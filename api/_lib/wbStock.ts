// «Остатки» WB — фактические складские остатки по nmId (seller-analytics-api, отчёт warehouse_remains), НЕ из Google-таблицы.
// Нужны для фильтра «в продаже» в разделе Цены: раньше он опирался на признаки из
// таблицы снабжения и на историю продаж — оба источника дырявые (правка клиента 15.09,
// см. docs/handover): товар без недавних продаж и без строки в таблице считался
// «не в продаже» и просто пропадал из вида, даже если реально лежит на складе WB.
//
// GET https://statistics-api.wildberries.ru/api/v1/supplier/stocks?dateFrom=...
// возвращает ТЕКУЩИЙ снимок остатков по всем складам; dateFrom — обязательный, но не
// фильтрует «на дату», а служит нижней границей истории (по спецификации WB), поэтому
// берём фиксированную раннюю дату. Суммируем quantity по nmId.
import { fetchWithRetry } from './fetchRetry';
import { cacheGet, cacheSet, isFresh } from './cache';
import { fetchAllWbCards } from './wbCards';

const CACHE_KEY = 'wb-stock:v2'; // v2: + FBS (склады продавца, marketplace-api v3)
const TTL_MS = 30 * 60_000; // остатки меняются в течение дня чаще, чем цены

export type WbStock = {
  byNm: Record<string, number>; // nmId (строкой) → остаток FBO (склады WB) + FBS (склады продавца)
  fboByNm?: Record<string, number>;
  fbsByNm?: Record<string, number>; // максимум по складам продавца (региональные склады дублируют один физический остаток)
  fbsError?: string; // если FBS не удалось получить — явный 0 в FBO-отчёте не считается «нет в наличии»
  fetchedAt: number;
};

