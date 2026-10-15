/**
 * «Реклама 2.0» → «Конкуренты»: привязка конкурентов к товарам (14.10.2026) —
 * разбор ссылок, правка менеджером, предложения системы, сборка цифр для вкладки.
 *
 * Запуск: node node_modules/tsx/dist/cli.mjs scripts/check-ads-watch.ts
 */
import './_ads-check-env';
import { readFileSync } from 'node:fs';
import { parseNmId, parseOzonSku } from '../api/_lib/competitorWatch';
import { editWatch, autoSuggest, buildWatch, watchParams, saveCabinetSnapshot, getCompetitors, requestRefresh, refreshState, posSeries, hiddenCards } from '../api/_lib/ads/cabinet';
import { adsDb } from '../api/_lib/ads/store';
import { listTasks, maintainQueue } from '../api/_lib/agentQueue';

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
  { sku: '3330519032', name: 'Беспроводной адаптер CarPlay и Android Auto 2-в-1', avgPrice: 1528, sellerId: '1', category3: 'Устройство головное', gmvSum: 1e6 },
  { sku: '4392959400', name: 'блютуз адаптер для авто CarPlay Carlinkit TBox Ambient', avgPrice: 12851, sellerId: '2', category3: 'Устройство головное', gmvSum: 9e5 },
  { sku: '6666666666', name: 'Магнитола 9 дюймов андроид Урал Шторм 6+128ГБ', avgPrice: 18920, sellerId: '4', category3: 'Устройство головное', gmvSum: 8.5e5 },
  { sku: '5555555555', name: 'Carlinkit Tbox Ultra 2в1 Сarplay Android auto бокс', avgPrice: 17000, sellerId: '3', category3: 'Устройство головное', gmvSum: 8e5, drr: 6.5, soldCount: 40 },
  { sku: '3154491355', name: 'Carlinkit Ultra 2 AI Box 8/128 ГБ, Android 15, CarPlay и Android Auto', article: 'CARLINKIT-ULTRA2-KRUG-8-128', avgPrice: 19741, sellerId: '466884', category3: 'Устройство головное' },
] }] };
check('Ozon: лидеры только в коридоре цены (½–2× нашей)', autoSuggest('ozon', ozData), 1);
check('Ozon: дешёвый адаптер и магнитола не предложены', getLinks('CARLINKIT-ULTRA2-KRUG-8-128', 'ozon').map(l => `${l.nmId}:${l.status}`), ['4392959400:active', '5555555555:suggested']);
const ozNext = { markets: [{ ...ozData.markets[0], items: ozData.markets[0].items.filter(x => x.sku !== '5555555555') }] };
autoSuggest('ozon', ozNext);
check('Ozon: выпавший из рынка нетронутый лидер убран, подтверждённый остался', getLinks('CARLINKIT-ULTRA2-KRUG-8-128', 'ozon').map(l => `${l.nmId}:${l.status}`), ['4392959400:active']);
autoSuggest('ozon', ozData);

console.log('Сборка для вкладки');
const w = buildWatch('wb', wbData);
const p = w.watch.find(x => x.key === 'SOTA-RGB')!;
check('товар с привязками первым', w.watch[0].key, 'SOTA-RGB');
const b = p.links.find(l => l.id === '390744732')!;
check('цифры: витрина + сравнение', [b.title, b.seller, b.price, b.rating, b.feedbacks, b.stock, b.orders, b.avgPos, b.inPromo], ['Светильник соты RGB', 'Odds & Ends', 3832, 4.6, 73, 42, 39, 22, true]);
const c = p.links.find(l => l.id === '321878641')!;
check('без карточки — цена из сравнения', [c.price, c.status], [3528, 'active']);
check('порядок — как привязаны: «Подтвердить» и «Не наш» строку не двигают', p.links.map(l => l.id), ['390744732', '257585393', '321878641', '832682672', '111111111']);
const oz = buildWatch('ozon', ozData).watch.find(x => x.key === 'CARLINKIT-ULTRA2-KRUG-8-128')!;
check('Ozon: ДРР и продажи лидера', oz.links.filter(l => l.id === '5555555555').map(l => [l.drr, l.orders, l.seller === '' ? 'нет' : l.seller]), [[6.5, 40, 'нет']]);

console.log('Снимок и ответ API');
const sum = saveCabinetSnapshot('wb', wbData);
check('сводка для «Сборщиков»', /отчётов сравнения 1, карточек конкурентов 1/.test(sum), true);
const api = getCompetitors('wb');
check('ответ: набор с отчётом помечен', api.wb?.comparisons.sets.map(s => s.opened), [true, false]);
check('ответ: привязки и каталог', [api.watch.length > 0, Array.isArray(api.catalog)], [true, true]);

