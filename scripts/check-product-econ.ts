/**
 * Проверка главного правила резолвера экономики товара.
 *
 * Правило: неизвестное значение — это null с причиной, а НЕ правдоподобный
 * дефолт, и «рекламы не было» (честный ноль) отличается от «ДРР неизвестен».
 * Именно смешение этих двух состояний давало клиенту ДРР 7% у всех товаров и
 * прочерки вместо прибыли (правки от 29.08).
 *
 * Второе правило: себестоимость ищется ПО АРТИКУЛУ и не зависит от того, попал
 * ли товар в чью-то таблицу. Раньше зависела — и новый товар оставался без неё.
 *
 * Запуск: npm run check
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'av-check-econ-'));
process.env.CACHE_DIR = dir;
process.env.COSTS_FILE = join(dir, 'costs.json');
process.env.SETTINGS_FILE = join(dir, 'settings.json');

// Себестоимость есть только в НАШЕМ справочнике: товара нет ни в одной таблице.
writeFileSync(process.env.COSTS_FILE, JSON.stringify({
  items: { 'OCHKI-KAMERA': { cost: 2876, source: 'sheet', updatedAt: '2026-08-29' } },
  updatedAt: '2026-08-29',
}));

let failed = 0;
function check(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n      получили ${JSON.stringify(actual)}\n      ждали    ${JSON.stringify(expected)}`}`);
}

async function main() {
  const { getCost } = await import('../api/_lib/costs');
  const { commissionFor } = await import('../api/_lib/wbCommissions');
  const { getSettings, setSettings } = await import('../api/_lib/settings');

  console.log('Себестоимость ищется по артикулу, а не через таблицу');
  check('товар есть только в справочнике — цена найдена', getCost('OCHKI-KAMERA'), 2876);
  check('регистр и пробелы не мешают', getCost('  ochki-kamera '), 2876);
  check('незаведённый артикул — null, а не ноль', getCost('НЕТ-ТАКОГО'), null);

  console.log('\nКомиссия берётся строго по выбранной схеме');
  const rates = { paidStorageKgvp: 20, kgvpMarketplace: 25 };
  check('FBO берёт ставку склада площадки', commissionFor(rates, 'fbo'), 20);
  check('FBS берёт ставку своего склада', commissionFor(rates, 'fbs'), 25);
  // Ставку соседней схемы подставлять НЕЛЬЗЯ: это молча покажет неверную прибыль.
  check('нет ставки нужной схемы — null, а не чужая', commissionFor({ paidStorageKgvp: 20 }, 'fbs'), null);
  check('пустые ставки — null', commissionFor(undefined, 'fbs'), null);

  console.log('\nСхема работы сохраняется и по умолчанию FBS');
  check('умолчание — FBS (клиент перешёл 29.08)', getSettings().wbFulfilment, 'fbs');
  setSettings({ wbFulfilment: 'fbo' });
  check('переключение сохраняется', getSettings().wbFulfilment, 'fbo');

  console.log(failed ? `\nРАСХОЖДЕНИЙ: ${failed}` : '\nВсё сходится.');
  process.exit(failed ? 1 : 0);
}
void main();
