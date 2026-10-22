/**
 * Сводка раздела «Реклама» (этап 1, 14.10.2026): бюджет по правилу владельца,
 * кампании со статистикой и правами на ручные действия, товары с воронкой и
 * узкими местами.
 *
 * Новых запросов к площадкам не делает: товары, заказы, воронка, остатки, цена
 * и маржа — из базы РНП (getRnp), кампании, ставки и статистика кампаний — из
 * ads.sqlite. Экран открывается мгновенно и не тратит лимиты.
 *
 * Ключи товаров: в РНП у Ozon ключ — артикул продавца, а в рекламе — SKU
 * площадки; связь — rnp_item.ext_id (RnpItem.extId). У WB оба ключа — nmId.
 */
import { getRnp } from '../rnp';
import { mskDate } from '../mskDate';
import { listCampaigns, listItems, campaignStats, listFlags, statSummary, type CampaignStat } from './store';
import { lastAdsSync } from './sync';
import {
  ADS_BUDGET_SHARE, NO_ADS_REASON_LABEL,
  type Ads2Mp, type Ads2Overview, type Ads2Campaign, type Ads2Product, type Ads2Stat, type Ads2Issue, type Ads2Day,
} from '../../../shared/ads2';
import type { RnpResponse } from '../../../shared/rnp';

const DAY_MS = 86_400_000;
const addDays = (d: string, n: number) => new Date(Date.parse(d + 'T00:00:00Z') + n * DAY_MS).toISOString().slice(0, 10);
const r2 = (v: number) => Math.round(v * 100) / 100;
const pct = (n: number, d: number) => (d > 0 ? r2((n / d) * 100) : null);
const up = (s: string) => String(s ?? '').trim().toUpperCase();

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function toStat(s: Omit<CampaignStat, 'campaign_id' | 'sku' | 'days'> | null): Ads2Stat | null {
  if (!s) return null;
  return {
    views: s.views, clicks: s.clicks, spend: r2(s.spend), carts: s.carts, orders: s.orders, revenue: r2(s.revenue),
    ctr: pct(s.clicks, s.views), cpc: s.clicks > 0 ? r2(s.spend / s.clicks) : null,
    cpo: s.orders > 0 ? r2(s.spend / s.orders) : null, drr: pct(s.spend, s.revenue), avgPos: s.avg_pos,
  };
}

function addStat(acc: CampaignStat | undefined, s: CampaignStat): CampaignStat {
  if (!acc) return { ...s };
  const views = acc.views + s.views;
  // Позиция — средневзвешенная по показам.
  const pos = acc.avg_pos != null && s.avg_pos != null && views > 0
    ? (acc.avg_pos * acc.views + s.avg_pos * s.views) / views : (acc.avg_pos ?? s.avg_pos);
  return { ...acc, views, clicks: acc.clicks + s.clicks, spend: acc.spend + s.spend, carts: acc.carts + s.carts,
    orders: acc.orders + s.orders, revenue: acc.revenue + s.revenue, avg_pos: pos == null ? null : r2(pos) };
}

/** Сумма метрики РНП по товару за индексы дней. */
function sumIdx(rnp: RnpResponse, key: string, metric: string, idxs: number[]): number | null {
  const arr = rnp.facts[key]?.[metric];
  if (!arr) return null;
  let s: number | null = null;
  for (const i of idxs) { const v = arr[i]; if (v != null) s = (s ?? 0) + v; }
  return s;
}
const num0 = (v: number | null) => (v == null ? '–' : String(Math.round(v)));
function lastIdx(rnp: RnpResponse, key: string, metric: string, idxs: number[]): number | null {
  const arr = rnp.facts[key]?.[metric];
  if (!arr) return null;
  for (let j = idxs.length - 1; j >= 0; j--) { const v = arr[idxs[j]]; if (v != null) return v; }
  return null;
}

const ISO = /^d{4}-d{2}-d{2}$/;

/**
 * Сводка за период. По умолчанию — последние `days` дней по сегодня; с 22.10.2026
 * можно передать любой период `span` (вчера, позавчера, свои даты) — месяц,
 * прогноз и «сегодня» в бюджете всё равно считаются от текущего дня.
 */
