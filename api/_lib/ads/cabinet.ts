/**
 * Конкуренты и позиции из аналитики кабинетов — Агент 3 «Реклама», сценарий
 * competitor_watch на ПК (14.10.2026). Форматы — docs/ads-system/КАБИНЕТЫ_ДАННЫЕ_2026-10-14.md.
 *
 * Хост присылает сырые ответы кабинета; здесь храним снимок (ads.sqlite,
 * последние 30 на площадку) и разбираем последний для вкладки «Конкуренты».
 */
import { adsDb, type AdMp } from './store';
import { DEFAULT_AGENT_SETTINGS } from '../../../shared/agents';
import type { Ads2Competitors, Ads2OzMarketItem, Ads2WatchLink, Ads2WatchProduct, Ads2WbPosItem } from '../../../shared/ads2';
import {
  getAllLinks, suggestLinks, watchedIds, addLink, setLinkStatus, removeLink, parseNmId, parseOzonSku, getLatestPrices,
  type CompetitorLink, type WatchStatus,
} from '../competitorWatch';
import { rnpItems } from '../rnp';
import { wbImageUrl } from '../wbBasket';

const KEEP = 30;

function db(): any {
  const d = adsDb();
  if (!d) throw new Error('хранилище рекламы недоступно');
  d.exec(`CREATE TABLE IF NOT EXISTS ad_cabinet_snapshot (
    id INTEGER PRIMARY KEY AUTOINCREMENT, mp TEXT NOT NULL, at INTEGER NOT NULL, json TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS ad_cab_mp ON ad_cabinet_snapshot (mp, at);`);
  return d;
}

/** Записать снимок; вернуть короткую сводку для «Сборщиков». */
export function saveCabinetSnapshot(mp: AdMp, data: any): string {
  if (!data || typeof data !== 'object') throw new Error('пустой снимок');
  const d = db();
  d.prepare('INSERT INTO ad_cabinet_snapshot (mp, at, json) VALUES (?, ?, ?)').run(mp, Date.now(), JSON.stringify(data));
  d.prepare(`DELETE FROM ad_cabinet_snapshot WHERE mp = ? AND id NOT IN (SELECT id FROM ad_cabinet_snapshot WHERE mp = ? ORDER BY at DESC LIMIT ?)`).run(mp, mp, KEEP);
  let suggested = 0;
  try { suggested = autoSuggest(mp, data); } catch (e) { console.warn('[competitors] предложения не собраны:', (e as Error).message); }
  const sug = suggested ? `, предложено конкурентов ${suggested}` : '';
  const cards = Array.isArray(data.cards) ? `, карточек конкурентов ${data.cards.length}` : '';
  if (mp === 'wb') {
    const items = (data.report?.groups ?? []).reduce((s: number, g: any) => s + (g.items?.length ?? 0), 0);
    const pos = data.report?.positionInfo?.average?.current;
    const opened = Array.isArray(data.compDetails) ? `, отчётов сравнения ${data.compDetails.length}` : '';
    return `WB: карточек с позициями ${items}${pos != null ? `, средняя позиция ${pos}` : ''}, наборов сравнения ${data.comparisons?.history?.length ?? 0}${opened}${cards}${sug}`;
  }
  const items = (data.markets ?? []).reduce((s: number, m: any) => s + (m.items?.length ?? 0), 0);
  const p = data.positions?.[0]?.days?.at?.(-1);
  return `Ozon: категорий ${data.markets?.length ?? 0}, товаров рынка ${items}${p ? `, наше место ${p.my_position} из ${p.all_sellers}` : ''}${cards}${sug}`;
}

// ─── Привязка конкурентов к нашим товарам ───────────────────────────────────
// Хранилище — общее с карточкой товара (../competitorWatch.ts, файл av-data/competitors.json):
// ключ — наш артикул продавца, у каждой привязки источник (manual/auto) и статус
// (active — подтверждён, suggested — предложен системой, ignored — «не мой конкурент»).

const up = (s: unknown) => String(s ?? '').trim().toUpperCase();

const WORD_STOP = new Set(['подар', 'набор', 'компл', 'новый', 'новин', 'качес', 'лучши', 'товар', 'black', 'white', 'черны', 'белый']);
/** Значимые слова названия: от 4 букв, без цифр, по первым 5 буквам (грубая основа: «адаптер/адаптера»). */
export function titleWords(s: string): Set<string> {
  const out = new Set<string>();
  for (const w of s.toLowerCase().replace(/ё/g, 'е').split(/[^a-zа-я0-9]+/)) {
    if (w.length < 4 || /\d/.test(w)) continue;
    const st = w.slice(0, 5);
    if (!WORD_STOP.has(st)) out.add(st);
  }
  return out;
}

