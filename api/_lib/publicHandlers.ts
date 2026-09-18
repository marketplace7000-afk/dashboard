/**
 * Обработчики публичных данных маркетплейсов и рекламного кабинета Ozon.
 *
 * Что объединяет эти три темы: все они ходят наружу за данными, которых нет в
 * основном кабинете продавца, и у каждой свои правила лимитов.
 *
 *   handleCompetitors — единый парсер выдачи WB и Ozon (см. _lib/competitors)
 *   handleWbPublic    — публичный поиск и карточка WB для сравнения с конкурентами
 *   handleOzonPerf    — прокси в Ozon Performance с собственной авторизацией
 *
 * Вынесено из api/route.ts: маршрутизатор не обязан знать, как устроен разбор
 * карточки WB или обмен токена Performance API.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { upstreamQs } from '../_proxy';
import { fetchWithRetry } from './fetchRetry';
import { cacheGet, cacheSet, isFresh, makeCacheKey, makeUpstreamCacheKey } from './cache';
import { getOzonPerfToken, PERF_HOST, OzonPerfAuthError } from './ozonPerfAuth';
import { competitorSearch, competitorCard, type Platform } from './competitors';
import { wbBasketHost, wbImageUrl } from './wbBasket';

/** 90 минут на публичный поиск конкурентов: выдача меняется не поминутно. */
const WB_PUBLIC_CACHE_TTL_MS = 90 * 60_000;

// ────────────────────────────────────────────────────────────────────────────
// Конкуренты — единый парсер WB + Ozon (api/_lib/competitors.ts)
// ────────────────────────────────────────────────────────────────────────────
export async function handleCompetitors(req: VercelRequest, res: VercelResponse, rest: string[]) {
  const action = rest[0];
  const mp: Platform = req.query.mp === 'ozon' ? 'ozon' : 'wb';

  if (action === 'search') {
    const q = String(req.query.q || '').trim();
    if (!q) return res.status(400).json({ error: 'missing_q' });
    const limit = Math.min(Number(req.query.limit) || 16, 30);
    const data = await competitorSearch(mp, q, limit);
    res.setHeader('x-av-cache', data.error ? 'ERROR' : data.partial ? 'STALE' : 'OK');
    return res.status(200).json(data);
  }

  if (action === 'card') {
    const id = String(req.query.id || '').trim();
    if (!id) return res.status(400).json({ error: 'missing_id' });
    try {
      const card = await competitorCard(mp, id);
      return res.status(200).json(card);
    } catch (e: any) {
      return res.status(502).json({ error: 'card_failed', detail: String(e?.message ?? e) });
    }
  }

  return res.status(404).json({ error: 'competitors_action_not_found' });
}

// ────────────────────────────────────────────────────────────────────────────
// WB basket-CDN хелперы (для фото и card.json конкурентов)
// ────────────────────────────────────────────────────────────────────────────
// Формула баскета переехала в _lib/wbBasket.ts — она была скопирована сюда и ещё
// в два места, причём ЗДЕСЬ обрывалась на basket-21, а в остальных копиях доходила
// до 26. Из-за этого фото товаров с большим nmId не грузились (телемост 11.08, п.10).

