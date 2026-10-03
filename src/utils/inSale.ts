/**
 * «В продаже» = товар есть на витрине магазина и его можно купить (01.10.2026).
 *
 * Жалоба клиента: на WB с фильтром «В продаже» были видны OTTOCAST-P3-KVDRT,
 * CARBITLINK и др., хотя на витрине магазина 37 товаров, а этих нет. Отчёт WB
 * warehouse_remains показывал по ним остаток (1 шт. в Краснодаре и т.п.) — это
 * единицы, которые числятся на складе, но покупателю не продаются (возвраты,
 * брак, карточка скрыта). Остаток — необходимое условие, но не достаточное.
 *
 * Поэтому решает последний полный обход витрины агентом (он листает всю
 * витрину магазина, 3 раза в день): на витрине нет — не в продаже. Живые
 * остатки (раз в 5 мин) уточняют: товар распродан после обхода — не в продаже.
 * Если обхода давно не было или он явно неполный — решают только остатки.
 */
export type SweepRow = { price: number; at: number };

/** Обход старше — не доверяем (между вечерним и утренним прогоном ~10 ч). */
export const SWEEP_MAX_AGE_MS = 24 * 60 * 60_000;
/** Все снимки одного обхода укладываются в это окно от самого свежего. */
const SWEEP_WINDOW_MS = 2 * 60 * 60_000;

export type Sweep = { at: number | null; ids: Set<string>; usable: boolean };

/**
 * Товары последнего обхода витрины.
 * stockPositive — сколько товаров с остатком по API: обход, нашедший меньше
 * половины от этого, считаем сорвавшимся (недолистал ленту) и не применяем.
 */
export function lastSweep(items: Record<string, SweepRow>, stockPositive: number, now = Date.now()): Sweep {
  let at = 0;
  for (const it of Object.values(items)) if (it && it.price > 0 && Number(it.at) > at) at = Number(it.at);
  const ids = new Set<string>();
  if (!at) return { at: null, ids, usable: false };
  for (const [id, it] of Object.entries(items)) {
    if (it && it.price > 0 && Number(it.at) >= at - SWEEP_WINDOW_MS) ids.add(id.toUpperCase());
  }
  const usable = now - at <= SWEEP_MAX_AGE_MS && ids.size >= Math.max(5, Math.floor(stockPositive * 0.5));
  return { at, ids, usable };
}

/**
 * Итоговое решение. stock: остаток по API (null — остатки неизвестны или неполные).
 * Возвращает null, если ни обход, ни остатки ответа не дают (тогда — старые фолбэки).
 */
export function decideInSale(id: string, stock: number | null, sweep: Sweep): boolean | null {
  if (stock !== null && stock <= 0) return false;          // распродан — точно нет
  if (sweep.usable) return sweep.ids.has(id.toUpperCase()); // витрина — главный судья
  if (stock !== null) return stock > 0;
  return null;
}
