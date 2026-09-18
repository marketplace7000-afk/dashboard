/**
 * Авторизация Telegram Mini App по проверенному Telegram-ID (вместо пароля).
 *
 * Как это работает: при открытии мини-аппы Telegram кладёт в
 * `window.Telegram.WebApp.initData` строку (query-string), ПОДПИСАННУЮ токеном
 * нашего бота. Здесь мы проверяем подпись по официальному алгоритму Telegram,
 * убеждаемся, что данные свежие, и сверяем user.id с белым списком
 * TELEGRAM_ALLOWED_IDS. Только после этого route.ts выдаёт ту же cookie
 * `av_session`, что и при входе по паролю.
 *
 * Подделать initData без токена бота нельзя — подпись завязана на него.
 * См. https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export type TgUser = { id: number; username?: string; first_name?: string };

// Одним типом с опциональными полями (а не discriminated union): в api/tsconfig
// strict:false, поэтому сужение по булеву дискриминанту (ok:true|false) не
// работает — литералы схлопываются в boolean. С опциональными полями доступ
// валиден в любой ветке.
export type TgValidationReason = 'no_token' | 'bad_initdata' | 'bad_hash' | 'expired' | 'no_user';
export type TgValidationResult = { ok: boolean; user?: TgUser; reason?: TgValidationReason };

// Сколько живёт initData. Telegram кладёт auth_date (unix-секунды). Старше суток
// не принимаем — защита от перехвата и переигровки старой строки.
const MAX_AGE_MS = 24 * 60 * 60_000;

function safeEqHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try { return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex')); }
  catch { return false; }
}

/**
 * Проверяет подпись initData и возвращает пользователя Telegram.
 * НЕ проверяет белый список — это делает isAllowedTgId() отдельно,
 * чтобы можно было залогировать «кто стучался, но не в списке».
 */
export function validateInitData(initData: string, botToken: string): TgValidationResult {
  if (!botToken) return { ok: false, reason: 'no_token' };
  if (!initData || typeof initData !== 'string') return { ok: false, reason: 'bad_initdata' };

  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return { ok: false, reason: 'bad_initdata' };

  // data_check_string: все пары кроме hash, отсортированы по ключу, "key=value"\n.
  params.delete('hash');
  const dataCheckString = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join('\n');

  // secret_key = HMAC_SHA256(key="WebAppData", message=bot_token)
  const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const computed = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  if (!safeEqHex(computed, hash)) return { ok: false, reason: 'bad_hash' };

  // Свежесть
  const authDate = Number(params.get('auth_date') || 0);
  if (!authDate || Date.now() - authDate * 1000 > MAX_AGE_MS) {
    return { ok: false, reason: 'expired' };
  }

  // user — это JSON-строка внутри initData
  let user: TgUser;
  try {
    user = JSON.parse(params.get('user') || '');
  } catch { return { ok: false, reason: 'no_user' }; }
  if (!user || typeof user.id !== 'number') return { ok: false, reason: 'no_user' };

  return { ok: true, user };
}

/** Разбирает TELEGRAM_ALLOWED_IDS ("123,456") в множество строк. */
export function allowedTgIds(): Set<string> {
  const raw = (process.env.TELEGRAM_ALLOWED_IDS || '').trim();
  return new Set(
    raw.split(/[,\s]+/).map(s => s.trim()).filter(Boolean),
  );
}

export function isAllowedTgId(id: number | string): boolean {
  const allow = allowedTgIds();
  // Пустой список = доступ закрыт для всех (fail-safe). Открыть можно только
  // явно перечислив ID в env.
  if (allow.size === 0) return false;
  return allow.has(String(id));
}
