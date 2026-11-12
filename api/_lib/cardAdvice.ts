/**
 * «Ведение карточек»: рекомендации по карточке (02.11.2026).
 * Считаются правилами из свежих данных при каждом открытии раздела, поэтому меняются вместе с данными.
 * Ожидания между правками нет: работа динамичная, владелец решает сам, что делать. На площадках ничего не меняется.
 */
import { adsDb } from './ads/store';
import { rnpItems } from './rnp';
import { getCompetitors } from './ads/cabinet';
import type { Ads2WatchLink, Ads2WatchProduct } from '../../shared/ads2';
import { listPins, type CardPin } from './cards';
import { cardVisibility, type VisQuery } from './cardVisibility';
import { seoOverview } from './cardSeo';
import { listProposals, getAutopilotMode, ACTIONABLE } from './ads/autopilot';
import type { PlanRnp } from '../../shared/plan';

export type AdviceArea = 'margin' | 'ads' | 'text' | 'price' | 'stock' | 'sales';
export type AdviceLevel = 'high' | 'mid' | 'low';
export type Advice = {
  key: string; area: AdviceArea; level: AdviceLevel; title: string; why: string;
  /** Где в разделе смотреть подробности; ads — раздел «Реклама». */
  open: 'edits' | 'vis' | 'rules' | 'ads' | null;
  /** Полный текст автопилота, если подсказка сокращена. */
  more?: string;
  /** Предложение автопилота, которое можно применить кнопкой: команда уходит на площадку. */
  proposalId?: number;
};

const CACHE_MS = 5 * 60_000;
const DEFAULT_MIN_STOCK_DAYS = 14;
const SLOW_DAYS = 90;
const WASTE_RUB = 300;
/** Цена вдвое выше медианы первой десятки: скорее всего, там другой тип товара, сравнение ничего не значит. */
const PRICE_COMPARABLE = 2;

/** Правило владельца (01.11.2026): цену поднимаем постепенно, не больше 1 % в день от цены в кабинете продавца. */
export const PRICE_RAISE_PER_DAY = 0.01;
export function maxPriceToday(cabinetPrice: number): number { return Math.floor(cabinetPrice * (1 + PRICE_RAISE_PER_DAY)); }
export function daysToPrice(cabinetPrice: number, target: number): number {
  return target <= cabinetPrice ? 0 : Math.ceil(Math.log(target / cabinetPrice) / Math.log(1 + PRICE_RAISE_PER_DAY));
}

/** Текст автопилота коротко: первая фраза до расчёта, рубли без копеек. */
export function shortReason(text: string): string {
  const first = text.split(/(?<=[.!?])\s+(?=[А-ЯЁA-Z])/)[0].split(/:\s/)[0].replace(/[.;,\s]+$/, '');
  const clean = first.replace(/(\d[\d\s]*),\d+(?=\s*₽)/g, '$1').trim();
  return clean.length > 120 ? `${clean.slice(0, 117).replace(/\s+\S*$/, '')}…` : clean;
}

const rub = (n: number) => `${Math.round(n).toLocaleString('ru-RU')} ₽`;
const plural = (n: number, one: string, few: string, many: string) => {
  const a = n % 100, b = n % 10;
  return a >= 11 && a <= 14 ? many : b === 1 ? one : b >= 2 && b <= 4 ? few : many;
};
const queries = (n: number) => `${n} ${plural(n, 'запросу', 'запросам', 'запросам')}`;

const MIN_COMPETITORS = 3;
const FRESH_PRICE_MS = 7 * 86_400_000;
/** Дешевле рынка: цена покупателя ниже середины рынка больше чем на 3 %. Дороже: выше больше чем на 5 %. */
const BELOW_MARKET = 0.97, ABOVE_MARKET = 1.05;
const WEAK_RATIO = 0.8;
const ZERO_ORDERS_ADS = 1000;

const median = (v: (number | null | undefined)[]): number | null => {
  const a = v.filter((x): x is number => x != null && x > 0).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};
const pctDiff = (a: number, b: number) => Math.round((a / b - 1) * 100);
const pct1 = (n: number) => `${n.toLocaleString('ru-RU', { maximumFractionDigits: 1 })} %`;
const signed = (n: number) => `${n > 0 ? '+' : ''}${n} %`;

