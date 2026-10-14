/**
 * «Реклама 2.0», этап 0: шлюз к площадкам, разбор кампаний и статистики WB,
 * хранилище ads.sqlite.
 *
 * Что проверяем:
 *   • шлюз выдерживает интервал ведра, пропускает действия вперёд истории,
 *     а 429 ставит паузу всему ведру и отдаёт «занято», не держа вызывающего;
 *   • кампании WB из /api/advert/v2/adverts (форма — из официальной спецификации);
 *   • fullstats: товар складывается по площадкам показа, корзины без разбивки
 *     раскладываются по кликам, позиция берётся из boosterStats;
 *   • хранилище: пересчёт дня заменяет строки, отметка «Не рекламировать»
 *     требует причину.
 *
 * Запуск: npm run check
 */
import './_ads-check-env';
import { join } from 'node:path';
import { gate, note, ruleFor, gatewayStatus, GatewayBusy, _resetGatewayForTests } from '../api/_lib/gateway';
import { parseWbAdverts, parseWbFullstats, parseOzonCampaigns, parseWbDailyLimits, parseOzonSkuStats, micro } from '../api/_lib/ads/sync';
import { parseWbFunnelHistory } from '../api/_lib/rnp';
import { applyAdAction } from '../api/_lib/ads/actions';
import * as store from '../api/_lib/ads/store';

let failed = 0;
function check(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n      получили ${JSON.stringify(actual)}\n      ждали    ${JSON.stringify(expected)}`}`);
}

