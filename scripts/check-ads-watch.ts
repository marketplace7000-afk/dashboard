/**
 * «Реклама 2.0» → «Конкуренты»: привязка конкурентов к товарам (14.10.2026) —
 * разбор ссылок, правка менеджером, предложения системы, сборка цифр для вкладки.
 *
 * Запуск: node node_modules/tsx/dist/cli.mjs scripts/check-ads-watch.ts
 */
import './_ads-check-env';
import { readFileSync } from 'node:fs';
import { parseNmId, parseOzonSku } from '../api/_lib/competitorWatch';
import { editWatch, autoSuggest, buildWatch, watchParams, saveCabinetSnapshot, getCompetitors } from '../api/_lib/ads/cabinet';

let failed = 0;
function check(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n      получили ${JSON.stringify(actual)}\n      ждали    ${JSON.stringify(expected)}`}`);
}

process.env.OZON_CLIENT_ID = '466884';
// Привязки читаем из файла: на пути с кириллицей tsx грузит две копии модуля, и кэш
// копии, импортированной здесь, не видит записей, сделанных через cabinet.ts.
const store = () => JSON.parse(readFileSync(process.env.COMPETITORS_FILE!, 'utf8'));
const getWatchList = () => store();
const getLinks = (sku: string, mp: 'wb' | 'ozon' = 'wb'): any[] => (mp === 'wb' ? store().items : store().ozon ?? {})[sku]?.links ?? [];

console.log('Ссылки и артикулы');
check('WB ссылка', parseNmId('https://www.wildberries.ru/catalog/390744732/detail.aspx?targetUrl=GP'), 390744732);
check('WB число', parseNmId('390744732'), 390744732);
check('Ozon ссылка с названием', parseOzonSku('https://www.ozon.ru/product/besprovodnoy-adapter-carplay-3330519032/?at=abc'), 3330519032);
check('Ozon ссылка без названия', parseOzonSku('ozon.ru/product/3330519032'), 3330519032);
check('Ozon старая ссылка', parseOzonSku('https://www.ozon.ru/context/detail/id/154491355/'), 154491355);
check('Ozon SKU числом', parseOzonSku(' 3154491355 '), 3154491355);
check('Ozon: ссылка WB не принимается', parseOzonSku('https://www.wildberries.ru/catalog/390744732/detail.aspx'), null);

console.log('Правка менеджером');
check('без товара — ошибка', editWatch({ mp: 'wb', sku: '', link: '390744732' }).ok, false);
check('ссылка Ozon во вкладке WB — ошибка', editWatch({ mp: 'wb', sku: 'SOTA-RGB', link: 'https://www.ozon.ru/product/x-3330519032/' }).ok, false);
check('WB: привязать по ссылке', editWatch({ mp: 'wb', sku: 'sota-rgb', link: 'https://www.wildberries.ru/catalog/390744732/detail.aspx' }), { ok: true });
check('ручной сразу подтверждён', getLinks('SOTA-RGB').map(l => [l.nmId, l.source, l.status]), [[390744732, 'manual', 'active']]);
check('Ozon: привязать по SKU', editWatch({ mp: 'ozon', sku: 'CARLINKIT-ULTRA2-KRUG-8-128', link: '4392959400' }), { ok: true });
check('Ozon не попал в ветку WB (репрайсер/card.wb.ru)', Object.keys(getWatchList().items), ['SOTA-RGB']);

