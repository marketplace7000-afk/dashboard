/**
 * Сверка пола цены репрайсера с калькулятором клиента.
 *
 * Пол считается подбором по calcWbProfit — тому же расчёту, по которому маржа
 * показывается на экране. Проверка держит это свойство: на границе маржа не ниже
 * порога, рублём ниже — уже ниже. Если кто-то заменит подбор на «свою формулу
 * побыстрее», здесь это сразу вылезет, а на проде вылезло бы убыточными ценами.
 *
 * Запуск: npm run check
 */
import { priceForMargin } from '../api/_lib/repricer';
import { calcWbProfit, WB_DEFAULTS, type WbCalcInput } from '../src/utils/wbProfit';

let bad = 0;
const ok = (name: string, cond: boolean, extra = '') => {
  if (!cond) bad++;
  console.log(`  ${cond ? '✓' : '✗'} ${name}${extra ? ' · ' + extra : ''}`);
};

const base: WbCalcInput = { ...WB_DEFAULTS, retail: 1000, cost: 300, logistic: 90, storage: 5 };

console.log('Пол цены считается тем же калькулятором, что и маржа на экране');
for (const target of [5, 15, 25]) {
  const floor = priceForMargin(base, target);
  if (floor == null) { ok(`порог ${target}%`, false, 'не найден'); continue; }
  const at = calcWbProfit({ ...base, retail: floor })!.margin;
  const below = calcWbProfit({ ...base, retail: floor - 1 })!.margin;
  ok(`порог ${target}%: на границе маржа не ниже`, at >= target - 0.01, `${at.toFixed(2)}% при ${floor} ₽`);
  ok(`порог ${target}%: рублём ниже уже мало`, below < target, `${below.toFixed(2)}% при ${floor - 1} ₽`);
}

// Недостижимый порог: маржа физически не может превысить 100% минус доли.
ok('недостижимый порог даёт null', priceForMargin(base, 99) === null);

// Дорогая себестоимость поднимает пол.
const cheap = priceForMargin(base, 15)!;
const pricey = priceForMargin({ ...base, cost: 600 }, 15)!;
ok('выше себестоимость — выше пол', pricey > cheap, `${cheap} ₽ против ${pricey} ₽`);

// Монотонность: чем выше требуемая маржа, тем выше пол.
const f5 = priceForMargin(base, 5)!, f25 = priceForMargin(base, 25)!;
ok('выше требуемая маржа — выше пол', f25 > f5, `${f5} ₽ против ${f25} ₽`);

console.log(bad ? `\nПРОВАЛОВ: ${bad}` : '\nВсё сходится.');
process.exit(bad ? 1 : 0);
