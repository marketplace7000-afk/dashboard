/**
 * База знаний агента 4 (разделы 4–6 ТЗ):
 *  - тексты (тон, FAQ, скрипты, шаблоны) — редактируются в кабинете;
 *  - материалы по товарам с Яндекс.Диска (публичная ссылка, без токена);
 *  - пары «вопрос → ответ» из архива Telegram (разбор в браузере владельца,
 *    на сервер приходят только очищенные пары);
 *  - подбор похожих прошлых ответов магазина.
 */
import { getDb, safeJson, getSettings, rlog } from './db';
import { unzipAll } from '../zip';
import { askClaude } from './claude';
import type { KbTextKey, KbFolder, TgPair, ReviewItem } from '../../../shared/reviews';

// ─── Тексты ────────────────────────────────────────────────────────────────
export function getKbTexts(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of getDb().prepare('SELECT key, text FROM kb_texts').all() as any[]) out[r.key] = r.text;
  return out;
}

export function setKbText(key: KbTextKey, text: string): void {
  getDb().prepare(`INSERT INTO kb_texts (key, text, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at`)
    .run(key, String(text || '').slice(0, 30_000), Date.now());
}

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
  const r = getDb().prepare('SELECT COUNT(*) AS n, COUNT(DISTINCT dialog_id) AS d, MAX(date) AS last FROM kb_tg').get() as any;
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

export function similarTgPairs(item: ReviewItem, limit = 5): { id: string; question: string; answer: string }[] {
  const q = terms(`${item.text} ${item.pros || ''} ${item.cons || ''}`);
  if (!q.size) return [];
  const rows = getDb().prepare('SELECT dialog_id, message_id, question, answer FROM kb_tg').all() as any[];
  const off = (item.offerId || '').toLowerCase();
  return rows
    .map(r => ({ r, s: score(q, r.question) + (off && r.question.toLowerCase().includes(off) ? 3 : 0) }))
    .filter(x => x.s >= 2)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map(x => ({ id: `${x.r.dialog_id}:${x.r.message_id}`, question: x.r.question.slice(0, 600), answer: x.r.answer.slice(0, 600) }));
}

export function similarPastAnswers(item: ReviewItem, limit = 5): { id: number; text: string; answer: string; rating: number | null }[] {
  const rows = getDb().prepare(`SELECT id, text, mp_answer, rating, offer_id FROM items
    WHERE kind = ? AND mp_answer IS NOT NULL AND mp_answer <> '' AND id <> ?
    ORDER BY created_at DESC LIMIT 2000`).all(item.kind, item.id) as any[];
  const q = terms(item.text);
  return rows
    .map(r => ({
      r,
      s: (item.offerId && r.offer_id === item.offerId ? 3 : 0) + score(q, r.text)
        + (item.rating && r.rating && Math.abs(item.rating - r.rating) <= 1 ? 1 : 0),
    }))
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map(x => ({ id: x.r.id, text: String(x.r.text || '').slice(0, 400), answer: String(x.r.mp_answer).slice(0, 600), rating: x.r.rating }));
}

// ─── Яндекс.Диск ───────────────────────────────────────────────────────────
const YD_API = 'https://cloud-api.yandex.net/v1/disk/public/resources';
const SKIP_DIR = /фото для дизайнер|видео|video/i;
const SKIP_EXT = /\.(mp4|mov|avi|psd|zip|rar|7z|ai|cdr|heic|webp|gif)$/i;
const IMG_EXT = /\.(jpe?g|png)$/i;
const IMG_USEFUL = /комплект|упаков|характерист|инструкц|габарит|размер|параметр/i;
const ENG = /англ|eng|english|original/i;

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

