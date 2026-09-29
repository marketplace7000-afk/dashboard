// Транзит на склады Ozon FBO — товары, которые едут на склад или на приёмке,
// но ещё НЕ в продаже. Клиент на созвоне (01.07.2026) просил спарсить это по API:
// «нас интересуют накладные, которые в пути на приёмке; подготовка не интересует».
//
// Флоу Ozon Seller API (v2 отключён 11.12.2025 → используем v3):
//   1) POST /v3/supply-order/list  {limit, sort_by, filter:{states}}  → order_ids
//   2) POST /v3/supply-order/get   {order_ids}                        → state + supplies[].bundle_id
//   3) POST /v1/supply-order/bundle {bundle_ids}                      → items[]{offer_id, quantity}
//
// Числовые коды статусов (подобраны по живому API): 4=IN_TRANSIT (в пути),
// 5=ACCEPTANCE_AT_STORAGE_WAREHOUSE (на приёмке). Их и берём — исключая
// подготовку (draft), COMPLETED (уже в продаже) и CANCELLED.

import { fetchWithRetry } from './fetchRetry';
import { cacheGet, cacheSet, isFresh } from './cache';

const BASE = 'https://api-seller.ozon.ru';
const CACHE_KEY = 'ozon-transit:v1';
const TTL_MS = 60 * 60_000; // 1 час — заявки на поставку меняются медленно

// Статусы «едет на склад / на приёмке» = ещё не в продаже.
const TRANSIT_STATE_CODES = [4, 5];
const TRANSIT_STATES = new Set(['IN_TRANSIT', 'ACCEPTANCE_AT_STORAGE_WAREHOUSE']);

export type OzonTransitResult = {
  items: Record<string, number>;      // offer_id (UPPER) → суммарное кол-во в транзите
  totalUnits: number;
  ordersCount: number;
  byState: Record<string, number>;    // сколько заявок в каждом статусе (для сверки)
  fetchedAt: number;
};

function ozHeaders(): Record<string, string> {
  return {
    'Client-Id': process.env.OZON_CLIENT_ID ?? '',
    'Api-Key': process.env.OZON_API_KEY ?? '',
    'Content-Type': 'application/json',
  };
}

async function ozPost(path: string, body: unknown): Promise<any> {
  const res = await fetchWithRetry(
    `${BASE}/${path}`,
    { method: 'POST', headers: ozHeaders(), body: JSON.stringify(body) },
    { maxRetries: 2, timeoutMs: 30_000 },
  );
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`ozon ${path} → ${res.status} ${txt.slice(0, 200)}`);
  }
  return res.json();
}

async function compute(): Promise<OzonTransitResult> {
  // 1) Собираем все order_ids в статусах «в пути / на приёмке» (с пагинацией).
  const orderIds: number[] = [];
  let lastId = '';
  for (let page = 0; page < 20; page++) {
    const body: any = { limit: 100, sort_by: 1, filter: { states: TRANSIT_STATE_CODES } };
    if (lastId) body.last_id = lastId;
    const r = await ozPost('v3/supply-order/list', body);
    const ids: number[] = r.order_ids ?? [];
    orderIds.push(...ids);
    lastId = r.last_id ?? '';
    if (ids.length < 100 || !lastId) break;
  }

  // 2) Детали заявок пачками по 50 → статус + bundle_id по каждой поставке.
  const byState: Record<string, number> = {};
  const bundleIds: string[] = [];
  for (let i = 0; i < orderIds.length; i += 50) {
    const r = await ozPost('v3/supply-order/get', { order_ids: orderIds.slice(i, i + 50) });
    for (const o of r.orders ?? []) {
      byState[o.state] = (byState[o.state] ?? 0) + 1;
      for (const s of o.supplies ?? []) {
        // страхуемся: берём только поставки в нужном статусе с валидным bundle_id
        if (s.bundle_id && TRANSIT_STATES.has(s.state ?? o.state)) bundleIds.push(s.bundle_id);
      }
    }
  }

  // 3) Состав каждой поставки (пагинация внутри bundle) → сумма по offer_id.
  const items: Record<string, number> = {};
  let totalUnits = 0;
  for (const bid of bundleIds) {
    let bLastId = '';
    for (let page = 0; page < 50; page++) {
      const body: any = { bundle_ids: [bid], limit: 100, is_asc: true };
      if (bLastId) body.last_id = bLastId;
      const r = await ozPost('v1/supply-order/bundle', body);
      for (const it of r.items ?? []) {
        const offer = String(it.offer_id ?? '').trim().toUpperCase();
        const qty = Number(it.quantity) || 0;
        if (!offer || qty <= 0) continue;
        items[offer] = (items[offer] ?? 0) + qty;
        totalUnits += qty;
      }
      bLastId = r.last_id ?? '';
      if (!r.has_next || !bLastId) break;
    }
  }

  return { items, totalUnits, ordersCount: orderIds.length, byState, fetchedAt: Date.now() };
}

// Кэшируем на 1 час; при сбое отдаём последний удачный кэш (пусть протухший),
// чтобы страница «Распределение» не оставалась без цифры транзита.
export async function getOzonTransit(noCache = false): Promise<OzonTransitResult> {
  const cached = await cacheGet<OzonTransitResult>(CACHE_KEY);
  if (!noCache && isFresh(cached)) return cached.data;
  try {
    const fresh = await compute();
    await cacheSet(CACHE_KEY, fresh, TTL_MS);
    return fresh;
  } catch (e) {
    if (cached?.data) return cached.data; // graceful degradation
    throw e;
  }
}
