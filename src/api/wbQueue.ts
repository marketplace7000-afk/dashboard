/**
 * Очередь запросов к WB API с кэшированием.
 * Решает 429 Too Many Requests: запросы идут строго последовательно
 * с задержкой 600мс между ними, ответы кэшируются на 5 мин.
 */

const CACHE_TTL = 5 * 60 * 1000; // 5 мин
// Раньше держали 1200мс между запросами, чтобы не словить 429 от WB. Теперь
// браузер ходит ТОЛЬКО в наш кэш (cron-only), а не в WB напрямую — тормозить
// незачем. Грузим мгновенно, как Ozon.
const DELAY_MS = 0;

type CacheEntry = { data: any; ts: number };

const cache = new Map<string, CacheEntry>();
let busy: Promise<void> = Promise.resolve();

function cacheKey(url: string, opts?: RequestInit): string {
  return `${opts?.method ?? 'GET'}:${url}:${opts?.body ?? ''}`;
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

/**
 * Обёртка вокруг fetch для WB API:
 * - кэширует ответы на CACHE_TTL
 * - выстраивает запросы в очередь (последовательно, с задержкой)
 */
export async function wbFetch<T>(url: string, opts?: RequestInit, force = false): Promise<T> {
  const key = cacheKey(url, opts);

  // force — ручное «обновить сейчас»: минуем и свой кэш в браузере, и серверный.
  // Сервер по заголовку сходит в WB один раз по этому ключу (не чаще раза в 5 мин,
  // см. api/_proxy.ts). Нужно, чтобы клиент мог сверить сегодняшнюю цифру с кабинетом.
  if (force) {
    opts = { ...opts, headers: { ...(opts?.headers as Record<string, string>), 'x-av-no-cache': '1' } };
  } else {
    const cached = cache.get(key);
    if (cached && Date.now() - cached.ts < CACHE_TTL) {
      return cached.data as T;
    }
  }

  // Встаём в очередь
  const prev = busy;
  let resolve: () => void;
  busy = new Promise<void>((r) => { resolve = r; });

  await prev;

  try {
    await sleep(DELAY_MS);
    const res = await fetch(url, opts);
    const text = await res.text();
    if (res.status === 503 && text.includes('warming_up')) {
      throw new Error('Данные ещё загружаются фоновым сборщиком — обновятся автоматически в течение часа.');
    }
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 300)}`);
    let data: T;
    try { data = JSON.parse(text) as T; } catch { data = text as any; }

    cache.set(key, { data, ts: Date.now() });
    return data;
  } finally {
    resolve!();
  }
}

/** Сбросить весь кэш WB (при смене токена и т.п.) */
export function wbClearCache() {
  cache.clear();
}
