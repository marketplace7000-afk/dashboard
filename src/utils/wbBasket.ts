/**
 * Хост basket-CDN Wildberries по номеру карточки (nmId).
 * Зеркало api/_lib/wbBasket.ts — держать согласованными.
 *
 * Формула была скопирована в три места с РАЗНЫМИ потолками (21 и 26), из-за чего
 * у товаров с большим nmId фото уезжали в несуществующий хост — жалоба клиента
 * «по ценам не прогрузились фотки» (телемост 11.08, п. 10).
 *
 * 20.10.2026: границы — официальная таблица витрины WB (cdn.wbbasket.ru/api/v3/upstreams,
 * origin.mediabasket_route_map). Прежний «ровный шаг 216» был неверен выше vol ~4566 —
 * фото новых карточек вели в пустой хост. Сервер перечитывает таблицу сам, здесь — снимок.
 */
const VOL_BOUNDS = [
  143, 287, 431, 719, 1007, 1061, 1115, 1169, 1313, 1601,
  1655, 1919, 2045, 2189, 2405, 2621, 2837, 3053, 3269, 3485,
  3701, 3917, 4133, 4349, 4565, 4877, 5189, 5501, 5813, 6125,
  6437, 6749, 7061, 7373, 7685, 7997, 8309, 8741, 9173, 9605,
  10373, 11141, 11909, 12677, 13445, 14213, 14981, 15749, 16517, 17285,
  18053, 18821, 19589, 20357, 21125, 21893, 22661, 23429, 24197, 24965,
  25733, 26501, 27269, 28037, 28805,
];
const STEP_AFTER = VOL_BOUNDS[VOL_BOUNDS.length - 1] - VOL_BOUNDS[VOL_BOUNDS.length - 2]; // последний шаг WB (768)
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
