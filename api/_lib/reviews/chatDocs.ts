/**
 * «Документы» в чатах с покупателями (20.11.2026): инструкции, техпаспорта, сертификаты, фото комплектации.
 *  - источник 1: папки товаров на Яндекс.Диске (те же, что читает база знаний, см. kb.ts);
 *  - источник 2: файлы, которые менеджер добавил прямо в кабинете (лежат на сервере, привязаны к артикулу);
 *  - отправка в чат WB/Ozon: площадки принимают PDF, JPG, PNG до 5 МБ — большой PDF сжимаем (Ghostscript),
 *    большую картинку уменьшаем; Word/Excel в чат не уходят — только на почту;
 *  - отправка на почту покупателя через ящик магазина (mailer.ts) — когда файл в чате не открывается.
 * Внутренние файлы (ссылки на поставщика, ТН ВЭД, исходники фото, видео, архивы) покупателю не показываем.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm, mkdir, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDb, getSettings, rlog, safeJson } from './db';
import { foldersForOffer, ydDownloadUrl } from './kb';
import { chatDb, getThread, replySignOf, addMessages } from './chatStore';
import { WB_CHAT_BASE, wbChatHeaders } from './sources';
import { ozonUpstream } from '../../_proxy';
import { gate, note } from '../gateway';
import { sendMail, mailReady, mailFrom, maskEmail, EMAIL_RE } from '../mailer';

const run = promisify(execFile);

/** Предел площадок на один файл в чате (WB: «5 Мб каждый», 30 Мб на сообщение). */
export const CHAT_FILE_MAX = 5 * 1024 * 1024;
/** Письмо: Яндекс принимает до ~30 МБ, с запасом на base64. */
const MAIL_TOTAL_MAX = 20 * 1024 * 1024;
/** Инструкции бывают по 70 МБ (AF-P280, 20.11) — качаем и сжимаем на сервере. */
const DOWNLOAD_MAX = 150 * 1024 * 1024;
const UPLOAD_DIR = join(process.env.CACHE_DIR || join(process.cwd(), '.av-cache'), 'chat-docs');

export type DocCategory = 'Инструкция' | 'Техпаспорт' | 'Сертификат' | 'Комплектация' | 'Характеристики' | 'Другое';
export type ChatDoc = {
  id: string;            // «yd:<путь на Диске>» или «up:<номер>»
  name: string;          // имя файла
  folder: string;        // папка товара (для поиска по всем товарам)
  category: DocCategory;
  english: boolean;
  ext: string;
  size: number | null;
  chatOk: boolean;       // формат подходит для чата площадки
  source: 'disk' | 'upload';
  offerId?: string | null;
};

// ─── Что показывать и как назвать ──────────────────────────────────────────
const HIDDEN_EXT = /^(mp4|mov|avi|mkv|zip|rar|7z|psd|ai|cdr|heic|webp|gif|txt|url)$/i;
/** Внутренние файлы: ссылка на поставщика, ТН ВЭД, таблицы для дизайнеров. */
const INTERNAL = /ссылк|сылк|тн\s*вэд|1688|alibaba|для дизайнер|поставщ|ответы на наши|наши вопросы|себестоим|закупк/i;
// \b в JS не видит границ русских слов — поэтому явные варианты «(анг)», «анг.», «_RU».
const ENG = /англ|\(анг|анг\)|анг\.|eng|english|original|оригинал|кит|chin/i;
const RUS = /русск|рус\)|\(рус|[_\- ]ru[_.\- )]|[_\- ]ru$|俄语/i;
export const CHAT_EXT = /^(pdf|jpe?g|png)$/i;

export function categoryOf(name: string, path: string): DocCategory {
  const s = `${path} ${name}`;
  if (/паспорт/i.test(s)) return 'Техпаспорт';
  if (/сертиф|certific|декларац|соответств/i.test(s)) return 'Сертификат';
  if (/инструкц|руковод|manual|说明书|user guide/i.test(s)) return 'Инструкция';
  if (/комплект/i.test(s)) return 'Комплектация';
  if (/характер|габарит|размер|параметр|spec/i.test(s)) return 'Характеристики';
  return 'Другое';
}

