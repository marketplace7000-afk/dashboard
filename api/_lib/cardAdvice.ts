/**
 * «Ведение карточек»: рекомендации по карточке (02.11.2026).
 * Считаются правилами из свежих данных при каждом открытии раздела, поэтому меняются вместе с данными.
 * Ожидания между правками нет: работа динамичная, владелец решает сам, что делать. На площадках ничего не меняется.
 */
import { adsDb } from './ads/store';
import { rnpItems } from './rnp';
import { listPins, type CardPin } from './cards';
import { cardVisibility, type VisQuery } from './cardVisibility';
import { seoOverview } from './cardSeo';
import { listProposals } from './ads/autopilot';

export type AdviceArea = 'margin' | 'ads' | 'text' | 'price' | 'stock' | 'sales';
export type AdviceLevel = 'high' | 'mid' | 'low';
export type Advice = {
  key: string; area: AdviceArea; level: AdviceLevel; title: string; why: string;
  /** Где в разделе смотреть подробности; ads — раздел «Реклама». */
  open: 'edits' | 'vis' | 'rules' | 'ads' | null;
};

const CACHE_MS = 5 * 60_000;
const DEFAULT_MIN_STOCK_DAYS = 14;
const SLOW_DAYS = 90;
const WASTE_RUB = 300;
/** Цена вдвое выше медианы первой десятки: скорее всего, там другой тип товара, сравнение ничего не значит. */
const PRICE_COMPARABLE = 2;

const rub = (n: number) => `${Math.round(n).toLocaleString('ru-RU')} ₽`;
const plural = (n: number, one: string, few: string, many: string) => {
  const a = n % 100, b = n % 10;
  return a >= 11 && a <= 14 ? many : b === 1 ? one : b >= 2 && b <= 4 ? few : many;
};
const queries = (n: number) => `${n} ${plural(n, 'запросу', 'запросам', 'запросам')}`;

function fromNumbers(p: CardPin): Advice[] {
  const out: Advice[] = [];
  const m = p.margin;
  if (m?.below && m.pct != null) {
    const floor = m.floorPrice != null ? `Цена для минимума: от ${rub(m.floorPrice)}${p.price != null ? `, сейчас ${rub(p.price)}` : ''}. ` : '';
    out.push({ key: 'margin', area: 'margin', level: 'high', open: 'rules', title: `Маржа ${m.pct} % ниже минимума ${m.minPct} %`, why: `${floor}Поднимите цену или снизьте расход на рекламу. Разгонять рекламу сейчас нельзя: у маржи приоритет.` });
  }
  const drr = p.cur?.drrPct;
  if (p.maxDrrPct != null && drr != null && drr > p.maxDrrPct) {
    out.push({ key: 'drr', area: 'ads', level: 'high', open: 'ads', title: `ДРР ${drr} % выше рамки ${p.maxDrrPct} %`, why: `Реклама за 7 дней: ${rub(p.cur!.ads)} при заказах на ${rub(p.cur!.amount)}. Снизьте ставки на запросы без заказов.` });
  }
  if (p.cur && p.prev && p.prev.orders >= 5 && p.cur.orders < p.prev.orders * 0.7) {
    out.push({ key: 'orders', area: 'sales', level: 'mid', open: null, title: `Заказы упали: ${p.cur.orders} против ${p.prev.orders} неделей раньше`, why: 'Проверьте цену, остатки и рекламу: что из них менялось за неделю.' });
  }
  const days = p.turnover?.here.days;
  const minDays = p.minStockDays ?? DEFAULT_MIN_STOCK_DAYS;
  if (days != null && days < minDays) {
    out.push({ key: 'stock-low', area: 'stock', level: 'high', open: 'rules', title: `Запаса хватит на ${days} дн.`, why: `Это меньше ${minDays} дн. Не поднимайте ставки и закажите поставку.` });
  } else if (days != null && days > SLOW_DAYS) {
    out.push({ key: 'stock-slow', area: 'stock', level: 'mid', open: null, title: `Товар лежит: запаса на ${days} дн.`, why: !m || m.pct == null ? 'Маржа сейчас не посчитана: сначала проверьте её, потом ускоряйте продажи.' : m.below ? 'Но маржа ниже минимума: сначала верните маржу, потом ускоряйте продажи.' : 'Маржа позволяет: можно усилить рекламу или акции, чтобы ускорить оборот.' });
  }
  return out;
}

async function fromAds(p: CardPin, ids: Set<string>, pending: Awaited<ReturnType<typeof listProposals>>): Promise<Advice[]> {
  return pending.filter(a => a.mp === p.mp && a.sku != null && ids.has(String(a.sku))).slice(0, 5).map(a => ({
    key: `ad-${a.id}`, area: 'ads' as const, level: a.level === 'critical' ? 'high' as const : a.level === 'warn' ? 'mid' as const : 'low' as const,
    open: 'ads' as const, title: a.title, why: a.reason,
  }));
}

