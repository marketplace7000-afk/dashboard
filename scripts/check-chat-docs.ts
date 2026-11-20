/**
 * «Документы» в чатах (20.11.2026): что показываем покупателю, как называем файл, письмо в MIME.
 * Пути — как реально лежат на Яндекс.Диске владельца.
 * Запуск: npm run check
 */
import { categoryOf, isSendable, isEnglish, friendlyName, hasPdfTwin, CHAT_EXT } from '../api/_lib/reviews/chatDocs';
import { buildMime, maskEmail, EMAIL_RE } from '../api/_lib/mailer';
import { cleanBuyerName, isUnread } from '../api/_lib/reviews/chatStore';

let failed = 0;
function check(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n      получили ${JSON.stringify(actual)}\n      ждали    ${JSON.stringify(expected)}`}`);
}

const B = '/База о товаре начального уровня ';
const f = (p: string) => ({ name: p.split('/').pop()!, path: p });
const show = (p: string) => { const x = f(p); return isSendable(x.name, x.path); };
const cat = (p: string) => { const x = f(p); return categoryOf(x.name, x.path); };

console.log('Что видит менеджер');
check('русская инструкция — да', show(`${B}/AFERIY/AFERIY-STAN-AF-P280-2kWh/инструкция на русском/AF-P280_Руководство_пользователя_RU_17_страниц.pdf`), true);
check('техпаспорт Excel — да', show(`${B}/ALLPOWERS/ALLPOWERS-STAN3,5kWh-AP-R4000/технические паспорта/R4000_техпаспорт_русский.xlsx`), true);
check('фото комплектации — да', show(`${B}/AD-CARLINKIT-ULTRA/комплектация.jpg`), true);
check('Word «ссылка и характеристики» — нет (ссылка на поставщика)', show(`${B}/AD-CARLINKIT-ULTRA/характеристики и ссылка.docx`), false);
check('Word «комплектация и ТН ВЭД» — нет', show(`${B}/AFERIY/комплектация и ТН ВЭД.docx`), false);
check('Word «характерист.docx» — нет', show(`${B}/ALLPOWERS/ALLPOWERS-STAN3,5kWh-AP-R4000/характерист.docx`), false);
check('фото из папки «фото» — нет', show(`${B}/ALLPOWERS/ALLPOWERS-SUNPANEL-200W-SE200/фото/4.jpg`), false);
check('архив сертификатов .rar — нет', show(`${B}/AFERIY/AFERIY-STAN-AF-P280-2kWh/техническая документация/AF-P280 certificates.rar`), false);
check('видео — нет', show(`${B}/AFERIY/видео реклама.mp4`), false);
check('наш техпаспорт ИП Алешко — да', show(`${B}/ALLPOWERS/R4000/Техпаспорт для клиента (ИП Алешко А.О.)/Техпаспорт ИП Алешко — ALLPOWERS R4000.pdf`), true);
check('техпаспорт от производителя — нет', show(`${B}/ALLPOWERS/R4000/Техпаспорт от производителя/R4000_техпаспорт_русский.xlsx`), false);
check('документация от производителя — нет', show(`${B}/AFERIY/X/Документация от производителя/AF-P280_технические_характеристики_RU.pdf`), false);
{
  const dir = `${B}/ALLPOWERS/R4000/Техпаспорт для клиента (ИП Алешко А.О.)/Техпаспорт ИП Алешко — ALLPOWERS R4000`;
  const all = new Set([`${dir}.pdf`, `${dir}.docx`]);
  check('Word рядом с таким же PDF — прячем', hasPdfTwin(`${dir}.docx`, all), true);
  check('Word без PDF-двойника — показываем', hasPdfTwin(`${B}/X/инструкция.docx`, all), false);
}