// ────────────────────────────────────────────────────────────────────────────
// WB public card — полная карточка конкурента (описание, характеристики, ВСЕ
// фото). Берём card.json с CDN wbbasket.ru (не search.wb.ru → почти не банится).
// ────────────────────────────────────────────────────────────────────────────
async function handleWbPublicCard(req: VercelRequest, res: VercelResponse) {
  const nm = Number(req.query.nm);
  if (!nm || !Number.isFinite(nm)) return res.status(400).json({ error: 'missing_nm' });

  const cacheKey = makeCacheKey('wb-public', 'card', String(nm));
  const cached = await cacheGet<any>(cacheKey);
  if (isFresh(cached)) { res.setHeader('x-av-cache', 'HIT'); return res.status(200).json(cached.data); }

  const { host, vol, part } = wbBasketHost(nm);
  const cardUrl = `${host}/vol${vol}/part${part}/${nm}/info/ru/card.json`;
  try {
    const r = await fetchWithRetry(cardUrl, {
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
    });
    if (!r.ok) return res.status(502).json({ error: 'wb_card_failed', status: r.status, detail: `card.json HTTP ${r.status}` });
    const c = await r.json() as any;

    const chars: Array<{ name: string; value: string }> = [];
    if (Array.isArray(c?.options)) for (const o of c.options) if (o?.name) chars.push({ name: o.name, value: String(o.value ?? '') });
    if (Array.isArray(c?.grouped_options)) for (const g of c.grouped_options) for (const o of (g?.options || [])) if (o?.name) chars.push({ name: o.name, value: String(o.value ?? '') });

    const photoCount = Number(c?.media?.photo_count) || Number(c?.photo_count) ||
      (Array.isArray(c?.media?.photos) ? c.media.photos.length : 0) || 1;
    const images: string[] = [];
    for (let i = 1; i <= Math.min(photoCount, 15); i++) images.push(wbImageUrl(nm, i, 'big'));

    const payload = {
      ok: true,
      nm,
      imtId: c?.imt_id ?? c?.imtId ?? null,
      name: c?.imt_name || c?.subj_name || c?.subj_root_name || '',
      brand: c?.selling?.brand_name || c?.brand || '',
      description: c?.description || '',
      characteristics: chars,
      photoCount,
      images,
      link: `https://www.wildberries.ru/catalog/${nm}/detail.aspx`,
    };
    await cacheSet(cacheKey, payload, WB_PUBLIC_CACHE_TTL_MS);
    res.setHeader('x-av-cache', 'MISS');
    return res.status(200).json(payload);
  } catch (e: any) {
    return res.status(502).json({ error: 'wb_card_unreachable', detail: String(e?.message ?? e) });
  }
}

