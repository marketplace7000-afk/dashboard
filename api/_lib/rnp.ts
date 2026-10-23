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
import { skuStatsByDay } from './ads/store';
import { fetchWithRetry } from './fetchRetry';
import { listOzonFbsPostings } from './ozonFbsList';
import { getUiState } from './uiState';
import { resolveCost, getCosts } from './costs';
import type { RnpMp, RnpItem, RnpResponse, RnpSummary, RnpSummaryProduct } from '../../shared/rnp';

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

/** Весь справочник товаров площадки (WB: sku = nmID; Ozon: sku = артикул, extId = SKU). */
export function rnpItems(mp: RnpMp): { sku: string; article: string; name: string; photo: string; extId: string }[] {
  const d = getDb();
  if (!d) return [];
  try {
    return (d.prepare('SELECT sku, article, name, photo, ext_id FROM rnp_item WHERE mp = ?').all(mp) as any[])
      .map(r => ({ sku: String(r.sku), article: String(r.article || ''), name: String(r.name || ''), photo: String(r.photo || ''), extId: String(r.ext_id || '') }));
  } catch { return []; }
}

/**
 * Товары в наличии: остаток FBO+FBS > 0 в последнем обходе остатков (как фильтр «В продаже» в «Ценах»).
 * Заказы без остатка не считаем: на Ozon это в основном старые дубли карточек.
 */
