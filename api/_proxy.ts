/**
 * Универсальный обработчик прокси для WB и Ozon API.
 * Вызывается из api/wb/[...slug].ts и api/ozon/[...slug].ts.
 *
 * Что делает:
 *  - Подставляет credentials из env (никогда не попадают в браузер)
 *  - Ретраит на 429/5xx с backoff (юзер не видит rate-limit ошибки)
 *  - Кэширует ответы в Vercel KV (если подключен) или in-memory
 *  - Если апстрим лежит — отдаёт stale-кэш как fallback
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { fetchWithRetry } from './_lib/fetchRetry';
import {
  cacheGet, cacheSet, isFresh, makeUpstreamCacheKey, makeUpstreamCachePrefix,
  cacheGetNearestWindow, cacheWarmedWindows, windowKeyFor,
} from './_lib/cache';

type Upstream = {
  base: string;
  headers: Record<string, string>;
  // Какой serverside-TTL применять. Если 0 — не кэшируем.
  cacheTtlMs?: number;
  // Режим кэша для браузерных запросов:
  //  - 'cron-only' (WB): браузер НИКОГДА не ходит в upstream. Кэш наполняет только
  //    cron. Нет кэша → 503 «прогрев». Полностью защищает драконовские лимиты WB.
  //  - 'swr' (Ozon): отдаём свежий кэш сразу; если протух/нет — подтягиваем из
  //    upstream, но не чаще SWR_GATE_MS на ключ (single-flight), чтобы рефреши
  //    страницы не штормили API. Бэк не ходит в Ozon «на каждое обновление».
  cacheMode?: 'cron-only' | 'swr';
};

// Гейт single-flight для SWR (Ozon): не дёргаем один и тот же датасет из upstream
// чаще, чем раз в SWR_GATE_MS, и не запускаем параллельные одинаковые запросы.
const SWR_GATE_MS = 30 * 60_000;
const swrLastTry = new Map<string, number>();
const swrInflight = new Map<string, Promise<{ status: number; ct: string; text: string } | null>>();

// ─── Ручное обновление одного датасета (режим cron-only) ────────────────────
// Клиент просил, чтобы сегодняшнюю цифру можно было сверить с кабинетом по
// требованию. Раньше это было невозможно: ветка cron-only игнорировала заголовок
// x-av-no-cache и всегда отдавала кэш, а единственной альтернативой был ?force=1
// на кроне — он снимает все гейты сразу и бьёт по всему кабинету WB.
//
// Здесь — один запрос к площадке по ОДНОМУ ключу, не чаще раза в 5 минут.
// По лимитам WB это безопасно даже для тяжёлых методов (воронка ~1 запрос/2 мин
// на кабинет), а ретраи отключены: повторный тычок после 429 только раздувает
// штраф (WB растит окно с 37с до 11–22 мин).
const MANUAL_GATE_MS = 5 * 60_000;
const manualLastTry = new Map<string, number>();
const manualInflight = new Map<string, Promise<{ status: number; ct: string; text: string } | null>>();

// Query-строка для upstream/ключа кэша БЕЗ служебного `p`. На self-host server.ts
// переписывает req.url в `/api/route?p=<полный-путь>&<origQs>`, поэтому наивное
// `req.url.split('?')[1]` захватывает routing-параметр `p` и отравляет ключ кэша
// (`...:?p=wb/analytics/...:o0s7` вместо чистого `...:o0s7`) → вечный промах и 503.
// Удаляем `p`, остальные параметры сохраняем как есть. На Vercel `p` в req.url нет
// (он в req.query через rewrite), поэтому фикс безопасен и там.
export function upstreamQs(req: VercelRequest): string {
  const qi = req.url?.indexOf('?') ?? -1;
  if (qi < 0) return '';
  // Убираем ТОЛЬКО служебный p=<path>, остальные параметры оставляем БАЙТ-В-БАЙТ.
  // ВАЖНО: не прогонять через URLSearchParams — он ре-энкодит запятые (,→%2C),
  // из-за чего ключ кэша fullstats (ids=1,2,3) не совпадал с прогретым cron'ом.
  // Значение p не содержит '&' (это путь со слэшами), поэтому split по '&' безопасен.
  const parts = req.url!.slice(qi + 1).split('&').filter(p => p !== '' && !p.startsWith('p='));
  return parts.length ? '?' + parts.join('&') : '';
}

export async function handleProxy(
  req: VercelRequest,
  res: VercelResponse,
  upstream: Upstream,
  rest: string,
  cacheNamespace?: string,
) {
  const qs = upstreamQs(req);
  const url = `${upstream.base}/${rest}${qs}`;
  const method = (req.method ?? 'GET').toUpperCase();

  const headers: Record<string, string> = { ...upstream.headers };
  if (method !== 'GET' && req.headers['content-type']) {
    headers['Content-Type'] = String(req.headers['content-type']);
  }

  let body: string | undefined;
  if (method !== 'GET' && req.body) {
    body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
  }

  // Cache только для GET и POST с body (для POST body учитывается в ключе).
  // Ключ нормализован по датам (см. makeUpstreamCacheKey): запрос за день/неделю/
  // месяц к одному эндпоинту попадает в один прогретый кроном датасет.
  const ttl = upstream.cacheTtlMs ?? 0;
  const noCache = req.headers['x-av-no-cache'] === '1';
  const isCacheable = ttl > 0 && (method === 'GET' || method === 'POST');
  const cacheKey = isCacheable
    ? makeUpstreamCacheKey(cacheNamespace, method, rest, qs, body)
    : null;

  const serveCached = (c: { data: { status: number; ct: string; text: string }; fetchedAt: number }, tag: string) => {
    res.setHeader('x-av-cache', tag);
    res.setHeader('x-av-cache-age', String(Math.round((Date.now() - c.fetchedAt) / 1000)));
    res.status(c.data.status);
    res.setHeader('content-type', c.data.ct);
    return res.send(c.data.text);
  };
  const warming = (extra?: Record<string, unknown>) => {
    res.setHeader('x-av-cache', 'WARMING');
    return res.status(503).json({
      error: 'warming_up',
      namespace: cacheNamespace ?? null,
      detail: 'Данные ещё загружаются. Браузер не обращается к WB/Ozon напрямую — данные тянет фоновый сборщик.',
      ...extra,
    });
  };

  // ─── Режим 'cron-only' (WB) ──────────────────────────────────────────────
  // Браузер НИКОГДА не идёт в upstream. Кэш наполняет только cron. Нет кэша → 503.
  if (upstream.cacheMode === 'cron-only') {
    // Ручное «обновить сейчас»: один поход в площадку по этому ключу, с гейтом.
    if (noCache && cacheKey) {
      const waited = Date.now() - (manualLastTry.get(cacheKey) ?? 0);
      let p = manualInflight.get(cacheKey);
      if (!p && waited >= MANUAL_GATE_MS) {
        manualLastTry.set(cacheKey, Date.now());
        p = (async () => {
          try {
            // Без ретраев: после 429 повторный тычок только увеличивает штраф WB.
            const r = await fetchWithRetry(url, { method, headers, body }, { maxRetries: 0 });
            const text = await r.text();
            const ct = r.headers.get('content-type') ?? 'application/json';
            if (r.ok) await cacheSet(cacheKey, { status: r.status, ct, text }, ttl);
            return { status: r.status, ct, text };
          } catch { return null; }
          finally { manualInflight.delete(cacheKey); }
        })();
        manualInflight.set(cacheKey, p);
      }
      if (p) {
        const fresh = await p;
        if (fresh && fresh.status < 400) {
          res.setHeader('x-av-cache', 'MANUAL');
          res.setHeader('x-av-cache-age', '0');
          res.status(fresh.status);
          res.setHeader('content-type', fresh.ct);
          return res.send(fresh.text);
        }
        // Площадка не дала (429/5xx/сеть) — честно говорим об этом заголовком,
        // а данные ниже отдадим из кэша, чтобы экран не опустел.
        res.setHeader('x-av-manual', fresh ? `upstream_${fresh.status}` : 'upstream_unreachable');
      } else {
        // Гейт закрыт — сообщаем, через сколько секунд можно повторить.
        res.setHeader('x-av-manual', 'throttled');
        res.setHeader('x-av-manual-retry-after', String(Math.ceil((MANUAL_GATE_MS - waited) / 1000)));
      }
    }

    if (cacheKey) {
      const cached = await cacheGet<{ status: number; ct: string; text: string }>(cacheKey);
      if (cached) return serveCached(cached, isFresh(cached) ? 'HIT' : 'STALE');

      // Точное окно не прогрето. Берём ближайшее ТОЙ ЖЕ ДЛИНЫ — сдвиг по смещению
      // законен (сборщик грел вечером, браузер спрашивает утром). А вот окно другой
      // длины подставлять нельзя: раньше запрос за день мог получить месячный
      // датасет, потому что все периоды лежат под одним префиксом. Именно так
      // «дашборд показывал одно, разделы другое» (телемост 11.08).
      const prefix = makeUpstreamCachePrefix(cacheNamespace, method, rest, qs, body);
      const want = windowKeyFor(qs, body);
      const near = cacheGetNearestWindow<{ status: number; ct: string; text: string }>(prefix, want);
      if (near) {
        // Отдаём период явно — чтобы интерфейс мог подписать, за какие даты цифры,
        // а не выдавать чужое окно за запрошенное.
        res.setHeader('x-av-window-requested', want || '—');
        res.setHeader('x-av-window-served', near.window);
        return serveCached(near.entry, 'STALE-NEAR');
      }
      // Ничего подходящего нет. Молчать нельзя — лучше видимый пропуск, чем
      // правдоподобное неверное число. Говорим, какие окна прогреты.
      return warming({
        requestedWindow: want || null,
        warmedWindows: cacheWarmedWindows(prefix),
      });
    }
    return warming();
  }

  // ─── Режим 'swr' (Ozon) ──────────────────────────────────────────────────
  // Свежий кэш — сразу. Протух/нет — подтягиваем из upstream, но не чаще
  // SWR_GATE_MS на ключ и без параллельных дублей (single-flight). Рефреши
  // страницы не штормят Ozon: реальный поход к API максимум раз в 30 мин на датасет.
  if (upstream.cacheMode === 'swr') {
    const cached = cacheKey ? await cacheGet<{ status: number; ct: string; text: string }>(cacheKey) : null;
    if (cached && isFresh(cached)) return serveCached(cached, 'HIT');
    if (!cacheKey) { /* не кэшируемо — провалимся в обычный fetch ниже */ }
    else {
      const gateOpen = Date.now() - (swrLastTry.get(cacheKey) ?? 0) >= SWR_GATE_MS;
      let p = swrInflight.get(cacheKey);
      if (!p && gateOpen) {
        swrLastTry.set(cacheKey, Date.now());
        p = (async () => {
          try {
            const r = await fetchWithRetry(url, { method, headers, body });
            const text = await r.text();
            const ct = r.headers.get('content-type') ?? 'application/json';
            if (r.ok) {
              await cacheSet(cacheKey, { status: r.status, ct, text }, ttl || 90 * 60_000);
            }
            return { status: r.status, ct, text };
          } catch { return null; }
          finally { swrInflight.delete(cacheKey); }
        })();
        swrInflight.set(cacheKey, p);
      }
      if (p) {
        const fresh = await p;
        if (fresh && fresh.status < 400) {
          res.setHeader('x-av-cache', 'MISS');
          res.status(fresh.status);
          res.setHeader('content-type', fresh.ct);
          return res.send(fresh.text);
        }
        if (cached) return serveCached(cached, 'STALE');
        if (fresh) { res.status(fresh.status); res.setHeader('content-type', fresh.ct); return res.send(fresh.text); }
        return warming();
      }
      // гейт закрыт и нет inflight: отдаём что есть, иначе ждём прогрева
      if (cached) return serveCached(cached, 'STALE');
      return warming();
    }
  }

  // 1) cache hit? (обычный режим — не используется для WB/Ozon)
  if (cacheKey && !noCache) {
    const cached = await cacheGet<{ status: number; ct: string; text: string }>(cacheKey);
    if (isFresh(cached)) {
      res.setHeader('x-av-cache', 'HIT');
      res.setHeader('x-av-cache-age', String(Math.round((Date.now() - cached.fetchedAt) / 1000)));
      res.status(cached.data.status);
      res.setHeader('content-type', cached.data.ct);
      return res.send(cached.data.text);
    }
  }

  // 2) miss → upstream с retry
  try {
    const r = await fetchWithRetry(url, { method, headers, body });
    const text = await r.text();
    const ct = r.headers.get('content-type') ?? 'application/json';

    if (cacheKey && r.ok) {
      await cacheSet(cacheKey, { status: r.status, ct, text }, ttl);
      res.setHeader('x-av-cache', 'MISS');
    } else if (cacheKey && r.status === 429) {
      // Сохраняем 429-ответ короткоживущим (60с). Это спасает от bursts:
      // если пользователь обновляет страницу подряд, прокси отдаёт прошлый
      // 429 без повторного дёргания апстрима. Также — если есть прошлый
      // успешный stale-кэш, отдаём его вместо 429.
      const stale = await cacheGet<{ status: number; ct: string; text: string }>(cacheKey);
      if (stale && stale.data.status < 400) {
        res.setHeader('x-av-cache', 'STALE-ON-429');
        res.status(stale.data.status);
        res.setHeader('content-type', stale.data.ct);
        return res.send(stale.data.text);
      }
      await cacheSet(cacheKey, { status: r.status, ct, text }, 60_000);
      res.setHeader('x-av-cache', '429-SHORT');
    } else if (cacheKey) {
      res.setHeader('x-av-cache', 'BYPASS');
    }

    res.status(r.status);
    res.setHeader('content-type', ct);
    res.send(text);
  } catch (e: any) {
    // Если апстрим лежит и есть stale cache — отдадим его
    if (cacheKey) {
      const stale = await cacheGet<{ status: number; ct: string; text: string }>(cacheKey);
      if (stale) {
        res.setHeader('x-av-cache', 'STALE');
        res.status(stale.data.status);
        res.setHeader('content-type', stale.data.ct);
        return res.send(stale.data.text);
      }
    }
    res.status(502).json({ error: 'upstream_unreachable', detail: String(e?.message ?? e) });
  }
}

