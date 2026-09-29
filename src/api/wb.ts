// WB API клиент с раздельными JWT-токенами по областям доступа.
// Токены хранятся в localStorage (ключи ниже) или подхватываются из
// import.meta.env.VITE_WB_TOKEN_<SCOPE> при сборке.
//
// Безопасность: НЕ коммитим токены в репозиторий. Для прод/staging — env vars.
// Для локальной разработки — Настройки → WB-токены (UI добавлен ниже).
import { noteSwallowed } from '../utils/log';

export type WbScope =
  | 'stats'      // Статистика — заказы, продажи, остатки
  | 'prices'    // Цены и скидки
  | 'analytics'  // Аналитика — отчёты, поиск по SKU
  | 'promotion'  // Продвижение — реклама
  | 'supplies';  // Поставки — приёмки, FBO

const LS_PREFIX = 'av_wb_token_';

const ENV_KEYS: Record<WbScope, string> = {
  stats:     'VITE_WB_TOKEN_STATS',
  prices:    'VITE_WB_TOKEN_PRICES',
  analytics: 'VITE_WB_TOKEN_ANALYTICS',
  promotion: 'VITE_WB_TOKEN_PROMOTION',
  supplies:  'VITE_WB_TOKEN_SUPPLIES',
};

// Пути к нашему backend proxy. В prod это Vercel Functions с кэшем + retry,
// в dev (vercel dev) — то же самое. Vite-proxy для тех же путей пробрасывает
// напрямую к WB hosts (без серверного кэша) — для упрощённой локалки.
// Токены подставляет backend из env WB_TOKEN / WB_TOKEN_<SCOPE>.
export const WB_HOSTS: Record<WbScope, string> = {
  stats:     '/wb/statistics',
  prices:    '/wb/discounts',
  analytics: '/wb/analytics',
  promotion: '/wb/promotion',
  supplies:  '/wb/supplies',
};

export const SCOPE_LABEL: Record<WbScope, string> = {
  stats:     'Статистика',
  prices:    'Цены и скидки',
  analytics: 'Аналитика',
  promotion: 'Продвижение',
  supplies:  'Поставки',
};

// Порядок фолбэка — какие другие scope-поля проверять, если в нужном пусто.
// Логика: WB-токены часто универсальные (один JWT с 5+ битами scope),
// поэтому если для нужной области нет — пробуем любой непустой токен.
const FALLBACK_ORDER: WbScope[] = ['stats', 'prices', 'analytics', 'promotion', 'supplies'];

function readTokenStrict(scope: WbScope): string | null {
  const fromLS = localStorage.getItem(LS_PREFIX + scope);
  // 18.09.2026: Chrome подставил в эти поля сохранённый пароль сайта (автозаполнение) — токен WB короче 40 символов
  // быть не может: такое значение стираем, и сервер берёт WB_TOKEN из .env.
  if (fromLS && fromLS.trim().length >= 40) return fromLS;
  if (fromLS) localStorage.removeItem(LS_PREFIX + scope);
  const envKey = ENV_KEYS[scope];
  const envVal = (import.meta.env as Record<string, string | undefined>)[envKey];
  return envVal || null;
}

export function getWbToken(scope: WbScope): string | null {
  const own = readTokenStrict(scope);
  if (own) return own;
  // Универсальный фолбэк: берём первый непустой токен из любого scope.
  // Если scope-биты в JWT не включают нужное право — реальный fetch вернёт 401/403,
  // и WbAuthError честно скажет об этом.
  for (const s of FALLBACK_ORDER) {
    if (s === scope) continue;
    const t = readTokenStrict(s);
    if (t) return t;
  }
  return null;
}

export function setWbToken(scope: WbScope, token: string | null) {
  if (token && token.trim()) localStorage.setItem(LS_PREFIX + scope, token.trim());
  else localStorage.removeItem(LS_PREFIX + scope);
}

export function getAllWbTokens(): Record<WbScope, string | null> {
  return {
    stats:     getWbToken('stats'),
    prices:    getWbToken('prices'),
    analytics: getWbToken('analytics'),
    promotion: getWbToken('promotion'),
    supplies:  getWbToken('supplies'),
  };
}

export class WbAuthError extends Error {
  scope: WbScope;
  constructor(scope: WbScope, message: string) {
    super(message);
    this.scope = scope;
    this.name = 'WbAuthError';
  }
}

