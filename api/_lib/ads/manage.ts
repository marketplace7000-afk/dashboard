/**
 * «Управление рекламой» — сводная модель по товарам для обеих площадок.
 *
 * Собирает в одну строку на артикул то, что раньше жило в разных местах:
 *   реклама (collectAdsBySku, 7 и 30 дн)     — расход, выручка с рекламы, показы/клики/заказы;
 *   все заказы (getTotalRevenue)             — знаменатель ДРР «как у клиента» и скорость продаж;
 *   остатки FBS (stockSheet)                 — таблица «Склад»: остаток и «в пути» по складам,
 *                                              с учётом какая площадка откуда отгружается;
 *   карточки (WB content / Ozon product)     — название и фото, чтобы в таблице был артикул,
 *                                              а не nmId;
 *   маржа (снимок с листа «Цены»)            — marginPct/marginRub, которые видит пользователь
 *                                              в «Ценах»; публикует сам лист в общую память UI.
 *
 * Скорость продаж (шт/день) — по логике логиста клиента: если последние 7 дней
 * продают быстрее, чем средние 30, вес 0.8/0.2 в пользу свежего окна (рост),
 * иначе 0.5/0.5 (спад). Дней остатка = остаток площадки / скорость площадки.
 */
import { cacheGet, cacheSet, isFresh, cacheGetNewestByPrefix, makeUpstreamCachePrefix } from '../cache';
import { fetchWithRetry } from '../fetchRetry';

export type Platform = 'wb' | 'ozon';
export type ManageStatus = 'scale' | 'ok' | 'watch' | 'over' | 'stop' | 'stock' | 'no-ads';

export type ManageRow = {
  platform: Platform;
  /** Артикул продавца (vendorCode WB / offer_id Ozon), верхний регистр. */
  article: string;
  /** nmId для WB, sku для Ozon (для ссылок). */
  id: string;
  name: string;
  photo: string;
  category: string;
  // — реклама, 7 дней —
  spend7: number;
  adsRevenue7: number;
  adsOrders7: number;
  views7: number;
  clicks7: number;
  ctr7: number | null;
  cpc7: number | null;
  // — реклама, 30 дней —
  spend30: number;
  adsRevenue30: number;
  // — все заказы (знаменатель ДРР, скорость) —
  orders7: number;
  orders30: number;
  revenue7: number;
  revenue30: number;
  /** ДРР = расход / выручка по всем заказам, % (формула клиента 14.08). */
  drr7: number | null;
  drr30: number | null;
  /** Запасной ДРР только по рекламной выручке (когда всех заказов нет). */
  drrAds7: number | null;
  norm: number;
  /** Доля рекламных заказов во всех, %. */
  adsShare7: number | null;
  // — остатки —
  stock: number | null;
  transit: number | null;
  velocity: number | null;
  stockDays: number | null;
  stockDaysWithTransit: number | null;
  // — экономика —
  marginPct: number | null;
  marginRub: number | null;
  marginAfterAdsPct: number | null;
  status: ManageStatus;
  statusNote: string;
};

export type ManageSummary = {
  platform: Platform;
  available: boolean;
  items: number;
  withAds: number;
  spend7: number;
  spend30: number;
  revenue7: number;
  revenue30: number;
  adsRevenue7: number;
  drr7: number | null;
  drr30: number | null;
  norm: number;
  byStatus: Record<ManageStatus, number>;
  stockCritical: number;
};

export type ManageReport = {
  generatedAt: number;
  rows: ManageRow[];
  summary: { wb: ManageSummary; ozon: ManageSummary };
  stock: { fetchedAt: number | null; warehouses: { name: string; mps: Platform[]; rows: number }[]; error?: string };
  margins: { wb: number | null; ozon: number | null };
  diagnostics: string[];
};

const CACHE_KEY = 'ads-manage:v1';
const TTL_MS = 10 * 60_000;
const OZ_CATALOG_KEY = 'ozon-catalog:v1';
const OZ_CATALOG_TTL = 12 * 3600_000;

const r1 = (n: number) => Math.round(n * 10) / 10;
const pct = (num: number, den: number): number | null => (den > 0 ? r1((num / den) * 100) : null);

// ==== карточки: название и фото ====

type Card = { name: string; photo: string; category: string };

