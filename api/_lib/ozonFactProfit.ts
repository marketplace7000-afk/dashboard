// Факт-прибыль Ozon из РЕАЛЬНЫХ финансовых операций (как считает КАН) — вместо
// прогноза по тарифам. Источник: начисления v1/finance/accrual/by-day за последние
// 30 дней (ozonAccruals). До 18.10.2026 здесь был v3/finance/transaction/list —
// Ozon отключил его 08.09.2026, и факт месяц стоял на данных от 08.09.
//
// По каждой продаже (начисление POSTING с posting.products[].commission и
// положительной sale_amount), по каждому товару отправления:
//   commission.sale_amount — выручка продавца (≈ цена продавца)
//   commission.commission  — комиссия Ozon (отрицательная)
//   delivery.services[]    — логистика доставки этого товара (отрицательные)
//   выплата                — total_amount начисления; если товаров в отправлении
//                            несколько — выручка − комиссия − логистика товара
//
// ВАЖНО: выплата НЕ включает склад/рекламу/эквайринг — Ozon проводит их отдельными
// операциями, не привязанными к SKU. Поэтому это «начислено за продажу», а не
// полная чистая выплата (её КАН аллоцирует эвристикой). Реальны здесь комиссия и
// логистика доставки — их и показываем как факт против прогноза по тарифам.
//
// Агрегируем по offer_id (Ozon sku из транзакции → offer_id через sources[].sku).
// Отдаём средние на единицу. Кэш 6ч — финотчёт обновляется раз в сутки.

import { fetchWithRetry } from './fetchRetry';
import { cacheGet, cacheSet, isFresh } from './cache';
import { getAccrualsForDay, datesBetween } from './ozonAccruals';
import { mskDate } from './mskDate';

const BASE = 'https://api-seller.ozon.ru';
const CACHE_KEY = 'ozon-fact-profit:v1';
const TTL_MS = 6 * 60 * 60_000;

export type OzonFactRow = {
  units: number;      // сколько продаж учтено
  revenue: number;    // средняя выручка/шт (accruals_for_sale)
  commission: number; // средняя комиссия/шт (₽, положит.)
  logistic: number;   // средняя логистика+услуги/шт (₽, положит.)
  payout: number;     // средняя выплата Ozon/шт (amount) — «как у КАН»
};

export type OzonFactProfit = {
  items: Record<string, OzonFactRow>; // offer_id (UPPER) → факт
  count: number;
  from: string;
  fetchedAt: number;
};

function ozHeaders(): Record<string, string> {
  return {
    'Client-Id': process.env.OZON_CLIENT_ID ?? '',
    'Api-Key': process.env.OZON_API_KEY ?? '',
    'Content-Type': 'application/json',
  };
}

async function ozReq(path: string, body?: unknown, method: 'GET' | 'POST' = 'POST'): Promise<any> {
  const res = await fetchWithRetry(
    `${BASE}/${path}`,
    { method, headers: ozHeaders(), body: body !== undefined ? JSON.stringify(body) : undefined },
    { maxRetries: 2, timeoutMs: 40_000 },
  );
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`ozon ${path} → ${res.status} ${txt.slice(0, 200)}`);
  }
  return res.json();
}

// Ozon sku (число) → offer_id (UPPER). Берём из sources[].sku и верхнего sku.
async function buildSkuMap(): Promise<Record<string, string>> {
  const pids: number[] = [];
  let lastId = '';
  for (let page = 0; page < 10; page++) {
    const pl = await ozReq('v3/product/list', { filter: { visibility: 'ALL' }, last_id: lastId, limit: 1000 });
    const items: any[] = pl?.result?.items ?? [];
    for (const it of items) if (it?.product_id) pids.push(it.product_id);
    lastId = pl?.result?.last_id ?? '';
    if (!lastId || items.length < 1000) break;
  }
  const map: Record<string, string> = {};
  for (let i = 0; i < pids.length; i += 1000) {
    const info = await ozReq('v3/product/info/list', { product_id: pids.slice(i, i + 1000) });
    for (const it of (info?.items ?? [])) {
      const offer = String(it?.offer_id ?? '').toUpperCase();
      if (!offer) continue;
      if (it?.sku) map[String(it.sku)] = offer;
      for (const s of (it?.sources ?? [])) if (s?.sku) map[String(s.sku)] = offer;
    }
  }
  return map;
}

function isoDaysAgo(days: number): string {
  // Без Date.now() в проде нельзя — но это серверный код (Node), Date доступен.
  const d = new Date(Date.now() - days * 86400_000);
  return d.toISOString();
}

async function compute(): Promise<OzonFactProfit> {
  const skuMap = await buildSkuMap();
  const from = isoDaysAgo(30);

  const acc: Record<string, { units: number; revenue: number; commission: number; logistic: number; payout: number }> = {};
  const amt = (m: any) => Number(m?.amount) || 0;
  for (const day of datesBetween(mskDate(29), mskDate(0))) {
    const accruals = await getAccrualsForDay(day).catch(() => []);
    for (const a of accruals) {
      const products = (a.posting?.products ?? []).filter(p => p.commission);
      if (!products.length) continue;
      const single = products.length === 1;
      for (const p of products) {
        const sale = amt(p.commission?.sale_amount ?? p.commission?.seller_price);
        if (sale <= 0) continue;                       // возврат, не продажа
        const offer = skuMap[String(p.sku ?? '')];
        if (!offer) continue;
        const qty = Math.max(1, Number(p.quantity) || 1);
        const commission = amt(p.commission?.commission ?? p.commission?.sale_commission);
        const logistic = (p.delivery?.services ?? []).reduce((s: number, x: any) => s + amt(x?.accrued), 0);
        const cur = acc[offer] ?? (acc[offer] = { units: 0, revenue: 0, commission: 0, logistic: 0, payout: 0 });
        cur.units += qty;
        cur.revenue += sale;
        cur.commission += Math.abs(commission);
        cur.logistic += Math.abs(logistic);
        cur.payout += single ? amt(a.total_amount) : sale + commission + logistic;
      }
    }
  }

  const items: Record<string, OzonFactRow> = {};
  for (const [offer, v] of Object.entries(acc)) {
    if (v.units <= 0) continue;
    items[offer] = {
      units: v.units,
      revenue: Math.round(v.revenue / v.units),
      commission: Math.round(v.commission / v.units),
      logistic: Math.round(v.logistic / v.units),
      payout: Math.round(v.payout / v.units),
    };
  }
  return { items, count: Object.keys(items).length, from, fetchedAt: Date.now() };
}

export async function getOzonFactProfit(noCache = false): Promise<OzonFactProfit> {
  const cached = await cacheGet<OzonFactProfit>(CACHE_KEY);
  if (!noCache && isFresh(cached)) return cached.data;
  try {
    const fresh = await compute();
    await cacheSet(CACHE_KEY, fresh, TTL_MS);
    return fresh;
  } catch (e) {
    if (cached?.data) return cached.data;
    throw e;
  }
}