/** Файл можно показать менеджеру для отправки покупателю. */
export function isSendable(name: string, path: string): boolean {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (!ext || ext === name.toLowerCase() || HIDDEN_EXT.test(ext)) return false;
  if (INTERNAL.test(name) || INTERNAL.test(path)) return false;
  // Word с «характеристиками» — это рабочая записка (там ссылка на поставщика и ТН ВЭД), не документ для покупателя.
  if (/^docx?$/i.test(ext) && /характер|харак/i.test(name)) return false;
  // Папка «фото» — фото товара для карточки, кроме фото комплектации.
  const dirs = path.split('/').slice(0, -1);
  if (/^(jpe?g|png)$/i.test(ext) && dirs.some(d => /^\s*фото/i.test(d)) && !/комплект/i.test(name)) return false;
  return true;
}

export function isEnglish(name: string, path: string): boolean {
  return ENG.test(`${path} ${name}`) && !RUS.test(name);
}

/** Имя файла для покупателя: китайские/служебные имена → «Инструкция AF-P280.pdf». */
export function friendlyName(d: { name: string; category: DocCategory; english: boolean }, label: string): string {
  const ext = (d.name.split('.').pop() || '').toLowerCase();
  const base = d.name.slice(0, -(ext.length + 1));
  const ugly = /[㐀-鿿]/.test(base) || /^\d+$/.test(base.trim()) || base.trim().length < 3;
  if (!ugly) return d.name;
  const cat = d.category === 'Другое' ? 'Документ' : d.category;
  return `${cat}${d.english ? ' (англ.)' : ''} ${label}`.replace(/[\\/:*?"<>|]+/g, '-').trim() + `.${ext}`;
}

// ─── Список ────────────────────────────────────────────────────────────────
const ydId = (path: string) => `yd:${path}`;

function docsOfRows(rows: any[]): ChatDoc[] {
  const out: ChatDoc[] = [];
  for (const r of rows) {
    for (const f of safeJson(r.files, []) as any[]) {
      if (!f?.path || !isSendable(f.name, f.path)) continue;
      const ext = (f.name.split('.').pop() || '').toLowerCase();
      out.push({
        id: ydId(f.path), name: f.name, folder: r.path, category: categoryOf(f.name, f.path),
        english: isEnglish(f.name, f.path), ext, size: Number(f.size) || null,
        chatOk: CHAT_EXT.test(ext), source: 'disk',
      });
    }
  }
  return out;
}

const CAT_ORDER: DocCategory[] = ['Инструкция', 'Техпаспорт', 'Сертификат', 'Комплектация', 'Характеристики', 'Другое'];
function sortDocs(a: ChatDoc, b: ChatDoc): number {
  return CAT_ORDER.indexOf(a.category) - CAT_ORDER.indexOf(b.category)
    || Number(a.english) - Number(b.english)
    || a.name.localeCompare(b.name, 'ru');
}

function uploadsDb(): any {
  const d = chatDb();
  d.exec(`CREATE TABLE IF NOT EXISTS chat_docs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, offer_id TEXT, name TEXT NOT NULL, mime TEXT NOT NULL,
      size INTEGER NOT NULL, file TEXT NOT NULL, added_at INTEGER NOT NULL, added_by TEXT
    );
    CREATE TABLE IF NOT EXISTS chat_doc_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, marketplace TEXT NOT NULL, chat_id TEXT NOT NULL, at INTEGER NOT NULL,
      channel TEXT NOT NULL, names TEXT NOT NULL, to_masked TEXT, by TEXT, ok INTEGER NOT NULL, error TEXT
    );
    CREATE INDEX IF NOT EXISTS chat_doc_log_chat ON chat_doc_log(marketplace, chat_id, at);`);
  return d;
}

function uploadToDoc(r: any): ChatDoc {
  const ext = (String(r.name).split('.').pop() || '').toLowerCase();
  return {
    id: `up:${r.id}`, name: r.name, folder: r.offer_id ? `Добавлено в кабинете · ${r.offer_id}` : 'Добавлено в кабинете',
    category: categoryOf(r.name, ''), english: isEnglish(r.name, ''), ext, size: r.size,
    chatOk: CHAT_EXT.test(ext), source: 'upload', offerId: r.offer_id,
  };
}

/** Документы товара (Диск + добавленные в кабинете). */
export function docsForOffer(offerId: string | null): ChatDoc[] {
  if (!offerId) return [];
  const { mine, brand } = foldersForOffer(offerId);
  const disk = docsOfRows([...mine, ...brand]);
  const ups = (uploadsDb().prepare('SELECT * FROM chat_docs WHERE UPPER(offer_id) = ? ORDER BY added_at DESC').all(offerId.toUpperCase()) as any[]).map(uploadToDoc);
  return [...ups, ...disk.sort(sortDocs)];
}

/** Поиск по всем товарам: имя папки (артикул) или имя файла. */
export function searchDocs(q: string, limit = 80): ChatDoc[] {
  const s = q.trim().toLowerCase();
  if (s.length < 2) return [];
  const rows = getDb().prepare('SELECT path, files FROM kb_folders ORDER BY path').all() as any[];
  const disk = docsOfRows(rows).filter(d => d.folder.toLowerCase().includes(s) || d.name.toLowerCase().includes(s));
  const ups = (uploadsDb().prepare('SELECT * FROM chat_docs ORDER BY added_at DESC').all() as any[]).map(uploadToDoc)
    .filter(d => d.name.toLowerCase().includes(s) || String(d.offerId || '').toLowerCase().includes(s));
  return [...ups, ...disk.sort((a, b) => a.folder.localeCompare(b.folder, 'ru') || sortDocs(a, b))].slice(0, limit);
}

/** Адреса почты, которые покупатель написал в чате (последний — первым). */
export function emailsInChat(mp: string, chatId: string): string[] {
  const rows = chatDb().prepare('SELECT text FROM chat_messages WHERE marketplace = ? AND chat_id = ? AND from_buyer = 1 ORDER BY at DESC LIMIT 200')
    .all(mp, chatId) as any[];
  const out: string[] = [];
  for (const r of rows) for (const m of String(r.text).match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || []) {
    const e = m.toLowerCase();
    if (!out.includes(e)) out.push(e);
  }
  return out;
}

export function docLog(mp: string, chatId: string): { at: number; channel: string; names: string[]; to: string | null; ok: boolean; error: string | null }[] {
  return (uploadsDb().prepare('SELECT * FROM chat_doc_log WHERE marketplace = ? AND chat_id = ? ORDER BY at DESC LIMIT 30').all(mp, chatId) as any[])
    .map(r => ({ at: r.at, channel: r.channel, names: safeJson(r.names, []), to: r.to_masked, ok: !!r.ok, error: r.error }));
}

function logSend(mp: string, chatId: string, channel: 'chat' | 'email', names: string[], to: string | null, by: string, error: string | null) {
  uploadsDb().prepare('INSERT INTO chat_doc_log (marketplace, chat_id, at, channel, names, to_masked, by, ok, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(mp, chatId, Date.now(), channel, JSON.stringify(names), to ? maskEmail(to) : null, by, error ? 0 : 1, error);
}

export function docsOverview(mp: string, chatId: string) {
  const th = getThread(mp, chatId);
  return {
    docs: docsForOffer(th?.offerId ?? null),
    emails: emailsInChat(mp, chatId),
    log: docLog(mp, chatId),
    mail: { ready: mailReady(), from: mailReady() ? mailFrom() : null },
    diskConnected: !!getSettings().yandexDiskUrl,
  };
}

// ─── Файл: скачать / добавить / удалить ─────────────────────────────────────
const MIME: Record<string, string> = {
  pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', doc: 'application/msword',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', xls: 'application/vnd.ms-excel',
};
export const mimeOf = (name: string) => MIME[(name.split('.').pop() || '').toLowerCase()] || 'application/octet-stream';

/** Документ по id. Путь Диска принимаем только тот, что есть в базе (а не любой присланный). */
export function findDoc(id: string): ChatDoc | null {
  if (id.startsWith('up:')) {
    const r = uploadsDb().prepare('SELECT * FROM chat_docs WHERE id = ?').get(Number(id.slice(3))) as any;
    return r ? uploadToDoc(r) : null;
  }
  if (!id.startsWith('yd:')) return null;
  // Папок десятки — проще пройти все, чем искать по JSON.
  return docsOfRows(getDb().prepare('SELECT path, files FROM kb_folders').all() as any[]).find(d => d.id === id) ?? null;
}

export async function docBytes(doc: ChatDoc): Promise<Buffer> {
  if (doc.source === 'upload') {
    const r = uploadsDb().prepare('SELECT file FROM chat_docs WHERE id = ?').get(Number(doc.id.slice(3))) as any;
    if (!r) throw new Error('Файл удалён');
    return readFile(join(UPLOAD_DIR, r.file));
  }
  const key = getSettings().yandexDiskUrl;
  if (!key) throw new Error('Не задана ссылка на папку Яндекс.Диска');
  const href = await ydDownloadUrl(key, doc.id.slice(3));
  const r = await fetch(href, { signal: AbortSignal.timeout(180_000) });
  if (!r.ok) throw new Error(`Яндекс.Диск: файл не скачался (${r.status})`);
  const len = Number(r.headers.get('content-length') || 0);
  if (len > DOWNLOAD_MAX) throw new Error(`Файл ${(len / 1048576).toFixed(0)} МБ — слишком большой`);
  return Buffer.from(await r.arrayBuffer());
}

export async function addUpload(offerId: string | null, name: string, data: Buffer, by: string): Promise<ChatDoc> {
  const clean = String(name || '').replace(/[\\/:*?"<>|\r\n]+/g, ' ').trim().slice(0, 150);
  const ext = (clean.split('.').pop() || '').toLowerCase();
  if (!clean || !MIME[ext]) throw new Error('Можно добавить PDF, JPG, PNG, Word или Excel');
  if (!data.length) throw new Error('Пустой файл');
  // nginx пропускает до 10 МБ; большие файлы — через Яндекс.Диск.
  if (data.length > 10 * 1024 * 1024) throw new Error('Файл больше 10 МБ — положите его в папку товара на Яндекс.Диске');
  await mkdir(UPLOAD_DIR, { recursive: true });
  const file = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  await writeFile(join(UPLOAD_DIR, file), data);
  const r = uploadsDb().prepare('INSERT INTO chat_docs (offer_id, name, mime, size, file, added_at, added_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(offerId ? String(offerId).trim().slice(0, 80) : null, clean, MIME[ext], data.length, file, Date.now(), by);
  rlog('info', 'Документы: добавлен файл', { name: clean, offer: offerId, by });
  return uploadToDoc(uploadsDb().prepare('SELECT * FROM chat_docs WHERE id = ?').get(Number(r.lastInsertRowid)));
}

export async function removeUpload(id: string): Promise<void> {
  if (!id.startsWith('up:')) throw new Error('С Диска файлы удаляются на самом Диске');
  const r = uploadsDb().prepare('SELECT * FROM chat_docs WHERE id = ?').get(Number(id.slice(3))) as any;
  if (!r) return;
  uploadsDb().prepare('DELETE FROM chat_docs WHERE id = ?').run(r.id);
  const p = join(UPLOAD_DIR, r.file);
  if (existsSync(p)) await unlink(p).catch(e => console.warn('[chatDocs] файл не удалён:', (e as Error).message));
}

// ─── Подготовка к чату: уложиться в 5 МБ ────────────────────────────────────
async function shrinkPdf(buf: Buffer): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), 'rv-doc-'));
  try {
    const src = join(dir, 'in.pdf');
    await writeFile(src, buf);
    let best = buf;
    // /ebook — 150 dpi (читается хорошо); /screen — 72 dpi, последний шанс.
    for (const preset of ['/ebook', '/screen']) {
      const out = join(dir, `out${preset.slice(1)}.pdf`);
      try {
        await run('gs', ['-sDEVICE=pdfwrite', '-dCompatibilityLevel=1.5', `-dPDFSETTINGS=${preset}`, '-dNOPAUSE', '-dBATCH', '-dQUIET', `-sOutputFile=${out}`, src], { timeout: 180_000 });
        const small = await readFile(out);
        if (small.length < best.length) best = small;
        if (best.length <= CHAT_FILE_MAX) break;
      } catch (e) { console.warn('[chatDocs] gs не сжал PDF:', String((e as Error).message).slice(0, 200)); }
    }
    return best;
  } finally { await rm(dir, { recursive: true, force: true }).catch(e => console.warn('[chatDocs] tmp:', (e as Error).message)); }
}

async function shrinkImage(buf: Buffer): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), 'rv-doc-'));
  try {
    const src = join(dir, 'src'); const out = join(dir, 'out.jpg');
    await writeFile(src, buf);
    await run('convert', [`${src}[0]`, '-auto-orient', '-resize', '2400x2400>', '-quality', '85', out], { timeout: 120_000 });
    return await readFile(out);
  } catch (e) {
    console.warn('[chatDocs] картинка не уменьшилась:', String((e as Error).message).slice(0, 200));
    return buf;
  } finally { await rm(dir, { recursive: true, force: true }).catch(e => console.warn('[chatDocs] tmp:', (e as Error).message)); }
}

