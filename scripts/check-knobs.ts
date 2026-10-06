/**
 * Ручные значения в расчёте товара не «замерзают» (05.10.2026): действуют,
 * пока данные под ними не поменялись. Запуск: npm run check
 */
import { activeKnobs, pruneKnobs, sameAuto } from '../src/utils/knobs';

let failed = 0;
function check(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n      получили ${JSON.stringify(actual)}\n      ждали    ${JSON.stringify(expected)}`}`);
}

// Сценарий «что если»: СПП вписали 40 при 45 по данным — действует, пока данные те же.
const knobs = { '1': { spp: '40', price: '45000' } };
const base = { '1': { spp: 45, price: 41000 } };
check('данные не менялись — ручные значения действуют',
  activeKnobs(1, knobs, base, { spp: 45, price: 41000 }), { spp: '40', price: '45000' });
check('пришла новая СПП с витрины — ручная СПП снимается, цена остаётся',
  activeKnobs(1, knobs, base, { spp: 53, price: 41000 }), { price: '45000' });
check('округление не считается изменением', activeKnobs(1, knobs, base, { spp: 45.3, price: 41050 }), { spp: '40', price: '45000' });
check('старое значение без базы (до 05.10) не действует',
  activeKnobs('6428384479', { '6428384479': { cost: '10000' } }, {}, { cost: 10286 }), {});
check('данных по полю пока нет — значение с базой держим',
  activeKnobs(1, knobs, base, { price: 41000 }), { spp: '40', price: '45000' });
check('товара без ручных значений — пусто', activeKnobs(2, knobs, base, { spp: 45 }), {});

// Чистка хранилища: боевой пример 05.10 — у панели Ozon застыли цена/себестоимость/СПП/ДРР без базы.
const r = pruneKnobs(
  { '6428384479': { cost: '10000', drr: '7', spp: '33', price: '41000' }, '1': { spp: '40' }, '9': { drr: '3' } },
  { '1': { spp: 45 }, '9': { drr: 5 } },
  { '6428384479': { cost: 10286, drr: 2.1, spp: 45, price: 41000 }, '1': { spp: 45 } },
);
check('устаревшие убраны, действующие и незагруженные — на месте', r.knobs, { '1': { spp: '40' }, '9': { drr: '3' } });
check('база чистится вместе с ними', r.base, { '1': { spp: 45 }, '9': { drr: 5 } });
check('список снятых', r.dropped.sort(), ['6428384479:cost', '6428384479:drr', '6428384479:price', '6428384479:spp']);
check('допуск: 41000 и 41080 — одно и то же (0.2%)', [sameAuto(41080, 41000), sameAuto(41100, 41000)], [true, false]);

console.log(failed ? `\nРАСХОЖДЕНИЙ: ${failed}` : '\nВсё сходится.');
process.exit(failed ? 1 : 0);
