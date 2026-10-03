/**
 * Фильтр «В продаже» (01.10.2026): витрина решает, остатки отсекают распроданное.
 * Живой кейс: OTTOCAST-P3-KVDRT — 1 шт. «на складе» по отчёту WB, но на витрине нет.
 * Запуск: npm run check
 */
import { lastSweep, decideInSale } from '../src/utils/inSale';

let failed = 0;
function check(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n      получили ${JSON.stringify(actual)}\n      ждали    ${JSON.stringify(expected)}`}`);
}
const H = 3600_000, now = 1_800_000_000_000;
const items: Record<string, { price: number; at: number }> = {};
for (let i = 0; i < 37; i++) items[`N${i}`] = { price: 1000, at: now - 2 * H - i * 60_000 };
items['OLD'] = { price: 900, at: now - 50 * H };               // был на витрине позавчера
const sw = lastSweep(items, 55, now);
check('обход из 37 товаров применим', [sw.usable, sw.ids.size], [true, 37]);
check('на витрине и есть остаток → в продаже', decideInSale('N1', 3, sw), true);
check('остаток есть, на витрине нет (OTTOCAST) → не в продаже', decideInSale('OTTOCAST', 1, sw), false);
check('на витрине, но распродан после обхода → не в продаже', decideInSale('N2', 0, sw), false);
check('давний снимок не считается витриной', decideInSale('OLD', 2, sw), false);
check('остатки неизвестны — решает витрина', decideInSale('N3', null, sw), true);
const stale = lastSweep(items, 55, now + 30 * H);
check('обход старше суток — решают остатки', [stale.usable, decideInSale('OTTOCAST', 1, stale)], [false, true]);
const broken = lastSweep({ A: { price: 1, at: now }, B: { price: 1, at: now }, C: { price: 1, at: now }, D: { price: 1, at: now }, E: { price: 1, at: now } }, 55, now);
check('сорванный обход (5 из 55) не применяем', broken.usable, false);
check('ни обхода, ни остатков — решают фолбэки', decideInSale('X', null, broken), null);
console.log(failed ? `\nРАСХОЖДЕНИЙ: ${failed}` : '\nВсё сходится.');
process.exit(failed ? 1 : 0);