async function main() {
  console.log('Шлюз');
  check('fullstats → своё ведро 20 с', ruleFor('https://advert-api.wildberries.ru/adv/v3/fullstats?ids=1')?.bucket, 'wb-adv:fullstats');
  check('bids/min не попадает в ведро bids', ruleFor('https://advert-api.wildberries.ru/api/advert/v1/bids/min')?.bucket, 'wb-adv:bids-min');
  check('чужие хосты без правила', ruleFor('https://api.anthropic.com/v1/messages'), null);

  _resetGatewayForTests();
  // Ведро с интервалом 200 мс: второй запрос ждёт, действие (0) обгоняет историю (2).
  const url = 'https://advert-api.wildberries.ru/api/advert/v2/adverts';
  await gate(url, 1);
  const order: string[] = [];
  const t0 = Date.now();
  await Promise.all([
    gate(url, 2).then(() => order.push('история')),
    gate(url, 0).then(() => order.push('действие')),
  ]);
  check('действие проходит раньше истории', order, ['действие', 'история']);
  check('интервал ведра выдержан (≥ 2 × 200 мс)', Date.now() - t0 >= 380, true);

  note(url, 429, 600);
  let busy: unknown = null;
  try { await gate(url, 1); } catch (e) { busy = e; }
  check('429 с окном 10 мин → «занято», вызывающий не висит', busy instanceof GatewayBusy, true);
  const st = gatewayStatus().find(b => b.bucket === 'wb-adv:adverts');
  check('пауза видна в состоянии шлюза', (st?.pausedForSec ?? 0) > 590, true);
  check('учтён 429', st?.throttled, 1);
  _resetGatewayForTests();

  console.log('Кампании WB');
  const adv = parseWbAdverts({
    adverts: [
      { bid_type: 'manual', id: 40772131, status: 9,
        settings: { name: 'Поиск/CARLINKIT-AMB-S2-8-128', payment_type: 'cpm', placements: { search: true, recommendations: false } },
        nm_settings: [{ nm_id: 923646381, bids_kopecks: { search: 87000, recommendations: 0 }, subject: { id: 1, name: 'Адаптеры' } }],
        timestamps: { created: '2026-10-08T10:00:00+03:00', started: '2026-10-08T10:05:00+03:00' } },
      { bid_type: 'unified', id: 40898103, status: 11,
        settings: { name: 'Клик/CP-CARLINKIT-MINI-DUBL', payment_type: 'cpc', placements: { search: true, recommendations: true } },
        nm_settings: [{ nm_id: 111, bids_kopecks: { search: 2300, recommendations: 2300 } }] },
    ],
  });
  check('две кампании', adv.campaigns.map(c => [c.id, c.status, c.payment]), [['40772131', 'active', 'cpm'], ['40898103', 'paused', 'cpc']]);
  check('ставка в копейках', adv.items[0].bid_search_kop, 87000);

  console.log('Статистика WB (fullstats)');
  const rows = parseWbFullstats([{
    advertId: 40772131,
    boosterStats: [{ date: '2026-10-12', nm: 923646381, avg_position: 7 }],
    days: [{
      date: '2026-10-12T00:00:00Z',
      apps: [
        { appType: 1, atbs: 4, nms: [{ nmId: 923646381, views: 100, clicks: 10, sum: 50, orders: 1, sum_price: 3000 }, { nmId: 222, views: 50, clicks: 10, sum: 20, orders: 0, sum_price: 0 }] },
        { appType: 64, atbs: 0, nms: [{ nmId: 923646381, views: 200, clicks: 5, sum: 40, orders: 1, sum_price: 3100 }] },
      ],
    }],
  }]);
  const main = rows.find(r => r.sku === '923646381')!;
  check('товар сложен по площадкам', [main.views, main.clicks, main.spend, main.orders, main.revenue], [300, 15, 90, 2, 6100]);
  check('корзины по кликам: 4 × 10/20', main.carts, 2);
  check('позиция из boosterStats', main.avg_pos, 7);
  check('дата без времени', main.date, '2026-10-12');

  console.log('Кампании Ozon');
  const oz = parseOzonCampaigns({ list: [{ id: '777', title: 'CARLINKIT', state: 'CAMPAIGN_STATE_RUNNING', paymentType: 'CPC', advObjectType: 'SKU',
    weeklyBudget: '7000000000', productAutopilotStrategy: 'TARGET_CIR', placement: ['PLACEMENT_SEARCH_AND_CATEGORY'] }] });
  check('недельный бюджет из миллионных долей рубля', oz[0].weekly_budget, 7000);
  check('статус и стратегия', [oz[0].status, oz[0].bid_type, oz[0].payment], ['active', 'TARGET_CIR', 'cpc']);
  // Прод 14.10: paymentType в списке нет — оплата выводится из объекта рекламы.
  const oz2 = parseOzonCampaigns({ list: [{ id: '1', state: 'CAMPAIGN_STATE_RUNNING', advObjectType: 'SKU' }, { id: '2', state: 'CAMPAIGN_STATE_INACTIVE', advObjectType: 'SEARCH_PROMO' }] });
  check('оплата без paymentType: SKU → cpc, «Оплата за заказ» → cpo', oz2.map(c => c.payment), ['cpc', 'cpo']);
  check('ставка Ozon "8000000" = 8 ₽', micro('8000000'), 8);

  console.log('Дневные лимиты WB');
  const lim = { id: '40898103', enabled: true, limitRub: 700, spentTodayRub: 120.5 };
  check('обёртка adverts', parseWbDailyLimits({ adverts: [{ advertId: 40898103, enabled: true, dailyLimit: 70000, spentToday: 12050 }] }), [lim]);
  check('корневой массив, snake_case', parseWbDailyLimits([{ advert_id: 40898103, is_enabled: true, daily_limit: 70000, spent_today: 12050 }]), [lim]);
  check('мусор → пусто', parseWbDailyLimits({ error: 'x' }), []);

  console.log('Статистика Ozon по товарам (statistics/products/sku)');
  const ozs = parseOzonSkuStats({ rows: [
    { campaignId: '777', sku: '5385887749', date: '2026-10-13', views: '1000', clicks: '40', toCart: '6', expense: '320,50', orders: '2', sales: '5980' },
    { campaignId: '777', sku: '5385887749', date: '2026-10-13T00:00:00Z', views: '10', clicks: '1', toCart: '0', expense: '8', orders: '0', sales: '0' },
  ] });
  check('рубли с запятой, дубли дня складываются', ozs.map(r => [r.date, r.views, r.clicks, r.spend, r.carts, r.orders, r.revenue]), [['2026-10-13', 1010, 41, 328.5, 6, 2, 5980]]);

  console.log('Воронка WB по дням (sales-funnel/products/history)');
  check('переходы и корзины по дням', parseWbFunnelHistory([{ product: { nmId: 923646381 }, history: [{ date: '2026-10-13', openCount: 120, cartCount: 14 }] }]),
    [{ nm: '923646381', date: '2026-10-13', open: 120, cart: 14 }]);

  console.log('Хранилище');
  store._useAdsDbForTests(':memory:');
  if (!store.adsDb()) { console.log('  — node:sqlite недоступен в этой версии Node, проверка хранилища пропущена'); }
  else {
    store.saveCampaigns('wb', adv.campaigns, adv.items);
    store.upsertDailyLimits('wb', [{ id: '40898103', enabled: true, limitRub: 700, spentTodayRub: 120.5 }]);
    const list = store.listCampaigns('wb');
    check('кампании сохранены с числом товаров', list.map(c => [c.id, c.items]).sort(), [['40772131', 1], ['40898103', 1]]);
    check('дневной лимит записан', list.find(c => c.id === '40898103')?.daily_limit, 700);

    store.saveStatDays('wb', rows);
    // Пересчёт того же дня без товара 222: строка товара должна исчезнуть.
    store.saveStatDays('wb', rows.filter(r => r.sku !== '222'));
    check('пересчёт дня заменяет строки', store.statSummary()[0]?.rows, 1);

    let err = '';
    try { store.setFlag('wb', '923646381', true, null, null, 'manager'); } catch (e) { err = (e as Error).message; }
    check('«Не рекламировать» без причины не ставится', err.startsWith('укажите причину'), true);
    store.setFlag('wb', '923646381', true, 'self_buyout', 'карточка под самовыкупы', 'manager');
    check('отметка стоит', store.isNoAds('wb', '923646381'), true);
    store.setFlag('wb', '923646381', false, null, null, 'manager');
    check('отметка снимается', store.isNoAds('wb', '923646381'), false);

    store.setFlag('ozon', '5933182946', true, 'phase_out', null, 'manager');
    check('архив пачкой', store.setArchived('ozon', ['5933182946', '5933182510', '5933182510'], true, 'self_buyout', 'manager'), 2);
    const af = () => store.listFlags().filter(x => x.mp === 'ozon').map(x => `${x.sku}:${x.archived}:${x.no_ads}:${x.reason}`).sort();
    check('архив = скрыт + «не рекламировать», прежняя причина сохраняется', af(), ['5933182510:true:true:self_buyout', '5933182946:true:true:phase_out']);
    store.setArchived('ozon', ['5933182510'], false, null, 'manager');
    check('возврат снимает только архив', af(), ['5933182510:false:true:self_buyout', '5933182946:true:true:phase_out']);

    store.logChange({ mp: 'wb', campaign_id: '40772131', sku: '923646381', actor: 'autopilot', action: 'bid',
      before: { search: 87000 }, after: { search: 95000 }, reason: 'позиция 3 → 7', status: 'proposed' });
    check('журнал пишет и читает JSON', store.listChanges(5)[0]?.after, { search: 95000 });
  }

  if (store.adsDb()) await checkActions();

  console.log(failed ? `\n✗ ошибок: ${failed}` : '\n✓ всё в порядке');
  process.exit(failed ? 1 : 0);
}