// ─── WB ────────────────────────────────────────────────────────────────────
// Поддерживаем все ключевые сервисы WB. Scope из URL → host map ниже.
// Token: env WB_TOKEN_<SCOPE_UPPER> в приоритете, fallback на WB_TOKEN.
type WbScope =
  | 'common' | 'content' | 'statistics' | 'feedbacks' | 'discounts'
  | 'promotion' | 'analytics' | 'supplies' | 'finance';

const WB_HOSTS: Record<WbScope, string> = {
  common:     'https://common-api.wildberries.ru',
  content:    'https://content-api.wildberries.ru',
  statistics: 'https://statistics-api.wildberries.ru',
  feedbacks:  'https://feedbacks-api.wildberries.ru',
  discounts:  'https://discounts-prices-api.wildberries.ru',
  promotion:  'https://advert-api.wildberries.ru',
  analytics:  'https://seller-analytics-api.wildberries.ru',
  supplies:   'https://supplies-api.wildberries.ru',
  // Новый фин-хост WB (07.2026): sales-reports/detailed заменяет
  // statistics-api reportDetailByPeriod (тот удаляется 15.07.2026).
  finance:    'https://finance-api.wildberries.ru',
};

// TTL серверного кэша по скоупам — подогнаны под реальные лимиты WB API
// (dev.wildberries.ru/news/281). Лимиты драконовские: seller-info 1/24ч,
// reportDetailByPeriod 2/24ч, cards/list 1/час, sales 1/2ч. Поэтому кэш держим
// долго: данные на маркетплейсе суточные, чаще обновлять смысла нет, а лишний
// поход в апстрим = 429. На 429 прокси отдаёт stale-кэш (см. handleProxy).
const WB_TTL: Record<WbScope, number> = {
  common:     24 * 60 * 60_000,  // seller-info: 1/24ч
  content:    12 * 60 * 60_000,  // cards/list: 1/час
  statistics: 12 * 60 * 60_000,  // reports: 1-2/сутки
  feedbacks:  30 * 60_000,       // 5/час — можно чаще
  discounts:   6 * 60 * 60_000,  // 1/час
  promotion:   6 * 60 * 60_000,  // balance 2/час
  analytics:   6 * 60 * 60_000,  // sales-funnel 2/час
  supplies:   12 * 60 * 60_000,
  finance:    12 * 60 * 60_000,  // sales-reports/detailed: 1/мин, отчёт недельный
};

