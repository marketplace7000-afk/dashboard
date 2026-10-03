// Живые остатки Ozon по offer_id — для фильтра «В продаже» на листе цен (01.10.2026).
//
// Раньше фильтр Ozon опирался на остаток из Google-таблицы снабжения (stockOzon)
// и на свежесть обхода витрины агентом. Таблица отстаёт, витрина бывает не снята —
// и товары без наличия проходили фильтр (жалоба клиента 29.09/01.10).
//
// POST /v4/product/info/stocks отдаёт по каждому товару остатки по схемам
// fbo / fbs / rfbs: present (на складе) и reserved (уже под заказами).
// Купить сейчас можно present − reserved. Пагинация — курсором: товаров в
// кабинете 182, а лимит страницы 100 (старый прогрев брал одну страницу).
import { fetchWithRetry } from './fetchRetry';
import { cacheGet, cacheSet, isFresh } from './cache';

const BASE = 'https://api-seller.ozon.ru';
const CACHE_KEY = 'ozon-stock:v1';
const TTL_MS = 5 * 60_000;

export type OzonStock = {
  /** offer_id (UPPER) → доступно к покупке (present − reserved) по всем схемам. */
  byOffer: Record<string, number>;
  fboByOffer: Record<string, number>;
  fbsByOffer: Record<string, number>; // fbs + rfbs
  /** false — прошли не все страницы (ошибка посередине); тогда 0 не приговор. */
  complete: boolean;
  total: number;
  fetchedAt: number;
};

function ozHeaders(): Record<string, string> {
  return {
    'Client-Id': process.env.OZON_CLIENT_ID ?? '',
    'Api-Key': process.env.OZON_API_KEY ?? '',
    'Content-Type': 'application/json',
  };
}

/** Чистая сборка из ответов страниц — отдельно, чтобы проверять без сети. */
export function aggregateOzonStocks(items: any[]): Pick<OzonStock, 'byOffer' | 'fboByOffer' | 'fbsByOffer'> {
  const byOffer: Record<string, number> = {};
  const fboByOffer: Record<string, number> = {};
  const fbsByOffer: Record<string, number> = {};
  for (const it of items) {
    const oid = String(it?.offer_id ?? '').trim().toUpperCase();
    if (!oid) continue;
    let fbo = 0, fbs = 0;
    for (const s of Array.isArray(it?.stocks) ? it.stocks : []) {
      const free = Math.max(0, (Number(s?.present) || 0) - (Number(s?.reserved) || 0));
      if (s?.type === 'fbo') fbo += free; else fbs += free; // fbs, rfbs, crossborder — склад продавца
    }
    fboByOffer[oid] = (fboByOffer[oid] || 0) + fbo;
    fbsByOffer[oid] = (fbsByOffer[oid] || 0) + fbs;
    byOffer[oid] = (byOffer[oid] || 0) + fbo + fbs;
  }
  return { byOffer, fboByOffer, fbsByOffer };
}

async function compute(): Promise<OzonStock> {
  const all: any[] = [];
  let cursor = '';
  let total = 0;
  let complete = false;
  const seen = new Set<string>();
  for (let page = 0; page < 30; page++) {
    const body: any = { filter: { visibility: 'ALL' }, limit: 100 };
    if (cursor) body.cursor = cursor;
    const res = await fetchWithRetry(`${BASE}/v4/product/info/stocks`,
      { method: 'POST', headers: ozHeaders(), body: JSON.stringify(body) },
      { maxRetries: 2, timeoutMs: 30_000 });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      if (!all.length) throw new Error(`ozon v4/product/info/stocks → ${res.status} ${txt.slice(0, 200)}`);
      console.warn(`[ozon-stock] страница ${page + 1} не получена: ${res.status} — остатки неполные`);
      break;
    }
    const j: any = await res.json();
    const items: any[] = j?.items ?? [];
    // Последняя страница у Ozon может повторять товары — не считаем остаток дважды.
    const before = all.length;
    for (const it of items) { const id = String(it?.product_id ?? it?.offer_id); if (!seen.has(id)) { seen.add(id); all.push(it); } }
    if (all.length === before) { complete = true; break; } // одни повторы — дальше листать нечего
    total = Number(j?.total) || total;
    cursor = String(j?.cursor ?? '');
    if (!items.length || !cursor || (total && all.length >= total)) { complete = true; break; }
  }
  return { ...aggregateOzonStocks(all), complete, total: total || all.length, fetchedAt: Date.now() };
}

let refreshing: Promise<OzonStock> | null = null;
function refresh(): Promise<OzonStock> {
  if (!refreshing) {
    refreshing = compute()
      .then(async fresh => { await cacheSet(CACHE_KEY, fresh, TTL_MS); return fresh; })
      .finally(() => { refreshing = null; });
  }
  return refreshing;
}

export async function getOzonStock(noCache = false): Promise<OzonStock> {
  const cached = await cacheGet<OzonStock>(CACHE_KEY);
  if (!noCache && isFresh(cached)) return cached!.data;
  try {
    return await refresh();
  } catch (e) {
    if (cached?.data) return cached.data;
    throw e;
  }
}