// ─── Лимиты WB (по news/281) ───────────────────────────────────────────────
// Хранят минимальный интервал между запросами на scope. Статистика — 1 req/min,
// promotion — 5 req/sec, остальные — 10 req/sec. Все эти лимиты per-эндпоинт,
// но мы используем общий per-scope троттлинг как безопасный compromise.
// Интервалы между запросами per-scope. РАНЬШЕ тут стояли 6-20 сек — защита от
// анти-burst WB, когда браузер ходил в WB НАПРЯМУЮ. Сейчас режим cron-only:
// браузер ходит ТОЛЬКО в наш кэш (отвечает мгновенно), в WB не стучится вообще,
// поэтому клиентский тормоз лишь искусственно замедлял загрузку (реклама ждала
// 10с, аналитика 20с на ровном месте). Обнулено — читаем свой кэш без пауз, как
// Ozon. Настоящий лимит WB держит серверный сборщик (api/route.ts handleCron).
const MIN_INTERVAL_MS: Record<WbScope, number> = {
  stats:     0,
  prices:    0,
  analytics: 0,
  promotion: 0,
  supplies:  0,
};

// После 429 — увеличенная пауза перед следующей попыткой
const POST_429_BACKOFF_MS: Record<WbScope, number> = {
  stats:     30000,
  prices:    5000,
  analytics: 60000,
  promotion: 60000,  // 1 минута после 429 на /adv/*
  supplies:  5000,
};

const lastCall: Record<WbScope, number> = {
  stats: 0, prices: 0, analytics: 0, promotion: 0, supplies: 0,
};

// Сериализатор per-scope: следующий запрос ждёт пока пройдёт MIN_INTERVAL_MS
// после предыдущего и пока разрешится текущий queue.
const queues: Record<WbScope, Promise<unknown>> = {
  stats: Promise.resolve(), prices: Promise.resolve(),
  analytics: Promise.resolve(), promotion: Promise.resolve(),
  supplies: Promise.resolve(),
};

function nextSlot(scope: WbScope): Promise<void> {
  const job = queues[scope].then(async () => {
    const wait = lastCall[scope] + MIN_INTERVAL_MS[scope] - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastCall[scope] = Date.now();
  });
  queues[scope] = job.catch(() => undefined);
  return job;
}

// Универсальный fetch к WB API с rate limit + retry на 429/5xx.
// Передавай относительный путь — будет добавлен к WB_HOSTS[scope].
// Или абсолютный URL — будет использован как есть.
export class WbRateLimitError extends Error {
  scope: WbScope;
  constructor(scope: WbScope, message: string) {
    super(message);
    this.scope = scope;
    this.name = 'WbRateLimitError';
  }
}

export async function wbFetch(
  scope: WbScope,
  path: string,
  init: RequestInit = {},
  opts: { maxRetries?: number; noRetryOn429?: boolean } = {},
): Promise<any> {
  // На прод-режиме (через /wb/<scope>/* proxy) токен подставляется на сервере.
  // На локалке через vite-proxy — тоже. Поэтому Authorization из браузера НЕ
  // отправляем; сервер сам подставит из WB_TOKEN / WB_TOKEN_<SCOPE>.
  // Если у клиента есть свой токен (для UI тестов разных аккаунтов) — кладём
  // его в спец-заголовок X-Wb-Token, сервер прокинет.
  const clientToken = getWbToken(scope);

  const url = path.startsWith('http') ? path : WB_HOSTS[scope] + path;
  const maxRetries = opts.maxRetries ?? 3;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    await nextSlot(scope);

    const headers = new Headers(init.headers);
    if (clientToken) headers.set('X-Wb-Token', clientToken);
    if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');

    const res = await fetch(url, { ...init, headers });

    // Наш cache-only «прогрев»: данных в кэше ещё нет. НЕ ретраим (иначе висим
    // секундами на ровном месте) — сразу отдаём как «нет данных».
    if (res.status === 503) {
      const text = await res.text().catch(() => '');
      if (text.includes('warming_up')) {
        throw new WbRateLimitError(scope, 'Данные ещё загружаются фоновым сборщиком.');
      }
      if (attempt < maxRetries) {
        await new Promise(r => setTimeout(r, Math.min(15000, 2000 * Math.pow(1.5, attempt))));
        continue;
      }
      throw new Error(`WB 503 ${SCOPE_LABEL[scope]}: ${text.slice(0, 200)}`);
    }

    if (res.status === 401 || res.status === 403) {
      throw new WbAuthError(scope, `WB ${res.status}: токен невалиден или нет прав (${SCOPE_LABEL[scope]})`);
    }

    if (res.status === 429) {
      // На 429 для anti-burst шлюзов (особенно /adv/*) ретрай только разрушает.
      // Если noRetryOn429 — бросаем сразу понятной ошибкой и блокируем scope на 60 сек.
      if (opts.noRetryOn429 || attempt >= maxRetries) {
        lastCall[scope] = Date.now() + POST_429_BACKOFF_MS[scope] - MIN_INTERVAL_MS[scope];
        throw new WbRateLimitError(scope, `WB 429 — лимит превышен. Подожди ~60 сек и попробуй снова.`);
      }
      // WB шлёт окно ожидания в X-Ratelimit-Retry (секунды), а не в Retry-After.
      const ra = parseInt(res.headers.get('x-ratelimit-retry') || res.headers.get('Retry-After') || '', 10);
      const delay = (Number.isFinite(ra) && ra > 0) ? ra * 1000 + 1_000 : POST_429_BACKOFF_MS[scope];
      lastCall[scope] = Date.now() + delay - MIN_INTERVAL_MS[scope];
      console.warn(`[wb:${scope}] 429, retry через ${delay}ms (attempt ${attempt + 1}/${maxRetries})`);
      await new Promise(r => setTimeout(r, delay));
      continue;
    }

    if (res.status >= 500 && res.status < 600) {
      if (attempt < maxRetries) {
        const delay = Math.min(15000, 2000 * Math.pow(1.5, attempt));
        console.warn(`[wb:${scope}] ${res.status}, retry через ${delay}ms (attempt ${attempt + 1}/${maxRetries})`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`WB ${res.status} ${SCOPE_LABEL[scope]}: ${text.slice(0, 240)}`);
    }

    const ct = res.headers.get('content-type') || '';
    return ct.includes('application/json') ? res.json() : res.text();
  }

  throw new Error(`WB ${SCOPE_LABEL[scope]}: исчерпаны ${maxRetries} попыток`);
}