function wbToken(scope: WbScope, override?: string): string {
  if (override && override.trim()) return override.trim();
  const upper = scope.toUpperCase();
  const scoped = process.env[`WB_TOKEN_${upper}`];
  if (scoped && scoped.trim()) return scoped.trim();
  return (process.env.WB_TOKEN ?? '').trim();
}

export function wbUpstream(scope: string, tokenOverride?: string): Upstream {
  const s = (WB_HOSTS as Record<string, string>)[scope] ? (scope as WbScope) : 'common';
  return {
    base: WB_HOSTS[s],
    headers: { Authorization: wbToken(s, tokenOverride) },
    cacheTtlMs: WB_TTL[s],
    // cron-only: браузер НИКОГДА не ходит в WB напрямую (иначе ловим 429 на каждой
    // странице). Кэш наполняет только фоновый сборщик; промах → 503 «прогрев»,
    // а фронт показывает последнюю цифру из БД («на дату X»).
    cacheMode: 'cron-only',
  };
}

// ─── Ozon Seller API ──────────────────────────────────────────────────────
export function ozonUpstream(): Upstream {
  return {
    base: 'https://api-seller.ozon.ru',
    headers: {
      'Client-Id': process.env.OZON_CLIENT_ID ?? '',
      'Api-Key': process.env.OZON_API_KEY ?? '',
    },
    cacheTtlMs: 90 * 60_000,
    cacheMode: 'swr', // свежий кэш сразу; протух — подтягиваем не чаще раза в 30 мин
  };
}