/** Разрезать PDF по страницам на части не больше 5 МБ (gs, диапазоны страниц). null — не вышло. */
async function splitPdf(buf: Buffer): Promise<Buffer[] | null> {
  const dir = await mkdtemp(join(tmpdir(), 'rv-split-'));
  try {
    const src = join(dir, 'in.pdf');
    await writeFile(src, buf);
    const info = (await run('pdfinfo', [src], { timeout: 60_000 })).stdout;
    const pages = Number(info.match(/Pages:\s+(\d+)/)?.[1] || 0);
    if (pages < 2) return null;
    // Начинаем с расчёта «по размеру», при неудаче режем мельче (части бывают неравными: картинки на одних страницах).
    for (let parts = Math.ceil(buf.length / (CHAT_FILE_MAX * 0.85)); parts <= Math.min(pages, 6); parts++) {
      const per = Math.ceil(pages / parts);
      const out: Buffer[] = [];
      for (let first = 1; first <= pages; first += per) {
        const file = join(dir, `p${parts}-${first}.pdf`);
        await run('gs', ['-sDEVICE=pdfwrite', '-dNOPAUSE', '-dBATCH', '-dQUIET', `-dFirstPage=${first}`, `-dLastPage=${Math.min(pages, first + per - 1)}`, `-sOutputFile=${file}`, src], { timeout: 180_000 });
        out.push(await readFile(file));
      }
      if (out.every(b => b.length <= CHAT_FILE_MAX)) return out;
    }
    return null;
  } catch (e) {
    console.warn('[chatDocs] PDF не разрезался:', String((e as Error).message).slice(0, 200));
    return null;
  } finally { await rm(dir, { recursive: true, force: true }).catch(e => console.warn('[chatDocs] tmp:', (e as Error).message)); }
}

