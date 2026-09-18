/**
 * Единые рекламные метрики по товару для обеих площадок.
 *
 * Зачем свой слой: документы специалистов по рекламе (WB и Ozon) описывают ОДНУ
 * и ту же цепочку — показы → клики → корзина → заказ → выручка. Площадки отдают
 * её по-разному: Ozon асинхронным CSV-отчётом, WB массивом nm[] внутри статистики
 * кампаний. Сценарии не должны знать об этой разнице, поэтому приводим к одному
 * виду здесь.
 *
 * Считаем ДВА периода — текущий и предыдущий такой же длины. Половина сценариев
 * из документов про динамику («CTR снизился», «CPC вырос более чем на 20%»), без
 * прошлого периода они не работают.
 */

export type Platform = 'wb' | 'ozon';

/** Сырые числа за период по одному товару. */
export type AdFunnel = {
  views: number;      // показы
  clicks: number;     // клики
  carts: number;      // добавления в корзину (WB не отдаёт — 0)
  orders: number;     // заказы из рекламы
  spend: number;      // расход, ₽
  revenue: number;    // выручка от рекламы, ₽
};

/** Производные показатели. Считаем здесь, чтобы сценарии не дублировали формулы. */
export type AdDerived = {
  ctr: number | null;         // клики ÷ показы × 100
  cpc: number | null;         // расход ÷ клики
  cpm: number | null;         // расход ÷ показы × 1000
  cartRate: number | null;    // корзины ÷ клики × 100
  orderRate: number | null;   // заказы ÷ клики × 100
  cartToOrder: number | null; // заказы ÷ корзины × 100
  cpo: number | null;         // расход ÷ заказы
  drr: number | null;         // расход ÷ выручка × 100
};

export type AdItem = {
  platform: Platform;
  sku: string;                // артикул продавца (Ozon) или vendorCode (WB)
  name?: string;
  category?: string;
  current: AdFunnel;
  previous: AdFunnel;
  derivedNow: AdDerived;
  derivedPrev: AdDerived;
};

export const emptyFunnel = (): AdFunnel => ({
  views: 0, clicks: 0, carts: 0, orders: 0, spend: 0, revenue: 0,
});

/** Деление, которое не врёт: при нулевом знаменателе возвращаем null, а не ноль. */
const div = (a: number, b: number): number | null => (b > 0 ? a / b : null);
const pct = (a: number, b: number): number | null => {
  const r = div(a, b);
  return r === null ? null : Math.round(r * 1000) / 10;
};

export function derive(f: AdFunnel): AdDerived {
  return {
    ctr: pct(f.clicks, f.views),
    cpc: f.clicks > 0 ? Math.round((f.spend / f.clicks) * 100) / 100 : null,
    cpm: f.views > 0 ? Math.round((f.spend / f.views) * 1000 * 100) / 100 : null,
    cartRate: pct(f.carts, f.clicks),
    orderRate: pct(f.orders, f.clicks),
    cartToOrder: pct(f.orders, f.carts),
    cpo: f.orders > 0 ? Math.round((f.spend / f.orders) * 100) / 100 : null,
    drr: pct(f.spend, f.revenue),
  };
}

/**
 * Изменение показателя в процентах относительно прошлого периода.
 * null, если сравнивать не с чем — сценарии обязаны это учитывать и молчать,
 * а не выдавать «рост на бесконечность».
 */
export function changePct(now: number | null, prev: number | null): number | null {
  if (now === null || prev === null || prev === 0) return null;
  return Math.round(((now - prev) / prev) * 1000) / 10;
}

export function buildItem(
  platform: Platform,
  sku: string,
  current: AdFunnel,
  previous: AdFunnel,
  meta?: { name?: string; category?: string },
): AdItem {
  return {
    platform,
    sku,
    name: meta?.name,
    category: meta?.category,
    current,
    previous,
    derivedNow: derive(current),
    derivedPrev: derive(previous),
  };
}
