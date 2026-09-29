/**
 * Парсер конкурентной выдачи WB и Ozon.
 *
 * Принцип (как у кабинетного API): «сбор отделён от чтения».
 *  - Пользователь читает кэш (прогревается фоном + по требованию).
 *  - Во внешние площадки ходим через очередь per-host с троттлом и single-flight,
 *    чтобы не словить бан (search.wb.ru / www.ozon.ru агрессивно лимитируют по IP).
 *  - На бан/ошибку отдаём прошлый кэш (stale) + cooldown.
 *
 * См. docs/COMPETITOR_PARSER.md.
 */
import { fetchWithRetry } from './fetchRetry';
import { cacheGet, cacheSet, isFresh, makeCacheKey } from './cache';
import { wbBasketNumber } from './wbBasket';
import { noteSwallowed } from './log';

export type Platform = 'wb' | 'ozon';

export type CompetitorItem = {
  platform: Platform;
  id: string;            // nmId (WB) | sku (Ozon)
  name: string;
  brand: string | null;
  seller: string | null;
  price: number;         // цена для покупателя (после скидок), ₽
  oldPrice: number | null;
  rating: number | null; // 0..5
  reviews: number | null;
  image: string | null;
  url: string;
};

export type CompetitorSearch = {
  platform: Platform;
  query: string;
  fetchedAt: number;
  items: CompetitorItem[];
  partial?: boolean;
  error?: string;
};

export type CompetitorCard = {
  platform: Platform;
  id: string;
  name: string;
  brand: string | null;
  description: string;
  characteristics: Array<{ name: string; value: string }>;
  photoCount: number;
  images: string[];
  link: string;
};

const SEARCH_TTL_MS = 8 * 60 * 60_000;   // выдача за день почти не меняется
const CARD_TTL_MS = 12 * 60 * 60_000;
const COOLDOWN_MS = 10 * 60_000;          // после бана хоста — пауза

// ─── Очередь per-host с троттлом ────────────────────────────────────────────
const hostQueue = new Map<string, Promise<unknown>>();
const hostLastCall = new Map<string, number>();
const hostCooldownUntil = new Map<string, number>();
const HOST_MIN_INTERVAL_MS = 1_800; // ~1 запрос / 1.8с на хост

function jitter(): number { return 300 + (Date.now() % 900); }

/** Поставить задачу в последовательную очередь хоста с выдержкой интервала. */
function enqueue<T>(host: string, job: () => Promise<T>): Promise<T> {
  const prev = hostQueue.get(host) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(async () => {
    const wait = (hostLastCall.get(host) ?? 0) + HOST_MIN_INTERVAL_MS + jitter() - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    hostLastCall.set(host, Date.now());
    return job();
  });
  hostQueue.set(host, run.catch(() => undefined));
  return run;
}

// ─── Single-flight + кэш ────────────────────────────────────────────────────
const inflight = new Map<string, Promise<any>>();

async function cachedFetch<T>(
  cacheKey: string,
  ttlMs: number,
  host: string,
  loader: () => Promise<T>,
): Promise<{ data: T; stale: boolean }> {
  const cached = await cacheGet<T>(cacheKey);
  // Сохраняем данные кэша отдельно: isFresh() сужает `cached`, дальше им не пользуемся.
  const cachedData: T | null = cached ? cached.data : null;
  if (isFresh(cached)) return { data: cached.data, stale: false };

  // хост в cooldown после бана — отдаём прошлый кэш если есть
  if (Date.now() < (hostCooldownUntil.get(host) ?? 0) && cachedData !== null) {
    return { data: cachedData, stale: true };
  }

  let p = inflight.get(cacheKey);
  if (!p) {
    p = (async () => {
      try {
        const data = await enqueue(host, loader);
        await cacheSet(cacheKey, data, ttlMs);
        return data;
      } finally { inflight.delete(cacheKey); }
    })();
    inflight.set(cacheKey, p);
  }
  try {
    return { data: await p, stale: false };
  } catch (e) {
    if (cachedData !== null) return { data: cachedData, stale: true };
    throw e;
  }
}