console.log('Раздел документа');
check('инструкция', cat(`${B}/X/инструкция на русском/C2_руководство_пользователя_RU.pdf`), 'Инструкция');
check('техпаспорт', cat(`${B}/X/технические паспорта/R2500-V2_техпаспорт_русский.xlsx`), 'Техпаспорт');
check('комплектация', cat(`${B}/X/комплектация.jpg`), 'Комплектация');
check('сертификат', cat(`${B}/X/AF-P280 certificates.pdf`), 'Сертификат');
check('английская инструкция помечена', isEnglish('AF-P280 User manual.pdf', `${B}/AFERIY/X/инструкция на англ AF-P280/AF-P280 User manual.pdf`), true);
check('русская — не английская', isEnglish('AF-P280_Инструкция_RU.pdf', `${B}/AFERIY/X/инструкция на русском/AF-P280_Инструкция_RU.pdf`), false);
check('Excel в чат нельзя', CHAT_EXT.test('xlsx'), false);
check('PDF в чат можно', CHAT_EXT.test('pdf'), true);

console.log('Имя файла для покупателя');
check('китайское имя → понятное', friendlyName({ name: 'Mini Ultra12345 说明书 (俄语)26.7.6.pdf', category: 'Инструкция', english: false }, 'AD-CARLINKIT-ULTRA'), 'Инструкция AD-CARLINKIT-ULTRA.pdf');
check('нормальное имя не трогаем', friendlyName({ name: 'AF-P280_Инструкция_RU.pdf', category: 'Инструкция', english: false }, 'X'), 'AF-P280_Инструкция_RU.pdf');
check('«1.pdf» → понятное', friendlyName({ name: '1.pdf', category: 'Другое', english: false }, 'BOARD-JSK-X04'), 'Документ BOARD-JSK-X04.pdf');

console.log('Письмо');
const mime = buildMime({ to: 'buyer@mail.ru', subject: 'Документы к товару', text: 'Здравствуйте!', attachments: [{ name: 'Инструкция.pdf', mime: 'application/pdf', data: Buffer.from('%PDF-1.4 test') }] }, 'shop@yandex.ru', 'Магазин');
check('тема закодирована', /Subject: =\?UTF-8\?B\?/.test(mime), true);
check('вложение с русским именем', mime.includes(`filename*=UTF-8''${encodeURIComponent('Инструкция.pdf')}`), true);
check('конец письма', mime.trimEnd().endsWith('--'), true);
check('строки не длиннее 998', mime.split('\r\n').every(l => l.length <= 998), true);
check('адрес скрыт в журнале', maskEmail('ivanov@mail.ru'), 'iv***@mail.ru');
check('проверка адреса', [EMAIL_RE.test('a.b@mail.ru'), EMAIL_RE.test('нет'), EMAIL_RE.test('a@b')], [true, false, false]);

console.log('Прочитано / не прочитано');
const NOW = Date.UTC(2026, 10, 20, 20, 0);
const H = 3600_000;
check('покупатель написал, диалог не открывали — новое', isUnread({ last_from_buyer: 1, last_at: NOW - H, seen_at: null }, NOW), true);
check('открыли после сообщения — прочитано', isUnread({ last_from_buyer: 1, last_at: NOW - 2 * H, seen_at: NOW - H }, NOW), false);
check('покупатель написал ещё раз после открытия — снова новое', isUnread({ last_from_buyer: 1, last_at: NOW - H, seen_at: NOW - 2 * H }, NOW), true);
check('последним ответили мы — прочитано', isUnread({ last_from_buyer: 0, last_at: NOW - H, seen_at: null }, NOW), false);
check('старше 14 дней — не подсвечиваем', isUnread({ last_from_buyer: 1, last_at: NOW - 15 * 24 * H, seen_at: null }, NOW), false);

console.log('Имена покупателей Ozon из кабинета');
check('обычное имя', cleanBuyerName('  Дмитрий   П. '), 'Дмитрий П.');
check('пустое и «Покупатель» — нет имени', [cleanBuyerName(''), cleanBuyerName(null), cleanBuyerName('Покупатель')], [null, null, null]);
check('без угловых скобок и переносов', cleanBuyerName('<b>Ира</b>\nК.'), 'b Ира /b К.');
check('длинное — обрезано до 60', (cleanBuyerName('А'.repeat(100)) || '').length, 60);

if (failed) { console.log(`\n✗ Документы в чатах: ${failed} ошибок`); process.exit(1); }
console.log('\n✓ Документы в чатах: всё верно');