export type MarketRow = { label: string; our: string; market: string; range: string; note?: string };
export type CardMarket = {
  /** Хватает ли свежих цен закреплённых конкурентов, чтобы судить о цене. */
  known: boolean; n: number; total: number; at: number | null; summary: string; rows: MarketRow[];
  /** Цена покупателя: мы и середина рынка. */
  buyer: number | null; medianBuyer: number | null;
  our: Ads2WatchLink | null; links: Ads2WatchLink[];
};
type PriceSpot = 'below' | 'at' | 'above' | 'unknown';
const spotOf = (m: CardMarket | null): PriceSpot => {
  if (!m?.known || m.buyer == null || m.medianBuyer == null) return 'unknown';
  return m.buyer < m.medianBuyer * BELOW_MARKET ? 'below' : m.buyer > m.medianBuyer * ABOVE_MARKET ? 'above' : 'at';
};

function findWatch(p: CardPin, watch: Ads2WatchProduct[]): Ads2WatchProduct | undefined {
  const art = (p.article || p.sku).toUpperCase();
  return watch.find(w => w.ourId === p.sku || w.key === p.sku.toUpperCase() || w.key === art);
}

/** Наша карточка против конкурентов, закреплённых в разделе «Конкуренты». Те же данные, что там. */
export function marketOf(p: CardPin, w: Ads2WatchProduct | undefined): CardMarket | null {
  const active = (w?.links ?? []).filter(l => l.status === 'active');
  if (!w || !active.length) return null;
  const now = Date.now();
  const priced = active.filter(l => !l.hidden && l.stock !== 0 && (l.price ?? 0) > 0);
  const fresh = priced.filter(l => l.priceAt != null && now - l.priceAt < FRESH_PRICE_MS);
  const our = w.our;
  const buyer = p.margin?.buyer ?? our?.price ?? null;
  const prices = fresh.map(l => l.price!);
  const medianBuyer = median(prices);
  const known = fresh.length >= MIN_COMPETITORS && buyer != null;
  const at = fresh.length ? Math.max(...fresh.map(l => l.priceAt!)) : null;
  const rub0 = (n: number | null | undefined) => (n == null ? '—' : rub(n));
  const num0 = (n: number | null | undefined, d = 0) => (n == null ? '—' : n.toLocaleString('ru-RU', { maximumFractionDigits: d }));
  const row = (label: string, ours: number | null | undefined, list: (number | null | undefined)[], fmt: (n: number | null | undefined) => string, note?: string): MarketRow | null => {
    const v = list.filter((x): x is number => x != null && x > 0);
    if (ours == null && !v.length) return null;
    return { label, our: fmt(ours), market: fmt(median(v)), range: v.length ? `${fmt(Math.min(...v))} – ${fmt(Math.max(...v))}` : '—', ...(note ? { note } : {}) };
  };
  const pctFmt = (n: number | null | undefined) => (n == null ? '—' : `${num0(n, 1)} %`);
  const sameDays = active.filter(l => l.ordersDays === our?.ordersDays);
  const check = (l: Ads2WatchLink | null | undefined) => (l && l.gmv != null && l.orders ? l.gmv / l.orders : null);
  const spp = p.margin?.spp ?? null;
  const estRetail = (n: number) => (spp != null && spp < 100 ? Math.round(n / (1 - spp / 100)) : null);
  const inAds = active.filter(l => l.inAds === true).length, adsKnown = active.filter(l => l.inAds != null).length;
  const rows = [
    row('Цена покупателя', buyer, prices, rub0),
    row('Цена в кабинете', p.margin?.retail ?? p.price, prices.map(estRetail), rub0, 'У конкурентов это оценка при нашей СПП: их кабинет нам не виден'),
    row('CTR', our?.ctr, active.map(l => l.ctr), pctFmt),
    row('Конверсия в корзину', our?.convPdp, active.map(l => l.convPdp), pctFmt),
    row('Рейтинг', our?.rating, active.map(l => l.rating), n => num0(n, 1)),
    row('Отзывы', our?.feedbacks, active.map(l => l.feedbacks), n => num0(n)),
    row(`Заказы${our?.ordersDays ? ` за ${our.ordersDays} дн.` : ''}`, our?.orders, sameDays.map(l => l.orders), n => num0(n), our?.compDate ? `Из «Сравнения карточек» от ${our.compDate.split('-').reverse().join('.')}, поэтому может отличаться от столбца «Заказы, 7 дн»` : undefined),
    row('Средний чек', check(our), sameDays.map(check), rub0),
    ...(adsKnown ? [{ label: 'В рекламе', our: our?.inAds == null ? '—' : our.inAds ? 'да' : 'нет', market: `${inAds} из ${adsKnown}`, range: '—' }] : []),
  ].filter((r): r is MarketRow => r != null);
  const diff = known && medianBuyer != null ? pctDiff(buyer!, medianBuyer) : null;
  const summary = !known ? `мало свежих цен конкурентов (нужно от ${MIN_COMPETITORS})` : diff! > 5 ? `мы дороже на ${diff} %` : diff! < -3 ? `мы дешевле на ${-diff!} %` : 'мы в рынке';
  return { known, n: fresh.length, total: active.length, at, summary, rows, buyer, medianBuyer, our, links: active };
}

