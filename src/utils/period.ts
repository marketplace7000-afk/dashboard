/**
 * Периоды и окна дат — одна точка на весь фронт.
 *
 * Зачем отдельный модуль. Правило окна («ровно N суток, включая сегодня»)
 * определяет ключ серверного кэша: сборщик греет данные под ключом, собранным
 * из тех же дат, что шлёт браузер. Пока это правило было переписано в трёх
 * местах — в useLiveWb, useLiveOzon и useFinanceSummary — любая правка в одном
 * из них разводила ключи, и страница молча показывала данные чужого периода
 * или пустоту вместо цифр. Оба таких случая уже были (телемост 11.08).
 *
 * Поэтому длина периода и арифметика окна живут здесь, а модули данных их
 * только используют. Менять правило можно ровно в одном месте.
 *
 * Даты — всегда по Москве, потому что сутки на WB и Ozon московские, а продавец
 * может открыть кабинет из любого пояса (см. utils/mskDate).
 */
import { mskDate } from './mskDate';

export type PeriodKey = 'day' | 'week' | 'month';

/**
 * Длина периода в сутках.
 *
 * Именно ВКЛЮЧАЯ сегодня: «неделя» это 7 суток, а не 8. Раньше окно строилось
 * как `from = today − N`, что давало N+1 сутки; пока браузер только читал кэш,
 * расхождение сидело в ключе, но с появлением ручного обновления тело запроса
 * уходит в площадку напрямую, и лишний день стал реальной разницей с цифрой
 * сборщика.
 */
export const PERIOD_DAYS: Record<PeriodKey, number> = { day: 1, week: 7, month: 30 };

export const PERIOD_LABEL: Record<PeriodKey, string> = {
  day: 'Сегодня', week: '7 дней', month: '30 дней',
};

export type DateRange = { from: string; to: string };

/**
 * Окно в `days` суток, заканчивающееся сегодня.
 * Базовая арифметика: всё остальное в модуле выражено через неё.
 */
export function windowRange(days: number): DateRange {
  return { from: mskDate(days - 1), to: mskDate(0) };
}

/** Предыдущее окно той же длины — для сравнения «период к периоду». */
export function prevWindowRange(days: number): DateRange {
  return { from: mskDate(2 * days - 1), to: mskDate(days) };
}

/** Текущее окно периода. */
export function periodRange(period: PeriodKey): DateRange {
  return windowRange(PERIOD_DAYS[period]);
}

/** Предыдущее окно периода. */
export function prevPeriodRange(period: PeriodKey): DateRange {
  return prevWindowRange(PERIOD_DAYS[period]);
}

/** «24.06–30.06» из ISO-дат. */
export function fmtRangeRu(from: string, to: string): string {
  const d = (iso: string) => { const p = iso.split('-'); return `${p[2]}.${p[1]}`; };
  return from === to ? d(from) : `${d(from)}–${d(to)}`;
}

/**
 * «7 дней (25.06–01.07)» — метка периода с конкретными числами.
 * Клиент просил, чтобы везде было видно, за какой именно период цифры.
 */
export function periodLabelRu(period: PeriodKey): string {
  const r = periodRange(period);
  return `${PERIOD_LABEL[period]} (${fmtRangeRu(r.from, r.to)})`;
}