function wbToken(): string {
  return (process.env.WB_TOKEN_COMMON || process.env.WB_TOKEN || '').trim();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 09.2026: WB отключил GET /api/v1/supplier/stocks (410/404, "This method is deprecated",
// see https://dev.wildberries.ru/release-notes?id=494). Актуальная замена — отчёт
// "Остатки на складах" через асинхронную задачу: создать → дождаться status=done → скачать.
async function compute(): Promise<WbStock> {
  const createRes = await fetchWithRetry(
    'https://seller-analytics-api.wildberries.ru/api/v1/warehouse_remains?groupByNm=true',
    { method: 'GET', headers: { Authorization: wbToken() } },
    { maxRetries: 2, timeoutMs: 30_000 },
  );
  if (!createRes.ok) {
    const txt = await createRes.text().catch(() => '');
    throw new Error(`wb warehouse_remains (create) → ${createRes.status} ${txt.slice(0, 200)}`);
  }
  const created: any = await createRes.json();
  const taskId = created?.data?.taskId;
  if (!taskId) throw new Error(`wb warehouse_remains (create) → нет taskId в ответе: ${JSON.stringify(created).slice(0, 200)}`);

  const deadline = Date.now() + 90_000;
  let ready = false;
  while (Date.now() < deadline) {
    await sleep(3_000);
    const statusRes = await fetchWithRetry(
      `https://seller-analytics-api.wildberries.ru/api/v1/warehouse_remains/tasks/${taskId}/status`,
      { method: 'GET', headers: { Authorization: wbToken() } },
      { maxRetries: 2, timeoutMs: 20_000 },
    );
    if (!statusRes.ok) {
      const txt = await statusRes.text().catch(() => '');
      throw new Error(`wb warehouse_remains (status) → ${statusRes.status} ${txt.slice(0, 200)}`);
    }
    const st: any = await statusRes.json();
    const status = st?.data?.status;
    if (status === 'done') { ready = true; break; }
    if (status === 'purged' || status === 'canceled') {
      throw new Error(`wb warehouse_remains (status) → задача завершилась со статусом "${status}"`);
    }
    // status === 'new' | 'processing' — ждём дальше
  }
  if (!ready) throw new Error('wb warehouse_remains (status) → превышен таймаут ожидания отчёта (90с)');

  const downloadRes = await fetchWithRetry(
    `https://seller-analytics-api.wildberries.ru/api/v1/warehouse_remains/tasks/${taskId}/download`,
    { method: 'GET', headers: { Authorization: wbToken() } },
    { maxRetries: 2, timeoutMs: 30_000 },
  );
  if (!downloadRes.ok) {
    const txt = await downloadRes.text().catch(() => '');
    throw new Error(`wb warehouse_remains (download) → ${downloadRes.status} ${txt.slice(0, 200)}`);
  }
  const rows: any[] = await downloadRes.json();
  const byNm: Record<string, number> = {};
  const TRANSIT_NAMES = new Set(['В пути до получателей', 'В пути возврата на склад WB']);
  const TOTAL_NAME = 'Всего находится на складах';
  for (const r of Array.isArray(rows) ? rows : []) {
    const nm = String(r?.nmId ?? '');
    if (!nm) continue;
    const warehouses: any[] = Array.isArray(r?.warehouses) ? r.warehouses : [];
    const totalRow = warehouses.find((w) => w?.warehouseName === TOTAL_NAME);
    const qty = totalRow
      ? Number(totalRow.quantity) || 0
      : warehouses
          .filter((w) => !TRANSIT_NAMES.has(w?.warehouseName))
          .reduce((sum, w) => sum + (Number(w?.quantity) || 0), 0);
    byNm[nm] = (byNm[nm] || 0) + qty;
  }
  // FBS: товары со склада продавца в отчёт warehouse_remains не попадают (или стоят там с 0),
  // хотя реально продаются (кейс DUDU-C3-8-128, 17.09.2026). Берём остатки по складам продавца
  // через marketplace-api v3: /warehouses → /stocks/{warehouseId} по баркодам из карточек.
  let fbs: Record<string, number> = {};
  let fbsError: string | undefined;
  try { fbs = await computeFbs(); } catch (e: any) { fbsError = String(e?.message ?? e).slice(0, 200); }
  const combined: Record<string, number> = { ...byNm };
  for (const [nm, a] of Object.entries(fbs)) combined[nm] = (combined[nm] || 0) + a;
  return { byNm: combined, fboByNm: byNm, fbsByNm: fbs, fbsError, fetchedAt: Date.now() };
}

async function computeFbs(): Promise<Record<string, number>> {
  const H = { Authorization: wbToken(), 'Content-Type': 'application/json' };
  const whRes = await fetch('https://marketplace-api.wildberries.ru/api/v3/warehouses', { headers: H });
  if (!whRes.ok) throw new Error(`wb v3/warehouses → ${whRes.status} ${(await whRes.text()).slice(0, 200)}`);
  const whs: any[] = await whRes.json();
  const { cards } = await fetchAllWbCards({ base: 'https://content-api.wildberries.ru', headers: { Authorization: wbToken() } });
  const skuToNm = new Map<string, string>();
  for (const c of cards) for (const sz of c?.sizes ?? []) for (const sku of sz?.skus ?? []) skuToNm.set(String(sku), String(c.nmID));
  const skus = [...skuToNm.keys()];
  const fbs: Record<string, number> = {};
  if (!skus.length) return fbs;
  for (const w of Array.isArray(whs) ? whs : []) {
    for (let i = 0; i < skus.length; i += 1000) {
      const chunk = skus.slice(i, i + 1000);
      let res: Response | null = null;
      for (let attempt = 0; attempt < 4; attempt++) {
        res = await fetch(`https://marketplace-api.wildberries.ru/api/v3/stocks/${w.id}`, { method: 'POST', headers: H, body: JSON.stringify({ skus: chunk }) });
        if (res.status !== 429) break;
        const ra = Number(res.headers.get('x-ratelimit-retry') || res.headers.get('retry-after') || 0);
        await sleep(Math.max(2000, Math.min(30_000, ra * 1000)));
      }
      if (!res || !res.ok) continue; // один склад не ответил — остальные всё равно считаем
      const j: any = await res.json().catch(() => null);
      for (const st of j?.stocks ?? []) {
        const nm = skuToNm.get(String(st?.sku)); if (!nm) continue;
        const a = Number(st?.amount) || 0;
        if (a > (fbs[nm] ?? 0)) fbs[nm] = a;
      }
      await sleep(400);
    }
  }
  return fbs;
}

export async function getWbStock(noCache = false): Promise<WbStock> {
  const cached = await cacheGet<WbStock>(CACHE_KEY);
  if (!noCache && isFresh(cached)) return cached!.data;
  try {
    const fresh = await compute();
    await cacheSet(CACHE_KEY, fresh, TTL_MS);
    return fresh;
  } catch (e) {
    if (cached?.data) return cached.data;
    throw e;
  }
}
