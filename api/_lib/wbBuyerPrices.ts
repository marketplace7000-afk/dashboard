// Цена ПОКУПАТЕЛЯ с СПП по товарам WB — «живой» источник вместо таблицы.
//
// WB в ценовом методе (discounts-prices-api) СПП НЕ отдаёт, а публичный
// card.wb.ru режет наш серверный IP (403). Поэтому берём фактическую цену, что
// заплатил покупатель, из данных о ПРОДАЖАХ (statistics supplier/sales), которые
// сборщик уже греет. Поле finishedPrice = цена со всеми скидками ВКЛЮЧАЯ СПП
// (проверено: finishedPrice ≈ priceWithDisc × (1 − spp/100)).
//
// По каждому nmId берём ПОСЛЕДНЮЮ продажу (не возврат) → её finishedPrice.
// Это реальная цена последней сделки: свежее ручной таблицы и без скрейпинга.
// Ограничение: только по товарам, что продавались в окне; остальным — фолбэк
// на таблицу/ценовой API (делает фронт).

import { cacheGet, cacheSet, isFresh, makeUpstreamCachePrefix, cacheGetNewestByPrefix } from './cache';

const RESULT_KEY = 'wb-buyer-prices:v2';
const TTL_MS = 60 * 60_000; // 1 час (пересчёт из уже готового кэша продаж — дёшево)

// Долгоживущая ПАМЯТЬ последней известной цены покупателя по каждому nmId.
// Зачем: WB в ценовом API СПП не отдаёт, а окно продаж — только 30 дней. Товар,
// не продававшийся в окне, раньше терял цену покупателя и показывал серую с
// СПП 0% (жалоба Дмитрия 03.08: «на WB тянется серая, а у Ozon работает»). У Ozon
// цена восстанавливается по последнему СПП — даём WB такую же память.
const MEMORY_KEY = 'wb-buyer-prices-memory:v1';
const MEMORY_TTL_MS = 180 * 24 * 60 * 60_000; // полгода

export type WbBuyerPrice = {
  price: number;      // finishedPrice — цена покупателя с СПП
  spp: number;        // % СПП последней сделки
  beforeSpp: number;  // priceWithDisc — цена после скидки продавца (без СПП)
  date: string;       // дата последней продажи (YYYY-MM-DD)
  fromMemory?: boolean; // true — восстановлено из памяти (продажи в окне не было)
};

export type WbBuyerPrices = {
  items: Record<string, WbBuyerPrice>; // nmId → цена
  count: number;
  fetchedAt: number;
};

function readSalesFromCache(): any[] {
  // Продажи прогреваются кроном за 30-дневное окно. Ключ нормализован по датам,
  // поэтому ищем по префиксу (любое окно) и берём самый свежий датасет.
  const prefix = makeUpstreamCachePrefix('wb:statistics', 'GET', 'api/v1/supplier/sales', '?dateFrom=2026-01-01', undefined);
  const entry = cacheGetNewestByPrefix<{ text: string }>(prefix);
  if (!entry?.data?.text) return [];
  try {
    const arr = JSON.parse(entry.data.text);
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

/** Цены покупателя из окна продаж (live): nmId → последняя сделка. */
function compute(): Record<string, WbBuyerPrice> {
  const sales = readSalesFromCache();
  const latest: Record<string, WbBuyerPrice> = {};
  for (const s of sales) {
    const nm = s?.nmId;
    if (!nm) continue;
    if (String(s.saleID || '').startsWith('R')) continue;   // возврат — пропускаем
    const price = Number(s.finishedPrice);
    if (!(price > 0)) continue;                              // отрицательные/пустые — мимо
    const date = String(s.date || '').slice(0, 10);
    const key = String(nm);
    if (!latest[key] || date > latest[key].date) {
      latest[key] = {
        price: Math.round(price),
        spp: Number(s.spp) || 0,
        beforeSpp: Math.round(Number(s.priceWithDisc) || 0),
        date,
      };
    }
  }
  return latest;
}

/**
 * Считает цены покупателя и СЛИВАЕТ их в долгоживущую память.
 * Свежая продажа всегда перекрывает запомненную (дата новее). Товары, которых нет
 * в окне, берутся из памяти с пометкой fromMemory — чтобы не показывать серую.
 */
async function computeWithMemory(): Promise<WbBuyerPrices> {
  const fresh = compute();                    // nmId → цена из окна продаж (live)

  const mem = (await cacheGet<Record<string, WbBuyerPrice>>(MEMORY_KEY))?.data ?? {};
  // Обновляем память свежими продажами (перезаписываем только если дата новее).
  for (const [nm, p] of Object.entries(fresh)) {
    const prev = mem[nm];
    if (!prev || p.date >= prev.date) mem[nm] = { ...p, fromMemory: false };
  }
  await cacheSet(MEMORY_KEY, mem, MEMORY_TTL_MS);

  // Результат: живые цены из окна + восстановленные из памяти для остальных.
  const items: Record<string, WbBuyerPrice> = {};
  for (const [nm, p] of Object.entries(mem)) {
    items[nm] = { ...p, fromMemory: !(nm in fresh) };
  }
  return { items, count: Object.keys(items).length, fetchedAt: Date.now() };
}

export async function getWbBuyerPrices(noCache = false): Promise<WbBuyerPrices> {
  const cached = await cacheGet<WbBuyerPrices>(RESULT_KEY);
  if (!noCache && isFresh(cached)) return cached.data;
  const fresh = await computeWithMemory();
  await cacheSet(RESULT_KEY, fresh, TTL_MS);
  return fresh;
}
