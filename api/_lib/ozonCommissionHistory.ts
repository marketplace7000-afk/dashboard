// История ставок комиссии Ozon по товарам (07.11.2026, просьба владельца:
// «поменяли комиссию — сразу видно в ценах»).
//
// Сама ставка у Ozon и так живая: v5/product/info/prices отдаёт её по каждому
// товару, сборщик обновляет раз в проход (≤ 2 ч). Проверено 07.11: ставка API
// совпадает с удержанной по финотчёту (47 % против 46–47 %). Здесь только
// запоминаем, когда ставка менялась, чтобы экран показал «было → стало».

import { cacheGet, cacheSet } from './cache';
import { mskDate } from './mskDate';
import type { RateStep } from './wbCommissions';

const KEY = 'ozon-commission-history:v1';
const TTL_MS = 400 * 24 * 60 * 60_000;

export type OzonCommissionHistory = Record<string, RateStep[]>; // offer_id (UPPER) → ступеньки

const num = (v: unknown): number | null => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };

/** Дописать изменившиеся ставки и вернуть историю. */
export async function updateOzonCommissionHistory(rows: any[], normSku: (s: unknown) => string): Promise<OzonCommissionHistory> {
  const hist = (await cacheGet<OzonCommissionHistory>(KEY))?.data ?? {};
  const today = mskDate(0);
  let changed = false;
  for (const row of rows) {
    const sku = normSku(row?.offer_id);
    if (!sku) continue;
    const c = row?.commissions ?? {};
    const fbo = num(c.sales_percent_fbo), fbs = num(c.sales_percent_fbs);
    if (fbo == null && fbs == null) continue;
    const steps = hist[sku] ?? (hist[sku] = []);
    const last = steps[steps.length - 1];
    if (last && last.fbo === fbo && last.fbs === fbs) continue;
    if (last && last.since === today) { last.fbo = fbo; last.fbs = fbs; }
    else steps.push({ since: today, fbo, fbs });
    changed = true;
  }
  if (changed) await cacheSet(KEY, hist, TTL_MS);
  return hist;
}
