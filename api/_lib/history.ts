/**
 * Слой истории (ежедневные снимки) на встроенном node:sqlite (Node ≥ 22.5 / 24).
 *
 * Зачем: кэш в памяти теряет цифры при рестарте/протухании/429 от WB — и сайт/бот
 * пишут «данные прогреваются», хотя вчера они были. БД хранит снимок ЗА КАЖДЫЙ
 * ДЕНЬ, поэтому даже когда апстрим сегодня недоступен, мы отдаём последнюю
 * известную цифру (с пометкой «на дату X») вместо пустоты + даём историю/тренды.
 *
 * Принцип: cron раз в день пишет строку (recordDailySnapshot). buildSnapshot()
 * при промахе живого кэша берёт последнюю строку из БД (getLatestSnapshot).
 *
 * Деградация: если node:sqlite недоступен (старый Node) — модуль превращается в
 * no-op, ничего не падает, просто истории не будет (как было раньше).
 */
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

// node:sqlite — встроенный, без npm-зависимостей. На старом Node (< 22.5) require
// бросит — тогда работаем в режиме no-op (история просто выключена).
let DatabaseSync: any = null;
try {
  // api/ — CommonJS (api/package.json), require доступен.
  DatabaseSync = require('node:sqlite').DatabaseSync;
} catch {
  DatabaseSync = null;
}

const DB_DIR = process.env.CACHE_DIR || join(process.cwd(), '.av-cache');
const DB_PATH = join(DB_DIR, 'history.sqlite');

export type DailyRow = {
  date: string;            // YYYY-MM-DD (МСК)
  // Ozon
  ozonRevenue: number | null;
  ozonOrders: number | null;
  ozonProducts: number | null;
  // WB
  wbRevenue: number | null;
  wbOrders: number | null;
  wbProducts: number | null;
  // общие метрики кабинета
  reviewsUnanswered: number | null;
  reviewsArchive: number | null;
  adsTotal: number | null;
  adsActive: number | null;
  updatedAt: number;
};

let db: any = null;
let initFailed = false;

function getDb(): any | null {
  if (db) return db;
  if (initFailed || !DatabaseSync) return null;
  try {
    mkdirSync(DB_DIR, { recursive: true });
    db = new DatabaseSync(DB_PATH);
    db.exec(`
      CREATE TABLE IF NOT EXISTS daily_snapshot (
        date TEXT PRIMARY KEY,
        ozon_revenue REAL, ozon_orders REAL, ozon_products INTEGER,
        wb_revenue REAL, wb_orders REAL, wb_products INTEGER,
        reviews_unanswered INTEGER, reviews_archive INTEGER,
        ads_total INTEGER, ads_active INTEGER,
        updated_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS alert_sent (
        key TEXT PRIMARY KEY,
        sent_at INTEGER
      );
    `);
    return db;
  } catch (e) {
    console.warn('[history] sqlite init failed, история выключена:', (e as Error).message);
    initFailed = true;
    return null;
  }
}

export function historyEnabled(): boolean {
  return getDb() != null;
}

/** Upsert снимка за дату. Частичные поля (null) НЕ затирают уже сохранённые —
 *  COALESCE сохраняет предыдущее значение, если новое пустое. */
export function recordDailySnapshot(date: string, r: Partial<Omit<DailyRow, 'date' | 'updatedAt'>>): void {
  const d = getDb();
  if (!d) return;
  try {
    d.prepare(`
      INSERT INTO daily_snapshot
        (date, ozon_revenue, ozon_orders, ozon_products, wb_revenue, wb_orders, wb_products,
         reviews_unanswered, reviews_archive, ads_total, ads_active, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(date) DO UPDATE SET
        ozon_revenue       = COALESCE(excluded.ozon_revenue,       daily_snapshot.ozon_revenue),
        ozon_orders        = COALESCE(excluded.ozon_orders,        daily_snapshot.ozon_orders),
        ozon_products      = COALESCE(excluded.ozon_products,      daily_snapshot.ozon_products),
        wb_revenue         = COALESCE(excluded.wb_revenue,         daily_snapshot.wb_revenue),
        wb_orders          = COALESCE(excluded.wb_orders,          daily_snapshot.wb_orders),
        wb_products        = COALESCE(excluded.wb_products,        daily_snapshot.wb_products),
        reviews_unanswered = COALESCE(excluded.reviews_unanswered, daily_snapshot.reviews_unanswered),
        reviews_archive    = COALESCE(excluded.reviews_archive,    daily_snapshot.reviews_archive),
        ads_total          = COALESCE(excluded.ads_total,          daily_snapshot.ads_total),
        ads_active         = COALESCE(excluded.ads_active,         daily_snapshot.ads_active),
        updated_at         = excluded.updated_at
    `).run(
      date,
      n(r.ozonRevenue), n(r.ozonOrders), n(r.ozonProducts),
      n(r.wbRevenue), n(r.wbOrders), n(r.wbProducts),
      n(r.reviewsUnanswered), n(r.reviewsArchive), n(r.adsTotal), n(r.adsActive),
      Date.now(),
    );
  } catch (e) {
    console.warn('[history] запись снимка не удалась:', (e as Error).message);
  }
}

function n(v: number | null | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function mapRow(row: any): DailyRow {
  return {
    date: row.date,
    ozonRevenue: row.ozon_revenue, ozonOrders: row.ozon_orders, ozonProducts: row.ozon_products,
    wbRevenue: row.wb_revenue, wbOrders: row.wb_orders, wbProducts: row.wb_products,
    reviewsUnanswered: row.reviews_unanswered, reviewsArchive: row.reviews_archive,
    adsTotal: row.ads_total, adsActive: row.ads_active,
    updatedAt: row.updated_at,
  };
}

/** Последний сохранённый снимок (любая дата). */
export function getLatestSnapshot(): DailyRow | null {
  const d = getDb();
  if (!d) return null;
  try {
    const row = d.prepare(`SELECT * FROM daily_snapshot ORDER BY date DESC LIMIT 1`).get();
    return row ? mapRow(row) : null;
  } catch { return null; }
}

/** Дедуп алертов: true — если этот ключ уже отправляли в пределах ttlMs (тогда
 *  слать НЕ нужно). Иначе помечает как отправленный и возвращает false. */
export function alertAlreadySent(key: string, ttlMs: number): boolean {
  const d = getDb();
  if (!d) return false; // без БД дедупа нет — но и спама почти нет (cron редкий)
  try {
    const row = d.prepare(`SELECT sent_at FROM alert_sent WHERE key = ?`).get(key) as { sent_at: number } | undefined;
    if (row && Date.now() - row.sent_at < ttlMs) return true;
    d.prepare(`INSERT INTO alert_sent (key, sent_at) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET sent_at = excluded.sent_at`)
      .run(key, Date.now());
    return false;
  } catch { return false; }
}

/** Ряд снимков за последние N дней (по возрастанию даты) — для трендов/графиков. */
export function getSnapshotSeries(days: number): DailyRow[] {
  const d = getDb();
  if (!d) return [];
  try {
    const rows = d.prepare(`SELECT * FROM daily_snapshot ORDER BY date DESC LIMIT ?`).all(Math.max(1, days)) as any[];
    return rows.map(mapRow).reverse();
  } catch { return []; }
}
