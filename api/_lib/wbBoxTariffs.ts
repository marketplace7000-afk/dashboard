// Тарифы логистики/хранения WB (FBW) — живьём из tariffs/box вместо дефолтов.
//   GET https://common-api.wildberries.ru/api/v1/tariffs/box?date=YYYY-MM-DD
//   → warehouseList[]: boxDeliveryBase (₽ за первый литр), boxDeliveryLiter (₽ за
//     каждый доп. литр), boxDeliveryCoefExpr (коэффициент склада, %),
//     boxStorageBase / boxStorageLiter (₽/литр/сутки).
// Значения — СТРОКИ с запятой ("0,07") → парсим в число.
//
// ВАЖНО: boxDeliveryBase УЖЕ включает коэффициент склада (у склада 150% база
// приходит 69 = 46×1.5), поэтому coef отдельно НЕ умножаем. Берём БАЗОВУЮ ставку
// (минимальную по складам = склад с коэф 100%, 46 ₽ + 14 ₽/л) — как в калькуляторе
// клиента. Литраж товара фронт считает из габаритов карточки. Кэш 24ч.

import { fetchWithRetry } from './fetchRetry';
import { cacheGet, cacheSet, isFresh } from './cache';

const CACHE_KEY = 'wb-box-tariffs:v1';
const TTL_MS = 24 * 60 * 60_000;

export type WbBoxTariffs = {
  deliveryBase: number;   // ₽ за первый литр
  deliveryLiter: number;  // ₽ за каждый доп. литр
  deliveryCoef: number;   // коэффициент склада, % (обычно 100)
  storageBase: number;    // ₽/литр/сутки (первый литр)
  storageLiter: number;   // ₽/литр/сутки (доп.)
  fetchedAt: number;
};

function wbToken(): string {
  return (process.env.WB_TOKEN_COMMON || process.env.WB_TOKEN || '').trim();
}

const numRu = (v: any): number => { const n = parseFloat(String(v ?? '').replace(',', '.')); return isNaN(n) ? 0 : n; };

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

async function compute(): Promise<WbBoxTariffs> {
  const res = await fetchWithRetry(
    `https://common-api.wildberries.ru/api/v1/tariffs/box?date=${todayStr()}`,
    { method: 'GET', headers: { Authorization: wbToken() } },
    { maxRetries: 2, timeoutMs: 30_000 },
  );
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`wb tariffs/box → ${res.status} ${txt.slice(0, 200)}`);
  }
  const data = await res.json();
  const wl: any[] = data?.response?.data?.warehouseList ?? data?.data?.warehouseList ?? data?.warehouseList ?? [];
  // Стандартный склад с коэффициентом 100% (как в калькуляторе клиента, 46+14).
  // Если такого нет — берём с минимальным коэффициентом.
  const withCoef = wl.map(w => ({ coef: numRu(w.boxDeliveryCoefExpr), w }))
    .filter(x => x.coef > 0)
    .sort((a, b) => Math.abs(a.coef - 100) - Math.abs(b.coef - 100));
  const std = withCoef[0]?.w ?? wl[0] ?? {};
  return {
    deliveryBase: numRu(std.boxDeliveryBase) || 46,
    deliveryLiter: numRu(std.boxDeliveryLiter) || 14,
    deliveryCoef: numRu(std.boxDeliveryCoefExpr) || 100,
    storageBase: numRu(std.boxStorageBase) || 0.07,
    storageLiter: numRu(std.boxStorageLiter) || 0.07,
    fetchedAt: Date.now(),
  };
}

export async function getWbBoxTariffs(noCache = false): Promise<WbBoxTariffs> {
  const cached = await cacheGet<WbBoxTariffs>(CACHE_KEY);
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
