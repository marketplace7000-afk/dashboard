/**
 * Хост basket-CDN Wildberries по номеру карточки (nmId).
 *
 * Зачем отдельный модуль: формула была скопирована в ТРИ места с РАЗНЫМИ
 * потолками — api/route.ts обрывался на basket-21, а competitors.ts и
 * LiveWbAnalytics.tsx доходили до basket-26. Товары с большим nmId уезжали
 * в несуществующий хост, и у клиента «по ценам не прогрузились фотки»
 * (телемост 11.08, п. 10).
 *
 * Проверено 14.08.2026: хосты basket-01 … basket-32 отвечают по HTTP (404 на
 * корень = хост живой, просто корень пустой). То есть потолок 21 заведомо мал.
 *
 * Пороги vol до 3485 — таблица наблюдений. Дальше WB нарезает баскеты РОВНЫМ
 * шагом 216 (3485 → 3701 → 3917 → 4133 → 4349 → 4565…), поэтому верхнюю часть
 * считаем арифметикой, а не продолжаем таблицу руками: так формула не устареет
 * при следующем баскете. NB: сам шаг — эмпирика, официальной спецификации у WB
 * нет; если WB его изменит, фото снова поедут (см. wbImageUrlWithFallback).
 */

/** Верхние границы vol для баскетов 1..20 (наблюдения). */
const VOL_BOUNDS = [
  143, 287, 431, 719, 1007, 1061, 1115, 1169, 1313, 1601,
  1655, 1919, 2045, 2189, 2405, 2621, 2837, 3053, 3269, 3485,
];
const STEP_AFTER = 216;      // шаг нарезки баскетов выше vol 3485
const LAST_TABLE_BASKET = VOL_BOUNDS.length;          // 20
const LAST_TABLE_VOL = VOL_BOUNDS[VOL_BOUNDS.length - 1]; // 3485

export function wbBasketNumber(nm: number): number {
  const vol = Math.floor(nm / 1e5);
  for (let i = 0; i < VOL_BOUNDS.length; i++) if (vol <= VOL_BOUNDS[i]) return i + 1;
  return LAST_TABLE_BASKET + Math.ceil((vol - LAST_TABLE_VOL) / STEP_AFTER);
}

export function wbBasketHost(nm: number): { host: string; vol: number; part: number; basket: number } {
  const basket = wbBasketNumber(nm);
  return {
    host: `https://basket-${String(basket).padStart(2, '0')}.wbbasket.ru`,
    vol: Math.floor(nm / 1e5),
    part: Math.floor(nm / 1e3),
    basket,
  };
}

export function wbImageUrl(nm: number, idx = 1, size = 'big'): string {
  const { host, vol, part } = wbBasketHost(nm);
  return `${host}/vol${vol}/part${part}/${nm}/images/${size}/${idx}.webp`;
}

/** Тот же URL, но на соседнем баскете — запасной вариант, если основной промахнулся. */
export function wbImageUrlNeighbour(nm: number, idx = 1, size = 'big', delta = 1): string {
  const basket = Math.max(1, wbBasketNumber(nm) + delta);
  const vol = Math.floor(nm / 1e5);
  const part = Math.floor(nm / 1e3);
  return `https://basket-${String(basket).padStart(2, '0')}.wbbasket.ru/vol${vol}/part${part}/${nm}/images/${size}/${idx}.webp`;
}
