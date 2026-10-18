// Ozon Finance — реальные финансовые операции (после возвратов и комиссий).
// 18.10.2026: Ozon отключил v3/finance/transaction/totals и /list (08.09.2026,
// теперь 404) — экраны месяц показывали кэш от 08.09. Теперь сервер собирает
// начисления v1/finance/accrual/by-day по дням и отдаёт их в прежнем формате
// через /api/ozon-finance (см. api/_lib/ozonAccruals.ts). Типы ниже — прежние.
import { noteSwallowed } from '../utils/log';

type RangeResp = { ok: boolean; totals: OzonFinTotals; list: OzonFinList; failedDays?: string[]; error?: string };

// Дата YYYY-MM-DD по Москве: принимаем и готовую дату, и ISO-момент.
function toMskDay(v: string): string {
  if (/^d{4}-d{2}-d{2}$/.test(v)) return v;
  return new Date(Date.parse(v) + 3 * 3_600_000).toISOString().slice(0, 10);
}

// Totals и list приходят одним ответом — параллельные вызовы склеиваем.
const inflight = new Map<string, Promise<RangeResp>>();
function ozonFinanceRange(from: string, to: string): Promise<RangeResp> {
  const f = toMskDay(from), t = toMskDay(to);
  const key = f + '|' + t;
  const running = inflight.get(key);
  if (running) return running;
  const p = (async () => {
    const res = await fetch(`/api/ozon-finance?from=${f}&to=${t}`, { credentials: 'include' });
    const text = await res.text().catch(() => '');
    if (!res.ok) throw new Error(`Ozon ${res.status}: ${text.slice(0, 240)}`);
    return JSON.parse(text) as RangeResp;
  })().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

// ─── Итоги за период (формат бывшего v3/finance/transaction/totals) ─────────
export type OzonFinTotals = {
  result: {
    accruals_for_sale: number;          // выручка от продаж
    sale_commission: number;             // комиссия маркетплейса
    processing_and_delivery: number;     // обработка и доставка (фулфилмент)
    refunds_and_cancellations: number;   // возвраты и отмены
    services_amount: number;             // сервисы (реклама, бейджи и т.п.)
    compensation_amount: number;         // компенсации
    money_transfer: number;              // перевод средств
    others_amount: number;               // прочее
  };
};

export async function ozonFinanceTotals(fromISO: string, toISO: string): Promise<OzonFinTotals> {
  return (await ozonFinanceRange(fromISO, toISO)).totals;
}

// ─── Операции за период (формат бывшего v3/finance/transaction/list) ───────
// Детальный список — для drill-down (откуда взялась цифра). operation_type —
// старый код, где есть аналог, иначе «Группа:ИмяТипа» (Delivery:…, Advertising:…).
export type OzonFinOperation = {
  operation_id: number;
  operation_type: string;          // OperationAgentDeliveredToCustomer / OperationItemReturn / Delivery:LastMileCourier / Advertising:PayPerClick / ...
  operation_type_name: string;     // человекочитаемое название
  operation_date: string;
  delivery_charge: number;
  return_delivery_charge: number;
  accruals_for_sale: number;
  sale_commission: number;
  amount: number;                  // итог по операции
  type: string;                    // orders / returns / services / compensation / transferDelivery / other
  posting?: { delivery_schema?: string; order_date?: string; posting_number?: string; warehouse_id?: number };
  items?: Array<{ name?: string; sku?: number }>;
  services?: Array<{ name?: string; price: number }>;
};

export type OzonFinList = {
  result: {
    operations: OzonFinOperation[];
    page_count: number;
    row_count: number;
  };
};

export async function ozonFinanceList(fromISO: string, toISO: string): Promise<OzonFinList> {
  return (await ozonFinanceRange(fromISO, toISO)).list;
}

// ─── Утилиты ───────────────────────────────────────────────────────────────
export function toIso(d: Date): string {
  return d.toISOString();
}
export function daysAgoIso(n: number, endOfDay = false): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  if (endOfDay) d.setHours(23, 59, 59, 999);
  else d.setHours(0, 0, 0, 0);
  return d.toISOString();
}
export function dateToIsoStart(dateStr: string): string {
  // dateStr формата YYYY-MM-DD
  return new Date(dateStr + 'T00:00:00.000Z').toISOString();
}
export function dateToIsoEnd(dateStr: string): string {
  return new Date(dateStr + 'T23:59:59.999Z').toISOString();
}
export function isoToShort(iso: string): string {
  return iso.slice(0, 10);
}

