/**
 * Слежение за конкурентами по каждому нашему товару (этап 1 из плана 11.08).
 *
 * Клиент попросил ДВА режима и оба обязательны (переписка 11.08, 09:03):
 *  1) система сама находит конкурентов и предлагает их, чтобы мы ничего не
 *     пропустили. Но не десятки — «достаточно 5 сильнейших прямых конкурентов
 *     с продажами»;
 *  2) менеджер руками цепляет по ссылке тех, кто реально важен, и агент следит
 *     именно за ними.
 * Поэтому у каждой привязки есть источник (`manual` / `auto`) и статус: авто-
 * находки лежат как «предложены» и в расчёт рынка не идут, пока их не одобрят.
 * Так система не начинает молча считать рынок по случайным товарам из выдачи.
 *
 * Хранилище — файл, как у справочника себестоимости (costs.ts). База данных ради
 * пары сотен строк не нужна, а файл переживает рестарт и его видно глазами.
 * История цен — в SQLite рядом со снимками дня (history.ts): её нужно
 * накапливать долго и читать диапазонами.
 */
import { join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { mskDate } from './mskDate';
import { noteSwallowed } from './log';

// ─── Файл привязок ──────────────────────────────────────────────────────────
const FILE = process.env.COMPETITORS_FILE || join(process.cwd(), 'av-data', 'competitors.json');

export type WatchSource = 'manual' | 'auto';
export type WatchStatus = 'active' | 'suggested' | 'ignored';

export type CompetitorLink = {
  /** Артикул WB конкурента. Единственный надёжный ключ: ссылки клиент шлёт разные. */
  nmId: number;
  source: WatchSource;
  status: WatchStatus;
  /** Что видели при добавлении — чтобы в списке было понятно, кто это. */
  title?: string;
  brand?: string;
  addedAt: number;
  /** Заметка менеджера («основной конкурент», «дешёвая копия» и т.п.). */
  note?: string;
};

/** Ключ — НАШ артикул продавца (vendorCode, в верхнем регистре). */
export type WatchStore = {
  items: Record<string, { nmId?: number; links: CompetitorLink[] }>;
  updatedAt: number;
};

const EMPTY: WatchStore = { items: {}, updatedAt: 0 };
let cache: WatchStore | null = null;

function read(): WatchStore {
  if (cache) return cache;
  try {
    cache = JSON.parse(readFileSync(FILE, 'utf8')) as WatchStore;
    if (!cache.items) cache = { ...EMPTY };
  } catch {
    cache = { ...EMPTY, items: {} };
  }
  return cache!;
}

function write(s: WatchStore): void {
  cache = s;
  try {
    mkdirSync(join(FILE, '..'), { recursive: true });
    // Через временный файл: если процесс убьют на записи, основной не побьётся.
    const tmp = `${FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(s, null, 2), 'utf8');
    renameSync(tmp, FILE);
  } catch (e) {
    console.warn('[competitors] не удалось сохранить привязки:', (e as Error).message);
  }
}

const norm = (sku: string) => String(sku ?? '').trim().toUpperCase();

export function getWatchList(): WatchStore {
  return read();
}

/** Привязки одного товара. Пустой массив, если ничего не заводили. */
export function getLinks(sku: string): CompetitorLink[] {
  return read().items[norm(sku)]?.links ?? [];
}

/**
 * Добавить конкурента. Повторное добавление того же nmId не плодит дубли, а
 * ПОВЫШАЕТ статус: если товар был предложен автоматически, а менеджер добавил
 * его руками — он становится подтверждённым вручную.
 */
export function addLink(
  sku: string,
  nmId: number,
  opts: { source?: WatchSource; title?: string; brand?: string; note?: string } = {},
): CompetitorLink[] {
  const s = read();
  const key = norm(sku);
  if (!key || !Number.isFinite(nmId) || nmId <= 0) return getLinks(sku);

  const entry = s.items[key] ?? { links: [] };
  const source = opts.source ?? 'manual';
  const existing = entry.links.find(l => l.nmId === nmId);

  if (existing) {
    if (source === 'manual') { existing.source = 'manual'; existing.status = 'active'; }
    if (opts.title) existing.title = opts.title;
    if (opts.brand) existing.brand = opts.brand;
    if (opts.note !== undefined) existing.note = opts.note;
  } else {
    entry.links.push({
      nmId,
      source,
      // Авто-находки ждут одобрения: иначе рынок посчитается по случайным
      // товарам из выдачи, а клиент просил только реальных конкурентов.
      status: source === 'manual' ? 'active' : 'suggested',
      title: opts.title,
      brand: opts.brand,
      note: opts.note,
      addedAt: Date.now(),
    });
  }
  s.items[key] = entry;
  s.updatedAt = Date.now();
  write(s);
  return entry.links;
}

/** Сменить статус: одобрить авто-находку или убрать конкурента из расчёта. */
export function setLinkStatus(sku: string, nmId: number, status: WatchStatus): CompetitorLink[] {
  const s = read();
  const entry = s.items[norm(sku)];
  if (!entry) return [];
  const link = entry.links.find(l => l.nmId === nmId);
  if (link) { link.status = status; s.updatedAt = Date.now(); write(s); }
  return entry.links;
}

export function removeLink(sku: string, nmId: number): CompetitorLink[] {
  const s = read();
  const key = norm(sku);
  const entry = s.items[key];
  if (!entry) return [];
  entry.links = entry.links.filter(l => l.nmId !== nmId);
  s.updatedAt = Date.now();
  write(s);
  return entry.links;
}

/** Артикул WB из ссылки или из строки с числом. Клиент шлёт и то, и другое. */
export function parseNmId(input: string): number | null {
  const s = String(input ?? '').trim();
  // https://www.wildberries.ru/catalog/1271418370/detail.aspx
  const fromUrl = /wildberries\.ru\/catalog\/(\d{4,})/i.exec(s);
  if (fromUrl) return Number(fromUrl[1]);
  // «nm1271418370» или просто число
  const bare = /(\d{4,})/.exec(s.replace(/^nm/i, ''));
  return bare ? Number(bare[1]) : null;
}

/** Все артикулы конкурентов, за которыми реально следим (без предложенных). */
export function activeNmIds(): number[] {
  const out = new Set<number>();
  for (const entry of Object.values(read().items)) {
    for (const l of entry.links) if (l.status === 'active') out.add(l.nmId);
  }
  return [...out];
}

// ─── История цен конкурентов (SQLite) ───────────────────────────────────────
// Отдельная таблица в той же базе, что снимки дня. Как и там: если node:sqlite
// недоступен, модуль молча выключается, а привязки продолжают работать.
let DatabaseSync: any = null;
try { DatabaseSync = require('node:sqlite').DatabaseSync; } catch { DatabaseSync = null; }

const DB_DIR = process.env.CACHE_DIR || join(process.cwd(), '.av-cache');
const DB_PATH = join(DB_DIR, 'history.sqlite');
let db: any = null;
let dbFailed = false;

function getDb(): any | null {
  if (db) return db;
  if (dbFailed || !DatabaseSync) return null;
  try {
    mkdirSync(DB_DIR, { recursive: true });
    db = new DatabaseSync(DB_PATH);
    db.exec(`
      CREATE TABLE IF NOT EXISTS competitor_price (
        date   TEXT NOT NULL,
        nm_id  INTEGER NOT NULL,
        price  INTEGER NOT NULL,
        title  TEXT,
        brand  TEXT,
        rating REAL,
        feedbacks INTEGER,
        PRIMARY KEY (date, nm_id)
      );
    `);
    return db;
  } catch (e) {
    console.warn('[competitors] история цен выключена:', (e as Error).message);
    dbFailed = true;
    return null;
  }
}

export type PricePoint = { date: string; nmId: number; price: number; title?: string; brand?: string };

/**
 * Записать цены за сегодня. Один замер в сутки на артикул: цель — тренд, а не
 * тиковый график, и лишние строки только раздувают базу.
 */
export function recordPrices(points: Omit<PricePoint, 'date'>[]): number {
  const d = getDb();
  if (!d || !points.length) return 0;
  const date = mskDate(0);
  const st = d.prepare(`
    INSERT INTO competitor_price (date, nm_id, price, title, brand)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(date, nm_id) DO UPDATE SET price=excluded.price, title=excluded.title, brand=excluded.brand
  `);
  let n = 0;
  for (const p of points) {
    if (!Number.isFinite(p.nmId) || !(p.price > 0)) continue;
    try { st.run(date, p.nmId, Math.round(p.price), p.title ?? null, p.brand ?? null); n++; } catch (e) { noteSwallowed('competitor-watch', 'цена конкурента не записана', e); }
  }
  return n;
}

/** Ряд цен по артикулу за N дней — для графика «как менялась цена конкурента». */
export function getPriceSeries(nmId: number, days = 30): { date: string; price: number }[] {
  const d = getDb();
  if (!d) return [];
  const from = mskDate(days);
  try {
    return d.prepare('SELECT date, price FROM competitor_price WHERE nm_id = ? AND date >= ? ORDER BY date')
      .all(nmId, from) as { date: string; price: number }[];
  } catch { return []; }
}

/** Последняя известная цена по каждому из артикулов. */
export function getLatestPrices(nmIds: number[]): Record<number, { price: number; date: string; title?: string }> {
  const d = getDb();
  const out: Record<number, { price: number; date: string; title?: string }> = {};
  if (!d || !nmIds.length) return out;
  try {
    const rows = d.prepare(`
      SELECT nm_id, price, date, title FROM competitor_price
      WHERE nm_id IN (${nmIds.map(() => '?').join(',')})
        AND date = (SELECT MAX(date) FROM competitor_price cp2 WHERE cp2.nm_id = competitor_price.nm_id)
    `).all(...nmIds) as any[];
    for (const r of rows) out[r.nm_id] = { price: r.price, date: r.date, title: r.title ?? undefined };
  } catch (e) {
    // Пустой ответ штатен, пока история не накопилась. Ошибка запроса штатной не
    // бывает: без записи сломанная таблица выглядит так же, как пустая.
    noteSwallowed('competitor-watch', 'последние цены не прочитаны', e);
  }
  return out;
}