function markBlocked(host: string) {
  hostCooldownUntil.set(host, Date.now() + COOLDOWN_MS);
}

const BROWSER_HEADERS: Record<string, string> = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'ru-RU,ru;q=0.9',
};

// ════════════════════════════════════════════════════════════════════════════
// WB
// ════════════════════════════════════════════════════════════════════════════
const WB_SEARCH_HOST = 'search.wb.ru';

// basket-host: диапазоны WB периодически расширяет. Держим таблицу + auto-bump
// при 404 (перебор соседних баскетов). См. wbBasketCandidates.
// Таблица переехала в _lib/wbBasket.ts (там же продолжение выше vol 4565 —
// раньше формула упиралась в потолок 26 и все новые карточки шли в него).
// Перебор соседей при 404 ниже остаётся: он страхует, если WB сменит шаг.
const wbBasket = wbBasketNumber;
function wbHostStr(b: number): string { return `https://basket-${String(b).padStart(2, '0')}.wbbasket.ru`; }
function wbImageUrl(nm: number, basket: number, idx: number, size = 'big'): string {
  const vol = Math.floor(nm / 1e5);
  const part = Math.floor(nm / 1e3);
  return `${wbHostStr(basket)}/vol${vol}/part${part}/${nm}/images/${size}/${idx}.webp`;
}

function normalizeWbSearchItem(p: any): CompetitorItem | null {
  const id = p?.id;
  if (!id || !Number.isFinite(id)) return null;
  const basket = wbBasket(id);
  const vol = Math.floor(id / 1e5);
  const part = Math.floor(id / 1e3);
  const image = `${wbHostStr(basket)}/vol${vol}/part${part}/${id}/images/c516x688/1.webp`;
  const price = (p.sizes?.[0]?.price?.product ?? p.priceU ?? 0) / 100;
  const salePrice = (p.sizes?.[0]?.price?.total ?? p.salePriceU ?? p.priceU ?? 0) / 100;
  return {
    platform: 'wb',
    id: String(id),
    name: String(p.name ?? ''),
    brand: p.brand ?? null,
    seller: p.supplier ?? null,
    price: salePrice || price,
    oldPrice: price > salePrice ? price : null,
    rating: typeof p.reviewRating === 'number' ? p.reviewRating : null,
    reviews: typeof p.feedbacks === 'number' ? p.feedbacks : null,
    image,
    url: `https://www.wildberries.ru/catalog/${id}/detail.aspx`,
  };
}

async function fetchWbSearch(query: string, limit: number): Promise<CompetitorSearch> {
  const url = `https://${WB_SEARCH_HOST}/exactmatch/ru/common/v9/search?ab_testing=false&appType=1&curr=rub&dest=-1257786&query=${encodeURIComponent(query)}&resultset=catalog&sort=popular&spp=30&suppressSpellcheck=false`;
  const r = await fetchWithRetry(url, { method: 'GET', headers: BROWSER_HEADERS });
  const text = await r.text();
  const looksHtml = text.trim().startsWith('<') || (r.headers.get('content-type') || '').includes('text/html');
  if (looksHtml || r.status === 429 || /429/.test(text.slice(0, 40))) {
    markBlocked(WB_SEARCH_HOST);
    throw new Error('wb_search_rate_limited');
  }
  if (!r.ok) throw new Error(`wb_search_failed_${r.status}`);
  const json = JSON.parse(text);
  const products = (json?.data?.products ?? []) as any[];
  const items = products.slice(0, limit).map(normalizeWbSearchItem).filter(Boolean) as CompetitorItem[];
  return { platform: 'wb', query, fetchedAt: Date.now(), items };
}

/** Позиция своего nmId в поисковой выдаче WB по запросу.
 *  Сканирует до `pages` страниц (≈100 товаров каждая). Возвращает позицию
 *  (1-based) и страницу, либо null если не найден в просмотренных страницах. */
export type WbRank = { query: string; nmId: number; position: number | null; page: number | null; scanned: number; fetchedAt: number };

