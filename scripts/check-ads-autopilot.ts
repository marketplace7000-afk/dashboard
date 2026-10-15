/**
 * «Реклама 2.0», этап 2: автопилот-советник — правила и путь «предложение →
 * применить/отклонить» без сети (fetch подменён).
 *
 * Запуск: node node_modules/tsx/dist/cli.mjs scripts/check-ads-autopilot.ts
 */
import './_ads-check-env';
import { join } from 'node:path';
import * as store from '../api/_lib/ads/store';
import { buildProposals, saveProposals, listProposals, decideProposal, type AutopilotCtx } from '../api/_lib/ads/autopilot';
import type { Ads2Overview, Ads2Campaign, Ads2Product, Ads2Stat } from '../shared/ads2';

let failed = 0;
function check(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n      получили ${JSON.stringify(actual)}\n      ждали    ${JSON.stringify(expected)}`}`);
}

const stat = (s: Partial<Ads2Stat>): Ads2Stat => {
  const b = { views: 10000, clicks: 200, spend: 0, carts: 0, orders: 0, revenue: 0, ...s };
  return { ...b, ctr: null, cpc: null, cpo: null, drr: b.revenue > 0 ? Math.round((b.spend / b.revenue) * 10000) / 100 : null, avgPos: null };
};
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
  cardViews: null, carts: null, pdpToCart: null, cartToOrder: null, avgPos: null, price: 5000, marginPct: 30, marginRub: 1500,
  campaigns: [], flag: null, issues: [], series: { orders: [], spend: [] }, ...o,
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

  console.log('Правила');
  const ov = overview([
    // 1: ДРР 20% (> 2× нормы) — ставка вниз на 15%: 300 → 255
    camp('1', [item('101', 300, stat({ spend: 2000, orders: 2, revenue: 10000 }))]),
    // 2: ДРР 1%, 5 заказов, запас 60 дн — вверх 200 → 230
    camp('2', [item('102', 200, stat({ spend: 500, orders: 5, revenue: 50000 }))]),
    // 3: остаток 2 дня у единственного товара — пауза кампании
    camp('3', [item('103', 200, stat({ spend: 400, orders: 1, revenue: 5000 }))]),
    // 4: хорошая окупаемость, но корзина плохая — задача команде, а не повышение
    camp('4', [item('104', 200, stat({ spend: 500, orders: 5, revenue: 50000 }))]),
    // 5: товар «Не рекламировать» в общей кампании — задача убрать; сосед без изменений
    camp('5', [item('105', 200, stat({ spend: 100, orders: 1, revenue: 4000 }), true), item('106', 200, stat({ spend: 100, orders: 1, revenue: 4000 }))]),
    // 6: CPC без дневного лимита: 700 ₽ за 7 дней → 100 ₽/день × 1,3 → 130 ₽
    camp('6', [item('107', 20, stat({ spend: 700, orders: 1, revenue: 10000 }))], { payment: 'cpc', bidType: 'unified', can: { pause: true, start: false, bid: true, dailyLimit: true, weeklyBudget: false } }),
    // 7: на паузе — не трогаем
    camp('7', [item('108', 200, stat({ spend: 3000, orders: 0 }))], { status: 'paused', statusCode: 11 }),
  ], [
    prod('101'), prod('102'), prod('103', { daysOfStock: 2 }),
    prod('104', { issues: [{ code: 'cart_to_order', level: 'warn', text: 'Из корзины заказывают мало' }] }),
    prod('105'), prod('106'), prod('107'), prod('108'),
    prod('200', { issues: [{ code: 'no_ads_opportunity', level: 'info', text: '' }] }),
  ]);
  const ps = buildProposals(ov);
  const by = (cid: string | null, sku?: string) => ps.filter(p => p.campaignId === cid && (sku === undefined || p.sku === sku)).map(p => [p.kind, p.rule, p.fromValue, p.toValue]);
  check('ДРР 20% → ставка вниз 300 → 255', by('1'), [['bid', 'drr_high', 300, 255]]);
  check('окупается и есть запас → вверх 200 → 230', by('2'), [['bid', 'scale', 200, 230]]);
  check('остаток 2 дня у всех товаров → пауза кампании', by('3'), [['pause', 'stock_out', null, null]]);
  check('узкое место в корзине → задача, не повышение', by('4'), [['task', 'cart_to_order', null, null]]);
  check('«Не рекламировать» в общей кампании → задача убрать', by('5', '105'), [['task', 'flagged', null, null]]);
  check('CPC без лимита → лимит 130 ₽', by('6').filter(x => x[0] === 'daily_limit'), [['daily_limit', 'no_daily_limit', null, 130]]);
  check('кампанию на паузе не трогаем', by('7'), []);
  check('кандидат на новую кампанию — только совет', by(null, '200'), [['new_campaign', 'no_ads_opportunity', null, null]]);
  check('срочное — первым', ps[0].level, 'critical');

  const over = buildProposals(overview([camp('2', [item('102', 200, stat({ spend: 500, orders: 5, revenue: 50000 }))])], [prod('102')], 7.5));
  check('площадка выше бюджета (7,5% при 5%) — не повышаем', over.filter(p => p.kind === 'bid').length, 0);
  // Маржа 1500 ₽ → потолок заказа 600 ₽; факт 3000/4 = 750 ₽ при ДРР 5% (в норме) — всё равно вниз шагом 15%.
  const ceil = buildProposals(overview([camp('9', [item('109', 1000, stat({ spend: 3000, orders: 4, revenue: 60000 }))])], [prod('109', { marginRub: 1500 })]));
  check('заказ дороже 40% маржи → вниз шагом 15%', ceil.map(p => [p.rule, p.toValue]), [['above_ceiling', 850]]);
  // ДРР 1%, но заказ 550 ₽ при потолке 600: +15% выйдет за потолок — не повышаем.
  const noUp = buildProposals(overview([camp('10', [item('110', 200, stat({ spend: 2750, orders: 5, revenue: 275000 }))])], [prod('110', { marginRub: 1500 })]));
  check('повышение упрётся в потолок маржи — не предлагаем', noUp.length, 0);

  console.log('Этап В: конкуренты, край маржи, потолок ставки, норма категории, «худший ДРР первым»');
  const ctx = (o: Partial<AutopilotCtx>): AutopilotCtx => ({ marginFloorPct: 17.1, comps: new Map(), benchDrr: new Map(), ...o });
  const c1 = buildProposals(overview([camp('2', [item('102', 200, stat({ spend: 500, orders: 5, revenue: 50000 }))])], [prod('102')]),
    ctx({ comps: new Map([['102', { ourBuyer: 5000, prices: [4000, 4500], total: 2, outOfStock: 0, median: 4250, min: 4000 }]]) }));
  check('дороже конкурентов на 8%+ → задача по цене, не повышение', c1.map(p => [p.kind, p.rule]), [['task', 'comp_cheaper']]);
  // ДРР 4% (между «есть куда расти» и нормой), 4 заказа на 200 кликов — потолок ставки 240 ₽ не мешает.
  const c2 = buildProposals(overview([camp('2', [item('102', 200, stat({ spend: 2000, orders: 4, revenue: 50000 }))])], [prod('102')]),
    ctx({ comps: new Map([['102', { ourBuyer: 5000, prices: [], total: 2, outOfStock: 2, median: null, min: null }]]) }));
  check('у всех конкурентов нет в наличии → окно, вверх 200 → 230', c2.map(p => [p.kind, p.rule, p.toValue]), [['bid', 'comp_out', 230]]);
  const c3 = buildProposals(overview([camp('2', [item('102', 200, stat({ spend: 500, orders: 5, revenue: 50000 }))])], [prod('102', { marginPct: 16 })]), ctx({}));
  check('маржа 16% ниже края плана 17,1% → не повышаем', c3.length, 0);
  // CPC: 1 заказ на 200 кликов, маржа 1500 → потолок за клик 1500 × 40% × 0,5% = 3 ₽; ставка 20 → вниз шагом до 17
  const c4 = buildProposals(overview([camp('11', [item('111', 20, stat({ spend: 400, orders: 1, revenue: 10000 }))], { payment: 'cpc', bidType: 'unified', can: { pause: true, start: false, bid: true, dailyLimit: false, weeklyBudget: false } })], [prod('111', { marginRub: 1500 })]));
  check('ставка выше потолка за клик → вниз шагом', c4.map(p => [p.rule, p.toValue]), [['above_bid_ceiling', 17]]);
  const c5 = buildProposals(overview([camp('12', [item('112', 100, stat({ spend: 1200, orders: 2, revenue: 10000 }))])], [prod('112')]), ctx({ benchDrr: new Map([['112', 10]]) }));
  check('ДРР 12% при медиане категории 10% — в норме, ставку не снижаем', c5.filter(p => p.kind === 'bid').length, 0);
  const c6 = buildProposals(overview(
    Array.from({ length: 7 }, (_, i) => camp(`2${i}`, [item(`12${i}`, 200, stat({ spend: 550 + i * 50, orders: 1, revenue: 10000 }))])),
    Array.from({ length: 7 }, (_, i) => prod(`12${i}`)), 7.5));
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
