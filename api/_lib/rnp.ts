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
 *        средняя позиция       — search-report/table/details за сутки (подписка «Джем»)
 *        СПП                   — поле spp тех же заказов
 *   Ozon заказы и воронка      — v1/analytics/data, dimension sku×day (НОВЫЙ запрос)
 *        соинвест              — отправления FBS (список) и FBO (деталь): price vs customer_price
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
import { cacheGet, cacheSet, isFresh, cacheGetNewestByPrefix, makeUpstreamCachePrefix, makeUpstreamCacheKey } from './cache';
import { mskDate } from './mskDate';
import { fetchWithRetry } from './fetchRetry';
import { getUiState } from './uiState';
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

/**
 * Фото и название товара из справочника РНП — для чатов с покупателями.
 * WB: ключ — nmID, Ozon: ключ — артикул продавца, ext_id — SKU площадки.
 */
export function rnpProductLookup(mp: RnpMp, q: { sku?: string | null; offerId?: string | null }): { photo: string; name: string; article: string; extId: string } | null {
  const d = getDb();
  if (!d || (!q.sku && !q.offerId)) return null;
  try {
    const r = d.prepare(`SELECT sku, article, name, photo, ext_id FROM rnp_item WHERE mp = ?
      AND (sku = ? OR (? <> '' AND ext_id = ?) OR (? <> '' AND (UPPER(sku) = ? OR UPPER(article) = ?)))
      ORDER BY (photo <> '') DESC LIMIT 1`)
      .get(mp, String(q.sku ?? ''), String(q.sku ?? ''), String(q.sku ?? ''), up(q.offerId), up(q.offerId), up(q.offerId)) as any;
    if (!r) return null;
    return { photo: String(r.photo || ''), name: String(r.name || ''), article: String(r.article || ''), extId: String(mp === 'wb' ? r.sku : r.ext_id || '') };
  } catch { return null; }
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
    // СПП: доля скидки WB от цены продавца. Храним рубли скидки и базу, процент
    // считает экран — так он верно сворачивается по дням и товарам.
    if (num(o.priceWithDisc) > 0) {
      bump(facts, date, nm, 'spp_base', num(o.priceWithDisc));
      bump(facts, date, nm, 'spp_disc', num(o.priceWithDisc) * num(o.spp) / 100);
    }
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
  const salesMetrics = ['ordered_cnt', 'ordered_amount', 'cancel_cnt', 'spp_base', 'spp_disc'];
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

/**
 * Средняя позиция WB в поиске по дням — отчёт «Поисковые запросы: ваши товары»
 * (seller-analytics search-report/table/details, нужна подписка «Джем», без неё 402).
 * includeSearchTexts обязательно true: при false WB считает только подменные
 * артикулы, и у всех товаров выходят нули.
 *
 * Отчёт за одни сутки = позиция за день. Каждый проход — сегодня и вчера (WB
 * пересчитывает отчёт раз в 2 часа), плюс до WB_POS_BACKFILL ещё не собранных
 * дней из последних 30. Лимит метода — 3 запроса в минуту, отсюда пауза.
 * Вес для свёртки — переходы в карточку из поиска + 1 (показов WB не отдаёт,
 * а +1 не даёт пропасть товарам без переходов).
 */
const WB_POS_PAUSE_MS = 21_000;
const WB_POS_BACKFILL = 10;

async function wbPosDay(date: string): Promise<Array<{ nm: string; pos: number; opens: number }>> {
  const token = (process.env.WB_TOKEN_ANALYTICS || process.env.WB_TOKEN || '').trim();
  const out: Array<{ nm: string; pos: number; opens: number }> = [];
  for (let offset = 0, page = 0; page < 10; page++, offset += 1000) {
    if (page) await sleep(WB_POS_PAUSE_MS);
    const r = await fetchWithRetry('https://seller-analytics-api.wildberries.ru/api/v2/search-report/table/details', {
      method: 'POST',
      headers: { Authorization: token, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        currentPeriod: { start: date, end: date }, nmIds: [], subjectIds: [], brandNames: [], tagIds: [],
        positionCluster: 'all', orderBy: { field: 'openCard', mode: 'desc' },
        includeSubstitutedSKUs: true, includeSearchTexts: true, limit: 1000, offset,
      }),
    }, { maxRetries: 3, backoff429Ms: 21_000, timeoutMs: 60_000 });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      const err = new Error(`search-report ${date} → ${r.status}${r.status === 402 ? ' (нет подписки «Джем»)' : ''} ${t.slice(0, 150)}`) as Error & { status?: number };
      err.status = r.status;
      throw err;
    }
    const products: any[] = (await r.json())?.data?.products ?? [];
    for (const p of products) {
      const nm = String(p?.nmId ?? '');
      if (nm) out.push({ nm, pos: num(p?.avgPosition?.current), opens: num(p?.openCard?.current) });
    }
    if (products.length < 1000) break;
  }
  return out;
}

