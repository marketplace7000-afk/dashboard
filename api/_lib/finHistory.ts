/**
 * История финансов по дням и артикулам (21.10.2026, переделано 22.10) — чтобы на
 * главной можно было выбрать в календаре любой период и увидеть расходы за него.
 *
 * Раньше финансы считал браузер «на лету» и только за 1/7/30 дней: отчёт WB
 * прогревается одним 30-дневным окном, начисления Ozon лежат в кэше неделями и
 * потом пропадают. Теперь каждый проход сборщика раскладывает их по дням и
 * артикулам в свою базу (.av-cache/fin-sku.sqlite), и история только растёт.
 *
 * Единый формат для обеих площадок (замечание владельца 22.10):
 *   выручка  — по цене продавца, ДО СПП / соинвеста: WB — retailPriceWithDisc × шт
 *              (retailAmount в отчёте — уже после СПП), Ozon — sale_amount начисления;
 *   комиссия — всё, что площадка удержала с этой цены, кроме логистики:
 *              WB — выручка до СПП − «к перечислению», Ozon — commission начисления.
 * По артикулам — чтобы считать только настоящие товары (себестоимость заведена в
 * «Складе»), а товары для выкупов не учитывать. Удержания без артикула (хранение,
 * штрафы, подписки) лежат под пустым артикулом и входят в итог всегда.
 *
 *   WB   — finance-api sales-reports/detailed, period=daily, строки по дате операции.
 *          Раз в 6 часов за последние 30 дней, один раз — догрузка с 12.09.
 *   Ozon — v1/finance/accrual/by-day (кэш ozonAccruals): последние 7 дней каждым
 *          проходом, история — догрузкой по 15 дней за проход.
 * Реклама здесь — только то, чего нет в РНП (у Ozon: ускоренный сбор отзывов и
 * прочие начисления за продвижение). Оплата кампаний (WB «Продвижение», Ozon
 * PayPerClick) пропускается: её расход берётся из РНП, иначе он учёлся бы дважды.
 */
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { mskDate } from './mskDate';
import { fetchWithRetry } from './fetchRetry';
import { resolveCost, getCosts } from './costs';
import { normalizeWbFinanceRow } from '../../src/api/wbFinance';

let DatabaseSync: any = null;
try { DatabaseSync = require('node:sqlite').DatabaseSync; } catch { DatabaseSync = null; }

const DB_DIR = process.env.CACHE_DIR || join(process.cwd(), '.av-cache');
const DAY_MS = 86_400_000;
/** С этой даты в РНП есть заказы — раньше финансы не догружаем. */
const HISTORY_START = '2026-09-12';
const WB_EVERY_MS = 6 * 60 * 60_000;

export type FinMp = 'wb' | 'ozon';
/** Статьи, ₽ (расходы — положительными, доход в «прочем» — отрицательным). units — штуки. */
const METRICS = ['rev', 'commission', 'logistics', 'storage', 'other', 'ads_fin', 'units'] as const;
type Metric = typeof METRICS[number];
type SkuFin = Record<Metric, number>;
/** дата → артикул (UPPER, '' — без артикула) → статьи. */
type DayFacts = Map<string, Map<string, SkuFin>>;

let db: any = null;
function getDb(): any | null {
  if (db) return db;
  if (!DatabaseSync) return null;
  try {
    mkdirSync(DB_DIR, { recursive: true });
    db = new DatabaseSync(join(DB_DIR, 'fin-sku.sqlite'));
    db.exec(`
      CREATE TABLE IF NOT EXISTS fin_fact (mp TEXT NOT NULL, date TEXT NOT NULL, sku TEXT NOT NULL, metric TEXT NOT NULL, value REAL,
        PRIMARY KEY (mp, date, sku, metric)) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS fin_meta (key TEXT PRIMARY KEY, value TEXT);
    `);
    return db;
  } catch (e) {
    console.warn('[fin] sqlite init failed:', (e as Error).message);
    return null;
  }
}
const metaGet = (k: string): string | null => (getDb()?.prepare('SELECT value FROM fin_meta WHERE key = ?').get(k) as any)?.value ?? null;
const metaSet = (k: string, v: string) => getDb()?.prepare('INSERT OR REPLACE INTO fin_meta (key, value) VALUES (?, ?)').run(k, v);
const addDays = (date: string, n: number) => new Date(Date.parse(date + 'T00:00:00Z') + n * DAY_MS).toISOString().slice(0, 10);

