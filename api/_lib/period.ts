/**
 * Окна дат на сервере — одна точка.
 *
 * Зеркало src/utils/period.ts и обязано считать ТО ЖЕ САМОЕ: ключ кэша строится
 * из дат запроса, и если сборщик считает окно иначе, чем браузер, прогретые
 * данные никто не найдёт. Такой промах не виден в логах — страница просто
 * показывает пустоту (см. «ключи кэша» в docs/ПЕРЕДАЧА_АГЕНТУ.md).
 *
 * Даты по Москве: сутки на WB и Ozon московские (см. _lib/mskDate).
 */
import { mskDate } from './mskDate';

export type DateRange = { from: string; to: string };

/** Окно в `days` суток, заканчивающееся сегодня. Ровно N суток, включая сегодня. */
export function windowRange(days: number): DateRange {
  return { from: mskDate(days - 1), to: mskDate(0) };
}

/** Предыдущее окно той же длины — для сравнения «период к периоду». */
export function prevWindowRange(days: number): DateRange {
  return { from: mskDate(2 * days - 1), to: mskDate(days) };
}

// ─── Тела запросов, из которых строятся ключи кэша ──────────────────────────
// Живут здесь, а не у сборщика, потому что их строят ДВОЕ: сборщик, когда греет
// датасет, и читатели, когда идут в прогретое. Пока у каждого была своя копия,
// они разошлись на сутки — ключ сборщика оканчивался на s6, ключ читателя на s7,
// и точное попадание не случалось НИ РАЗУ. Спасал запасной поиск ближайшего
// окна, то есть штатным режимом работы был промах.

/** Воронка продаж WB (sales-funnel v3). Аргумент — длина окна в сутках. */
export function wbFunnelBody(days: number) {
  const w = windowRange(days);
  return {
    period: { start: w.from, end: w.to },
    timezone: 'Europe/Moscow', limit: 200, offset: 0,
    brandNames: [], subjectIDs: [], tagIDs: [], nmIDs: [],
    orderBy: { field: 'ordersSumRub', mode: 'desc' },
  };
}

/** Аналитика Ozon. Аргумент — длина окна в сутках, метрики в порядке как у фронта. */
export function ozAnalyticsBody(days: number, metrics: string[], dimension: string[], limit: number) {
  const w = windowRange(days);
  return { date_from: w.from, date_to: w.to, metrics, dimension, limit, offset: 0 };
}
