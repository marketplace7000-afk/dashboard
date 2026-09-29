/**
 * Лист «Склад»: колонки по заголовкам, а не по номеру.
 *
 * 04.09 клиент вставил колонку «Link», артикул уехал из B в C, «Закуп» из I в J.
 * Парсер читал по номерам, вернул ноль строк, синхронизация молча оставила
 * старую себестоимость. Таблица клиента — живой документ, колонки будут
 * двигаться и дальше, поэтому разбор обязан находить их по заголовкам.
 *
 * Запуск: npm run check
 */
import { detectSkladLayout } from '../api/_lib/sheets';

let failed = 0;
function check(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n      получили ${JSON.stringify(actual)}\n      ждали    ${JSON.stringify(expected)}`}`);
}

// Как было до 29.08: A=Pic, B=SKU, …, I=Закуп.
const old = [
  ['', '', '', '', '', '', '', '', 'Едет с Китая'],
  ['Pic', 'SKU Ozon/ЯМ/WB', '', '', '', '', '', '', 'Закуп', 'В пути'],
  ['', 'OCHKI-KAMERA', '', '', '', '', '', '', 2876],
];
// Как стало 04.09: вставлена колонка B «Link» — всё сдвинулось на одну.
const shifted = [
  ['', '', '', '', '', '', '', '', '', 'Едет на склад'],
  ['Pic', 'Link', 'SKU Ozon/ЯМ/WB', '', '', '', '', '', '', 'Закуп', 'В пути'],
  ['', '', 'CARLINKIT-ULTRA3-KRUG-8-128-SCREEN', '', '', '', '', '', '', 11497],
];

console.log('Заголовки находятся независимо от положения колонок');
const a = detectSkladLayout(old);
check('старая раскладка: SKU в B', a.skuCol, 1);
check('старая раскладка: Закуп в I', a.costCol, 8);
const b = detectSkladLayout(shifted);
check('после вставки Link: SKU в C', b.skuCol, 2);
check('после вставки Link: Закуп в J', b.costCol, 9);
check('найдено по заголовкам, не по номеру', b.byHeader, true);

// Живой лист 09.09: «Закуп» в строке 1 над группой, «SKU» в строке 2.
const live = [
  ['', '', '', '', '', '', '', '', '', 'Закуп', 'Едет на склад'],
  ['Pic', 'Link', 'SKU Ozon/ЯМ/WB', 'NAME', 'Длина', 'Ширина', 'Высота', 'Вес', 'Баркод', '', 2230],
  ['', '', '', '', '', '', '', '', '', '', 'В пути, ед.'],
  ['', '', 'POLFAR', 'Набор для полировки фар', 21, 10, 6.5, 224, 1000052566607, 242.03, 0],
];
const c = detectSkladLayout(live);
check('заголовки в разных строках: SKU в C', c.skuCol, 2);
check('заголовки в разных строках: Закуп в J', c.costCol, 9);
check('данные начинаются после второй строки заголовка', c.headerRow, 1);

console.log('\nБез заголовков — запасной вариант, и это видно');
const bare = detectSkladLayout([['', 'X', '', '', '', '', '', '', 100]]);
check('запасной вариант B/I', [bare.skuCol, bare.costCol], [1, 8]);
check('помечен как «по номеру»', bare.byHeader, false);

console.log(failed ? `\nРАСХОЖДЕНИЙ: ${failed}` : '\nВсё сходится.');
process.exit(failed ? 1 : 0);
