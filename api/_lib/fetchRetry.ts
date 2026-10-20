// fetch с авто-retry на 429 и 5xx. Используем на серверной стороне, чтобы
// браузер пользователя никогда не видел rate-limit ошибок WB/Ozon.
// 429 уважает Retry-After заголовок, дальше — exponential backoff.
//
// 13.10.2026: каждая попытка проходит общий шлюз (gateway.ts) — единую очередь
// с лимитами площадок для всех модулей сервера.
import { gate, note, GatewayBusy, type Priority } from './gateway';

export type FetchRetryOptions = {
  maxRetries?: number;
  backoff429Ms?: number;
  backoff5xxMs?: number;
  timeoutMs?: number;
  /** Очередь шлюза: 0 — действие, 1 — свежие данные (по умолчанию), 2 — история. */
  priority?: Priority;
};

/** Ответ «занято» от шлюза — выглядит как 429 площадки, чтобы вызывающие не менялись. */
function busyResponse(e: GatewayBusy): Response {
  return new Response(JSON.stringify({ error: 'rate_limited_locally', bucket: e.bucket, retryAfterSec: e.retryAfterSec }), {
    status: 429,
    headers: { 'Content-Type': 'application/json', 'X-Ratelimit-Retry': String(e.retryAfterSec), 'X-Av-Gateway': '1' },
  });
}

export async function fetchWithRetry(
  url: string,
  init: RequestInit = {},
  opts: FetchRetryOptions = {},
): Promise<Response> {
  const maxRetries = opts.maxRetries ?? 3;
  const base429 = opts.backoff429Ms ?? 5_000;
  const base5xx = opts.backoff5xxMs ?? 2_000;
  const timeoutMs = opts.timeoutMs ?? 60_000;

  let lastErr: any;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      await gate(url, opts.priority ?? 1);
    } catch (e) {
      if (e instanceof GatewayBusy) return busyResponse(e);
      throw e;
    }
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: ac.signal });
      clearTimeout(t);
      // Тело читают вызывающие (r.json()/r.text()) уже после возврата. Раньше таймаут
      // снимался на заголовках, и оборванный посередине ответ (финотчёт WB) висел
      // минутами. Даём на чтение тела ещё столько же; после чтения abort ничего не делает.
      const bodyTimer = setTimeout(() => ac.abort(), timeoutMs);
      (bodyTimer as any).unref?.();
      // WB отдаёт окно ожидания в X-Ratelimit-Retry (секунды), а НЕ в Retry-After.
      // Например sales-funnel: корзина 1 запрос, X-Ratelimit-Retry: 37. Читаем оба,
      // приоритет — WB-заголовку. +1с запас, чтобы корзина точно успела пополниться.
      const ra = parseInt(
        res.headers.get('x-ratelimit-retry') || res.headers.get('Retry-After') || '',
        10,
      );
      note(url, res.status, Number.isFinite(ra) ? ra : undefined);

      if (res.status === 429 || res.status === 503) {
        if (attempt >= maxRetries) return res;
        // Глобальный лимитер кабинета («global limiter, per seller») при перегрузе
        // просит ждать сотни/тысячи секунд (напр. 1360). Ждать столько inline нельзя,
        // а повторять во время штрафа — только продлевать его. Если окно больше нашего
        // потолка — сразу отдаём 429, вызывающий поставит cooldown и повторит позже.
        // ВАЖНО: потолок 200с, НЕ 120с. Штатное окно воронки WB = X-Ratelimit-Retry: 122
        // (лимит «1 запрос / ~2 мин на кабинет») — со старым порогом 120с мы сдавались
        // за 2 секунды до открытия окна, и прогрев analytics не проходил НИКОГДА.
        if (Number.isFinite(ra) && ra * 1000 > 200_000) return res;
        const delay = Number.isFinite(ra) && ra > 0
          ? ra * 1000 + 1_000
          : Math.min(120_000, base429 * Math.pow(1.5, attempt));
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      if (res.status >= 500 && res.status < 600) {
        if (attempt >= maxRetries) return res;
        const delay = Math.min(15_000, base5xx * Math.pow(2, attempt));
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      return res;
    } catch (e: any) {
      clearTimeout(t);
      lastErr = e;
      if (attempt >= maxRetries) throw e;
      const delay = Math.min(15_000, 1500 * Math.pow(2, attempt));
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastErr;
}
