// Ozon Finance API — реальные финансовые транзакции (после возвратов и комиссий).
// Используется те же креды что и для Seller API (Client-Id + Api-Key из .env),
// идёт через vite-прокси /ozon/* → api-seller.ozon.ru.
import { noteSwallowed } from '../utils/log';

const PROXY_BASE = '/ozon';

async function ozonFetch<T>(path: string, body: any): Promise<T> {
  const res = await fetch(PROXY_BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    if (res.status === 503 && text.includes('warming_up')) {
      throw new Error('Данные ещё загружаются фоновым сборщиком — обновятся автоматически.');
    }
    throw new Error(`Ozon ${res.status}: ${text.slice(0, 240)}`);
  }
  return res.json() as Promise<T>;
}

// ─── /v3/finance/transaction/totals ────────────────────────────────────────
// Возвращает сводные суммы по типам операций за период.
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
  return ozonFetch<OzonFinTotals>('/v3/finance/transaction/totals', {
    date: { from: fromISO, to: toISO },
    posting_number: '',
    transaction_type: 'all',
  });
}

// ─── /v3/finance/transaction/list ──────────────────────────────────────────
// Детальный список операций — для drill-down (откуда взялась цифра).
export type OzonFinOperation = {
  operation_id: number;
  operation_type: string;          // OperationAgentDeliveredToCustomer / OperationItemReturn / OperationMarketplaceServiceItemAdvertisingCharge / ...
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

export async function ozonFinanceList(
  fromISO: string,
  toISO: string,
  opts: { page?: number; pageSize?: number; operationTypes?: string[]; transactionType?: 'all' | 'orders' | 'returns' | 'services' | 'compensation' | 'transferDelivery' | 'other' } = {},
): Promise<OzonFinList> {
  return ozonFetch<OzonFinList>('/v3/finance/transaction/list', {
    filter: {
      date: { from: fromISO, to: toISO },
      operation_type: opts.operationTypes || [],
      posting_number: '',
      transaction_type: opts.transactionType || 'all',
    },
    page: opts.page ?? 1,
    page_size: opts.pageSize ?? 1000,
  });
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

export async function ozonFinanceTotalsCached(fromISO: string, toISO: string, force = false) {
  const path = '/v3/finance/transaction/totals';
  const body = { date: { from: fromISO, to: toISO }, posting_number: '', transaction_type: 'all' };
  const cached = readFinCache<OzonFinTotals>(path, body);
  if (!force && cached && Date.now() - cached.fetchedAt < cached.ttlMs) {
    return { data: cached.data, fromCache: true, fetchedAt: cached.fetchedAt };
  }
  const data = await ozonFinanceTotals(fromISO, toISO);
  const payload: Cached<OzonFinTotals> = { data, fetchedAt: Date.now(), ttlMs: DEFAULT_TTL };
  try { localStorage.setItem(cacheKey(path, body), JSON.stringify(payload)); }
  catch (e) { noteSwallowed('ozon-finance', 'ответ не закэширован', e); }
  return { data, fromCache: false, fetchedAt: payload.fetchedAt };
}

export async function ozonFinanceListCached(
  fromISO: string,
  toISO: string,
  opts: { pageSize?: number; operationTypes?: string[]; transactionType?: any } = {},
  force = false,
) {
  const path = '/v3/finance/transaction/list:all';
  const body = {
    filter: { date: { from: fromISO, to: toISO }, operation_type: opts.operationTypes || [], posting_number: '', transaction_type: opts.transactionType || 'all' },
    page_size: opts.pageSize ?? 1000,
  };
  const cached = readFinCache<OzonFinList>(path, body);
  if (!force && cached && Date.now() - cached.fetchedAt < cached.ttlMs) {
    return { data: cached.data, fromCache: true, fetchedAt: cached.fetchedAt };
  }
  // Постранично — Ozon отдаёт максимум 1000 операций за запрос.
  // Цикл по страницам пока не выберем все row_count.
  const pageSize = opts.pageSize ?? 1000;
  const allOps: OzonFinOperation[] = [];
  let page = 1;
  let totalRows = 0;
  let pageCount = 1;
  while (page <= pageCount) {
    const r = await ozonFinanceList(fromISO, toISO, { ...opts, page, pageSize });
    allOps.push(...(r.result.operations || []));
    totalRows = r.result.row_count;
    pageCount = r.result.page_count;
    page++;
    if (page > 50) break; // safety: max 50 страниц = 50k операций
  }
  const data: OzonFinList = { result: { operations: allOps, page_count: pageCount, row_count: totalRows } };
  const payload: Cached<OzonFinList> = { data, fetchedAt: Date.now(), ttlMs: DEFAULT_TTL };
  try { localStorage.setItem(cacheKey(path, body), JSON.stringify(payload)); }
  catch (e) { noteSwallowed('ozon-finance', 'ответ не закэширован', e); }
  return { data, fromCache: false, fetchedAt: payload.fetchedAt };
}