export type ChatFile = { name: string; mime: string; data: Buffer };

/**
 * Файл под правила чата: ≤ 5 МБ. Большой PDF — сжать; не хватило — разрезать на части
 * («… (часть 1 из 2).pdf»); большая картинка — уменьшить.
 */
export async function prepareForChat(doc: ChatDoc, data: Buffer, label: string, mp: 'wb' | 'ozon' = 'wb'): Promise<ChatFile[]> {
  let name = friendlyName(doc, label);
  if (!doc.chatOk) throw new Error(`«${doc.name}»: в чат площадка принимает только PDF, JPG и PNG — отправьте на почту`);
  let out = data; let mime = mimeOf(doc.name);
  // Ozon: файл не режем (решение владельца 20.11) — шлём целиком; если Ozon откажет по размеру, sendDocsToChat пробует сжатый.
  if (mp === 'ozon') return [{ name, mime, data: out }];
  if (out.length > CHAT_FILE_MAX) {
    if (doc.ext === 'pdf') out = await shrinkPdf(out);
    else { out = await shrinkImage(out); mime = 'image/jpeg'; name = name.replace(/\.(png|jpe?g)$/i, '.jpg'); }
  }
  if (out.length <= CHAT_FILE_MAX) return [{ name, mime, data: out }];
  const parts = doc.ext === 'pdf' ? await splitPdf(out) : null;
  if (!parts) throw new Error(`«${doc.name}»: даже сжатый файл ${(out.length / 1048576).toFixed(1)} МБ, а в чат можно до 5 МБ — отправьте на почту`);
  const base = name.replace(/\.pdf$/i, '');
  return parts.map((b, i) => ({ name: `${base} (часть ${i + 1} из ${parts.length}).pdf`, mime, data: b }));
}

