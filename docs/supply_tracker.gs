/**
 * Apps Script для таблицы Supply_Tracker.
 *
 * Зачем: агент 3 («Трекер поставок») читает вкладку Tracker и напоминает о сроках
 * этапов. Трекер — ОТДЕЛЬНЫЙ файл от таблицы закупок, поэтому нужен свой скрипт.
 *
 * Отличие от скрипта на таблице закупок: здесь есть токен. Без него ссылка на
 * веб-приложение сама по себе даёт доступ к данным любому, кто её узнает.
 *
 * КАК РАЗВЕРНУТЬ (делается один раз, в таблице Supply_Tracker):
 *  1. Расширения → Apps Script.
 *  2. Вставить этот код, заменив содержимое файла.
 *  3. В строке TOKEN ниже поставить свой длинный случайный набор символов.
 *  4. Развернуть → Новое развёртывание → тип «Веб-приложение».
 *       Запуск от имени: я
 *       Доступ: все, у кого есть ссылка
 *  5. Скопировать выданный URL и передать разработчику.
 *
 * Права: скрипт работает ТОЛЬКО на чтение, изменить или удалить данные он не может.
 */

// ⚠ Замените на свой случайный токен (например 32 символа) и никому не показывайте.
const TOKEN = 'ЗАМЕНИТЕ_НА_СЛУЧАЙНЫЙ_ТОКЕН';

function doGet(e) {
  const params = (e && e.parameter) || {};

  // Без верного токена не отдаём ничего — иначе ссылку достаточно узнать,
  // чтобы прочитать всю таблицу поставок.
  if (params.token !== TOKEN) {
    return json({ error: 'unauthorized' });
  }

  const sheetName = params.sheet || 'Tracker';
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
  if (!sheet) {
    return json({ error: 'Лист не найден: ' + sheetName });
  }

  // getDisplayValues, а не getValues: даты и проценты приходят уже в том виде,
  // в каком их видят люди в таблице. Иначе пришлось бы угадывать формат.
  const data = sheet.getDataRange().getDisplayValues();
  return json({ data: data });
}

function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