function bump(facts: DayFacts, date: string, sku: string, m: Metric, v: number): void {
  if (!v) return;
  let day = facts.get(date);
  if (!day) facts.set(date, day = new Map());
  const key = sku.trim().toUpperCase();
  let f = day.get(key);
  if (!f) day.set(key, f = { rev: 0, commission: 0, logistics: 0, storage: 0, other: 0, ads_fin: 0, units: 0 });
  f[m] += v;
}

/** Записать дни целиком: прежние значения дня заменяются (отчёт мог уточниться). */
function writeDays(mp: FinMp, facts: DayFacts): number {
  const d = getDb();
  if (!d || !facts.size) return 0;
  const del = d.prepare('DELETE FROM fin_fact WHERE mp = ? AND date = ?');
  const put = d.prepare('INSERT INTO fin_fact (mp, date, sku, metric, value) VALUES (?, ?, ?, ?, ?)');
  d.exec('BEGIN');
  try {
    for (const [date, bySku] of facts) {
      del.run(mp, date);
      for (const [sku, f] of bySku) for (const m of METRICS) if (f[m]) put.run(mp, date, sku, m, Math.round(f[m] * 100) / 100);
    }
    d.exec('COMMIT');
  } catch (e) { d.exec('ROLLBACK'); throw e; }
  return facts.size;
}

// ─── WB ─────────────────────────────────────────────────────────────────────
async function fetchWbDaily(from: string, to: string): Promise<any[]> {
  const token = process.env.WB_TOKEN ?? '';
  if (!token) throw new Error('нет WB_TOKEN');
  const res = await fetchWithRetry('https://finance-api.wildberries.ru/api/finance/v1/sales-reports/detailed', {
    method: 'POST', headers: { Authorization: token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ dateFrom: from, dateTo: to, limit: 100000, rrdId: 0, period: 'daily' }),
  }, { maxRetries: 3, timeoutMs: 90_000 });
  if (res.status === 204) return [];
  if (!res.ok) throw new Error(`финотчёт WB → ${res.status}`);
  const rows = await res.json().catch(() => []);
  return Array.isArray(rows) ? rows : [];
}

/** Разложить строки финотчёта WB по дням и артикулам (выручка — до СПП). */
export function wbRowsToFacts(raw: any[]): { facts: DayFacts; coveredTo: string } {
  const facts: DayFacts = new Map();
  let coveredTo = '';
  for (const x of raw) {
    const r = normalizeWbFinanceRow(x);
    const date = (r.rr_dt || r.sale_dt || '').slice(0, 10);
    if (!date) continue;
    if (date > coveredTo) coveredTo = date;
    const sku = r.sa_name || '';
    const sign = r.doc_type_name === 'Продажа' ? 1 : r.doc_type_name === 'Возврат' ? -1 : 0;
    if (sign) {
      const q = r.quantity || 0;
      const rev = sign * (r.retail_price_withdisc_rub || 0) * q;
      bump(facts, date, sku, 'rev', rev);
      bump(facts, date, sku, 'units', sign * q);
      // Удержано WB с цены продавца = цена до СПП − «к перечислению». СПП WB платит из своего
      // вознаграждения, поэтому эта разница и есть комиссия с эквайрингом, как у Ozon.
      bump(facts, date, sku, 'commission', rev - sign * (r.ppvz_for_pay || 0));
    }
    bump(facts, date, sku, 'logistics', (r.delivery_rub || 0) + (r.rebill_logistic_cost || 0));
    bump(facts, date, sku, 'storage', r.storage_fee || 0);
    // Удержание «Оказание услуг WB Продвижение» — оплата рекламных кампаний, она уже
    // учтена расходом кампаний из РНП (15–21.10: 106 505 ₽ здесь и 116 310 ₽ там).
    const promo = /продвижени/i.test(String(x?.bonusTypeName ?? ''));
    // additional_payment бывает доходом: вычитаем со знаком (как в buildWbFinance).
    bump(facts, date, sku, 'other', (r.penalty || 0) + (r.acceptance || 0) + (promo ? 0 : r.deduction || 0) - (r.additional_payment || 0));
  }
  return { facts, coveredTo };
}