// ─── Отправка ───────────────────────────────────────────────────────────────
async function sendFileToChat(mp: 'wb' | 'ozon', chatId: string, f: { name: string; mime: string; data: Buffer }): Promise<void> {
  if (mp === 'wb') {
    const sign = replySignOf(mp, chatId);
    if (!sign) throw new Error('Нет подписи чата — нажмите «Обновить» вверху страницы');
    const url = `${WB_CHAT_BASE}/api/v1/seller/message`;
    const form = new FormData();
    form.append('replySign', sign);
    form.append('file', new Blob([new Uint8Array(f.data)], { type: f.mime }), f.name);
    await gate(url, 0);
    const r = await fetch(url, { method: 'POST', headers: wbChatHeaders(), body: form, signal: AbortSignal.timeout(120_000) });
    note(url, r.status, Number(r.headers.get('retry-after')) || undefined);
    const t = await r.text();
    let j: any = null; try { j = JSON.parse(t); } catch { /* не JSON */ }
    if (!r.ok || (Array.isArray(j?.errors) && j.errors.length)) {
      throw new Error(`WB ${r.status}: ${String(j?.detail || j?.error || (Array.isArray(j?.errors) ? j.errors.join('; ') : '') || t).slice(0, 200)}`);
    }
    return;
  }
  const up = ozonUpstream();
  const url = `${up.base}/v1/chat/send/file`;
  await gate(url, 0);
  const r = await fetch(url, {
    method: 'POST', headers: { ...(up.headers as any), 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, name: f.name, base64_content: f.data.toString('base64') }),
    signal: AbortSignal.timeout(120_000),
  });
  note(url, r.status, Number(r.headers.get('retry-after')) || undefined);
  const t = await r.text();
  let j: any = null; try { j = JSON.parse(t); } catch { /* не JSON */ }
  if (!r.ok || (j && j.result && j.result !== 'success')) throw new Error(`Ozon ${r.status}: ${String(j?.message || j?.result || t).slice(0, 200)}`);
}

