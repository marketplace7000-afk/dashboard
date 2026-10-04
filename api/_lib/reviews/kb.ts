/**
 * База знаний агента 2 «Отзывы и вопросы»:
 *  - материалы по товарам с Яндекс.Диска (публичная ссылка, без токена):
 *    Word — разбор на сервере, PDF — pdftotext (poppler) на сервере бесплатно,
 *    сканы и картинки — Claude (Haiku); изменения на Диске подхватываются по md5;
 *  - пары «вопрос → ответ» из архива Telegram и чатов покупателей WB/Ozon
 *    (на сервере только очищенные пары);
 *  - подбор похожих прошлых ответов магазина и нужных кусков материалов.
 * Шаблонов и ручных FAQ нет: ответ собирается под конкретный отзыв и товар.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDb, safeJson, getSettings, rlog } from './db';
import { unzipAll } from '../zip';
import { askClaude } from './claude';
import type { KbFolder, TgPair, ReviewItem } from '../../../shared/reviews';

// ─── Telegram ──────────────────────────────────────────────────────────────
const PII = [
  /(\+7|8)[\s\-()]*\d{3}[\s\-()]*\d{3}[\s\-]*\d{2}[\s\-]*\d{2}/g,
  /@[A-Za-z0-9_]{4,}/g,
  /https?:\/\/t\.me\/\S+/g,
  /[\w.+-]+@[\w-]+\.[\w.]+/g,
];
export function stripPii(s: string): string {
  let out = String(s || '');
  for (const re of PII) out = out.replace(re, '[скрыто]');
  return out.trim();
}

export function importTgPairs(pairs: TgPair[]): { added: number; total: number } {
  const d = getDb();
  const ins = d.prepare('INSERT OR IGNORE INTO kb_tg (dialog_id, message_id, question, answer, date) VALUES (?, ?, ?, ?, ?)');
  let added = 0;
  for (const p of pairs.slice(0, 20_000)) {
    const q = stripPii(p.question).slice(0, 2000);
    const a = stripPii(p.answer).slice(0, 2000);
    if (q.length < 3 || a.length < 2) continue;
    const r = ins.run(String(p.dialogId).slice(0, 64), String(p.messageId).slice(0, 64), q, a, String(p.date || '').slice(0, 32));
    if (r.changes) added++;
  }
  return { added, total: tgStats().pairs };
}

export function tgStats(): { pairs: number; dialogs: number; lastDate: string | null } {
  const r = getDb().prepare("SELECT COUNT(*) AS n, COUNT(DISTINCT dialog_id) AS d, MAX(date) AS last FROM kb_tg WHERE source = 'tg'").get() as any;
  return { pairs: r.n, dialogs: r.d, lastDate: r.last };
}

// ─── Поиск похожего (без модели) ───────────────────────────────────────────
function terms(s: string): Set<string> {
  const out = new Set<string>();
  for (const w of String(s || '').toLowerCase().replace(/ё/g, 'е').split(/[^a-zа-я0-9]+/)) {
    if (w.length >= 4) out.add(w.slice(0, 6));
  }
  return out;
}
function score(a: Set<string>, text: string): number {
  let n = 0;
  for (const t of terms(text)) if (a.has(t)) n++;
  return n;
}

/** Похожие диалоги: Telegram + чаты покупателей WB/Ozon. Свой товар — с приоритетом. */
export function similarTgPairs(item: ReviewItem, limit = 5): { id: string; source: string; question: string; answer: string }[] {
  const q = terms(`${item.text} ${item.pros || ''} ${item.cons || ''}`);
  if (!q.size) return [];
  const rows = getDb().prepare('SELECT dialog_id, message_id, question, answer, source, offer_id FROM kb_tg').all() as any[];
  const off = (item.offerId || '').toUpperCase();
  return rows
    .map(r => ({
      r,
      s: score(q, r.question)
        + (off && String(r.offer_id || '').toUpperCase() === off ? 2 : 0)
        + (off && r.question.toUpperCase().includes(off) ? 3 : 0),
    }))
    .filter(x => x.s >= 2)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map(x => ({
      id: `${x.r.dialog_id}:${x.r.message_id}`, source: x.r.source || 'tg',
      question: x.r.question.slice(0, 600), answer: x.r.answer.slice(0, 600),
    }));
}