async function collectWb(): Promise<string> {
  const last = Number(metaGet('wb:fetched_at') ?? 0);
  const backfilled = metaGet('wb:backfill:v2') === '1';
  if (backfilled && Date.now() - last < WB_EVERY_MS) return 'WB: рано, раз в 6 ч';
  const from = backfilled ? mskDate(30) : HISTORY_START;
  const raw = await fetchWbDaily(from, mskDate(0));
  const { facts, coveredTo } = wbRowsToFacts(raw);
  const n = writeDays('wb', facts);
  metaSet('wb:fetched_at', String(Date.now()));
  const prevCovered = metaGet('wb:covered_to') ?? '';
  if (coveredTo > prevCovered) metaSet('wb:covered_to', coveredTo);
  if (!backfilled) metaSet('wb:backfill:v2', '1');
  return `WB: строк ${raw.length}, дней ${n}, отчёт по ${coveredTo || prevCovered || '—'}`;
}

// ─── Ozon ───────────────────────────────────────────────────────────────────
async function collectOzon(): Promise<string> {
  const { getAccrualsForDay, getAccrualTypes, groupOfType } = await import('./ozonAccruals');
  const { getSkuMap } = await import('./ozonShowcase');
  const skuMap = await getSkuMap().catch(() => ({} as Record<string, string>));
  // Числовой SKU без артикула в карте не найдёт себестоимость и попадёт в «не учтены» —
  // лучше показать его там, чем молча смешать с общими удержаниями.
  const offerOf = (sku: unknown) => {
    const s = String(sku ?? '').trim();
    return s ? String(skuMap[s] ?? `SKU ${s}`) : '';
  };
  const types = await getAccrualTypes();
  const n = (m: any) => { const v = Number(m?.amount ?? 0); return Number.isFinite(v) ? v : 0; };
  const today = mskDate(0);
  // Свежие 7 дней — каждым проходом (начисления дня приезжают с опозданием),
  // история — по 15 дней за проход, пока не дойдём до начала РНП.
  const dates: string[] = [];
  for (let x = mskDate(6); x <= today; x = addDays(x, 1)) dates.push(x);
  let back = metaGet('ozon:backfill_to:v2') ?? addDays(mskDate(6), -1);
  for (let k = 0; k < 15 && back >= HISTORY_START; k++, back = addDays(back, -1)) dates.push(back);
  const facts: DayFacts = new Map();
  let failed = 0;
  for (const date of dates) {
    let list;
    try { list = await getAccrualsForDay(date); } catch { failed++; continue; }
    // День без начислений тоже записываем: иначе он считался бы «нет данных».
    if (!facts.has(date)) facts.set(date, new Map());
    for (const a of list) {
      const products = a.posting?.products ?? [];
      const sold = products.filter(p => p.commission);
      if (sold.length) {
        for (const p of products) {
          const sku = offerOf(p.sku);
          const rev = n(p.commission?.sale_amount ?? p.commission?.seller_price);
          bump(facts, date, sku, 'rev', rev);
          bump(facts, date, sku, 'commission', -n(p.commission?.commission ?? p.commission?.sale_commission));
          bump(facts, date, sku, 'logistics', -(p.delivery?.services ?? []).reduce((s, x) => s + n(x.accrued), 0));
          if (p.commission) bump(facts, date, sku, 'units', Math.sign(rev) * (Number(p.quantity) || 1));
        }
        continue;
      }
      // Без продажи: статью определяет самая крупная строка начисления (как в ozonAccruals).
      const fees: Array<{ type_id: number; accrued?: any }> = [];
      const walk = (node: unknown) => {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) { node.forEach(walk); return; }
        const o = node as Record<string, unknown>;
        if (typeof o.type_id === 'number' && o.accrued) { fees.push(o as any); return; }
        Object.values(o).forEach(walk);
      };
      walk(a.posting); walk(a.item_fees); walk(a.non_item_fee); walk(a.container_fees);
      const main = fees.slice().sort((x, y) => Math.abs(n(y.accrued)) - Math.abs(n(x.accrued)))[0];
      const typeName = main ? types.get(main.type_id)?.name ?? '' : '';
      // «Оплата за клик» — это кампании Ozon Performance, их расход уже берётся из РНП
      // (15–21.10: 241 868 ₽ здесь), второй раз не считаем.
      if (typeName === 'PayPerClick') continue;
      const group = groupOfType(typeName);
      const sku = offerOf(products[0]?.sku ?? a.item_fees?.fees?.[0]?.sku);
      const cost = -n(a.total_amount);
      const m: Metric = group === 'logistics' || group === 'packaging' || group === 'returnLogistics' ? 'logistics'
        : group === 'acquiring' ? 'commission'
        : group === 'ads' ? 'ads_fin'
        : group === 'storage' ? 'storage'
        : 'other';
      bump(facts, date, sku, m, cost);
    }
  }
  const written = writeDays('ozon', facts);
  metaSet('ozon:backfill_to:v2', back);
  const covered = [...facts.keys(), metaGet('ozon:covered_to') ?? ''].sort().at(-1)!;
  if (covered) metaSet('ozon:covered_to', covered);
  return `Ozon: дней ${written}${failed ? `, не открылись ${failed}` : ''}, история с ${back < HISTORY_START ? HISTORY_START : addDays(back, 1)}`;
}