function labelFor(mp: string, chatId: string): string {
  const th = getThread(mp, chatId);
  return th?.offerId || th?.productName?.slice(0, 40) || 'к товару';
}

export type SendResult = { ok: boolean; sent: string[]; errors: string[] };

export async function sendDocsToChat(mp: 'wb' | 'ozon', chatId: string, ids: string[], by: string): Promise<SendResult> {
  if (!getThread(mp, chatId)) return { ok: false, sent: [], errors: ['Чат не найден'] };
  const label = labelFor(mp, chatId);
  const sent: string[] = []; const errors: string[] = [];
  for (const id of ids.slice(0, 10)) {
    const doc = findDoc(id);
    if (!doc) { errors.push('Файл не найден — обновите список'); continue; }
    try {
      for (const f of await prepareForChat(doc, await docBytes(doc), label, mp)) {
        try {
          await sendFileToChat(mp, chatId, f);
        } catch (e) {
          // Ozon не принял большой PDF целиком — одна попытка со сжатым (без нарезки).
          if (mp !== 'ozon' || doc.ext !== 'pdf' || f.data.length <= CHAT_FILE_MAX) throw e;
          console.warn('[chatDocs] Ozon не принял файл целиком, пробую сжатый:', String((e as Error).message).slice(0, 200));
          const small = await shrinkPdf(f.data);
          if (small.length >= f.data.length) throw e;
          await sendFileToChat(mp, chatId, { ...f, data: small });
        }
        sent.push(f.name);
        // Своё сообщение — сразу в ленту (WB пришлёт событие «[файл: …]» с тем же текстом, и это заменит пометку).
        addMessages(mp, chatId, [{ id: `local:${Date.now()}-${sent.length}`, at: Date.now(), fromBuyer: false, text: `[файл: ${f.name}]` }]);
      }
    } catch (e) {
      errors.push(String((e as Error)?.message ?? e).slice(0, 300));
    }
  }
  const mpName = mp === 'wb' ? 'WB' : 'Ozon';
  if (sent.length) { logSend(mp, chatId, 'chat', sent, null, by, null); rlog('info', `Чат ${mpName}: отправлены документы`, { chat: chatId, by, files: sent }); }
  if (errors.length) { logSend(mp, chatId, 'chat', [], null, by, errors.join(' · ').slice(0, 500)); rlog('warn', `Чат ${mpName}: документ не отправлен`, { chat: chatId, by, errors }); }
  return { ok: !errors.length, sent, errors };
}