async function collectWbPositions(): Promise<string> {
  const backs = [0, 1];
  for (let b = 2; b <= 29 && backs.length < 2 + WB_POS_BACKFILL; b++) {
    if (metaGet(`wb:pos-day:${mskDate(b)}`) !== '1') backs.push(b);
  }
  const parts: string[] = [];
  for (const [i, b] of backs.entries()) {
    if (i) await sleep(WB_POS_PAUSE_MS);
    const date = mskDate(b);
    let rows: Array<{ nm: string; pos: number; opens: number }>;
    try {
      rows = await wbPosDay(date);
    } catch (e) {
      const status = (e as { status?: number }).status;
      // Без подписки дальше спрашивать бессмысленно; слишком старый день — помечаем, чтобы не крутить.
      if (status === 402) return `позиции WB: ${(e as Error).message}`;
      if (status === 400 && b >= 2) metaSet(`wb:pos-day:${date}`, '1');
      parts.push(`${date}: сбой ${status ?? ''}`);
      continue;
    }
    const facts: DayFacts = new Map();
    let n = 0;
    for (const r of rows) {
      if (r.pos <= 0) continue;
      const w = r.opens + 1;
      bump(facts, date, r.nm, 'pos_wsum', r.pos * w);
      bump(facts, date, r.nm, 'pos_weight', w);
      n++;
    }
    writeDays('wb', [date], ['pos_wsum', 'pos_weight'], facts);
    if (b >= 2) metaSet(`wb:pos-day:${date}`, '1');
    parts.push(`${date}: ${n}`);
  }
  markCollected('wb:positions');
  return `позиции WB: ${parts.join(', ')}`;
}

/**
 * Воронка WB по дням (14.10.2026, «Реклама 2.0», этап 1): переходы в карточку
 * и добавления в корзину — sales-funnel/products/history. Метод отдаёт не
 * дальше последней недели, по 20 товаров за запрос, 3 запроса в минуту (интервал
 * держит шлюз). Поэтому каждый проход берёт 7 последних дней, а история
 * копится в базе. Товары — те, у кого за 14 дней были заказы или остаток.
 *
 * Пишем по товарам, а не «стереть день целиком»: если часть запросов упала,
 * воронка остальных товаров за эти дни не пропадёт.
 */
const WB_FUNNEL_METRICS = ['session_view_pdp', 'hits_tocart'];
const WB_FUNNEL_MAX_NMS = 400;

