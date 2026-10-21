/**
 * История финансов по дням (21.10.2026) — чтобы на главной можно было выбрать
 * в календаре любой период и увидеть расходы за него.
 *
 * Раньше финансы считал браузер «на лету» и только за 1/7/30 дней: отчёт WB
 * прогревается одним 30-дневным окном, начисления Ozon лежат в кэше неделями и
 * потом пропадают. Теперь каждый проход сборщика раскладывает их по дням в свою
 * базу (.av-cache/fin.sqlite), и история только растёт.
 *
 *   WB   — finance-api sales-reports/detailed, period=daily: свежее недельного,
 *          строки по дате операции (rrDate). Раз в 6 часов за последние 30 дней,
 *          один раз — догрузка с начала истории РНП.
 *   Ozon — v1/finance/accrual/by-day (кэш ozonAccruals): последние 7 дней каждым
 *          проходом, история — догрузкой по 15 дней за проход.
 *
 * Раскладка по статьям — те же buildWbFinance / buildOzonFinance, что считали
 * финсводку раньше, поэтому цифры не разъезжаются со старыми экранами.
 * Реклама здесь только «финансовая» (промо-начисления Ozon); основной расход
 * рекламы берётся из РНП (кампании WB и Ozon Performance по дням).
 */
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { mskDate } from './mskDate';
import { fetchWithRetry } from './fetchRetry';
import { normalizeWbFinanceRow, aggregateWbFinance } from '../../src/api/wbFinance';
import { buildWbFinance, buildOzonFinance } from '../../src/utils/financeLogic';

let DatabaseSync: any = null;
try { DatabaseSync = require('node:sqlite').DatabaseSync; } catch { DatabaseSync = null; }

const DB_DIR = process.env.CACHE_DIR || join(process.cwd(), '.av-cache');
const DAY_MS = 86_400_000;
/** С этой даты в РНП есть заказы — раньше финансы не догружаем. */
const HISTORY_START = '2026-09-12';
const WB_EVERY_MS = 6 * 60 * 60_000;

export type FinMp = 'wb' | 'ozon';
/** Статьи дня, ₽ (расходы — положительными числами). */
const METRICS = ['gross', 'net', 'commission', 'logistics', 'storage', 'other', 'ads_fin', 'units'] as const;