/** Наш справочник: артикул продавца ↔ номер на площадке (WB nmID, Ozon SKU). */
function ourCatalog(mp: AdMp): { byKey: Map<string, { id: string; name: string; photo: string }>; byId: Map<string, string> } {
  const byKey = new Map<string, { id: string; name: string; photo: string }>();
  const byId = new Map<string, string>();
  for (const r of rnpItems(mp)) {
    const key = up(mp === 'wb' ? r.article : (r.article || r.sku));
    const id = mp === 'wb' ? r.sku : r.extId;
    if (!key) continue;
    if (!byKey.has(key)) byKey.set(key, { id: id || '', name: r.name, photo: r.photo });
    if (id) byId.set(String(id), key);
  }
  return { byKey, byId };
}

/**
 * Предложить конкурентов из того, что агент снял в кабинете:
 *  WB  — товары из наборов «Сравнение карточек» (их собирают менеджеры) к нашему товару того же набора;
 *  Ozon — 5 лидеров по выручке в категории нашего товара («Товары на Ozon»).
 * Только «предложены»: в расчёты не идут, пока менеджер не подтвердит.
 */
export function autoSuggest(mp: AdMp, data: any): number {
  const { byId } = ourCatalog(mp);
  let n = 0;
  if (mp === 'wb') {
    for (const it of data?.report?.groups?.flatMap((g: any) => g.items ?? []) ?? []) if (it.nmId && it.vendorCode) byId.set(String(it.nmId), up(it.vendorCode));
    for (const h of data?.comparisons?.history ?? []) {
      const nms = (h.nms ?? []).filter((x: any) => x?.nmID && !x.isDeleted);
      const ours = nms.filter((x: any) => byId.has(String(x.nmID)));
      const others = nms.filter((x: any) => !byId.has(String(x.nmID)));
      for (const o of ours) n += suggestLinks('wb', byId.get(String(o.nmID))!, others.map((x: any) => ({ id: Number(x.nmID), title: String(x.nmName ?? ''), note: `из сравнения WB ${String(h.date ?? '')}`.trim() })));
    }
    return n;
  }
  const ourSeller = String(process.env.OZON_CLIENT_ID || '').trim();
  for (const m of data?.markets ?? []) {
    const items = m.items ?? [];
    const isOurs = (x: any) => (!!ourSeller && String(x.sellerId) === ourSeller) || !!x.blockedAsYourGood || byId.has(String(x.sku));
    const others = items.filter((x: any) => !isOurs(x));
    for (const o of items.filter(isOurs)) {
      const key = byId.get(String(o.sku)) ?? up(o.article);
      if (!key) continue;
      // Категория широкая (в «Устройство головное» и адаптер за 1,5 тыс., и бокс за 20 тыс.),
      // поэтому конкурент — лидер по выручке в коридоре цены нашего товара: от половины до двух цен.
      // Плюс хотя бы одно общее значимое слово в названии: иначе к адаптеру CarPlay попадают магнитолы.
      const our = num(o.avgPrice);
      const ourWords = titleWords(String(o.name ?? o.skuName ?? ''));
      const leaders = others
        .filter((x: any) => { const p = num(x.avgPrice); return !our || (p != null && p >= our / 2 && p <= our * 2); })
        .map((x: any, i: number) => ({ x, i, common: Math.min(3, [...titleWords(String(x.name ?? x.skuName ?? ''))].filter(w => ourWords.has(w)).length) }))
        .filter(c => !ourWords.size || c.common > 0)
        .sort((a, b) => b.common - a.common || a.i - b.i)
        .slice(0, 5).map(c => c.x);
      n += suggestLinks('ozon', key, leaders.map((x: any) => ({ id: Number(x.sku), title: String(x.name ?? x.skuName ?? ''), brand: String(x.brand ?? ''), note: `лидер Ozon «${String(x.category3 ?? '')}», цена и название близки к нашим` })), 5, true);
    }
  }
  return n;
}

