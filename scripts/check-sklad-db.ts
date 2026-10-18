/**
 * Раздел «Склад», этап 1: база, роли, справочники, импорт из таблицы.
 * Работает на временном файле базы — рабочую .av-cache/sklad.sqlite не трогает.
 *
 * Запуск: npm run check
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'sklad-check-'));
process.env.SKLAD_DB_PATH = join(dir, 'sklad.sqlite');

let failed = 0;
function check(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n      получили ${JSON.stringify(actual)}\n      ждали    ${JSON.stringify(expected)}`}`);
}

async function main() {
  const { getSkladDb, closeSkladDb } = await import('../api/_lib/sklad/db');
  const users = await import('../api/_lib/sklad/users');
  const cat = await import('../api/_lib/sklad/catalog');
  const imp = await import('../api/_lib/sklad/importSheet');
  const owner = users.OWNER_BY_PASSWORD;

  getSkladDb();
  cat.ensureSeed();
  cat.ensureSeed(); // повторный вызов не дублирует

  console.log('Склады и склады площадок из конфигурации FBS.gs');
  const wh = cat.listWarehouses();
  check('6 складов', wh.map(w => w.name), ['Склад Уфа', 'ФФ Подольск', 'ФФ Уфа', 'ФФ СПБ', 'ФФ Краснодар', 'Южные ворота']);
  const mp = cat.listMpWarehouses();
  const podolsk = wh.find(w => w.name === 'ФФ Подольск')!.id;
  check('WB каб.1: 25 складов (8+6+1 СГТ+4+6)', mp.filter(m => m.mp === 'wb1').length, 25);
  check('WB каб.2: 6 складов Подольска', mp.filter(m => m.mp === 'wb2' && m.warehouseId === podolsk).length, 6);
  check('СГТ — только тяжёлые', mp.find(m => m.extName === 'Склад ФФ Подольск-СГТ')?.mode, 'heavy_only');
  check('КГТ Ozon — только заказы', mp.find(m => m.mp === 'ozon' && m.extName === 'КГТ')?.mode, 'orders_only');

  console.log('Пользователи и роли');
  const ufa = wh.find(w => w.name === 'ФФ Уфа')!.id;
  check('сотруднику склада обязателен склад', users.createUser({ login: 'ivan', name: 'Иван', role: 'warehouse', password: 'secret123' }, owner).error,
    'Сотруднику склада нужно выбрать хотя бы один склад');
  check('короткий пароль', users.createUser({ login: 'ivan', name: 'Иван', role: 'manager', password: '123' }, owner).error,
    'Пароль — не короче 8 символов');
  const ivan = users.createUser({ login: 'ivan', name: 'Иван', role: 'warehouse', password: 'secret123', warehouseIds: [ufa] }, owner).user!;
  check('создан сотрудник ФФ Уфа', [ivan.role, ivan.warehouseIds], ['warehouse', [ufa]]);
  check('логин уникален без учёта регистра', users.createUser({ login: 'IVAN', name: 'Двойник', role: 'manager', password: 'secret123' }, owner).error,
    'Такой логин уже есть');
  check('неверный пароль не пускает', users.loginWithPassword('ivan', 'wrong-pass'), null);
  const au = users.loginWithPassword('Ivan', 'secret123')!;
  check('верный пароль пускает, склады подставлены', [au.role, au.warehouseIds], ['warehouse', [ufa]]);
  const ver = users.sessionVersion(ivan.id);
  check('сессия действует', users.userForSession(ivan.id, ver)?.login, 'ivan');
  users.updateUser(ivan.id, { password: 'newsecret1' }, owner);
  check('смена пароля гасит старую сессию', users.userForSession(ivan.id, ver), null);
  users.updateUser(ivan.id, { active: false }, owner);
  check('выключенный не входит', users.loginWithPassword('ivan', 'newsecret1'), null);
  check('полный кабинет: менеджер да, склад нет', [users.hasFullCabinet({ role: 'manager', sections: users.ROLE_SECTIONS.manager }), users.hasFullCabinet({ role: 'warehouse', sections: ['sklad'] })], [true, false]);
  const rop = users.createUser({ login: 'rop@avtovibe.ru', name: 'РОП', role: 'manager', password: 'secret123' }, owner).user!;
  check('логин-почта, разделы по роли (без настроек)', [rop.login, rop.sections.includes('settings'), rop.customSections], ['rop@avtovibe.ru', false, false]);
  const r1 = users.updateUser(rop.id, { sections: ['sklad', 'rnp'] }, owner).user!;
  check('свои галочки', [r1.sections, r1.customSections], [['sklad', 'rnp'], true]);
  const buyer = users.createUser({ login: 'zakup', name: 'Закупщик', role: 'buyer', password: 'secret123', sections: ['sklad', 'dashboard'] }, owner).user!;
  check('закупщику добавили Дашборд — кабинет шире склада', users.hasFullCabinet({ role: 'buyer', sections: buyer.sections }), true);
  check('фулфилменту галочки не открывают продажи', users.updateUser(ivan.id, { sections: ['sklad', 'ads'] }, owner).user!.sections, ['sklad']);
  check('смена роли сбрасывает галочки на набор роли', users.updateUser(rop.id, { role: 'buyer' }, owner).user!.sections, ['sklad']);

  console.log('Товары и баркоды');
  const p1 = cat.saveProduct(null, { article: 'POLFAR', name: 'Набор для полировки фар', barcodes: [{ barcode: '1000052566607', kind: 'main' }] }, owner).product!;
  check('товар создан', [p1.article, p1.status, p1.barcodes.length], ['POLFAR', 'active', 1]);
  check('артикул уникален без учёта регистра', cat.saveProduct(null, { article: 'polfar' }, owner).error, 'Товар с таким артикулом уже есть');
  const p2 = cat.saveProduct(null, { article: 'DUDU-C3-8-128' }, owner).product!;
  check('чужой баркод не отбираем', cat.saveProduct(p2.id, { barcodes: [{ barcode: '1000052566607' }] }, owner).error,
    'Баркод 1000052566607 уже принадлежит товару POLFAR');
  check('поиск по баркоду с пробелами', cat.findProduct(' 1000 0525 66607 ')?.article, 'POLFAR');
  check('поиск по артикулу без учёта регистра', cat.findProduct('dudu-c3-8-128')?.article, 'DUDU-C3-8-128');
  const worker = { ...au, warehouseIds: [ufa] };
  check('склад не меняет название', cat.saveProduct(p1.id, { name: 'X' }, worker).error,
    'Сотрудник склада может менять только габариты, вес, штук в коробке и баркоды');
  const dims = cat.saveProduct(p1.id, { lengthCm: '21', widthCm: '10', heightCm: '6,5', weightG: 224 }, worker).product!;
  check('склад вносит габариты (запятая в дроби)', [dims.heightCm, dims.volumeL], [6.5, 1.365]);
  check('ссылка на диск проверяется', cat.saveProduct(p1.id, { diskUrl: 'disk.yandex.ru/d/x' }, owner).error,
    'Ссылка на Яндекс Диск должна начинаться с https://');

  console.log('Новые склады площадок: наш склад по названию');
  const { suggestWarehouse } = await import('../api/_lib/sklad/mpSync');
  const ours = cat.listWarehouses();
  const sug = (n: string) => { const s = suggestWarehouse(n, ours); return [ours.find(w => w.id === s.warehouseId)?.name ?? null, s.mode]; };
  check('«Склад ФФ Подольск-Рязань» → ФФ Подольск', sug('Склад ФФ Подольск-Рязань'), ['ФФ Подольск', 'stock']);
  check('«Склад ФФ Подольск-СГТ» → ФФ Подольск, только тяжёлые', sug('Склад ФФ Подольск-СГТ'), ['ФФ Подольск', 'heavy_only']);
  check('«Склад ФФ Уфа-Казань» → ФФ Уфа, а не Склад Уфа', sug('Склад ФФ Уфа-Казань'), ['ФФ Уфа', 'stock']);
  check('«Склад Уфа» → Склад Уфа', sug('Склад Уфа'), ['Склад Уфа', 'stock']);
  check('чужой склад не угадываем', sug('Нижнекамск спортивная 9'), [null, 'stock']);

  console.log('Импорт из таблицы: колонки по заголовкам, архив вместо удаления');
  const header = [
    ['', '', '', '', '', '', '', '', '', 'Закуп', 'Едет на склад', '', 'Склад Уфа'],
    ['Pic', 'Link', 'SKU Ozon/ЯМ/WB', 'NAME', 'Длина', 'Ширина', 'Высота', 'Вес', 'Баркод', '', '', '', '', '', 'Кол-во'],
    ['', '', '', '', '', '', '', '', '', '', 'В пути, ед.', '', 'Остаток, ед.', '', 'в коробке'],
  ];
  const rows = [
    ['', 'https://disk.yandex.ru/d/TaSLXsCQardVwQ', 'DUDU-C3-8-128', 'Android box DUDUAUTO C3 8-128', 14.5, 12.5, 5.5, 323, 6430000742732, 12037, 0, 0, 110, 0, 100],
    ['', '', 'POLFAR', '', '', '', '', '', 1000052566607],
    ...Array.from({ length: 10 }, (_, i) => ['', '', `NEW-${i}`, `Новинка ${i}`]),
  ];
  const formulas = [[], [], [], ['=IMAGE("https://ir.ozone.ru/a.jpg")'], ['=IMAGE("https://ir.ozone.ru/b.jpg")']];
  const master = imp.parseMaster([...header, ...rows], formulas);
  check('прочитано 12 товаров', master.length, 12);
  check('поля DUDU', [master[0].diskUrl, master[0].perBox, master[0].photoUrl, master[0].barcode],
    ['https://disk.yandex.ru/d/TaSLXsCQardVwQ', 100, 'https://ir.ozone.ru/a.jpg', '6430000742732']);
  const base = imp.parseBarcodeBase([['', 'Штрихкод'], ['POLFAR', 1000052566607], ['РАКЕЛЬ-С-НОЖОМ', 4600000000017], ['DUDU-C3-8-128', 6430000742732]]);
  const dry = imp.applyImport(master, base, owner, true);
  check('пробный прогон ничего не пишет', [dry.created.length, cat.listProducts().length], [10, 2]);
  const r = imp.applyImport(master, base, owner, false);
  check('создано 10 новинок, 1 выведенный — в архиве', [r.created.length, r.archivedNew], [10, ['РАКЕЛЬ-С-НОЖОМ']]);
  check('пустые ячейки таблицы не затирают внесённое складом', cat.findProduct('POLFAR')?.heightCm, 6.5);
  check('DUDU обновлён из таблицы', r.updated.find(u => u.article === 'DUDU-C3-8-128')?.fields,
    ['name', 'lengthCm', 'widthCm', 'heightCm', 'weightG', 'perBox', 'photoUrl', 'diskUrl']);
  const r2 = imp.applyImport(master.filter(p => p.article !== 'NEW-0'), base, owner, false);
  check('повторный импорт: пропавший со «Склада Уфа» → архив', r2.archivedGone, ['NEW-0']);
  check('повторный импорт ничего не создаёт', r2.created.length, 0);
  const r3 = imp.applyImport(master, base, owner, false);
  check('вернулся на лист — снова активный', r3.reactivated, ['NEW-0']);
  check('сбой чтения (мало строк) не архивирует всё', imp.applyImport(master.slice(0, 3), base, owner, true).archivedGone.length, 0);

  closeSkladDb();
}

main()
  .catch(e => { failed++; console.error(e); })
  .finally(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* временная папка */ }
    if (failed) { console.log(`\nПРОВАЛЕНО проверок: ${failed}`); process.exit(1); }
    console.log('\nВсе проверки «Склада» прошли');
  });
