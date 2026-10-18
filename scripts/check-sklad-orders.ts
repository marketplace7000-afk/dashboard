/**
 * Раздел «Склад», этап 3: заказы FBS — состояния WB/Ozon, теневой и боевой
 * режимы, отмены, деление отправлений Ozon, несобранные в инвентаризации,
 * сверка с «Отгрузкой» таблицы. На временной базе.
 *
 * Запуск: npm run check
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'sklad-orders-'));
process.env.SKLAD_DB_PATH = join(dir, 'sklad.sqlite');

let failed = 0;
function check(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n      получили ${JSON.stringify(actual)}\n      ждали    ${JSON.stringify(expected)}`}`);
}

async function main() {
  const { getSkladDb, closeSkladDb, kvSet } = await import('../api/_lib/sklad/db');
  const users = await import('../api/_lib/sklad/users');
  const cat = await import('../api/_lib/sklad/catalog');
  const mv = await import('../api/_lib/sklad/movements');
  const ord = await import('../api/_lib/sklad/orders');
  const inv = await import('../api/_lib/sklad/inventory');
  const cmp = await import('../api/_lib/sklad/ordersCompare');
  const owner = users.OWNER_BY_PASSWORD;
  const d = getSkladDb();
  cat.ensureSeed();
  const wh = (n: string) => cat.listWarehouses().find(w => w.name === n)!.id;
  const POD = wh('ФФ Подольск'), KRD = wh('ФФ Краснодар');
  // id складов площадок, как их найдёт сверка
  d.prepare(`UPDATE mp_warehouses SET ext_id = '111' WHERE mp = 'wb1' AND ext_name = 'Склад ФФ Подольск-Тверь'`).run();
  d.prepare(`UPDATE mp_warehouses SET ext_id = '222' WHERE mp = 'ozon' AND ext_name = 'Склад ФФ Краснодар'`).run();
  d.prepare(`UPDATE mp_warehouses SET ext_id = '333' WHERE mp = 'ozon' AND ext_name = 'КГТ'`).run();
  const hdmi = cat.saveProduct(null, { article: 'HDMI-WIRELESS-G146', barcodes: [{ barcode: '6430000111111', kind: 'main' }] }, owner).product!.id;
  const manic = cat.saveProduct(null, { article: 'MANIC-STICK-GREY-HX-2607', barcodes: [{ barcode: '6430000222222', kind: 'main' }] }, owner).product!.id;
  mv.postMovement({ kind: 'other_in', whId: POD, lines: [{ productId: hdmi, qty: 10 }] }, owner);
  mv.postMovement({ kind: 'other_in', whId: KRD, lines: [{ productId: hdmi, qty: 10 }, { productId: manic, qty: 5 }] }, owner);

  console.log('Состояния заказов');
  check('WB new → не собран', ord.wbState('new', 'waiting').state, 'open');
  check('WB confirm → собран', ord.wbState('confirm', 'waiting').state, 'assembled');
  check('WB complete → передан', ord.wbState('complete', 'sorted').state, 'shipped');
  check('WB отмена покупателем до сборки', ord.wbState('new', 'canceled_by_client').state, 'cancelled_before');
  check('WB supplierStatus cancel', ord.wbState('cancel', 'waiting').state, 'cancelled_before');
  check('WB отмена после передачи', ord.wbState('complete', 'canceled').state, 'cancelled_after');
  check('Ozon awaiting_packaging', ord.ozonState('awaiting_packaging', undefined, null).state, 'open');
  check('Ozon awaiting_deliver', ord.ozonState('awaiting_deliver', undefined, null).state, 'assembled');
  check('Ozon отменён до отгрузки', ord.ozonState('cancelled', false, null).state, 'cancelled_before');
  check('Ozon отменён после сборки без передачи — с пометкой', [ord.ozonState('cancelled', true, null).state, !!ord.ozonState('cancelled', true, null).problem], ['cancelled_after', true]);
  check('Ozon delivering', ord.ozonState('delivering', undefined, null).state, 'shipped');

  const T = Date.now() - 3600_000;
  const wbO = (id: string, state: any, raw = 'new/waiting') => ({ mp: 'wb1' as const, orderId: id, offer: '6430000111111', keys: ['6430000111111'], qty: 1, extWhId: '111', orderedAt: T, rawStatus: raw, state });
  const ozO = (pn: string, offer: string, qty: number, state: any, whExt = '222') => ({ mp: 'ozon' as const, orderId: pn, offer, keys: [offer], qty, extWhId: whExt, orderedAt: T, rawStatus: state, state });

  console.log('Теневой режим: только реестр, остатки не меняются');
  const r1 = ord.upsertOrders([wbO('1001', 'open'), ozO('0100-0001-1', 'HDMI-WIRELESS-G146', 2, 'open'), ozO('0100-0002-1', 'MANIC-STICK-GREY-HX-2607', 1, 'open', '333')]);
  check('записано 3, ничего не списано', [r1.added, r1.created, mv.stockOf(POD, hdmi), mv.stockOf(KRD, hdmi)], [3, 0, 10, 10]);
  check('КГТ Ozon → ФФ Подольск', (d.prepare(`SELECT wh_id FROM mp_orders WHERE order_id = '0100-0002-1'`).get() as any).wh_id, POD);
  const r2 = ord.upsertOrders([{ ...wbO('1002', 'open'), extWhId: '999' }, { ...wbO('1003', 'open'), offer: '000', keys: ['000'] }]);
  check('непривязанный склад и неизвестный товар — проблемы', [r2.unmapped, ord.listOrders({ problems: true }).total], [2, 2]);
  check('несобранные на полке для инвентаризации', [...ord.pendingOnShelf(KRD).entries()], [[hdmi, 2]]);
  check('ожидается в инвентаризации = остаток + несобранные', (() => {
    const i = inv.createInventory({ whId: KRD }, owner).inventory!;
    inv.setCount(i.id, { productId: hdmi, qty: 12 }, owner);
    const l = inv.getInventory(i.id)!.lines[0];
    inv.updateInventory(i.id, { cancel: true }, owner);
    return [l.stock, l.pending, l.expected, l.diff];
  })(), [10, 2, 12, 0]);

  console.log('Боевой режим: списание в момент заказа, сторно отмен');
  kvSet('orders_live_since', String(T - 60_000));
  const r3 = ord.upsertOrders([wbO('1001', 'open'), ozO('0100-0001-1', 'HDMI-WIRELESS-G146', 2, 'open')]);
  check('существующие заказы после отметки списаны', [r3.created, mv.stockOf(POD, hdmi), mv.stockOf(KRD, hdmi)], [2, 9, 8]);
  const r4 = ord.upsertOrders([wbO('1001', 'assembled', 'confirm/waiting'), ozO('0100-0001-1', 'HDMI-WIRELESS-G146', 2, 'open')]);
  check('смена статуса не списывает повторно', [r4.created, mv.stockOf(POD, hdmi)], [0, 9]);
  ord.upsertOrders([wbO('1001', 'cancelled_before', 'confirm/canceled_by_client')]);
  check('отмена до передачи → сторно, товар вернулся', mv.stockOf(POD, hdmi), 10);
  ord.upsertOrders([wbO('1001', 'cancelled_before', 'cancel/canceled_by_client')]);
  check('повторная отмена не сторнирует дважды', mv.stockOf(POD, hdmi), 10);
  ord.upsertOrders([ozO('0100-0001-1', 'HDMI-WIRELESS-G146', 1, 'open'), ozO('0100-0001-3', 'HDMI-WIRELESS-G146', 1, 'open')], new Set(['0100-0001-1', '0100-0001-3']));
  check('деление Ozon 2 → 1+1: всего списано 2, не 3', mv.stockOf(KRD, hdmi), 8);
  ord.upsertOrders([ozO('0100-0001-1', 'MANIC-STICK-GREY-HX-2607', 1, 'open')], new Set(['0100-0001-1']));
  check('товар ушёл из отправления → сторно', [mv.stockOf(KRD, hdmi), mv.stockOf(KRD, manic)], [9, 4]);
  ord.upsertOrders([wbO('1005', 'shipped', 'complete/sorted')]);
  ord.upsertOrders([wbO('1005', 'cancelled_after', 'complete/canceled')]);
  check('отмена после передачи — списание остаётся (ждём возврат)', mv.stockOf(POD, hdmi), 9);
  // заказ уже есть в перенесённой истории — не списываем второй раз
  mv.insertMovement({ whId: POD, sign: -1, kind: 'sale_wb', ref: '1006', source: 'sheet', lines: [{ productId: hdmi, qty: 1 }] }, owner);
  ord.upsertOrders([wbO('1006', 'open')]);
  check('заказ из истории таблицы не задваивается', mv.stockOf(POD, hdmi), 8);
  const old = { ...wbO('0999', 'open'), orderedAt: T - 3 * 3600_000 };
  ord.upsertOrders([old]);
  check('заказ до отметки перехода не списывается (он в истории)', mv.stockOf(POD, hdmi), 8);

  console.log('Сверка с «Отгрузкой» таблицы');
  d.prepare(`UPDATE mp_orders SET ordered_at = ? WHERE 1=1`).run(Date.now() - 3600_000);
  const row = (n: number, sku: string, qty: number, ref: string, from: string) => ({ row: n, date: 46313, sku, qty, dest: 'WB', ref, from });
  const rep = cmp.compareOrders([
    row(20, 'HDMI-WIRELESS-G146', 1, '1001', 'ФФ Подольск'),       // отменён до передачи, но строка осталась
    row(21, 'HDMI-WIRELESS-G146', 1, '0100-0001-1', 'ФФ Краснодар'), // товар ушёл из отправления при делении
    row(24, 'HDMI-WIRELESS-G146', 2, '0100-0001-3', 'ФФ Краснодар'), // на площадке 1 после деления
    row(22, 'HDMI-WIRELESS-G146', 1, '1005', 'ФФ СПБ'),            // не тот склад
    row(23, 'HDMI-WIRELESS-G146', 1, '777777777', 'ФФ Подольск'),  // сайт этого заказа не видел
  ], 3);
  check('отменённый и ушедший при делении остались в таблице', rep.cancelledButInTable.map(x => x.orderId).sort(), ['0100-0001-1', '1001']);
  check('количество после деления', rep.qtyMismatch.map(x => [x.orderId, x.site, x.table]), [['0100-0001-3', 1, 2]]);
  check('склад не совпал', rep.whMismatch.map(x => x.orderId), ['1005']);
  check('нет в таблице', rep.missingInTable.map(x => x.orderId).sort(), ['0100-0001-1', '0100-0002-1', '0999', '1006'].sort());
  check('есть только в таблице', rep.tableOnly.map(x => x.ref), ['777777777']);

  console.log('«Склад Уфа» → Ozon: сводная сверка по артикулам (вносится вручную)');
  d.prepare(`UPDATE mp_warehouses SET ext_id = '444' WHERE mp = 'ozon' AND ext_name = 'Склад Уфа'`).run();
  const MSK = 3 * 3600000;
  const today0 = Math.floor((Date.now() + MSK) / 86400000) * 86400000 - MSK;
  const yesterdayNoon = today0 - 12 * 3600000;
  ord.upsertOrders([{ ...ozO('0200-0001-1', 'HDMI-WIRELESS-G146', 2, 'shipped', '444'), orderedAt: yesterdayNoon },
    { ...ozO('0200-0002-1', 'MANIC-STICK-GREY-HX-2607', 1, 'shipped', '444'), orderedAt: yesterdayNoon },
    { ...ozO('0200-0003-1', 'MANIC-STICK-GREY-HX-2607', 1, 'cancelled_before', '444'), orderedAt: yesterdayNoon }]);
  const ySerial = (today0 + MSK) / 86400000 + 25569 - 1;
  const rep2 = cmp.compareOrders([
    { row: 30, date: ySerial, sku: 'HDMI-WIRELESS-G146', qty: 2, dest: 'Ozon', ref: 'fbs', from: 'Склад Уфа' },
    { row: 31, date: ySerial, sku: 'MANIC-STICK-GREY-HX-2607', qty: 2, dest: 'Ozon', ref: '', from: 'Склад Уфа' },
    { row: 32, date: ySerial, sku: 'HDMI-WIRELESS-G146', qty: 10, dest: 'Ozon', ref: 'Новосибирск 15.10', from: 'Склад Уфа' },
  ], 3);
  check('поставка FBO, записанная как Ozon, — отдельно, не в сумме', rep2.manual[0].fbo.map(x => [x.row, x.qty]), [[32, 10]]);
  check('сумма по артикулу: HDMI сошлось, MANIC на 1 больше в таблице', rep2.manual[0].items, [
    { article: 'HDMI-WIRELESS-G146', site: 2, table: 2 }, { article: 'MANIC-STICK-GREY-HX-2607', site: 1, table: 2 }]);
  check('заказы ручного склада не попадают в «нет в таблице»', rep2.missingInTable.some(x => x.orderId.startsWith('0200-')), false);

  console.log('Склад площадки «не учитывать» (самовыкупы)');
  const before = ord.listOrders({ problems: true }).counts.problems;
  ord.setIgnoredWh('wb1', '999', 'Нижнекамск', 'самовыкупы', true);
  check('заказ со склада «не учитывать» — не проблема и не в списке', [ord.listOrders({ problems: true }).counts.problems, ord.listOrders({ ignored: true }).total], [before - 1, 1]);
  const r9 = ord.upsertOrders([{ ...wbO('1009', 'open'), extWhId: '999' }]);
  check('новый заказ оттуда не списывается и не «без привязки»', [r9.unmapped, r9.created], [0, 0]);
  ord.setIgnoredWh('wb1', '999', 'Нижнекамск', '', false);
  check('снять пометку', ord.listIgnoredWh().length, 0);

  closeSkladDb();
}

main()
  .catch(e => { failed++; console.error(e); })
  .finally(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* временная папка */ }
    if (failed) { console.log(`\nПРОВАЛЕНО проверок: ${failed}`); process.exit(1); }
    console.log('\nВсе проверки заказов «Склада» прошли');
  });
