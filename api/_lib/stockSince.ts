/**
 * «С КАКОГО МОМЕНТА У ТОВАРА ЕСТЬ ОСТАТОК» — для новинок на листе цен (23.10.2026).
 *
 * Жалоба клиента: AFERIY-STAN-AF-P280-2kWh поступил в продажу сегодня — есть в
 * «Складе», есть цена в кабинете, продаётся, — а в «Ценах» его нет. Причина в
 * фильтре «В продаже» (src/utils/inSale.ts): главный судья там — последний обход
 * витрины агентом (3 раза в день), и товар, появившийся ПОСЛЕ обхода, считался
 * «не на витрине» до следующего обхода (а если компьютер выключен — до суток).
 *
 * Остатки WB/Ozon перечитываются раз в 5 минут. Здесь запоминаем, когда остаток
 * товара стал положительным: если это случилось позже последнего обхода, витрина
 * про товар ещё ничего не знает — он новый, и лист цен показывает его сразу.
 * Распродан (остаток 0) — отметка стирается, следующий приход начнёт её заново.
 *
 * Первый запуск: всё, что уже лежит на складе, помечаем «давно» (0) — иначе до
 * ближайшего обхода всплыли бы единицы-«хвосты», которых на витрине нет (возвраты,
 * брак; см. inSale.ts), и фильтр снова показывал бы непродаваемое.
 *
 * Файл в av-data (как себестоимость): переживает выкатку и перезапуск.
 */
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { noteSwallowed } from './log';

const FILE = process.env.STOCK_SINCE_FILE || join(process.cwd(), 'av-data', 'stock-since.json');

type SinceFile = Partial<Record<'wb' | 'ozon', Record<string, number>>>;

function load(): SinceFile {
  try {
    if (existsSync(FILE)) return JSON.parse(readFileSync(FILE, 'utf8')) ?? {};
  } catch (e) {
    noteSwallowed('stock-since', 'файл не прочитан — отметки начнутся заново', e);
  }
  return {};
}

/** Отметки без обновления — когда снимок остатков неполный и 0 в нём не приговор. */
export function peekStockSince(mp: 'wb' | 'ozon'): Record<string, number> {
  return load()[mp] ?? {};
}

/**
 * Обновить отметки по свежему снимку остатков и вернуть их (ключ → мс, 0 = «давно»).
 * Зовётся после каждого полного пересчёта остатков площадки.
 */
export function trackStockSince(mp: 'wb' | 'ozon', stock: Record<string, number>, now = Date.now()): Record<string, number> {
  const data = load();
  const firstRun = !data[mp];
  const prev = data[mp] ?? {};
  const next: Record<string, number> = {};
  for (const [id, qty] of Object.entries(stock)) {
    if (!(qty > 0)) continue;
    next[id] = id in prev ? prev[id] : (firstRun ? 0 : now);
  }
  data[mp] = next;
  try {
    mkdirSync(dirname(FILE), { recursive: true });
    const tmp = `${FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(data), 'utf8');
    renameSync(tmp, FILE);
  } catch (e) {
    noteSwallowed('stock-since', 'файл не записан', e);
  }
  return next;
}
