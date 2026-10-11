/**
 * «Рука на пульсе» (РНП) — метрики по дням и товарам WB и Ozon (11.10.2026).
 *
 * Замена платной «Руке на пульсе» из «Культуры Аналитики»: те же цифры берём
 * напрямую из API площадок по нашим ключам.
 *
 * Хранилище — rnp.sqlite, одна строка на (площадка, дата, товар, метрика). Зачем
 * своя база: WB отдаёт заказы только за 30 дней, отчёты рекламы Ozon строятся
 * минутами — без накопления история дальше месяца пропадала бы, а экран ждал бы.
 *
 * Сбор (collectRnp) идёт из цепочки warm-extras раз в 2 часа и почти ничего не
 * спрашивает у площадок сверх обычного прогрева:
 *   WB   заказы и продажи      — кэш statistics supplier/orders|sales (30 дн)
 *        реклама по дням       — кэш adv/v3/fullstats (days[].apps[].nms[])
 *        остатки               — getWbStock() (снимок на сегодня)
 *   Ozon заказы и воронка      — v1/analytics/data, dimension sku×day (НОВЫЙ запрос)
 *        реклама по дням       — отчёт Performance за одни сутки (getOzonSkuAdsRange(d, d))
 *        остатки               — getOzonStock() (снимок на сегодня)
 *
 * Пересчёт дня — «удалить метрики источника за день и записать заново»: товар,
 * у которого в пересчитанный день заказов не стало (отмена задним числом),
 * получает честный ноль, а не застрявшее старое значение.
 *
 * Производные метрики (средний чек, ДРР, CTR…) здесь НЕ хранятся — их считает
 * экран из базовых (shared/rnp.ts), иначе они ломаются при свёртке.
 */
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { cacheGet, cacheSet, isFresh, cacheGetNewestByPrefix, makeUpstreamCachePrefix } from './cache';
import { mskDate } from './mskDate';
import { fetchWithRetry } from './fetchRetry';
import type { RnpMp, RnpItem, RnpResponse } from '../../shared/rnp';

let DatabaseSync: any = null;
try {
  DatabaseSync = require('node:sqlite').DatabaseSync;
} catch {
  DatabaseSync = null;
}

const DB_DIR = process.env.CACHE_DIR || join(process.cwd(), '.av-cache');
const DB_PATH = join(DB_DIR, 'rnp.sqlite');
const DAY_MS = 86_400_000;
const MSK_OFFSET_MS = 3 * 3_600_000;

let db: any = null;
let initFailed = false;

function getDb(): any | null {
  if (db) return db;
  if (initFailed || !DatabaseSync) return null;
  try {
    mkdirSync(DB_DIR, { recursive: true });
    db = new DatabaseSync(DB_PATH);
    db.exec(`
      CREATE TABLE IF NOT EXISTS rnp_fact (
        mp TEXT NOT NULL, date TEXT NOT NULL, sku TEXT NOT NULL, metric TEXT NOT NULL, value REAL,
        PRIMARY KEY (mp, date, sku, metric)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS rnp_fact_date ON rnp_fact (mp, date);
      CREATE TABLE IF NOT EXISTS rnp_item (
        mp TEXT NOT NULL, sku TEXT NOT NULL,
        article TEXT, name TEXT, category TEXT, brand TEXT, photo TEXT, ext_id TEXT, updated_at INTEGER,
        PRIMARY KEY (mp, sku)
      );
      CREATE TABLE IF NOT EXISTS rnp_meta (key TEXT PRIMARY KEY, value TEXT);
    `);
    return db;
  } catch (e) {
    console.warn('[rnp] sqlite init failed:', (e as Error).message);
    initFailed = true;
    return null;
  }
}

