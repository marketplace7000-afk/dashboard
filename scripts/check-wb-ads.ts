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
  check('название подхватилось', r?.names.get(923646381) ?? null, 'Адаптер CarPlay');
  check('день из прошлого окна не смешался с текущим', r?.previous.get(923646381)?.spend ?? null, 500);

  console.log('\nПричина пустоты называется честно');
  await cacheSet(key, { status: 200, ct: 'application/json', text: JSON.stringify([{ advertId: 1, days: [{ date: mskDate(1), clicks: 5 }] }]) }, 60_000);
  check('статистика есть, товарной разбивки нет', (getWbAdsByNm(7), wbAdsMissReason()), 'no-product-breakdown');

  console.log(failed ? `\nРАСХОЖДЕНИЙ: ${failed}` : '\nВсё сходится.');
  process.exit(failed ? 1 : 0);
}
void main();