/** Параметры задания competitor_watch: кого снимать на витрине (конкуренты + наши товары с привязками). */
export function watchParams(mp: AdMp): { watch: number[]; ours: number[] } {
  const { byKey } = ourCatalog(mp);
  const ours: number[] = [];
  for (const key of Object.keys(getAllLinks(mp))) {
    const id = Number(byKey.get(key)?.id);
    if (Number.isFinite(id) && id > 0) ours.push(id);
  }
  return { watch: watchedIds(mp, 80), ours: ours.slice(0, 40) };
}

/**
 * Правка привязок менеджером: add (ссылка или артикул конкурента), approve (взять в расчёт),
 * ignore («не мой конкурент» — система больше не предложит), restore, remove.
 */
export function editWatch(b: any): { ok: true } | { ok: false; error: string } {
  const mp: AdMp = b?.mp === 'ozon' ? 'ozon' : 'wb';
  const sku = up(b?.sku);
  if (!sku) return { ok: false, error: 'Выберите наш товар' };
  const action = String(b?.action ?? 'add');
  if (action === 'add') {
    const raw = String(b?.link ?? '').trim();
    const id = mp === 'wb' ? parseNmId(raw) : parseOzonSku(raw);
    if (!id) return { ok: false, error: mp === 'wb' ? 'Не разобрал артикул: нужна ссылка wildberries.ru/catalog/… или номер' : 'Не разобрал SKU: нужна ссылка ozon.ru/product/… или номер SKU' };
    if (mp === 'wb' && /ozon\./i.test(raw)) return { ok: false, error: 'Это ссылка Ozon — переключитесь на Ozon' };
    if (mp === 'ozon' && /wildberries|wb\.ru/i.test(raw)) return { ok: false, error: 'Это ссылка WB — переключитесь на WB' };
    const { byId } = ourCatalog(mp);
    if (byId.has(String(id))) return { ok: false, error: `Это наш товар (${byId.get(String(id))}), а не конкурент` };
    addLink(sku, id, { mp, source: 'manual', note: b?.note ? String(b.note).slice(0, 120) : undefined });
    return { ok: true };
  }
  const id = Number(b?.id);
  if (!Number.isFinite(id) || id <= 0) return { ok: false, error: 'нет номера конкурента' };
  if (action === 'remove') { removeLink(sku, id, mp); return { ok: true }; }
  const st: Record<string, WatchStatus> = { approve: 'active', ignore: 'ignored', restore: 'suggested' };
  if (!st[action]) return { ok: false, error: `неизвестное действие ${action}` };
  setLinkStatus(sku, id, st[action], mp);
  return { ok: true };
}

const num = (v: unknown): number | null => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const cur = (v: any): number | null => num(v?.current ?? v);
const dyn = (v: any): number | null => num(v?.dynamics);

/** Факторы ранжирования WB → подписи. Ключи — как в ответе table/recommendations. */
export const WB_FACTOR_LABEL: Record<string, string> = {
  conversion: 'низкая конверсия', moneyAmount: 'мало продаж в деньгах', action: 'нет акции', logistic: 'логистика/срок доставки',
  boostNmRating: 'рейтинг карточки', boostSellerRating: 'рейтинг продавца', disturbing: 'тревожный контент', marketingOnImage: 'реклама на фото',
  blur: 'размытые фото', marketingCharc: 'реклама в характеристиках', aiText: 'текст похож на ИИ', sameBg: 'одинаковый фон фото',
  badPkg: 'упаковка на фото', untidy: 'неопрятные фото',
};