/** Для сборщика: дописать историю по обеим площадкам. */
export async function collectFinHistory(): Promise<string> {
  if (!getDb()) return 'финистория: база недоступна (нужен Node 22.5+)';
  const out: string[] = [];
  for (const [name, fn] of [['WB', collectWb], ['Ozon', collectOzon]] as const) {
    try { out.push(await fn()); } catch (e) { out.push(`${name}: ${(e as Error).message.slice(0, 120)}`); }
  }
  return out.join(' · ');
}

export type FinRange = {
  /** Дней с данными из дней периода. */
  days: number; total: number;
  coveredTo: string | null;
  /** Выручка после возвратов по цене продавца (до СПП). */
  rev: number; commission: number; logistics: number; storage: number; other: number; adsFin: number; units: number;
  /** Себестоимость проданного по таблице «Склад». */
  cogs: number;
  /** Не учтены — артикулы без себестоимости в «Складе» (товары для выкупов) и их выручка. */
  excluded: { skus: string[]; rev: number };
};

/** Финансы площадки за [from, to] из накопленной истории — только настоящие товары. */
export function getFinRange(mp: FinMp, from: string, to: string): FinRange {
  const total = (Date.parse(to) - Date.parse(from)) / DAY_MS + 1;
  const out: FinRange = { days: 0, total, coveredTo: metaGet(`${mp}:covered_to`), rev: 0, commission: 0, logistics: 0, storage: 0, other: 0, adsFin: 0, units: 0, cogs: 0, excluded: { skus: [], rev: 0 } };
  const d = getDb();
  if (!d) return out;
  const rows = d.prepare('SELECT date, sku, metric, value FROM fin_fact WHERE mp = ? AND date >= ? AND date <= ?').all(mp, from, to) as Array<{ date: string; sku: string; metric: Metric; value: number }>;
  const days = (d.prepare('SELECT COUNT(DISTINCT date) AS n FROM fin_fact WHERE mp = ? AND date >= ? AND date <= ?').get(mp, from, to) as any)?.n ?? 0;
  out.days = Number(days) || 0;
  const costs = getCosts();
  const cost = new Map<string, number | null>();
  const costOf = (sku: string) => {
    if (!cost.has(sku)) cost.set(sku, resolveCost(sku, costs)?.cost ?? null);
    return cost.get(sku)!;
  };
  const key: Record<Metric, keyof FinRange> = { rev: 'rev', commission: 'commission', logistics: 'logistics', storage: 'storage', other: 'other', ads_fin: 'adsFin', units: 'units' };
  const unitsBySku = new Map<string, number>();
  const fake = new Set<string>();
  for (const r of rows) {
    const v = Number(r.value) || 0;
    // Без артикула — общие удержания (хранение, штрафы): входят всегда.
    if (r.sku && costOf(r.sku) === null) {
      if (r.metric === 'rev' && v) { fake.add(r.sku); out.excluded.rev += v; }
      continue;
    }
    (out as any)[key[r.metric]] += v;
    if (r.metric === 'units' && r.sku) unitsBySku.set(r.sku, (unitsBySku.get(r.sku) ?? 0) + v);
  }
  for (const [sku, u] of unitsBySku) if (u > 0) out.cogs += u * (costOf(sku) ?? 0);
  out.excluded.skus = [...fake].sort();
  out.excluded.rev = Math.round(out.excluded.rev);
  return out;
}