/**
 * Команды площадкам — без сети: fetch подменён, смотрим, что ушло бы в WB и Ozon.
 * Главное — единицы (WB копейки, Ozon миллионные доли) и что соседние товары
 * кампании Ozon отправляются со своими ставками.
 */
async function checkActions() {
  console.log('Команды площадкам (fetch подменён)');
  process.env.WB_TOKEN_PROMOTION = 'test';
  process.env.OZON_PERF_CLIENT_ID = 'id';
  process.env.OZON_PERF_CLIENT_SECRET = 'secret';
  const sent: { method: string; url: string; body: any }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any = {}) => {
    const u = String(url);
    if (u.endsWith('/api/client/token')) return new Response(JSON.stringify({ access_token: 't', expires_in: 1800 }), { status: 200 });
    sent.push({ method: init.method ?? 'GET', url: u, body: init.body ? JSON.parse(init.body) : null });
    if (u.includes('/daily-limits?')) return new Response(JSON.stringify({ adverts: [{ advertId: 40898103, enabled: true, dailyLimit: 150000, spentToday: 0 }] }), { status: 200 });
    if (u.includes('/daily-limits')) return new Response(JSON.stringify({ adverts: [{ advertId: 40898103, belowMinLimit: false, requiredLimit: 0 }] }), { status: 200 });
    if (u.includes('/v2/products')) return new Response(JSON.stringify({ products: [{ sku: '5385887749', bid: '9500000' }, { sku: '111', bid: '5000000' }] }), { status: 200 });
    return new Response('{}', { status: 200 });
  }) as any;
  try {
    // Модуль команд может получить свою копию store (на Windows с кириллицей в пути
    // tsx различает спецификаторы модуля) — поэтому обе копии работают с одним
    // файлом во временной папке, а не с базой в памяти.
    store._useAdsDbForTests(join(process.env.CACHE_DIR!, 'ads.sqlite'));
    const adv = parseWbAdverts({ adverts: [
      { bid_type: 'manual', id: 40772131, status: 9, settings: { name: 'Поиск', payment_type: 'cpm', placements: { search: true } },
        nm_settings: [{ nm_id: 923646381, bids_kopecks: { search: 87000, recommendations: 0 } }] },
      { bid_type: 'unified', id: 40898103, status: 11, settings: { name: 'Клик', payment_type: 'cpc', placements: { search: true, recommendations: true } },
        nm_settings: [{ nm_id: 111, bids_kopecks: { search: 2300, recommendations: 2300 } }] },
    ] });
    store.saveCampaigns('wb', adv.campaigns, adv.items);
    let r = await applyAdAction({ mp: 'wb', campaignId: '40772131', kind: 'bid', sku: '923646381', placement: 'search', valueRub: 950 });
    check('WB ставка 950 ₽ → 95000 копеек в поиск', [r.ok, sent.at(-1)?.method, sent.at(-1)?.body?.bids?.[0]?.nm_bids?.[0]], [true, 'PATCH', { nm_id: 923646381, bid_kopecks: 95000, placement: 'search' }]);
    r = await applyAdAction({ mp: 'wb', campaignId: '40772131', kind: 'bid', sku: '923646381', placement: 'search', valueRub: 3000 });
    check('скачок больше чем ×2 — нужно подтверждение, в площадку не ушло', [r.ok, r.needConfirm, sent.length], [false, true, 1]);
    r = await applyAdAction({ mp: 'wb', campaignId: '40772131', kind: 'daily_limit', valueRub: 1500 });
    check('дневной лимит у CPM-кампании не ставится', r.ok, false);
    r = await applyAdAction({ mp: 'wb', campaignId: '40898103', kind: 'daily_limit', valueRub: 1500 });
    const put = sent.find(s => s.method === 'PUT');
    check('WB лимит 1500 ₽ → 150000 копеек, без переноса, затем сверка', [r.ok, put?.body, r.message.includes('ВНИМАНИЕ')],
      [true, { advertIds: [40898103], enabled: true, dailyLimit: 150000, carryOverEnabled: false }, false]);
    r = await applyAdAction({ mp: 'wb', campaignId: '40772131', kind: 'pause' });
    check('WB пауза активной кампании', [r.ok, sent.at(-1)?.url.endsWith('/adv/v0/pause?id=40772131')], [true, true]);
    check('после паузы статус в базе обновлён', store.getCampaign('wb', '40772131')?.status, 'paused');

    store.saveCampaigns('ozon',
      [{ mp: 'ozon', id: '777', name: 'LIGHTS', status: 'active', status_code: null, payment: 'cpc', bid_type: 'TARGET_BIDS', placements: null,
         daily_limit: null, daily_limit_on: null, spent_today: null, weekly_budget: 26000, created_at: null, started_at: null },
       { mp: 'ozon', id: '778', name: 'MAX', status: 'active', status_code: null, payment: 'cpc', bid_type: 'MAX_CLICKS', placements: null,
         daily_limit: null, daily_limit_on: null, spent_today: null, weekly_budget: 7000, created_at: null, started_at: null }],
      [{ campaign_id: '777', sku: '5385887749', bid_raw: '8000000' }, { campaign_id: '777', sku: '111', bid_raw: '5000000' }, { campaign_id: '778', sku: '222', bid_raw: '0' }]);
    r = await applyAdAction({ mp: 'ozon', campaignId: '777', kind: 'bid', sku: '5385887749', valueRub: 9.5 });
    const ozPut = sent.find(s => s.method === 'PUT' && s.url.endsWith('/campaign/777/products'));
    check('Ozon ставка 9,5 ₽ → "9500000", сосед уходит со своей ставкой', [r.ok, [...(ozPut?.body?.bids ?? [])].sort((x: any, y: any) => x.sku.localeCompare(y.sku)), r.message.includes('ВНИМАНИЕ')],
      [true, [{ sku: '111', bid: '5000000' }, { sku: '5385887749', bid: '9500000' }], false]);
    r = await applyAdAction({ mp: 'ozon', campaignId: '778', kind: 'bid', sku: '222', valueRub: 10 });
    check('Ozon: при MAX_CLICKS ставку не трогаем', r.ok, false);
    r = await applyAdAction({ mp: 'ozon', campaignId: '777', kind: 'weekly_budget', valueRub: 30000 });
    const patch = sent.find(s => s.method === 'PATCH' && s.url.endsWith('/campaign/777'));
    check('Ozon недельный бюджет 30 000 ₽ → "30000000000"', [r.ok, patch?.body], [true, { weeklyBudget: '30000000000' }]);
    const log = store.listChanges(20);
    check('журнал: успехи и отказы записаны, неподтверждённый скачок — нет',
      [log.filter(l => l.status === 'applied').length, log.filter(l => l.status === 'failed').length], [5, 2]);
  } finally {
    globalThis.fetch = realFetch;
  }
}

void main();
