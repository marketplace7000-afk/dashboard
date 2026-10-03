/**
 * Сопоставление артикула карточки с артикулом таблицы «Склад» (01.10.2026).
 * Живые примеры из кабинета клиента: размеры одежды, номер партии, FBS-дубли Ozon.
 * Запуск: npm run check
 */
import { resolveCost, type CostsFile } from '../api/_lib/costs';

let failed = 0;
function check(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n      получили ${JSON.stringify(actual)}\n      ждали    ${JSON.stringify(expected)}`}`);
}

const e = (cost: number) => ({ cost, source: 'sheet' as const, updatedAt: '' });
const data: CostsFile = {
  updatedAt: '',
  items: {
    'CARLINKIT-ULTRA4-KRUG': e(9955),
    'CP-CARLINKIT-MINI': e(656),
    'CP-CARLINKIT-MINI-DUBL': e(858),
    'W-ПАЛАЦБЛЕСК-ЧЕРН-S': e(700), 'W-ПАЛАЦБЛЕСК-ЧЕРН-M': e(700), 'W-ПАЛАЦБЛЕСК-ЧЕРН-L': e(720),
    'POL-3M-1Л-СИН-ФИНИШ-5996': e(5996),
    'CARBITLINK': e(3100),
    'W-БРЮКСИНГ-КОР-42-44': e(577.88), 'W-БРЮКСИНГ-КОР-50-52': e(577.88),
    'DJI-MINI-4-PRO': e(70000),
    'LED-K7-H4-42': e(500), 'LED-K7-H4-44': e(900),
    'CARLINKIT-ULTRA2-KRUG-8-128': e(9355),
  },
};
const c = (sku: string) => { const r = resolveCost(sku, data); return r ? [r.cost, r.via] : null; };

console.log('Точное совпадение главнее всего');
check('CARLINKIT-ULTRA4-KRUG', c('carlinkit-ultra4-krug '), [9955, 'exact']);
check('DUBL — свой артикул, не подменяется основным', c('CP-CARLINKIT-MINI-DUBL'), [858, 'exact']);
console.log('FBS-дубли карточек Ozon');
check('«CP-CARLINKIT-MINI - FBS»', c('CP-CARLINKIT-MINI - FBS'), [656, 'normalized']);
check('«DJI-MINI-4-PRO- FBS»', c('DJI-MINI-4-PRO- FBS'), [70000, 'normalized']);
check('«CARBITLINK-FBS3»', c('CARBITLINK-FBS3'), [3100, 'normalized']);
console.log('Размеры и номер партии');
check('родитель одежды → размер (наибольшая)', c('W-ПАЛАЦБЛЕСК-ЧЕРН'), [720, 'variant']);
check('размер-диапазон «42-44»', c('W-БРЮКСИНГ-КОР'), [577.88, 'variant']);
check('номер партии в таблице', c('POL-3M-1Л-СИН-ФИНИШ'), [5996, 'variant']);
check('варианты с разной ценой — не угадываем', c('LED-K7-H4'), null);
check('два сегмента хвоста — не вариант', c('CARLINKIT-ULTRA2-KRUG'), null);
check('«-PRO» — другой товар, не вариант', c('DJI-MINI-4'), null);
check('нет в таблице — пусто', c('GROOMING-SET'), null);

console.log(failed ? `\nРАСХОЖДЕНИЙ: ${failed}` : '\nВсё сходится.');
process.exit(failed ? 1 : 0);