async function wbCards(): Promise<{ byNm: Map<string, Card & { article: string }>; ok: boolean }> {
  const byNm = new Map<string, Card & { article: string }>();
  try {
    const entry = cacheGetNewestByPrefix<{ text?: string }>(
      makeUpstreamCachePrefix('wb:content', 'POST', 'content/v2/get/cards/list'),
    );
    const cards: any[] = entry?.data?.text ? JSON.parse(entry.data.text)?.cards ?? [] : [];
    for (const c of cards) {
      const nm = String(c?.nmID ?? '');
      if (!nm) continue;
      const p = c?.photos?.[0] ?? {};
      byNm.set(nm, {
        article: String(c?.vendorCode ?? '').trim().toUpperCase(),
        name: String(c?.title ?? ''),
        photo: String(p?.c246x328 ?? p?.tm ?? p?.big ?? ''),
        category: String(c?.subjectName ?? ''),
      });
    }
    return { byNm, ok: byNm.size > 0 };
  } catch {
    return { byNm, ok: false };
  }
}

async function ozonCatalog(): Promise<{ byOffer: Map<string, Card & { sku: string }>; ok: boolean }> {
  const byOffer = new Map<string, Card & { sku: string }>();
  const cached = await cacheGet<Record<string, Card & { sku: string }>>(OZ_CATALOG_KEY);
  if (isFresh(cached)) {
    for (const [k, v] of Object.entries(cached.data)) byOffer.set(k, v);
    return { byOffer, ok: byOffer.size > 0 };
  }
  try {
    const headers = {
      'Client-Id': process.env.OZON_CLIENT_ID ?? '',
      'Api-Key': process.env.OZON_API_KEY ?? '',
      'Content-Type': 'application/json',
    };
    const post = async (path: string, body: unknown) => {
      const res = await fetchWithRetry(`https://api-seller.ozon.ru/${path}`,
        { method: 'POST', headers, body: JSON.stringify(body) }, { maxRetries: 2, timeoutMs: 40_000 });
      if (!res.ok) throw new Error(`ozon ${path} → ${res.status}`);
      return res.json();
    };
    const pids: number[] = [];
    let lastId = '';
    for (let page = 0; page < 10; page++) {
      const pl = await post('v3/product/list', { filter: { visibility: 'ALL' }, last_id: lastId, limit: 1000 });
      const items: any[] = pl?.result?.items ?? [];
      for (const it of items) if (it.product_id) pids.push(it.product_id);
      lastId = pl?.result?.last_id ?? '';
      if (!lastId || items.length < 1000) break;
    }
    const map: Record<string, Card & { sku: string }> = {};
    for (let i = 0; i < pids.length; i += 1000) {
      const info = await post('v3/product/info/list', { product_id: pids.slice(i, i + 1000) });
      for (const it of info?.items ?? []) {
        const offer = String(it?.offer_id ?? '').trim().toUpperCase();
        if (!offer) continue;
        map[offer] = {
          sku: String(it?.sku ?? it?.sources?.[0]?.sku ?? ''),
          name: String(it?.name ?? ''),
          photo: String(it?.primary_image ?? it?.images?.[0] ?? ''),
          category: '',
        };
      }
    }
    if (Object.keys(map).length) await cacheSet(OZ_CATALOG_KEY, map, OZ_CATALOG_TTL);
    for (const [k, v] of Object.entries(map)) byOffer.set(k, v);
    return { byOffer, ok: byOffer.size > 0 };
  } catch {
    if (cached?.data) for (const [k, v] of Object.entries(cached.data)) byOffer.set(k, v);
    return { byOffer, ok: byOffer.size > 0 };
  }
}

// ==== маржа: снимок с листа «Цены» (общая память UI) ====

type MarginSnap = { at: number; items: Record<string, { marginPct: number | null; marginRub: number | null }> };

async function marginSnapshot(mp: Platform): Promise<MarginSnap | null> {
  try {
    const { getUiState } = await import('../uiState');
    const st: any = getUiState();
    const raw = st?.state?.[`prices-${mp}:margins`] ?? st?.[`prices-${mp}:margins`];
    if (!raw) return null;
    const j = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!j?.items) return null;
    return { at: Number(j.at) || 0, items: j.items };
  } catch {
    return null;
  }
}

// ==== скорость продаж и дни остатка ====