/** Сколько рекламы на продажу выдержит минимум маржи при нынешней цене. */
function adsRoom(p: CardPin): { now: number; allowed: number; preAdsPct: number; base: number } | null {
  const m = p.margin;
  if (!m || m.rubPerSale == null || m.adsRub == null || !m.base) return null;
  const preAds = m.rubPerSale + m.adsRub;
  return { now: m.adsRub, allowed: Math.floor(preAds - (m.minPct / 100) * m.base), preAdsPct: Math.round((preAds / m.base) * 1000) / 10, base: m.base };
}

/** Можно ли усиливать рекламу: маржа в норме, мы не дороже рынка и реклама ещё помещается в минимум. */
function canBoostAds(p: CardPin, market: CardMarket | null): boolean {
  const room = adsRoom(p);
  return !!p.margin && !p.margin.below && spotOf(market) !== 'above' && !!room && room.allowed > room.now;
}

/** Маржа ниже минимума: цену выше рынка не предлагаем, решение ищем в рекламе и расходах. */
function marginAdvice(p: CardPin, market: CardMarket | null): Advice | null {
  const m = p.margin;
  if (!m?.below || m.pct == null) return null;
  const spot = spotOf(market), room = adsRoom(p);
  const parts: string[] = [];
  const retail = m.retail ?? p.price;
  if (spot === 'below' && retail != null && m.buyer != null && market?.medianBuyer != null) {
    const toMarket = Math.floor(retail * (market.medianBuyer / m.buyer));
    const target = m.floorPrice != null ? Math.min(toMarket, m.floorPrice) : toMarket;
    if (target > retail) parts.push(`Мы дешевле рынка на ${-pctDiff(m.buyer, market.medianBuyer)} %: цену можно поднимать до ${rub(target)}, не больше 1 % в день (сегодня до ${rub(Math.min(maxPriceToday(retail), target))}, это примерно ${daysToPrice(retail, target)} дн.).`);
  } else if (spot === 'unknown') {
    parts.push('Цену не поднимаем: нет свежих цен хотя бы 3 закреплённых конкурентов, поэтому рынок неизвестен.');
  } else if (m.buyer != null && market?.medianBuyer != null) {
    const d = pctDiff(m.buyer, market.medianBuyer);
    parts.push(`Цену поднимать нельзя: покупатель платит ${rub(m.buyer)}, рынок ${rub(market.medianBuyer)} (${signed(d)}).${spot === 'above' ? ' Снижать тоже нельзя: упадёт маржа.' : ''}`);
  }
  if (room) {
    const drr = (v: number) => Math.round((v / room.base) * 1000) / 10;
    if (room.allowed <= 0) parts.push(`Реклама не спасёт: даже без неё маржа ${room.preAdsPct} %, ниже минимума ${m.minPct} %. Варианты: снизить закупку и логистику или осознанно изменить минимум в «Рамках». Рекламу держите на минимальной ставке.`);
    else if (room.allowed < room.now * 0.1) parts.push(`Решение: минимум допускает всего ${rub(room.allowed)} рекламы на продажу вместо ${rub(room.now)}, то есть рекламу придётся почти отключить. Заказы из рекламы при этом уйдут: решите, что важнее для этого товара, минимум или оборот.`);
    else if (room.now > room.allowed) parts.push(`Решение: снизить рекламу с ${rub(room.now)} до ${rub(room.allowed)} на продажу (ДРР с ${pct1(drr(room.now))} до ${pct1(drr(room.allowed))}). Этого хватит для минимума, но часть заказов из рекламы может уйти.`);
  }
  return { key: 'margin', area: 'margin', level: 'high', open: 'rules', title: `Маржа ${m.pct} % ниже минимума ${m.minPct} %`, why: parts.join(' ') || 'Проверьте расходы в разделе «Цены».' };
}