export async function getAdsOverview(mp: Ads2Mp, days = 14, span?: { from?: string; to?: string }): Promise<Ads2Overview> {
  const notes: string[] = [];
  const today = mskDate(0);
  let to = span?.to && ISO.test(span.to) && span.to <= today ? span.to : today;
  let from = span?.from && ISO.test(span.from) ? span.from : addDays(to, -(Math.min(Math.max(days, 1), 90) - 1));
  if (from > to) [from, to] = [to, from];
  if (from < addDays(to, -179)) from = addDays(to, -179);
  const monthStart = today.slice(0, 8) + '01';
  const ma7From = addDays(today, -7);
  const loadFrom = [from, monthStart, ma7From].sort()[0];
  const rnp = await getRnp(mp, loadFrom, today);
  notes.push(...rnp.notes);

  const idxOf = new Map(rnp.dates.map((d, i) => [d, i]));
  const range = (a: string, b: string) => rnp.dates.map((d, i) => (d >= a && d <= b ? i : -1)).filter(i => i >= 0);
  const period = range(from, to);
  const dates = period.map(i => rnp.dates[i]);
  const last7 = range(addDays(today, -7), addDays(today, -1));  // 7 полных дней до сегодня
  const month = range(monthStart, today);
  const keys = Object.keys(rnp.facts);

  // ── Бюджет ────────────────────────────────────────────────────────────────
  const dayTotal = (metric: string, i: number) => keys.reduce((s, k) => s + (rnp.facts[k]?.[metric]?.[i] ?? 0), 0);
  const daysOut: Ads2Day[] = period.map(i => {
    const orders = r2(dayTotal('ordered_amount', i));
    return { date: rnp.dates[i], orders, spend: r2(dayTotal('adv_expenses', i)), budget: r2(orders * ADS_BUDGET_SHARE) };
  });
  const sumDays = (idxs: number[], metric: string) => idxs.reduce((s, i) => s + dayTotal(metric, i), 0);
  const pOrders = sumDays(period, 'ordered_amount');
  const pSpend = sumDays(period, 'adv_expenses');
  const avg7Orders = last7.length ? sumDays(last7, 'ordered_amount') / last7.length : 0;
  const avg7Spend = last7.length ? sumDays(last7, 'adv_expenses') / last7.length : 0;
  const todayI = idxOf.get(today);
  const dayOfMonth = Number(today.slice(8, 10));
  const daysInMonth = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 0)).getUTCDate();
  const monthDone = month.filter(i => rnp.dates[i] < today);    // без сегодняшнего неполного дня
  const mOrdersDone = sumDays(monthDone, 'ordered_amount');
  const mSpendDone = sumDays(monthDone, 'adv_expenses');
  const left = daysInMonth - (dayOfMonth - 1);
  const MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
  const budget: Ads2Overview['budget'] = {
    sharePct: ADS_BUDGET_SHARE * 100,
    orders: r2(pOrders), spend: r2(pSpend), budget: r2(pOrders * ADS_BUDGET_SHARE), drrPct: pct(pSpend, pOrders),
    month: {
      label: MONTHS[Number(today.slice(5, 7)) - 1], daysPassed: dayOfMonth - 1, daysInMonth,
      orders: r2(sumDays(month, 'ordered_amount')), spend: r2(sumDays(month, 'adv_expenses')),
      budget: r2(sumDays(month, 'ordered_amount') * ADS_BUDGET_SHARE),
      forecastOrders: r2(mOrdersDone + avg7Orders * left),
      forecastSpend: r2(mSpendDone + avg7Spend * left),
      forecastBudget: r2((mOrdersDone + avg7Orders * left) * ADS_BUDGET_SHARE),
    },
    today: { spend: todayI == null ? 0 : r2(dayTotal('adv_expenses', todayI)), norm: r2(avg7Orders * ADS_BUDGET_SHARE) },
  };

  // ── Справочники ───────────────────────────────────────────────────────────
  const itemByKey = new Map(rnp.items.map(it => [it.sku, it]));
  const keyByAdSku = new Map<string, string>();
  for (const it of rnp.items) keyByAdSku.set(mp === 'wb' ? it.sku : (it.extId ?? ''), it.sku);
  const flags = new Map(listFlags().filter(f => f.mp === mp).map(f => [f.sku, f]));

  // ── Кампании ──────────────────────────────────────────────────────────────
  const statsBySku = campaignStats(mp, from, to, true);
  const byCampSku = new Map(statsBySku.map(s => [`${s.campaign_id}|${s.sku}`, s]));
  const byCamp = new Map<string, CampaignStat>();
  for (const s of statsBySku) byCamp.set(s.campaign_id, addStat(byCamp.get(s.campaign_id), s));
  const items = listItems(mp);
  const itemsByCamp = new Map<string, typeof items>();
  for (const it of items) { const a = itemsByCamp.get(it.campaign_id) ?? []; a.push(it); itemsByCamp.set(it.campaign_id, a); }

  const campaigns: Ads2Campaign[] = listCampaigns(mp).map(c => {
    const its = itemsByCamp.get(c.id) ?? [];
    const sc = c.status_code;
    const isSkuOzon = mp === 'ozon' && c.payment === 'cpc';
    const can = mp === 'wb'
      ? { pause: sc === 9, start: sc === 4 || sc === 11, bid: sc === 4 || sc === 9 || sc === 11, dailyLimit: c.payment === 'cpc', weeklyBudget: false }
      : { pause: c.status === 'active' || c.status === 'out_of_budget', start: c.status === 'paused' || c.status === 'out_of_budget',
          bid: c.bid_type === 'TARGET_BIDS', dailyLimit: false, weeklyBudget: isSkuOzon };
    return {
      mp, id: c.id, name: c.name || `Кампания ${c.id}`, status: c.status ?? '', statusCode: sc,
      payment: c.payment, bidType: c.bid_type,
      dailyLimit: c.daily_limit, dailyLimitOn: c.daily_limit_on, spentToday: c.spent_today, weeklyBudget: c.weekly_budget,
      can,
      items: its.map(it => {
        const key = keyByAdSku.get(it.sku) ?? null;
        const ri = key ? itemByKey.get(key) : undefined;
        return {
          sku: it.sku, article: ri?.article ?? '', name: ri?.name || it.title || '', photo: ri?.photo ?? '', productKey: key,
          bidSearch: it.bid_search_kop == null ? null : it.bid_search_kop / 100,
          bidReco: it.bid_reco_kop == null ? null : it.bid_reco_kop / 100,
          bid: it.bid_raw == null ? null : Math.round(Number(it.bid_raw) / 10_000) / 100,
          targetCir: it.target_cir ?? null,
          noAds: !!flags.get(it.sku)?.no_ads,
          stat: toStat(byCampSku.get(`${c.id}|${it.sku}`) ?? null),
        };
      }),
      stat: toStat(byCamp.get(c.id) ?? null),
    };
  });

  // ── Товары ────────────────────────────────────────────────────────────────
  const campsBySku = new Map<string, { id: string; name: string; status: string }[]>();
  for (const c of campaigns) for (const it of c.items) {
    const a = campsBySku.get(it.sku) ?? [];
    a.push({ id: c.id, name: c.name, status: c.status });
    campsBySku.set(it.sku, a);
  }

  const products: Ads2Product[] = [];
  for (const key of keys) {
    const ri = itemByKey.get(key);
    const orders = sumIdx(rnp, key, 'ordered_cnt', period) ?? 0;
    const revenue = sumIdx(rnp, key, 'ordered_amount', period) ?? 0;
    const spend = sumIdx(rnp, key, 'adv_expenses', period) ?? 0;
    const stock = lastIdx(rnp, key, 'stocks', period);
    // Если остатка нет — с какого дня (последний день с остатком + 1) и сколько ушло на рекламу с тех пор.
    let outSince: string | null = null, spendSinceOut = 0;
    if (stock === 0) {
      const st = rnp.facts[key]?.stocks ?? [];
      for (let j = period.length - 1; j >= 0; j--) {
        const v = st[period[j]];
        if (v == null) continue;
        if (v > 0) break;
        outSince = rnp.dates[period[j]];
        spendSinceOut += rnp.facts[key]?.adv_expenses?.[period[j]] ?? 0;
      }
    }
    if (!orders && !spend && !stock) continue;
    const adSku = mp === 'wb' ? key : (ri?.extId ?? null);
    const advOrders = sumIdx(rnp, key, 'adv_orders', period) ?? 0;
    const ord7 = sumIdx(rnp, key, 'ordered_cnt', last7) ?? 0;
    const cardViews = sumIdx(rnp, key, 'session_view_pdp', period);
    const carts = sumIdx(rnp, key, 'hits_tocart', period);
    const posW = sumIdx(rnp, key, 'pos_weight', period);
    const posS = sumIdx(rnp, key, 'pos_wsum', period);
    const pv = rnp.prices?.[up(ri?.article ?? key)];
    const flag = adSku ? flags.get(adSku) : undefined;
    products.push({
      key, adSku, article: ri?.article ?? key, name: ri?.name ?? '', photo: ri?.photo ?? '', category: ri?.category ?? '',
      link: adSku ? (mp === 'wb' ? `https://www.wildberries.ru/catalog/${adSku}/detail.aspx` : `https://www.ozon.ru/product/${adSku}/`) : null,
      orders, revenue: r2(revenue), spend: r2(spend), drr: spend > 0 ? pct(spend, revenue) : null, advOrders, advShare: orders > 0 ? pct(advOrders, orders) : null,
      stock, daysOfStock: stock != null && ord7 > 0 ? Math.round(stock / (ord7 / 7)) : null,
      stockFbo: lastIdx(rnp, key, 'stocks_fbo', period), stockFbs: lastIdx(rnp, key, 'stocks_fbs', period),
      outSince, spendSinceOut: r2(spendSinceOut),
      cardViews, carts,
      pdpToCart: cardViews && carts != null ? pct(carts, cardViews) : null,
      cartToOrder: carts ? pct(orders, carts) : null,
      avgPos: posW ? r2(posS! / posW) : null,
      price: pv?.price ?? rnp.sellerPrices?.[up(ri?.article ?? key)] ?? null,
      marginPct: pv?.marginPct ?? null, marginRub: pv?.marginRub ?? null,
      campaigns: adSku ? campsBySku.get(adSku) ?? [] : [],
      flag: flag?.no_ads ? { reason: flag.reason ?? 'other', note: flag.note } : null,
      archived: !!flag?.archived,
      issues: [],
      series: {
        orders: period.map(i => rnp.facts[key]?.ordered_cnt?.[i] ?? null),
        spend: period.map(i => rnp.facts[key]?.adv_expenses?.[i] ?? null),
      },
    });
  }

  // ── Узкие места ───────────────────────────────────────────────────────────
  const work = products.filter(p => !p.archived); // архив (самовыкуп, дубли) не портит медианы
  const medPdp = median(work.filter(p => (p.cardViews ?? 0) >= 100 && p.pdpToCart != null).map(p => p.pdpToCart!));
  const medCart = median(work.filter(p => (p.carts ?? 0) >= 20 && p.cartToOrder != null).map(p => p.cartToOrder!));
  const target = ADS_BUDGET_SHARE * 100;
  for (const p of products) {
    const is: Ads2Issue[] = [];
    const running = p.campaigns.some(c => c.status === 'active');
    if (p.flag && running) is.push({ code: 'flagged_but_running', level: 'critical', text: `Отмечен «Не рекламировать» (${NO_ADS_REASON_LABEL[p.flag.reason] ?? p.flag.reason}), но реклама идёт` });
    if (p.archived) { p.issues = is; continue; } // в архиве — только сигнал «реклама идёт», остальное не нужно
    const mpName = mp === 'wb' ? 'WB' : 'Ozon';
    if (p.stock === 0 && p.spend > 0) {
      const since = p.outSince ? ` с ${p.outSince.slice(8, 10)}.${p.outSince.slice(5, 7)}` : '';
      is.push({ code: 'stock_critical', level: 'critical', text: `Нет остатка${since}: ${mpName} отдаёт 0 к продаже (FBO ${p.stockFbo ?? 0}, FBS ${p.stockFbs ?? 0}, за вычетом резерва) — ${p.spendSinceOut > 0 ? `а реклама потратила ${Math.round(p.spendSinceOut)} ₽ с тех пор; ` : ''}рекламу держать на паузе до поставки` });
    }
    else if (p.daysOfStock != null && p.daysOfStock < 3 && p.spend > 0) is.push({ code: 'stock_critical', level: 'critical', text: `Остатка на ${p.daysOfStock} дн (${num0(p.stock)} шт: FBO ${p.stockFbo ?? 0}, FBS ${p.stockFbs ?? 0}) — реклама разгонит спрос, которого нечем закрыть` });
    else if (p.daysOfStock != null && p.daysOfStock < 7 && p.spend > 0) is.push({ code: 'stock_low', level: 'warn', text: `Остатка на ${p.daysOfStock} дн (${num0(p.stock)} шт) — не повышать ставки до поставки` });
    if (p.spend >= 500 && p.orders === 0) is.push({ code: 'spend_no_orders', level: 'critical', text: `Расход ${Math.round(p.spend)} ₽ без единого заказа` });
    else if (p.drr != null && p.drr > target * 2 && p.spend >= 300) is.push({ code: 'drr_high', level: 'warn', text: `ДРР ${p.drr}% — больше чем вдвое выше нормы ${target}%` });
    if (medPdp != null && (p.cardViews ?? 0) >= 100 && p.pdpToCart != null && p.pdpToCart < medPdp * 0.6) {
      is.push({ code: 'card_to_cart', level: 'warn', text: `В корзину кладут ${p.pdpToCart}% против ${r2(medPdp)}% в среднем — карточка не убеждает (фото, цена, отзывы); реклама тут не поможет` });
    }
    if (medCart != null && (p.carts ?? 0) >= 20 && p.cartToOrder != null && p.cartToOrder < medCart * 0.6) {
      is.push({ code: 'cart_to_order', level: 'warn', text: `Из корзины заказывают ${p.cartToOrder}% против ${r2(medCart)}% — проверьте цену, срок доставки, наличие на складах` });
    }
    if (p.marginPct != null && p.marginPct < 10 && p.spend > 0) is.push({ code: 'low_margin', level: 'warn', text: `Маржа ${p.marginPct}% — рекламе почти не из чего платить` });
    if (!p.flag && !p.campaigns.length && p.orders >= 5 && (p.daysOfStock ?? 0) >= 30 && (p.marginPct == null || p.marginPct >= 20)) {
      is.push({ code: 'no_ads_opportunity', level: 'info', text: 'Продаётся без рекламы, запас большой — кандидат на кампанию (решает менеджер)' });
    }
    p.issues = is;
  }
  products.sort((a, b) => b.revenue - a.revenue || b.spend - a.spend);

  // Статистика «кампания × товар» у Ozon копится с 13.10.2026 (метод отдаёт только вчера и сегодня):
  // за более ранние дни «Кампании» покажут не всё, а «Товары» — полностью (из отчётов РНП).
  const statFrom = statSummary().find(x => x.mp === mp)?.from;
  if (statFrom && from < statFrom) notes.push(`Статистика по кампаниям ${mp === 'wb' ? 'WB' : 'Ozon'} есть с ${statFrom.split('-').reverse().join('.')} — за более ранние дни во вкладке «Кампании» цифры неполные; «Товары» и «Обзор» — полные.`);
  if (!campaigns.length) notes.push('Кампаний в базе ещё нет — сбор идёт в цепочке обновлений сервера раз в 2 часа.');
  return {
    ok: true, mp, from, to, dates, budget, days: daysOut, campaigns, products,
    medians: { pdpToCart: medPdp == null ? null : r2(medPdp), cartToOrder: medCart == null ? null : r2(medCart) },
    lastSync: lastAdsSync(), notes: [...new Set(notes)],
  };
}