// Группировка операций по operation_type для разбивки
export function groupOperationsByType(ops: OzonFinOperation[]): Array<{ type: string; name: string; sum: number; count: number }> {
  const map = new Map<string, { name: string; sum: number; count: number }>();
  for (const op of ops) {
    const cur = map.get(op.operation_type) || { name: op.operation_type_name || op.operation_type, sum: 0, count: 0 };
    cur.sum += op.amount || 0;
    cur.count += 1;
    map.set(op.operation_type, cur);
  }
  return Array.from(map.entries())
    .map(([type, v]) => ({ type, name: v.name, sum: v.sum, count: v.count }))
    .sort((a, b) => a.sum - b.sum); // от минуса (расходы) к плюсу (доходы)
}

// Группировка по транзакционному type (orders/returns/services/...)
export function groupOperationsByTxnType(ops: OzonFinOperation[]): Record<string, { sum: number; count: number }> {
  const m: Record<string, { sum: number; count: number }> = {};
  for (const op of ops) {
    const key = op.type || 'other';
    if (!m[key]) m[key] = { sum: 0, count: 0 };
    m[key].sum += op.amount || 0;
    m[key].count += 1;
  }
  return m;
}

// localStorage TTL-кэш
const CACHE_PREFIX = 'av_ozon_fin_cache_';
const DEFAULT_TTL = 30 * 60_000;

type Cached<T> = { data: T; fetchedAt: number; ttlMs: number };

function cacheKey(path: string, body: any): string {
  return CACHE_PREFIX + path + ':' + JSON.stringify(body).slice(0, 200);
}

export function readFinCache<T>(path: string, body: any): Cached<T> | null {
  try {
    const raw = localStorage.getItem(cacheKey(path, body));
    return raw ? JSON.parse(raw) as Cached<T> : null;
  } catch { return null; }
}

export function clearFinCache() {
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const k = localStorage.key(i);
    if (k && k.startsWith(CACHE_PREFIX)) localStorage.removeItem(k);
  }
}

// Ключи кэша — новые: под старыми (/v3/...) в браузерах лежат цифры от 08.09.
const TOTALS_PATH = '/api/ozon-finance:totals';
const LIST_PATH = '/api/ozon-finance:list';
export function finCacheBody(fromISO: string, toISO: string) {
  return { from: toMskDay(fromISO), to: toMskDay(toISO) };
}

export function readFinTotalsCache(fromISO: string, toISO: string) {
  return readFinCache<OzonFinTotals>(TOTALS_PATH, finCacheBody(fromISO, toISO));
}
export function readFinListCache(fromISO: string, toISO: string) {
  return readFinCache<OzonFinList>(LIST_PATH, finCacheBody(fromISO, toISO));
}

async function cachedPart<T>(path: string, fromISO: string, toISO: string, force: boolean, pick: (r: RangeResp) => T) {
  const body = finCacheBody(fromISO, toISO);
  const cached = readFinCache<T>(path, body);
  if (!force && cached && Date.now() - cached.fetchedAt < cached.ttlMs) {
    return { data: cached.data, fromCache: true, fetchedAt: cached.fetchedAt };
  }
  const data = pick(await ozonFinanceRange(fromISO, toISO));
  const payload: Cached<T> = { data, fetchedAt: Date.now(), ttlMs: DEFAULT_TTL };
  try { localStorage.setItem(cacheKey(path, body), JSON.stringify(payload)); }
  catch (e) { noteSwallowed('ozon-finance', 'ответ не закэширован', e); }
  return { data, fromCache: false, fetchedAt: payload.fetchedAt };
}

export function ozonFinanceTotalsCached(fromISO: string, toISO: string, force = false) {
  return cachedPart(TOTALS_PATH, fromISO, toISO, force, r => r.totals);
}

export function ozonFinanceListCached(fromISO: string, toISO: string, force = false) {
  return cachedPart(LIST_PATH, fromISO, toISO, force, r => r.list);
}
