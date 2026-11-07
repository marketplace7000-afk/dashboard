// Проверка истории ставок комиссии (07.11.2026): смена ставки видна сразу,
// а продажи до смены сравниваются со старой ставкой.
import { tariffAt, recentChange, type WbCommissionHistory } from '../api/_lib/wbCommissions';
import { mskDate } from '../api/_lib/mskDate';

const d10 = mskDate(10), d3 = mskDate(3), d40 = mskDate(40);
const hist: WbCommissionHistory = {
  'Магнитолы автомобильные': [
    { since: d10, fbo: 35.5, fbs: 40 },
    { since: d3, fbo: 36.5, fbs: 41 },
  ],
};
let ok = true;
const eq = (name: string, a: unknown, b: unknown) => { const pass = JSON.stringify(a) === JSON.stringify(b); ok &&= pass; console.log(`  ${pass ? '✓' : '✗'} ${name}: ${JSON.stringify(a)}`); };
eq('продажа до истории — первая ставка', tariffAt(hist, 'Магнитолы автомобильные', d40, 'fbs'), 40);
eq('продажа между сменами — старая ставка', tariffAt(hist, 'Магнитолы автомобильные', mskDate(5), 'fbs'), 40);
eq('после смены — новая ставка', tariffAt(hist, 'Магнитолы автомобильные', mskDate(0), 'fbs'), 41);
eq('смена видна', recentChange(hist, 'Магнитолы автомобильные', 'fbo'), { since: d3, from: 35.5, to: 36.5 });
eq('старая смена не показывается', recentChange(hist, 'Магнитолы автомобильные', 'fbo', 2), null);
eq('нет предмета', tariffAt(hist, 'Коптеры', d3, 'fbs'), null);
console.log(ok ? '\nИстория ставок в порядке.' : '\nОШИБКА');
if (!ok) process.exit(1);
