/**
 * Конкуренты и позиции из аналитики кабинетов — Агент 3 «Реклама», сценарий
 * competitor_watch на ПК (14.10.2026). Форматы — docs/ads-system/КАБИНЕТЫ_ДАННЫЕ_2026-10-14.md.
 *
 * Хост присылает сырые ответы кабинета; здесь храним снимок (ads.sqlite,
 * последние 30 на площадку) и разбираем последний для вкладки «Конкуренты».
 */
import { adsDb, type AdMp } from './store';
import { DEFAULT_AGENT_SETTINGS } from '../../../shared/agents';
import type { Ads2Competitors, Ads2OzMarketItem, Ads2WbPosItem } from '../../../shared/ads2';

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
  if (mp === 'wb') {
    const items = (data.report?.groups ?? []).reduce((s: number, g: any) => s + (g.items?.length ?? 0), 0);
    const pos = data.report?.positionInfo?.average?.current;
    return `WB: карточек с позициями ${items}${pos != null ? `, средняя позиция ${pos}` : ''}, наборов сравнения ${data.comparisons?.history?.length ?? 0}`;
  }
  const items = (data.markets ?? []).reduce((s: number, m: any) => s + (m.items?.length ?? 0), 0);
  const p = data.positions?.[0]?.days?.at?.(-1);
  return `Ozon: категорий ${data.markets?.length ?? 0}, товаров рынка ${items}${p ? `, наше место ${p.my_position} из ${p.all_sellers}` : ''}`;
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
        return { date: String(h.date ?? ''), free: free.has(nms.map((n: any) => n.nmId).sort().join(',')), nms };
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
    const last = (p.days ?? []).at(-1) ?? {};
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

export function getCompetitors(mp: AdMp): Ads2Competitors {
  const d = db();
  const row = d.prepare('SELECT at, json FROM ad_cabinet_snapshot WHERE mp = ? ORDER BY at DESC LIMIT 1').get(mp) as any;
  if (!row) return { ok: true, mp, at: null, empty: true, errors: [] };
  const data = JSON.parse(row.json);
  const base = { ok: true as const, mp, at: Number(row.at), empty: false, errors: (data?.errors ?? []).map(String).slice(0, 10) };
  return mp === 'wb' ? { ...base, wb: parseWb(data) } : { ...base, ozon: parseOzon(data, String(process.env.OZON_CLIENT_ID || '').trim()) };
}