let db: any = null;
function getDb(): any | null {
  if (db) return db;
  if (!DatabaseSync) return null;
  try {
    mkdirSync(DB_DIR, { recursive: true });
    db = new DatabaseSync(join(DB_DIR, 'fin.sqlite'));
    db.exec(`
      CREATE TABLE IF NOT EXISTS fin_day (mp TEXT NOT NULL, date TEXT NOT NULL, metric TEXT NOT NULL, value REAL, PRIMARY KEY (mp, date, metric)) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS fin_units (mp TEXT NOT NULL, date TEXT NOT NULL, sku TEXT NOT NULL, units REAL, PRIMARY KEY (mp, date, sku)) WITHOUT ROWID;
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

type DayFin = { gross: number; net: number; commission: number; logistics: number; storage: number; other: number; ads_fin: number; units: number; unitsBySku: Record<string, number> };

/** Записать дни целиком: прежние значения дня заменяются (отчёт мог уточниться). */
function writeDays(mp: FinMp, days: Map<string, DayFin>): number {
  const d = getDb();
  if (!d || !days.size) return 0;
  const delDay = d.prepare('DELETE FROM fin_day WHERE mp = ? AND date = ?');
  const delUnits = d.prepare('DELETE FROM fin_units WHERE mp = ? AND date = ?');
  const putDay = d.prepare('INSERT INTO fin_day (mp, date, metric, value) VALUES (?, ?, ?, ?)');
  const putUnits = d.prepare('INSERT INTO fin_units (mp, date, sku, units) VALUES (?, ?, ?, ?)');
  d.exec('BEGIN');
  try {
    for (const [date, f] of days) {
      delDay.run(mp, date); delUnits.run(mp, date);
      for (const m of METRICS) putDay.run(mp, date, m, Math.round(f[m] * 100) / 100);
      for (const [sku, u] of Object.entries(f.unitsBySku)) if (u) putUnits.run(mp, date, sku.toUpperCase(), u);
    }
    d.exec('COMMIT');
  } catch (e) { d.exec('ROLLBACK'); throw e; }
  return days.size;
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

async function collectWb(): Promise<string> {
  const last = Number(metaGet('wb:fetched_at') ?? 0);
  const backfilled = metaGet('wb:backfill:v2') === '1';
  if (backfilled && Date.now() - last < WB_EVERY_MS) return 'WB: рано, раз в 6 ч';
  const from = backfilled ? mskDate(30) : HISTORY_START;
  const to = mskDate(0);
  const raw = await fetchWbDaily(from, to);
  const byDay = new Map<string, any[]>();
  let coveredTo = metaGet('wb:covered_to') ?? '';
  for (const r of raw) {
    const row = normalizeWbFinanceRow(r);
    const date = (row.rr_dt || row.sale_dt || '').slice(0, 10);
    if (!date) continue;
    (byDay.get(date) ?? byDay.set(date, []).get(date)!).push(row);
    if (date > coveredTo) coveredTo = date;
  }
  const days = new Map<string, DayFin>();
  for (const [date, rows] of byDay) {
    const t = aggregateWbFinance(rows);
    const f = buildWbFinance(t);
    // Комиссия WB = продажи − «к перечислению» по продажам и возвратам. В ней уже
    // эквайринг и компенсация СПП. Колонка ppvz_sales_commission, которую брала
    // старая сводка, — лишь часть вознаграждения: на 13–19.10 она дала 3 % от
    // выручки вместо реальных ~20 %.
    let forPay = 0;
    for (const r of rows) {
      if (r.doc_type_name === 'Продажа') forPay += r.ppvz_for_pay || 0;
      else if (r.doc_type_name === 'Возврат') forPay -= r.ppvz_for_pay || 0;
    }
    days.set(date, {
      gross: f.grossRevenue, net: f.netRevenue,
      commission: Math.max(0, t.netRevenue - forPay),
      logistics: t.deliveryTotal + t.rebillLogisticTotal,
      storage: f.storage, other: f.other, ads_fin: 0, units: f.unitsSold, unitsBySku: f.unitsBySku,
    });
  }
  const n = writeDays('wb', days);
  metaSet('wb:fetched_at', String(Date.now()));
  if (coveredTo) metaSet('wb:covered_to', coveredTo);
  if (!backfilled) metaSet('wb:backfill:v2', '1');
  return `WB: строк ${raw.length}, дней ${n}, отчёт по ${coveredTo || '—'}`;
}

// ─── Ozon ───────────────────────────────────────────────────────────────────
async function collectOzon(): Promise<string> {
  const { getLegacyOps, legacyTotals } = await import('./ozonAccruals');
  const { getSkuMap } = await import('./ozonShowcase');
  const skuMap = await getSkuMap().catch(() => ({} as Record<string, string>));
  const skuToOffer = new Map(Object.entries(skuMap).map(([k, v]) => [k, String(v).toUpperCase()]));
  const today = mskDate(0);
  // Свежие 7 дней — каждым проходом (начисления дня приезжают с опозданием),
  // история — по 15 дней за проход, пока не дойдём до начала РНП.
  const dates: string[] = [];
  for (let x = mskDate(6); x <= today; x = addDays(x, 1)) dates.push(x);
  let back = metaGet('ozon:backfill_to') ?? addDays(mskDate(6), -1);
  for (let k = 0; k < 15 && back >= HISTORY_START; k++, back = addDays(back, -1)) dates.push(back);
  const days = new Map<string, DayFin>();
  let failed = 0;
  for (const date of dates) {
    const { ops, failedDays } = await getLegacyOps(date, date);
    if (failedDays.length) { failed++; continue; }
    const f = buildOzonFinance({ result: legacyTotals(ops) } as any, ops as any, skuToOffer);
    days.set(date, {
      gross: f.grossRevenue, net: f.netRevenue, commission: f.commission, logistics: f.logistics,
      storage: f.storage, other: f.other, ads_fin: f.ads, units: f.unitsSold, unitsBySku: f.unitsBySku,
    });
  }
  const n = writeDays('ozon', days);
  metaSet('ozon:backfill_to', back);
  if (days.size) metaSet('ozon:covered_to', [...days.keys(), metaGet('ozon:covered_to') ?? ''].sort().at(-1)!);
  return `Ozon: дней ${n}${failed ? `, не открылись ${failed}` : ''}, история с ${back < HISTORY_START ? HISTORY_START : addDays(back, 1)}`;
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
  gross: number; net: number; commission: number; logistics: number; storage: number; other: number; adsFin: number; units: number;
  /** Себестоимость проданного по таблице «Склад»; товары без неё — в missing. */
  cogs: number; missing: string[];
};

/** Финансы площадки за [from, to] из накопленной истории. */
export async function getFinRange(mp: FinMp, from: string, to: string): Promise<FinRange> {
  const total = (Date.parse(to) - Date.parse(from)) / DAY_MS + 1;
  const out: FinRange = { days: 0, total, coveredTo: metaGet(`${mp}:covered_to`), gross: 0, net: 0, commission: 0, logistics: 0, storage: 0, other: 0, adsFin: 0, units: 0, cogs: 0, missing: [] };
  const d = getDb();
  if (!d) return out;
  const rows = d.prepare('SELECT date, metric, value FROM fin_day WHERE mp = ? AND date >= ? AND date <= ?').all(mp, from, to) as Array<{ date: string; metric: string; value: number }>;
  const seen = new Set<string>();
  const key: Record<string, keyof FinRange> = { gross: 'gross', net: 'net', commission: 'commission', logistics: 'logistics', storage: 'storage', other: 'other', ads_fin: 'adsFin', units: 'units' };
  for (const r of rows) {
    seen.add(r.date);
    const k = key[r.metric];
    if (k) (out as any)[k] += Number(r.value) || 0;
  }
  out.days = seen.size;
  const units = d.prepare('SELECT sku, SUM(units) AS u FROM fin_units WHERE mp = ? AND date >= ? AND date <= ? GROUP BY sku').all(mp, from, to) as Array<{ sku: string; u: number }>;
  const { getCost } = await import('./costs');
  for (const { sku, u } of units) {
    if (!(u > 0)) continue;
    const c = getCost(sku);
    if (c && c > 0) out.cogs += c * u; else out.missing.push(sku);
  }
  return out;
}
