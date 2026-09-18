/**
 * Остатки FBS из Google-таблицы «Склад» (та же таблица, что и себестоимость:
 * SKLAD_SHEET_ID, сервисный аккаунт avtovibe-sheets@…).
 *
 * Бизнес перешёл на FBS полностью (17.09.2026). Физический товар лежит на
 * пяти площадках, у каждой свой лист в таблице:
 *   «Склад Уфа»     — основной склад, отгружает ТОЛЬКО Ozon;
 *   «ФФ Уфа»        — фулфилмент, отгружает ТОЛЬКО WB;
 *   «ФФ Подольск», «ФФ СПБ», «ФФ Краснодар» — отгружают и WB, и Ozon.
 * Колонки листа (проверено по API 17.09.2026, строка 2 — заголовки, данные с 4-й):
 *   C — артикул (он же vendorCode WB и offer_id Ozon), I — баркод,
 *   K — «В пути, ед.» (едет на этот склад), M — «Остаток, ед.».
 * Остаток на маркетплейсах ставит Apps Script клиента (остаток − открытые заказы),
 * поэтому таблица — первоисточник, а не отчёты WB/Ozon.
 */
import { cacheGet, cacheSet, isFresh } from './cache';

export type WarehouseStock = { stock: number; transit: number };
export type StockItem = {
  article: string;
  barcode: string;
  /** По складам: имя листа → остаток/в пути. */
  wh: Record<string, WarehouseStock>;
  /** Доступно площадке = сумма по складам, которые её отгружают. Общие склады входят в обе цифры. */
  wb: WarehouseStock;
  ozon: WarehouseStock;
  total: WarehouseStock;
};
export type StockSheet = {
  fetchedAt: number;
  warehouses: { name: string; mps: Array<'wb' | 'ozon'>; rows: number }[];
  items: Record<string, StockItem>;
  error?: string;
};

const SHEETS: Array<{ name: string; mps: Array<'wb' | 'ozon'> }> = [
  { name: 'Склад Уфа', mps: ['ozon'] },
  { name: 'ФФ Уфа', mps: ['wb'] },
  { name: 'ФФ Подольск', mps: ['wb', 'ozon'] },
  { name: 'ФФ СПБ', mps: ['wb', 'ozon'] },
  { name: 'ФФ Краснодар', mps: ['wb', 'ozon'] },
];
const CACHE_KEY = 'stock-sheet:v1';
const TTL_MS = 10 * 60_000;
const COL = { article: 2, barcode: 8, transit: 10, stock: 12 }; // C, I, K, M (0-based)

const num = (v: unknown): number => {
  if (v === null || v === undefined || v === '') return 0;
  const n = Number(String(v).replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
};
const empty = (): WarehouseStock => ({ stock: 0, transit: 0 });

async function build(): Promise<StockSheet> {
  const id = (process.env.SKLAD_SHEET_ID || '').trim();
  const out: StockSheet = { fetchedAt: Date.now(), warehouses: [], items: {} };
  if (!id) { out.error = 'SKLAD_SHEET_ID не задан'; return out; }
  const { hasServiceAccount, readSheetRange } = await import('./googleSheetsApi');
  if (!hasServiceAccount()) { out.error = 'ключ сервисного аккаунта не настроен'; return out; }
  const errors: string[] = [];
  for (const sh of SHEETS) {
    let rows: any[][] = [];
    try {
      rows = await readSheetRange(id, `'${sh.name}'!A4:M3000`);
    } catch (e) {
      errors.push(`${sh.name}: ${(e as Error).message}`);
      out.warehouses.push({ name: sh.name, mps: sh.mps, rows: -1 });
      continue;
    }
    let n = 0;
    for (const r of rows) {
      const article = String(r?.[COL.article] ?? '').trim().toUpperCase();
      if (!article) continue;
      const w: WarehouseStock = { stock: num(r?.[COL.stock]), transit: num(r?.[COL.transit]) };
      const it = out.items[article] ?? (out.items[article] = {
        article, barcode: '', wh: {}, wb: empty(), ozon: empty(), total: empty(),
      });
      if (!it.barcode) it.barcode = String(r?.[COL.barcode] ?? '').trim();
      it.wh[sh.name] = w;
      it.total.stock += w.stock; it.total.transit += w.transit;
      for (const mp of sh.mps) { it[mp].stock += w.stock; it[mp].transit += w.transit; }
      n++;
    }
    out.warehouses.push({ name: sh.name, mps: sh.mps, rows: n });
  }
  if (errors.length) out.error = errors.join('; ');
  return out;
}

export async function getStockSheet(noCache = false): Promise<StockSheet> {
  const cached = await cacheGet<StockSheet>(CACHE_KEY);
  if (!noCache && isFresh(cached)) return cached.data;
  try {
    const fresh = await build();
    // Пустой результат с ошибкой не кэшируем надолго — пусть следующий заход попробует снова.
    if (Object.keys(fresh.items).length) await cacheSet(CACHE_KEY, fresh, TTL_MS);
    else if (cached?.data) return { ...cached.data, error: fresh.error ?? cached.data.error };
    return fresh;
  } catch (e) {
    if (cached?.data) return { ...cached.data, error: (e as Error).message };
    return { fetchedAt: Date.now(), warehouses: [], items: {}, error: (e as Error).message };
  }
}
