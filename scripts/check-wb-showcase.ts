/**
 * Витрина WB с card.wb.ru v4.
 *
 * Две вещи, которые уже ломались молча. Во-первых, v2 отвечает 404, а у v4
 * `products` лежит на верхнем уровне — сбор цен конкурентов из-за этого давал
 * ноль позиций. Во-вторых, единицы: v2 отдавал копейки, v4 — рубли (аудит
 * 04.09), и перепутать их значит показать цену в сто раз меньше или больше.
 * Для своих товаров единицы страхуются якорем — серой ценой из Seller API.
 *
 * Запуск: npm run check
 */
import { fetchWbPrices } from '../api/_lib/competitorPrices';

let failed = 0;
function check(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n      получили ${JSON.stringify(actual)}\n      ждали    ${JSON.stringify(expected)}`}`);
}

const v4 = (products: any[]) => new Response(JSON.stringify({ products }), { status: 200, headers: { 'content-type': 'application/json' } });
const card = (id: number, product: number, basic: number, name = 'Товар') =>
  ({ id, name, brand: 'B', reviewRating: 4.8, feedbacks: 10, sizes: [{ price: { basic, product } }] });

async function main() {
  console.log('v4: products на верхнем уровне, product = витрина, basic = зачёркнутая');
  (globalThis as any).fetch = async (url: any) => {
    const u = String(url);
    if (!u.includes('/cards/v4/detail')) return new Response('not found', { status: 404 });   // v2 больше не существует
    return v4([card(1249404821, 13052, 48800, 'MEKEDE X20'), card(528794102, 76276, 139008, 'DJI Mini 3')]);
  };
  const r = await fetchWbPrices([1249404821, 528794102]);
  check('обе карточки прочитаны', r.items.length, 2);
  check('витрина X20 = product', r.items[0].price, 13052);
  check('зачёркнутая X20 = basic', r.items[0].oldPrice, 48800);
  check('ошибки нет', r.error, undefined);

  console.log('\nЕдиницы: якорь спасает от копеек');
  (globalThis as any).fetch = async () => v4([card(1, 1305200, 4880000)]);   // вдруг копейки
  const anchored = await fetchWbPrices([1], new Map([[1, 20984]]));           // серая цена 20 984 ₽
  check('копейки с якорем → рубли', anchored.items[0].price, 13052);
  (globalThis as any).fetch = async () => v4([card(1, 13052, 48800)]);
  const rub = await fetchWbPrices([1], new Map([[1, 20984]]));
  check('рубли с якорем остаются рублями', rub.items[0].price, 13052);
  check('витрина не выше серой цены', rub.items[0].price <= 20984, true);

  console.log('\nБлокировка не маскируется под данные');
  (globalThis as any).fetch = async () => new Response('<html>blocked</html>', { status: 403 });
  const blocked = await fetchWbPrices([1]);
  check('403 → пусто с причиной', blocked.items.length === 0 && /403/.test(blocked.error ?? ''), true);

  console.log(failed ? `\nРАСХОЖДЕНИЙ: ${failed}` : '\nВсё сходится.');
  process.exit(failed ? 1 : 0);
}
void main();
