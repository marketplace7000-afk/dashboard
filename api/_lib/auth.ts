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
import { createHmac, timingSafeEqual } from 'node:crypto';
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

export type SessionPayload = { iat: number; exp: number };

export function signSession(secret: string): string {
  const payload: SessionPayload = {
    iat: Date.now(),
    exp: Date.now() + TTL_DAYS * 86_400_000,
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
  // Если password не сконфигурен — auth выключен (dev mode)
  if (!process.env.AUTH_PASSWORD) return true;

  const secret = process.env.AUTH_SECRET || process.env.AUTH_PASSWORD; // fallback на сам пароль если AUTH_SECRET не задан
  const cookie = readCookie(req, COOKIE_NAME);
  const session = verifySession(cookie, secret);
  if (!session) {
    res.status(401).json({ error: 'unauthorized' });
    return false;
  }
  return true;
}

export function checkPassword(input: string): boolean {
  const expected = process.env.AUTH_PASSWORD;
  if (!expected) return false;
  return safeEq(input, expected);
}