export function parseWb(data: any): NonNullable<Ads2Competitors['wb']> {
  const rep = data?.report ?? {};
  const bad = new Map<string, string[]>();
  for (const r of data?.recommendations ?? []) {
    bad.set(String(r.nmID), Object.entries(WB_FACTOR_LABEL).filter(([k]) => r?.[k] === 'bad').map(([, l]) => l));
  }
  const items: Ads2WbPosItem[] = [];
  for (const g of rep.groups ?? []) for (const it of g.items ?? []) {
    items.push({
      nmId: String(it.nmId), name: String(it.name ?? ''), vendorCode: String(it.vendorCode ?? ''), photo: String(it.mainPhoto ?? ''),
      subject: String(it.subjectName ?? ''), isAdvertised: !!it.isAdvertised,
      price: num(it.price?.minPrice), rating: num(it.rating), feedbackRating: num(it.feedbackRating),
      avgPos: cur(it.avgPosition), avgPosDyn: dyn(it.avgPosition), views: cur(it.views), viewsDyn: dyn(it.views),
      ctr: cur(it.ctr), openCard: cur(it.openCard), orders: cur(it.orders), ordersDyn: dyn(it.orders), visibility: cur(it.visibility),
      bad: bad.get(String(it.nmId)) ?? [],
    });
  }
  const ours = new Set(items.map(i => i.nmId));
  const free = new Set((data?.comparisons?.limits?.availableWithoutCharge ?? []).map((s: number[]) => [...s].map(String).sort().join(',')));
  const opened = new Set((data?.compDetails ?? []).map((c: any) => String(c.id)));
  const lim = data?.comparisons?.limits ?? {};
  return {
    period: data?.period ?? null,
    summary: {
      avgPos: cur(rep.positionInfo?.average), avgPosDyn: dyn(rep.positionInfo?.average), medianPos: cur(rep.positionInfo?.median),
      visibility: cur(rep.visibilityInfo?.visibility), advertised: cur(rep.commonInfo?.advertisedProducts), total: num(rep.commonInfo?.totalProducts),
    },
    items,
    comparisons: {
      thisMonth: num(lim.comparisonsThisMonth), remaining: num(lim.remainingComparisonsThisMonth),
      agentLimit: DEFAULT_AGENT_SETTINGS.wb_comparisons_month_limit,
      sets: (data?.comparisons?.history ?? []).map((h: any) => {
        const nms = (h.nms ?? []).map((n: any) => ({ nmId: String(n.nmID), name: String(n.nmName ?? ''), photo: String(n.mainPhoto ?? ''), ours: ours.has(String(n.nmID)) }));
        return { date: String(h.date ?? ''), free: free.has(nms.map((n: any) => n.nmId).sort().join(',')), opened: opened.has(String(h.ID)), nms };
      }),
    },
  };
}

export function parseOzon(data: any, ourSellerId: string): NonNullable<Ads2Competitors['ozon']> {
  const toItem = (x: any, i: number): Ads2OzMarketItem => ({
    rank: i + 1, sku: String(x.sku ?? ''), name: String(x.name ?? x.skuName ?? ''), link: String(x.link ?? ''), photo: String(x.photo ?? ''),
    seller: String(x.sellerName ?? ''), ours: (!!ourSellerId && String(x.sellerId) === ourSellerId) || !!x.blockedAsYourGood,
    price: num(x.avgPrice), gmv: num(x.gmvSum ?? x.soldSum), sold: num(x.soldCount), salesDyn: num(x.salesDynamics),
    convSearch: num(x.convToCartSearch), convPdp: num(x.pdpToCartConversion ?? x.convToCartPdp), drr: num(x.drr),
    daysInPromo: num(x.daysInPromo), daysWithTrafarets: num(x.daysWithTrafarets),
  });
  const categories = (data?.markets ?? []).map((m: any) => {
    const all: Ads2OzMarketItem[] = (m.items ?? []).map(toItem);
    const b = m.benchmark ?? {};
    return {
      category3Id: String(m.category3Id), name: String(m.items?.[0]?.category3 ?? m.category3Id), updateDate: m.updateDate ?? null,
      ours: all.filter(x => x.ours), top: all.slice(0, 10),
      benchmark: { price: num(b.avgGmv), convSearch: num(b.convToCartSearch), convPdp: num(b.pdpToCartConversion), drr: num(b.drr) },
    };
  });
  const positions = (data?.positions ?? []).map((p: any) => {
    // В последний день место бывает 0 (продаж ещё нет) — берём последний день с местом.
    const days = p.days ?? [];
    const last = [...days].reverse().find((d: any) => Number(d?.my_position) > 0) ?? days.at(-1) ?? {};
    const ch = p.chart ?? {};
    const byDate = new Map<string, { my: number | null; competitor: number | null; best: number | null }>();
    const put = (arr: any[], k: 'my' | 'competitor' | 'best') => {
      for (const x of arr ?? []) {
        const e = byDate.get(x.start_date) ?? { my: null, competitor: null, best: null };
        e[k] = num(x.value);
        byDate.set(x.start_date, e);
      }
    };
    put(ch.my_index, 'my'); put(ch.closest_competitor, 'competitor'); put(ch.best_seller, 'best');
    // Имени категории 2-го уровня в ответах нет — называем по типам наших рынков внутри неё.
    const inside = (data?.markets ?? []).filter((m: any) => (m.items ?? []).some((x: any) => String(x.category2Id) === String(p.category2Id)))
      .map((m: any) => String(m.items?.[0]?.category3 ?? '')).filter(Boolean);
    return {
      category2Id: String(p.category2Id), name: inside.join(', ') || `категория ${p.category2Id}`, myPosition: num(last.my_position), myPositionDyn: num(last.my_position_dynamics),
      sellers: num(last.all_sellers), competitor: ch.competitor_name ?? null, percentDiff: num(ch.percent_diff),
      series: [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, v]) => ({ date, ...v })),
    };
  });
  return { categories, positions };
}

