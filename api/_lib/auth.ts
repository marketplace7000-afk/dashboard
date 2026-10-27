/**
 * Простая password-auth для single-tenant дашборда.
 *
 * Логика:
 *   - В env: AUTH_PASSWORD (что вводит пользователь) + AUTH_SECRET (для HMAC подписи)
 *   - POST /api/auth/login { password } → если password === AUTH_PASSWORD, ставим
 *     httpOnly cookie `av_session=<base64payload>.<hmac>` на 7 дней
 *   - На любом защищённом endpoint вызываем requireAuth(req, res):
 *     • если cookie валидна и не протухла — пропускаем
 *     • иначе 401
 *   - Cookie подписана HMAC-SHA256 секретом — её нельзя подделать на стороне клиента
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { VercelRequest, VercelResponse } from '@vercel/node';

const COOKIE_NAME = 'av_session';
const TTL_DAYS = 7;

function hmac(input: string, secret: string): string {
  return createHmac('sha256', secret).update(input).digest('base64url');
}

function safeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch { return false; }
}

/**
 * uid/ver — личная учётка раздела «Склад» (api/_lib/sklad/users.ts): ver
 * сверяется с базой на каждом запросе, поэтому смена пароля, роли или
 * выключение пользователя гасят его сессии сразу. Без uid — вход по общему
 * паролю AUTH_PASSWORD (владелец), как было до «Склада».
 */
export type SessionPayload = { iat: number; exp: number; uid?: number; ver?: number; pv?: string; ov?: number };

/**
 * Сессия по общему паролю привязана к самому паролю (pv) и к счётчику
 * «выйти везде» (ov, kv owner_session_ver). Раньше её подписывал только
 * AUTH_SECRET, и смена AUTH_PASSWORD не выкидывала тех, кто уже вошёл:
 * cookie жила ещё 7 дней (27.10.2026 — сотрудники сидели под паролем владельца).
 */
function ownerPasswordTag(secret: string): string {
  return hmac(`owner-pw:${process.env.AUTH_PASSWORD ?? ''}`, secret).slice(0, 22);
}

export function ownerSessionVersion(): number {
  try { return Number(require('./sklad/db').kvGet('owner_session_ver') ?? 0) || 0; } catch { return 0; }
}

/** «Выйти везде» для входа по общему паролю. Возвращает новую версию. */
export function bumpOwnerSessionVersion(): number {
  const next = ownerSessionVersion() + 1;
  require('./sklad/db').kvSet('owner_session_ver', String(next));
  return next;
}

export function signSession(secret: string, user?: { uid: number; ver: number }): string {
  const payload: SessionPayload = {
    iat: Date.now(),
    exp: Date.now() + TTL_DAYS * 86_400_000,
    ...(user ? { uid: user.uid, ver: user.ver } : { pv: ownerPasswordTag(secret), ov: ownerSessionVersion() }),
  };
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = hmac(data, secret);
  return `${data}.${sig}`;
}

export function verifySession(token: string | undefined, secret: string): SessionPayload | null {
  if (!token || !secret) return null;
  const dot = token.lastIndexOf('.');
  if (dot < 0) return null;
  const data = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = hmac(data, secret);
  if (!safeEq(sig, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString()) as SessionPayload;
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch { return null; }
}

function readCookie(req: VercelRequest, name: string): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=');
  }
  return undefined;
}

export function setSessionCookie(res: VercelResponse, token: string) {
  const maxAge = TTL_DAYS * 86_400;
  const parts = [
    `${COOKIE_NAME}=${token}`,
    'Path=/',
    `Max-Age=${maxAge}`,
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (process.env.NODE_ENV === 'production') parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

export function clearSessionCookie(res: VercelResponse) {
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`,
  );
}

/**
 * Защита API-эндпоинта. Возвращает true если запрос авторизован, иначе
 * сама отправляет 401 и возвращает false — handler должен сделать `return`.
 *
 * Если AUTH_PASSWORD не задан в env (например, в dev) — авторизация выключена.
 * Это даёт удобный локальный dev и одновременно требует явного включения на проде.
 */
export function requireAuth(req: VercelRequest, res: VercelResponse): boolean {
  // Если password не сконфигурен — auth выключен (dev mode). На проде — наоборот,
  // закрываемся: потерянный при выкладке .env не должен открывать кабинет всем.
  if (!process.env.AUTH_PASSWORD) {
    if (authRequiredButMissing()) {
      res.status(503).json({ error: 'auth_not_configured' });
      return false;
    }
    return true;
  }

  const secret = process.env.AUTH_SECRET || process.env.AUTH_PASSWORD; // fallback на сам пароль если AUTH_SECRET не задан
  const cookie = readCookie(req, COOKIE_NAME);
  const session = verifySession(cookie, secret);
  if (!session) {
    res.status(401).json({ error: 'unauthorized' });
    return false;
  }
  if (session.uid !== undefined) {
    // Личная учётка: пользователь должен существовать, быть включён и иметь ту же версию сессии.
    let user: import('./sklad/users').AuthUser | null = null;
    try {
      user = require('./sklad/users').userForSession(session.uid, session.ver ?? 0);
    } catch (e) {
      console.warn('[auth] проверка личной учётки не удалась:', (e as Error).message);
    }
    if (!user) {
      res.status(401).json({ error: 'unauthorized' });
      return false;
    }
    (req as any).__avUser = user;
  } else if (session.pv !== ownerPasswordTag(secret) || (session.ov ?? 0) !== ownerSessionVersion()) {
    // Пароль владельца сменили или нажали «выйти везде» — старый вход недействителен.
    res.status(401).json({ error: 'unauthorized' });
    return false;
  }
  return true;
}

/**
 * Кто сделал запрос — вызывать после requireAuth. Вход по общему паролю
 * (и выключенная авторизация в dev) — владелец.
 */
export function authUser(req: VercelRequest): import('./sklad/users').AuthUser {
  return (req as any).__avUser ?? require('./sklad/users').OWNER_BY_PASSWORD;
}

/**
 * Прод без пароля входа — ошибка настройки, а не «режим разработки» (прожарка
 * 20.10.2026: стоило .env потеряться при выкладке, и кабинет с ключами WB/Ozon
 * на запись открывался всем). Признак прода — NODE_ENV=production.
 */
export function authRequiredButMissing(): boolean {
  return process.env.NODE_ENV === 'production' && !process.env.AUTH_PASSWORD;
}

/** Сравнение секретов без утечки по времени ответа (длина тоже не утекает). */
export function secretEquals(got: string, expected: string): boolean {
  if (!got || !expected) return false;
  const a = createHash('sha256').update(got).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

export function checkPassword(input: string): boolean {
  const expected = process.env.AUTH_PASSWORD;
  if (!expected) return false;
  return safeEq(input, expected);
}