export function parseWbFunnelHistory(json: unknown): Array<{ nm: string; date: string; open: number; cart: number }> {
  const arr: any[] = Array.isArray(json) ? json : Array.isArray((json as any)?.data) ? (json as any).data : [];
  const out: Array<{ nm: string; date: string; open: number; cart: number }> = [];
  for (const p of arr) {
    const nm = String(p?.product?.nmId ?? p?.nmId ?? '');
    if (!nm) continue;
    for (const h of p?.history ?? []) {
      const date = String(h?.date ?? '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      out.push({ nm, date, open: num(h?.openCount), cart: num(h?.cartCount) });
    }
  }
  return out;
}

async function collectWbFunnel(): Promise<string> {
  const d = getDb();
  if (!d) return 'воронка WB: базы нет';
  const token = (process.env.WB_TOKEN_ANALYTICS || process.env.WB_TOKEN || '').trim();
  if (!token) return 'воронка WB: нет ключа';
  const nms = (d.prepare(`SELECT sku FROM rnp_fact WHERE mp = 'wb' AND date >= ? AND metric IN ('ordered_cnt', 'stocks') AND value > 0
    GROUP BY sku ORDER BY SUM(CASE WHEN metric = 'ordered_cnt' THEN value ELSE 0 END) DESC LIMIT ?`)
    .all(mskDate(13), WB_FUNNEL_MAX_NMS) as Array<{ sku: string }>).map(r => r.sku).filter(s => /^\d+$/.test(s));
  if (!nms.length) return 'воронка WB: нет товаров с заказами или остатком';

  const start = mskDate(6), end = mskDate(0);
  const del = d.prepare(`DELETE FROM rnp_fact WHERE mp = 'wb' AND sku = ? AND date >= ? AND date <= ? AND metric IN (${WB_FUNNEL_METRICS.map(() => '?').join(',')})`);
  const ins = d.prepare('INSERT OR REPLACE INTO rnp_fact (mp, date, sku, metric, value) VALUES (?, ?, ?, ?, ?)');
  let ok = 0, failed = 0, rows = 0;
  let lastErr = '';
  for (let i = 0; i < nms.length; i += 20) {
    const chunk = nms.slice(i, i + 20);
    const r = await fetchWithRetry('https://seller-analytics-api.wildberries.ru/api/analytics/v3/sales-funnel/products/history', {
      method: 'POST',
      headers: { Authorization: token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ selectedPeriod: { start, end }, nmIds: chunk.map(Number), skipDeletedNm: false, aggregationLevel: 'day' }),
    }, { maxRetries: 2, backoff429Ms: 21_000, timeoutMs: 60_000 }).catch(e => ({ ok: false, status: 0, text: async () => String((e as Error).message) }) as any);
    if (!r.ok) {
      failed += chunk.length;
      lastErr = `${r.status} ${(await r.text().catch(() => '')).slice(0, 120)}`;
      // Нет подписки/прав — дальше спрашивать бессмысленно.
      if (r.status === 401 || r.status === 402 || r.status === 403) break;
      continue;
    }
    const hist = parseWbFunnelHistory(await r.json().catch(() => null));
    d.exec('BEGIN');
    try {
      for (const nm of chunk) del.run(nm, start, end, ...WB_FUNNEL_METRICS);
      for (const h of hist) {
        if (h.date < start || h.date > end) continue;
        ins.run('wb', h.date, h.nm, 'session_view_pdp', h.open);
        ins.run('wb', h.date, h.nm, 'hits_tocart', h.cart);
        rows += 2;
      }
      d.exec('COMMIT');
    } catch (e) { d.exec('ROLLBACK'); throw e; }
    ok += chunk.length;
  }
  if (ok) markCollected('wb:funnel');
  return `воронка WB: товаров ${ok} из ${nms.length} → ${rows} значений${failed ? `, сбой ${failed} (${lastErr})` : ''}`;
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
  // Средняя позиция за день. Средние не складываются, поэтому храним позицию ×
  // показы в поиске и сами показы (pos_wsum / pos_weight) — см. writeOzRow.
  ['position_category', 'pos_raw'],
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

// v2 — после добавления средней позиции (11.10): один раз перезабираем 30 дней, чтобы была история.
const BACKFILL_KEY = 'ozon:analytics:backfill:v2';

/** Заказы и воронка Ozon по дням и SKU. Первый раз — 30 дней, дальше — последние 4. */
async function collectOzonAnalytics(items: Map<string, RnpItem>): Promise<string> {
  const backfilled = metaGet(BACKFILL_KEY) === '1';
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
    const val: Record<string, number> = {};
    set.forEach(([, key], i) => { val[key] = num(ms[i]); });
    for (const [key, v] of Object.entries(val)) if (key !== 'pos_raw') bump(facts, date, offer, key, v);
    // Позиция без показов в поиске ничего не значит — такой день не учитываем.
    const pos = val.pos_raw ?? 0;
    const w = val.hits_view_search ?? 0;
    if (pos > 0 && w > 0) {
      bump(facts, date, offer, 'pos_wsum', pos * w);
      bump(facts, date, offer, 'pos_weight', w);
    }
  }
  const days: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
  const keys = set.map(m => m[1]).filter(k => k !== 'pos_raw');
  if (set.some(m => m[1] === 'pos_raw')) keys.push('pos_wsum', 'pos_weight');
  const written = writeDays('ozon', days, keys, facts);
  if (!backfilled) metaSet(BACKFILL_KEY, '1');
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

/**
 * Соинвест Ozon по заказам: цена продавца (financial_data.products[].price) против
 * того, что заплатил покупатель (customer_price). Как и у WB, считаем по дате заказа.
 *
 * Проверено 12.10: у FBS customer_price приходит прямо в списке (86 из 86 за
 * сутки), у FBO — только в детали v2/posting/fbo/get (в списке его нет), поэтому
 * FBO разворачиваем по одному — их немного (~13 в сутки). Список FBO отдаёт
 * limit ≤ 100 и курсор, поле dir игнорирует (см. ozonBuyerPrices.ts).
 *
 * Первый проход — 30 дней, дальше — последние 3 (заказ дня может приехать позже).
 */
const OZ_SPP_BACKFILL_KEY = 'ozon:spp:backfill:v1';
/** Строже этого — выброс (компенсации, служебные позиции), см. ozonBuyerPrices.ts. */
const OZ_MAX_PLAUSIBLE_SPP = 0.85;

async function collectOzonSpp(): Promise<string> {
  const backfilled = metaGet(OZ_SPP_BACKFILL_KEY) === '1';
  const from = mskDate(backfilled ? 2 : 29);
  const to = mskDate(0);
  // Границы — МСК-сутки в UTC.
  const sinceIso = new Date(Date.parse(from + 'T00:00:00Z') - MSK_OFFSET_MS).toISOString();
  const toIso = new Date(Date.parse(to + 'T23:59:59Z') - MSK_OFFSET_MS).toISOString();

  const { getSkuMap } = await import('./ozonShowcase');
  const skuToOffer = await getSkuMap();
  const facts: DayFacts = new Map();
  let lines = 0, skipped = 0;
  const take = (p: any) => {
    const t = Date.parse(p?.in_process_at ?? p?.created_at ?? '');
    if (!Number.isFinite(t)) return;
    const date = mskDateOf(t);
    if (date < from || date > to) return;
    const offerBySku = new Map<string, string>();
    for (const it of (p?.products ?? [])) {
      const sku = String(it?.sku ?? '');
      offerBySku.set(sku, skuToOffer[sku] || String(it?.offer_id ?? '').trim());
    }
    for (const fin of (p?.financial_data?.products ?? [])) {
      const offer = offerBySku.get(String(fin?.product_id ?? ''));
      const seller = num(fin?.price);
      const buyer = num(String(fin?.customer_price ?? '').replace(',', '.'));
      const q = num(fin?.quantity) || 1;
      if (!offer || seller <= 0 || buyer <= 0) { skipped++; continue; }
      if (buyer < seller * (1 - OZ_MAX_PLAUSIBLE_SPP)) { skipped++; continue; }
      bump(facts, date, offer, 'spp_base', seller * q);
      bump(facts, date, offer, 'spp_disc', Math.max(0, seller - buyer) * q);
      lines++;
    }
  };

  // FBS: цена покупателя сразу в списке.
  let fbs = 0;
  for (let offset = 0; offset < 20_000; offset += 1000) {
    const j = await ozPost('v3/posting/fbs/list', {
      dir: 'ASC', filter: { since: sinceIso, to: toIso }, limit: 1000, offset, with: { financial_data: true },
    });
    const batch: any[] = j?.result?.postings ?? [];
    batch.forEach(take);
    fbs += batch.length;
    if (!j?.result?.has_next || batch.length < 1000) break;
  }

  // FBO: список без цены покупателя → деталь по каждому отправлению.
  const fboList: any[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 50; page++) {
    const j = await ozPost('v3/posting/fbo/list', {
      dir: 'ASC', filter: { since: sinceIso, to: toIso }, limit: 100, with: { financial_data: true },
      ...(cursor ? { cursor } : { offset: 0 }),
    });
    const batch: any[] = j?.postings ?? j?.result?.postings ?? [];
    fboList.push(...batch);
    cursor = j?.cursor;
    if (!j?.has_next || !cursor || !batch.length) break;
  }
  let fboFailed = 0;
  for (const p of fboList) {
    try {
      const j = await ozPost('v2/posting/fbo/get', { posting_number: p?.posting_number, with: { financial_data: true } });
      take(j?.result ?? j);
    } catch { fboFailed++; }
    await sleep(120);
  }
  // Сбой части деталей FBO занизил бы базу дня — такой проход не записываем.
  if (fboFailed > Math.max(2, fboList.length * 0.1)) {
    return `соинвест Ozon: не открылись ${fboFailed} из ${fboList.length} FBO, пропуск`;
  }

  const days: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
  const written = writeDays('ozon', days, ['spp_base', 'spp_disc'], facts);
  if (!backfilled) metaSet(OZ_SPP_BACKFILL_KEY, '1');
  markCollected('ozon:spp');
  return `соинвест Ozon ${from}…${to}: FBS ${fbs}, FBO ${fboList.length}, позиций ${lines}${skipped ? `, без цены ${skipped}` : ''} → ${written} значений`;
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
      await step('позиции WB', () => collectWbPositions());
      await step('воронка WB', () => collectWbFunnel());
      await step('каталог WB', async () => { await wbCatalog(items); await fillSheetCategories(items); upsertItems('wb', [...items.values()]); return `каталог WB: ${items.size} товаров`; });
    }
    if (!only || only === 'ozon') {
      const items = new Map<string, RnpItem>();
      await step('аналитика Ozon', () => collectOzonAnalytics(items));
      await step('соинвест Ozon', () => collectOzonSpp());
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

/**
 * Цена в кабинете продавца (со скидкой продавца, до СПП/соинвеста площадки) —
 * та же база, что у «Среднего чека» в РНП и у «Цены ЛК» на листе «Цены».
 * Берём из прогретого кэша ценовых API (cron обновляет их сам), ключ — артикул UPPER.
 */
async function sellerPrices(mp: RnpMp): Promise<Record<string, number>> {
  const map: Record<string, number> = {};
  const key = mp === 'wb'
    ? makeUpstreamCacheKey('wb:discounts', 'GET', 'api/v2/list/goods/filter', '?limit=1000', undefined)
    : makeUpstreamCacheKey('ozon-seller', 'POST', 'v5/product/info/prices', '', JSON.stringify({ filter: { visibility: 'ALL' }, limit: 100 }));
  const cached = await cacheGet<{ text: string }>(key);
  if (!cached?.data?.text) return map;
  try {
    const j = JSON.parse(cached.data.text);
    if (mp === 'wb') {
      for (const g of j?.data?.listGoods ?? []) {
        const art = up(g?.vendorCode);
        const s = g?.sizes?.[0] ?? {};
        const p = num(s.discountedPrice) || num(s.price) * (1 - num(g?.discount) / 100);
        if (art && p > 0) map[art] = Math.round(p);
      }
    } else {
      for (const it of j?.items ?? []) {
        const art = up(it?.offer_id);
        // Как «Цена ЛК» на листе «Цены»: marketing_seller_price, иначе price.price.
        const p = num(it?.price?.marketing_seller_price) || num(it?.price?.price);
        if (art && p > 0) map[art] = Math.round(p);
      }
    }
  } catch { /* кэш не разобран — цены просто не покажем */ }
  return map;
}

export async function getRnp(mp: RnpMp, fromIn?: string, toIn?: string): Promise<RnpResponse> {
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
  for (const src of ['sales', 'ads', 'stock', 'analytics', 'funnel']) {
    const v = metaGet(`collected:${mp}:${src}`);
    if (v) res.collectedAt[src] = Number(v);
  }
  // Текущая цена, маржа и ROI — снимок листа «Цены» (его шлёт браузер, пока лист
  // открыт; тот же снимок берёт «Управление рекламой»). Цифры совпадают с таблицей цен.
  try {
    const raw = getUiState().state[`prices-${mp}:margins`];
    const j = raw ? JSON.parse(raw) : null;
    if (j?.items) {
      res.prices = {};
      for (const [k, v] of Object.entries<any>(j.items)) {
        if (v?.view) res.prices[k] = v.view;
        // Снимок старого формата (без view, его пишет вкладка со старой версией сайта):
        // маржу берём из него, ROI в нём нет.
        else if (v) res.prices[k] = { price: null, marginPct: v.marginPct ?? null, marginRub: v.marginRub ?? null, roi: null, roiStatus: null };
      }
      res.pricesAt = Number(j.at) || null;
    }
  } catch { /* снимка нет — блок цены просто не показываем */ }
  // Маржа и ROI живут только в снимке листа «Цены»: если он пуст или старый — говорим, как обновить.
  const sheet = `«Цены» → ${mp === 'wb' ? 'Wildberries' : 'Ozon'}`;
  const withMargin = Object.values(res.prices ?? {}).filter(p => p.marginPct !== null).length;
  if (!res.prices || !withMargin) notes.push(`Маржа и ROI берутся с листа ${sheet}, а свежего расчёта оттуда ещё нет. Откройте этот лист и дождитесь загрузки — цифры появятся здесь после обновления страницы.`);
  else if (res.pricesAt && Date.now() - res.pricesAt > 2 * DAY_MS) notes.push(`Маржа и ROI — по расчёту листа ${sheet} от ${new Date(res.pricesAt + 3 * 3_600_000).toISOString().slice(0, 10).split('-').reverse().join('.')}. Откройте лист, чтобы обновить.`);
  res.sellerPrices = await sellerPrices(mp);
  if (!rows.length) notes.push('За выбранный период данных ещё нет: сбор идёт раз в 2 часа, первый проход после запуска сервера — в течение 10–30 минут.');
  if (present.has('stocks') && salesStart && from < salesStart) notes.push(`История собирается с ${salesStart.split('-').reverse().join('.')}: раньше этой даты данных нет.`);
  return res;
}
