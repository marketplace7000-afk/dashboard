/**
 * Тот же журнал проглоченных ошибок, что и на сервере (api/_lib/log.ts), только
 * для браузера: пишем в консоль вкладки.
 *
 * Фронт глотает ошибки чаще бэкенда — почти каждый необязательный блок на
 * странице обёрнут в try/catch, чтобы не уронить остальной экран. Это правильно,
 * но след оставлять обязательно: иначе «у меня пустая таблица» невозможно
 * разобрать по скриншоту от клиента.
 *
 * Повторы группируются по паре scope+what, чтобы цикл по товарам не залил консоль.
 */

const DEFAULT_THROTTLE_MS = 5 * 60_000;

type Slot = { last: number; skipped: number };
const slots = new Map<string, Slot>();

/** Человеческий текст ошибки: message, если он есть, иначе сериализация. */
export function errText(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  if (typeof err === 'string') return err;
  try { return JSON.stringify(err); } catch { return String(err); }
}

/**
 * Записать ошибку, которую мы намеренно не пробрасываем наверх.
 *
 * `what` — ключ группировки, поэтому без подстановок id и дат.
 */
export function noteSwallowed(scope: string, what: string, err: unknown, throttleMs = DEFAULT_THROTTLE_MS): void {
  const key = `${scope}|${what}`;
  const now = Date.now();
  const slot = slots.get(key);
  if (slot && now - slot.last < throttleMs) { slot.skipped++; return; }
  const repeats = slot?.skipped ?? 0;
  slots.set(key, { last: now, skipped: 0 });
  const window = throttleMs >= 60_000 ? `${Math.round(throttleMs / 60_000)} мин` : `${Math.round(throttleMs / 1000)} с`;
  const tail = repeats ? ` (+ещё ${repeats} за ${window})` : '';
  console.warn(`[${scope}] ${what}: ${errText(err)}${tail}`);
}
