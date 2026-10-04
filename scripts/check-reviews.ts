/**
 * Проверки агента 4 «Отзывы и вопросы» (без сети и без Claude):
 * сопоставление папок Диска с артикулами, эскалация кодом, очистка Telegram,
 * извлечение текста из docx, правило «отвечено вручную в кабинете».
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
process.env.REVIEWS_DB = join(tmpdir(), `reviews-check-${Date.now()}.sqlite`);

const { suggestOffers, stripPii, docxText, importTgPairs, tgStats, productKeyOf } = await import('../api/_lib/reviews/kb');
const { codeEscalation } = await import('../api/_lib/reviews/drafts');
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

// 2. Эскалация кодом.
eq('оценка 2 → эскалация', codeEscalation({ kind: 'review', rating: 2, text: 'норм', pros: null, cons: null }, 2), 'Оценка 2★');
eq('оценка 5, «брак» → эскалация', !!codeEscalation({ kind: 'review', rating: 5, text: 'пришёл брак, хочу вернуть', pros: null, cons: null }, 2), true);
eq('Роспотребнадзор → эскалация', !!codeEscalation({ kind: 'question', rating: null, text: 'напишу в роспотребнадзор', pros: null, cons: null }, 2), true);
eq('обычный вопрос → без эскалации', codeEscalation({ kind: 'question', rating: null, text: 'Какая ёмкость батареи?', pros: null, cons: null }, 2), null);
eq('отзыв 5 без риска', codeEscalation({ kind: 'review', rating: 5, text: 'Отличная станция, всё работает', pros: null, cons: null }, 2), null);

eq('грубость → эскалация', codeEscalation({ kind: 'question', rating: null, text: 'что за говно прислали', pros: null, cons: null }, 2), 'Грубая лексика');

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

if (fails) { console.log(`\nОшибок: ${fails}`); process.exit(1); }
console.log('\ncheck-reviews: всё в порядке');
