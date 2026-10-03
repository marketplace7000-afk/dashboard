import { fetchWithRetry } from './fetchRetry';
import { cacheGet, cacheSet, isFresh, makeUpstreamCacheKey } from './cache';
import { noteSwallowed } from './log';

// Кэш «витрины» Ozon — цены, которые видит покупатель на публичной странице
// магазина (ozon.ru/seller/avto-vibe), снятые вручную браузером (Claude in
// Chrome), потому что официальный API продавца не отдаёт реальную скидку
// площадки/соинвест (СПП) — только «цену ЛК». См. wbShowcase.ts — тот же
// принцип для Wildberries, только там браузер обязателен из-за антибота WB.
const CACHE_KEY = 'ozon-showcase:v1';
const TTL_MS = 3 * 60 * 60_000;

export type OzonShowcaseRow = { price: number; oldPrice?: number; greyPrice?: number; at: number };
export type OzonShowcase = {
  items: Record<string, OzonShowcaseRow>;
  count: number;
  requested: number;
  rejected?: number;
  fetchedAt: number;
  error?: string;
};

// ---- sku (число, как в ссылке на витрине ozon.ru/product/.../<sku>/) → offer_id ----
// ВАЖНО: это НЕ то же самое, что product_id из v5/product/info/prices — Ozon
// использует разные пространства ID для внутреннего учёта продавца (product_id)
// и для витрины/заказов (sku). Строим карту ровно так же, как ozonFactProfit.ts
// (buildSkuMap): список товаров через v3/product/list, затем sku из
// v3/product/info/list (верхний sku и sources[].sku — варианты FBO/FBS).
const SKU_MAP_CACHE_KEY = 'ozon-sku-map:v1';
const SKU_MAP_TTL_MS = 6 * 60 * 60_000;
const BASE = 'https://api-seller.ozon.ru';

function ozHeaders(): Record<string, string> {
  return {
    'Client-Id': process.env.OZON_CLIENT_ID ?? '',
    'Api-Key': process.env.OZON_API_KEY ?? '',
    'Content-Type': 'application/json',
  };
}

async function ozReq(path: string, body?: unknown): Promise<any> {
  const res = await fetchWithRetry(
    `${BASE}/${path}`,
    { method: 'POST', headers: ozHeaders(), body: body !== undefined ? JSON.stringify(body) : undefined },
    { maxRetries: 2, timeoutMs: 40_000 },
  );
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`ozon ${path} → ${res.status} ${txt.slice(0, 200)}`);
  }
  return res.json();
}