export async function wbSearchRank(query: string, nmId: number, pages = 5): Promise<WbRank> {
  let scanned = 0;
  for (let page = 1; page <= pages; page++) {
    const url = `https://${WB_SEARCH_HOST}/exactmatch/ru/common/v9/search?ab_testing=false&appType=1&curr=rub&dest=-1257786&page=${page}&query=${encodeURIComponent(query)}&resultset=catalog&sort=popular&spp=30&suppressSpellcheck=false`;
    // WB иногда отдаёт битый JSON/429-stub — пробуем до 2 раз с паузой.
    let products: any[] | null = null;
    for (let attempt = 0; attempt < 2 && products === null; attempt++) {
      if (attempt) await new Promise(r => setTimeout(r, 1200));
      const r = await fetchWithRetry(url, { method: 'GET', headers: BROWSER_HEADERS });
      const text = await r.text();
      if (text.trim().startsWith('<') || r.status === 429) { markBlocked(WB_SEARCH_HOST); continue; }
      if (!r.ok) continue;
      try { products = (JSON.parse(text)?.data?.products ?? []) as any[]; } catch { products = null; }
    }
    if (products === null) { markBlocked(WB_SEARCH_HOST); throw new Error('wb_search_rate_limited'); }
    if (!products.length) break;
    const idx = products.findIndex(p => Number(p?.id) === nmId);
    if (idx >= 0) {
      return { query, nmId, position: scanned + idx + 1, page, scanned: scanned + products.length, fetchedAt: Date.now() };
    }
    scanned += products.length;
  }
  return { query, nmId, position: null, page: null, scanned, fetchedAt: Date.now() };
}

