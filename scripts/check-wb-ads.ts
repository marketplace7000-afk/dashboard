/**
 * Разбор рекламной статистики WB по товарам.
 *
 * Здесь проверяется одна вещь, которая стоила недель: у WB разбивка по товарам
 * лежит в поле `nms`, а не `nm`. Мы читали `nm`, получали undefined, и вся
 * реклама WB по товарам была пустой — таблица показывала «WB 0 строк» при живом
 * расходе, а ДРР у всех товаров WB падал в дефолтные 7%.
 *
 * Форма ответа снята с живого кабинета 01.09.2026.
 *
 * Запуск: npm run check
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Кэш проверки — во временную папку: настоящий трогать нельзя.
process.env.CACHE_DIR = mkdtempSync(join(tmpdir(), 'av-check-wbads-'));

import { getWbAdsByNm, wbAdsMissReason } from '../api/_lib/ads/wbSource';
import { parseWbFullstatsV4 } from '../api/_lib/ads/sync';
import { cacheSet, makeUpstreamCacheKey } from '../api/_lib/cache';
import { mskDate } from '../api/_lib/mskDate';

let failed = 0;
function check(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n      получили ${JSON.stringify(actual)}\n      ждали    ${JSON.stringify(expected)}`}`);
}

/** Ответ WB как он приходит на самом деле: товары внутри apps[].nms. */
function wbResponse() {
  const day = (date: string, sum: number) => ({
    date, atbs: 0, clicks: 10, sum,
    apps: [{
      appType: 64, atbs: 2, clicks: 10, sum,
      nms: [{ nmId: 923646381, name: 'Адаптер CarPlay', views: 100, clicks: 10, sum, orders: 1, sum_price: 2000 }],
    }],
  });
  return [{
    advertId: 1,
    days: [day(mskDate(1), 300), day(mskDate(10), 500)],   // один день в текущем окне, один в прошлом
  }];
}

async function main() {
  const qs = `?ids=1&beginDate=${mskDate(29)}&endDate=${mskDate(0)}`;
  const key = makeUpstreamCacheKey('wb:promotion', 'GET', 'adv/v3/fullstats', qs, undefined);
  await cacheSet(key, { status: 200, ct: 'application/json', text: JSON.stringify(wbResponse()) }, 60_000);

  console.log('Разбивка по товарам читается из поля nms');
  const r = getWbAdsByNm(7);
  check('метрики нашлись', r != null, true);
  check('товар попал в текущее окно', r?.current.get(923646381)?.spend ?? null, 300);
  check('день из прошлого окна не смешался с текущим', r?.previous.get(923646381)?.spend ?? null, 500);

  console.log('\nПричина пустоты называется честно');
  await cacheSet(key, { status: 200, ct: 'application/json', text: JSON.stringify([{ advertId: 1, days: [{ date: mskDate(1), clicks: 5 }] }]) }, 60_000);
  check('статистика есть, товарной разбивки нет', (getWbAdsByNm(7), wbAdsMissReason()), 'no-product-breakdown');

  console.log('\nСтатистика v4 (плоские строки, 19.11.2026) важнее v3');
  const qs4 = `?advertIds=1&beginDate=${mskDate(29)}&endDate=${mskDate(0)}`;
  const key4 = makeUpstreamCacheKey('wb:promotion', 'GET', 'api/advert/v4/fullstats', qs4, undefined);
  const row = (date: string, placement: string, conversionType: string, sum: number, orders: number) =>
    ({ advertId: 1, nmId: 923646381, date, placement, conversionType, views: sum ? 50 : 0, clicks: sum ? 5 : 0, sum, atbs: 1, orders, sumPrice: orders * 1000, shks: orders, canceled: 0 });
  await cacheSet(key4, { status: 200, ct: 'application/json', text: JSON.stringify({ rows: [
    row(mskDate(1), 'search', 'direct', 200, 1), row(mskDate(1), 'recommendation', 'direct', 40, 0), row(mskDate(1), 'search', 'multicard', 0, 2),
  ] }) }, 60_000);
  const f4 = getWbAdsByNm(7)?.current.get(923646381);
  check('v4: зоны и типы конверсии сложены', [f4?.spend, f4?.orders, f4?.carts, f4?.views], [240, 3, 3, 100]);

  console.log('\nРазбор v4 в строки хранилища');
  const rows = parseWbFullstatsV4({ rows: [
    { advertId: 7, nmId: 5, date: '2026-11-12', placement: 'search', conversionType: 'direct', views: 0, clicks: 28, sum: 701.6, atbs: 2, orders: 1, sumPrice: 900, shks: 1, canceled: 0, avgPos: 13 },
    { advertId: 7, nmId: 5, date: '2026-11-12', placement: 'search', conversionType: 'associated', views: 0, clicks: 0, sum: 0, atbs: 1, orders: 1, sumPrice: 500, shks: 1, canceled: 0 },
  ] }, new Map([['7|2026-11-12|5', 928]]));
  check('одна строка на кампанию × день × товар', rows.length, 1);
  check('показы кампании «за клик» взяты из v3', rows[0]?.views, 928);
  check('заказы и сумма — со всеми типами конверсии', [rows[0]?.orders, rows[0]?.revenue, rows[0]?.carts], [2, 1400, 3]);
  check('средняя позиция из «поиск + прямой»', rows[0]?.avg_pos, 13);

  console.log(failed ? `\nРАСХОЖДЕНИЙ: ${failed}` : '\nВсё сходится.');
  process.exit(failed ? 1 : 0);
}
void main();