// ─── localStorage TTL-кэш ──────────────────────────────────────────────────
// Спасает от 429 при перезагрузке страницы и от случайных кликов «обновить»:
// возвращает свежий снимок из кэша если ему меньше N мс.
const CACHE_PREFIX = 'av_wb_cache_';

export type CachedResponse<T = any> = {
  data: T;
  fetchedAt: number;
  ttlMs: number;
};

function cacheKey(scope: WbScope, path: string, init?: RequestInit): string {
  const method = init?.method || 'GET';
  const body = typeof init?.body === 'string' ? init.body : '';
  return CACHE_PREFIX + scope + ':' + method + ':' + path + (body ? ':' + body.slice(0, 100) : '');
}

export function readCache<T = any>(scope: WbScope, path: string, init?: RequestInit): CachedResponse<T> | null {
  try {
    const raw = localStorage.getItem(cacheKey(scope, path, init));
    if (!raw) return null;
    return JSON.parse(raw) as CachedResponse<T>;
  } catch { return null; }
}

export function isCacheFresh(c: CachedResponse | null): boolean {
  if (!c) return false;
  return Date.now() - c.fetchedAt < c.ttlMs;
}

export function clearCache(scope?: WbScope) {
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const k = localStorage.key(i);
    if (!k || !k.startsWith(CACHE_PREFIX)) continue;
    if (!scope || k.startsWith(CACHE_PREFIX + scope + ':')) localStorage.removeItem(k);
  }
}

// wbFetch + кэширование. Если в кэше есть свежие данные (моложе ttlMs) и
// force=false — возвращаем их БЕЗ запроса. Иначе делаем запрос и сохраняем.
export async function wbFetchCached<T = any>(
  scope: WbScope,
  path: string,
  opts: { ttlMs?: number; force?: boolean; init?: RequestInit; noRetryOn429?: boolean } = {},
): Promise<{ data: T; fromCache: boolean; fetchedAt: number }> {
  const ttlMs = opts.ttlMs ?? 5 * 60_000; // 5 минут по умолчанию
  const init = opts.init;
  const cached = readCache<T>(scope, path, init);
  if (!opts.force && isCacheFresh(cached)) {
    return { data: cached!.data, fromCache: true, fetchedAt: cached!.fetchedAt };
  }
  const data = await wbFetch(scope, path, init, { noRetryOn429: opts.noRetryOn429 });
  const payload: CachedResponse<T> = { data, fetchedAt: Date.now(), ttlMs };
  // Переполнение localStorage: ответ отдадим, но кэш молча перестанет работать,
  // и каждый заход будет заново дёргать API WB с его лимитами.
  try { localStorage.setItem(cacheKey(scope, path, init), JSON.stringify(payload)); }
  catch (e) { noteSwallowed('wb', 'ответ не закэширован', e); }
  return { data, fromCache: false, fetchedAt: payload.fetchedAt };
}
