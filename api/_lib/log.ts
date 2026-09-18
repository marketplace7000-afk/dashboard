/**
 * Журнал проглоченных ошибок.
 *
 * Пустой `catch {}` — самый дорогой способ сломать платформу: 31.07 из-за одного
 * такого перестал писаться дамп кэша, и это выяснилось почти через месяц. Правило
 * теперь простое: ошибку либо пробрасываем наверх, либо гасим — но с записью.
 *
 * Гасить приходится часто и в горячих циклах (строка отчёта, чанк, товар), поэтому
 * запись здесь с ограничением частоты: первый случай виден сразу, повторы за окно
 * копятся и попадают в журнал одной строкой «ещё N раз». Так журнал остаётся
 * читаемым, но ни одна ошибка не исчезает бесследно.
 *
 * Пишем в `console.warn`, а не в `console.log`: под systemd обычный вывод
 * буферизуется и в `journalctl` появляется с задержкой, stderr — сразу.
 */

const DEFAULT_THROTTLE_MS = 10 * 60_000;

type Slot = { last: number; skipped: number };
// Общий стор на процесс: под tsx один и тот же модуль грузится дважды (ESM для
// server.ts и CJS для api/), и у каждого инстанса иначе был бы свой счётчик —
// журнал получал бы дубли. См. тот же приём в cache.ts.
const slots = ((process as any).__AV_LOG_SLOTS__ ??= new Map<string, Slot>()) as Map<string, Slot>;

/** Человеческий текст ошибки: message, если он есть, иначе сериализация. */
export function errText(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  if (typeof err === 'string') return err;
  try { return JSON.stringify(err); } catch { return String(err); }
}

/**
 * Записать ошибку, которую мы намеренно не пробрасываем наверх.
 *
 * @param scope  модуль-источник, попадёт в квадратные скобки: 'cache', 'wb-funnel'
 * @param what   что именно не получилось, на русском и без переменных данных —
 *               строка служит ключом группировки, поэтому в неё нельзя
 *               подставлять id/даты, иначе ограничение частоты не сработает
 * @param err    сама ошибка
 * @param throttleMs  окно группировки повторов, по умолчанию 10 минут
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