console.log('Обновление днём');
const open = () => listTasks({ status: ['queued', 'claimed', 'running'], type: 'competitor_watch', limit: 50 }).filter(t => t.params.marketplace === 'wb');
check('после привязки нового конкурента — одно быстрое обновление', open().map(t => !!t.params.light), [true]);
check('«Обновить сейчас», пока ждёт, — нового задания нет', [requestRefresh('wb', 'panel').ok, open().length], [true, 1]);
const lightSum = saveCabinetSnapshot('wb', { light: true, errors: [], cards: [{ id: 390744732, name: 'Светильник соты RGB', supplier: 'Odds & Ends', rating: 4.7, feedbacks: 75, price: 3500, qty: 40 }] });
check('быстрый проход: сводка', /быстрое обновление — карточек на витрине 1/.test(lightSum), true);
const api2 = getCompetitors('wb');
check('быстрый проход не затирает аналитику кабинета', [api2.at === api.at, api2.wb?.items.length], [true, 1]);
const yest = new Date(Date.now() + 3 * 3600_000 - 86_400_000).toISOString().slice(0, 10);
adsDb().prepare('INSERT OR REPLACE INTO ad_comp_card (mp, id, date, at, price) VALUES (?, ?, ?, ?, ?)').run('wb', '390744732', yest, Date.now() - 86_400_000, 3800);
const b2 = getCompetitors('wb').watch.find(x => x.key === 'SOTA-RGB')!.links.find(l => l.id === '390744732')!;
check('свежая витрина главнее ночного снимка, цена сутки назад', [b2.price, b2.rating, b2.feedbacks, b2.price1d, !!b2.priceAt], [3500, 4.7, 75, 3800, true]);
const firstAt = b2.priceAt!;
for (const t0 = Date.now(); Date.now() - t0 < 5;) { /* следующий проход — позже по времени */ }
saveCabinetSnapshot('wb', { light: true, errors: ['нет цены'], cards: [{ id: 390744732, rating: 4.7, feedbacks: 76, qty: 30 }] });
const b3 = getCompetitors('wb').watch.find(x => x.key === 'SOTA-RGB')!.links.find(l => l.id === '390744732')!;
maintainQueue(); // заводит расписания по умолчанию
const rs = refreshState('wb');
check('цену в проход не отдали — остаётся прошлая со своим временем', [b3.price, b3.feedbacks, b3.priceAt === firstAt, rs.pass!.at > firstAt, rs.pass!.priced, rs.pass!.cards], [3500, 76, true, true, 0, 1]);
console.log('Карточка не видна покупателям');
saveCabinetSnapshot('wb', { light: true, errors: [], cards: [], notShown: [390744732] });
saveCabinetSnapshot('wb', { light: true, errors: [], cards: [{ id: 1, price: 10 }], notShown: [390744732] });
const h1 = hiddenCards('wb').get('390744732');
const b4 = getCompetitors('wb').watch.find(x => x.key === 'SOTA-RGB')!.links.find(l => l.id === '390744732')!;
check('не вернула витрина — помечена, «с» — первый проход, цена прежняя', [b4.hidden, b4.hiddenSince === h1, b4.price, b4.priceAt === firstAt], [true, true, 3500, true]);
saveCabinetSnapshot('wb', { light: true, errors: [], cards: [{ id: 390744732, price: 3400, qty: 5 }] });
check('снова на витрине — пометка снята', [hiddenCards('wb').has('390744732'), getCompetitors('wb').watch.find(x => x.key === 'SOTA-RGB')!.links.find(l => l.id === '390744732')!.price], [false, 3400]);
check('расписание по МСК (вечер 15.10: быстрые проходы перед выпусками советника)', [...rs.slots.map(s => s.time)].sort(), ['05:40', '11:20', '14:50', '16:50']);
check('сразу после прохода пропуска нет', rs.missedAt, null);
const mskMidnight = Math.floor((Date.now() + 3 * 3600_000) / 86_400_000) * 86_400_000 - 3 * 3600_000;
const tomorrow1230 = mskMidnight + 86_400_000 + 12.5 * 3600_000;
check('завтра в 12:30 без прохода — пропущено 11:20', refreshState('wb', tomorrow1230).missedAt, mskMidnight + 86_400_000 + (11 * 60 + 20) * 60_000);
check('завтра в 11:50 — 11:20 ещё ждём (40 минут), но ночной 05:40 пропущен', refreshState('wb', mskMidnight + 86_400_000 + (11 * 60 + 50) * 60_000).missedAt, mskMidnight + 86_400_000 + (5 * 60 + 40) * 60_000);
saveCabinetSnapshot('wb', { ...wbData, daily: [{ date: yest, report: { groups: [{ items: [{ nmId: 1417220162, avgPosition: { current: 14 }, views: { current: 900 } }] }] } }] });
check('позиция WB за день сохраняется', posSeries('wb', yest, yest).get('1417220162')?.get(yest), 14);

console.log(failed ? `\nПРОВАЛЕНО: ${failed}` : '\nВсе проверки прошли');
process.exit(failed ? 1 : 0);