const PDF_PROMPT = 'Это материал о товаре интернет-магазина (инструкция, описание, упаковка). Выпиши из него по-русски всё, что пригодится, чтобы отвечать покупателям: характеристики с цифрами, комплектацию, как пользоваться, ограничения и меры безопасности, частые проблемы и их решения, гарантию. Сжато, списками, без вступлений, до 900 слов. Если полезного нет — ответь одним словом НЕТ.';
const IMG_PROMPT = 'Это фото/картинка о товаре интернет-магазина. Перепиши по-русски полезный для покупателя текст с картинки (характеристики, размеры, комплектация) и перечисли, что входит в комплект, если это видно. Сжато, до 200 слов. Если полезного нет — ответь одним словом НЕТ.';

async function extractWithClaude(kind: 'pdf' | 'image', url: string, name: string, model: string): Promise<string> {
  const ext = name.toLowerCase().split('.').pop();
  const block = kind === 'pdf'
    ? { type: 'document', source: { type: 'url', url } }
    : { type: 'image', source: { type: 'url', url } };
  const { text } = await askClaude(kind === 'pdf' ? 'index-pdf' : 'index-image', {
    model, max_tokens: kind === 'pdf' ? 1800 : 500, temperature: 0,
    messages: [{ role: 'user', content: [block, { type: 'text', text: kind === 'pdf' ? PDF_PROMPT : IMG_PROMPT }] }],
  });
  void ext;
  return /^\s*НЕТ\.?\s*$/i.test(text) ? '' : text.trim();
}

function norm(s: string): string { return s.toUpperCase().replace(/[\s_]+/g, '').replace(/[,.]/g, ''); }

