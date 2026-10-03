/**
 * Защита от «слипшихся» цен витрины Ozon (03.10.2026).
 * Парсер брал цену не из своей плитки — одна цифра доставалась 5–7 товарам
 * сразу (у 39 из 42 товаров на листе стояли 7 одинаковых цен). Признак, по
 * которому это видно без похода на сайт: одна цена покупателя у товаров с
 * разной ценой ЛК. Такие цифры не записываем.
 * Запуск: npm run check
 */
import { findStickyPrices } from '../api/_lib/ozonShowcase';

let failed = 0;
function check(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n      получили ${JSON.stringify(actual)}\n      ждали    ${JSON.stringify(expected)}`}`);
}
const sorted = (s: Set<number>) => [...s].sort((a, b) => a - b);

// 1. Боевой случай 03.10: 17 033 ₽ досталась семи товарам с разными ценами ЛК.
const realCase = [
  { price: 17033, greyPrice: 3754 },   // CP-CARLINKIT-MINI-PRO
  { price: 17033, greyPrice: 3356 },   // MANIC-STICK-1000mAH-PINK
  { price: 17033, greyPrice: 3268 },   // AD-OTTOCAST-CA525T3
  { price: 17033, greyPrice: 45200 },  // DUDU-C3-8-128
  { price: 17033, greyPrice: 38325 },  // CARLINKIT-ULTRA2-KRUG-8-128-DUBL
  { price: 17033, greyPrice: 5496 },   // MASSAGE-WHITE-D845
  { price: 17033, greyPrice: 9700 },   // CPC200-CCPA-АКТИВАТОР-DUBL
];
check('слипшаяся цена 17 033 отбракована', sorted(findStickyPrices(realCase)), [17033]);

// 2. Нормальный проход: у каждого товара своя цена — не трогаем.
check('разные цены проходят', sorted(findStickyPrices([
  { price: 23862, greyPrice: 45200 },
  { price: 17062, greyPrice: 38325 },
  { price: 76000, greyPrice: 139287 },
])), []);

// 3. Два варианта одного товара с общей ценой — это законно (порог 3).
check('пара с общей ценой проходит', sorted(findStickyPrices([
  { price: 1804, greyPrice: 4085 },
  { price: 1804, greyPrice: 3485 },
])), []);

// 4. Три одинаковых товара с одной ценой ЛК и одной витринной — законно:
//    подозрительна не общая цена, а общая цена при РАЗНЫХ ЛК.
check('одинаковые ЛК — цена не считается слипшейся', sorted(findStickyPrices([
  { price: 2500, greyPrice: 5000 },
  { price: 2500, greyPrice: 5000 },
  { price: 2500, greyPrice: 5000 },
])), []);

// 5. Без цены ЛК судить не о чем — не бракуем (иначе потеряем новые товары).
check('без цены ЛК не бракуем', sorted(findStickyPrices([
  { price: 999 }, { price: 999 }, { price: 999 }, { price: 999 },
])), []);

// 6. Две слипшиеся группы в одном проходе — обе отбракованы.
check('две группы сразу', sorted(findStickyPrices([
  { price: 1504, greyPrice: 32000 },
  { price: 1504, greyPrice: 14660 },
  { price: 1504, greyPrice: 3780 },
  { price: 4500, greyPrice: 18437 },
  { price: 4500, greyPrice: 8554 },
  { price: 4500, greyPrice: 9856 },
  { price: 65465, greyPrice: 139287 },
])), [1504, 4500]);

console.log(failed ? `\nРАСХОЖДЕНИЙ: ${failed}` : '\nВсё сходится.');
process.exit(failed ? 1 : 0);
