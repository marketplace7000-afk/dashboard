// Транзит на склады WB FBW — товары, которые едут на склад / на приёмке, но ещё
// НЕ в продаже. Зеркало ozonTransit.ts. Клиент (созвон 01.07): «на ВБ абсолютно
// то же самое — товары, которые сейчас в пути или в приёмке».
//
// Флоу WB Supplies API (host supplies-api.wildberries.ru):
//   1) POST /api/v1/supplies {"dates":[]}          → список поставок (заголовки)
//   2) GET  /api/v1/supplies/{supplyID}/goods       → состав {vendorCode, quantity}
//
// Правило «транзита» выведено эмпирично по живому API (02.07.2026):
//   statusID=1 — черновик (нет дат)            → исключаем («подготовка»)
//   statusID=3 — запланировано (supplyDate в будущем, factDate=null) → едет ✓
//   statusID=5 — принято (factDate проставлен)  → уже в продаже, исключаем
// Обобщение: транзит = НЕ черновик, factDate пусто (ещё не принято), И supplyDate
// свежий/будущий. Последнее КРИТИЧНО: нашлись зависшие поставки статуса 5 без
// factDate с датами 2025 года — это мусор, не транзит. Окно 21 день отсекает их,
// но пропускает «отгружено в воротах»/«идёт приёмка» (дата поставки только прошла).

import { fetchWithRetry } from './fetchRetry';
import { cacheGet, cacheSet, isFresh } from './cache';

const BASE = 'https://supplies-api.wildberries.ru';
const CACHE_KEY = 'wb-transit:v1';
// 3 часа: cron принудительно освежает раз в 2ч, поэтому браузер всегда читает
// свежий кэш и НЕ триггерит запрос к supplies-api при заходе на «Распределение».
const TTL_MS = 3 * 60 * 60_000;

export type WbTransitResult = {
  items: Record<string, number>;      // vendorCode (UPPER) → кол-во в транзите
  totalUnits: number;
  suppliesCount: number;              // сколько поставок в транзите
  byStatus: Record<string, number>;   // распределение statusID (для сверки)
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

const RECENT_MS = 21 * 24 * 60 * 60_000;
function isTransit(s: any): boolean {
  if (!s || s.statusID === 1 || s.factDate || !s.supplyDate) return false;
  const t = new Date(s.supplyDate).getTime();
  if (!Number.isFinite(t)) return false;
  return t >= Date.now() - RECENT_MS; // свежие/будущие; отсекаем зависшие старые
}

async function compute(): Promise<WbTransitResult> {
  // 1) Все поставки → фильтр «в пути / на приёмке».
  const supplies: any[] = await wbReq('/api/v1/supplies', 'POST', { dates: [] });
  const byStatus: Record<string, number> = {};
  for (const s of supplies) byStatus[String(s.statusID)] = (byStatus[String(s.statusID)] ?? 0) + 1;
  const transit = supplies.filter(isTransit);

  // 2) Состав каждой транзитной поставки → сумма quantity по vendorCode.
  const items: Record<string, number> = {};
  let totalUnits = 0;
  for (const s of transit) {
    const goods: any = await wbReq(`/api/v1/supplies/${s.supplyID}/goods`, 'GET');
    const list: any[] = Array.isArray(goods) ? goods : (goods?.goods ?? goods?.items ?? []);
    for (const g of list) {
      const code = String(g.vendorCode ?? g.article ?? g.supplierArticle ?? g.nmID ?? '').trim().toUpperCase();
      const qty = Number(g.quantity ?? g.readyForSaleQuantity ?? 0) || 0;
      if (!code || qty <= 0) continue;
      items[code] = (items[code] ?? 0) + qty;
      totalUnits += qty;
    }
  }

  return { items, totalUnits, suppliesCount: transit.length, byStatus, fetchedAt: Date.now() };
}

// Кэш 1ч; при сбое (в т.ч. per-seller 429) отдаём последний удачный кэш, чтобы
// «Распределение» не осталось без цифры транзита WB.
export async function getWbTransit(noCache = false): Promise<WbTransitResult> {
  const cached = await cacheGet<WbTransitResult>(CACHE_KEY);
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
