/**
 * Каркас фоновых ИИ-агентов Avto Vibe.
 *
 * Агент — это фоновая задача, которая сама проверяет своё условие и, если есть
 * что сказать, возвращает сообщения. Отправку/дедуп/расписание берёт на себя
 * раннер (agents/index.ts), поэтому агент остаётся маленьким и тестируемым.
 *
 * Отличие от alerts.ts: alerts — это пороги по кэшу МП, а агенты могут ходить
 * куда угодно (таблицы, трекеры, каталоги) и иметь свою периодичность.
 */

export type AgentMessage = {
  /** Стабильный ключ для дедупа. Включай дату, если алерт может повториться завтра. */
  key: string;
  /** Готовый HTML-текст для Telegram. */
  text: string;
};

export type AgentSchedule = 'hourly' | 'daily';

export type Agent = {
  /** Технический id (в логах и в env-переключателе AGENT_<ID>_ENABLED). */
  id: string;
  /** Человекочитаемое имя — показываем в интерфейсе «ИИ-агенты». */
  name: string;
  /** Что делает — одной строкой. */
  role: string;
  schedule: AgentSchedule;
  /** Проверка условия. Пустой массив = агенту нечего сказать. */
  run: () => Promise<AgentMessage[]>;
};

/** Агент включён, если env AGENT_<ID>_ENABLED не равен '0'. По умолчанию включён. */
export function agentEnabled(id: string): boolean {
  const key = `AGENT_${id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_ENABLED`;
  return (process.env[key] ?? '1') !== '0';
}

/** МСК-дата YYYY-MM-DD — для ключей дедупа «раз в сутки». */
export function mskDay(): string {
  return new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10);
}
