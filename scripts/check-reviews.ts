/**
 * Проверки агента 2 «Отзывы и вопросы» (без сети и без Claude):
 * сопоставление папок Диска с артикулами, эскалация кодом, очистка Telegram,
 * извлечение текста из docx, правило «отвечено вручную в кабинете».
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
process.env.REVIEWS_DB = join(tmpdir(), `reviews-check-${Date.now()}.sqlite`);

const { suggestOffers, stripPii, docxText, importTgPairs, tgStats, productKeyOf, cleanKnowledge } = await import('../api/_lib/reviews/kb');
const { codeEscalation, extractJson, FORBIDDEN } = await import('../api/_lib/reviews/drafts');
const { pairsFromChat, wbCardText } = await import('../api/_lib/reviews/sources');
const { chunksOf, productKnowledge, confirmFolder, imageMime } = await import('../api/_lib/reviews/kb');
const { upsertItem, markAnsweredExcept, getDb } = await import('../api/_lib/reviews/db');

let fails = 0;
function eq(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fails++; console.log(`✗ ${name}\n   получено: ${JSON.stringify(got)}\n   ожидали:  ${JSON.stringify(want)}`); }
  else console.log(`✓ ${name}`);
}

// 1. Папки Яндекс.Диска (снимок 04.10.2026) → артикулы.
const offers = ['S2000-PRO', 'R2500-V2', 'R4000', 'MASSAGE-GREEN-MM001', 'FACE-MASK-QZ011-BLACK', 'MANIC-STICK-1000mAH-PINK',
  'BOARD-JSK-X04-BLACK', 'BOARD-JSK-X04-WHITE', 'CARBITLINK-DUBL', 'FUEL-PUMP-FTP001', 'S2000'];
eq('S2000-PRO внутри длинного имени', suggestOffers('ALLPOWERS-STAN1,5kWh-AP-S2000-PRO', offers), ['S2000-PRO']);
eq('R2500-V2 внутри имени', suggestOffers('ALLPOWERS-STAN2kWh-AP-R2500-V2', offers), ['R2500-V2']);
eq('пробел в начале имени', suggestOffers(' CARBITLINK-DUBL', offers), ['CARBITLINK-DUBL']);
eq('точное совпадение', suggestOffers('FACE-MASK-QZ011-BLACK', offers), ['FACE-MASK-QZ011-BLACK']);
eq('папка = начало нескольких артикулов', suggestOffers('BOARD-JSK-X04', offers).sort(), ['BOARD-JSK-X04-BLACK', 'BOARD-JSK-X04-WHITE']);
eq('бренд без совпадений', suggestOffers('ECOFLOW', offers), []);


// 1б. Папка товара для файла (структура Диска владельца на 04.10.2026).
const B = '/База о товаре начального уровня ';
eq('файл в подпапке инструкции', productKeyOf(`${B}/ALLPOWERS/ALLPOWERS-STAN1,5kWh-AP-S2000-PRO/Наша инструкция на Русском языке /x.pdf`), 'ALLPOWERS/ALLPOWERS-STAN1,5kWh-AP-S2000-PRO');
eq('файл прямо в папке бренда', productKeyOf(`${B}/AFERIY/комплектация и ТН ВЭД.docx`), 'AFERIY');
eq('пробелы в имени папки', productKeyOf(`${B}/  CARBITLINK-DUBL/ссылка и характеристики.docx`), 'CARBITLINK-DUBL');
eq('фото/кит — не товар', productKeyOf(`${B}/AD-CARLINKIT-ULTRA/фото/кит/1.jpg`), 'AD-CARLINKIT-ULTRA');
eq('инструкция с латиницей в имени — не товар', productKeyOf(`${B}/AFERIY/AFERIY-STAN-AF-P280-2kWh/инструкция на англ  AF-P280/a.pdf`), 'AFERIY/AFERIY-STAN-AF-P280-2kWh');
eq('файл в корне — без товара', productKeyOf('/прайс.xlsx'), null);

eq('TX.RX ↔ TX/RX', suggestOffers('HDMI-WIRELESS-CHD02-HD-TX.RX', ['HDMI-WIRELESS-CHD02-HD-TX/RX']), ['HDMI-WIRELESS-CHD02-HD-TX/RX']);
eq('ссылки поставщика и ТН ВЭД вырезаются', cleanKnowledge('1.Ссылка на 1688: https://detail.1688.com/x\nМощность: 2400 Вт\nТН ВЭД: 8413702100\nРД: ДС ТР ТС'), 'Мощность: 2400 Вт');

// 2. Эскалация кодом.
eq('оценка 2 → эскалация', codeEscalation({ kind: 'review', rating: 2, text: 'норм', pros: null, cons: null }, 2), 'Оценка 2★');
eq('оценка 5, «брак» → эскалация', !!codeEscalation({ kind: 'review', rating: 5, text: 'пришёл брак, хочу вернуть', pros: null, cons: null }, 2), true);
eq('Роспотребнадзор → эскалация', !!codeEscalation({ kind: 'question', rating: null, text: 'напишу в роспотребнадзор', pros: null, cons: null }, 2), true);
eq('обычный вопрос → без эскалации', codeEscalation({ kind: 'question', rating: null, text: 'Какая ёмкость батареи?', pros: null, cons: null }, 2), null);
eq('отзыв 5 без риска', codeEscalation({ kind: 'review', rating: 5, text: 'Отличная станция, всё работает', pros: null, cons: null }, 2), null);

eq('грубость → эскалация', codeEscalation({ kind: 'question', rating: null, text: 'что за говно прислали', pros: null, cons: null }, 2), 'Грубая лексика');

eq('обрезанный JSON → ответ достаётся', extractJson('{"answer": "Здравствуйте! \\"Да\\".", "confidence": "low", "needs_escalation": true, "sources_used": ["history:5"').answer, 'Здравствуйте! "Да".');
eq('целый JSON', extractJson('```json\n{"answer":"Ок","confidence":"high","needs_escalation":false}\n```').confidence, 'high');

// 3. Очистка Telegram от персональных данных.
eq('телефон и @username', stripPii('Позвоните +7 (912) 345-67-89 или @ivan_petrov'), 'Позвоните [скрыто] или [скрыто]');
importTgPairs([
  { dialogId: 'd1', messageId: '1', question: 'Как подключить к машине?', answer: 'Через USB, инструкция в коробке', date: '2026-09-01' },
  { dialogId: 'd1', messageId: '1', question: 'дубль', answer: 'дубль', date: '2026-09-01' },
]);
eq('повторная загрузка без дублей', tgStats().pairs, 1);

// 4. docx без зависимостей.
function makeZip(name: string, content: string): Buffer {
  const data = deflateRawSync(Buffer.from(content, 'utf8'));
  const nameBuf = Buffer.from(name, 'utf8');
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8);
  local.writeUInt32LE(data.length, 18); local.writeUInt16LE(nameBuf.length, 26);
  const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(8, 10); cd.writeUInt32LE(data.length, 20);
  cd.writeUInt16LE(nameBuf.length, 28); cd.writeUInt32LE(0, 42);
  const localPart = Buffer.concat([local, nameBuf, data]);
  const cdPart = Buffer.concat([cd, nameBuf]);
  const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cdPart.length, 12); eocd.writeUInt32LE(localPart.length, 16);
  return Buffer.concat([localPart, cdPart, eocd]);
}
const docx = makeZip('word/document.xml', '<w:document><w:body><w:p><w:r><w:t>Ёмкость: 1536 Вт·ч</w:t></w:r></w:p><w:p><w:r><w:t>Вес 17 кг &amp; ручка</w:t></w:r></w:p></w:body></w:document>');
eq('docx → текст', docxText(docx), 'Ёмкость: 1536 Вт·ч\nВес 17 кг & ручка');

// 5. Ответ вручную в кабинете убирает запись из неотвеченных.
upsertItem({ marketplace: 'wb', kind: 'question', externalId: 'q1', text: 'вопрос 1', createdAt: 1, answered: false });
upsertItem({ marketplace: 'wb', kind: 'question', externalId: 'q2', text: 'вопрос 2', createdAt: 2, answered: false });
markAnsweredExcept('wb', 'question', new Set(['q2']));
const rows = getDb().prepare("SELECT external_id, answered_on_mp FROM items WHERE kind = 'question' ORDER BY external_id").all() as any[];
eq('q1 отвечен в кабинете, q2 ещё открыт', rows.map(r => [r.external_id, r.answered_on_mp]), [['q1', 1], ['q2', 0]]);

// 6. Чаты покупателей → пары: автосообщение магазина без вопроса не считается.
eq('пары из чата', pairsFromChat([
  { id: 'a', at: 1, fromBuyer: false, text: 'Вы оставили отзыв с низкой оценкой' },
  { id: 'b', at: 2, fromBuyer: true, text: 'Не включается адаптер' },
  { id: 'c', at: 3, fromBuyer: true, text: 'Машина Kia Rio' },
  { id: 'd', at: 4, fromBuyer: false, text: 'Проверьте, включён ли CarPlay в настройках' },
  { id: 'e', at: 5, fromBuyer: false, text: 'И перезагрузите магнитолу' },
  { id: 'f', at: 6, fromBuyer: true, text: 'Спасибо, заработало' },
]).map(p => [p.id, p.question, p.answer]), [['d', 'Не включается адаптер\nМашина Kia Rio', 'Проверьте, включён ли CarPlay в настройках\nИ перезагрузите магнитолу']]);

// 7. Ссылки и контакты в ответе — только вручную.
eq('ссылка в ответе', FORBIDDEN.test('Напишите нам: https://taplink.cc/x'), true);
eq('мессенджер в ответе', FORBIDDEN.test('Пишите в Телеграм'), true);
eq('обычный ответ', FORBIDDEN.test('Спасибо за отзыв! Максимальная мощность 2000 Вт.'), false);

// 8. Карточка WB → текст.
eq('карточка WB', wbCardText({ title: 'Адаптер', characteristics: [{ name: 'Цвет', value: ['черный'] }], description: '<p>Без проводов</p>' }),
  'Название: Адаптер\nЦвет: черный\nОписание: Без проводов');

// 9. Знания под вопрос: карточка + нужный кусок материалов, а не начало файла.
const d = getDb();
d.prepare("INSERT INTO kb_cards (marketplace, offer_id, name, text, updated_at) VALUES ('wb', 'TEST-1', 'Тест', 'Название: Тестовый адаптер', 1)").run();
const filler = Array.from({ length: 30 }, (_, i) => `Абзац про упаковку номер ${i} без полезного.`).join('\n\n');
d.prepare("INSERT INTO kb_folders (path, offer_ids, suggested, confirmed, files, text, updated_at) VALUES ('TEST-1', '[\"TEST-1\"]', '[]', 1, '[]', ?, 1)")
  .run(`### инструкция.pdf\n${filler}\n\nСопряжение по Bluetooth: удерживайте кнопку 5 секунд до мигания.`);
const pk = productKnowledge('TEST-1', 'как сделать сопряжение bluetooth', 900);
eq('карточка в знаниях', pk.text.includes('Тестовый адаптер'), true);
eq('нужный кусок инструкции найден', pk.text.includes('удерживайте кнопку 5 секунд'), true);
eq('куски по файлам', chunksOf('### a.docx\nраз\n\nдва').map(c => c.file), ['a.docx']);
void confirmFolder;
// 10. Компоненты набора без артикула идут в знания артикула-набора (папка-родитель с именем артикула).
d.prepare("INSERT INTO kb_folders (path, offer_ids, suggested, confirmed, files, text, updated_at) VALUES ('KIT-9-А-Б/PN111', '[]', '[]', 0, '[]', ?, 1)")
  .run('### pn.pdf\nПолироль наносить на холодную поверхность.');
eq('материалы компонента в наборе', productKnowledge('KIT-9-А/Б', 'как наносить полироль', 2000).text.includes('холодную поверхность'), true);
eq('общая папка не нужна чужому артикулу', productKnowledge('TEST-1', 'полироль', 2000).text.includes('холодную'), false);
eq('общая папка помечена', (await import('../api/_lib/reviews/kb')).listFolders().find(f => f.path === 'KIT-9-А-Б/PN111')?.shared, true);
// 11. Чаты: статус диалога по последнему сообщению, своё сообщение не дублируется.
{
  const cs = await import('../api/_lib/reviews/chatStore');
  cs.setThreadMeta('wb', 'c1', { replySign: 'sig', clientName: 'Иван' });
  cs.addMessages('wb', 'c1', [{ id: 'e1', at: 1000, fromBuyer: true, text: 'Не подключается к магнитоле' }]);
  eq('новое сообщение покупателя → ждёт ответа', cs.getThread('wb', 'c1')?.status, 'new');
  cs.addMessages('wb', 'c1', [{ id: 'local:1', at: 2000, fromBuyer: false, text: 'Проверьте Bluetooth' }]);
  eq('ответили → не ждёт', cs.getThread('wb', 'c1')?.status, 'idle');
  cs.addMessages('wb', 'c1', [{ id: 'e2', at: 2001, fromBuyer: false, text: 'Проверьте Bluetooth' }]);
  eq('своё сообщение не задваивается', cs.chatMessages('wb', 'c1').map(m => m.id), ['e1', 'e2']);
  cs.patchThread('wb', 'c1', { status: 'sent' });
  cs.addMessages('wb', 'c1', [{ id: 'e3', at: 3000, fromBuyer: true, text: 'Не помогло' }]);
  eq('покупатель снова написал → ждёт ответа', cs.getThread('wb', 'c1')?.status, 'new');
  eq('подпись для ответа есть', cs.getThread('wb', 'c1')?.canReply, true);
  // Тот же id чата на Ozon — отдельный диалог.
  cs.setThreadMeta('ozon', 'c1', { replySign: 'c1' });
  cs.addMessages('ozon', 'c1', [{ id: 'o1', at: 5000, fromBuyer: true, text: 'Подойдёт к Kia Rio 2019?' }]);
  eq('Ozon отдельно от WB', [cs.chatMessages('ozon', 'c1').length, cs.chatMessages('wb', 'c1').length], [1, 3]);
}
eq('«Макс» как мессенджер', FORBIDDEN.test('пишите в Макс'), true);
eq('«Максим» — не мессенджер', FORBIDDEN.test('Максим, спасибо'), false);
eq('png под видом jpg', imageMime(Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'x.jpg'), 'image/png');

if (fails) { console.log(`\nОшибок: ${fails}`); process.exit(1); }
console.log('\ncheck-reviews: всё в порядке');