console.log('Предложения системы');
const wbData = {
  report: { groups: [{ items: [{ nmId: 1417220162, vendorCode: 'SOTA-RGB', name: 'Светильник соты', price: { minPrice: 3600 }, orders: { current: 34, dynamics: 10 }, avgPosition: { current: 16, dynamics: -2 } }] }] },
  comparisons: { history: [
    { ID: 'a', date: '2026-10-14', status: { available: true }, nms: [{ nmID: 257585393, nmName: 'Соты A' }, { nmID: 390744732, nmName: 'Соты B' }, { nmID: 321878641, nmName: 'Соты C' }, { nmID: 1417220162, nmName: 'Наш' }, { nmID: 832682672, nmName: 'Соты D' }] },
    { ID: 'b', date: '2026-09-01', status: { available: false }, nms: [{ nmID: 1417220162 }, { nmID: 111111111, nmName: 'Соты E' }, { nmID: 222222222, nmName: 'Соты F' }] },
  ] },
  compDetails: [{ id: 'a', date: '2026-10-14', nms: [
    { nmId: 390744732, name: 'Соты B', medianPrice: 3541, orders: 39, ordersDyn: 5, avgPos: 22, ctr: 4, inAds: false, inPromo: true },
    { nmId: 321878641, name: 'Соты C', medianPrice: 3528, orders: 5, avgPos: 33, inAds: true },
  ] }],
  cards: [{ id: 390744732, name: 'Светильник соты RGB', supplier: 'Odds & Ends', rating: 4.6, feedbacks: 73, price: 3832, qty: 42 }],
};
// 1 уже привязан вручную, 4 новых из двух наборов, лимит 5 живых на товар.
check('WB: из сравнений предложено до 5 на товар', autoSuggest('wb', wbData), 4);
const st = () => getLinks('SOTA-RGB').map(l => `${l.nmId}:${l.status}`);
check('порядок и статусы', st(), ['390744732:active', '257585393:suggested', '321878641:suggested', '832682672:suggested', '111111111:suggested']);
check('«Не наш конкурент»', editWatch({ mp: 'wb', sku: 'SOTA-RGB', action: 'ignore', id: 257585393 }), { ok: true });
check('повторный проход не возвращает отклонённого', autoSuggest('wb', wbData), 1);
check('вместо него следующий из сравнений', st(), ['390744732:active', '257585393:ignored', '321878641:suggested', '832682672:suggested', '111111111:suggested', '222222222:suggested']);
check('подтвердить предложенного', editWatch({ mp: 'wb', sku: 'SOTA-RGB', action: 'approve', id: 321878641 }), { ok: true });
check('удалить', editWatch({ mp: 'wb', sku: 'SOTA-RGB', action: 'remove', id: 222222222 }), { ok: true });
check('агенту — подтверждённые и предложенные, без отклонённых', watchParams('wb').watch.sort(), [111111111, 321878641, 390744732, 832682672]);

const ozData = { markets: [{ category3Id: '91915', items: [
  { sku: '3330519032', name: 'Адаптер дешёвый', avgPrice: 1528, sellerId: '1', category3: 'Устройство головное', gmvSum: 1e6 },
  { sku: '4392959400', name: 'TBox Ambient', avgPrice: 12851, sellerId: '2', category3: 'Устройство головное', gmvSum: 9e5 },
  { sku: '5555555555', name: 'Бокс конкурента', avgPrice: 17000, sellerId: '3', category3: 'Устройство головное', gmvSum: 8e5, drr: 6.5, soldCount: 40 },
  { sku: '3154491355', name: 'Наш Ultra 2', article: 'CARLINKIT-ULTRA2-KRUG-8-128', avgPrice: 19741, sellerId: '466884', category3: 'Устройство головное' },
] }] };
check('Ozon: лидеры только в коридоре цены (½–2× нашей)', autoSuggest('ozon', ozData), 1);
check('Ozon: дешёвый адаптер не предложен', getLinks('CARLINKIT-ULTRA2-KRUG-8-128', 'ozon').map(l => `${l.nmId}:${l.status}`), ['4392959400:active', '5555555555:suggested']);

console.log('Сборка для вкладки');
const w = buildWatch('wb', wbData);
const p = w.watch.find(x => x.key === 'SOTA-RGB')!;
check('товар с привязками первым', w.watch[0].key, 'SOTA-RGB');
const b = p.links.find(l => l.id === '390744732')!;
check('цифры: витрина + сравнение', [b.title, b.seller, b.price, b.rating, b.feedbacks, b.stock, b.orders, b.avgPos, b.inPromo], ['Светильник соты RGB', 'Odds & Ends', 3832, 4.6, 73, 42, 39, 22, true]);
const c = p.links.find(l => l.id === '321878641')!;
check('без карточки — цена из сравнения', [c.price, c.status], [3528, 'active']);
check('подтверждённые выше предложенных', p.links.slice(0, 2).map(l => l.status), ['active', 'active']);
const oz = buildWatch('ozon', ozData).watch.find(x => x.key === 'CARLINKIT-ULTRA2-KRUG-8-128')!;
check('Ozon: ДРР и продажи лидера', oz.links.filter(l => l.id === '5555555555').map(l => [l.drr, l.orders, l.seller === '' ? 'нет' : l.seller]), [[6.5, 40, 'нет']]);

console.log('Снимок и ответ API');
const sum = saveCabinetSnapshot('wb', wbData);
check('сводка для «Сборщиков»', /отчётов сравнения 1, карточек конкурентов 1/.test(sum), true);
const api = getCompetitors('wb');
check('ответ: набор с отчётом помечен', api.wb?.comparisons.sets.map(s => s.opened), [true, false]);
check('ответ: привязки и каталог', [api.watch.length > 0, Array.isArray(api.catalog)], [true, true]);

console.log(failed ? `\nПРОВАЛЕНО: ${failed}` : '\nВсе проверки прошли');
process.exit(failed ? 1 : 0);