/** Наши артикулы: из собранных отзывов/вопросов и карты Ozon sku→offer_id. */
async function knownOfferIds(): Promise<string[]> {
  const set = new Set<string>();
  for (const r of getDb().prepare('SELECT DISTINCT offer_id FROM items WHERE offer_id IS NOT NULL').all() as any[]) set.add(String(r.offer_id).trim());
  try {
    const m = await (await import('../ozonShowcase')).getSkuMap();
    for (const v of Object.values(m)) set.add(String(v).trim());
  } catch { /* нет карты — не беда */ }
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

let indexing: Promise<any> | null = null;
export type IndexProgress = { running: boolean; done: number; total: number; current: string | null; startedAt: number | null; error: string | null };
const progress: IndexProgress = { running: false, done: 0, total: 0, current: null, startedAt: null, error: null };
export function indexProgress(): IndexProgress { return { ...progress }; }

/** Обойти публичную папку, обновить карточки знаний (только изменённые файлы). */
export function indexYandexDisk(): Promise<any> {
  if (indexing) return indexing;
  indexing = (async () => {
    const s = getSettings();
    if (!s.yandexDiskUrl) throw new Error('Не задана ссылка на папку Яндекс.Диска');
    Object.assign(progress, { running: true, done: 0, total: 0, current: null, startedAt: Date.now(), error: null });
    const offers = await knownOfferIds();

    // 1. Дерево папок.
    const folders: { path: string; name: string; files: YdItem[] }[] = [];
    const walk = async (path: string, name: string, depth: number) => {
      const items = await ydList(s.yandexDiskUrl, path);
      const files = items.filter(i => i.type === 'file');
      if (files.length) folders.push({ path, name, files });
      if (depth >= 4) return;
      for (const d of items.filter(i => i.type === 'dir')) {
        if (SKIP_DIR.test(d.name)) continue;
        await walk(d.path, depth === 0 ? d.name : name + ' / ' + d.name, depth + 1);
      }
    };
    await walk('/', '', 0);

    // Подпапки товара («Наша инструкция на Русском языке») относим к папке товара верхнего уровня.
    const prodKey = (p: string) => p.split('/').filter(Boolean).slice(0, 1).join('/');
    const groups = new Map<string, YdItem[]>();
    for (const f of folders) {
      const segs = f.path.split('/').filter(Boolean);
      // Папки-бренды (AFERIY/ECOFLOW) содержат папки товаров: товар = вложенная папка с «-» в имени.
      const key = segs.length >= 2 && /-/.test(segs[1]) && !/инструкц|фото|комплект/i.test(segs[1])
        ? segs.slice(0, 2).join('/') : prodKey(f.path) || '/';
      const arr = groups.get(key) || [];
      arr.push(...f.files);
      groups.set(key, arr);
    }
    progress.total = [...groups.values()].reduce((n, a) => n + a.length, 0);

    const d = getDb();
    const getRow = d.prepare('SELECT * FROM kb_folders WHERE path = ?');
    for (const [key, files] of groups) {
      const row = getRow.get(key) as any;
      const prevFiles: any[] = safeJson(row?.files, []);
      const prevByMd5 = new Map(prevFiles.map(f => [f.md5 + '|' + f.name, f]));
      const hasRuInstr = files.some(f => /\.pdf$/i.test(f.name) && /инструкц|руков/i.test(f.name + f.path) && !ENG.test(f.name + f.path));
      const outFiles: any[] = [];
      for (const f of files) {
        progress.current = `${key}/${f.name}`;
        const prev = prevByMd5.get(f.md5 + '|' + f.name);
        if (prev && (prev.status === 'done' || prev.status === 'skipped')) { outFiles.push(prev); progress.done++; continue; }
        const rec: any = { name: f.name, path: f.path, md5: f.md5, kind: (f.name.split('.').pop() || '').toLowerCase(), status: 'pending', text: '' };
        try {
          if (SKIP_EXT.test(f.name)) { rec.status = 'skipped'; rec.note = 'не нужен для ответов'; }
          else if (/\.doc$/i.test(f.name)) { rec.status = 'skipped'; rec.note = 'старый .doc — пересохраните в .docx'; }
          else if (/\.docx$/i.test(f.name)) {
            const href = await ydDownloadUrl(s.yandexDiskUrl, f.path);
            const buf = Buffer.from(await (await fetch(href, { signal: AbortSignal.timeout(60_000) })).arrayBuffer());
            rec.text = docxText(buf).slice(0, 20_000); rec.status = 'done';
          } else if (/\.pdf$/i.test(f.name)) {
            if (ENG.test(f.name + f.path) && hasRuInstr) { rec.status = 'skipped'; rec.note = 'есть русская инструкция'; }
            else if ((f.size || 0) > 30e6) { rec.status = 'skipped'; rec.note = 'файл больше 30 МБ'; }
            else { rec.text = await extractWithClaude('pdf', await ydDownloadUrl(s.yandexDiskUrl, f.path), f.name, s.indexModel); rec.status = 'done'; }
          } else if (IMG_EXT.test(f.name)) {
            if (!IMG_USEFUL.test(f.name + ' ' + f.path)) { rec.status = 'skipped'; rec.note = 'обычное фото (можно отметить «прочитать»)'; }
            else if ((f.size || 0) > 5e6) { rec.status = 'skipped'; rec.note = 'картинка больше 5 МБ'; }
            else { rec.text = await extractWithClaude('image', await ydDownloadUrl(s.yandexDiskUrl, f.path), f.name, s.indexModel); rec.status = 'done'; }
          } else { rec.status = 'skipped'; rec.note = 'неизвестный тип'; }
        } catch (e) {
          rec.status = 'error'; rec.note = String((e as Error)?.message ?? e).slice(0, 200);
          if (/Подлимит/.test(rec.note)) { progress.error = rec.note; }
        }
        outFiles.push(rec);
        progress.done++;
      }
      const text = outFiles.filter(f => f.status === 'done' && f.text)
        .map(f => `### ${f.name}\n${f.text}`).join('\n\n').slice(0, 40_000);
      const name = key.split('/').pop() || key;
      const suggested = suggestOffers(name, offers);
      const filesForDb = outFiles.map(f => ({ name: f.name, path: f.path, md5: f.md5, kind: f.kind, status: f.status, note: f.note, text: f.text }));
      if (row) {
        d.prepare('UPDATE kb_folders SET suggested = ?, files = ?, text = ?, updated_at = ?, offer_ids = CASE WHEN confirmed = 1 THEN offer_ids ELSE ? END WHERE path = ?')
          .run(JSON.stringify(suggested), JSON.stringify(filesForDb), text, Date.now(), JSON.stringify(suggested), key);
      } else {
        d.prepare('INSERT INTO kb_folders (path, offer_ids, suggested, confirmed, files, text, updated_at) VALUES (?, ?, ?, 0, ?, ?, ?)')
          .run(key, JSON.stringify(suggested), JSON.stringify(suggested), JSON.stringify(filesForDb), text, Date.now());
      }
      if (progress.error) break;
    }
    rlog('info', 'Яндекс.Диск: материалы обновлены', { folders: groups.size, files: progress.total });
    return { folders: groups.size, files: progress.total };
  })().catch(e => {
    progress.error = String((e as Error)?.message ?? e).slice(0, 300);
    rlog('error', 'Яндекс.Диск: обход не удался', { error: progress.error });
    throw e;
  }).finally(() => { progress.running = false; progress.current = null; indexing = null; });
  return indexing;
}

export function listFolders(): KbFolder[] {
  return (getDb().prepare('SELECT * FROM kb_folders ORDER BY path').all() as any[]).map(r => ({
    path: r.path,
    offerIds: safeJson(r.offer_ids, []),
    suggested: safeJson(r.suggested, []),
    confirmed: !!r.confirmed,
    files: (safeJson(r.files, []) as any[]).map(f => ({ name: f.name, kind: f.kind, status: f.status, note: f.note })),
    textChars: String(r.text || '').length,
    updatedAt: r.updated_at,
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

/** Карточка знаний товара для черновика: папки товара + папка бренда, не длиннее limit символов. */
export function productKnowledge(offerId: string | null, limit = 6000): { text: string; sources: string[] } {
  if (!offerId) return { text: '', sources: [] };
  const rows = getDb().prepare('SELECT path, offer_ids, text FROM kb_folders').all() as any[];
  const mine = rows.filter(r => (safeJson(r.offer_ids, []) as string[]).some(o => o.toUpperCase() === offerId.toUpperCase()));
  if (!mine.length) return { text: '', sources: [] };
  const brands = new Set(mine.map(r => r.path.split('/')[0]).filter((b: string) => b && !mine.some(m => m.path === b)));
  const brandRows = rows.filter(r => brands.has(r.path));
  const parts = [...mine, ...brandRows].map(r => `## Материалы: ${r.path}\n${prioritize(r.text)}`);
  return { text: parts.join('\n\n').slice(0, limit), sources: [`product:${offerId}`] };
}

/** Характеристики (docx) — первыми, потом инструкция, потом остальное. */
function prioritize(text: string): string {
  const blocks = String(text || '').split(/\n(?=### )/);
  const rank = (b: string) => /характер|ссылка|габар/i.test(b.slice(0, 120)) ? 0 : /инструкц|руковод/i.test(b.slice(0, 120)) ? 1 : 2;
  return blocks.sort((a, b) => rank(a) - rank(b)).join('\n');
}

export function offersWithoutMaterials(): string[] {
  const rows = getDb().prepare('SELECT offer_ids FROM kb_folders').all() as any[];
  const covered = new Set<string>();
  for (const r of rows) for (const o of safeJson(r.offer_ids, []) as string[]) covered.add(o.toUpperCase());
  const ours = getDb().prepare(`SELECT offer_id, COUNT(*) AS n FROM items WHERE offer_id IS NOT NULL GROUP BY offer_id ORDER BY n DESC`).all() as any[];
  return ours.map(r => String(r.offer_id)).filter(o => !covered.has(o.toUpperCase()));
}