export function similarPastAnswers(item: ReviewItem, limit = 5): { id: number; text: string; answer: string; rating: number | null }[] {
  const rows = getDb().prepare(`SELECT id, text, mp_answer, rating, offer_id FROM items
    WHERE kind = ? AND mp_answer IS NOT NULL AND mp_answer <> '' AND id <> ?
    ORDER BY created_at DESC LIMIT 6000`).all(item.kind, item.id) as any[];
  const q = terms(item.text);
  return rows
    .map(r => ({
      r,
      s: (item.offerId && r.offer_id === item.offerId ? 4 : 0) + score(q, `${r.text}`)
        + (item.rating && r.rating && Math.abs(item.rating - r.rating) <= 1 ? 1 : 0),
    }))
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map(x => ({ id: x.r.id, text: String(x.r.text || '').slice(0, 400), answer: String(x.r.mp_answer).slice(0, 600), rating: x.r.rating }));
}

/** Последние наши ответы на похожие по оценке отзывы — чтобы не повторяться дословно. */
export function recentAnswers(kind: string, rating: number | null, limit = 6): string[] {
  const rows = getDb().prepare(`SELECT mp_answer FROM items WHERE kind = ? AND mp_answer IS NOT NULL AND mp_answer <> ''
    AND (? IS NULL OR rating = ?) ORDER BY created_at DESC LIMIT ?`).all(kind, rating, rating, limit) as any[];
  return rows.map(r => String(r.mp_answer).slice(0, 300));
}

// ─── Яндекс.Диск ───────────────────────────────────────────────────────────
const YD_API = 'https://cloud-api.yandex.net/v1/disk/public/resources';
const SKIP_DIR = /фото для дизайнер|видео|video/i;
const SKIP_EXT = /\.(mp4|mov|avi|psd|zip|rar|7z|ai|cdr|heic|webp|gif)$/i;
const IMG_EXT = /\.(jpe?g|png)$/i;
const IMG_USEFUL = /комплект|упаков|характерист|инструкц|габарит|размер|параметр/i;
const ENG = /англ|eng|english|original|кит/i;

type YdItem = { name: string; path: string; type: 'dir' | 'file'; size?: number; md5?: string; modified?: string; file?: string };