const blankLink = (id: string, mp: AdMp): Ads2WatchLink => ({
  id, url: mp === 'wb' ? `https://www.wildberries.ru/catalog/${id}/detail.aspx` : `https://www.ozon.ru/product/${id}/`,
  source: 'manual', status: 'active', title: '', brand: '', seller: '', note: '', photo: '',
  price: null, rating: null, feedbacks: null, stock: null, orders: null, ordersDyn: null, avgPos: null, ctr: null, openCard: null,
  inAds: null, inPromo: null, gmv: null, drr: null,
});

/** Фото карточки WB по номеру (basket-CDN, как на витрине). */
function wbPhoto(nm: string): string {
  const n = Number(nm);
  return Number.isFinite(n) && n > 0 ? wbImageUrl(n, 1, 'c246x328') : '';
}

/** Цифры по номеру товара из всего, что агент снял этой ночью. */
function metricsIndex(mp: AdMp, data: any): Map<string, Partial<Ads2WatchLink>> {
  const m = new Map<string, Partial<Ads2WatchLink>>();
  const put = (id: string, v: Partial<Ads2WatchLink>) => {
    const cur = m.get(id) ?? {};
    for (const [k, x] of Object.entries(v)) if (x != null && x !== '' && (cur as any)[k] == null) (cur as any)[k] = x;
    m.set(id, cur);
  };
  for (const c of data?.cards ?? []) {
    const id = String(c.id ?? c.sku ?? '');
    if (!id) continue;
    put(id, {
      title: c.name ? String(c.name) : undefined, brand: c.brand ? String(c.brand) : undefined,
      seller: c.seller ?? c.supplier ? String(c.seller ?? c.supplier) : undefined, photo: c.photo ? String(c.photo) : undefined,
      price: num(c.price), rating: num(c.rating), feedbacks: num(c.feedbacks ?? c.reviews), stock: num(c.qty),
    });
  }
  if (mp === 'wb') {
    for (const set of data?.compDetails ?? []) for (const x of set.nms ?? []) {
      put(String(x.nmId), {
        title: x.name || undefined, brand: x.brand || undefined, photo: x.photo || undefined,
        price: num(x.medianPrice) || num(x.minPrice), rating: num(x.rating), feedbacks: num(x.feedbacks),
        orders: num(x.orders), ordersDyn: num(x.ordersDyn), avgPos: num(x.avgPos), ctr: num(x.ctr), openCard: num(x.openCard),
        inAds: typeof x.inAds === 'boolean' ? x.inAds : null, inPromo: typeof x.inPromo === 'boolean' ? x.inPromo : null,
      });
    }
    for (const g of data?.report?.groups ?? []) for (const it of g.items ?? []) {
      put(String(it.nmId), { title: it.name || undefined, photo: it.mainPhoto || undefined, price: num(it.price?.minPrice), rating: num(it.feedbackRating),
        orders: cur(it.orders), ordersDyn: dyn(it.orders), avgPos: cur(it.avgPosition), ctr: cur(it.ctr), openCard: cur(it.openCard), inAds: !!it.isAdvertised });
    }
  } else {
    for (const mk of data?.markets ?? []) for (const x of mk.items ?? []) {
      put(String(x.sku), { title: x.name || undefined, brand: x.brand || undefined, seller: x.sellerName || undefined, photo: x.photo || undefined,
        price: num(x.avgPrice), gmv: num(x.gmvSum ?? x.soldSum), orders: num(x.soldCount), ordersDyn: num(x.salesDynamics), drr: num(x.drr),
        inPromo: num(x.daysInPromo) != null ? Number(x.daysInPromo) > 0 : null, inAds: num(x.daysWithTrafarets) != null ? Number(x.daysWithTrafarets) > 0 : null });
    }
  }
  return m;
}