function fromVisibility(p: CardPin): Advice[] {
  if (p.mp !== 'ozon') return [];
  const excluded = new Set((adsDb()!.prepare("SELECT text FROM card_seo_mark WHERE mp = 'ozon' AND sku = ? AND mark = 'exclude'").all(p.sku) as { text: string }[]).map(r => r.text));
  const rows = cardVisibility(p.sku).filter(v => v.exact && v.ours?.pos != null && !excluded.has(v.query));
  const list = (l: VisQuery[], f: (v: VisQuery) => string) => l.slice(0, 3).map(f).join('; ');
  const out: Advice[] = [];
  const weak = rows.filter(v => v.diag.startsWith('Слабее по тексту'));
  if (weak.length) out.push({ key: 'vis-text', area: 'text', level: 'mid', open: 'vis', title: `Текст слабее лидеров по ${queries(weak.length)}`, why: `${list(weak, v => `«${v.query}»: ${v.ours!.pos}-е место, соответствие ${v.ours!.relevance} против ${v.topRelevance}`)}. Отметьте чужие запросы «Не наш», остальные добавьте в название и описание.` });
  const pricey = rows.filter(v => v.diag.startsWith('Цена выше') && v.ours!.price != null && v.topPrice != null && v.ours!.price <= v.topPrice * PRICE_COMPARABLE);
  if (pricey.length) out.push({ key: 'vis-price', area: 'price', level: 'low', open: 'vis', title: `Цена выше первой десятки по ${queries(pricey.length)}`, why: `${list(pricey, v => `«${v.query}»: ${rub(v.ours!.price!)} против ${rub(v.topPrice!)}`)}. Снижать только в пределах минимальной маржи.` });
  const pop = rows.filter(v => v.diag.startsWith('Текст в порядке'));
  if (pop.length) out.push({ key: 'vis-pop', area: 'ads', level: 'low', open: 'vis', title: `Мало популярности по ${queries(pop.length)}`, why: `${list(pop, v => `«${v.query}»: ${v.ours!.pos}-е место`)}. Текст в порядке, карточке нужны продажи: реклама на эти запросы, если маржа позволяет.` });
  return out;
}

async function fromSeo(p: CardPin): Promise<Advice[]> {
  const o = await seoOverview(p.mp, p.sku);
  const out: Advice[] = [];
  if (o.draft?.status === 'draft') out.push({ key: 'seo-draft', area: 'text', level: 'mid', open: 'edits', title: 'Черновик SEO ждёт решения', why: 'Посмотрите текст и подтвердите или отклоните его.' });
  const missing = o.gaps.filter(g => g.mark !== 'exclude' && g.missing.length > 0 && g.tier != null && g.tier !== 'НЧ');
  if (missing.length) {
    const confirmed = missing.filter(g => g.twin).length;
    out.push({ key: 'seo-gaps', area: 'text', level: 'mid', open: 'edits', title: `В тексте нет слов из ${queries(missing.length).replace('запросу', 'запроса').replace('запросам', 'запросов')} ВЧ и СЧ`, why: `Например: ${missing.slice(0, 3).map(g => `«${g.text}»`).join(', ')}.${confirmed ? ` Подтверждены второй площадкой: ${confirmed}.` : ''} Подготовьте черновик или отметьте чужие «Не наш».` });
  }
  const adOf = (g: (typeof o.gaps)[number]) => g.ad?.spend ?? 0;
  const foreign = o.gaps.filter(g => g.mark === 'exclude' && adOf(g) > 0);
  const spent = foreign.reduce((n, g) => n + adOf(g), 0);
  if (spent >= WASTE_RUB) out.push({ key: 'ad-foreign', area: 'ads', level: 'high', open: 'ads', title: `Реклама тратит на чужие запросы: ${rub(spent)}`, why: `${foreign.slice(0, 3).map(g => `«${g.text}»`).join(', ')}: вы отметили их «Не наш». Исключите их из кампании.` });
  const empty = o.gaps.filter(g => g.mark !== 'exclude' && adOf(g) >= WASTE_RUB && (g.ad?.orders ?? 0) === 0).sort((a, b) => adOf(b) - adOf(a));
  if (empty.length) out.push({ key: 'ad-empty', area: 'ads', level: 'mid', open: 'ads', title: `Реклама без заказов по ${queries(empty.length)}`, why: `${empty.slice(0, 3).map(g => `«${g.text}»: ${rub(adOf(g))}`).join('; ')}. Снизьте ставку или исключите запрос.` });
  return out;
}

const ORDER: Record<AdviceLevel, number> = { high: 0, mid: 1, low: 2 };

let cache: { at: number; data: Record<string, { items: Advice[]; failed: string[] }> } | null = null;

/** Рекомендации по всем закреплённым карточкам. Сбой одного источника не прячет остальные, но отмечается. */
export async function allAdvice(): Promise<Record<string, { items: Advice[]; failed: string[] }>> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.data;
  const pins = await listPins();
  const pending = await listProposals(null).catch(() => null);
  const data: Record<string, { items: Advice[]; failed: string[] }> = {};
  for (const p of pins) {
    const it = rnpItems(p.mp).find(i => i.sku === p.sku);
    const ids = new Set([p.sku, String(it?.extId ?? ''), p.article].filter(Boolean));
    const failed: string[] = [];
    const safe = async (name: string, f: () => Advice[] | Promise<Advice[]>): Promise<Advice[]> => {
      try { return await f(); } catch (e) { console.warn(`[cards] рекомендации, ${name}:`, (e as Error)?.message); failed.push(name); return []; }
    };
    if (!pending) failed.push('реклама');
    const items = [
      ...fromNumbers(p),
      ...(pending ? await safe('реклама', () => fromAds(p, ids, pending)) : []),
      ...await safe('видимость в поиске', () => fromVisibility(p)),
      ...await safe('запросы и текст', () => fromSeo(p)),
    ].sort((a, b) => ORDER[a.level] - ORDER[b.level]);
    data[`${p.mp}:${p.sku}`] = { items, failed };
  }
  cache = { at: Date.now(), data };
  return data;
}
