// Факт-прибыль Ozon из РЕАЛЬНЫХ финансовых операций (как считает КАН) — вместо
// прогноза по тарифам. Источник: /v3/finance/transaction/list за последние 30 дней.
//
// По каждой доставленной продаже (OperationAgentDeliveredToCustomer):
//   accruals_for_sale  — выручка продавца (≈ цена продавца)
//   sale_commission    — комиссия Ozon (отрицательная)
//   services[].price   — логистика доставки на этой операции (отрицательные)
//   amount             — начислено за эту продажу (выручка − комиссия − логистика доставки)
//
// ВАЖНО: amount НЕ включает склад/рекламу/эквайринг — Ozon проводит их отдельными
// операциями, не привязанными к SKU. Поэтому это «начислено за продажу», а не
// полная чистая выплата (её КАН аллоцирует эвристикой). Реальны здесь комиссия и
// логистика доставки — их и показываем как факт против прогноза по тарифам.
//
// Агрегируем по offer_id (Ozon sku из транзакции → offer_id через sources[].sku).
// Отдаём средние на единицу. Кэш 6ч — финотчёт обновляется раз в сутки.

import { fetchWithRetry } from './fetchRetry';
import { cacheGet, cacheSet, isFresh } from './cache';

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
  const to = new Date().toISOString();

  const acc: Record<string, { units: number; revenue: number; commission: number; logistic: number; payout: number }> = {};
  let page = 1;
  let pageCount = 1;
  do {
    const tr = await ozReq('v3/finance/transaction/list', {
      filter: { date: { from, to }, operation_type: [], transaction_type: 'all' },
      page, page_size: 1000,
    });
    const result = tr?.result ?? {};
    pageCount = result.page_count ?? 1;
    for (const o of (result.operations ?? [])) {
      if (o?.operation_type !== 'OperationAgentDeliveredToCustomer') continue;
      const items: any[] = o?.items ?? [];
      if (!items.length) continue;
      const offer = skuMap[String(items[0]?.sku ?? '')];
      if (!offer) continue;
      const services = (o?.services ?? []).reduce((s: number, x: any) => s + (Number(x?.price) || 0), 0);
      const cur = acc[offer] ?? (acc[offer] = { units: 0, revenue: 0, commission: 0, logistic: 0, payout: 0 });
      cur.units += 1;
      cur.revenue += Number(o?.accruals_for_sale) || 0;
      cur.commission += Math.abs(Number(o?.sale_commission) || 0);
      cur.logistic += Math.abs(services);
      cur.payout += Number(o?.amount) || 0;
    }
    page += 1;
  } while (page <= pageCount && page <= 25);

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
