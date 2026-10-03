/**
 * Товары Ozon в наличии, которых нет на страницах магазина (03.10.2026):
 * S2000-PRO (46 шт.) числился «не продаётся» и держал цену из отчёта 65 465 ₽
 * при 76 000 ₽ на витрине. Запуск: npm run check
 */
import { inStockOffers, pickDirectCards, pickCardPrices } from '../shared/ozonInStock';

let failed = 0;
function check(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n      получили ${JSON.stringify(actual)}\n      ждали    ${JSON.stringify(expected)}`}`);
}

const skuMap = {
  '5873369452': 'ALLPOWERS-STAN1,5KWH-AP-S2000-PRO',
  '1689106881': 'ALLPOWERS-STAN2KWH-AP-R2500-V2',
  '4832943114': 'AD-CARLINKIT-ULTRA',
  '1111111111': 'OLD-ARCHIVE-ITEM',
  '2222222222': 'ALLPOWERS-STAN1,5KWH-AP-S2000-PRO', // второй sku того же товара
};
const stock = {
  'ALLPOWERS-STAN1,5KWH-AP-S2000-PRO': 46,
  'ALLPOWERS-STAN2KWH-AP-R2500-V2': 12,
  'AD-CARLINKIT-ULTRA': 240,
  'OLD-ARCHIVE-ITEM': 0,
};
const offers = inStockOffers(skuMap, stock);
check('без остатка в список не попадает', 'OLD-ARCHIVE-ITEM' in offers, false);
check('у товара собраны все его sku', offers['ALLPOWERS-STAN1,5KWH-AP-S2000-PRO']?.sort(), ['2222222222', '5873369452']);

// Обход магазина нашёл только Carlinkit — открыть надо две электростанции.
const groups = pickDirectCards(new Set(['4832943114']), offers, 40);
check('открываем только тех, кого нет на витрине', groups.map((g) => g.offer).sort(),
  ['ALLPOWERS-STAN1,5KWH-AP-S2000-PRO', 'ALLPOWERS-STAN2KWH-AP-R2500-V2']);
check('найденный на витрине товар не открываем', groups.some((g) => g.offer === 'AD-CARLINKIT-ULTRA'), false);
check('найден хоть один sku товара — карточка не нужна',
  pickDirectCards(new Set(['2222222222', '4832943114', '1689106881']), offers, 40).length, 0);
check('потолок карточек за проход', pickDirectCards(new Set(), offers, 1).length, 1);

// Цены с карточки: боевые цифры S2000-PRO 03.10.
check('три цены: с картой / без карты / зачёркнутая', pickCardPrices([76000, 84136, 139287]),
  { price: 76000, noCard: 84136, oldPrice: 139287 });
check('порядок на странице не важен', pickCardPrices([139287, 84136, 76000]),
  { price: 76000, noCard: 84136, oldPrice: 139287 });
check('две близкие — с картой и без', pickCardPrices([1857, 2050]), { price: 1857, noCard: 2050 });
check('две далёкие — цена и зачёркнутая', pickCardPrices([1857, 4850]), { price: 1857, oldPrice: 4850 });
check('одна цена', pickCardPrices([1927]), { price: 1927 });
check('пусто — нет цены', pickCardPrices([]), null);

console.log(failed ? `\nРАСХОЖДЕНИЙ: ${failed}` : '\nВсё сходится.');
process.exit(failed ? 1 : 0);
