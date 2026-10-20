/**
 * Хост basket-CDN Wildberries по номеру карточки (nmId).
 *
 * Зачем отдельный модуль: формула была скопирована в ТРИ места с РАЗНЫМИ
 * потолками — api/route.ts обрывался на basket-21, а competitors.ts и
 * LiveWbAnalytics.tsx доходили до basket-26. Товары с большим nmId уезжали
 * в несуществующий хост, и у клиента «по ценам не прогрузились фотки»
 * (телемост 11.08, п. 10).
 *
 * 20.10.2026: прежний «ровный шаг 216» выше vol 3485 оказался неверным — с vol ~4566
 * WB режет баскеты по 312, 432, затем 768, и у 58 из 96 конкурентов WB фото вели в
 * пустой хост. Теперь границы — официальная таблица самой витрины WB
 * (cdn.wbbasket.ru/api/v3/upstreams → origin.mediabasket_route_map, снята 20.10).
 * Сервер перечитывает её раз в 12 часов (refreshInBackground), так что новые баскеты
 * подхватываются сами; за пределами таблицы продолжаем последним шагом.
 * Зеркало для браузера — src/utils/wbBasket.ts (только таблица).
 */

/** Верхние границы vol для баскетов 1..65 (таблица WB на 20.10.2026). */
let VOL_BOUNDS = [
  143, 287, 431, 719, 1007, 1061, 1115, 1169, 1313, 1601,
  1655, 1919, 2045, 2189, 2405, 2621, 2837, 3053, 3269, 3485,
  3701, 3917, 4133, 4349, 4565, 4877, 5189, 5501, 5813, 6125,
  6437, 6749, 7061, 7373, 7685, 7997, 8309, 8741, 9173, 9605,
  10373, 11141, 11909, 12677, 13445, 14213, 14981, 15749, 16517, 17285,
  18053, 18821, 19589, 20357, 21125, 21893, 22661, 23429, 24197, 24965,
  25733, 26501, 27269, 28037, 28805,
];

const UPSTREAMS_URL = 'https://cdn.wbbasket.ru/api/v3/upstreams';
const REFRESH_MS = 12 * 3600_000;
let refreshedAt = 0;
let refreshing = false;

/** Перечитать таблицу баскетов у WB (не блокирует вызывающего; ошибки — остаёмся на прежней). */
function refreshInBackground(): void {
  if (refreshing || Date.now() - refreshedAt < REFRESH_MS || typeof fetch !== 'function') return;
  refreshing = true;
  refreshedAt = Date.now();
  fetch(UPSTREAMS_URL, { signal: AbortSignal.timeout(15_000) })
    .then(r => (r.ok ? r.json() : null))
    .then((j: any) => {
      const hosts: any[] = j?.origin?.mediabasket_route_map?.[0]?.hosts ?? [];
      const bounds: number[] = [];
      for (let i = 0; i < hosts.length; i++) {
        const h = hosts[i];
        // Берём только ровную последовательность basket-01, basket-02, … с растущими границами.
        if (h?.host !== `basket-${String(i + 1).padStart(2, '0')}.wbbasket.ru`) break;
        const to = Number(h.vol_range_to);
        if (!Number.isFinite(to) || (bounds.length && to <= bounds[bounds.length - 1])) break;
        bounds.push(to);
      }
      if (bounds.length >= VOL_BOUNDS.length) VOL_BOUNDS = bounds;
    })
    .catch(() => {})
    .finally(() => { refreshing = false; });
}

export function wbBasketNumber(nm: number): number {
  refreshInBackground();
  const vol = Math.floor(nm / 1e5);
  for (let i = 0; i < VOL_BOUNDS.length; i++) if (vol <= VOL_BOUNDS[i]) return i + 1;
  // Дальше таблицы — последним шагом WB (на 20.10 это 768).
  const n = VOL_BOUNDS.length, step = VOL_BOUNDS[n - 1] - VOL_BOUNDS[n - 2];
  return n + Math.ceil((vol - VOL_BOUNDS[n - 1]) / step);
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
