/**
 * Серверное чтение Google-таблицы клиента (тот же Apps Script, что и фронт).
 *
 * Нужно агентам, которые работают БЕЗ открытого браузера (проактивные алерты в
 * Telegram): фронтовый src/api/googleSheets.ts им недоступен.
 * Читаем только те листы/колонки, что реально нужны агентам — не дублируем весь
 * парсинг фронта.
 */

const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbwCPfeSVYni6VCXK206p8sxVly8T7Ur5khc6kMdIxIeZBKSfK5wPH12Q5Qs8j4u96v3/exec';

/** Сырые строки листа. Пустой массив, если лист недоступен (не роняем агента). */
export async function fetchSheetRows(sheetName: string): Promise<any[][]> {
  const url = `${APPS_SCRIPT_URL}?sheet=${encodeURIComponent(sheetName)}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json() as { data?: any[][]; error?: string };
    if (json.error) throw new Error(json.error);
    return json.data ?? [];
  } catch (e) {
    console.warn(`[sheets] лист "${sheetName}" недоступен:`, (e as Error).message);
    return [];
  }
}

const n = (v: any): number => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};

export type StockRow = {
  sku: string;
  name: string;
  stockOzon: number;
  stockWB: number;
  warehouseStock: number;
  transit: number;
  daily: number;          // средние продажи в день (по 30 дн, обе площадки)
  purchasePrice: number;
};

/**
 * Остатки + скорость продаж + транзит по SKU.
 * Колонки (как во фронтовом парсере):
 *   Ozon_wb:                A=SKU B=имя C=остОзон D=остWB E=s7Oz F=s7WB G=s30Oz H=s30WB
 *   Склад и цена закупки:   A=SKU C=остаток_склад D=цена_закупки
 *   Транзит:                A=SKU C=кол-во
 */
export async function fetchStockSnapshot(): Promise<StockRow[]> {
  const [owb, sklad, tranzit] = await Promise.all([
    fetchSheetRows('Ozon_wb'),
    fetchSheetRows('Склад и цена закупки'),
    fetchSheetRows('Транзит'),
  ]);
  if (!owb.length) return [];

  const map = new Map<string, StockRow>();
  for (let i = 1; i < owb.length; i++) {
    const r = owb[i];
    const sku = String(r[0] ?? '').trim().toUpperCase();
    if (!sku) continue;
    const daily = (n(r[6]) + n(r[7])) / 30;   // s30 Ozon + s30 WB
    map.set(sku, {
      sku,
      name: String(r[1] ?? '').trim(),
      stockOzon: n(r[2]),
      stockWB: n(r[3]),
      warehouseStock: 0,
      transit: 0,
      daily: Math.round(daily * 100) / 100,
      purchasePrice: 0,
    });
  }
  // Склад — только обновляем существующие SKU (как на фронте: в «Складе» много
  // служебных вариантов, которые не должны попадать в прогноз).
  for (let i = 1; i < sklad.length; i++) {
    const r = sklad[i];
    const it = map.get(String(r[0] ?? '').trim().toUpperCase());
    if (!it) continue;
    it.warehouseStock += n(r[2]);
    if (!it.purchasePrice) it.purchasePrice = n(r[3]);
  }
  for (let i = 1; i < tranzit.length; i++) {
    const r = tranzit[i];
    const it = map.get(String(r[0] ?? '').trim().toUpperCase());
    if (!it) continue;
    it.transit += n(r[2]);
  }
  return [...map.values()];
}

/**
 * СЕБЕСТОИМОСТЬ ИЗ ОСНОВНОЙ ТАБЛИЦЫ «СКЛАД» (решение клиента 11.08).
 *
 * Клиент попросил не переносить себестоимость в платформу: таблица у него —
 * система учёта, закупщик и кладовщик ведут в ней цены новых партий. Просьба
 * была перецепиться с таблицы-дублёра на основную таблицу «Склад», колонка I.
 *
 * Колонки листа (проверено по скриншоту 11.08):
 *   B (индекс 1) — SKU Ozon/ЯМ/WB
 *   I (индекс 8) — «Закуп», себестоимость единицы
 * В самой ячейке формула (ВПР к листу «Себес»), но Apps Script отдаёт уже
 * вычисленное значение, так что читаем как обычное число.
 *
 * Адрес скрипта основной таблицы задаётся отдельной переменной окружения:
 * это ДРУГОЙ файл, чем таблица-дашборд, и общий скрипт к нему доступа не имеет.
 */
const SKLAD_SCRIPT_URL = (process.env.SKLAD_SCRIPT_URL || '').trim();
const SKLAD_SHEET_NAME = (process.env.SKLAD_SHEET_NAME || 'Склад').trim();

export type SkladCost = { sku: string; cost: number };

const SKLAD_SHEET_ID = (process.env.SKLAD_SHEET_ID || '').trim();

/**
 * Разбор листа «Склад»: колонки ищем ПО ЗАГОЛОВКАМ, а не по номеру.
 *
 * 04.09 клиент вставил в таблицу колонку «Link»: артикул уехал из B в C, «Закуп»
 * из I в J. Парсер читал по номерам, попал в пустоту, вернул ноль строк — и
 * синхронизация молча оставила СТАРЫЕ значения (9 751 вместо 11 497 и т.д.).
 * Таблица клиента — живой документ, колонки в ней будут двигаться и дальше.
 *
 * Заголовок ищем в первых строках: ячейка с «sku» или «артикул» — это колонка
 * артикула, ячейка с «закуп» — себестоимость. Номера B/I остаются запасным
 * вариантом, если заголовков не нашлось, и об этом пишется в журнал.
 */
export type SkladLayout = { skuCol: number; costCol: number; headerRow: number; byHeader: boolean };

export function detectSkladLayout(rows: any[][]): SkladLayout {
  const norm = (v: unknown) => String(v ?? '').trim().toLowerCase();
  // Заголовки у клиента разнесены по строкам: «Закуп» стоит над группой в
  // строке 1, а «SKU Ozon/ЯМ/WB» — в строке 2 (живой лист 09.09). Поэтому ищем
  // каждую колонку в любой из первых строк, а не требуем обе в одной.
  let skuCol = -1, costCol = -1, headerRow = -1;
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const r = rows[i] ?? [];
    if (skuCol < 0) skuCol = r.findIndex(c => /(^|\s)sku(\s|$|\/)|артикул/.test(norm(c)));
    if (costCol < 0) costCol = r.findIndex(c => /закуп/.test(norm(c)));
    if (skuCol >= 0 && costCol >= 0) { headerRow = i; break; }
  }
  if (skuCol >= 0 && costCol >= 0) return { skuCol, costCol, headerRow, byHeader: true };
  console.warn('[sheets] заголовки «SKU»/«Закуп» в листе «Склад» не найдены — читаем колонки B и I по номеру');
  return { skuCol: 1, costCol: 8, headerRow: 0, byHeader: false };
}

function parseSkladRows(rows: any[][]): SkladCost[] {
  const items: SkladCost[] = [];
  const lay = detectSkladLayout(rows);
  for (let i = lay.headerRow + 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r) continue;
    const sku = String(r[lay.skuCol] ?? '').trim().toUpperCase();
    const cost = n(r[lay.costCol]);
    if (!sku || cost <= 0) continue;
    if (/^sku/i.test(sku)) continue;                       // повторный заголовок
    items.push({ sku, cost });
  }
  console.log(`[sheets] «Склад»: артикул в колонке ${lay.skuCol + 1}, закуп в ${lay.costCol + 1}` +
    `${lay.byHeader ? ' (по заголовкам)' : ' (по номеру!)'} · строк с ценой ${items.length}`);
  return items;
}

export async function fetchSkladCosts(): Promise<{ items: SkladCost[]; error?: string }> {
  // Предпочтительный путь — сервисный аккаунт: клиенту достаточно поделиться
  // таблицей на просмотр, разворачивать скрипт у себя не нужно.
  if (SKLAD_SHEET_ID) {
    try {
      const { hasServiceAccount, readSheetRange, listSheetTitles } = await import('./googleSheetsApi');
      if (!hasServiceAccount()) throw new Error('ключ сервисного аккаунта не настроен');
      // Вкладку ищем по списку, а не подставляем имя вслепую. 09.09: лист «Склад»
      // переименовали в «Склад Уфа», и чтение падало с 400 «Unable to parse range»
      // — себестоимость молча жила на старых значениях. Берём точное имя из
      // настроек, иначе первую вкладку, чьё имя начинается со «Склад».
      const titles = await listSheetTitles(SKLAD_SHEET_ID);
      const tab = titles.find(t => t === SKLAD_SHEET_NAME)
        ?? titles.find(t => t.toLowerCase().startsWith(SKLAD_SHEET_NAME.toLowerCase()))
        ?? titles.find(t => /склад/i.test(t));
      if (!tab) throw new Error(`в таблице нет вкладки «${SKLAD_SHEET_NAME}»; есть: ${titles.join(', ')}`);
      if (tab !== SKLAD_SHEET_NAME) console.warn(`[sheets] вкладка «${SKLAD_SHEET_NAME}» не найдена, читаем «${tab}»`);
      // Имя с пробелом в A1-нотации обязано быть в одинарных кавычках.
      const rows = await readSheetRange(SKLAD_SHEET_ID, `'${tab.replace(/'/g, "''")}'!A1:Z5000`);
      return { items: parseSkladRows(rows) };
    } catch (e) {
      const msg = (e as Error).message;
      console.warn('[sheets] «Склад» через Sheets API не прочитан:', msg);
      // Ниже пробуем Apps Script, если он настроен, — вдруг доступ дали так.
      if (!SKLAD_SCRIPT_URL) return { items: [], error: msg };
    }
  }

  if (!SKLAD_SCRIPT_URL) {
    return { items: [], error: 'не настроено: задайте SKLAD_SHEET_ID (сервисный аккаунт) или SKLAD_SCRIPT_URL' };
  }
  try {
    const url = `${SKLAD_SCRIPT_URL}?sheet=${encodeURIComponent(SKLAD_SHEET_NAME)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json() as { data?: any[][]; error?: string };
    if (json.error) throw new Error(json.error);
    return { items: parseSkladRows(json.data ?? []) };
  } catch (e) {
    const msg = (e as Error).message;
    console.warn('[sheets] лист «Склад» основной таблицы недоступен:', msg);
    return { items: [], error: msg };
  }
}
