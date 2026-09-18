/**
 * ЖИВАЯ ВИТРИННАЯ ЦЕНА WB ПО СВОИМ ТОВАРАМ.
 *
 * Зачем. «Цена покупателя с СПП» в кабинете собиралась из пяти источников, и ни
 * один не был витриной: свежая сделка (уже вчерашняя цена), clubDiscountedPrice
 * (цена подписчика WB Клуба — на ~10% ниже витрины по определению), давняя
 * сделка из памяти на полгода, таблица, серая цена. Клиент сравнивал с сайтом и
 * видел расхождения (04.09: DJI Mini 3 — 68 639 у нас против 76 276 на витрине;
 * MEKEDE X20 — 20 984 против 13 052).
 *
 * Причина в источнике: СПП WB (скидка площадки, ~38% у X20) в Seller API НЕТ
 * ВООБЩЕ. Она есть только в публичной карточке card.wb.ru — там же, откуда мы
 * давно снимаем цены конкурентов. Тем же батчем снимаем и свои: 168 nmId = два
 * запроса по 100 раз в прогрев, лимиты не трогает.
 *
 * Якорь единиц — серая цена из Seller API (см. toRub в competitorPrices).
 */
import { cacheGet, cacheSet, makeUpstreamCacheKey } from './cache';
import { fetchWbPrices } from './competitorPrices';
import { noteSwallowed } from './log';

const CACHE_KEY = 'wb-showcase:v1';
// Сборщик ходит раз в 2 часа; TTL с запасом, чтобы между проходами не было дыры.
const TTL_MS = 3 * 60 * 60_000;

export type WbShowcaseRow = {
  price: number;        // витрина, ₽
  oldPrice?: number;    // зачёркнутая, ₽
  greyPrice?: number;   // серая цена из Seller API, ₽ — от неё считается СПП
  at: number;
};
export type WbShowcase = {
  items: Record<string, WbShowcaseRow>;   // nmId → витрина
  count: number;
  requested: number;
  fetchedAt: number;
  error?: string;
};

/** Наши nmId и серая цена — из прогретого кэша цен WB. */
async function ownGoods(): Promise<Map<number, number>> {
  const key = makeUpstreamCacheKey('wb:discounts', 'GET', 'api/v2/list/goods/filter', '?limit=1000', undefined);
  const out = new Map<number, number>();
  const c = await cacheGet<{ text: string }>(key);
  if (!c?.data?.text) return out;
  try {
    for (const g of (JSON.parse(c.data.text)?.data?.listGoods ?? [])) {
      const nm = Number(g?.nmID ?? g?.nmId) || 0;
      const grey = Number(g?.sizes?.[0]?.discountedPrice) || 0;
      if (nm) out.set(nm, grey);
    }
  } catch (e) {
    noteSwallowed('wb-showcase', 'кэш цен WB не разобран', e);
  }
  return out;
}

/** Снять витрину по всем своим товарам и положить в кэш. Зовётся сборщиком. */
export async function collectWbShowcase(): Promise<WbShowcase> {
  const goods = await ownGoods();
  const ids = [...goods.keys()];
  const prev = (await cacheGet<WbShowcase>(CACHE_KEY))?.data;
  if (!ids.length) {
    return prev ?? { items: {}, count: 0, requested: 0, fetchedAt: Date.now(), error: 'цены WB не прогреты — нет списка nmId' };
  }
  const { items, error } = await fetchWbPrices(ids, goods);
  const now = Date.now();
  const rows: Record<string, WbShowcaseRow> = {};
  for (const it of items) {
    rows[String(it.nmId)] = { price: it.price, oldPrice: it.oldPrice, greyPrice: goods.get(it.nmId) || undefined, at: now };
  }
  // Образец в журнал — по нему на проде сверяется, что единицы (рубли/копейки)
  // угаданы верно: витрина должна быть НЕ ВЫШЕ серой цены и того же порядка.
  const sample = items[0];
  if (sample) {
    console.warn(`[wb-showcase] образец: nm ${sample.nmId} витрина ${sample.price} ₽, зачёркнутая ${sample.oldPrice ?? '—'}, серая (Seller API) ${goods.get(sample.nmId) ?? '—'}`);
  }
  const result: WbShowcase = {
    // Не снялось — оставляем прошлое значение по этому nmId, чтобы сбой одного
    // прохода не превращал цену в прочерк; возраст виден по `at`.
    items: { ...(prev?.items ?? {}), ...rows },
    count: items.length,
    requested: ids.length,
    fetchedAt: now,
    error,
  };
  await cacheSet(CACHE_KEY, result, TTL_MS);
  return result;
}

export async function getWbShowcase(): Promise<WbShowcase | null> {
  return (await cacheGet<WbShowcase>(CACHE_KEY))?.data ?? null;
}

/**
 * Принять цены с витрины WB, собранные вручную браузером (Claude in Chrome),
 * когда прямой запрос card.wb.ru с сервера заблокирован антиботом WB.
 * Мержит по nmId поверх текущего кэша, не трогая остальные товары.
 */
export async function ingestWbShowcase(
  entries: Record<string, { price: number; oldPrice?: number }>,
): Promise<WbShowcase> {
  const prev = (await cacheGet<WbShowcase>(CACHE_KEY))?.data;
  const now = Date.now();
  const rows: Record<string, WbShowcaseRow> = { ...(prev?.items ?? {}) };
  // Серая цена (цена ЛК) на момент снятия витрины — чтобы запомнить СПП% на этот момент
  // и пересчитывать цену покупателя, если ЛК-цена поменяется до следующего снятия (см. LiveWbPricing.tsx).
  const goods = await ownGoods();
  let updated = 0;
  for (const [nm, v] of Object.entries(entries || {})) {
    const price = Number(v?.price) || 0;
    if (!nm || price <= 0) continue;
    const oldPrice = v?.oldPrice ? Number(v.oldPrice) || undefined : rows[nm]?.oldPrice;
    const greyPrice = goods.get(Number(nm)) || rows[nm]?.greyPrice;
    rows[nm] = { price, oldPrice, greyPrice, at: now };
    updated++;
  }
  const result: WbShowcase = {
    items: rows,
    count: Object.keys(rows).length,
    requested: updated,
    fetchedAt: now,
  };
  await cacheSet(CACHE_KEY, result, TTL_MS);
  return result;
}