/** Товары с конкурентами для вкладки: сначала те, у кого есть привязки, затем наши товары из снимка. */
export function buildWatch(mp: AdMp, data: any): { watch: Ads2WatchProduct[]; catalog: { key: string; name: string }[] } {
  const { byKey } = ourCatalog(mp);
  const links = getAllLinks(mp);
  const idx = metricsIndex(mp, data);
  const wbPrices = mp === 'wb' ? getLatestPrices(Object.values(links).flat().map(l => l.nmId)) : {};
  const toLink = (l: CompetitorLink): Ads2WatchLink => {
    const id = String(l.nmId);
    const x = idx.get(id) ?? {};
    const r = { ...blankLink(id, mp), ...x, source: l.source, status: l.status, note: l.note ?? '' };
    if (!r.title) r.title = l.title ?? '';
    if (!r.brand) r.brand = l.brand ?? '';
    if (r.price == null && (wbPrices as any)[l.nmId]) r.price = (wbPrices as any)[l.nmId].price;
    if (!r.photo && mp === 'wb') r.photo = wbPhoto(id);
    return r;
  };
  const keys = new Set(Object.keys(links));
  // Наши товары из снимка — чтобы было к чему привязать конкурента прямо из списка
  // (и номер/название/фото, если справочник РНП товар ещё не знает).
  const fromSnap = new Map<string, { id: string; name: string; photo: string }>();
  if (mp === 'wb') for (const g of data?.report?.groups ?? []) for (const it of g.items ?? []) {
    if (it.vendorCode) fromSnap.set(up(it.vendorCode), { id: String(it.nmId ?? ''), name: String(it.name ?? ''), photo: String(it.mainPhoto ?? '') });
  }
  else for (const mk of data?.markets ?? []) for (const x of mk.items ?? []) {
    const ourSeller = String(process.env.OZON_CLIENT_ID || '').trim();
    if ((ourSeller && String(x.sellerId) === ourSeller) || x.blockedAsYourGood) fromSnap.set(up(x.article), { id: String(x.sku ?? ''), name: String(x.name ?? ''), photo: String(x.photo ?? '') });
  }
  for (const k of fromSnap.keys()) keys.add(k);
  // и весь наш справочник площадки: «Все товары» — это все товары, а не только попавшие в снимок кабинета
  for (const [k, v] of byKey) if (v.id) keys.add(k);
  keys.delete('');
  const watch: Ads2WatchProduct[] = [...keys].map(key => {
    const cat = byKey.get(key)?.id ? byKey.get(key) : fromSnap.get(key) ?? byKey.get(key);
    const ourId = cat?.id ?? '';
    const ourM = ourId ? idx.get(ourId) : undefined;
    const our = ourId ? { ...blankLink(ourId, mp), ...(ourM ?? {}), title: cat?.name || ourM?.title || '', photo: cat?.photo || ourM?.photo || (mp === 'wb' ? wbPhoto(ourId) : '') } : null;
    const ls = (links[key] ?? []).map(toLink);
    const order = { active: 0, suggested: 1, ignored: 2 } as const;
    ls.sort((a, b) => order[a.status] - order[b.status] || (b.orders ?? -1) - (a.orders ?? -1));
    return { key, ourId, name: cat?.name || our?.title || key, photo: our?.photo ?? '', our, links: ls };
  });
  const live = (p: Ads2WatchProduct) => p.links.filter(l => l.status !== 'ignored').length;
  watch.sort((a, b) => Number(live(b) > 0) - Number(live(a) > 0) || live(b) - live(a) || a.name.localeCompare(b.name, 'ru'));
  for (const [k, v] of fromSnap) if (!byKey.has(k)) byKey.set(k, v);
  const catalog = [...byKey.entries()].map(([key, v]) => ({ key, name: v.name })).sort((a, b) => a.key.localeCompare(b.key)).slice(0, 2000);
  return { watch, catalog };
}

export function getCompetitors(mp: AdMp): Ads2Competitors {
  const d = db();
  const row = d.prepare('SELECT at, json FROM ad_cabinet_snapshot WHERE mp = ? ORDER BY at DESC LIMIT 1').get(mp) as any;
  if (!row) return { ok: true, mp, at: null, empty: true, errors: [], ...buildWatch(mp, null) };
  const data = JSON.parse(row.json);
  const base = { ok: true as const, mp, at: Number(row.at), empty: false, errors: (data?.errors ?? []).map(String).slice(0, 10), ...buildWatch(mp, data) };
  return mp === 'wb' ? { ...base, wb: parseWb(data) } : { ...base, ozon: parseOzon(data, String(process.env.OZON_CLIENT_ID || '').trim()) };
}