/** Мы дороже рынка, а маржа в норме: считаем, до какой цены можно снизиться без потери минимума. */
function priceAdvice(p: CardPin, market: CardMarket | null): Advice | null {
  const m = p.margin;
  if (!m || m.below || spotOf(market) !== 'above' || m.buyer == null || market?.medianBuyer == null) return null;
  const retail = m.retail ?? p.price;
  if (retail == null) return null;
  const d = pctDiff(m.buyer, market.medianBuyer);
  const toMarket = Math.round(retail * (market.medianBuyer / m.buyer));
  const target = Math.max(toMarket, m.floorPrice ?? 0);
  const head = `Покупатель платит ${rub(m.buyer)}, рынок ${rub(market.medianBuyer)}.`;
  if (target >= retail) return { key: 'price-high', area: 'price', level: 'mid', open: null, title: `Дороже рынка на ${d} %, снижать некуда`, why: `${head} Минимум маржи ${m.minPct} % не даёт опустить цену. Рекламу не усиливайте: дорогой товар она не вытянет.` };
  return { key: 'price-high', area: 'price', level: 'mid', open: null, title: `Дороже рынка на ${d} %: можно снизить цену`, why: `${head} Маржа позволяет снизить цену в кабинете с ${rub(retail)} до ${rub(target)}${target > toMarket ? ' (ниже уже минимум маржи, и мы всё равно останемся дороже рынка)' : ''} при той же СПП. Рекламу до этого не усиливайте.` };
}

/** Воронка против закреплённых конкурентов: только там, где данные есть с обеих сторон. */
function funnelAdvice(market: CardMarket | null): Advice[] {
  if (!market?.our) return [];
  const out: Advice[] = [], { our, links } = market;
  const ctr = median(links.map(l => l.ctr));
  if (our.ctr != null && ctr != null && our.ctr < ctr * WEAK_RATIO) out.push({ key: 'ctr', area: 'sales', level: 'mid', open: null, title: `CTR ${pct1(our.ctr)} ниже конкурентов (${pct1(ctr)})`, why: 'Покупатели реже нажимают на карточку в поиске: проверьте главное фото и цену в выдаче.' });
  const conv = median(links.map(l => l.convPdp));
  if (our.convPdp != null && conv != null && our.convPdp < conv * WEAK_RATIO) out.push({ key: 'conv', area: 'sales', level: 'mid', open: null, title: `Конверсия в корзину ${pct1(our.convPdp)} ниже конкурентов (${pct1(conv)})`, why: 'Карточку открывают, но не кладут в корзину: проверьте цену, отзывы и описание.' });
  const rating = median(links.map(l => l.rating));
  if (our.rating != null && rating != null && our.rating <= rating - 0.3) out.push({ key: 'rating', area: 'sales', level: 'mid', open: null, title: `Рейтинг ${our.rating} ниже конкурентов (${rating})`, why: 'Разберите последние низкие оценки в разделе «Отзывы и вопросы».' });
  const fb = median(links.map(l => l.feedbacks));
  if (our.feedbacks != null && fb != null && our.feedbacks < fb * 0.2) out.push({ key: 'reviews', area: 'sales', level: 'low', open: null, title: `Отзывов ${our.feedbacks.toLocaleString('ru-RU')} против ${Math.round(fb).toLocaleString('ru-RU')} у конкурентов`, why: 'Меньше доверия к карточке: это одна из причин дорогого рекламного заказа.' });
  return out;
}

