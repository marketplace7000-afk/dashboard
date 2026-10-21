/**
 * История финансов для главной (22.10.2026): выручка WB — до СПП, комиссия — то,
 * что WB удержал с цены продавца. Пример — живая строка финотчёта за 15.10.
 * Запуск: npm run check
 */
import { wbRowsToFacts } from '../api/_lib/finHistory';

let failed = 0;
function check(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n      получили ${JSON.stringify(actual)}\n      ждали    ${JSON.stringify(expected)}`}`);
}

console.log('Финотчёт WB → статьи по дням и артикулам');
const { facts, coveredTo } = wbRowsToFacts([
  // Продажа: цена продавца 8 495, покупатель заплатил 5 108 (СПП 39,87 %), к перечислению 5 190.
  { rrDate: '2026-10-15', docTypeName: 'Продажа', vendorCode: 'fuel-pump-ftp001', quantity: 1, retailPriceWithDisc: '8495', retailAmount: '5108', forPay: '5190', deliveryService: '0' },
  // Доставка к покупателю отдельной строкой.
  { rrDate: '2026-10-15', docTypeName: '', sellerOperName: 'Логистика', vendorCode: 'fuel-pump-ftp001', quantity: 0, deliveryService: '96.5' },
  // Возврат того же товара днём позже.
  { rrDate: '2026-10-16', docTypeName: 'Возврат', vendorCode: 'fuel-pump-ftp001', quantity: 1, retailPriceWithDisc: '8495', retailAmount: '5108', forPay: '5190' },
  // Хранение без артикула.
  { rrDate: '2026-10-16', docTypeName: '', vendorCode: '', quantity: 0, paidStorage: '312.4' },
  // Удержания: оплата рекламы (уже есть в РНП) и подписка «Джем».
  { rrDate: '2026-10-16', docTypeName: '', vendorCode: '', quantity: 0, deduction: '106505', bonusTypeName: 'Оказание услуг «WB Продвижение», документ №319965682' },
  { rrDate: '2026-10-16', docTypeName: '', vendorCode: '', quantity: 0, deduction: '42990', bonusTypeName: 'Предоставление услуг по подписке «Джем», документ №319921736' },
]);
const day = (d: string, sku: string) => facts.get(d)?.get(sku);
check('выручка — по цене продавца, до СПП', day('2026-10-15', 'FUEL-PUMP-FTP001')?.rev, 8495);
check('комиссия = цена до СПП − к перечислению', day('2026-10-15', 'FUEL-PUMP-FTP001')?.commission, 3305);
check('логистика по артикулу', day('2026-10-15', 'FUEL-PUMP-FTP001')?.logistics, 96.5);
check('возврат вычитает выручку, комиссию и штуки', [day('2026-10-16', 'FUEL-PUMP-FTP001')?.rev, day('2026-10-16', 'FUEL-PUMP-FTP001')?.commission, day('2026-10-16', 'FUEL-PUMP-FTP001')?.units], [-8495, -3305, -1]);
check('хранение без артикула — под пустым артикулом', day('2026-10-16', '')?.storage, 312.4);
check('оплата «WB Продвижение» не дублирует рекламу из РНП, «Джем» — в прочем', day('2026-10-16', '')?.other, 42990);
check('отчёт есть по последней дате строк', coveredTo, '2026-10-16');

if (failed) { console.log(`\n✗ история финансов: ошибок ${failed}`); process.exit(1); }
console.log('\n✓ история финансов в порядке');
