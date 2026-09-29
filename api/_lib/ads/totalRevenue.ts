/**
 * ВЫРУЧКА ПО ВСЕМ ЗАКАЗАМ ТОВАРА — знаменатель ДРР в понимании клиента.
 *
 * Клиент 14.08: «ДРР мы считаем как расход рекламы, делённый на общее количество
 * заказанных товаров, а не просто на заказанный от рекламы товар». У площадок
 * же в рекламной статистике лежит выручка, которую принесла САМА реклама. Это
 * два разных показателя: наш всегда выше, и сверить их с таблицей клиента
 * нельзя в принципе, сколько ни чини источники.
 *
 * Поэтому берём общую выручку по артикулу из тех же датасетов, что уже
 * прогревает крон, и делим расход на неё:
 *   WB   — воронка sales-funnel v3, поле statistics.selectedPeriod.ordersSumRub
 *   Ozon — analytics/data с разбивкой по sku, метрика revenue
 *
 * Ключи кэша строятся ровно теми же телами запроса, что у крона, иначе попадём
 * мимо прогретого датасета и молча получим ноль.
 */
import { cacheGet, makeUpstreamCacheKey, makeUpstreamCachePrefix, cacheGetNearestWindow, windowKeyFor } from '../cache';
import { wbFunnelBody, ozAnalyticsBody } from '../period';
import { getSkuMap } from '../ozonShowcase';

async function readCache<T>(ns: string, method: 'GET' | 'POST', path: string, body?: any): Promise<T | null> {
  const bodyStr = body ? JSON.stringify(body) : undefined;
  let cached = await cacheGet<{ status: number; ct: string; text: string }>(makeUpstreamCacheKey(ns, method, path, '', bodyStr));
  if (!cached || cached.data.status >= 400) {
    const near = cacheGetNearestWindow<{ status: number; ct: string; text: string }>(
      makeUpstreamCachePrefix(ns, method, path, '', bodyStr),
      windowKeyFor('', bodyStr),
    );
    if (near && near.entry.data.status < 400) cached = near.entry;
  }
  if (!cached || cached.data.status >= 400) return null;
  try { return JSON.parse(cached.data.text) as T; } catch { return null; }
}

export type TotalRevenue = {
  /** WB: nmId → выручка по всем заказам за окно. */
  wbByNm: Map<string, number>;
  /** Ozon: артикул продавца (offer_id, верхний регистр) → выручка. */
  ozonBySku: Map<string, number>;
  /** По какой площадке данные не нашлись — чтобы честно сказать в интерфейсе. */
  missing: string[];
  /** Заказов (шт) за окно — защита ДРР от шума на малых объёмах. */
  wbOrdersByNm: Map<string, number>;
  ozonOrdersBySku: Map<string, number>;
};

// Тела запросов берём ТЕ ЖЕ, что строит сборщик (_lib/period): своя копия здесь
// и была причиной вечного промаха мимо прогретого датасета.

export async function getTotalRevenue(days: number): Promise<TotalRevenue> {
  const missing: string[] = [];

  // ── WB ──
  const wbByNm = new Map<string, number>();
  const wbOrdersByNm = new Map<string, number>();
  const wb = await readCache<any>('wb:analytics', 'POST', 'api/analytics/v3/sales-funnel/products', wbFunnelBody(days));
  const cards: any[] = wb?.data?.cards ?? [];
  for (const c of cards) {
    const nm = String(c?.nmID ?? '');
    const sum = Number(c?.statistics?.selectedPeriod?.ordersSumRub) || 0;
    if (nm && sum > 0) wbByNm.set(nm, (wbByNm.get(nm) ?? 0) + sum);
    const cnt = Number(c?.statistics?.selectedPeriod?.ordersCount) || 0;
    if (nm && cnt > 0) wbOrdersByNm.set(nm, (wbOrdersByNm.get(nm) ?? 0) + cnt);
  }
  if (!wbByNm.size) missing.push('WB: воронка продаж не прогрета');

  // ── Ozon ──
  // Крон греет по SKU два окна: 7 дней (limit 200) и 30 (limit 300). На 14 днях
  // берём семидневное тело — и запасной поиск его НЕ подменит: он требует
  // совпадения длины окна и разрешает расходиться только смещению. То есть на
  // 14 днях знаменателя по Ozon не будет вовсе, и в диагностике это честно
  // написано. Это лучше, чем поделить расход за две недели на выручку за одну:
  // ДРР вышел бы вдвое завышенным, а по нему принимают решения.
  const ozonBySku = new Map<string, number>();
  const ozonOrdersBySku = new Map<string, number>();
  const ozBody = days > 14 ? ozAnalyticsBody(30, ['ordered_units', 'revenue'], ['sku'], 300) : ozAnalyticsBody(7, ['ordered_units', 'revenue'], ['sku'], 200);
  const oz = await readCache<any>('ozon-seller', 'POST', 'v1/analytics/data', ozBody);
  // dimension[0] по sku: { id, name } — id это витринный sku Ozon, а name — НАЗВАНИЕ
  // товара (не артикул). До 16.09.2026 ключом брали name, и ни один Ozon-товар не
  // находил свою выручку: ДРР Ozon молча считался от рекламной выручки (ads-only)
  // вместо формулы клиента. Теперь sku → offer_id через карту из ozonShowcase.
  const skuMap = await getSkuMap().catch(() => ({} as Record<string, string>));
  for (const row of (oz?.result?.data ?? [])) {
    const dim = row?.dimensions?.[0] ?? {};
    const id = String(dim.id ?? '').trim();
    const sku = String(skuMap[id] ?? '').trim().toUpperCase();
    if (!sku) continue;
    const units = Number(row?.metrics?.[0]) || 0;
    const revenue = Number(row?.metrics?.[1]) || 0;
    if (revenue > 0) ozonBySku.set(sku, (ozonBySku.get(sku) ?? 0) + revenue);
    if (units > 0) ozonOrdersBySku.set(sku, (ozonOrdersBySku.get(sku) ?? 0) + units);
  }
  if (!ozonBySku.size) missing.push('Ozon: аналитика по SKU не прогрета или карта sku→артикул пуста');

  return { wbByNm, ozonBySku, wbOrdersByNm, ozonOrdersBySku, missing };
}
