/**
 * Хост basket-CDN Wildberries по номеру карточки (nmId).
 * Зеркало api/_lib/wbBasket.ts — держать согласованными.
 *
 * Формула была скопирована в три места с РАЗНЫМИ потолками (21 и 26), из-за чего
 * у товаров с большим nmId фото уезжали в несуществующий хост — жалоба клиента
 * «по ценам не прогрузились фотки» (телемост 11.08, п. 10).
 *
 * Проверено 14.08.2026: хосты basket-01 … basket-32 отвечают по HTTP.
 * Пороги vol до 3485 — таблица наблюдений, выше WB режет ровным шагом 216,
 * поэтому продолжаем арифметикой, а не руками.
 */
const VOL_BOUNDS = [
  143, 287, 431, 719, 1007, 1061, 1115, 1169, 1313, 1601,
  1655, 1919, 2045, 2189, 2405, 2621, 2837, 3053, 3269, 3485,
];
const STEP_AFTER = 216;
const LAST_TABLE_BASKET = VOL_BOUNDS.length;
const LAST_TABLE_VOL = VOL_BOUNDS[VOL_BOUNDS.length - 1];

export function wbBasketNumber(nm: number): number {
  const vol = Math.floor(nm / 1e5);
  for (let i = 0; i < VOL_BOUNDS.length; i++) if (vol <= VOL_BOUNDS[i]) return i + 1;
  return LAST_TABLE_BASKET + Math.ceil((vol - LAST_TABLE_VOL) / STEP_AFTER);
}

export function wbImageUrl(nm: number, idx = 1, size = 'c246x328'): string {
  const basket = String(wbBasketNumber(nm)).padStart(2, '0');
  const vol = Math.floor(nm / 1e5);
  const part = Math.floor(nm / 1e3);
  return `https://basket-${basket}.wbbasket.ru/vol${vol}/part${part}/${nm}/images/${size}/${idx}.webp`;
}

/** Соседний баскет — запасной URL, если основной промахнулся (шаг WB — эмпирика). */
export function wbImageUrlNeighbour(nm: number, idx = 1, size = 'c246x328', delta = 1): string {
  const basket = String(Math.max(1, wbBasketNumber(nm) + delta)).padStart(2, '0');
  const vol = Math.floor(nm / 1e5);
  const part = Math.floor(nm / 1e3);
  return `https://basket-${basket}.wbbasket.ru/vol${vol}/part${part}/${nm}/images/${size}/${idx}.webp`;
}