function fromNumbers(p: CardPin, market: CardMarket | null): Advice[] {
  const out: Advice[] = [];
  const m = p.margin;
  const spot = spotOf(market);
  const margin = marginAdvice(p, market);
  if (margin) out.push(margin);
  const price = priceAdvice(p, market);
  if (price) out.push(price);
  const drr = p.cur?.drrPct;
  if (p.maxDrrPct != null && drr != null && drr > p.maxDrrPct) {
    out.push({ key: 'drr', area: 'ads', level: 'high', open: 'ads', title: `ДРР ${pct1(drr)} выше рамки ${pct1(p.maxDrrPct)}`, why: `Реклама за 7 дней: ${rub(p.cur!.ads)} при заказах на ${rub(p.cur!.amount)}. Снизьте ставки на запросы без заказов.` });
  }
  if (p.cur && p.cur.orders === 0 && p.cur.ads >= ZERO_ORDERS_ADS) {
    const dear = spot === 'above' && m?.buyer != null && market?.medianBuyer != null ? ` Покупатель платит ${rub(m.buyer)} при рынке ${rub(market.medianBuyer)}: сначала разберите цену.` : '';
    out.push({ key: 'ads-zero', area: 'ads', level: 'high', open: 'ads', title: `Реклама ${rub(p.cur.ads)} за 7 дней, заказов нет`, why: `Снизьте ставку или поставьте кампанию на паузу.${dear}` });
  }
  if (p.cur && p.prev && p.prev.orders >= 5 && p.cur.orders < p.prev.orders * 0.7) {
    const causes: string[] = [];
    const our = market?.our;
    if (our?.price != null && our.price7d != null && our.price > our.price7d * 1.03) causes.push(`наша цена покупателя выросла с ${rub(our.price7d)} до ${rub(our.price)}`);
    if (p.cur.ads < p.prev.ads * 0.7) causes.push(`реклама снизилась с ${rub(p.prev.ads)} до ${rub(p.cur.ads)}`);
    const lower = (market?.links ?? []).filter(l => l.price != null && l.price7d != null && l.price < l.price7d * 0.95).length;
    if (lower) causes.push(`снизили цену конкурентов: ${lower}`);
    if ((p.turnover?.here.fbo ?? 1) === 0) causes.push('на складах площадки нет остатка');
    out.push({ key: 'orders', area: 'sales', level: 'mid', open: null, title: `Заказы упали: ${p.cur.orders} против ${p.prev.orders} неделей раньше`, why: causes.length ? `Что изменилось: ${causes.join('; ')}.` : 'Цена, реклама и цены конкурентов заметно не менялись: посмотрите места в поиске и остатки.' });
  }
  const days = p.turnover?.here.days;
  const minDays = p.minStockDays ?? DEFAULT_MIN_STOCK_DAYS;
  if (days != null && days < minDays) {
    out.push({ key: 'stock-low', area: 'stock', level: 'high', open: 'rules', title: `Запаса хватит на ${days} дн.`, why: p.cur?.orders === 0 ? `Это меньше ${minDays} дн. по продажам за 28 дней, но за последние 7 дней заказов нет: сначала найдите причину, поставку вслепую не заказывайте.` : `Это меньше ${minDays} дн. Не поднимайте ставки и закажите поставку.` });
  } else if (days != null && days > SLOW_DAYS) {
    const why = !m || m.pct == null ? 'Маржа сейчас не посчитана: сначала проверьте её.'
      : m.below ? 'Но маржа ниже минимума: сначала верните маржу, потом ускоряйте продажи.'
      : spot === 'above' ? 'Мы дороже рынка: ускорять продажи рекламой бесполезно, сначала цена.'
      : canBoostAds(p, market) ? 'Маржа и цена позволяют усилить рекламу или участвовать в акциях.'
      : 'Запас рекламы в рамках минимума исчерпан: ускорять продажи только через акции с расчётом маржи.';
    out.push({ key: 'stock-slow', area: 'stock', level: 'mid', open: null, title: `Товар лежит: запаса на ${days} дн.`, why });
  }
  return [...out, ...funnelAdvice(market)];
}

