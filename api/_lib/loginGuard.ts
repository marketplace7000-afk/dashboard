/**
 * Защита входа от подбора пароля (прожарка 20.10.2026).
 *
 * Раньше после неверного пароля была только пауза 0,8 с, а параллельные
 * запросы ничем не ограничивались — пароль можно было перебирать тысячами в
 * минуту. Теперь считаем неудачи отдельно по адресу и по логину: 5 неудач с
 * адреса за 15 минут — вход с него закрыт на 15 минут. По логину порог выше
 * (30): иначе чужой человек мог бы нарочно запереть владельца пятью попытками,
 * а 30 всё равно не дают перебирать пароль с множества адресов.
 * Удачный вход обнуляет счётчик. Хранится в памяти процесса: после рестарта
 * счётчики сбрасываются, для одного сервера этого достаточно.
 */
import type { VercelRequest } from '@vercel/node';

const MAX_FAILS_IP = 5;
const MAX_FAILS_LOGIN = 30;
const WINDOW_MS = 15 * 60_000;
const MAX_KEYS = 10_000;   // чтобы перебор с тысяч адресов не раздул память

type Entry = { fails: number; first: number; lockedUntil: number };
const store: Map<string, Entry> =
  ((process as any).__AV_LOGIN_GUARD__ ??= new Map<string, Entry>());

/** Адрес клиента: за nginx — X-Real-IP (nginx ставит его сам, клиент подменить не может). */
export function clientIp(req: VercelRequest): string {
  const real = req.headers['x-real-ip'];
  const ip = (Array.isArray(real) ? real[0] : real) || (req as any).socket?.remoteAddress || 'unknown';
  return String(ip).trim();
}

function keys(ip: string, login: string): string[] {
  return [`ip:${ip}`, `login:${(login || 'owner').toLowerCase()}`];
}

function prune(now: number): void {
  if (store.size < MAX_KEYS) return;
  for (const [k, e] of store) if (e.lockedUntil < now && now - e.first > WINDOW_MS) store.delete(k);
}

/** Сколько секунд ещё ждать, если вход закрыт; 0 — можно пробовать. */
export function loginLockedFor(ip: string, login: string, now = Date.now()): number {
  let wait = 0;
  for (const k of keys(ip, login)) {
    const e = store.get(k);
    if (e && e.lockedUntil > now) wait = Math.max(wait, Math.ceil((e.lockedUntil - now) / 1000));
  }
  return wait;
}

export function noteLoginFailure(ip: string, login: string, now = Date.now()): void {
  prune(now);
  for (const k of keys(ip, login)) {
    const e = store.get(k);
    if (!e || now - e.first > WINDOW_MS) { store.set(k, { fails: 1, first: now, lockedUntil: 0 }); continue; }
    e.fails++;
    if (e.fails >= (k.startsWith('ip:') ? MAX_FAILS_IP : MAX_FAILS_LOGIN)) {
      e.lockedUntil = now + WINDOW_MS;
      console.warn(`[auth] вход закрыт на 15 мин: ${k} (${e.fails} неудач)`);
    }
  }
}

export function noteLoginSuccess(ip: string, login: string): void {
  for (const k of keys(ip, login)) store.delete(k);
}