async function ydList(publicKey: string, path: string): Promise<YdItem[]> {
  const out: YdItem[] = [];
  for (let offset = 0; offset < 2000; offset += 200) {
    const url = `${YD_API}?public_key=${encodeURIComponent(publicKey)}&path=${encodeURIComponent(path)}&limit=200&offset=${offset}`
      + '&fields=_embedded.items.name,_embedded.items.path,_embedded.items.type,_embedded.items.size,_embedded.items.md5,_embedded.items.modified,_embedded.items.file,_embedded.total';
    const r = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!r.ok) throw new Error(`Яндекс.Диск ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j: any = await r.json();
    const items = j?._embedded?.items || [];
    out.push(...items);
    if (out.length >= (j?._embedded?.total ?? 0) || !items.length) break;
  }
  return out;
}

async function ydDownloadUrl(publicKey: string, path: string): Promise<string> {
  const r = await fetch(`${YD_API}/download?public_key=${encodeURIComponent(publicKey)}&path=${encodeURIComponent(path)}`, { signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`Яндекс.Диск download ${r.status}`);
  const j: any = await r.json();
  return j.href;
}

/** Текст из .docx без зависимостей: word/document.xml → абзацы. */
export function docxText(buf: Buffer): string {
  const doc = unzipAll(buf).find(e => e.name === 'word/document.xml');
  if (!doc) return '';
  return doc.data.toString('utf8')
    .replace(/<w:tab\/>/g, '\t')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<w:br\/>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}


/**
 * Из материалов убираем то, что покупателю видеть нельзя: ссылки на поставщика
 * (1688, Alibaba…), любые URL, коды ТН ВЭД и разрешительные документы для ввоза.
 */
export function cleanKnowledge(text: string): string {
  return String(text || '')
    .split('\n')
    .filter(l => !/1688|alibaba|aliexpress|taobao|pinduoduo|HYPERLINK|ТН\s*ВЭД|^\s*РД\s*:|^\s*\d*\.?\s*ссылка/i.test(l))
    .map(l => l.replace(/https?:\/\/\S+/g, '').replace(/www\.\S+/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const PDF_PROMPT = 'Это материал о товаре интернет-магазина (инструкция, описание, упаковка). Выпиши из него по-русски всё, что пригодится, чтобы отвечать покупателям: характеристики с цифрами, комплектацию, как пользоваться, ограничения и меры безопасности, частые проблемы и их решения, гарантию. Сжато, списками, без вступлений, до 900 слов. Если полезного нет — ответь одним словом НЕТ.';
const IMG_PROMPT = 'Это фото/картинка о товаре интернет-магазина. Перепиши по-русски полезный для покупателя текст с картинки (характеристики, размеры, комплектация) и перечисли, что входит в комплект, если это видно. Сжато, до 200 слов. Если полезного нет — ответь одним словом НЕТ.';

/** Запрос к Claude идёт через релей Vercel, а у него предел тела запроса ~4,5 МБ. */
const MAX_INLINE_BYTES = 3_200_000;
/** Больше этого PDF не качаем вовсе (чтение — на сервере, но память не резиновая). */
const MAX_PDF_BYTES = 80_000_000;
/** Версия разбора PDF: при смене все PDF перечитываются один раз. 2 = pdftotext на сервере. */
const PDF_VERSION = 2;

const run = promisify(execFile);
let popplerOk: boolean | null = null;
export async function havePoppler(): Promise<boolean> {
  if (popplerOk !== null) return popplerOk;
  try { await run('pdftotext', ['-v'], { timeout: 10_000 }); popplerOk = true; } catch (e: any) {
    // pdftotext -v пишет версию в stderr и может вернуть 0 или 99 — главное, что бинарник есть.
    popplerOk = e?.code !== 'ENOENT';
  }
  return popplerOk;
}

async function download(url: string, max: number): Promise<Buffer> {
  const r = await fetch(url, { signal: AbortSignal.timeout(180_000) });
  if (!r.ok) throw new Error(`Яндекс.Диск: файл не скачался (${r.status})`);
  const len = Number(r.headers.get('content-length') || 0);
  if (len > max) throw new SkipFile(`файл ${(len / 1e6).toFixed(0)} МБ — слишком большой`);
  return Buffer.from(await r.arrayBuffer());
}

/** Сколько «буквенного» текста — отличаем текстовый PDF от скана. */
function letters(s: string): number { return (s.match(/[A-Za-zА-Яа-яЁё]/g) || []).length; }

async function claudeOnImages(images: { data: Buffer; mime: string }[], prompt: string, model: string, purpose: string, maxTokens: number): Promise<string> {
  const content: any[] = images.map(im => ({ type: 'image', source: { type: 'base64', media_type: im.mime, data: im.data.toString('base64') } }));
  content.push({ type: 'text', text: prompt });
  const { text } = await askClaude(purpose, { model, max_tokens: maxTokens, temperature: 0, messages: [{ role: 'user', content }] });
  return /^\s*НЕТ\.?\s*$/i.test(text) ? '' : text.trim();
}

/**
 * PDF: сначала pdftotext на сервере (бесплатно, любой размер). Если текста почти нет —
 * это скан: первые страницы в картинки низкого разрешения и пачками < 3 МБ в Claude.
 * Без poppler — старый путь: файл целиком в Claude, если он меньше 3 МБ.
 */
export async function pdfKnowledge(url: string, name: string, model: string): Promise<{ text: string; via: string }> {
  const buf = await download(url, MAX_PDF_BYTES);
  if (!(await havePoppler())) {
    if (buf.length > MAX_INLINE_BYTES) throw new SkipFile(`файл ${(buf.length / 1e6).toFixed(1)} МБ, а на сервере нет pdftotext`);
    const { text } = await askClaude('index-pdf', {
      model, max_tokens: 1800, temperature: 0,
      messages: [{ role: 'user', content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buf.toString('base64') } },
        { type: 'text', text: PDF_PROMPT },
      ] }],
    });
    return { text: /^\s*НЕТ\.?\s*$/i.test(text) ? '' : text.trim(), via: 'claude' };
  }
  const dir = await mkdtemp(join(tmpdir(), 'rv-pdf-'));
  try {
    const file = join(dir, 'in.pdf');
    await writeFile(file, buf);
    let raw = '';
    try {
      raw = (await run('pdftotext', ['-enc', 'UTF-8', file, '-'], { timeout: 120_000, maxBuffer: 64 * 1024 * 1024 })).stdout;
    } catch (e) { rlog('warn', `pdftotext: ${name}`, { error: String((e as Error).message).slice(0, 200) }); }
    const pages = Math.max(1, (raw.match(/\f/g) || []).length);
    const text = raw.replace(/\f/g, '\n').replace(/[ \t]{2,}/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').trim();
    if (letters(text) >= Math.min(800, 60 * pages)) return { text: text.slice(0, 80_000), via: 'pdftotext' };

    // Скан: первые 12 страниц в JPEG 80 dpi.
    // -scale-to: длинная сторона не больше 1600 px (у Claude предел 8000 px; развёртки коробок бывают огромными).
    await run('pdftoppm', ['-jpeg', '-r', '80', '-scale-to', '1600', '-l', '12', file, join(dir, 'p')], { timeout: 180_000 });
    const imgs = (await readdir(dir)).filter(f => /^p-\d+\.jpg$/.test(f)).sort();
    const parts: string[] = [];
    let batch: { data: Buffer; mime: string }[] = [];
    let size = 0;
    const flush = async () => {
      if (!batch.length) return;
      parts.push(await claudeOnImages(batch, PDF_PROMPT, model, 'index-pdf-scan', 1800));
      batch = []; size = 0;
    };
    for (const f of imgs) {
      const data = await readFile(join(dir, f));
      if (size + data.length > 2_300_000 || batch.length >= 6) await flush();
      batch.push({ data, mime: 'image/jpeg' }); size += data.length;
    }
    await flush();
    return { text: parts.filter(Boolean).join('\n\n'), via: 'claude-scan' };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Тип картинки по содержимому: «.jpg» на Диске нередко на деле PNG или WebP. */
export function imageMime(buf: Buffer, name: string): string {
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return 'image/webp';
  if (buf.slice(0, 3).toString() === 'GIF') return 'image/gif';
  return /\.png$/i.test(name) ? 'image/png' : 'image/jpeg';
}

async function imageKnowledge(url: string, name: string, model: string): Promise<string> {
  const buf = await download(url, 40_000_000);
  if (buf.length > MAX_INLINE_BYTES) {
    // Большое фото — уменьшаем через poppler нельзя; пропускаем с понятной причиной.
    throw new SkipFile(`картинка ${(buf.length / 1e6).toFixed(1)} МБ — больше 3 МБ`);
  }
  return claudeOnImages([{ data: buf, mime: imageMime(buf, name) }], IMG_PROMPT, model, 'index-image', 500);
}

/** Файл осознанно пропущен (слишком большой и т.п.) — не ошибка, повторять не нужно. */
class SkipFile extends Error {}

/** Сравнение без знаков: в имени папки «/» из артикула заменяют на «-» (POL-3M-…-С/К/О ↔ С-К-О). */
function loose(s: string): string { return String(s || '').toUpperCase().replace(/Ё/g, 'Е').replace(/[^A-ZА-Я0-9]/g, ''); }

function norm(s: string): string { return s.toUpperCase().replace(/[\s_]+/g, '').replace(/[,./\\]/g, ''); }

/** Наши артикулы: из собранных отзывов/вопросов, карты Ozon sku→offer_id и карточек товаров. */
async function knownOfferIds(): Promise<string[]> {
  const set = new Set<string>();
  for (const r of getDb().prepare('SELECT DISTINCT offer_id FROM items WHERE offer_id IS NOT NULL').all() as any[]) set.add(String(r.offer_id).trim());
  try {
    const m = await (await import('../ozonShowcase')).getSkuMap();
    for (const v of Object.values(m)) set.add(String(v).trim());
  } catch { /* нет карты — не беда */ }
  // Артикулы из карточек WB/Ozon (обновляются раз в сутки, см. sources.ts) — без лишних запросов к WB.
  for (const r of getDb().prepare('SELECT DISTINCT offer_id FROM kb_cards').all() as any[]) set.add(String(r.offer_id).trim());
  return [...set].filter(Boolean);
}

export function suggestOffers(folderName: string, offers: string[]): string[] {
  const f = norm(folderName);
  if (!f) return [];
  const exact = offers.filter(o => norm(o) === f);
  if (exact.length) return exact;
  // Артикул внутри длинного имени папки: ALLPOWERS-STAN1,5kWh-AP-S2000-PRO ↔ S2000-PRO.
  const inside = offers.filter(o => norm(o).length >= 5 && f.includes(norm(o)));
  // Папка — общее начало нескольких артикулов (BOARD-JSK-X04 ↔ BOARD-JSK-X04-BLACK).
  const prefix = offers.filter(o => norm(o).startsWith(f) && f.length >= 6);
  const all = [...new Set([...inside, ...prefix])];
  // Из вложенных совпадений оставляем самые длинные (S2000-PRO, а не S2000).
  return all.filter(o => !all.some(p => p !== o && norm(p).includes(norm(o)) && inside.includes(p)));
}

/** Подпапки с материалами внутри папки товара — не товары. */
const CONTENT_DIR = /инструкц|фото|ссылк|упаков|характер|видео|комплект|англ|^\s*кит|габарит|размер|руковод|сертиф|документ|рекл/i;
export function isProductDir(name: string): boolean {
  return /[A-Za-z]{2,}/.test(name) && !CONTENT_DIR.test(name);
}
/**
 * Ключ товара для файла: от первой «товарной» папки до ближайшей «товарной»
 * папки над файлом. «/База…/ALLPOWERS/ALLPOWERS-…-S2000-PRO/инструкция на русском/x.pdf»
 * → «ALLPOWERS/ALLPOWERS-…-S2000-PRO»; файлы прямо в «AFERIY» → «AFERIY» (общая карточка бренда).
 */
export function productKeyOf(filePath: string): string | null {
  const dirs = String(filePath || '').split('/').filter(Boolean).slice(0, -1);
  let first = -1; let last = -1;
  dirs.forEach((d, i) => { if (isProductDir(d)) { if (first < 0) first = i; last = i; } });
  if (first < 0) return null;
  return dirs.slice(first, last + 1).map(d => d.trim()).join('/');
}

let indexing: Promise<any> | null = null;
export type IndexProgress = { running: boolean; done: number; total: number; current: string | null; startedAt: number | null; error: string | null };
const progress: IndexProgress = { running: false, done: 0, total: 0, current: null, startedAt: null, error: null };
export function indexProgress(): IndexProgress { return { ...progress }; }
export type DiskSync = { at: number; added: string[]; changed: string[]; removed: string[] };
let lastSync: DiskSync | null = null;
export function lastDiskSync(): DiskSync | null {
  if (lastSync) return lastSync;
  const r = getDb().prepare("SELECT value FROM kv WHERE key = 'disk_sync'").get() as any;
  return r ? safeJson(r.value, null) : null;
}

/** Обойти публичную папку, обновить карточки знаний (только изменённые файлы). */
export function indexYandexDisk(): Promise<any> {
  if (indexing) return indexing;
  indexing = (async () => {
    const s = getSettings();
    if (!s.yandexDiskUrl) throw new Error('Не задана ссылка на папку Яндекс.Диска');
    Object.assign(progress, { running: true, done: 0, total: 0, current: null, startedAt: Date.now(), error: null });
    const offers = await knownOfferIds();

    // 1. Все файлы папки (с путями). Структура владельца на 04.10:
    //   «База о товаре начального уровня» / <товар или бренд> / [<товар>] / «инструкция на русском» | «фото» | …
    const files: YdItem[] = [];
    const walk = async (path: string, depth: number) => {
      const items = await ydList(s.yandexDiskUrl, path);
      files.push(...items.filter(i => i.type === 'file'));
      if (depth >= 6) return;
      for (const d of items.filter(i => i.type === 'dir')) {
        if (SKIP_DIR.test(d.name)) continue;
        await walk(d.path, depth + 1);
      }
    };
    await walk('/', 0);

    // 2. Файл относится к ближайшей «папке товара» (имя-артикул, не «инструкция»/«фото»).
    const groups = new Map<string, YdItem[]>();
    for (const f of files) {
      const key = productKeyOf(f.path);
      if (!key) continue;
      const arr = groups.get(key) || [];
      arr.push(f);
      groups.set(key, arr);
    }
    progress.total = [...groups.values()].reduce((n, a) => n + a.length, 0);

    const d = getDb();
    const getRow = d.prepare('SELECT * FROM kb_folders WHERE path = ?');
    const stats = { added: [] as string[], changed: [] as string[], removed: [] as string[] };
    for (const [key, files] of groups) {
      const row = getRow.get(key) as any;
      const prevFiles: any[] = safeJson(row?.files, []);
      const prevByMd5 = new Map(prevFiles.map(f => [f.md5 + '|' + f.name, f]));
      const hasRuInstr = files.some(f => /\.pdf$/i.test(f.name) && /инструкц|руков/i.test(f.name + f.path) && !ENG.test(f.name + f.path));
      const outFiles: any[] = [];
      // Папка изменилась: новый/изменённый файл или файл удалён с Диска.
      let changed = !row || prevFiles.length !== files.length;
      for (const f of files) {
        progress.current = `${key}/${f.name}`;
        const prev = prevByMd5.get(f.md5 + '|' + f.name);
        const isPdf = /\.pdf$/i.test(f.name);
        const reusable = prev && (prev.status === 'done' || prev.status === 'skipped')
          && (!isPdf || prev.v === PDF_VERSION || (prev.status === 'skipped' && /русская инструкция/.test(prev.note || '')));
        if (reusable) { outFiles.push(prev); progress.done++; continue; }
        changed = true;
        const rec: any = { name: f.name, path: f.path, md5: f.md5, kind: (f.name.split('.').pop() || '').toLowerCase(), status: 'pending', text: '' };
        try {
          if (SKIP_EXT.test(f.name)) { rec.status = 'skipped'; rec.note = 'не нужен для ответов'; }
          else if (/\.doc$/i.test(f.name)) { rec.status = 'skipped'; rec.note = 'старый .doc — пересохраните в .docx'; }
          else if (/\.docx$/i.test(f.name)) {
            const href = await ydDownloadUrl(s.yandexDiskUrl, f.path);
            const buf = Buffer.from(await (await fetch(href, { signal: AbortSignal.timeout(60_000) })).arrayBuffer());
            rec.text = docxText(buf).slice(0, 20_000); rec.status = 'done';
          } else if (isPdf) {
            rec.v = PDF_VERSION;
            if (ENG.test(f.name + f.path) && hasRuInstr) { rec.status = 'skipped'; rec.note = 'есть русская инструкция'; }
            else {
              const r = await pdfKnowledge(await ydDownloadUrl(s.yandexDiskUrl, f.path), f.name, s.indexModel);
              rec.text = r.text; rec.via = r.via; rec.status = 'done';
              if (!r.text) { rec.status = 'skipped'; rec.note = 'полезного текста нет'; }
            }
          } else if (IMG_EXT.test(f.name)) {
            if (!IMG_USEFUL.test(f.name + ' ' + f.path)) { rec.status = 'skipped'; rec.note = 'обычное фото'; }
            else { rec.text = await imageKnowledge(await ydDownloadUrl(s.yandexDiskUrl, f.path), f.name, s.indexModel); rec.status = 'done'; }
          } else { rec.status = 'skipped'; rec.note = 'неизвестный тип'; }
        } catch (e) {
          if (e instanceof SkipFile) { rec.status = 'skipped'; rec.note = e.message; outFiles.push(rec); progress.done++; continue; }
          rec.status = 'error'; rec.note = String((e as Error)?.message ?? e).slice(0, 200);
          if (/Подлимит/.test(rec.note)) { progress.error = rec.note; }
        }
        outFiles.push(rec);
        progress.done++;
      }
      const text = outFiles.filter(f => f.status === 'done' && f.text)
        .map(f => `### ${f.name}\n${cleanKnowledge(f.text)}`).join('\n\n').slice(0, 150_000);
      const name = key.split('/').pop() || key;
      const suggested = suggestOffers(name, offers);
      const filesForDb = outFiles.map(f => ({ name: f.name, path: f.path, md5: f.md5, kind: f.kind, status: f.status, note: f.note, text: f.text, v: f.v, via: f.via }));
      if (row) {
        d.prepare(`UPDATE kb_folders SET suggested = ?, files = ?, text = ?, updated_at = CASE WHEN ? THEN ? ELSE updated_at END,
            offer_ids = CASE WHEN confirmed = 1 THEN offer_ids ELSE ? END WHERE path = ?`)
          .run(JSON.stringify(suggested), JSON.stringify(filesForDb), text, changed ? 1 : 0, Date.now(), JSON.stringify(suggested), key);
      } else {
        d.prepare('INSERT INTO kb_folders (path, offer_ids, suggested, confirmed, files, text, updated_at, first_seen_at) VALUES (?, ?, ?, 0, ?, ?, ?, ?)')
          .run(key, JSON.stringify(suggested), JSON.stringify(suggested), JSON.stringify(filesForDb), text, Date.now(), Date.now());
        stats.added.push(key);
      }
      if (changed && row) stats.changed.push(key);
      if (progress.error) break;
    }
    // Папки, которых на Диске больше нет (удалены или переименованы), — убираем из базы.
    // Только после полного успешного обхода: при сбое Диска ничего не удаляем.
    if (!progress.error) {
      for (const r of d.prepare('SELECT path FROM kb_folders').all() as any[]) {
        if (!groups.has(r.path)) { d.prepare('DELETE FROM kb_folders WHERE path = ?').run(r.path); stats.removed.push(r.path); }
      }
    }
    lastSync = { at: Date.now(), added: stats.added, changed: stats.changed, removed: stats.removed };
    getDb().prepare(`INSERT INTO kv (key, value, updated_at) VALUES ('disk_sync', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(JSON.stringify(lastSync), Date.now());
    rlog('info', 'Яндекс.Диск: материалы обновлены', { folders: groups.size, files: progress.total,
      added: stats.added.length, changed: stats.changed.length, removed: stats.removed.length });
    return { folders: groups.size, files: progress.total, ...stats };
  })().catch(e => {
    progress.error = String((e as Error)?.message ?? e).slice(0, 300);
    rlog('error', 'Яндекс.Диск: обход не удался', { error: progress.error });
    throw e;
  }).finally(() => { progress.running = false; progress.current = null; indexing = null; });
  return indexing;
}

/**
 * Общая папка: артикул к ней не закреплён, а материалы относятся к вложенным папкам
 * (бренд AFERIY, ECOFLOW) или к родительской папке-артикулу (компоненты набора POL-3M-…/PN05996).
 * Подтверждения не требует (решение владельца 04.10).
 */
function isSharedFolder(r: any, all: any[]): boolean {
  if ((safeJson(r.offer_ids, []) as string[]).length) return false;
  return all.some(x => x.path.startsWith(r.path + '/')) || String(r.path).includes('/');
}

export function listFolders(): KbFolder[] {
  const all = getDb().prepare('SELECT * FROM kb_folders ORDER BY path').all() as any[];
  return all.map(r => ({
    path: r.path,
    offerIds: safeJson(r.offer_ids, []),
    suggested: safeJson(r.suggested, []),
    confirmed: !!r.confirmed,
    files: (safeJson(r.files, []) as any[]).map(f => ({ name: f.name, kind: f.kind, status: f.status, note: f.note, via: f.via })),
    textChars: String(r.text || '').length,
    updatedAt: r.updated_at,
    firstSeenAt: r.first_seen_at ?? null,
    shared: isSharedFolder(r, all),
  }));
}

export function folderText(path: string): string {
  const r = getDb().prepare('SELECT text FROM kb_folders WHERE path = ?').get(path) as any;
  return r?.text || '';
}

export function confirmFolder(path: string, offerIds: string[]): void {
  const clean = [...new Set(offerIds.map(x => String(x).trim()).filter(Boolean))];
  getDb().prepare('UPDATE kb_folders SET offer_ids = ?, confirmed = 1 WHERE path = ?').run(JSON.stringify(clean), path);
}

/** Куски текста материалов: абзацы, склеенные до ~450 символов, с именем файла. */
export function chunksOf(text: string): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = [];
  for (const block of String(text || '').split(/\n(?=### )/)) {
    const m = block.match(/^### (.+)\n?/);
    const file = m ? m[1].trim() : '';
    const body = m ? block.slice(m[0].length) : block;
    let cur = '';
    for (const para of body.split(/\n\s*\n/)) {
      if (cur && cur.length + para.length > 450) { out.push({ file, text: cur.trim() }); cur = ''; }
      cur += (cur ? '\n' : '') + para;
      while (cur.length > 900) { out.push({ file, text: cur.slice(0, 900) }); cur = cur.slice(900); }
    }
    if (cur.trim()) out.push({ file, text: cur.trim() });
  }
  return out;
}

/**
 * Знания о товаре под конкретный отзыв/вопрос, не длиннее limit символов:
 *  1) карточка товара с площадок (название, характеристики, описание — по API);
 *  2) из материалов Диска — начало файла характеристик и куски, где есть слова из вопроса.
 */
export function productKnowledge(offerId: string | null, query = '', limit = 7000): { text: string; sources: string[] } {
  if (!offerId) return { text: '', sources: [] };
  const up = offerId.toUpperCase();
  const sources: string[] = [];
  const parts: string[] = [];

  const cards = getDb().prepare('SELECT marketplace, name, text FROM kb_cards WHERE UPPER(offer_id) = ?').all(up) as any[];
  if (cards.length) {
    // Обе площадки обычно описывают товар одинаково — берём более полную карточку и добавляем вторую, если влезает.
    cards.sort((a, b) => String(b.text).length - String(a.text).length);
    let cardText = `## Карточка товара (${cards[0].marketplace === 'wb' ? 'WB' : 'Ozon'})\n${String(cards[0].text).slice(0, 3000)}`;
    if (cards[1] && cardText.length < 2000) cardText += `\n## Карточка (${cards[1].marketplace === 'wb' ? 'WB' : 'Ozon'})\n${String(cards[1].text).slice(0, 1200)}`;
    parts.push(cardText);
    sources.push(`card:${offerId}`);
  }

  const rows = getDb().prepare('SELECT path, offer_ids, text FROM kb_folders').all() as any[];
  const offersOf = (r: any) => safeJson(r.offer_ids, []) as string[];
  // Папка товара: артикул закреплён за папкой, ИЛИ общая папка без артикулов лежит внутри
  // папки с именем-артикулом (набор POL-3M-…/PN05996 — материалы компонентов набора).
  const mine = rows.filter(r => offersOf(r).some(o => o.toUpperCase() === up)
    || (!offersOf(r).length && r.path.split('/').slice(0, -1).some((seg: string) => loose(seg) === loose(offerId))));
  if (mine.length) {
    // Общая папка бренда: её путь — начало пути папки товара (AFERIY ⊃ AFERIY/AFERIY-STAN-…).
    const brandRows = rows.filter(r => !mine.includes(r) && mine.some(m => m.path.startsWith(r.path + '/')));
    const chunks = [...mine, ...brandRows].flatMap(r => chunksOf(r.text).map(c => ({ ...c, folder: r.path })));
    const q = terms(query);
    const isSpec = (c: { file: string }) => /характер|габар|параметр/i.test(c.file);
    const ranked = chunks
      .map((c, i) => ({ c, i, s: score(q, c.text) * 3 + (isSpec(c) ? 2 : 0) + (/инструкц|руков/i.test(c.file) ? 1 : 0) }))
      .sort((a, b) => b.s - a.s || a.i - b.i);
    let room = limit - parts.join('\n\n').length - 200;
    const picked: typeof ranked = [];
    for (const x of ranked) {
      if (room <= 200) break;
      if (x.c.text.length > room) continue;
      picked.push(x); room -= x.c.text.length + 40;
    }
    // В исходном порядке файлов — так читается связнее.
    picked.sort((a, b) => a.i - b.i);
    if (picked.length) {
      parts.push('## Материалы с Яндекс.Диска (выдержки)\n' + picked.map(x => `[${x.c.file}] ${x.c.text}`).join('\n---\n'));
      sources.push(`product:${offerId}`);
    }
  }
  return { text: parts.join('\n\n').slice(0, limit), sources };
}

/** Наши артикулы с отзывами/вопросами, по которым нет папки на Диске (отвечаем по карточке и истории). */
export function offersWithoutMaterials(): string[] {
  const rows = getDb().prepare('SELECT path, offer_ids FROM kb_folders').all() as any[];
  const covered = new Set<string>();
  const coveredLoose = new Set<string>();
  for (const r of rows) {
    const offers = safeJson(r.offer_ids, []) as string[];
    for (const o of offers) covered.add(o.toUpperCase());
    if (!offers.length) for (const seg of String(r.path).split('/').slice(0, -1)) coveredLoose.add(loose(seg));
  }
  const ours = getDb().prepare(`SELECT offer_id, COUNT(*) AS n FROM items WHERE offer_id IS NOT NULL GROUP BY offer_id ORDER BY n DESC`).all() as any[];
  return ours.map(r => String(r.offer_id)).filter(o => !covered.has(o.toUpperCase()) && !coveredLoose.has(loose(o)));
}