/**
 * Связь с разделом «План» (12.11.2026): если товар отстаёт от плана месяца, совет говорит, сколько
 * нужно заказов в день, и чем можно ускориться с учётом маржи, цены против рынка и запаса рекламы.
 */
export function fromPlan(p: CardPin, market: CardMarket | null, plan: PlanRnp | null): Advice[] {
  if (!plan || plan.state === 'none') return [];
  const art = (p.article || p.sku).toUpperCase();
  const row = Object.entries(plan.byArticle).find(([k]) => k.toUpperCase() === art)?.[1];
  if (!row || !row.behind || row.needPerDay == null) return [];
  const m = p.margin;
  const spot = spotOf(market);
  const how = !m || m.pct == null ? 'Маржа сейчас не посчитана: сначала проверьте её.'
    : m.below ? 'Маржа ниже минимума: ускоряться рекламой или скидкой нельзя, сначала верните маржу.'
    : spot === 'above' ? 'Мы дороже рынка: сначала цена, реклама при такой цене план не догонит.'
    : canBoostAds(p, market) ? 'Маржа и цена позволяют усилить рекламу или взять акцию.'
    : 'Запас рекламы в рамках минимума исчерпан: остаются акции с расчётом маржи или пересмотр плана.';
  const pace = row.pace7 == null ? 'темп пока не посчитан' : `сейчас ${row.pace7.toLocaleString('ru-RU', { maximumFractionDigits: 1 })} в день`;
  return [{
    key: 'plan-behind', area: 'sales', level: 'mid', open: null,
    title: `План месяца: ${row.fact} из ${row.qty} шт., отстаём`,
    why: `До конца месяца ${plan.daysLeft} дн.: нужно ${row.needPerDay} заказов в день, ${pace}${plan.state === 'approved' ? '' : ' (план ещё не утверждён)'}. ${how}`,
  }];
}

async function fromAds(p: CardPin, market: CardMarket | null, ids: Set<string>, pending: Awaited<ReturnType<typeof listProposals>>): Promise<Advice[]> {
  const boost = canBoostAds(p, market);
  const canApply = getAutopilotMode().mode !== 'off';
  return pending
    .filter(a => a.mp === p.mp && a.sku != null && ids.has(String(a.sku)))
    // Совет «ничего не делать» действием не считаем.
    .filter(a => ACTIONABLE.includes(a.kind) || a.level === 'critical' || a.level === 'warn')
    // Предложение автопилота усилить рекламу не показываем, если этому мешает маржа или цена выше рынка.
    .filter(a => boost || !(a.fromValue != null && a.toValue != null && a.toValue > a.fromValue))
    .slice(0, 5).map(a => {
      const why = shortReason(a.reason);
      return {
        key: `ad-${a.id}`, area: 'ads' as const, level: a.level === 'critical' ? 'high' as const : a.level === 'warn' ? 'mid' as const : 'low' as const,
        open: 'ads' as const, title: a.title, why, ...(why !== a.reason ? { more: a.reason } : {}),
        ...(canApply && ACTIONABLE.includes(a.kind) ? { proposalId: a.id } : {}),
      };
    });
}

