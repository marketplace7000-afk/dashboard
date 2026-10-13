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
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.CACHE_DIR = mkdtempSync(join(tmpdir(), 'av-check-ads2-'));

import { gate, note, ruleFor, gatewayStatus, GatewayBusy, _resetGatewayForTests } from '../api/_lib/gateway';
import { parseWbAdverts, parseWbFullstats, parseOzonCampaigns } from '../api/_lib/ads/sync';
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

    store.logChange({ mp: 'wb', campaign_id: '40772131', sku: '923646381', actor: 'autopilot', action: 'bid',
      before: { search: 87000 }, after: { search: 95000 }, reason: 'позиция 3 → 7', status: 'proposed' });
    check('журнал пишет и читает JSON', store.listChanges(5)[0]?.after, { search: 95000 });
  }

  console.log(failed ? `\n✗ ошибок: ${failed}` : '\n✓ всё в порядке');
  process.exit(failed ? 1 : 0);
}

void main();
