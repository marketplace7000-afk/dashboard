/**
 * Отчёт Ozon по пачке кампаний — ZIP с файлом на КАЖДУЮ кампанию.
 *
 * Прежний разбор читал только первый файл архива: из десяти кампаний в пачке
 * данные доставались по одной, обычно без расхода. Кабинет видел 3,3% реальной
 * рекламы Ozon (аудит 04.09: 22 593 ₽ из 674 539 ₽). Здесь собирается архив
 * из трёх файлов в живом формате Ozon и проверяется, что прочитаны ВСЕ.
 *
 * Заодно: «Заказано на сумму» — одно значение на SKU за период, в каждой
 * кампании повторяется. При склейке берётся max, а не сумма, иначе задвоится.
 *
 * Запуск: npm run check
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';

process.env.CACHE_DIR = mkdtempSync(join(tmpdir(), 'av-check-zip-'));
process.env.OZON_REPORT_POLL_DELAY_MS = '20';
process.env.OZON_REPORT_POLL_BUDGET_MS = '2000';
process.env.OZON_CLIENT_ID = 'x'; process.env.OZON_API_KEY = 'x';
process.env.OZON_PERF_CLIENT_ID = 'x'; process.env.OZON_PERF_CLIENT_SECRET = 'x';

// ── Минимальный ZIP-упаковщик (deflate), чтобы не тащить зависимость ─────────
function crc32(buf: Buffer): number {
  let c = ~0;
  for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); }
  return ~c >>> 0;
}
function zip(files: { name: string; text: string }[]): Buffer {
  const locals: Buffer[] = [], cds: Buffer[] = []; let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name), data = Buffer.from(f.text, 'utf-8'), comp = deflateRawSync(data);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(crc32(data), 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(name.length, 26);
    const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(8, 10);
    cd.writeUInt32LE(crc32(data), 16); cd.writeUInt32LE(comp.length, 20); cd.writeUInt32LE(data.length, 24); cd.writeUInt16LE(name.length, 28); cd.writeUInt32LE(offset, 42);
    locals.push(lh, name, comp); cds.push(cd, name); offset += lh.length + name.length + comp.length;
  }
  const cdBuf = Buffer.concat(cds), eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cdBuf, eocd]);
}

// Живой формат Ozon (снят 04.09): первая строка — название кампании, вторая — заголовок.
const HEAD = 'sku;Название товара;Цена товара, ₽;Показы;Клики;CTR, %;Добавления в корзину;Средняя стоимость клика, ₽;Расход, ₽, с НДС;Продано товаров;Продажи в продвижении, ₽;Продано товаров модели;Продажи в продвижении с заказов модели, ₽;ДРР в продвижении, %;Заказано на сумму, ₽;ДРР (общий), %;Дата добавления';
const report = (id: string, rows: string[]) =>
  `﻿;Кампания по продвижению товаров № ${id}, период 30.07.2026-30.08.2026\n${HEAD}\n${rows.join('\n')}\nВсего;;;6;0;0,00;0;0,00;0,00;0;0,00;0;0,00;0,0;0,00;0,0;`;

const archive = zip([
  // Первая кампания — без расхода. Раньше читалась только она → SKU=0.
  { name: '40171488_30.07-30.08.csv', text: report('40171488', []) },
  { name: '33960604_30.07-30.08.csv', text: report('33960604', [
    '5013157451;Микротоковый массажёр;5665,00;1000;80;8,00;12;10,00;800,00;3;15000,00;3;15000,00;5,3;81600,00;1,0;01.08.2026' ]) },
  { name: '32707172_30.07-30.08.csv', text: report('32707172', [
    '5013157451;Микротоковый массажёр;5665,00;500;40;8,00;6;10,00;400,00;1;5000,00;1;5000,00;8,0;81600,00;0,5;01.08.2026',
    '3334496592;Сифон;6192,00;6;0;0,00;0;0,00;100,00;0;0,00;0;0,00;0,0;405354,00;0,0;03.08.2026' ]) },
]);

let created = 0;
(globalThis as any).fetch = async (url: any, init: any) => {
  const u = String(url);
  if (u.includes('/api/client/token')) return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }), { status: 200 });
  if (u.includes('/statistics/campaign/product/json')) return new Response(JSON.stringify({ rows: [
    { id: '40171488', objectType: 'SKU', status: 'CAMPAIGN_STATE_RUNNING', moneySpent: '0,00' },
    { id: '33960604', objectType: 'SKU', status: 'CAMPAIGN_STATE_RUNNING', moneySpent: '800,00' },
    { id: '32707172', objectType: 'SKU', status: 'CAMPAIGN_STATE_ARCHIVED', moneySpent: '500,00' },   // архивная, но с расходом
    { id: '23612241', objectType: 'ALL_SKU_PROMO', status: 'CAMPAIGN_STATE_INACTIVE', moneySpent: '999,00' }, // Ozon на неё отвечает 400
  ] }), { status: 200 });
  if (u.endsWith('/api/client/statistics') && init?.method === 'POST') {
    created++;
    const body = JSON.parse(init.body);
    if (body.campaigns.includes('23612241')) return new Response('{"error":"generation of this type of report is forbidden"}', { status: 400 });
    return new Response(JSON.stringify({ UUID: 'u1' }), { status: 200 });
  }
  if (u.includes('/statistics/report')) return new Response(archive, { status: 200, headers: { 'content-type': 'application/octet-stream' } });
  if (u.includes('/api/client/statistics/')) return new Response(JSON.stringify({ state: 'OK' }), { status: 200 });
  // Сшивка sku → артикул продавца (как на проде: список, затем инфо с sources[].sku).
  if (u.includes('/v3/product/list')) return new Response(JSON.stringify({ result: { items: [{ product_id: 1 }, { product_id: 2 }] } }), { status: 200 });
  if (u.includes('/v3/product/info/list')) return new Response(JSON.stringify({ items: [
    { offer_id: 'MASSAGE-WHITE-D845', sources: [{ sku: 5013157451 }] },
    { offer_id: 'SODA-SIPHON', sources: [{ sku: 3334496592 }] },
  ] }), { status: 200 });
  throw new Error('неожиданный запрос ' + u);
};

let failed = 0;
function check(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n      получили ${JSON.stringify(actual)}\n      ждали    ${JSON.stringify(expected)}`}`);
}

async function main() {
  const { unzipAll } = await import('../api/_lib/zip');
  console.log('ZIP читается целиком');
  const entries = unzipAll(archive);
  check('файлов в архиве', entries.length, 3);
  check('имена сохранены', entries.map(e => e.name)[1], '33960604_30.07-30.08.csv');

  console.log('\nОтчёт по пачке: данные из ВСЕХ кампаний');
  const m = await import('../api/_lib/ozonSkuAds');
  const r = await m.getOzonSkuAdsRange(30, 0, true);
  const massage = r.items['MASSAGE-WHITE-D845'], siphon = r.items['SODA-SIPHON'];
  check('массажёр найден (он во 2-м и 3-м файлах)', !!massage, true);
  check('расход массажёра сложен по двум кампаниям', massage?.spend, 1200);
  check('«Заказано на сумму» — max, не сумма', massage?.orderedSum, 81600);
  check('сифон из третьего файла тоже прочитан', siphon?.spend, 100);

  console.log('\nОтбор кампаний');
  check('ALL_SKU_PROMO не заказывалась (иначе 400 на всю пачку)', created, 1);
  check('архивная с расходом учтена', r.items['SODA-SIPHON'] != null, true);

  console.log(failed ? `\nРАСХОЖДЕНИЙ: ${failed}` : '\nВсё сходится.');
  process.exit(failed ? 1 : 0);
}
void main();