async function fetchWbCard(nm: number): Promise<CompetitorCard> {
  const vol = Math.floor(nm / 1e5);
  const part = Math.floor(nm / 1e3);
  // auto-bump: пробуем вычисленный баскет и соседние (формула устаревает по мере
  // роста nmId — так card.json не ломается для свежих карточек).
  const base = wbBasket(nm);
  const candidates = Array.from(new Set([base, base + 1, base - 1, base + 2]))
    .filter(b => b >= 1 && b <= 30);
  let c: any = null;
  for (const b of candidates) {
    const host = wbHostStr(b);
    try {
      const r = await fetchWithRetry(`${host}/vol${vol}/part${part}/${nm}/info/ru/card.json`,
        { method: 'GET', headers: BROWSER_HEADERS });
      if (r.ok) { c = await r.json(); break; }
    } catch (e) {
      // Перебор баскетов штатен, поэтому пишем редко: важен случай, когда
      // недоступны все, и карточка не находится вообще.
      noteSwallowed('competitors', 'баскет WB не ответил', e, 30 * 60_000);
    }
  }
  if (!c) throw new Error('wb_card_not_found');

  const chars: Array<{ name: string; value: string }> = [];
  if (Array.isArray(c?.options)) for (const o of c.options) if (o?.name) chars.push({ name: o.name, value: String(o.value ?? '') });
  if (Array.isArray(c?.grouped_options)) for (const g of c.grouped_options) for (const o of (g?.options || [])) if (o?.name) chars.push({ name: o.name, value: String(o.value ?? '') });

  const photoCount = Number(c?.media?.photo_count) || Number(c?.photo_count) ||
    (Array.isArray(c?.media?.photos) ? c.media.photos.length : 0) || 1;
  const basket = wbBasket(nm);
  const images: string[] = [];
  for (let i = 1; i <= Math.min(photoCount, 15); i++) images.push(wbImageUrl(nm, basket, i, 'big'));

  return {
    platform: 'wb',
    id: String(nm),
    name: c?.imt_name || c?.subj_name || c?.subj_root_name || '',
    brand: c?.selling?.brand_name || c?.brand || null,
    description: c?.description || '',
    characteristics: chars,
    photoCount,
    images,
    link: `https://www.wildberries.ru/catalog/${nm}/detail.aspx`,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// Ozon (Composer BFF)
// ⚠ Формат BFF Ozon периодически меняется (имена виджетов, пути полей). Парсер
// намеренно ТЕРПИМ: рекурсивно ищем товарные элементы и тянем поля по нескольким
// возможным путям. При неудаче возвращаем partial с error — фронт деградирует к
// Ozon-индексу цен. Калибровать на реальном ответе (см. docs).
// ════════════════════════════════════════════════════════════════════════════
const OZON_HOST = 'www.ozon.ru';

function pick(obj: any, paths: string[]): any {
  for (const path of paths) {
    let cur = obj;
    for (const k of path.split('.')) { cur = cur?.[k]; if (cur == null) break; }
    if (cur != null) return cur;
  }
  return undefined;
}

function parseMoney(s: any): number {
  if (typeof s === 'number') return s;
  if (typeof s !== 'string') return 0;
  const n = parseInt(s.replace(/[^\d]/g, ''), 10);
  return Number.isFinite(n) ? n : 0;
}

function skuFromLink(link: string | undefined): string | null {
  if (!link) return null;
  const m = link.match(/\/product\/[^/]*-(\d+)\/?/) || link.match(/(\d{6,})/);
  return m ? m[1] : null;
}

function normalizeOzonItem(it: any): CompetitorItem | null {
  // sku
  const link: string | undefined = pick(it, ['action.link', 'link', 'deepLink']);
  const sku = String(pick(it, ['sku', 'productId']) ?? skuFromLink(link) ?? '');
  if (!sku) return null;

  // имя — ищем в mainState (атомы текста) или прямых полях
  let name = String(pick(it, ['title', 'name']) ?? '');
  const mainState: any[] = Array.isArray(it?.mainState) ? it.mainState : [];
  if (!name) {
    const titleAtom = mainState.find(a => /name|title/i.test(a?.id || '') || a?.atom?.type === 'textAtom');
    name = String(pick(titleAtom, ['atom.text', 'atom.textAtom.text']) ?? '').replace(/<[^>]+>/g, '').trim();
  }

  // цена — priceV2 в mainState
  let price = 0, oldPrice: number | null = null;
  const priceAtom = mainState.find(a => /price/i.test(a?.id || '') || a?.atom?.type === 'priceV2');
  const priceArr = pick(priceAtom, ['atom.priceV2.price', 'atom.price.price']);
  if (Array.isArray(priceArr)) {
    const nums = priceArr.map((x: any) => ({ v: parseMoney(x?.text), style: x?.textStyle }));
    const cur = nums.find(n => /PRICE$|CARD/i.test(n.style || '')) ?? nums[0];
    const old = nums.find(n => /ORIGINAL|STRIKE/i.test(n.style || ''));
    price = cur?.v ?? 0;
    oldPrice = old && old.v > price ? old.v : null;
  } else {
    price = parseMoney(pick(it, ['price', 'finalPrice']));
  }

  const image = pick(it, ['tileImage.items.0.image.link', 'images.0', 'image.link', 'coverImage']) ?? null;

  // рейтинг/отзывы — иногда в labelList footer
  let rating: number | null = null, reviews: number | null = null;
  const footerLabels = JSON.stringify(pick(it, ['footerState', 'labelList']) ?? '');
  const rm = footerLabels.match(/([0-5][.,]\d)\s*★?/);
  if (rm) rating = parseFloat(rm[1].replace(',', '.'));
  const rev = footerLabels.match(/(\d[\d\s]*)\s*отзыв/i);
  if (rev) reviews = parseInt(rev[1].replace(/\s/g, ''), 10);

  if (!name && !price) return null;
  return {
    platform: 'ozon', id: sku, name, brand: null, seller: null,
    price, oldPrice, rating, reviews,
    image: typeof image === 'string' ? image : null,
    url: link ? (link.startsWith('http') ? link : `https://www.ozon.ru${link}`) : `https://www.ozon.ru/search/?text=${sku}`,
  };
}

function collectOzonItems(json: any): any[] {
  // widgetStates — объект; значения часто JSON-строки. Ищем массивы items.
  const out: any[] = [];
  const ws = json?.widgetStates ?? json?.widget_states ?? {};
  for (const key of Object.keys(ws)) {
    if (!/searchResult|tileGrid|skuGrid|tile/i.test(key)) continue;
    let val = ws[key];
    if (typeof val === 'string') { try { val = JSON.parse(val); } catch { continue; } }
    const items = val?.items ?? val?.products ?? [];
    if (Array.isArray(items)) out.push(...items);
  }
  // fallback: рекурсивный поиск любого массива объектов с признаками товара
  if (!out.length) {
    const seen = new Set<any>();
    const walk = (o: any, depth: number) => {
      if (!o || typeof o !== 'object' || depth > 6 || seen.has(o)) return;
      seen.add(o);
      if (Array.isArray(o)) {
        if (o.length && o.some(x => x && (x.sku || x.action?.link || x.mainState))) out.push(...o);
        o.forEach(x => walk(x, depth + 1));
      } else {
        for (const k of Object.keys(o)) walk(o[k], depth + 1);
      }
    };
    walk(json, 0);
  }
  return out;
}

async function fetchOzonSearch(query: string, limit: number): Promise<CompetitorSearch> {
  const inner = `/search/?text=${encodeURIComponent(query)}&from_global=true`;
  const url = `https://${OZON_HOST}/api/composer-api.bff/page/json/v2?url=${encodeURIComponent(inner)}`;
  const r = await fetchWithRetry(url, {
    method: 'GET',
    headers: { ...BROWSER_HEADERS, 'x-o3-app-name': 'dweb_client', 'Referer': `https://${OZON_HOST}/search/` },
  });
  const text = await r.text();
  if (r.status === 403 || r.status === 429 || text.trim().startsWith('<')) {
    markBlocked(OZON_HOST);
    throw new Error(r.status === 403 ? 'ozon_blocked' : 'ozon_rate_limited');
  }
  if (!r.ok) throw new Error(`ozon_search_failed_${r.status}`);
  let json: any;
  try { json = JSON.parse(text); } catch { throw new Error('ozon_bad_json'); }
  const raw = collectOzonItems(json);
  const seen = new Set<string>();
  const items: CompetitorItem[] = [];
  for (const it of raw) {
    const n = normalizeOzonItem(it);
    if (n && !seen.has(n.id)) { seen.add(n.id); items.push(n); if (items.length >= limit) break; }
  }
  return { platform: 'ozon', query, fetchedAt: Date.now(), items, partial: items.length === 0, error: items.length === 0 ? 'ozon_parse_empty' : undefined };
}

// ════════════════════════════════════════════════════════════════════════════
// Публичный API модуля
// ════════════════════════════════════════════════════════════════════════════
export async function competitorSearch(platform: Platform, query: string, limit = 16): Promise<CompetitorSearch> {
  const q = query.trim().toLowerCase();
  const key = makeCacheKey('comp', platform, 'search', q, String(limit));
  const host = platform === 'wb' ? WB_SEARCH_HOST : OZON_HOST;
  try {
    const { data, stale } = await cachedFetch<CompetitorSearch>(
      key, SEARCH_TTL_MS, host,
      () => platform === 'wb' ? fetchWbSearch(query, limit) : fetchOzonSearch(query, limit),
    );
    return stale ? { ...data, partial: true } : data;
  } catch (e: any) {
    return { platform, query, fetchedAt: Date.now(), items: [], error: String(e?.message ?? e) };
  }
}

export async function competitorCard(platform: Platform, id: string): Promise<CompetitorCard> {
  if (platform !== 'wb') throw new Error('card_unsupported_platform'); // Ozon-карточка — позже
  const nm = Number(id);
  if (!Number.isFinite(nm)) throw new Error('bad_id');
  const key = makeCacheKey('comp', 'wb', 'card', String(nm));
  const { data } = await cachedFetch<CompetitorCard>(key, CARD_TTL_MS, 'card.wbbasket', () => fetchWbCard(nm));
  return data;
}
