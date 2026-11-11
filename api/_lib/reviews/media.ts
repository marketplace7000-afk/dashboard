/**
 * Фото покупателей (11.11.2026): отзывы WB и Ozon, чаты WB и Ozon.
 * Раньше агент видел только пометку «[фото]» — теперь картинка уходит в Claude вместе
 * с отзывом/перепиской, а короткое описание «что на фото» сохраняется рядом (поле note):
 * его видит менеджер, и оно же заменяет картинку в старой части переписки.
 *
 *   owner = «item:<id отзыва>» | «chat:<wb|ozon>:<id сообщения>»
 *   url   = публичная ссылка площадки | «wbdl:<downloadID>» (вложение чата WB, качается токеном)
 *           | https://api-seller.ozon.ru/…/chat/file/… (вложение чата Ozon, качается ключом)
 *           | «none:» — видео без кадра-превью: посмотреть нельзя, но модель знает, что оно есть.
 * Ключи площадок уходят ТОЛЬКО на их собственные адреса — см. fetchBytes.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDb, rlog } from './db';
import { ozonUpstream } from '../../_proxy';

const run = promisify(execFile);

export type MediaKind = 'photo' | 'video';
export type MediaRow = { id: number; owner: string; idx: number; kind: MediaKind; url: string; note: string | null; error: string | null };
export type MediaIn = { kind: MediaKind; url: string };

let ready = false;
function mdb(): any {
  const d = getDb();
  if (ready) return d;
  d.exec(`
    CREATE TABLE IF NOT EXISTS media (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner TEXT NOT NULL, idx INTEGER NOT NULL,
      kind TEXT NOT NULL DEFAULT 'photo', url TEXT NOT NULL,
      note TEXT, error TEXT, created_at INTEGER NOT NULL,
      UNIQUE(owner, idx)
    );
  `);
  ready = true;
  return d;
}

const toRow = (r: any): MediaRow => ({ id: r.id, owner: r.owner, idx: r.idx, kind: r.kind, url: r.url, note: r.note, error: r.error });

/** Запомнить вложения владельца. Возвращает, сколько появилось новых (повторный сбор — 0). */
export function addMedia(owner: string, list: MediaIn[] | undefined | null): number {
  if (!list?.length) return 0;
  const ins = mdb().prepare('INSERT OR IGNORE INTO media (owner, idx, kind, url, created_at) VALUES (?, ?, ?, ?, ?)');
  let n = 0;
  list.slice(0, 12).forEach((m, i) => {
    const url = String(m?.url || '').trim().slice(0, 1000);
    if (!url) return;
    if (ins.run(owner, i, m.kind === 'video' ? 'video' : 'photo', url, Date.now()).changes) n++;
  });
  return n;
}

export function mediaOf(owner: string): MediaRow[] {
  return (mdb().prepare('SELECT * FROM media WHERE owner = ? ORDER BY idx').all(owner) as any[]).map(toRow);
}

export function mediaOfMany(owners: string[]): Map<string, MediaRow[]> {
  const out = new Map<string, MediaRow[]>();
  const d = mdb();
  for (let i = 0; i < owners.length; i += 400) {
    const part = owners.slice(i, i + 400);
    if (!part.length) continue;
    const rows = d.prepare(`SELECT * FROM media WHERE owner IN (${part.map(() => '?').join(',')}) ORDER BY owner, idx`).all(...part) as any[];
    for (const r of rows) { const a = out.get(r.owner) || []; a.push(toRow(r)); out.set(r.owner, a); }
  }
  return out;
}

export function getMedia(id: number): MediaRow | null {
  const r = mdb().prepare('SELECT * FROM media WHERE id = ?').get(id);
  return r ? toRow(r) : null;
}

export function setMediaNote(id: number, note: string): void {
  mdb().prepare('UPDATE media SET note = ?, error = NULL WHERE id = ?').run(note.replace(/\s+/g, ' ').trim().slice(0, 600), id);
}
function setMediaError(id: number, error: string | null): void {
  mdb().prepare('UPDATE media SET error = ? WHERE id = ?').run(error ? error.slice(0, 200) : null, id);
}

/** Для кабинета: без адресов (в них бывают служебные идентификаторы) — картинка отдаётся через /api/reviews/media/<id>. */
export type MediaView = { id: number; kind: MediaKind; note: string | null; viewable: boolean; error: string | null };
export const toView = (m: MediaRow): MediaView => ({ id: m.id, kind: m.kind, note: m.note, viewable: !m.url.startsWith('none:'), error: m.error });

// ─── Скачивание ────────────────────────────────────────────────────────────
/** Публичные хранилища картинок площадок (без ключей). Чужие адреса не качаем вовсе. */
const PUBLIC_HOSTS = /(^|\.)(geobasket\.ru|wbbasket\.ru|wbstatic\.net|wb\.ru|wildberries\.ru|ozone\.ru|ozon\.ru|ozonusercontent\.com)$/i;
const MAX_BYTES = 30_000_000;

