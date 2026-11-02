/**
 * Расчёты раздела «План» (02.11.2026). Запуск: npm run check
 */
import { avgCheck, calcPace, monthEnd, pctOf, pickPrice, planDaySeries, planStatus, sharedStockShort, shiftMonth } from '../shared/plan';

let failed = 0;
function check(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n      получили ${JSON.stringify(actual)}\n      ждали    ${JSON.stringify(expected)}`}`);
}

check('конец месяца', monthEnd('2026-02'), '2026-02-28');
check('сдвиг через год', shiftMonth('2026-12', 1), '2027-01');
check('средний чек', avgCheck(4, 1000), 250);
check('нет заказов — нет чека', avgCheck(0, 0), null);
check('процент без плана', pctOf(5, 0), null);

check('ручная цена важнее чека', pickPrice({ manual: 900, frozen: 800, basis: '7d', avg7: 100, avg30: 200, avg90: 300 }), { price: 900, source: 'manual' });
check('зафиксированная важнее чека', pickPrice({ manual: 0, frozen: 800, basis: '7d', avg7: 100, avg30: 200, avg90: 300 }), { price: 800, source: 'frozen' });
check('чек за 7 дней', pickPrice({ manual: 0, frozen: 0, basis: '7d', avg7: 100, avg30: 200, avg90: 300 }), { price: 100, source: 'avg7' });
check('чек за 30 дней', pickPrice({ manual: 0, frozen: 0, basis: '30d', avg7: 100, avg30: 200, avg90: 300 }), { price: 200, source: 'avg30' });
check('нет недели — берём месяц', pickPrice({ manual: 0, frozen: 0, basis: '7d', avg7: null, avg30: 200, avg90: 300 }), { price: 200, source: 'avg30' });
check('нет продаж совсем', pickPrice({ manual: 0, frozen: 0, basis: '7d', avg7: null, avg30: null, avg90: null }), { price: 0, source: 'none' });

// Сверка с октябрём WB: на утро 16.10 план 1 238, заказов по вчера 845, осталось 16 дней.
const oct = calcPace({ qty: 1238, month: '2026-10', today: '2026-10-16', factToYesterday: 845, factTotal: 845, pace7: 50 });
check('минимум в день, WB 16.10, вверх до целого', oct.needPerDay, 25);
check('минимум 7,6 → 8', calcPace({ qty: 38, month: '2026-11', today: '2026-11-26', factToYesterday: 0, factTotal: 0, pace7: 0 }).needPerDay, 8);
check('ровно 2 не становится 3', calcPace({ qty: 10, month: '2026-11', today: '2026-11-26', factToYesterday: 0, factTotal: 0, pace7: 0 }).needPerDay, 2);
check('дней осталось, включая сегодня', oct.daysLeft, 16);
check('темп выше минимума — не отстаёт', oct.behind, false);
check('прогноз: факт + темп × дни', oct.forecast, 845 + 50 * 16);
check('темп ниже минимума — отстаёт', calcPace({ qty: 1238, month: '2026-10', today: '2026-10-16', factToYesterday: 845, factTotal: 845, pace7: 20 }).behind, true);
check('план выполнен — минимум ноль', calcPace({ qty: 10, month: '2026-10', today: '2026-10-16', factToYesterday: 12, factTotal: 12, pace7: 1 }).needPerDay, 0);

// Новинка: старт 25.11, план 12 шт. До старта минимум считается от 6 дней продаж.
const pre = calcPace({ qty: 12, month: '2026-11', today: '2026-11-03', startDate: '2026-11-25', factToYesterday: 0, factTotal: 0, pace7: 0 });
check('новинка: дни от даты старта', pre.daysLeft, 6);
check('новинка: минимум от даты старта', pre.needPerDay, 2);
check('новинка до старта не считается отстающей', pre.behind, false);
check('новинка до старта: к вчера ничего не ждём', pre.expected, 0);
const started = calcPace({ qty: 12, month: '2026-11', today: '2026-11-28', startDate: '2026-11-25', factToYesterday: 1, factTotal: 1, pace7: 0.14 });
check('новинка после старта: отстаёт', started.behind, true);

