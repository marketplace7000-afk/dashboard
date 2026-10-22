/**
 * «Реклама 2.0», этап 2: автопилот-советник — правила и путь «предложение →
 * применить/отклонить» без сети (fetch подменён).
 *
 * Запуск: node node_modules/tsx/dist/cli.mjs scripts/check-ads-autopilot.ts
 */
import './_ads-check-env';
import { join } from 'node:path';
import * as store from '../api/_lib/ads/store';
import { buildProposals, saveProposals, listProposals, decideProposal, EMPTY_CTX, type AutopilotCtx } from '../api/_lib/ads/autopilot';
import { productEcon, zeroOrdersChance } from '../api/_lib/ads/econ';
import type { Ads2Overview, Ads2Campaign, Ads2Product, Ads2Stat, Ads2Econ } from '../shared/ads2';

let failed = 0;
function check(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n      получили ${JSON.stringify(actual)}\n      ждали    ${JSON.stringify(expected)}`}`);
}

const pc = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 10000) / 100 : null);
const stat = (s: Partial<Ads2Stat>): Ads2Stat => {
  const b = { views: 10000, clicks: 200, spend: 0, carts: 0, orders: 0, revenue: 0, ...s };
  return { shks: null, canceled: null, ...b, ctr: pc(b.clicks, b.views), cpc: b.clicks ? b.spend / b.clicks : null, cpo: b.orders ? b.spend / b.orders : null,
    drr: pc(b.spend, b.revenue), avgPos: null, cpm: b.views ? b.spend / b.views * 1000 : null,
    cartRate: pc(b.carts, b.clicks), cartToOrder: pc(b.orders, b.carts), cr: pc(b.orders, b.clicks) };
};
/** Экономика товара для проверок: допустимая цена заказа 600 ₽ (ДРР 12% от заказа 5000 ₽), товар в плюсе. */
const econ = (o: Partial<Ads2Econ> = {}): Ads2Econ => ({ marginBeforeAds: 1350, planPct: 15, buyoutPct: 100, allowedCpo: 600, allowedDrr: 12, profit: 10000, how: 'тест', ...o });
const camp = (id: string, items: Ads2Campaign['items'], over: Partial<Ads2Campaign> = {}): Ads2Campaign => ({
  mp: 'wb', id, name: `К${id}`, status: 'active', statusCode: 9, payment: 'cpm', bidType: 'manual',
  dailyLimit: null, dailyLimitOn: null, spentToday: null, weeklyBudget: null,
  can: { pause: true, start: false, bid: true, dailyLimit: false, weeklyBudget: false }, items, stat: null, ...over,
});
const item = (sku: string, bid: number, s: Ads2Stat | null, noAds = false): Ads2Campaign['items'][number] => ({
  sku, article: sku, name: sku, photo: '', productKey: sku, bidSearch: bid, bidReco: null, bid: null, targetCir: null, noAds, stat: s,
});
const prod = (sku: string, o: Partial<Ads2Product> = {}): Ads2Product => ({
  key: sku, adSku: sku, article: `A-${sku}`, name: sku, photo: '', category: '', link: null,
  orders: 10, revenue: 50000, spend: 1000, drr: 2, advOrders: 5, advShare: 50, stock: 500, daysOfStock: 60,
  stockFbo: null, stockFbs: null, outSince: null, spendSinceOut: 0,
  cardViews: null, carts: null, pdpToCart: null, cartToOrder: null, avgPos: null, ad: null, price: 5000, marginPct: 30, marginRub: 1500, econ: econ(),
  campaigns: [], flag: null, archived: false, issues: [], series: { orders: [], spend: [] }, ...o,
});

function overview(campaigns: Ads2Campaign[], products: Ads2Product[], drrPct = 4): Ads2Overview {
  return {
    ok: true, mp: 'wb', from: '2026-10-08', to: '2026-10-14', dates: [], days: [], campaigns, products,
    budget: { sharePct: 5, orders: 100000, spend: drrPct * 1000, budget: 5000, drrPct,
      month: { label: 'октябрь', orders: 0, spend: 0, budget: 0, daysPassed: 13, daysInMonth: 31, forecastOrders: 0, forecastSpend: 0, forecastBudget: 0 },
      today: { spend: 0, norm: 0 } },
    medians: { pdpToCart: null, cartToOrder: null }, lastSync: null, notes: [],
  };
}