function metaGet(key: string): string | null {
  const d = getDb();
  if (!d) return null;
  try { return (d.prepare('SELECT value FROM rnp_meta WHERE key = ?').get(key) as any)?.value ?? null; } catch { return null; }
}
function metaSet(key: string, value: string): void {
  const d = getDb();
  if (!d) return;
  try { d.prepare('INSERT INTO rnp_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value); } catch { /* не критично */ }
}

const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const up = (v: unknown) => String(v ?? '').trim().toUpperCase();
/** МСК-дата момента времени. */
const mskDateOf = (ms: number) => new Date(ms + MSK_OFFSET_MS).toISOString().slice(0, 10);
const addDays = (date: string, n: number) => new Date(Date.parse(date + 'T00:00:00Z') + n * DAY_MS).toISOString().slice(0, 10);

/** day → sku → metric → value */
type DayFacts = Map<string, Map<string, Map<string, number>>>;

function bump(f: DayFacts, date: string, sku: string, metric: string, v: number): void {
  let bySku = f.get(date);
  if (!bySku) { bySku = new Map(); f.set(date, bySku); }
  let m = bySku.get(sku);
  if (!m) { m = new Map(); bySku.set(sku, m); }
  m.set(metric, (m.get(metric) ?? 0) + v);
}

/**
 * Записать пересчитанные дни: для каждого дня из `days` стираем `metrics`
 * площадки и пишем то, что пришло. Всё в одной транзакции.
 */
function writeDays(mp: RnpMp, days: Iterable<string>, metrics: string[], facts: DayFacts): number {
  const d = getDb();
  if (!d) return 0;
  const del = d.prepare(`DELETE FROM rnp_fact WHERE mp = ? AND date = ? AND metric IN (${metrics.map(() => '?').join(',')})`);
  const ins = d.prepare('INSERT OR REPLACE INTO rnp_fact (mp, date, sku, metric, value) VALUES (?, ?, ?, ?, ?)');
  let rows = 0;
  d.exec('BEGIN');
  try {
    for (const date of days) {
      del.run(mp, date, ...metrics);
      for (const [sku, m] of facts.get(date) ?? []) {
        for (const [metric, v] of m) {
          if (!metrics.includes(metric)) continue;
          ins.run(mp, date, sku, metric, Math.round(v * 100) / 100);
          rows++;
        }
      }
    }
    d.exec('COMMIT');
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
  return rows;
}

function upsertItems(mp: RnpMp, items: RnpItem[]): void {
  const d = getDb();
  if (!d || !items.length) return;
  // Пустое поле не затирает известное: справочники приходят из разных источников.
  const st = d.prepare(`
    INSERT INTO rnp_item (mp, sku, article, name, category, brand, photo, ext_id, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(mp, sku) DO UPDATE SET
      article  = COALESCE(NULLIF(excluded.article, ''),  rnp_item.article),
      name     = COALESCE(NULLIF(excluded.name, ''),     rnp_item.name),
      category = COALESCE(NULLIF(excluded.category, ''), rnp_item.category),
      brand    = COALESCE(NULLIF(excluded.brand, ''),    rnp_item.brand),
      photo    = COALESCE(NULLIF(excluded.photo, ''),    rnp_item.photo),
      ext_id   = COALESCE(NULLIF(excluded.ext_id, ''),   rnp_item.ext_id),
      updated_at = excluded.updated_at
  `);
  d.exec('BEGIN');
  try {
    for (const it of items) {
      st.run(mp, it.sku, it.article ?? '', it.name ?? '', it.category ?? '', it.brand ?? '', it.photo ?? '', it.extId ?? '', Date.now());
    }
    d.exec('COMMIT');
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
}

function markCollected(source: string): void {
  metaSet(`collected:${source}`, String(Date.now()));
}

// ─── WB ────────────────────────────────────────────────────────────────────

function readCachedArray(path: string): any[] {
  const entry = cacheGetNewestByPrefix<{ text?: string; status?: number }>(
    makeUpstreamCachePrefix('wb:statistics', 'GET', path, '?dateFrom=2026-01-01', undefined),
  );
  if (!entry?.data?.text || (entry.data.status ?? 200) >= 400) return [];
  try {
    const arr = JSON.parse(entry.data.text);
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

/** Заказы и продажи WB из прогретого 30-дневного окна. */
function collectWbSales(items: Map<string, RnpItem>): string {
  const orders = readCachedArray('api/v1/supplier/orders');
  const sales = readCachedArray('api/v1/supplier/sales');
  // WB фильтрует окно по lastChangeDate, поэтому дни раньше начала окна могут
  // быть неполными. Пересчитываем только последние 29 суток — они точно целые.
  const minDay = mskDate(29);
  const facts: DayFacts = new Map();
  const touched = new Set<string>();
  for (let i = 0; i <= 29; i++) touched.add(mskDate(i));

  for (const o of orders) {
    const nm = String(o?.nmId ?? '');
    const date = String(o?.date ?? '').slice(0, 10);
    if (!nm || date < minDay) continue;
    if (!items.has(nm)) items.set(nm, { sku: nm, article: up(o.supplierArticle), name: '', category: String(o.subject ?? ''), brand: String(o.brand ?? ''), photo: '' });
    bump(facts, date, nm, 'ordered_cnt', 1);
    bump(facts, date, nm, 'ordered_amount', num(o.priceWithDisc));
    if (o.isCancel) bump(facts, date, nm, 'cancel_cnt', 1);
  }
  for (const s of sales) {
    const nm = String(s?.nmId ?? '');
    const date = String(s?.date ?? '').slice(0, 10);
    if (!nm || date < minDay) continue;
    const isReturn = String(s.saleID ?? '').startsWith('R');
    if (isReturn) bump(facts, date, nm, 'return_cnt', 1);
    else {
      bump(facts, date, nm, 'bought_cnt', 1);
      bump(facts, date, nm, 'bought_amount', num(s.priceWithDisc));
    }
  }
  if (!orders.length) return 'заказы WB: кэш пуст, пропуск';
  const salesMetrics = ['ordered_cnt', 'ordered_amount', 'cancel_cnt'];
  if (sales.length) salesMetrics.push('bought_cnt', 'bought_amount', 'return_cnt');
  const rows = writeDays('wb', touched, salesMetrics, facts);
  markCollected('wb:sales');
  return `заказы WB: ${orders.length} заказов, ${sales.length} продаж → ${rows} значений`;
}

type NmRow = { nmId?: number; views?: number; clicks?: number; sum?: number; orders?: number; sum_price?: number };
type WbAdDay = { date?: string; nm?: NmRow[]; nms?: NmRow[]; apps?: Array<{ nm?: NmRow[]; nms?: NmRow[] }> };

/** Реклама WB по дням и товарам из прогретой статистики кампаний. */
function collectWbAds(): string {
  const near = cacheGetNewestByPrefix<{ status: number; text: string }>(
    makeUpstreamCachePrefix('wb:promotion', 'GET', 'adv/v3/fullstats', '', undefined),
  );
  if (!near || near.data.status >= 400) return 'реклама WB: кэша нет';
  let campaigns: Array<{ days?: WbAdDay[] }> = [];
  try { campaigns = JSON.parse(near.data.text); } catch { return 'реклама WB: битый кэш'; }
  if (!Array.isArray(campaigns)) return 'реклама WB: неожиданный формат';

  const facts: DayFacts = new Map();
  const days = new Set<string>();
  for (const c of campaigns) {
    for (const d of c.days ?? []) {
      const date = String(d.date ?? '').slice(0, 10);
      if (!date) continue;
      // Разбивка лежит в `nms` (иногда `nm`), прямо в дне или внутри apps[] — см. ads/wbSource.ts.
      const nms: NmRow[] = [...(d.nms ?? d.nm ?? []), ...(d.apps ?? []).flatMap(a => a?.nms ?? a?.nm ?? [])];
      if (!nms.length) continue;
      days.add(date);
      for (const r of nms) {
        if (!r?.nmId) continue;
        const nm = String(r.nmId);
        bump(facts, date, nm, 'adv_views', num(r.views));
        bump(facts, date, nm, 'adv_clicks', num(r.clicks));
        bump(facts, date, nm, 'adv_expenses', num(r.sum));
        bump(facts, date, nm, 'adv_orders', num(r.orders));
        bump(facts, date, nm, 'adv_revenue', num(r.sum_price));
      }
    }
  }
  if (!days.size) return 'реклама WB: в статистике нет разбивки по товарам';
  const rows = writeDays('wb', days, ['adv_views', 'adv_clicks', 'adv_expenses', 'adv_orders', 'adv_revenue'], facts);
  markCollected('wb:ads');
  return `реклама WB: ${days.size} дн → ${rows} значений`;
}

async function collectWbStock(): Promise<string> {
  const { getWbStock } = await import('./wbStock');
  const st = await getWbStock();
  const today = mskDateOf(st.fetchedAt);
  const facts: DayFacts = new Map();
  for (const [nm, v] of Object.entries(st.byNm ?? {})) {
    bump(facts, today, nm, 'stocks', num(v));
    bump(facts, today, nm, 'stocks_fbo', num(st.fboByNm?.[nm]));
    bump(facts, today, nm, 'stocks_fbs', num(st.fbsByNm?.[nm]));
  }
  const rows = writeDays('wb', [today], ['stocks', 'stocks_fbo', 'stocks_fbs'], facts);
  markCollected('wb:stock');
  return `остатки WB: ${rows} значений на ${today}`;
}

async function wbCatalog(items: Map<string, RnpItem>): Promise<void> {
  try {
    const entry = cacheGetNewestByPrefix<{ text?: string }>(makeUpstreamCachePrefix('wb:content', 'POST', 'content/v2/get/cards/list'));
    const cards: any[] = entry?.data?.text ? JSON.parse(entry.data.text)?.cards ?? [] : [];
    for (const c of cards) {
      const nm = String(c?.nmID ?? '');
      if (!nm) continue;
      const p = c?.photos?.[0] ?? {};
      const prev = items.get(nm);
      items.set(nm, {
        sku: nm,
        article: up(c?.vendorCode) || prev?.article || '',
        name: String(c?.title ?? '') || prev?.name || '',
        category: String(c?.subjectName ?? '') || prev?.category || '',
        brand: String(c?.brand ?? '') || prev?.brand || '',
        photo: String(p?.tm ?? p?.c246x328 ?? p?.big ?? '') || prev?.photo || '',
      });
    }
  } catch (e) {
    console.warn('[rnp] карточки WB не прочитаны:', (e as Error).message);
  }
}

// ─── Ozon ──────────────────────────────────────────────────────────────────

const OZ_BASE = 'https://api-seller.ozon.ru';
function ozHeaders(): Record<string, string> {
  return { 'Client-Id': process.env.OZON_CLIENT_ID ?? '', 'Api-Key': process.env.OZON_API_KEY ?? '', 'Content-Type': 'application/json' };
}
async function ozPost(path: string, body: unknown): Promise<any> {
  const r = await fetchWithRetry(`${OZ_BASE}/${path}`, { method: 'POST', headers: ozHeaders(), body: JSON.stringify(body) }, { maxRetries: 2, timeoutMs: 60_000 });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    const err = new Error(`${path} → ${r.status} ${t.slice(0, 200)}`) as Error & { status?: number };
    err.status = r.status;
    throw err;
  }
  return r.json();
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// Метрики аналитики Ozon → наши ключи. Часть метрик Ozon открывает не всем
// (зависит от подписки) — при отказе откатываемся на базовый набор.
const OZ_FULL: Array<[string, string]> = [
  ['ordered_units', 'ordered_cnt'], ['revenue', 'ordered_amount'],
  ['hits_view', 'hits_view'], ['hits_view_search', 'hits_view_search'],
  ['session_view', 'session_view'], ['session_view_pdp', 'session_view_pdp'],
  ['hits_tocart', 'hits_tocart'], ['returns', 'return_cnt'], ['cancellations', 'cancel_cnt'],
  ['delivered_units', 'delivered_cnt'],
];
const OZ_BASIC: Array<[string, string]> = [['ordered_units', 'ordered_cnt'], ['revenue', 'ordered_amount']];
/** Пауза между страницами: у v1/analytics/data жёсткий лимит частоты на кабинет. */
const OZ_ANALYTICS_PAUSE_MS = Number(process.env.RNP_OZ_PAUSE_MS) || 61_000;

async function fetchOzAnalytics(from: string, to: string, set: Array<[string, string]>): Promise<any[]> {
  const out: any[] = [];
  for (let offset = 0, page = 0; page < 20; page++, offset += 1000) {
    if (page) await sleep(OZ_ANALYTICS_PAUSE_MS);
    const j = await ozPost('v1/analytics/data', {
      date_from: from, date_to: to, metrics: set.map(m => m[0]), dimension: ['sku', 'day'], limit: 1000, offset,
    });
    const rows: any[] = j?.result?.data ?? [];
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}

/** Заказы и воронка Ozon по дням и SKU. Первый раз — 30 дней, дальше — последние 4. */
async function collectOzonAnalytics(items: Map<string, RnpItem>): Promise<string> {
  const backfilled = metaGet('ozon:analytics:backfill') === '1';
  const from = mskDate(backfilled ? 3 : 29);
  const to = mskDate(0);
  let set = metaGet('ozon:analytics:basic') === '1' ? OZ_BASIC : OZ_FULL;
  let rows: any[];
  try {
    rows = await fetchOzAnalytics(from, to, set);
  } catch (e) {
    const status = (e as { status?: number }).status;
    if (set === OZ_FULL && (status === 400 || status === 403)) {
      console.warn('[rnp] Ozon не отдал расширенные метрики, берём заказы и выручку:', (e as Error).message);
      metaSet('ozon:analytics:basic', '1');
      set = OZ_BASIC;
      await sleep(OZ_ANALYTICS_PAUSE_MS);
      rows = await fetchOzAnalytics(from, to, set);
    } else throw e;
  }

  const { getSkuMap } = await import('./ozonShowcase');
  const skuToOffer = await getSkuMap();
  const facts: DayFacts = new Map();
  let unmapped = 0;
  for (const r of rows) {
    const sku = String(r?.dimensions?.[0]?.id ?? '');
    const date = String(r?.dimensions?.[1]?.id ?? '').slice(0, 10);
    if (!sku || !date) continue;
    const offer = skuToOffer[sku];
    if (!offer) { unmapped++; continue; }
    if (!items.has(offer)) items.set(offer, { sku: offer, article: offer, name: String(r.dimensions[0].name ?? ''), category: '', brand: '', photo: '', extId: sku });
    const ms: number[] = r.metrics ?? [];
    set.forEach(([, key], i) => bump(facts, date, offer, key, num(ms[i])));
  }
  const days: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
  const written = writeDays('ozon', days, set.map(m => m[1]), facts);
  if (!backfilled) metaSet('ozon:analytics:backfill', '1');
  markCollected('ozon:analytics');
  return `аналитика Ozon ${from}…${to}: строк ${rows.length}${unmapped ? `, без артикула ${unmapped}` : ''} → ${written} значений${set === OZ_BASIC ? ' (только заказы и выручка)' : ''}`;
}

/**
 * Реклама Ozon по дням. Отчёт Performance отдаёт SKU за период без разбивки по
 * дням, поэтому заказываем по отчёту на сутки: сегодня и вчера каждый проход,
 * плюс один ещё не собранный день из последних двух недель (добираем историю
 * постепенно — у Ozon один слот отчётов на кабинет).
 */
async function collectOzonAds(): Promise<string> {
  const { getOzonSkuAdsRange } = await import('./ozonSkuAds');
  const backs = [0, 1];
  for (let b = 2; b <= 13; b++) {
    if (metaGet(`ozon:ads-day:${mskDate(b)}`) !== '1') { backs.push(b); break; }
  }
  const parts: string[] = [];
  for (const b of backs) {
    const r = await getOzonSkuAdsRange(b, b).catch(() => null);
    if (!r) { parts.push(`${b}д: сбой`); continue; }
    // Дата — от момента сборки отчёта, а не от «сейчас»: отчёт «вчера» из кэша,
    // собранный до полуночи, описывает другие сутки.
    const date = mskDateOf(r.fetchedAt - b * DAY_MS);
    if (date !== mskDate(b) && b === 0) { parts.push(`${b}д: отчёт вчерашний, ждём новый`); continue; }
    const facts: DayFacts = new Map();
    for (const [offer, row] of Object.entries(r.items) as Array<[string, { spend: number; views: number; clicks: number; orders: number; revenue: number }]>) {
      bump(facts, date, offer, 'adv_expenses', row.spend);
      bump(facts, date, offer, 'adv_views', row.views);
      bump(facts, date, offer, 'adv_clicks', row.clicks);
      bump(facts, date, offer, 'adv_orders', row.orders);
      bump(facts, date, offer, 'adv_revenue', row.revenue);
    }
    writeDays('ozon', [date], ['adv_expenses', 'adv_views', 'adv_clicks', 'adv_orders', 'adv_revenue'], facts);
    // Закрытый день (не сегодня) считаем собранным — дальше его не перезаказываем.
    if (b >= 2 || (b === 1 && date === mskDate(1))) metaSet(`ozon:ads-day:${date}`, '1');
    parts.push(`${date}: товаров ${r.count}`);
  }
  markCollected('ozon:ads');
  return `реклама Ozon: ${parts.join(', ')}`;
}

async function collectOzonStock(): Promise<string> {
  const { getOzonStock } = await import('./ozonStock');
  const st = await getOzonStock();
  const today = mskDateOf(st.fetchedAt);
  const facts: DayFacts = new Map();
  for (const [offer, v] of Object.entries(st.byOffer ?? {})) {
    bump(facts, today, offer, 'stocks', num(v));
    bump(facts, today, offer, 'stocks_fbo', num(st.fboByOffer?.[offer]));
    bump(facts, today, offer, 'stocks_fbs', num(st.fbsByOffer?.[offer]));
  }
  // Неполный обход остатков не пишем: «0» на непройденных страницах — не правда.
  if (!st.complete) return 'остатки Ozon: обход неполный, пропуск';
  const rows = writeDays('ozon', [today], ['stocks', 'stocks_fbo', 'stocks_fbs'], facts);
  markCollected('ozon:stock');
  return `остатки Ozon: ${rows} значений на ${today}`;
}

const OZ_CATALOG_KEY = 'rnp:ozon-catalog:v1';
const OZ_TREE_KEY = 'rnp:ozon-type-names:v1';

/** Тип товара Ozon (то, что «Культура Аналитики» показывает категорией) по type_id. */
async function ozonTypeNames(): Promise<Record<string, string>> {
  const cached = await cacheGet<Record<string, string>>(OZ_TREE_KEY);
  const stale = cached?.data ?? {};
  if (isFresh(cached)) return cached.data;
  try {
    const j = await ozPost('v1/description-category/tree', { language: 'DEFAULT' });
    const map: Record<string, string> = {};
    const walk = (nodes: any[]) => {
      for (const n of nodes ?? []) {
        if (n?.type_id && n?.type_name) map[String(n.type_id)] = String(n.type_name);
        if (n?.children?.length) walk(n.children);
      }
    };
    walk(j?.result ?? []);
    if (Object.keys(map).length) await cacheSet(OZ_TREE_KEY, map, 7 * DAY_MS);
    return map;
  } catch (e) {
    console.warn('[rnp] дерево категорий Ozon не получено:', (e as Error).message);
    return stale;
  }
}

async function ozonCatalog(items: Map<string, RnpItem>): Promise<void> {
  type Row = { name: string; photo: string; typeId: string; sku: string };
  let map: Record<string, Row> | null = null;
  const cached = await cacheGet<Record<string, Row>>(OZ_CATALOG_KEY);
  const stale = cached?.data ?? null;   // до сужения типа isFresh — для отката при сбое
  if (isFresh(cached)) map = cached.data;
  else {
    try {
      const pids: number[] = [];
      let lastId = '';
      for (let page = 0; page < 10; page++) {
        const pl = await ozPost('v3/product/list', { filter: { visibility: 'ALL' }, last_id: lastId, limit: 1000 });
        const list: any[] = pl?.result?.items ?? [];
        for (const it of list) if (it?.product_id) pids.push(it.product_id);
        lastId = pl?.result?.last_id ?? '';
        if (!lastId || list.length < 1000) break;
      }
      map = {};
      for (let i = 0; i < pids.length; i += 1000) {
        const info = await ozPost('v3/product/info/list', { product_id: pids.slice(i, i + 1000) });
        for (const it of info?.items ?? []) {
          const offer = up(it?.offer_id);
          if (!offer) continue;
          map[offer] = {
            name: String(it?.name ?? ''),
            photo: String(it?.primary_image?.[0] ?? it?.primary_image ?? it?.images?.[0] ?? ''),
            typeId: String(it?.type_id ?? ''),
            sku: String(it?.sku ?? it?.sources?.[0]?.sku ?? ''),
          };
        }
      }
      if (Object.keys(map).length) await cacheSet(OZ_CATALOG_KEY, map, 12 * 3_600_000);
    } catch (e) {
      console.warn('[rnp] каталог Ozon не получен:', (e as Error).message);
      map = stale;
    }
  }
  if (!map) return;
  const types = await ozonTypeNames();
  for (const [offer, r] of Object.entries(map)) {
    const prev = items.get(offer);
    items.set(offer, {
      sku: offer, article: offer,
      name: r.name || prev?.name || '',
      category: types[r.typeId] || prev?.category || '',
      brand: '',
      photo: r.photo || prev?.photo || '',
      extId: r.sku || prev?.extId,
    });
  }
}

/** Категории из листа «Маржа» — там, где площадка категорию не дала. */
async function fillSheetCategories(items: Map<string, RnpItem>): Promise<void> {
  try {
    const { skuToCategory } = await import('./ads/categoryDrr');
    const cats = await skuToCategory();
    for (const it of items.values()) {
      if (!it.category) it.category = cats.get(up(it.article)) ?? cats.get(up(it.sku)) ?? '';
    }
  } catch { /* лист недоступен — останутся пустые категории */ }
}

// ─── Сбор ──────────────────────────────────────────────────────────────────

let collecting: Promise<string[]> | null = null;

/**
 * Один проход сбора по обеим площадкам. Каждый источник независим: сбой одного
 * не мешает остальным. Повторный вызов во время прохода ждёт текущий.
 */
export function collectRnp(only?: RnpMp): Promise<string[]> {
  if (collecting) return collecting;
  collecting = (async () => {
    const log: string[] = [];
    if (!getDb()) return ['РНП: node:sqlite недоступен, сбор выключен'];
    const step = async (name: string, fn: () => string | Promise<string>) => {
      try { log.push(await fn()); } catch (e) { log.push(`${name}: ${(e as Error).message.slice(0, 200)}`); }
    };
    if (!only || only === 'wb') {
      const items = new Map<string, RnpItem>();
      await step('заказы WB', () => collectWbSales(items));
      await step('реклама WB', () => collectWbAds());
      await step('остатки WB', () => collectWbStock());
      await step('каталог WB', async () => { await wbCatalog(items); await fillSheetCategories(items); upsertItems('wb', [...items.values()]); return `каталог WB: ${items.size} товаров`; });
    }
    if (!only || only === 'ozon') {
      const items = new Map<string, RnpItem>();
      await step('аналитика Ozon', () => collectOzonAnalytics(items));
      await step('остатки Ozon', () => collectOzonStock());
      await step('каталог Ozon', async () => { await ozonCatalog(items); await fillSheetCategories(items); upsertItems('ozon', [...items.values()]); return `каталог Ozon: ${items.size} товаров`; });
      await step('реклама Ozon', () => collectOzonAds());
    }
    console.warn('[rnp]', log.join(' · '));
    return log;
  })().finally(() => { collecting = null; });
  return collecting;
}

export function rnpCollecting(): boolean {
  return collecting != null;
}

// ─── Чтение ────────────────────────────────────────────────────────────────

const MAX_DAYS = 120;

export function getRnp(mp: RnpMp, fromIn?: string, toIn?: string): RnpResponse {
  const isDate = (s?: string) => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);
  let to = isDate(toIn) ? toIn! : mskDate(0);
  let from = isDate(fromIn) ? fromIn! : addDays(to, -13);
  if (from > to) [from, to] = [to, from];
  if ((Date.parse(to) - Date.parse(from)) / DAY_MS >= MAX_DAYS) from = addDays(to, -(MAX_DAYS - 1));

  const dates: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) dates.push(d);
  const idx = new Map(dates.map((d, i) => [d, i]));
  const notes: string[] = [];
  const res: RnpResponse = { ok: true, mp, from, to, dates, items: [], facts: {}, present: [], collectedAt: {}, notes };

  const d = getDb();
  if (!d) { notes.push('База РНП недоступна на сервере (нужен Node 22.5+).'); return res; }

  // Для «среднее за 7 дней» нужны 6 дней до начала периода.
  const preFrom = addDays(from, -6);
  const rows = d.prepare('SELECT date, sku, metric, value FROM rnp_fact WHERE mp = ? AND date >= ? AND date <= ?').all(mp, preFrom, to) as Array<{ date: string; sku: string; metric: string; value: number }>;

  const facts = res.facts;
  const present = new Set<string>();
  const orders = new Map<string, Map<string, number>>(); // sku → date → заказы (для ma7, включая преддни)
  for (const r of rows) {
    if (r.metric === 'ordered_cnt') {
      let m = orders.get(r.sku);
      if (!m) { m = new Map(); orders.set(r.sku, m); }
      m.set(r.date, r.value);
    }
    const i = idx.get(r.date);
    if (i === undefined) continue;
    const bySku = (facts[r.sku] ??= {});
    const arr = (bySku[r.metric] ??= new Array(dates.length).fill(null));
    arr[i] = r.value;
    present.add(r.metric);
  }

  // Средние заказы за 7 дней: считаем, только если по товару есть данные о
  // заказах за все 7 дней окна (иначе среднее занижено пропусками).
  const firstRow = d.prepare(`SELECT MIN(date) AS m FROM rnp_fact WHERE mp = ? AND metric = 'ordered_cnt'`).get(mp) as { m?: string } | undefined;
  const salesStart = firstRow?.m ?? null;
  for (const [sku, byDate] of orders) {
    const arr = new Array(dates.length).fill(null) as Array<number | null>;
    let any = false;
    dates.forEach((date, i) => {
      const start = addDays(date, -6);
      if (salesStart && start < salesStart) return;
      let s = 0;
      for (let k = 0; k < 7; k++) s += byDate.get(addDays(date, -k)) ?? 0;
      arr[i] = Math.round((s / 7) * 100) / 100;
      any = true;
    });
    if (any) { (facts[sku] ??= {}).ma7_ordered = arr; present.add('ma7_ordered'); }
  }

  const items = d.prepare('SELECT * FROM rnp_item WHERE mp = ?').all(mp) as any[];
  const known = new Set<string>();
  for (const it of items) {
    known.add(it.sku);
    if (!facts[it.sku]) continue;   // товары без единой цифры за период не показываем
    res.items.push({ sku: it.sku, article: it.article || it.sku, name: it.name || '', category: it.category || '', brand: it.brand || '', photo: it.photo || '', extId: it.ext_id || undefined });
  }
  for (const sku of Object.keys(facts)) {
    if (!known.has(sku)) res.items.push({ sku, article: sku, name: '', category: '', brand: '', photo: '' });
  }

  res.present = [...present];
  for (const src of ['sales', 'ads', 'stock', 'analytics']) {
    const v = metaGet(`collected:${mp}:${src}`);
    if (v) res.collectedAt[src] = Number(v);
  }
  if (!rows.length) notes.push('За выбранный период данных ещё нет: сбор идёт раз в 2 часа, первый проход после запуска сервера — в течение 10–30 минут.');
  if (present.has('stocks') && salesStart && from < salesStart) notes.push(`История собирается с ${salesStart.split('-').reverse().join('.')}: раньше этой даты данных нет.`);
  return res;
}
