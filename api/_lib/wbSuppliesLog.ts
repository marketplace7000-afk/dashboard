// Журнал поставок на склад WB (FBW) — что отгружено на склад WB, с датами и
// статусом приёмки. Раньше карточка «Поставки на склад WB» брала данные из
// statistics-api /api/v1/supplies (incomes) — WB УДАЛИЛ этот метод в июне 2026.
// Актуальный источник — supplies-api.wildberries.ru (тот же, что и транзит):
//   1) POST /api/v1/supplies {"dates":[]}       → заголовки поставок
//   2) GET  /api/v1/supplies/{supplyID}/goods    → состав (vendorCode, quantity)
//
// Заголовок отдаёт: supplyID, createDate, supplyDate, factDate, statusID,
// boxTypeID. Названия склада/количества в заголовке НЕТ — количество берём из
// состава (по одному запросу на поставку, поэтому кэшируем на час и ограничиваем
// окно последними N поставками, чтобы не выжигать лимит supplies-api).

import { fetchWithRetry } from './fetchRetry';
import { cacheGet, cacheSet, isFresh } from './cache';
import { noteSwallowed } from './log';

const BASE = 'https://supplies-api.wildberries.ru';
const CACHE_KEY = 'wb-supplies-log:v1';
// 3 часа: cron принудительно освежает раз в 2ч → браузер всегда читает свежий кэш
// и НЕ триггерит supplies-api при заходе на «Распределение».
const TTL_MS = 3 * 60 * 60_000;
const MAX_DETAIL = 25;         // на скольких свежих поставках тянем состав (лимит supplies-api ~30/мин)

export type WbSupplyRow = {
  supplyID: number;
  createDate: string;
  supplyDate: string;
  factDate: string | null;
  statusID: number;
  status: string;              // человекочитаемо
  boxType: string;
  units: number | null;        // сумма quantity (null — состав не тянули)
  positions: number | null;    // число артикулов в поставке
};

export type WbSuppliesLog = {
  supplies: WbSupplyRow[];
  totalUnits: number;
  count: number;               // всего поставок в окне (не только с составом)
  detailed: number;            // по скольким показано количество
  fetchedAt: number;
};

function wbToken(): string {
  return (process.env.WB_TOKEN_SUPPLIES || process.env.WB_TOKEN || '').trim();
}

async function wbReq(path: string, method: 'GET' | 'POST', body?: unknown): Promise<any> {
  const headers: Record<string, string> = { Authorization: wbToken() };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetchWithRetry(
    `${BASE}${path}`,
    { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined },
    { maxRetries: 3, timeoutMs: 30_000 },
  );
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`wb ${path} → ${res.status} ${txt.slice(0, 200)}`);
  }
  return res.json();
}

const BOX_TYPE: Record<number, string> = { 1: 'Короба', 2: 'Монопаллеты', 5: 'Суперсейф', 6: 'QR-поставка' };
function statusLabel(s: any): string {
  if (s.factDate) return 'Принято';
  if (s.statusID === 1) return 'Черновик';
  return 'Запланирована';
}

async function compute(days = 30): Promise<WbSuppliesLog> {
  const all: any[] = await wbReq('/api/v1/supplies', 'POST', { dates: [] });
  const since = Date.now() - days * 86_400_000;
  const tsOf = (s: any) => Date.parse(s.createDate || s.supplyDate || '') || 0;
  const recent = all
    .filter(s => { const t = tsOf(s); return t > 0 && t >= since; })
    .sort((a, b) => tsOf(b) - tsOf(a));

  let totalUnits = 0, detailed = 0;
  const supplies: WbSupplyRow[] = [];
  for (const s of recent) {
    let units: number | null = null, positions: number | null = null;
    if (detailed < MAX_DETAIL) {
      try {
        const goods: any = await wbReq(`/api/v1/supplies/${s.supplyID}/goods`, 'GET');
        const list: any[] = Array.isArray(goods) ? goods : (goods?.goods ?? goods?.items ?? []);
        units = 0; positions = list.length;
        for (const g of list) units += Number(g.quantity ?? g.readyForSaleQuantity ?? 0) || 0;
        totalUnits += units; detailed++;
      } catch (e) {
        // Поставка покажется без количества. Пустая колонка без объяснения читается
        // как ноль, поэтому причину фиксируем.
        noteSwallowed('wb-supplies', 'состав поставки не получен', e);
      }
    }
    supplies.push({
      supplyID: s.supplyID,
      createDate: s.createDate,
      supplyDate: s.supplyDate,
      factDate: s.factDate ?? null,
      statusID: s.statusID,
      status: statusLabel(s),
      boxType: BOX_TYPE[s.boxTypeID] ?? '—',
      units, positions,
    });
  }
  return { supplies, totalUnits, count: recent.length, detailed, fetchedAt: Date.now() };
}

// Кэш 1ч; при сбое (в т.ч. per-seller 429) отдаём последний удачный кэш.
export async function getWbSupplies(noCache = false): Promise<WbSuppliesLog> {
  const cached = await cacheGet<WbSuppliesLog>(CACHE_KEY);
  if (!noCache && isFresh(cached)) return cached.data;
  try {
    const fresh = await compute();
    await cacheSet(CACHE_KEY, fresh, TTL_MS);
    return fresh;
  } catch (e) {
    if (cached?.data) return cached.data;
    throw e;
  }
}
