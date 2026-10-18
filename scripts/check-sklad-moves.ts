/**
 * Раздел «Склад», этап 2: журнал движений, перемещения, сторно,
 * инвентаризация, перенос истории из таблицы и сверка с колонкой M.
 * Работает на временном файле базы — рабочую .av-cache/sklad.sqlite не трогает.
 *
 * Запуск: npm run check
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'sklad-moves-'));
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
  const inv = await import('../api/_lib/sklad/inventory');
  const hist = await import('../api/_lib/sklad/importHistory');
  const owner = users.OWNER_BY_PASSWORD;
  getSkladDb();
  cat.ensureSeed();

  const whId = (n: string) => cat.listWarehouses().find(w => w.name === n)!.id;
  const UFA = whId('Склад Уфа'), SPB = whId('ФФ СПБ'), FFU = whId('ФФ Уфа');
  const pol = cat.saveProduct(null, { article: 'POLFAR', barcodes: [{ barcode: '1000052566607', kind: 'main' }] }, owner).product!.id;
  const dudu = cat.saveProduct(null, { article: 'DUDU-C3-8-128' }, owner).product!.id;
  const worker = (wh: number) => ({ id: 999, login: 'w', name: 'Сотрудник', role: 'warehouse' as const, warehouseIds: [wh], sections: ['sklad' as const] });

  console.log('Движения: приход, расход, остаток');
  check('закупка без цены не проходит', mv.postMovement({ kind: 'purchase', whId: UFA, lines: [{ productId: pol, qty: 10 }] }, owner).error,
    'У закупки нужна цена за единицу — из неё считается себестоимость');
  mv.postMovement({ kind: 'purchase', whId: UFA, lines: [{ productId: pol, qty: 10, price: '242' }, { productId: dudu, qty: 5, price: 12037 }] }, owner);
  check('остаток после закупки', [mv.stockOf(UFA, pol), mv.stockOf(UFA, dudu)], [10, 5]);
  check('расход больше остатка не пропускаем', mv.postMovement({ kind: 'writeoff', whId: UFA, note: 'брак', lines: [{ productId: pol, qty: 11 }] }, owner).error,
    'Не хватает остатка: POLFAR (есть 10, нужно 11)');
  check('списание без причины не проходит', mv.postMovement({ kind: 'writeoff', whId: UFA, lines: [{ productId: pol, qty: 1 }] }, owner).error, 'Укажите причину списания');
  const w1 = mv.postMovement({ kind: 'writeoff', whId: UFA, note: 'брак', lines: [{ productId: pol, qty: 1 }] }, owner).movement!;
  check('списание', mv.stockOf(UFA, pol), 9);
  check('сотрудник не проводит на чужом складе', mv.postMovement({ kind: 'other_in', whId: UFA, lines: [{ productId: pol, qty: 1 }] }, worker(FFU)).error, 'Нет доступа к этому складу');
  check('сотрудник не проводит закупку', mv.postMovement({ kind: 'purchase', whId: FFU, lines: [{ productId: pol, qty: 1, price: 1 }] }, worker(FFU)).error, 'Этот вид движения вам недоступен');
  check('сотрудник не сторнирует', mv.reverseMovement(w1.id, 'ошибка', worker(UFA)).error, 'Исправлять проведённые движения может владелец или менеджер');
  mv.reverseMovement(w1.id, 'посчитали дважды', owner);
  check('сторно вернуло остаток', mv.stockOf(UFA, pol), 10);
  check('повторное сторно нельзя', mv.reverseMovement(w1.id, 'ещё раз', owner).error, 'Движение уже исправлено');
  check('сотрудник не видит цену партии', mv.listMovements({ kind: 'purchase' }, false).items[0].lines[0].price, null);

  console.log('Перемещение: в пути, приёмка по факту');
  const t = mv.sendTransfer({ whId: UFA, toWhId: SPB, lines: [{ productId: pol, qty: 6 }] }, owner).movement!;
  check('у отправителя списано, у получателя ещё нет', [mv.stockOf(UFA, pol), mv.stockOf(SPB, pol)], [4, 0]);
  check('видно «в пути»', mv.stockSnapshot(null).inTransit, [{ productId: pol, toWhId: SPB, qty: 6 }]);
  check('получатель видит входящее перемещение в журнале', mv.listMovements({ whIds: [SPB], inTransit: true }, false).total, 1);
  const rcv = mv.receiveTransfer(t.id, { lines: [{ productId: pol, qty: 5 }] }, worker(SPB)).movement!;
  check('принято 5 из 6, расхождение записано', [mv.stockOf(SPB, pol), rcv.note], [5, 'Отправлено 6, принято 5']);
  check('в пути больше нет', mv.stockSnapshot(null).inTransit.length, 0);
  check('принять второй раз нельзя', mv.receiveTransfer(t.id, {}, owner).error, 'Это перемещение уже принято');
  mv.reverseMovement(rcv.id, 'не тот склад', owner);
  check('отменили приёмку — снова в пути', mv.stockSnapshot(null).inTransit, [{ productId: pol, toWhId: SPB, qty: 6 }]);
  mv.receiveTransfer(t.id, {}, worker(SPB));
  check('приняли заново целиком', mv.stockOf(SPB, pol), 6);

  console.log('Инвентаризация');
  const i1 = inv.createInventory({ whId: SPB }, worker(SPB)).inventory!;
  check('одна открытая на склад', inv.createInventory({ whId: SPB }, worker(SPB)).inventory!.id, i1.id);
  check('чужой склад нельзя', inv.createInventory({ whId: UFA }, worker(SPB)).error, 'Нет доступа к этому складу');
  inv.setCount(i1.id, { productId: pol, qty: 1, add: true }, worker(SPB));
  inv.setCount(i1.id, { productId: pol, qty: 1, add: true }, worker(SPB));
  inv.setCount(i1.id, { productId: dudu, qty: 2 }, worker(SPB));
  const v = inv.getInventory(i1.id)!;
  check('сканирование прибавляет; ожидание и разница', v.lines.map(l => [l.article, l.counted, l.expected, l.diff]).sort(),
    [['DUDU-C3-8-128', 2, 0, 2], ['POLFAR', 2, 6, -4]]);
  const fin = inv.finishInventory(i1.id, worker(SPB));
  check('проведено: +2 и −4', [fin.plus, fin.minus, mv.stockOf(SPB, pol), mv.stockOf(SPB, dudu)], [2, 4, 2, 2]);
  check('закрытую не меняем', inv.setCount(i1.id, { productId: pol, qty: 9 }, worker(SPB)).error, 'Инвентаризация уже закрыта');
  check('в закрытой сохранено «ожидалось»', inv.getInventory(i1.id)!.lines.find(l => l.article === 'POLFAR')!.expected, 6);
  const i2 = inv.createInventory({ whId: SPB, fullCount: true }, worker(SPB)).inventory!;
  inv.setCount(i2.id, { productId: pol, qty: 2 }, worker(SPB));
  inv.finishInventory(i2.id, worker(SPB));
  check('полная: непосчитанное списано в ноль', [mv.stockOf(SPB, pol), mv.stockOf(SPB, dudu)], [2, 0]);
  inv.setPendingProvider(wh => new Map(wh === SPB ? [[pol, 1]] : []));
  const i3 = inv.createInventory({ whId: SPB }, worker(SPB)).inventory!;
  inv.setCount(i3.id, { productId: pol, qty: 3 }, worker(SPB));
  check('несобранный заказ на полке учтён в ожидании', inv.getInventory(i3.id)!.lines[0].diff, 0);
  inv.setPendingProvider(() => new Map());
  inv.updateInventory(i3.id, { cancel: true }, worker(SPB));

  console.log('Перенос истории из таблицы');
  check('дата из числа Google', new Date(hist.sheetDate(46313)! + 3 * 3600000).toISOString().slice(0, 10), '2026-10-18');
  check('дата строкой', new Date(hist.sheetDate('09.03.2025')! + 3 * 3600000).toISOString().slice(0, 10), '2025-03-09');
  const whMap = new Map(cat.listWarehouses().map(w => [w.name.toLowerCase(), w.id]));
  check('виды отгрузок', ['WB', 'Ozon', 'Яндекс', 'Я.Kit', 'ФФ СПБ', 'Прочая отгрузка', 'Прочее', ''].map(d0 => hist.shipmentKind(d0, whMap).kind),
    ['sale_wb', 'sale_ozon', 'sale_ym', 'sale_ykit', 'transfer_out', 'writeoff', 'writeoff', 'other_out']);
  check('поставка FBO, записанная как Ozon/WB', [hist.shipmentKind('Ozon', whMap, 'Новосибирск 15.10').kind, hist.shipmentKind('WB', whMap, 'fbs').kind, hist.shipmentKind('Ozon', whMap, '0123-4567-1').kind],
    ['fbo_ozon', 'sale_wb', 'sale_ozon']);
  check('виды приёмки', ([['Поставка', true], ['Поставка', false], ['355', true], ['Возврат Ozon', false], ['Входящий остаток', true]] as const)
    .map(([e, p]) => hist.receiptKind(e, p)), ['purchase', 'arrival', 'purchase', 'return_ozon', 'opening']);
  const R = (row: number, date: unknown, sku: string, qty: unknown, d0: unknown, e: unknown, f: unknown, g: string) => ({ row, date, sku, qty, d: d0, e, f, g });
  const receipts = [
    R(22, 46278, 'POLFAR', 20, 242, 'Входящий остаток', 1000052566607, 'ФФ Уфа'),
    R(21, 46300, 'CP-Q1M-FLASH', 7, '', 'Поставка', '', 'ФФ Уфа'),
    R(20, 46310, 'POLFAR', 1, '', 'Возврат WB', '', 'ФФ Уфа'),
  ];
  const shipments = [
    R(23, 46301, 'POLFAR', 3, 'WB', '1234567', 1000052566607, 'ФФ Уфа'),
    R(22, 46302, 'POLFAR', 2, 'Ozon', '0123-0001-1', '', 'ФФ Уфа'),
    R(21, 46303, 'CP-Q1M-FLASH', 2, 'ФФ СПБ', 'перемещение', '', 'ФФ Уфа'),
    R(20, 46304, 'POLFAR', 1, 'ФФ Краснодар', '', '', 'Выкуп в ПВЗ'),
    R(19, 46313, 'POLFAR', 1, 'ФФ Уфа', 'Инвентаризация 18.10', '', 'ФФ Уфа'),
    R(18, 46313, 'POLFAR', 5, 'ФФ Уфа', '', '', 'ФФ Уфа'),
  ];
  const before = mv.stockOf(FFU, pol);
  const dry = hist.applyHistory(receipts, shipments, owner, true);
  check('пробный перенос ничего не пишет', [dry.imported, mv.stockOf(FFU, pol)], [7, before]);
  const h1 = hist.applyHistory(receipts, shipments, owner, false);
  check('перенесено 7; пропущены неизвестный склад и отгрузка самому себе без пометки', [h1.imported, h1.skipped.map(s => s.row)], [7, [20, 18]]);
  check('инвентаризация «склад → он же» — недостача с предупреждением', [h1.byKind.inventory_minus, h1.warnings.length], [1, 1]);
  check('выведенный артикул заведён архивным', [h1.newArchived, cat.findProduct('CP-Q1M-FLASH')?.status], [['CP-Q1M-FLASH'], 'archived']);
  check('остаток ФФ Уфа = 20 + 1 − 3 − 2 − 1', mv.stockOf(FFU, pol) - before, 15);
  hist.applyHistory(receipts, shipments, owner, false);
  check('повторный перенос не задваивает', mv.stockOf(FFU, pol) - before, 15);
  check('ручные движения сайта перенос не трогает', mv.stockOf(UFA, pol), 4);
  const rec = hist.reconcile(new Map([['ФФ Уфа', new Map([['POLFAR', 15], ['CP-Q1M-FLASH', 5]])]]), new Map());
  const ffu = rec.warehouses.find(w => w.name === 'ФФ Уфа')!;
  check('сверка с колонкой M: всё совпало', [ffu.items, ffu.matched, ffu.diffs], [2, 2, []]);
  const rec2 = hist.reconcile(new Map([['ФФ Уфа', new Map([['POLFAR', 16]])]]), new Map());
  check('сверка показывает расхождение', rec2.warehouses.find(w => w.name === 'ФФ Уфа')!.diffs, [{ article: 'POLFAR', sheet: 16, site: 15 }]);
  kvSet(hist.CUTOVER_KEY, String(Date.now()));
  let blocked = '';
  try { hist.applyHistory(receipts, shipments, owner, true); } catch (e) { blocked = (e as Error).message; }
  check('после перехода перенос запрещён', blocked, 'Переход с таблицы уже завершён — перенос истории отключён');

  closeSkladDb();
}

main()
  .catch(e => { failed++; console.error(e); })
  .finally(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* временная папка */ }
    if (failed) { console.log(`\nПРОВАЛЕНО проверок: ${failed}`); process.exit(1); }
    console.log('\nВсе проверки движений «Склада» прошли');
  });