export function defaultMailText(mp: string, chatId: string): { subject: string; text: string } {
  const th = getThread(mp, chatId);
  const product = th?.productName ? `«${th.productName}»` : 'товару';
  const mpName = mp === 'wb' ? 'Wildberries' : 'Ozon';
  return {
    subject: `Документы к товару${th?.offerId ? ` ${th.offerId}` : ''}`,
    text: `Здравствуйте!\n\nКак договаривались в чате ${mpName}, высылаем документы к ${product} во вложении.\n\nЕсли появятся вопросы — пишите нам в чат магазина на ${mpName}, ответим.\n\nХорошего дня!`,
  };
}

export async function emailDocs(mp: 'wb' | 'ozon', chatId: string, ids: string[], to: string, text: string, by: string): Promise<SendResult> {
  const email = String(to || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return { ok: false, sent: [], errors: ['Проверьте адрес почты'] };
  if (!mailReady()) return { ok: false, sent: [], errors: ['Почта магазина ещё не подключена'] };
  const label = labelFor(mp, chatId);
  const attachments: { name: string; mime: string; data: Buffer }[] = [];
  const errors: string[] = [];
  let total = 0;
  for (const id of ids.slice(0, 10)) {
    const doc = findDoc(id);
    if (!doc) { errors.push('Файл не найден — обновите список'); continue; }
    try {
      let data = await docBytes(doc);
      // Тяжёлый PDF (инструкции по 70 МБ) в письмо целиком не влезет — сжимаем так же, как для чата.
      if (doc.ext === 'pdf' && data.length > 8 * 1024 * 1024) data = await shrinkPdf(data);
      if (total + data.length > MAIL_TOTAL_MAX) { errors.push(`«${doc.name}» не влез в письмо (всего больше 20 МБ) — отправьте отдельным письмом`); continue; }
      total += data.length;
      attachments.push({ name: friendlyName(doc, label), mime: mimeOf(doc.name), data });
    } catch (e) { errors.push(String((e as Error)?.message ?? e).slice(0, 300)); }
  }
  if (!attachments.length) return { ok: false, sent: [], errors: errors.length ? errors : ['Не выбраны файлы'] };
  const def = defaultMailText(mp, chatId);
  try {
    await sendMail({ to: email, subject: def.subject, text: String(text || '').trim() || def.text, attachments });
  } catch (e) {
    const msg = String((e as Error)?.message ?? e).slice(0, 300);
    logSend(mp, chatId, 'email', [], email, by, msg);
    rlog('error', 'Документы: письмо не ушло', { chat: chatId, to: maskEmail(email), error: msg });
    return { ok: false, sent: [], errors: [msg, ...errors] };
  }
  const names = attachments.map(a => a.name);
  logSend(mp, chatId, 'email', names, email, by, errors.length ? errors.join(' · ').slice(0, 500) : null);
  rlog('info', 'Документы: отправлены на почту', { chat: chatId, to: maskEmail(email), files: names, by });
  return { ok: !errors.length, sent: names, errors };
}