/** Логика логиста клиента: рост → 0.8 свежего окна + 0.2 длинного, спад → 0.5/0.5. */
export function velocityPerDay(orders7: number, orders30: number): number | null {
  const d7 = orders7 / 7;
  const d30 = orders30 / 30;
  if (d7 <= 0 && d30 <= 0) return null;
  const v = d7 > d30 ? 0.8 * d7 + 0.2 * d30 : 0.5 * d7 + 0.5 * d30;
  return v > 0 ? v : null;
}

// ==== статус по правилам (первичная сортировка, финальное слово — за Claude) ====

function decideStatus(r: Omit<ManageRow, 'status' | 'statusNote'>): { status: ManageStatus; note: string } {
  const drr = r.drr7 ?? r.drrAds7;
  const lowStock = r.stockDays !== null && r.stockDays < 7;
  if (r.spend7 <= 0) {
    if (lowStock) return { status: 'no-ads', note: 'без рекламы, остаток < 7 дн' };
    return { status: 'no-ads', note: 'реклама не крутится' };
  }
  if (r.spend7 >= 3000 && r.adsOrders7 === 0 && r.orders7 === 0) {
    return { status: 'stop', note: `расход ${Math.round(r.spend7)} ₽, заказов нет` };
  }
  if (lowStock) {
    return { status: 'stock', note: `остаток на ${r.stockDays} дн — не разгонять` };
  }
  if (r.marginAfterAdsPct !== null && r.marginAfterAdsPct < 0) {
    return { status: 'over', note: `маржа после рекламы ${r.marginAfterAdsPct}%` };
  }
  if (drr !== null && drr > r.norm * 1.5) {
    return { status: 'over', note: `ДРР ${drr}% при норме ${r.norm}%` };
  }
  if (drr !== null && drr > r.norm) {
    return { status: 'watch', note: `ДРР ${drr}% выше нормы ${r.norm}%` };
  }
  const goodStock = r.stockDays === null ? false : r.stockDays >= 14;
  const goodMargin = r.marginAfterAdsPct === null ? true : r.marginAfterAdsPct >= 10;
  if (drr !== null && drr <= r.norm && r.orders7 >= 5 && goodStock && goodMargin) {
    return { status: 'scale', note: `ДРР ${drr}% ≤ нормы, остаток ${r.stockDays} дн — можно усиливать` };
  }
  return { status: 'ok', note: drr === null ? 'ДРР не посчитать' : `ДРР ${drr}% в норме` };
}

// ==== сборка ====

const emptyStatus = (): Record<ManageStatus, number> =>
  ({ scale: 0, ok: 0, watch: 0, over: 0, stop: 0, stock: 0, 'no-ads': 0 });