async function fetchBytes(url: string): Promise<{ buf: Buffer; mime: string }> {
  let target = url;
  let headers: Record<string, string> = {};
  if (url.startsWith('wbdl:')) {
    const id = url.slice(5);
    if (!/^[A-Za-z0-9-]{8,80}$/.test(id)) throw new Error('неверный идентификатор вложения WB');
    const { WB_CHAT_BASE, wbChatHeaders } = await import('./sources');
    target = `${WB_CHAT_BASE}/api/v1/seller/download/${id}`;
    headers = wbChatHeaders();
  } else {
    const u = new URL(url);
    if (u.protocol !== 'https:') throw new Error('только https');
    if (u.hostname === 'api-seller.ozon.ru') {
      if (!/^\/v\d+\/chat\/file\//.test(u.pathname)) throw new Error('не вложение чата Ozon');
      const h = ozonUpstream().headers as any;
      headers = { 'Client-Id': h['Client-Id'], 'Api-Key': h['Api-Key'] };
    } else if (!PUBLIC_HOSTS.test(u.hostname)) {
      throw new Error(`адрес не из списка площадок (${u.hostname})`);
    }
  }
  // Переадресации не следуем: ключ не должен уйти на чужой адрес.
  const r = await fetch(target, { headers, redirect: Object.keys(headers).length ? 'error' : 'follow', signal: AbortSignal.timeout(60_000) });
  if (!r.ok) throw new Error(`не скачалось (${r.status})`);
  if (Number(r.headers.get('content-length') || 0) > MAX_BYTES) throw new Error('файл слишком большой');
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new Error('файл слишком большой');
  return { buf, mime: (r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase() };
}

function sniff(buf: Buffer): string | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (buf.subarray(0, 3).toString('latin1') === 'GIF') return 'image/gif';
  return null;
}

/** Любая картинка → JPEG не больше side px по длинной стороне (ImageMagick). null — не картинка или нет программы. */
async function toJpeg(buf: Buffer, side: number): Promise<Buffer | null> {
  const dir = await mkdtemp(join(tmpdir(), 'rv-media-'));
  try {
    const src = join(dir, 'src'); const out = join(dir, 'out.jpg');
    await writeFile(src, buf);
    await run('convert', [`${src}[0]`, '-auto-orient', '-resize', `${side}x${side}>`, '-quality', '80', out], { timeout: 60_000 });
    return await readFile(out);
  } catch { return null; } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Claude читает картинку до 1568 px по длинной стороне — больше только дороже. */
const MODEL_SIDE = 1568;
const MODEL_MAX_BYTES = 3_200_000;

/** Картинка в виде, пригодном и для Claude, и для показа в кабинете. Ошибка — с понятным текстом. */
export async function loadImage(m: MediaRow, side = MODEL_SIDE): Promise<{ data: Buffer; mime: string }> {
  if (m.url.startsWith('none:')) throw new Error('видео без кадра');
  const { buf } = await fetchBytes(m.url);
  const jpg = await toJpeg(buf, side);
  if (jpg && jpg.length <= MODEL_MAX_BYTES) return { data: jpg, mime: 'image/jpeg' };
  const kind = sniff(buf);
  if (kind && buf.length <= MODEL_MAX_BYTES) return { data: buf, mime: kind };
  throw new Error(kind ? 'картинка слишком большая, уменьшить не удалось' : 'файл не является картинкой');
}

// ─── Блоки для Claude ──────────────────────────────────────────────────────
export type Shown = { n: number; row: MediaRow; ok: boolean; label: string };

/**
 * Картинки → блоки сообщения Claude с подписями «Фото 1», «Фото 2»… (по ним модель потом
 * возвращает описания). Что не открылось — честно помечается, чтобы модель не делала вид, что видела.
 */
export async function imageBlocks(list: { row: MediaRow; label: string }[]): Promise<{ blocks: any[]; shown: Shown[] }> {
  const blocks: any[] = [];
  const shown: Shown[] = [];
  let n = 0;
  for (const { row, label } of list) {
    n++;
    const title = `Фото ${n}${row.kind === 'video' ? ' (кадр из видео покупателя; само видео недоступно)' : ''}${label ? ` — ${label}` : ''}`;
    try {
      const im = await loadImage(row);
      blocks.push({ type: 'text', text: `${title}:` });
      blocks.push({ type: 'image', source: { type: 'base64', media_type: im.mime, data: im.data.toString('base64') } });
      shown.push({ n, row, ok: true, label: title });
      if (row.error) setMediaError(row.id, null);
    } catch (e) {
      const why = String((e as Error)?.message ?? e).slice(0, 150);
      setMediaError(row.id, why);
      rlog('warn', 'Фото покупателя не открылось', { owner: row.owner, error: why });
      blocks.push({ type: 'text', text: `${title}: НЕ ОТКРЫЛОСЬ — ты его не видишь.` });
      shown.push({ n, row, ok: false, label: title });
    }
  }
  return { blocks, shown };
}

/** Описания из ответа модели ({"photos": {"1": "…"}} или массив) → в базу. */
export function saveNotes(shown: Shown[], photos: unknown): void {
  if (!photos || typeof photos !== 'object') return;
  for (const s of shown) {
    if (!s.ok) continue;
    const v = Array.isArray(photos) ? photos[s.n - 1] : (photos as any)[String(s.n)] ?? (photos as any)[`Фото ${s.n}`];
    const note = typeof v === 'string' ? v.trim() : '';
    if (note.length >= 3) setMediaNote(s.row.id, note);
  }
}

/** Общий кусок инструкции для отзывов и чатов. */
export const PHOTO_RULES = `ФОТО ПОКУПАТЕЛЯ: если к сообщению приложены изображения («Фото 1», «Фото 2»…), внимательно рассмотри каждое: что за товар и тот ли он, в каком состоянии, что написано на экране, упаковке или этикетке, как подключено, что за машина/магнитола/устройство. Учитывай увиденное так же, как слова покупателя: отвечай по сути того, что на фото, а не пересказывай его. Текст ошибки или надпись с фото используй как факт. Если на фото видны повреждение, брак, не тот товар или неполная комплектация — needs_escalation = true. Если по фото ничего нельзя понять, оно не открылось или это видео, которого ты не видишь, — не делай вид, что видел: при необходимости попроси описать словами. Не выдумывай того, чего на фото нет.
В поле "photos" опиши каждое открывшееся фото одной фразой по делу (что видно; надписи и текст ошибок — дословно): {"1": "…", "2": "…"}. Фото нет — "photos": {}.`;