const past = calcPace({ qty: 100, month: '2026-10', today: '2026-11-02', factToYesterday: 130, factTotal: 130, pace7: null });
check('закрытый месяц: минимума нет', past.needPerDay, null);
check('закрытый месяц: прогноз = факт', past.forecast, 130);

// Строки плана в таблице РНП: 30 шт на ноябрь, заказы 1.11 — 2 шт, 2.11 — 4 шт.
const days = [{ date: '2026-11-01', cnt: 2 }, { date: '2026-11-02', cnt: 4 }];
const ser = planDaySeries({ qty: 30, startDate: null, daily: days }, '2026-11', ['2026-10-31', '2026-11-01', '2026-11-02']);
check('РНП: прошлый месяц — пусто', [ser.plan_qty[0], ser.plan_need[0], ser.plan_fact[0], ser.plan_ordered[0]], [null, null, null, null]);
check('РНП: план на месяц', ser.plan_qty[2], 30);
check('РНП: заказы дня', ser.plan_ordered.slice(1), [2, 4]);
check('РНП: нарастающий итог', ser.plan_fact.slice(1), [2, 6]);
check('РНП: минимум 1.11 без заказов', ser.plan_need[1], 1);
check('РНП: минимум 2.11 — заказы только по 1.11', ser.plan_need[2], 28 / 29);
check('РНП: минимум совпадает с разделом «План»', Math.ceil(ser.plan_need[2]!), calcPace({ qty: 30, month: '2026-11', today: '2026-11-02', factToYesterday: 2, factTotal: 6, pace7: 1 }).needPerDay);
const fresh = planDaySeries({ qty: 12, startDate: '2026-11-25', daily: [] }, '2026-11', ['2026-11-24', '2026-11-25']);
check('РНП: новинка до старта — без минимума', fresh.plan_need[0], null);
check('РНП: новинка от старта', fresh.plan_need[1], 2);

// Общее выполнение на 11.11: прошло 10 дней из 30, при плане 30 к вчера ждём 10 шт.
const st = (cum: number, qty = 30) => planStatus({ qty, startDate: null, daily: [{ date: '2026-11-01', cnt: cum }, { date: '2026-11-11', cnt: 1 }] }, '2026-11', '2026-11-11');
check('статус: по плану', st(10).key, 'ok');
check('статус: чуть ниже, от 80 %', st(8).key, 'near');
check('статус: отстаёт', st(7).key, 'bad');
check('статус: сегодняшний заказ не спасает вчерашний итог', st(7).factToYesterday, 7);
check('статус: процент — вместе с сегодня', st(14).pct, 50);
check('статус: выполнен', st(29).key, 'done');
check('статус: первый день — ждём', planStatus({ qty: 30, startDate: null, daily: [] }, '2026-11', '2026-11-01').key, 'wait');
check('статус: новинка до старта — ждём', planStatus({ qty: 12, startDate: '2026-11-25', daily: [] }, '2026-11', '2026-11-03').key, 'wait');
check('статус: меньше штуки — не отставание', planStatus({ qty: 3, startDate: null, daily: [] }, '2026-11', '2026-11-03').key, 'ok');

// Общие склады: FBS 100, у каждой площадки осталось по 80 шт плана.
const side = (remain: number, fbo = 0, transit = 0) => ({ remain, fbo, transit });
check('склад: по 80 шт на двоих при FBS 100 — не хватит', sharedStockShort(side(80), side(80), 100), true);
check('склад: вторая площадка не мешает', sharedStockShort(side(80), side(0), 100), false);
check('склад: FBO второй площадки закрывает её план', sharedStockShort(side(80), side(80, 80), 100), false);
check('склад: поставка в пути учитывается', sharedStockShort(side(80), side(80, 0, 70), 100), false);
check('склад: своего FBO хватает — предупреждения нет', sharedStockShort(side(80, 80), side(200), 100), false);

if (failed) { console.error(`check-plan: ошибок ${failed}`); process.exit(1); }
console.log('check-plan: всё верно');