async function main() {
  store._useAdsDbForTests(join(process.env.CACHE_DIR!, 'ads.sqlite'));
  if (!store.adsDb()) { console.log('node:sqlite недоступен — пропуск'); return; }

  console.log('Экономика и значимость (econ.ts)');
  // Маржа листа 1000 ₽ уже за вычетом рекламы 350 ₽ → до рекламы 1350; план 15% от 5000 = 750; выкуп 90% → (1350 − 750) × 0,9 = 540.
  const pe = productEcon({ marginRub: 1000, adsRub: 350, base: 5000, price: 5000, buyout: 90, planPct: 15, orders: 10, revenue: 50000, spend: 3000 });
  check('допустимая цена заказа — от маржи ДО рекламы', [pe?.marginBeforeAds, pe?.allowedCpo, pe?.allowedDrr], [1350, 540, 10.8]);
  check('прибыль товара после всей рекламы', pe?.profit, 10 * 0.9 * 1350 - 3000);
  check('нет маржи — экономики нет', productEcon({ marginRub: null, adsRub: null, base: 5000, price: 5000, buyout: null, planPct: 15, orders: 1, revenue: 1, spend: 1 }), null);
  check('59 кликов при CR 2% → P(0) ≈ 30%', Math.round(zeroOrdersChance(59, 0.02) * 100), 30);
  check('293 клика при CR 2% → P(0) ≈ 0,3%', Math.round(zeroOrdersChance(293, 0.02) * 1000) / 10, 0.3);

  console.log('Правила');
  const ov = overview([
    // 1: заказ 1000 ₽ при допустимом 600 → ставка вниз пропорционально, но не больше −30%: 300 → 210
    camp('1', [item('101', 300, stat({ spend: 2000, orders: 2, revenue: 10000 }))]),
    // 2: заказ 100 ₽ при допустимом 600, 5 заказов, запас 60 дн — вверх, не больше +20%: 200 → 240
    camp('2', [item('102', 200, stat({ spend: 500, orders: 5, revenue: 50000 }))]),
    // 3: остаток 2 дня у единственного товара — пауза кампании
    camp('3', [item('103', 200, stat({ spend: 400, orders: 1, revenue: 5000 }))]),
    // 5: товар «Не рекламировать» в общей кампании — задача убрать; сосед без изменений
    camp('5', [item('105', 200, stat({ spend: 100, orders: 1, revenue: 4000 }), true), item('106', 200, stat({ spend: 100, orders: 1, revenue: 4000 }))]),
    // 6: CPC без дневного лимита: 700 ₽ за 7 дней → 100 ₽/день × 1,3 → 130 ₽
    camp('6', [item('107', 20, stat({ spend: 700, orders: 1, revenue: 10000 }))], { payment: 'cpc', bidType: 'unified', can: { pause: true, start: false, bid: true, dailyLimit: true, weeklyBudget: false } }),
    // 7: на паузе — не трогаем
    camp('7', [item('108', 200, stat({ spend: 3000, orders: 0 }))], { status: 'paused', statusCode: 11 }),
  ], [
    prod('101', { drr: 20 }), prod('102'), prod('103', { daysOfStock: 2 }),
    prod('105'), prod('106'), prod('107'), prod('108'),
    prod('200', { issues: [{ code: 'no_ads_opportunity', level: 'info', text: '' }] }),
  ]);
  const ps = buildProposals(ov);
  const by = (cid: string | null, sku?: string, list = ps) => list.filter(p => p.campaignId === cid && (sku === undefined || p.sku === sku)).map(p => [p.kind, p.rule, p.fromValue, p.toValue]);
  check('заказ дороже допустимого → вниз пропорционально, не больше 30%: 300 → 210', by('1'), [['bid', 'above_allowed_cpo', 300, 210]]);
  check('заказ втрое дешевле допустимого → вверх не больше 20%: 200 → 240', by('2'), [['bid', 'scale', 200, 240]]);
  check('остаток 2 дня у всех товаров → пауза кампании', by('3'), [['pause', 'stock_out', null, null]]);
  check('«Не рекламировать» в общей кампании → задача убрать', by('5', '105'), [['task', 'flagged', null, null]]);
  check('CPC без лимита → лимит 130 ₽', by('6').filter(x => x[0] === 'daily_limit'), [['daily_limit', 'no_daily_limit', null, 130]]);
  check('кампанию на паузе не трогаем', by('7'), []);
  check('кандидат на новую кампанию — только совет', by(null, '200'), [['new_campaign', 'no_ads_opportunity', null, null]]);
  check('срочное — первым', ps[0].level, 'critical');
  check('у каждого предложения есть проверки, уверенность и срок замера', ps.every(p => p.details && p.details.checks.length > 0 && p.details.confidence && p.details.controlDays > 0), true);

  console.log('Обязательные сценарии из разбора менеджера (22.10.2026)');
  // HDMI-WIRELESS: 59 кликов, 2 631 ₽, 0 рекламных заказов — пауза не обоснована.
  const s1 = buildProposals(overview([camp('31', [item('131', 300, stat({ clicks: 59, spend: 2631.65, orders: 0 }))])], [prod('131', { orders: 3 })]));
  check('59 кликов без заказов → не пауза, «рано делать вывод»', by('31', undefined, s1).map(x => [x[0], x[1]]), [['task', 'too_early']]);
  // MASSAGE-GREEN: 293 клика без заказов, и без рекламы товар не продаётся — пауза.
  const s2 = buildProposals(overview([camp('32', [item('132', 300, stat({ clicks: 293, spend: 5624.28, orders: 0 }))])], [prod('132', { orders: 0, econ: econ({ profit: -5624 }) })]));
  check('293 клика без заказов и товар в минусе → пауза кампании', by('32', undefined, s2).map(x => [x[0], x[1]]), [['pause', 'spend_no_orders']]);
  // 293 клика без рекламных заказов, но товар продаётся и в плюсе — ограниченный тест, а не пауза.
  const s3 = buildProposals(overview([camp('33', [item('133', 300, stat({ clicks: 293, spend: 5624.28, orders: 0 }))])], [prod('133', { orders: 12 })]));
  check('без своих заказов, но товар в плюсе → ставка −20% как тест', by('33', undefined, s3), [['bid', 'no_direct_orders', 300, 240]]);
  check('у теста есть условие отката', s3[0]?.details?.rollback?.includes('все заказы товара') ?? false, true);
  // CARLINKIT-ULTRA2: ДРР 12,2% при прибыльной экономике (допустимый ДРР 25%) — не снижать из-за порога 5%.
  const s4 = buildProposals(overview([camp('34', [item('134', 15, stat({ spend: 1220, orders: 2, revenue: 10000 }))])], [prod('134', { econ: econ({ allowedCpo: 1250, allowedDrr: 25 }) })]));
  check('ДРР 12,2% при допустимом 25% → ставку не трогаем', s4.filter(p => p.kind === 'bid').length, 0);
  // MANIC-STICK: заказ 334,81 ₽ при «лимите» 14 ₽ — сначала проверить данные.
  const s5 = buildProposals(overview([camp('35', [item('135', 29.75, stat({ spend: 669.62, orders: 2, revenue: 3000 }))])], [prod('135', { econ: econ({ allowedCpo: 14, allowedDrr: 1 }) })]));
  check('CPO 334,81 при лимите 14 → «проверить данные», без команды', by('35', undefined, s5).map(x => [x[0], x[1]]), [['task', 'data_check']]);
  // Нет остатка, кампания общая — исключить товар, а не резать бюджет.
  const s6 = buildProposals(overview([camp('36', [item('136', 200, stat({ spend: 800, orders: 1, revenue: 5000 })), item('137', 200, stat({ spend: 500, orders: 5, revenue: 50000 }))])],
    [prod('136', { stock: 0, daysOfStock: 0 }), prod('137')]));
  check('нет остатка в общей кампании → задача исключить товар', by('36', '136', s6).map(x => [x[0], x[1]]), [['task', 'stock_out']]);
  // Ozon, ставку ведёт стратегия: убыточный товар — 15% расхода прибыльной кампании → бюджет не режем.
  const oz = (items: Ads2Campaign['items']) => camp('37', items, { mp: 'ozon', payment: 'cpc', bidType: 'MAX_CLICKS', weeklyBudget: 10000,
    can: { pause: true, start: false, bid: false, dailyLimit: false, weeklyBudget: true } });
  const ozItem = (sku: string, s: Ads2Stat) => ({ ...item(sku, 0, s), bidSearch: null, bid: null });
  const s7 = buildProposals({ ...overview([oz([ozItem('138', stat({ spend: 3000, orders: 3, revenue: 15000 })), ozItem('139', stat({ spend: 17000, orders: 60, revenue: 300000 }))])], [prod('138', { drr: 20 }), prod('139')]), mp: 'ozon' });
  check('РК с прибыльными и убыточными товарами → не урезаем всю кампанию', by('37', undefined, s7).map(x => [x[0], x[1]]), [['task', 'mixed_campaign']]);
  const s8 = buildProposals({ ...overview([oz([ozItem('138', stat({ spend: 17000, orders: 17, revenue: 85000 })), ozItem('139', stat({ spend: 3000, orders: 10, revenue: 50000 }))])], [prod('138', { drr: 20 }), prod('139')]), mp: 'ozon' });
  check('убыточный товар — бо́льшая часть расхода → бюджет вниз по расчёту', by('37', undefined, s8).map(x => [x[0], x[1], x[3]]), [['weekly_budget', 'above_allowed_cpo', 7000]]);

  // Замечание менеджера Ozon (MANIC-STICK-GREY-HX-2607, 22.10): ставка уже 10 ₽ — ниже Ozon не даёт;
  // вместо «10 → 7 ₽» — недельный бюджет, ориентир — расход конкурентов (выручка × ДРР).
  const ozCpc = (bid: number, s: Ads2Stat) => camp('40', [{ ...item('140', 0, s), bidSearch: null, bid }], { mp: 'ozon', payment: 'cpc', bidType: 'MAX_CLICKS', weeklyBudget: 35000,
    can: { pause: true, start: false, bid: true, dailyLimit: false, weeklyBudget: true } });
  const bad = stat({ clicks: 3733, spend: 34967, orders: 29, revenue: 206581 });
  const f1 = buildProposals({ ...overview([ozCpc(10, bad)], [prod('140', { drr: 17, econ: econ({ allowedCpo: 478.67, allowedDrr: 5 }) })]), mp: 'ozon' });
  check('ставка на минимуме 10 ₽ → не «10 → 7», а недельный бюджет −30%', f1.map(p => [p.kind, p.fromValue, p.toValue]), [['weekly_budget', 35000, 24500]]);
  const f2 = buildProposals({ ...overview([ozCpc(10, bad)], [prod('140', { drr: 17, econ: econ({ allowedCpo: 478.67, allowedDrr: 5 }) })]), mp: 'ozon' },
    { ...EMPTY_CTX, compSpend: new Map([['140', { weekly: 30000, drr: 5.6, n: 5, list: ['конкурент: ~4 286 ₽/день (ДРР 5,6%)'] }]]) });
  check('ориентир конкурентов 30 000 ₽ ниже экономики? нет — экономика строже, −30%', f2.map(p => p.toValue), [24500]);
  const f3 = buildProposals({ ...overview([ozCpc(10, stat({ clicks: 3733, spend: 34967, orders: 60, revenue: 306581 }))], [prod('140', { drr: 17, econ: econ({ allowedCpo: 550, allowedDrr: 5 }) })]), mp: 'ozon' },
    { ...EMPTY_CTX, compSpend: new Map([['140', { weekly: 30000, drr: 5.6, n: 5, list: ['конкурент: ~4 286 ₽/день (ДРР 5,6%)'] }]]) });
  check('экономика просит −5%, конкуренты тратят 30 000 → бюджет к 30 000', f3.map(p => p.toValue), [30000]);
  check('в карточке — расход конкурентов в день', f3[0]?.details?.checks.some(c => c.includes('/день')) ?? false, true);
  const f4 = buildProposals({ ...overview([ozCpc(12, bad)], [prod('140', { drr: 17, econ: econ({ allowedCpo: 478.67, allowedDrr: 5 }) })]), mp: 'ozon' });
  check('ставка 12 ₽ → не ниже минимума 10 ₽', f4.map(p => [p.kind, p.toValue]), [['bid', 10]]);

  const over = buildProposals(overview([camp('2', [item('102', 200, stat({ spend: 500, orders: 5, revenue: 50000 }))])], [prod('102')], 7.5));
  check('площадка выше бюджета (7,5% при 5%) — не повышаем', over.filter(p => p.kind === 'bid').length, 0);
  // Допустимый заказ 600 ₽; факт 3000/4 = 750 ₽ → вниз на 20% (600/750).
  const ceil = buildProposals(overview([camp('9', [item('109', 1000, stat({ spend: 3000, orders: 4, revenue: 60000 }))])], [prod('109', { drr: 20 })]));
  // Тот же дорогой рекламный заказ, но общий ДРР товара 2% при допустимом 12% и товар в плюсе — не режем.
  const tot = buildProposals(overview([camp('9', [item('109', 1000, stat({ spend: 3000, orders: 4, revenue: 60000 }))])], [prod('109')]));
  check('дорогой рекламный заказ, но товар в целом в плюсе → пояснение, без снижения', tot.map(p => [p.kind, p.rule]), [['task', 'cpo_high_total_ok']]);
  check('заказ на 25% дороже допустимого → ставка −20%', ceil.map(p => [p.rule, p.toValue]), [['above_allowed_cpo', 800]]);
  // Заказ 550 ₽ при допустимом 600 — в коридоре, ничего не делаем.
  const noUp = buildProposals(overview([camp('10', [item('110', 200, stat({ spend: 2750, orders: 5, revenue: 275000 }))])], [prod('110')]));
  check('заказ в пределах допустимого — без изменений', noUp.length, 0);
  // Узкое место в корзине (корзина → заказ 25% при медиане 50%) — задача команде, а не повышение.
  const funnel = buildProposals(overview([camp('4', [item('104', 200, stat({ spend: 500, orders: 5, carts: 20, revenue: 50000 }))])], [prod('104')]),
    { ...EMPTY_CTX, bench: { ctr: null, cartRate: null, cartToOrder: 50, cr: null } });
  check('узкое место «корзина → заказ» → задача, не повышение', funnel.map(p => [p.kind, p.rule]), [['task', 'order']]);

  console.log('Этап В: конкуренты, край маржи, потолок ставки, норма категории, «худший ДРР первым»');
  const ctx = (o: Partial<AutopilotCtx>): AutopilotCtx => ({ ...EMPTY_CTX, marginFloorPct: 17.1, ...o });
  const c1 = buildProposals(overview([camp('2', [item('102', 200, stat({ spend: 500, orders: 5, revenue: 50000 }))])], [prod('102')]),
    ctx({ comps: new Map([['102', { ourBuyer: 5000, prices: [4000, 4500], total: 2, outOfStock: 0, median: 4250, min: 4000 }]]) }));
  check('дороже конкурентов на 8%+ → задача по цене, не повышение', c1.map(p => [p.kind, p.rule]), [['task', 'comp_cheaper']]);
  const c2 = buildProposals(overview([camp('2', [item('102', 200, stat({ spend: 2000, orders: 4, revenue: 50000 }))])], [prod('102')]),
    ctx({ comps: new Map([['102', { ourBuyer: 5000, prices: [], total: 2, outOfStock: 2, median: null, min: null }]]) }));
  check('у всех конкурентов нет в наличии → окно, вверх 200 → 230', c2.map(p => [p.kind, p.rule, p.toValue]), [['bid', 'comp_out', 230]]);
  const c3 = buildProposals(overview([camp('2', [item('102', 200, stat({ spend: 500, orders: 5, revenue: 50000 }))])], [prod('102', { marginPct: 16 })]), ctx({}));
  check('маржа 16% ниже края плана 17,1% → не повышаем', c3.length, 0);
  // CPC: 1 заказ на 200 кликов, допустимый заказ 600 → клик не дороже 3 ₽; ставка 20 → вниз на 30% до 14.
  const c4 = buildProposals(overview([camp('11', [item('111', 20, stat({ spend: 400, orders: 1, revenue: 10000 }))], { payment: 'cpc', bidType: 'unified', can: { pause: true, start: false, bid: true, dailyLimit: false, weeklyBudget: false } })], [prod('111')]));
  check('ставка выше потолка за клик → вниз не больше 30%', c4.map(p => [p.rule, p.toValue]), [['above_bid_ceiling', 14]]);
  const c5 = buildProposals(overview([camp('12', [item('112', 100, stat({ spend: 1200, orders: 2, revenue: 10000 }))])], [prod('112')]), ctx({ benchDrr: new Map([['112', 10]]) }));
  check('ДРР 12% в пределах допустимого — ставку не снижаем', c5.filter(p => p.kind === 'bid').length, 0);
  const c6 = buildProposals(overview(
    Array.from({ length: 7 }, (_, i) => camp(`2${i}`, [item(`12${i}`, 200, stat({ spend: 550 + i * 50, orders: 1, revenue: 10000 }))])),
    Array.from({ length: 7 }, (_, i) => prod(`12${i}`, { econ: econ({ allowedDrr: 5 }) })), 7.5));
  const ob = c6.filter(p => p.rule === 'over_budget');
  check('перерасход площадки: снижаем только 5 товаров с худшим ДРР', [ob.length, ob.every(p => Number(p.sku!.slice(2)) >= 2)], [5, true]);

  console.log('Предложения: хранение');
  let r = saveProposals('wb', ps);
  check('записаны', r.added, ps.length);
  r = saveProposals('wb', ps);
  check('повтор того же — без дублей', [r.added, r.kept], [0, ps.length]);
  const changed = ps.map(p => (p.campaignId === '1' ? { ...p, toValue: 260 } : p)).filter(p => p.campaignId !== '2');
  r = saveProposals('wb', changed);
  check('новое значение заменяет старое, пропавшее закрывается', [r.added, r.closed], [1, 2]);

  console.log('Применить / отклонить (fetch подменён)');
  process.env.WB_TOKEN_PROMOTION = 'test';
  const sent: { method: string; url: string; body: any }[] = [];
  globalThis.fetch = (async (url: any, init: any = {}) => {
    sent.push({ method: init.method ?? 'GET', url: String(url), body: init.body ? JSON.parse(init.body) : null });
    return new Response('{}', { status: 200 });
  }) as any;
  const adv = { adverts: [{ bid_type: 'manual', id: 1, status: 9, settings: { name: 'К1', payment_type: 'cpm', placements: { search: true } },
    nm_settings: [{ nm_id: 101, bids_kopecks: { search: 30000, recommendations: 0 } }] }] };
  const { parseWbAdverts } = await import('../api/_lib/ads/sync');
  const pa = parseWbAdverts(adv);
  store.saveCampaigns('wb', pa.campaigns, pa.items);

  let open = await listProposals('wb');
  const p1 = open.find(p => p.campaignId === '1')!;
  let res = await decideProposal(p1.id, 'apply', 'менеджер', null);
  check('применено: WB получил 260 ₽ = 26000 копеек', [res.ok, sent.at(-1)?.body?.bids?.[0]?.nm_bids?.[0]?.bid_kopecks], [true, 26000]);
  check('журнал: автопилот, применено', store.listChanges(1)[0] && [store.listChanges(1)[0].actor, store.listChanges(1)[0].status], ['autopilot', 'applied']);
  res = await decideProposal(p1.id, 'apply', 'менеджер', null);
  check('повторно применить нельзя', res.ok, false);

  open = await listProposals('wb');
  const p3 = open.find(p => p.campaignId === '3')!;
  const before = sent.length;
  res = await decideProposal(p3.id, 'reject', 'менеджер', 'идёт поставка завтра');
  check('отклонено — площадке ничего не ушло', [res.ok, sent.length - before], [true, 0]);
  r = saveProposals('wb', changed);
  check('отклонённое 3 дня не предлагается снова', (await listProposals('wb')).some(p => p.campaignId === '3'), false);

  const hist = await listProposals('wb', true);
  check('в истории: применённое и отклонённое', hist.map(p => p.status).sort(), ['applied', 'rejected']);

  // Ставка изменилась после предложения — применять вслепую нельзя.
  const stale = saveProposals('wb', [{ ...ps.find(p => p.campaignId === '1')!, fp: 'wb|1|101|bid|search|x', fromValue: 999, toValue: 900 }]);
  const pst = (await listProposals('wb')).find(p => p.fp === 'wb|1|101|bid|search|x')!;
  res = await decideProposal(pst.id, 'apply', 'менеджер', null);
  check('ставка уже другая → предложение снято, команда не ушла', [stale.added, res.ok, res.message.startsWith('ставка уже изменилась')], [1, false, true]);

  console.log(failed ? `\n✗ ошибок: ${failed}` : '\n✓ всё в порядке');
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