function fromVisibility(p: CardPin, market: CardMarket | null): Advice[] {
  if (p.mp !== 'ozon') return [];
  const excluded = new Set((adsDb()!.prepare("SELECT text FROM card_seo_mark WHERE mp = 'ozon' AND sku = ? AND mark = 'exclude'").all(p.sku) as { text: string }[]).map(r => r.text));
  const rows = cardVisibility(p.sku).filter(v => v.exact && v.ours?.pos != null && !excluded.has(v.query));
  const list = (l: VisQuery[], f: (v: VisQuery) => string) => l.slice(0, 3).map(f).join('; ');
  const out: Advice[] = [];
  const weak = rows.filter(v => v.diag.startsWith('Слабее по тексту'));
  if (weak.length) out.push({ key: 'vis-text', area: 'text', level: 'mid', open: 'vis', title: `Текст слабее лидеров по ${queries(weak.length)}`, why: `${list(weak, v => `«${v.query}»: ${v.ours!.pos}-е место, соответствие ${v.ours!.relevance} против ${v.topRelevance}`)}. Отметьте чужие запросы «Не наш», остальные добавьте в название и описание.` });
  const pricey = rows.filter(v => v.diag.startsWith('Цена выше') && v.ours!.price != null && v.topPrice != null && v.ours!.price <= v.topPrice * PRICE_COMPARABLE);
  // О цене судим по закреплённым конкурентам: в выдаче могут быть другие товары. Выдача только запасной вариант.
  if (pricey.length && !market?.known && !p.margin?.below) out.push({ key: 'vis-price', area: 'price', level: 'low', open: 'vis', title: `Цена выше первой десятки по ${queries(pricey.length)}`, why: `${list(pricey, v => `«${v.query}»: ${rub(v.ours!.price!)} против ${rub(v.topPrice!)}`)}. Снижать только в пределах минимальной маржи. Закрепите конкурентов, чтобы сравнение было точнее.` });
  const pop = rows.filter(v => v.diag.startsWith('Текст в порядке'));
  if (pop.length && canBoostAds(p, market)) out.push({ key: 'vis-pop', area: 'ads', level: 'low', open: 'vis', title: `Мало популярности по ${queries(pop.length)}`, why: `${list(pop, v => `«${v.query}»: ${v.ours!.pos}-е место`)}. Текст в порядке, карточке нужны продажи, маржа и цена позволяют усилить рекламу по этим запросам.` });
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

let cache: { at: number; data: Record<string, { items: Advice[]; failed: string[]; market: CardMarket | null }> } | null = null;

/** Рекомендации по всем закреплённым карточкам. Сбой одного источника не прячет остальные, но отмечается. */
export async function allAdvice(fresh = false): Promise<Record<string, { items: Advice[]; failed: string[]; market: CardMarket | null }>> {
  if (!fresh && cache && Date.now() - cache.at < CACHE_MS) return cache.data;
  const pins = await listPins();
  const pending = await listProposals(null).catch(() => null);
  const watch: Partial<Record<CardPin['mp'], Ads2WatchProduct[] | null>> = {};
  const watchOf = (mp: CardPin['mp']) => {
    if (watch[mp] === undefined) { try { watch[mp] = getCompetitors(mp).watch; } catch (e) { console.warn('[cards] конкуренты:', (e as Error)?.message); watch[mp] = null; } }
    return watch[mp];
  };
  const plans: Partial<Record<CardPin['mp'], PlanRnp | null>> = {};
  const planOf = async (mp: CardPin['mp']) => {
    if (plans[mp] === undefined) {
      try { plans[mp] = await (await import('./plan')).getPlanForRnp(mp); }
      catch (e) { console.warn('[cards] план месяца:', (e as Error)?.message); plans[mp] = null; }
    }
    return plans[mp] ?? null;
  };
  const data: Record<string, { items: Advice[]; failed: string[]; market: CardMarket | null }> = {};
  for (const p of pins) {
    const it = rnpItems(p.mp).find(i => i.sku === p.sku);
    const ids = new Set([p.sku, String(it?.extId ?? ''), p.article].filter(Boolean));
    const failed: string[] = [];
    const safe = async (name: string, f: () => Advice[] | Promise<Advice[]>): Promise<Advice[]> => {
      try { return await f(); } catch (e) { console.warn(`[cards] рекомендации, ${name}:`, (e as Error)?.message); failed.push(name); return []; }
    };
    if (!pending) failed.push('реклама');
    const w = watchOf(p.mp);
    if (w === null) failed.push('конкуренты');
    const market = w ? marketOf(p, findWatch(p, w)) : null;
    if (!p.margin) failed.push('маржа из раздела «Цены»');
    const plan = await planOf(p.mp);
    if (!plan) failed.push('план месяца');
    const items = [
      ...fromNumbers(p, market),
      ...fromPlan(p, market, plan),
      ...(pending ? await safe('реклама', () => fromAds(p, market, ids, pending)) : []),
      ...await safe('видимость в поиске', () => fromVisibility(p, market)),
      ...await safe('запросы и текст', () => fromSeo(p)),
    ].sort((a, b) => ORDER[a.level] - ORDER[b.level]);
    data[`${p.mp}:${p.sku}`] = { items, failed, market };
  }
  cache = { at: Date.now(), data };
  return data;
}