async function buildSkuMap(): Promise<Record<string, string>> {
  const pids: number[] = [];
  let lastId = '';
  for (let page = 0; page < 10; page++) {
    const pl = await ozReq('v3/product/list', { filter: { visibility: 'ALL' }, last_id: lastId, limit: 1000 });
    const items: any[] = pl?.result?.items ?? [];
    for (const it of items) if (it.product_id) pids.push(it.product_id);
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

export async function getSkuMap(): Promise<Record<string, string>> {
  const cached = await cacheGet<Record<string, string>>(SKU_MAP_CACHE_KEY);
  const have = !!cached?.data && Object.keys(cached.data).length > 0;
  // 03.10.2026: раньше здесь возвращалась ЛЮБАЯ запись кэша — cacheGet не
  // проверяет срок, а кэш живёт на диске, поэтому карта, построенная один раз,
  // не обновлялась никогда. Товары, заведённые позже (ALLPOWERS S2000-PRO,
  // R2500-V2, SUNPANEL), в карте отсутствовали: агент считал их плитки на
  // витрине чужими, ingest выбрасывал их цены, на листе Ozon висела цена
  // «факт» из отчёта (S2000-PRO 65 465 ₽ при 76 000 на витрине). Теперь карта
  // пересобирается по сроку (6 ч), а при ошибке API берём прошлую.
  if (have && isFresh(cached)) return cached!.data;
  try {
    const map = await buildSkuMap();
    if (Object.keys(map).length) {
      await cacheSet(SKU_MAP_CACHE_KEY, map, SKU_MAP_TTL_MS);
      return map;
    }
  } catch (e) {
    noteSwallowed('ozon-showcase', 'карта sku→offer_id не построена', e);
  }
  return have ? cached!.data : {};
}

// Текущая цена ЛК (для запоминания СПП%) — из уже прогретого кэша
// v5/product/info/prices (тот же, что использует /api/ozon-prices и
// productEcon.ts), без похода в API Ozon.
async function ownGoodsOzon(): Promise<{ bySku: Map<string, string>; lkPrice: Map<string, number> }> {
  const key = makeUpstreamCacheKey('ozon-seller', 'POST', 'v5/product/info/prices', '',
    JSON.stringify({ filter: { visibility: 'ALL' }, limit: 100 }));
  const bySkuRaw = await getSkuMap();
  const bySku = new Map<string, string>(Object.entries(bySkuRaw));
  const lkPrice = new Map<string, number>();
  const c = await cacheGet<{ text: string }>(key);
  if (!c?.data?.text) return { bySku, lkPrice };
  try {
    const items = JSON.parse(c.data.text)?.items ?? [];
    for (const it of items) {
      const offerId = String(it?.offer_id ?? '').toUpperCase();
      if (!offerId) continue;
      const cur = Number(it?.price?.marketing_seller_price) || Number(it?.price?.price) || 0;
      if (cur > 0) lkPrice.set(offerId, cur);
    }
  } catch (e) {
    noteSwallowed('ozon-showcase', 'кэш цен Ozon не разобран', e);
  }
  return { bySku, lkPrice };
}

export async function getOzonShowcase(): Promise<OzonShowcase | null> {
  return (await cacheGet<OzonShowcase>(CACHE_KEY))?.data ?? null;
}

/**
 * Принять цены с витрины Ozon (ozon.ru/seller/avto-vibe), собранные вручную
 * браузером (Claude in Chrome) — ключ входных записей: sku (число, как в
 * ссылке на витрине). Мержит по offer_id поверх текущего кэша, не трогая
 * остальные товары. Карточки, которых нет в нашем каталоге (например, блок
 * «Возможно, вам понравится» — чужие товары от других продавцов), молча
 * пропускаются: их sku просто не находится в карте соответствия.
 */
/** Цены, которые на этом проходе «слиплись»: одна и та же цена покупателя у
 *  трёх и более товаров с РАЗНОЙ ценой ЛК. Одинаковый СПП до рубля при разных
 *  ЛК невозможен, значит парсер взял цену не из своей плитки (03.10.2026 так
 *  вышло у 39 из 42 товаров). Такие цифры не записываем: вчерашние данные
 *  честнее подменённых. Три и более — чтобы не ловить пару вариантов одного
 *  товара с общей ценой. Экспортируется для scripts/check-ozon-showcase.ts. */
export function findStickyPrices(cand: { price: number; greyPrice?: number }[]): Set<number> {
  const byPrice = new Map<number, { price: number; greyPrice?: number }[]>();
  for (const c of cand) {
    const a = byPrice.get(c.price) ?? [];
    a.push(c);
    byPrice.set(c.price, a);
  }
  const sticky = new Set<number>();
  for (const [price, group] of byPrice) {
    if (group.length < 3) continue;
    const greys = new Set(group.map((g) => g.greyPrice || 0).filter(Boolean));
    if (greys.size >= 3) sticky.add(price);
  }
  return sticky;
}

export async function ingestOzonShowcase(
  entries: Record<string, { price: number; oldPrice?: number }>
): Promise<OzonShowcase> {
  const prev = (await cacheGet<OzonShowcase>(CACHE_KEY))?.data;
  const now = Date.now();
  const rows: Record<string, OzonShowcaseRow> = { ...(prev?.items ?? {}) };
  // Серая цена (цена ЛК) на момент снятия витрины — чтобы запомнить СПП% на
  // этот момент и пересчитывать цену покупателя, если ЛК-цена поменяется до
  // следующего снятия (см. LiveOzonPricing.tsx — тот же приём, что и для WB).
  const { bySku, lkPrice } = await ownGoodsOzon();

  type Cand = { offerId: string; price: number; oldPrice?: number; greyPrice?: number };
  const cand: Cand[] = [];
  for (const [sku, v] of Object.entries(entries || {})) {
    const price = Number(v?.price) || 0;
    if (!sku || price <= 0) continue;
    const offerId = bySku.get(String(sku));
    if (!offerId) continue; // не наш товар — рекомендательная карусель Ozon
    const oldPrice = v?.oldPrice ? Number(v.oldPrice) : rows[offerId]?.oldPrice;
    const greyPrice = lkPrice.get(offerId) || rows[offerId]?.greyPrice;
    cand.push({ offerId, price, oldPrice, greyPrice });
  }

  // Защита от «слипшихся» цен (03.10.2026). Если вёрстка витрины меняется и
  // парсер берёт цену не из своей плитки, одна цифра достаётся сразу многим
  // товарам — именно так 39 из 42 товаров на листе Ozon получили 7 одинаковых
  // цен. Признак, по которому это видно без похода на сайт: одна и та же цена
  // покупателя у трёх и более товаров с РАЗНОЙ ценой ЛК. Одинаковый СПП до
  // рубля при разных ЛК невозможен, поэтому такие цифры не записываем —
  // лучше оставить вчерашние данные, чем подменить их чужими.
  const sticky = findStickyPrices(cand);

  let updated = 0;
  let rejected = 0;
  for (const c of cand) {
    if (sticky.has(c.price)) { rejected++; continue; }
    rows[c.offerId] = { price: c.price, oldPrice: c.oldPrice, greyPrice: c.greyPrice, at: now };
    updated++;
  }
  if (rejected > 0) {
    noteSwallowed(
      'ozon-showcase',
      `отброшено ${rejected} «слипшихся» цен: одна цифра у товаров с разной ценой ЛК — похоже, изменилась вёрстка витрины Ozon`,
      new Error('sticky-prices'),
    );
  }

  const result: OzonShowcase = {
    items: rows,
    count: Object.keys(rows).length,
    requested: updated,
    rejected,
    fetchedAt: now,
  };
  await cacheSet(CACHE_KEY, result, TTL_MS);
  return result;
}
