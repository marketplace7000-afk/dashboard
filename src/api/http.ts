/**
 * ЕДИНАЯ ТОЧКА СЕТЕВЫХ ЗАПРОСОВ ФРОНТА.
 *
 * Зачем: до этого `fetch` вызывался в 30 файлах, каждый по-своему. Одно и то же
 * решение принималось заново в каждом месте — и каждый раз можно было забыть
 * деталь. Так и вышло:
 *   • забыли заголовок принудительного обновления → кнопка «Обновить» отдавала
 *     кэш, клиент видел вчерашние цены (жалоба 05.08);
 *   • забыли таймаут → оборванное соединение оставляло промис висеть навсегда,
 *     страница «вечно грузилась» (жалоба 11.08);
 *   • ошибку показывали вместо всей страницы или не показывали вовсе.
 *
 * Здесь это решено один раз. Новые вызовы делать ТОЛЬКО через apiGet/apiPost.
 */

/** Сколько ждём обычный запрос и сколько — принудительное обновление. */
const DEFAULT_TIMEOUT_MS = 45_000;
const FORCE_TIMEOUT_MS = 180_000;

export class ApiError extends Error {
  /** HTTP-код; 0 — до сервера не дошли (сеть, таймаут). */
  status: number;
  /** Истёк таймаут, а не отказ сервера — сообщение пользователю другое. */
  timedOut: boolean;
  constructor(message: string, status: number, timedOut = false) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.timedOut = timedOut;
  }
}

export type ApiResult<T> = {
  data: T;
  /** Возраст данных в секундах: сколько они пролежали в серверном кэше. */
  cacheAgeSec: number | null;
  /** Отдал ли сервер кэш и какой именно (HIT/MISS/STALE…). */
  cacheTag: string | null;
};

export type ApiOptions = {
  /** Принудительно перезапросить площадку, минуя серверный кэш. */
  force?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Дополнительные заголовки (например, x-wb-token для проверки токена). */
  headers?: Record<string, string>;
};

/**
 * Что делать, когда сессия истекла. Приложение подписывается один раз и
 * возвращает пользователя на экран входа — раньше каждый запрос молча получал
 * 401 и рисовал нули, будто бизнес встал (инцидент 11.08).
 */
let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: () => void): void {
  onUnauthorized = fn;
}

/**
 * Для модулей со своим fetch (отзывы, чаты, конкуренты, сборщики): на 401 тоже
 * вернуть на экран входа. Раньше там показывалось «HTTP 401» или пустота.
 */
export function notifyUnauthorized(status: number): void {
  if (status === 401) onUnauthorized?.();
}

async function request<T>(
  url: string,
  init: RequestInit,
  opts: ApiOptions = {},
): Promise<ApiResult<T>> {
  const timeout = opts.timeoutMs ?? (opts.force ? FORCE_TIMEOUT_MS : DEFAULT_TIMEOUT_MS);

  const headers: Record<string, string> = {
    ...(init.headers as Record<string, string> | undefined),
    ...opts.headers,
  };
  if (init.body !== undefined && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
  if (opts.force) headers['x-av-no-cache'] = '1';

  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers,
      credentials: 'include',
      signal: opts.signal ?? AbortSignal.timeout(timeout),
    });
  } catch (e: any) {
    const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    throw new ApiError(
      timedOut
        ? 'сервер не ответил вовремя — данные могут ещё собираться'
        : 'нет связи с сервером',
      0,
      timedOut,
    );
  }

  if (res.status === 401) {
    onUnauthorized?.();
    throw new ApiError('сессия истекла — нужно войти заново', 401);
  }

  const cacheAgeRaw = res.headers.get('x-av-cache-age');
  const meta = {
    cacheAgeSec: cacheAgeRaw != null ? Number(cacheAgeRaw) : null,
    cacheTag: res.headers.get('x-av-cache'),
  };

  if (!res.ok) {
    // Тело ошибки бывает и JSON, и HTML от nginx — вытаскиваем что-то читаемое.
    const text = await res.text().catch(() => '');
    let detail = text.slice(0, 200);
    try {
      const j = JSON.parse(text);
      // reason — человеческий текст (например, отказ по правам раздела), он важнее кода.
      detail = j?.reason ?? j?.error ?? j?.detail ?? detail;
    } catch {
      // Не JSON (HTML от nginx, пустое тело) — оставляем сырой текст. В журнал
      // не пишем: ошибка целиком уходит наверх в ApiError строкой ниже.
    }
    throw new ApiError(`сервер ответил ${res.status}${detail ? `: ${detail}` : ''}`, res.status);
  }

  // Успешный код, но не JSON — обычно HTML-заглушка nginx, пока сервер
  // перезапускается. Раньше это молча становилось null, и страница падала на
  // «Cannot read properties of null» (прожарка 20.10.2026).
  if (res.status === 204) return { data: null as T, ...meta };
  const text = await res.text().catch(() => '');
  let data: T;
  try { data = JSON.parse(text) as T; }
  catch { throw new ApiError('сервер вернул не данные — возможно, он перезапускается; попробуйте через минуту', res.status); }
  return { data, ...meta };
}

export function apiGet<T>(url: string, opts?: ApiOptions): Promise<ApiResult<T>> {
  return request<T>(url, { method: 'GET' }, opts);
}

export function apiPost<T>(url: string, body?: unknown, opts?: ApiOptions): Promise<ApiResult<T>> {
  return request<T>(url, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) }, opts);
}

/** Человеческий текст ошибки для интерфейса. */
export function errText(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  return String((e as Error)?.message ?? e);
}