// ────────────────────────────────────────────────────────────────────────────
// WB public search — поиск конкурентов через публичное API WB (без токена)
// ────────────────────────────────────────────────────────────────────────────
export async function handleWbPublic(req: VercelRequest, res: VercelResponse, rest: string[]) {
  const action = rest[0];
  if (action === 'card') return handleWbPublicCard(req, res);
  if (action !== 'search') return res.status(404).json({ error: 'wb_public_action_not_found' });

  const query = String(req.query.q || '').trim();
  if (!query) return res.status(400).json({ error: 'missing_q' });
  const limit = Math.min(Number(req.query.limit) || 12, 30);

  const cacheKey = makeCacheKey('wb-public', 'search', query, String(limit), '');
  const cached = await cacheGet<any>(cacheKey);
  if (isFresh(cached)) {
    res.setHeader('x-av-cache', 'HIT');
    const status = cached.data?.ok === false ? 429 : 200;
    return res.status(status).json(cached.data);
  }

  // Публичная поисковая ручка WB (без авторизации)
  const url = `https://search.wb.ru/exactmatch/ru/common/v9/search?ab_testing=false&appType=1&curr=rub&dest=-1257786&query=${encodeURIComponent(query)}&resultset=catalog&sort=popular&spp=30&suppressSpellcheck=false`;

  try {
    const r = await fetchWithRetry(url, {
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
    });
    const bodyText = await r.text();

    // WB часто баннит Vercel-IP и возвращает HTML «429 Too Many Requests»
    // с content-type text/html — пытаться парсить как JSON бессмысленно.
    const looksHtml = bodyText.trim().startsWith('<') ||
                      (r.headers.get('content-type') || '').includes('text/html');
    if (looksHtml || !r.ok) {
      const is429 = r.status === 429 || /429/i.test(bodyText);
      const errBody = {
        ok: false,
        error: is429 ? 'wb_search_rate_limited' : 'wb_search_failed',
        detail: is429
          ? 'WB временно ограничил публичный поиск с этого IP. Попробуйте позже или используйте VPN/прокси (на бэке-в-проде нужен пул residential-IP).'
          : bodyText.slice(0, 200),
      };
      // Кешируем ошибку на минуту — не плодим повторные удары в WB
      await cacheSet(cacheKey, errBody, 60_000);
      return res.status(is429 ? 429 : 502).json(errBody);
    }

    let json: any;
    try { json = JSON.parse(bodyText); }
    catch (e: any) {
      return res.status(502).json({
        error: 'wb_search_invalid_response',
        detail: `Ответ WB не парсится как JSON: ${e?.message}. Начало ответа: ${bodyText.slice(0, 80)}`,
      });
    }
    const products = (json?.data?.products || []) as any[];
    const items = products.slice(0, limit).map(p => {
      const id = p.id as number;
      const image = wbImageUrl(id, 1, 'c516x688');
      const price = (p.sizes?.[0]?.price?.product ?? p.priceU ?? 0) / 100;
      const salePrice = (p.sizes?.[0]?.price?.total ?? p.salePriceU ?? p.priceU ?? 0) / 100;
      return {
        id,
        name: p.name as string,
        brand: p.brand as string,
        supplier: p.supplier as string,
        rating: p.reviewRating as number,
        feedbacks: p.feedbacks as number,
        price,
        salePrice,
        discount: p.sale as number,
        image,
        link: `https://www.wildberries.ru/catalog/${id}/detail.aspx`,
      };
    });
    const payload = { ok: true, query, count: items.length, items };
    await cacheSet(cacheKey, payload, WB_PUBLIC_CACHE_TTL_MS);
    res.setHeader('x-av-cache', 'MISS');
    return res.status(200).json(payload);
  } catch (e: any) {
    return res.status(502).json({ error: 'wb_search_unreachable', detail: String(e?.message ?? e) });
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Ozon Performance (inlined из api/ozon-perf/[...slug].ts)
// ────────────────────────────────────────────────────────────────────────────
export async function handleOzonPerf(req: VercelRequest, res: VercelResponse, rest: string) {
  const qs = upstreamQs(req); // без служебного `p` (см. _proxy.upstreamQs)
  const url = `${PERF_HOST}/${rest}${qs}`;
  const method = (req.method ?? 'GET').toUpperCase();

  let body: string | undefined;
  if (method !== 'GET' && req.body) {
    body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
  }

  const isCacheable = method === 'GET' || method === 'POST';
  const cacheKey = isCacheable ? makeUpstreamCacheKey('ozon-perf', method, rest, qs, body) : null;

  // Свежий кэш отдаём сразу.
  if (cacheKey) {
    const cached = await cacheGet<{ status: number; ct: string; text: string }>(cacheKey);
    if (cached && isFresh(cached)) {
      res.setHeader('x-av-cache', 'HIT');
      res.setHeader('x-av-cache-age', String(Math.round((Date.now() - cached.fetchedAt) / 1000)));
      res.status(cached.data.status);
      res.setHeader('content-type', cached.data.ct);
      return res.send(cached.data.text);
    }
  }

  // Промах/устаревший кэш → идём в апстрим. В отличие от WB (cron-only из-за
  // драконовских лимитов), у Ozon Performance мягкие лимиты + серверный OAuth и
  // 30-мин кэш, поэтому браузеру можно тянуть любые периоды напрямую. Это и чинит
  // ДРР (жалоба №2) и раздел «Реклама» Ozon (жалоба №10).
  const TTL = 30 * 60_000;
  try {
    const token = await getOzonPerfToken();
    const r = await fetchWithRetry(
      url,
      { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body },
      { maxRetries: 2 },
    );
    const text = await r.text();
    const ct = r.headers.get('content-type') ?? 'application/json';
    if (r.ok && cacheKey) {
      await cacheSet(cacheKey, { status: r.status, ct, text }, TTL);
      res.setHeader('x-av-cache', 'MISS');
    } else {
      res.setHeader('x-av-cache', 'BYPASS');
    }
    res.status(r.status);
    res.setHeader('content-type', ct);
    return res.send(text);
  } catch (e: any) {
    // OAuth/апстрим упал → отдаём устаревший кэш, если есть, иначе понятную ошибку.
    if (cacheKey) {
      const stale = await cacheGet<{ status: number; ct: string; text: string }>(cacheKey);
      if (stale) {
        res.setHeader('x-av-cache', 'STALE');
        res.status(stale.data.status);
        res.setHeader('content-type', stale.data.ct);
        return res.send(stale.data.text);
      }
    }
    const status = e instanceof OzonPerfAuthError && e.status ? e.status : 502;
    return res.status(status).json({ error: 'ozon_perf_unreachable', detail: String(e?.message ?? e) });
  }
}