export function rnpInStockSkus(mp: RnpMp): Set<string> {
  const d = getDb();
  if (!d) return new Set();
  try {
    const last = (d.prepare(`SELECT max(date) dt FROM rnp_fact WHERE mp = ? AND metric = 'stocks'`).get(mp) as any)?.dt ?? '';
    const rows = d.prepare(`SELECT DISTINCT sku FROM rnp_fact WHERE mp = ? AND metric = 'stocks' AND date = ? AND value > 0`).all(mp, last) as any[];
    return new Set(rows.map(r => String(r.sku)));
  } catch { return new Set(); }
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

/** Сколько дней рекламы WB переписывать за проход: окно fullstats 30 дн + запас. */
const WB_ADS_DAYS = 35;

/**
 * Реклама WB по дням и товарам — из хранилища «Рекламы» (ads.sqlite, ad_stat_day).
 *
 * 22.10.2026: раньше читали одно самое свежее окно кэша fullstats и целиком
 * переписывали им 31 день. Если WB ответил 429 на часть кампаний, окно было
 * неполным — и РНП (а за ней «Реклама → Товары») теряла расход WB за весь месяц
 * (22.10 один такой прогрев оставил ~3–5 тыс ₽/день вместо 14–22 тыс по API). Хранилище
 * заменяет строки по паре «кампания × день» и неполным ответом ничего не стирает;
 * syncAds в цепочке крона идёт раньше collectRnp, так что данные свежие.
 */
function collectWbAds(): string {
  const to = mskDate(0);
  const from = mskDate(WB_ADS_DAYS - 1);
  const stats = skuStatsByDay('wb', from, to);
  if (!stats.length) return 'реклама WB: в хранилище рекламы пусто';
  const facts: DayFacts = new Map();
  const days = new Set<string>();
  for (const r of stats) {
    days.add(r.date);
    bump(facts, r.date, r.sku, 'adv_views', num(r.views));
    bump(facts, r.date, r.sku, 'adv_clicks', num(r.clicks));
    bump(facts, r.date, r.sku, 'adv_expenses', num(r.spend));
    bump(facts, r.date, r.sku, 'adv_orders', num(r.orders));
    bump(facts, r.date, r.sku, 'adv_revenue', num(r.revenue));
  }
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

/**
 * Цены по дням (этап Б советника, 15.10.2026): цена ЛК (ценовые API, тот же кэш, что у листа «Цены»)
 * и цена покупателя (WB — последняя продажа с СПП, Ozon — средняя по отправлениям с соинвестом).
 * Снимок на сегодня; из него советник видит «наша цена выросла» без пересчёта по заказам.
 */
async function collectPrices(mp: RnpMp): Promise<string> {
  const today = mskDateOf(Date.now());
  const facts: DayFacts = new Map();
  const items = rnpItems(mp);
  // ключ РНП по артикулу (UPPER): WB — nmId, Ozon — артикул как есть
  const byArt = new Map<string, string>();
  for (const it of items) { if (it.article) byArt.set(up(it.article), it.sku); if (mp === 'ozon') byArt.set(up(it.sku), it.sku); }
  const seller = await sellerPrices(mp);
  let n = 0;
  for (const [art, p] of Object.entries(seller)) {
    const sku = byArt.get(art);
    if (sku && p > 0) { bump(facts, today, sku, 'price_seller', p); n++; }
  }
  // Цена покупателя — из серверной маржи: там первый источник — витрина, снятая Агентом 3
  // (наши карточки, 4 прохода в день), дальше продажи / соинвест / память.
  let b = 0;
  try {
    const { getMargins } = await import('./margin');
    const m = await getMargins(mp);
    for (const r of Object.values(m.items)) {
      const sku = mp === 'wb' ? r.id : byArt.get(r.article);
      if (sku && r.buyer != null && r.buyer > 0) { bump(facts, today, sku, 'price_buyer', r.buyer); b++; }
    }
  } catch { /* маржа не посчиталась — цену покупателя за день не пишем */ }
  const rows = writeDays(mp, [today], ['price_seller', 'price_buyer'], facts);
  markCollected(`${mp}:prices`);
  return `цены ${mp === 'wb' ? 'WB' : 'Ozon'}: ЛК ${n}, покупателя ${b} → ${rows} значений на ${today}`;
}

/**
 * Рейтинг и число отзывов карточки по дням (18.10.2026, просьба владельца — видеть просадку рейтинга).
 * Берём то, что видит покупатель на витрине: Агент 3 несколько раз в день снимает наши карточки
 * (ads.sqlite → ad_comp_card, строка на товар в день, последний замер дня). Запросов к площадкам нет.
 * Таблица хранит 120 дней, поэтому каждый проход переписываем всю её историю — так подтягиваются
 * и дни до появления этой метрики (с 15.10.2026), и поздние замеры.
 * WB: id = nmID = ключ РНП. Ozon: id = SKU площадки → артикул (справочник РНП и карта SKU).
 */
export async function collectRatings(mp: RnpMp): Promise<string> {
  const { adsDb } = await import('./ads/store');
  const a = adsDb();
  if (!a) return `рейтинг ${mp === 'wb' ? 'WB' : 'Ozon'}: базы витрины нет`;
  let rows: Array<{ id: string; date: string; rating: number | null; feedbacks: number | null }>;
  try {
    rows = a.prepare(`SELECT id, date, rating, feedbacks FROM ad_comp_card WHERE mp = ? AND (hidden IS NULL OR hidden = 0) AND rating > 0`).all(mp) as any[];
  } catch { return `рейтинг ${mp === 'wb' ? 'WB' : 'Ozon'}: замеров витрины ещё нет`; }
  const toKey = new Map<string, string>();
  for (const it of rnpItems(mp)) {
    if (mp === 'wb') toKey.set(it.sku, it.sku);
    else if (it.extId) toKey.set(it.extId, it.sku);
  }
  if (mp === 'ozon') {
    const { getSkuMap } = await import('./ozonShowcase');
    for (const [sku, offer] of Object.entries(await getSkuMap())) if (!toKey.has(sku)) toKey.set(sku, offer);
  }
  const facts: DayFacts = new Map();
  const days = new Set<string>();
  const seen = new Set<string>();   // у одного артикула Ozon бывает несколько SKU — берём первый замер
  let n = 0;
  for (const r of rows) {
    const key = toKey.get(String(r.id));
    if (!key || seen.has(`${r.date}|${key}`)) continue;
    seen.add(`${r.date}|${key}`);
    days.add(r.date);
    bump(facts, r.date, key, 'rating', num(r.rating));
    if (r.feedbacks != null) bump(facts, r.date, key, 'feedbacks', num(r.feedbacks));
    n++;
  }
  if (!days.size) return `рейтинг ${mp === 'wb' ? 'WB' : 'Ozon'}: наших карточек в замерах нет`;
  const written = writeDays(mp, days, ['rating', 'feedbacks'], facts);
  markCollected(`${mp}:rating`);
  return `рейтинг ${mp === 'wb' ? 'WB' : 'Ozon'}: ${days.size} дн, замеров ${n} → ${written} значений`;
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
// wbf_order_* — заказы из той же воронки (22.10.2026): «Заказали на сумму» и штуки, как
// в аналитике кабинета. Заказы из supplier/orders (ordered_*) недосчитывают часть заказов:
// за 15–21.10 там 2 489 225 ₽ и 298 шт, в воронке и кабинете — 2 830 246 ₽ и 348 шт.
const WB_FUNNEL_METRICS = ['session_view_pdp', 'hits_tocart', 'wbf_order_cnt', 'wbf_order_sum'];
const WB_FUNNEL_MAX_NMS = 400;

export type WbFunnelDay = { nm: string; date: string; open: number; cart: number; orders: number; orderSum: number };

export function parseWbFunnelHistory(json: unknown): WbFunnelDay[] {
  const arr: any[] = Array.isArray(json) ? json : Array.isArray((json as any)?.data) ? (json as any).data : [];
  const out: WbFunnelDay[] = [];
  for (const p of arr) {
    const nm = String(p?.product?.nmId ?? p?.nmId ?? '');
    if (!nm) continue;
    for (const h of p?.history ?? []) {
      const date = String(h?.date ?? '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      out.push({ nm, date, open: num(h?.openCount), cart: num(h?.cartCount), orders: num(h?.orderCount), orderSum: num(h?.orderSum) });
    }
  }
  return out;
}

/**
 * Разовая догрузка заказов воронки за дни старше недели (история воронки по дням
 * отдаёт только последнюю неделю). Сводный метод sales-funnel/products с периодом
 * в один день отдаёт то же «Заказали на сумму» по товарам; по 12 дней за проход,
 * пауза 21 с — лимит шлюза 3 запроса в минуту.
 */
const WBF_BACKFILL_FROM = '2026-09-12';
export async function backfillWbFunnelOrders(): Promise<string> {
  const d = getDb();
  if (!d) return 'заказы воронки WB: базы нет';
  const token = (process.env.WB_TOKEN_ANALYTICS || process.env.WB_TOKEN || '').trim();
  if (!token) return 'заказы воронки WB: нет ключа';
  const days: string[] = [];
  for (let x = WBF_BACKFILL_FROM; x <= mskDate(7) && days.length < 12; x = addDays(x, 1)) if (metaGet(`wbf:day:${x}`) !== '1') days.push(x);
  if (!days.length) return 'заказы воронки WB: история догружена';
  const del = d.prepare(`DELETE FROM rnp_fact WHERE mp = 'wb' AND date = ? AND metric IN ('wbf_order_cnt', 'wbf_order_sum')`);
  const ins = d.prepare('INSERT OR REPLACE INTO rnp_fact (mp, date, sku, metric, value) VALUES (?, ?, ?, ?, ?)');
  let done = 0, lastErr = '';
  for (const day of days) {
    if (done) await sleep(21_000);
    const r = await fetchWithRetry('https://seller-analytics-api.wildberries.ru/api/analytics/v3/sales-funnel/products', {
      method: 'POST', headers: { Authorization: token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ selectedPeriod: { start: day, end: day }, limit: 1000, offset: 0 }),
    }, { maxRetries: 2, backoff429Ms: 21_000, timeoutMs: 60_000 }).catch(e => ({ ok: false, status: 0, text: async () => String((e as Error).message) }) as any);
    if (!r.ok) { lastErr = `${r.status} ${(await r.text().catch(() => '')).slice(0, 120)}`; break; }
    const j = await r.json().catch(() => null);
    const list: any[] = j?.data?.products ?? [];
    if (!j) { lastErr = 'ответ не JSON'; break; }
    d.exec('BEGIN');
    try {
      del.run(day);
      for (const p of list) {
        const nm = String(p?.product?.nmId ?? '');
        const s = p?.statistic?.selected ?? {};
        if (!nm || !(num(s.orderCount) > 0)) continue;
        ins.run('wb', day, nm, 'wbf_order_cnt', num(s.orderCount));
        ins.run('wb', day, nm, 'wbf_order_sum', num(s.orderSum));
      }
      d.exec('COMMIT');
    } catch (e) { d.exec('ROLLBACK'); throw e; }
    metaSet(`wbf:day:${day}`, '1');
    done++;
  }
  return `заказы воронки WB: догружено дней ${done} из ${days.length}${lastErr ? ` (${lastErr})` : ''}`;
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
    const json = await r.json().catch(() => null);
    // Ответ не разобрался — не стираем дни этих товаров: «лучше старые данные, чем дыра».
    if (!json) { failed += chunk.length; lastErr = 'ответ не JSON'; continue; }
    const hist = parseWbFunnelHistory(json);
    d.exec('BEGIN');
    try {
      for (const nm of chunk) del.run(nm, start, end, ...WB_FUNNEL_METRICS);
      for (const h of hist) {
        if (h.date < start || h.date > end) continue;
        ins.run('wb', h.date, h.nm, 'session_view_pdp', h.open);
        ins.run('wb', h.date, h.nm, 'hits_tocart', h.cart);
        ins.run('wb', h.date, h.nm, 'wbf_order_cnt', h.orders);
        ins.run('wb', h.date, h.nm, 'wbf_order_sum', h.orderSum);
        rows += 4;
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
  // Урезанный набор — только на сегодня: раньше один отказ 400/403 включал его
  // навсегда, и расширенные метрики не возвращались, даже когда Ozon снова их отдавал.
  let set = metaGet('ozon:analytics:basic') === mskDate(0) ? OZ_BASIC : OZ_FULL;
  let rows: any[];
  try {
    rows = await fetchOzAnalytics(from, to, set);
  } catch (e) {
    const status = (e as { status?: number }).status;
    if (set === OZ_FULL && (status === 400 || status === 403)) {
      console.warn('[rnp] Ozon не отдал расширенные метрики, берём заказы и выручку:', (e as Error).message);
      metaSet('ozon:analytics:basic', mskDate(0));
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
const OZ_AD_METRICS = ['adv_expenses', 'adv_views', 'adv_clicks', 'adv_orders', 'adv_revenue'] as const;

/**
 * Запись рекламы Ozon за день без потерь (23.10.2026).
 *
 * Отчёт Ozon по товарам собирается пачками по 10 кампаний; если бюджет окна
 * кончился, в нём только часть товаров — раньше он целиком перезаписывал день,
 * и у остальных товаров расход пропадал (22.10: 12 товаров вместо 28).
 * Теперь:
 *   • неполный отчёт день не затирает: по каждому товару берём большее из
 *     записанного и нового (расход за прошедший день только растёт);
 *   • статистика кампаний «Рекламы» (ad_stat_day, синхронный метод Ozon, каждые 2 ч)
 *     — страховка: товар, который есть там, а в отчёте нет или меньше, берём оттуда.
 * Возвращает, сколько товаров добавлено из статистики кампаний.
 */
function mergeOzonAdsDay(date: string, facts: DayFacts, complete: boolean): number {
  const d = getDb();
  if (!d) return 0;
  const day = facts.get(date) ?? new Map<string, Map<string, number>>();
  facts.set(date, day);
  const put = (sku: string, metric: string, v: number) => {
    const m = day.get(sku) ?? new Map<string, number>();
    m.set(metric, Math.max(m.get(metric) ?? 0, v));
    day.set(sku, m);
  };
  if (!complete) {
    const rows = d.prepare(`SELECT sku, metric, value FROM rnp_fact WHERE mp = 'ozon' AND date = ? AND metric IN (${OZ_AD_METRICS.map(() => '?').join(',')})`)
      .all(date, ...OZ_AD_METRICS) as Array<{ sku: string; metric: string; value: number }>;
    for (const r of rows) put(r.sku, r.metric, num(r.value));
  }
  // SKU площадки → артикул (ключ РНП).
  const offerBySku = new Map((d.prepare(`SELECT sku, ext_id FROM rnp_item WHERE mp = 'ozon' AND ext_id IS NOT NULL AND ext_id <> ''`).all() as any[])
    .map(r => [String(r.ext_id), String(r.sku)]));
  let added = 0;
  for (const s of skuStatsByDay('ozon', date, date)) {
    const offer = offerBySku.get(String(s.sku));
    if (!offer) continue;
    if (!day.has(offer) && num(s.spend) > 0) added++;
    put(offer, 'adv_expenses', num(s.spend));
    put(offer, 'adv_views', num(s.views));
    put(offer, 'adv_clicks', num(s.clicks));
    put(offer, 'adv_orders', num(s.orders));
    put(offer, 'adv_revenue', num(s.revenue));
  }
  writeDays('ozon', [date], [...OZ_AD_METRICS], facts);
  return added;
}

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
    const complete = r.complete !== false;
    const added = mergeOzonAdsDay(date, facts, complete);
    // Закрытый день (не сегодня) считаем собранным — дальше его не перезаказываем. Неполный — перезакажем.
    if (complete && (b >= 2 || (b === 1 && date === mskDate(1)))) metaSet(`ozon:ads-day:${date}`, '1');
    parts.push(`${date}: товаров ${r.count}${complete ? '' : ' (отчёт неполный — день дополнен, не затёрт)'}${added ? `, из статистики кампаний +${added}` : ''}`);
  }
  // Прошлые дни, которые отчёт в этот проход не трогал: дополняем из статистики кампаний
  // (только добавляет и поднимает, ничего не стирает) — так чинятся дни, затёртые неполным отчётом.
  let healed = 0;
  for (let b = 2; b <= 13; b++) if (!backs.includes(b)) healed += mergeOzonAdsDay(mskDate(b), new Map(), false);
  if (healed) parts.push(`прошлые дни дополнены: +${healed} товаро-дней`);
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
  const fbsList = await listOzonFbsPostings(ozPost, { filter: { since: sinceIso, to: toIso }, with: { financial_data: true } });
  fbsList.forEach(take);
  const fbs = fbsList.length;

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

/**
 * Типы товаров Ozon (type_id = category3Id в «Товарах на Ozon»), отсортированные
 * по нашей выручке заказов за последние дни — для задания «Конкуренты» Агента 3.
 * Только из кэша каталога и базы РНП, без запросов к Ozon.
 */
export async function ozonTopTypeIds(limit = 8, days = 14): Promise<{ typeId: string; revenue: number }[]> {
  const cat = (await cacheGet<Record<string, { typeId: string }>>(OZ_CATALOG_KEY))?.data;
  if (!cat) return [];
  const to = mskDate(0);
  const from = new Date(Date.parse(to + 'T00:00:00Z') - (days - 1) * DAY_MS).toISOString().slice(0, 10);
  const rnp = await getRnp('ozon', from, to);
  const sum = new Map<string, number>();
  for (const [key, f] of Object.entries(rnp.facts)) {
    const t = cat[key]?.typeId;
    if (!t) continue;
    const rev = (f?.ordered_amount ?? []).reduce((s: number, v: number | null) => s + (v ?? 0), 0);
    if (rev > 0) sum.set(t, (sum.get(t) ?? 0) + rev);
  }
  return [...sum.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([typeId, revenue]) => ({ typeId, revenue: Math.round(revenue) }));
}

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

// Состояние на process: под tsx модуль грузится в двух копиях (см. cache.ts), и
// флаг в переменной модуля не мешал планировщику и крону собирать одновременно.
const run: { collecting: Promise<string[]> | null; scope: RnpMp | 'all' | null } =
  ((process as any).__AV_RNP_RUN__ ??= { collecting: null, scope: null });

/**
 * Один проход сбора по обеим площадкам. Каждый источник независим: сбой одного
 * не мешает остальным. Повторный вызов во время прохода ждёт текущий, а если
 * текущий собирает другую площадку — после него собирает свою (раньше Ozon в
 * этом случае просто пропускался).
 */
export function collectRnp(only?: RnpMp): Promise<string[]> {
  const want = only ?? 'all';
  if (run.collecting) {
    if (run.scope === 'all' || run.scope === want) return run.collecting;
    return run.collecting.catch(() => []).then(() => collectRnp(only));
  }
  run.scope = want;
  run.collecting = (async () => {
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
      await step('заказы воронки WB', () => backfillWbFunnelOrders());
      await step('каталог WB', async () => { await wbCatalog(items); await fillSheetCategories(items); upsertItems('wb', [...items.values()]); return `каталог WB: ${items.size} товаров`; });
      await step('цены WB', () => collectPrices('wb'));
      await step('рейтинг WB', () => collectRatings('wb'));
    }
    if (!only || only === 'ozon') {
      const items = new Map<string, RnpItem>();
      await step('аналитика Ozon', () => collectOzonAnalytics(items));
      await step('соинвест Ozon', () => collectOzonSpp());
      await step('остатки Ozon', () => collectOzonStock());
      await step('каталог Ozon', async () => { await ozonCatalog(items); await fillSheetCategories(items); upsertItems('ozon', [...items.values()]); return `каталог Ozon: ${items.size} товаров`; });
      await step('реклама Ozon', () => collectOzonAds());
      await step('цены Ozon', () => collectPrices('ozon'));
      await step('рейтинг Ozon', () => collectRatings('ozon'));
    }
    console.warn('[rnp]', log.join(' · '));
    return log;
  })().finally(() => { run.collecting = null; run.scope = null; });
  return run.collecting;
}

export function rnpCollecting(): boolean {
  return run.collecting != null;
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

type RnpRow = { date: string; sku: string; metric: string; value: number };

/**
 * Какие строки базы считать фактами РНП (22.10.2026, сверка с сервисом 10X):
 *   • только настоящие товары — себестоимость заведена в «Складе»; товары для
 *     выкупов (светильники, сифоны, 3KOEPHKI…) не учитываются ни в одном анализе;
 *   • WB, заказы — из воронки (wbf_order_*), как «Заказали на сумму» в кабинете и в
 *     10X: отчёт supplier/orders недосчитывал 5–25 % заказов в день. Дни без воронки —
 *     по supplier/orders;
 *   • WB, выкупы — из финотчёта (дата операции, цена продавца до СПП, минус
 *     возвраты), как в 10X: отчёт «Продажи» давал +7 % за счёт других цен. Дни после
 *     последнего финотчёта остаются пустыми, а не подменяются «Продажами».
 * Отсюда читают все: экран РНП, Советник, обзор рекламы и сигналы.
 */
async function sourceRows(mp: RnpMp, raw: RnpRow[], items: any[], from: string, to: string, notes: string[]): Promise<RnpRow[]> {
  const costs = getCosts();
  const article = new Map(items.map(it => [String(it.sku), String(it.article || it.sku)]));
  const realCache = new Map<string, boolean>();
  const isReal = (sku: string) => {
    let v = realCache.get(sku);
    if (v === undefined) { v = !!resolveCost(article.get(sku) ?? sku, costs); realCache.set(sku, v); }
    return v;
  };
  const fake = new Set<string>();
  let out: RnpRow[] = [];
  const funnelDays = mp === 'wb' ? new Set(raw.filter(r => r.metric === 'wbf_order_sum').map(r => r.date)) : new Set<string>();
  for (const r of raw) {
    if (!isReal(r.sku)) { if (r.metric === 'ordered_cnt' && r.value > 0) fake.add(r.sku); continue; }
    if (mp === 'wb') {
      if (r.metric === 'wbf_order_sum') { out.push({ ...r, metric: 'ordered_amount' }); continue; }
      if (r.metric === 'wbf_order_cnt') { out.push({ ...r, metric: 'ordered_cnt' }); continue; }
      if ((r.metric === 'ordered_amount' || r.metric === 'ordered_cnt') && funnelDays.has(r.date)) continue;
    }
    out.push(r);
  }
  if (mp === 'wb') {
    const { getWbBuyouts } = await import('./finHistory');
    const fin = getWbBuyouts(from, to);
    if (fin.coveredTo) {
      out = out.filter(r => r.metric !== 'bought_amount' && r.metric !== 'bought_cnt');
      // Артикул финотчёта → nmId карточки. Артикул бывает у нескольких карточек — берём ту, у которой были заказы.
      const ordered = new Set(raw.filter(r => r.metric === 'ordered_cnt' && r.value > 0).map(r => r.sku));
      const nmByArticle = new Map<string, string>();
      for (const [sku, art] of article) {
        const k = art.toUpperCase();
        if (!nmByArticle.has(k) || ordered.has(sku)) nmByArticle.set(k, sku);
      }
      let lost = 0;
      for (const b of fin.rows) {
        const nm = nmByArticle.get(b.article.toUpperCase());
        if (!nm) { lost += b.rev; continue; }
        if (!isReal(nm)) continue;
        out.push({ date: b.date, sku: nm, metric: 'bought_amount', value: Math.round(b.rev * 100) / 100 });
        out.push({ date: b.date, sku: nm, metric: 'bought_cnt', value: b.units });
      }
      notes.push(`Заказы WB — по воронке, как в кабинете; выкупы — по финотчёту WB (цена продавца до СПП, за вычетом возвратов), он есть по ${fin.coveredTo.split('-').reverse().join('.')}.`);
      if (lost > 0) notes.push(`Выкупы на ${Math.round(lost).toLocaleString('ru-RU')} ₽ из финотчёта не сопоставились с карточками РНП.`);
    }
  }
  if (fake.size) notes.push(`Не показаны товары для выкупов — без себестоимости в «Складе»: ${fake.size} шт.`);
  return out;
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
  const raw = d.prepare('SELECT date, sku, metric, value FROM rnp_fact WHERE mp = ? AND date >= ? AND date <= ?').all(mp, preFrom, to) as RnpRow[];
  const items = d.prepare('SELECT * FROM rnp_item WHERE mp = ?').all(mp) as any[];
  const rows = await sourceRows(mp, raw, items, preFrom, to, notes);

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
  for (const src of ['sales', 'ads', 'stock', 'analytics', 'funnel', 'prices', 'rating']) {
    const v = metaGet(`collected:${mp}:${src}`);
    if (v) res.collectedAt[src] = Number(v);
  }
  // Текущая цена, маржа и ROI. С 15.10.2026 (этап Б советника) считаются на сервере теми же
  // формулами, что на листе «Цены» (api/_lib/margin.ts) — без открытого листа. Снимок листа
  // (его шлёт браузер, пока лист открыт) остаётся запасным путём, если серверный расчёт пуст.
  let served = false;
  try {
    const { getMargins } = await import('./margin');
    const m = await getMargins(mp);
    if (m.withMargin) {
      res.prices = {};
      for (const [art, r] of Object.entries(m.items)) res.prices[art] = { price: r.buyer, marginPct: r.marginPct, marginRub: r.marginRub, roi: r.roi, roiStatus: r.roiStatus, adsRub: r.adsRub ?? null, base: r.base ?? null, buyout: r.buyout ?? null };
      res.pricesAt = m.at;
      served = true;
    }
  } catch (e) { notes.push(`Маржа на сервере не посчиталась: ${(e as Error).message.slice(0, 120)}`); }
  if (!served) {
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
    const sheet = `«Цены» → ${mp === 'wb' ? 'Wildberries' : 'Ozon'}`;
    const withMargin = Object.values(res.prices ?? {}).filter(p => p.marginPct !== null).length;
    if (!res.prices || !withMargin) notes.push(`Маржа и ROI пока не посчитаны: нет себестоимости или цены ЛК в кэше площадки. Откройте лист ${sheet} — его расчёт подхватится.`);
  }
  res.sellerPrices = await sellerPrices(mp);
  if (!rows.length) notes.push('За выбранный период данных ещё нет: сбор идёт раз в 2 часа, первый проход после запуска сервера — в течение 10–30 минут.');
  if (present.has('stocks') && salesStart && from < salesStart) notes.push(`История собирается с ${salesStart.split('-').reverse().join('.')}: раньше этой даты данных нет.`);
  return res;
}

/**
 * Выжимка РНП для главной за любой период (21.10.2026): заказы по дням до и после
 * СПП, реклама и товары, которые сильнее всего выросли или упали. Полный getRnp за
 * 60 дней — ~1,4 МБ по Ozon; главной нужны несколько метрик, поэтому читаем таблицу
 * напрямую и отдаём килобайты.
 *
 * «До СПП» — «Заказали на сумму» по цене продавца: у WB из воронки (wbf_order_*, как в
 * аналитике кабинета; дни без воронки — по supplier/orders), у Ozon — «Заказано на сумму»
 * из аналитики. «После СПП» — та же сумма за вычетом доли скидки площадки дня
 * (spp_disc / spp_base).
 *
 * Считаются только настоящие товары — те, чья себестоимость заведена в таблице «Склад».
 * Остальное (товары для выкупов: светильники, сифоны и т.п.) владелец просил не
 * учитывать ни в одном анализе (22.10.2026).
 */
export function getRnpSummary(mp: RnpMp, fromIn: string, toIn: string): RnpSummary {
  const today = mskDate(0);
  const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);
  let to = isDate(toIn) && toIn <= today ? toIn : today;
  let from = isDate(fromIn) ? fromIn : addDays(to, -6);
  if (from > to) [from, to] = [to, from];
  if ((Date.parse(to) - Date.parse(from)) / DAY_MS >= MAX_DAYS) from = addDays(to, -(MAX_DAYS - 1));
  const dates: string[] = [];
  for (let x = from; x <= to; x = addDays(x, 1)) dates.push(x);
  const len = dates.length;
  const prevDates = dates.map(x => addDays(x, -len));
  // Товары сравниваем по закрытым дням: неполное «сегодня» против полного дня занижало бы рост.
  const curTo = to === today && from < today ? addDays(today, -1) : to;
  const moverLen = (Date.parse(curTo) - Date.parse(from)) / DAY_MS + 1;
  const prevTo = addDays(from, -1), prevFrom = addDays(prevTo, -(moverLen - 1));

  const empty = () => dates.map(() => null as number | null);
  const res: RnpSummary = {
    ok: true, mp, from, to, dates,
    amount: empty(), after: empty(), cnt: empty(), ads: empty(),
    prevAmount: empty(), prevAfter: empty(), prevCnt: empty(),
    movers: { from, to: curTo, up: [], down: [] }, firstDate: null, collectedAt: null,
    excluded: { skus: [], amount: 0 },
  };
  const d = getDb();
  if (!d) return res;

  const since = [prevDates[0], prevFrom].sort()[0];
  const rows = d.prepare(`SELECT date, sku, metric, value FROM rnp_fact WHERE mp = ? AND date >= ? AND date <= ?
    AND metric IN ('ordered_amount', 'ordered_cnt', 'wbf_order_sum', 'wbf_order_cnt', 'adv_expenses', 'spp_base', 'spp_disc')`).all(mp, since, to) as Array<{ date: string; sku: string; metric: string; value: number }>;
  const items = new Map((d.prepare('SELECT sku, article, name, photo FROM rnp_item WHERE mp = ?').all(mp) as any[]).map(it => [String(it.sku), it]));

  // Настоящий товар — себестоимость заведена в «Складе». Решение кэшируем: артикулов сотни, строк — тысячи.
  const costs = getCosts();
  const realCache = new Map<string, boolean>();
  const isReal = (sku: string) => {
    let v = realCache.get(sku);
    if (v === undefined) { v = !!resolveCost(String(items.get(sku)?.article || sku), costs); realCache.set(sku, v); }
    return v;
  };
  // WB: дни, за которые есть заказы воронки, считаем по ней; остальные — по supplier/orders.
  const funnelDays = new Set(rows.filter(r => r.metric === 'wbf_order_sum').map(r => r.date));
  const metricOf = (r: { date: string; metric: string }): string | null => {
    if (mp !== 'wb') return r.metric;
    if (r.metric === 'wbf_order_sum') return 'ordered_amount';
    if (r.metric === 'wbf_order_cnt') return 'ordered_cnt';
    if ((r.metric === 'ordered_amount' || r.metric === 'ordered_cnt') && funnelDays.has(r.date)) return null;
    return r.metric;
  };

  const idx = new Map(dates.map((x, i) => [x, i]));
  const pidx = new Map(prevDates.map((x, i) => [x, i]));
  const add = (arr: Array<number | null>, i: number, v: number) => { arr[i] = (arr[i] ?? 0) + v; };
  const sppBase = new Map<string, number>(), sppDisc = new Map<string, number>();
  const cur = new Map<string, { cnt: number; rub: number }>();
  const prev = new Map<string, number>();
  const excluded = new Map<string, number>();
  for (const r0 of rows) {
    const metric = metricOf(r0);
    if (!metric) continue;
    const r = { ...r0, metric };
    const v = Number(r.value) || 0;
    if (!isReal(r.sku)) {
      if (metric === 'ordered_amount' && r.date >= from && v > 0) excluded.set(r.sku, (excluded.get(r.sku) ?? 0) + v);
      continue;
    }
    const i = idx.get(r.date), p = pidx.get(r.date);
    if (r.metric === 'ordered_amount') {
      if (i !== undefined) add(res.amount, i, v);
      if (p !== undefined) add(res.prevAmount, p, v);
      if (r.date >= from && r.date <= curTo) { const c = cur.get(r.sku) ?? { cnt: 0, rub: 0 }; c.rub += v; cur.set(r.sku, c); }
    } else if (r.metric === 'ordered_cnt') {
      if (i !== undefined) add(res.cnt, i, v);
      if (p !== undefined) add(res.prevCnt, p, v);
      if (r.date >= from && r.date <= curTo) { const c = cur.get(r.sku) ?? { cnt: 0, rub: 0 }; c.cnt += v; cur.set(r.sku, c); }
      if (r.date >= prevFrom && r.date <= prevTo) prev.set(r.sku, (prev.get(r.sku) ?? 0) + v);
    } else if (r.metric === 'adv_expenses') {
      if (i !== undefined) add(res.ads, i, v);
    } else if (r.metric === 'spp_base') {
      sppBase.set(r.date, (sppBase.get(r.date) ?? 0) + v);
    } else if (r.metric === 'spp_disc') {
      sppDisc.set(r.date, (sppDisc.get(r.date) ?? 0) + v);
    }
  }
  // После СПП: доля скидки площадки за день. Нет базы за день — не знаем, оставляем пусто.
  const afterOf = (date: string, amount: number | null) => {
    const base = sppBase.get(date);
    if (amount === null || !base) return null;
    return amount * (1 - Math.min(1, (sppDisc.get(date) ?? 0) / base));
  };
  dates.forEach((x, i) => { res.after[i] = afterOf(x, res.amount[i]); });
  prevDates.forEach((x, i) => { res.prevAfter[i] = afterOf(x, res.prevAmount[i]); });
  res.excluded = {
    skus: [...excluded.keys()].map(s => String(items.get(s)?.article || s)).sort(),
    amount: Math.round([...excluded.values()].reduce((s, v) => s + v, 0)),
  };

  const product = (sku: string): RnpSummaryProduct => {
    const it = items.get(sku);
    return {
      sku, article: it?.article || sku, name: it?.name || '', photo: it?.photo || '',
      cur: cur.get(sku)?.cnt ?? 0, prev: prev.get(sku) ?? 0, curRub: Math.round(cur.get(sku)?.rub ?? 0),
    };
  };
  const all = [...new Set([...cur.keys(), ...prev.keys()])].map(product);
  // Порог в 3 заказа отсекает шум: «1 → 2 заказа» — это +100 %, но не новость.
  res.movers.up = all.filter(p => p.cur > p.prev && p.cur >= 3).sort((a, b) => (b.cur - b.prev) - (a.cur - a.prev)).slice(0, 10);
  res.movers.down = all.filter(p => p.cur < p.prev && p.prev >= 3).sort((a, b) => (a.cur - a.prev) - (b.cur - b.prev)).slice(0, 10);
  res.firstDate = (d.prepare(`SELECT MIN(date) AS m FROM rnp_fact WHERE mp = ? AND metric = 'ordered_amount'`).get(mp) as { m?: string } | undefined)?.m ?? null;
  const at = metaGet(`collected:${mp}:sales`);
  res.collectedAt = at ? Number(at) : null;
  return res;
}