async function build(): Promise<ManageReport> {
  const diagnostics: string[] = [];
  const [{ collectAdsBySku }, { getTotalRevenue }, { getStockSheet }, { getDrrNorms }, { drrNorm }] =
    await Promise.all([
      import('../agents/adsAdvisor'), import('./totalRevenue'), import('../stockSheet'),
      import('./norms'), import('./rules'),
    ]);
  const [ads7, ads30, tot7, tot30, stock, norms, wb, oz, mWb, mOz] = await Promise.all([
    collectAdsBySku(7).catch((e) => { diagnostics.push('реклама 7 дн: ' + (e as Error).message); return null; }),
    collectAdsBySku(30).catch((e) => { diagnostics.push('реклама 30 дн: ' + (e as Error).message); return null; }),
    getTotalRevenue(7).catch(() => null),
    getTotalRevenue(30).catch(() => null),
    getStockSheet(),
    getDrrNorms().catch(() => ({} as Record<string, number>)),
    wbCards(), ozonCatalog(), marginSnapshot('wb'), marginSnapshot('ozon'),
  ]);
  if (stock.error) diagnostics.push('остатки: ' + stock.error);
  if (!wb.ok) diagnostics.push('WB: каталог карточек не прогрет — названия/фото могут отсутствовать');
  if (!oz.ok) diagnostics.push('Ozon: каталог товаров недоступен — названия/фото могут отсутствовать');
  if (!mWb) diagnostics.push('WB: маржа появится после открытия листа «Цены → WB»');
  if (!mOz) diagnostics.push('Ozon: маржа появится после открытия листа «Цены → Ozon»');
  for (const m of tot7?.missing ?? []) diagnostics.push(m);

  // Ключ строки: platform + артикул. Реклама WB приходит по nmId → артикул через карточки.
  type Acc = Partial<ManageRow> & { platform: Platform; article: string; id: string };
  const acc = new Map<string, Acc>();
  const keyOf = (p: Platform, a: string) => `${p}:${a}`;
  const get = (p: Platform, article: string, id: string): Acc => {
    const k = keyOf(p, article);
    let a = acc.get(k);
    if (!a) { a = { platform: p, article, id }; acc.set(k, a); }
    if (!a.id && id) a.id = id;
    return a;
  };
  const resolve = (it: { platform: string; sku: string; id?: string }): { p: Platform; article: string; id: string } | null => {
    if (it.platform === 'wb') {
      const nm = String(it.id ?? '');
      const card = wb.byNm.get(nm);
      const article = (card?.article || String(it.sku ?? '')).trim().toUpperCase();
      if (!article) return null;
      return { p: 'wb', article, id: nm };
    }
    const article = String(it.sku ?? '').trim().toUpperCase();
    if (!article) return null;
    return { p: 'ozon', article, id: oz.byOffer.get(article)?.sku ?? String(it.id ?? '') };
  };
  for (const it of ads7?.items ?? []) {
    const r = resolve(it); if (!r) continue;
    const a = get(r.p, r.article, r.id);
    a.spend7 = (a.spend7 ?? 0) + it.spend; a.adsRevenue7 = (a.adsRevenue7 ?? 0) + it.revenue;
    a.adsOrders7 = (a.adsOrders7 ?? 0) + it.orders; a.views7 = (a.views7 ?? 0) + it.views;
    a.clicks7 = (a.clicks7 ?? 0) + it.clicks; if (it.category) a.category = it.category;
  }
  for (const it of ads30?.items ?? []) {
    const r = resolve(it); if (!r) continue;
    const a = get(r.p, r.article, r.id);
    a.spend30 = (a.spend30 ?? 0) + it.spend; a.adsRevenue30 = (a.adsRevenue30 ?? 0) + it.revenue;
    if (!a.category && it.category) a.category = it.category;
  }
  // Все заказы: WB по nmId → артикул, Ozon по offer_id.
  const addTotals = (t: Awaited<ReturnType<typeof getTotalRevenue>> | null, win: 7 | 30) => {
    if (!t) return;
    for (const [nm, cnt] of t.wbOrdersByNm) {
      const card = wb.byNm.get(nm); if (!card?.article) continue;
      const a = get('wb', card.article, nm);
      if (win === 7) { a.orders7 = (a.orders7 ?? 0) + cnt; a.revenue7 = (a.revenue7 ?? 0) + (t.wbByNm.get(nm) ?? 0); }
      else { a.orders30 = (a.orders30 ?? 0) + cnt; a.revenue30 = (a.revenue30 ?? 0) + (t.wbByNm.get(nm) ?? 0); }
    }
    for (const [sku, cnt] of t.ozonOrdersBySku) {
      const article = sku.trim().toUpperCase(); if (!article) continue;
      const a = get('ozon', article, oz.byOffer.get(article)?.sku ?? '');
      if (win === 7) { a.orders7 = (a.orders7 ?? 0) + cnt; a.revenue7 = (a.revenue7 ?? 0) + (t.ozonBySku.get(sku) ?? 0); }
      else { a.orders30 = (a.orders30 ?? 0) + cnt; a.revenue30 = (a.revenue30 ?? 0) + (t.ozonBySku.get(sku) ?? 0); }
    }
  };
  addTotals(tot7, 7); addTotals(tot30, 30);
  // Товары с остатком, но без рекламы и без заказов — тоже в таблицу (их видно как «без рекламы»).
  for (const [article, st] of Object.entries(stock.items)) {
    if (st.wb.stock > 0 || st.wb.transit > 0) get('wb', article, '');
    if (st.ozon.stock > 0 || st.ozon.transit > 0) get('ozon', article, '');
  }

  const rows: ManageRow[] = [];
  for (const a of acc.values()) {
    const card = a.platform === 'wb'
      ? [...wb.byNm.values()].find((c) => c.article === a.article) ?? null
      : oz.byOffer.get(a.article) ?? null;
    if (a.platform === 'wb' && !a.id) {
      for (const [nm, c] of wb.byNm) if (c.article === a.article) { a.id = nm; break; }
    }
    const st = stock.items[a.article];
    const stMp = st ? st[a.platform] : null;
    const spend7 = Math.round(a.spend7 ?? 0), spend30 = Math.round(a.spend30 ?? 0);
    const revenue7 = Math.round(a.revenue7 ?? 0), revenue30 = Math.round(a.revenue30 ?? 0);
    const adsRevenue7 = Math.round(a.adsRevenue7 ?? 0);
    const orders7 = a.orders7 ?? 0, orders30 = a.orders30 ?? 0;
    const velocity = velocityPerDay(orders7, orders30);
    const stockN = stMp ? stMp.stock : null;
    const transitN = stMp ? stMp.transit : null;
    const stockDays = stockN !== null && velocity ? Math.round(Math.max(0, stockN) / velocity) : null;
    const stockDaysWithTransit = stockN !== null && velocity
      ? Math.round(Math.max(0, stockN + (transitN ?? 0)) / velocity) : null;
    const snap = (a.platform === 'wb' ? mWb : mOz)?.items?.[a.article];
    const marginPct = snap?.marginPct ?? null;
    const drr7 = pct(spend7, revenue7);
    const drrAds7 = pct(spend7, adsRevenue7);
    const base: Omit<ManageRow, 'status' | 'statusNote'> = {
      platform: a.platform, article: a.article, id: a.id,
      name: card?.name ?? '', photo: card?.photo ?? '',
      category: a.category ?? card?.category ?? '',
      spend7, adsRevenue7, adsOrders7: a.adsOrders7 ?? 0, views7: a.views7 ?? 0, clicks7: a.clicks7 ?? 0,
      ctr7: pct(a.clicks7 ?? 0, a.views7 ?? 0),
      cpc7: (a.clicks7 ?? 0) > 0 ? Math.round(spend7 / (a.clicks7 ?? 1)) : null,
      spend30, adsRevenue30: Math.round(a.adsRevenue30 ?? 0),
      orders7, orders30, revenue7, revenue30,
      drr7, drr30: pct(spend30, revenue30), drrAds7,
      norm: drrNorm(a.category ?? card?.category, norms),
      adsShare7: pct(a.adsOrders7 ?? 0, orders7),
      stock: stockN, transit: transitN,
      velocity: velocity === null ? null : Math.round(velocity * 100) / 100,
      stockDays, stockDaysWithTransit,
      marginPct, marginRub: snap?.marginRub ?? null,
      marginAfterAdsPct: marginPct === null ? null : r1(marginPct - ((drr7 ?? drrAds7) ?? 0)),
    };
    const { status, note } = decideStatus(base);
    rows.push({ ...base, status, statusNote: note });
  }
  rows.sort((x, y) => y.spend7 - x.spend7 || y.revenue7 - x.revenue7);

  const summarize = (p: Platform): ManageSummary => {
    const rs = rows.filter((r) => r.platform === p);
    const s: ManageSummary = {
      platform: p, available: !!(p === 'wb' ? ads7?.sources?.wb : ads7?.sources?.ozon),
      items: rs.length, withAds: rs.filter((r) => r.spend7 > 0).length,
      spend7: 0, spend30: 0, revenue7: 0, revenue30: 0, adsRevenue7: 0,
      drr7: null, drr30: null, norm: drrNorm(undefined, norms), byStatus: emptyStatus(),
      stockCritical: rs.filter((r) => r.stockDays !== null && r.stockDays < 7 && r.orders7 > 0).length,
    };
    for (const r of rs) {
      s.spend7 += r.spend7; s.spend30 += r.spend30; s.revenue7 += r.revenue7; s.revenue30 += r.revenue30;
      s.adsRevenue7 += r.adsRevenue7; s.byStatus[r.status]++;
    }
    s.drr7 = pct(s.spend7, s.revenue7); s.drr30 = pct(s.spend30, s.revenue30);
    return s;
  };
  return {
    generatedAt: Date.now(), rows,
    summary: { wb: summarize('wb'), ozon: summarize('ozon') },
    stock: { fetchedAt: stock.fetchedAt ?? null, warehouses: stock.warehouses, error: stock.error },
    margins: { wb: mWb?.at ?? null, ozon: mOz?.at ?? null },
    diagnostics,
  };
}

export async function getAdsManage(noCache = false): Promise<ManageReport> {
  const cached = await cacheGet<ManageReport>(CACHE_KEY);
  if (!noCache && isFresh(cached)) return cached.data;
  const fresh = await build();
  await cacheSet(CACHE_KEY, fresh, TTL_MS);
  return fresh;
}
