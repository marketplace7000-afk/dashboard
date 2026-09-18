// ФАКТИЧЕСКАЯ логистика по артикулам — прямая и обратная — из финансовых
// отчётов площадок, а не из тарифов. Добавлено 16.09.2026 по просьбе клиента:
// «логистику прямую, возвратную и ДРР тянуть из API напрямую и обновлять
// регулярно».
//
// WB: finance-api /api/finance/v1/sales-reports/detailed (period=daily за 30 дн).
//   Строки «Доставка» с bonusTypeName «К клиенту при продаже» — прямая
//   логистика; все остальные строки «Доставка» (при отмене к клиенту и от
//   клиента, при возврате, возврат брака, возврат продавцу) — обратная.
//   Проверено на живом отчёте 16.09.2026: по FBS-товарам число «К клиенту при
//   продаже» совпадает с числом строк «Продажа» один в один.
// Ozon: v3/finance/transaction/list ОТКЛЮЧЁН (400 «obsolete method cannot be
//   used», проверено 16.09.2026). Замена — v1/finance/accrual/postings: по
//   номерам отправлений (до 200 за запрос) отдаёт начисления с type_id;
//   справочник типов — v1/finance/accrual/types. Отправления берём из
//   v3/posting/fbs/list + v2/posting/fbo/list за 30 дней.
//
// Считаем на единицу: прямая — ₽ за одну доставку; обратная — ₽ на одну
// ПРОДАННУЮ штуку (все затраты на отмены/невыкупы/возвраты, размазанные по
// продажам) — именно так её и надо закладывать в цену. Плюс факт выкупа.

import { fetchWithRetry } from './fetchRetry';
import { cacheGet, cacheSet, isFresh } from './cache';

const CACHE_KEY = 'logistics-fact:v1';
const TTL_MS = 12 * 60 * 60_000; // отчёты обновляются раз в сутки

export type FactWin = {
  units: number;        // продано, шт
  fwdCount: number;     // доставок покупателю (прямых)
  fwdRub: number;       // прямая логистика всего, ₽
  retRub: number;       // обратная логистика всего (отмены+невыкупы+возвраты), ₽
  retUnits: number;     // возвратов после выкупа, шт
  cancels: number;      // отмен/невыкупов, шт
  fwdPerUnit: number | null;    // ₽ за одну доставку
  returnPerSale: number | null; // ₽ обратной логистики на 1 проданную шт
  buyoutPct: number | null;     // факт выкупа, %
};
export type FactItem = { d7: FactWin; d30: FactWin };
export type LogisticsFact = {
  wb: Record<string, FactItem>;   // nmId → факт
  ozon: Record<string, FactItem>; // offer_id (UPPER) → факт
  diagnostics: string[];
  fetchedAt: number;
};

function emptyWin(): FactWin {
  return { units: 0, fwdCount: 0, fwdRub: 0, retRub: 0, retUnits: 0, cancels: 0, fwdPerUnit: null, returnPerSale: null, buyoutPct: null };
}
function finish(w: FactWin, mode: 'wb' | 'ozon' = 'wb'): FactWin {
  w.fwdRub = Math.round(w.fwdRub); w.retRub = Math.round(w.retRub);
  w.fwdPerUnit = w.fwdCount > 0 ? Math.round(w.fwdRub / w.fwdCount) : null;
  w.returnPerSale = w.units > 0 ? Math.round(w.retRub / w.units) : null;
  // WB: доставка при отмене — отдельная строка, попытки = доставки + отмены.
  // Ozon: «Logistic» начисляется и на невыкуп, поэтому попытки = продано + возвраты.
  const attempts = mode === 'wb' ? w.fwdCount + w.cancels : w.units + w.cancels;
  const ok = mode === 'wb' ? w.fwdCount : w.units;
  w.buyoutPct = attempts >= 3 ? Math.round((ok / attempts) * 1000) / 10 : null;
  return w;
}
const dayMs = 86_400_000;
function isoDay(back: number): string { return new Date(Date.now() - back * dayMs).toISOString().slice(0, 10); }

// ─── WB ─────────────────────────────────────────────────────────────────────
async function computeWb(diag: string[]): Promise<Record<string, FactItem>> {
  const out: Record<string, FactItem> = {};
  const token = process.env.WB_TOKEN ?? '';
  if (token === '') { diag.push('WB: нет WB_TOKEN'); return out; }
  const res = await fetchWithRetry('https://finance-api.wildberries.ru/api/finance/v1/sales-reports/detailed', {
    method: 'POST', headers: { Authorization: token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ dateFrom: isoDay(30), dateTo: isoDay(0), limit: 100000, rrdId: 0, period: 'daily' }),
  }, { maxRetries: 2, timeoutMs: 60_000 });
  if (!res.ok) { diag.push(`WB: финотчёт → ${res.status}`); return out; }
  const rows: any[] = await res.json().catch(() => []);
  if (!Array.isArray(rows) || rows.length === 0) { diag.push('WB: финотчёт пуст'); return out; }
  const since7 = Date.now() - 7 * dayMs;
  for (const x of rows) {
    const nm = String(x?.nmId ?? '');
    if (nm === '' || nm === '0') continue;
    const it = out[nm] ?? (out[nm] = { d7: emptyWin(), d30: emptyWin() });
    const dt = Date.parse(x?.rrDt ?? x?.saleDt ?? '') || 0;
    const wins = dt >= since7 ? [it.d7, it.d30] : [it.d30];
    const op = String(x?.sellerOperName ?? '');
    const bonus = String(x?.bonusTypeName ?? '');
    const qty = Number(x?.quantity) || 0;
    const ds = Number(x?.deliveryService) || 0;
    for (const w of wins) {
      if (op === 'Продажа') w.units += qty;
      else if (op === 'Возврат') w.retUnits += qty;
      else if (op === 'Доставка') {
        if (bonus.startsWith('К клиенту при продаже')) { w.fwdCount += 1; w.fwdRub += ds; }
        else {
          w.retRub += ds;
          if (bonus.startsWith('К клиенту при отмене')) w.cancels += 1;
        }
      }
    }
  }
  for (const it of Object.values(out)) { finish(it.d7); finish(it.d30); }
  return out;
}

// ─── Ozon ───────────────────────────────────────────────────────────────────
function ozHeaders(): Record<string, string> {
  return { 'Client-Id': process.env.OZON_CLIENT_ID ?? '', 'Api-Key': process.env.OZON_API_KEY ?? '', 'Content-Type': 'application/json' };
}
async function ozPost(path: string, body: unknown): Promise<any> {
  const res = await fetchWithRetry(`https://api-seller.ozon.ru/${path}`, {
    method: 'POST', headers: ozHeaders(), body: JSON.stringify(body),
  }, { maxRetries: 2, timeoutMs: 40_000 });
  if (!res.ok) throw new Error(`ozon ${path} → ${res.status} ${(await res.text().catch(() => '')).slice(0, 160)}`);
  return res.json();
}

// Типы начислений по имени из справочника. Список снят с живого
// v1/finance/accrual/types 16.09.2026 (124 типа).
const OZ_FWD = new Set(['Logistic', 'LastMile', 'LastMileCourier', 'LastMilePickUpPoint', 'Shipment', 'Drop-Off', 'Drop-Off Agent',
  'DeliveryToHandoverPlaceByOzon', 'CourierPickUpByOzon', 'Pick-Up', 'PickUpCourierDelivery', 'PickUpCourierArrangement',
  'CrossDock', 'CrossDockPickUpCourierDelivery', 'B2CLogistics', 'B2CDeliveryToHandoverPlaceByOzon', 'OzonGlobalLogisticsDelivery',
  'InternationalLogisticDelta', 'RfbsDomesticDelivery']);
const OZ_RET = new Set(['BackwardShipment', 'ReturnFlowLogistic', 'Cancellation', 'ClientReturn', 'PartialReturn', 'PreparingToReturn',
  'B2CBackwardLogistics', 'B2CPickUpPointReturnAcceptance', 'ReturnsStorageInTheWarehouse', 'RfbsEasyReturn', 'SellerReturns', 'PickUpPointReturnAcceptance']);

type Posting = { number: string; skuToOffer: Record<string, string> };

async function listPostings(path: string, since: string, to: string): Promise<Posting[]> {
  const out: Posting[] = [];
  let offset = 0;
  for (let page = 0; page < 20; page++) {
    const j = await ozPost(path, { dir: 'ASC', filter: { since, to }, limit: 1000, offset, with: {} });
    const arr: any[] = Array.isArray(j?.result) ? j.result : (j?.result?.postings ?? []);
    for (const p of arr) {
      const num = String(p?.posting_number ?? '');
      if (num === '') continue;
      const m: Record<string, string> = {};
      for (const pr of (p?.products ?? [])) { const sku = String(pr?.sku ?? ''); const off = String(pr?.offer_id ?? '').trim().toUpperCase(); if (sku !== '' && off !== '') m[sku] = off; }
      out.push({ number: num, skuToOffer: m });
    }
    if (arr.length < 1000) break;
    offset += 1000;
  }
  return out;
}

async function computeOzon(diag: string[]): Promise<Record<string, FactItem>> {
  const out: Record<string, FactItem> = {};
  const types = await ozPost('v1/finance/accrual/types', {}).catch(() => null);
  const typeName = new Map<number, string>();
  for (const t of (types?.accrual_types ?? [])) typeName.set(Number(t?.id), String(t?.name ?? ''));
  if (typeName.size === 0) { diag.push('Ozon: справочник типов начислений недоступен'); return out; }

  const since = new Date(Date.now() - 30 * dayMs).toISOString();
  const to = new Date().toISOString();
  const postings: Posting[] = [];
  for (const path of ['v3/posting/fbs/list', 'v2/posting/fbo/list']) {
    try { postings.push(...await listPostings(path, since, to)); }
    catch (e) { diag.push(`Ozon: ${path} — ${String((e as Error)?.message ?? e).slice(0, 120)}`); }
  }
  if (postings.length === 0) { diag.push('Ozon: отправлений за 30 дней не найдено'); return out; }

  const since7 = Date.now() - 7 * dayMs;
  const byNum = new Map(postings.map(p => [p.number, p] as const));
  let unknownTypes = new Map<string, number>();
  for (let i = 0; i < postings.length; i += 200) {
    const chunk = postings.slice(i, i + 200).map(p => p.number);
    let j: any;
    try { j = await ozPost('v1/finance/accrual/postings', { posting_numbers: chunk }); }
    catch (e) { diag.push(`Ozon: accrual/postings — ${String((e as Error)?.message ?? e).slice(0, 120)}`); continue; }
    for (const pa of (j?.posting_accruals ?? [])) {
      const p = byNum.get(String(pa?.posting_number ?? ''));
      if (!p) continue;
      for (const a of (pa?.accruals ?? [])) {
        const sku = String(a?.sku ?? '');
        // У начисления без sku (редко) — относим к первому товару отправления.
        const offer = p.skuToOffer[sku] ?? Object.values(p.skuToOffer)[0];
        if (!offer) continue;
        const it = out[offer] ?? (out[offer] = { d7: emptyWin(), d30: emptyWin() });
        const dt = Date.parse(a?.accrual_date ?? '') || 0;
        const wins = dt >= since7 ? [it.d7, it.d30] : [it.d30];
        const amt = Math.abs(Number(a?.accrued?.amount) || 0);
        const qty = Number(a?.quantity) || 1;
        const name = typeName.get(Number(a?.type_id)) ?? '';
        const sold = name === 'SaleCommission' || (a?.seller_price != null && Number(a?.seller_price?.amount) > 0);
        for (const w of wins) {
          if (sold) w.units += qty;
          if (OZ_FWD.has(name)) { w.fwdRub += amt; if (name === 'Logistic') w.fwdCount += qty; }
          else if (OZ_RET.has(name)) { w.retRub += amt; if (name === 'Cancellation' || name === 'ReturnFlowLogistic') w.cancels += qty; if (name === 'ClientReturn') w.retUnits += qty; }
          else if (!sold && amt > 0) unknownTypes.set(name, (unknownTypes.get(name) ?? 0) + 1);
        }
      }
    }
  }
  for (const it of Object.values(out)) {
    // Если Ozon не выделил «Logistic» отдельной строкой, считаем доставки по продажам.
    for (const w of [it.d7, it.d30]) { if (w.fwdCount === 0 && w.fwdRub > 0) w.fwdCount = w.units; finish(w, 'ozon'); }
  }
  if (unknownTypes.size > 0) diag.push('Ozon: типы вне классификации: ' + [...unknownTypes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k}×${v}`).join(', '));
  return out;
}

// ─── Сборка ─────────────────────────────────────────────────────────────────
async function compute(): Promise<LogisticsFact> {
  const diagnostics: string[] = [];
  const [wb, ozon] = await Promise.all([
    computeWb(diagnostics).catch(e => { diagnostics.push(`WB: ${String((e as Error)?.message ?? e).slice(0, 120)}`); return {}; }),
    computeOzon(diagnostics).catch(e => { diagnostics.push(`Ozon: ${String((e as Error)?.message ?? e).slice(0, 120)}`); return {}; }),
  ]);
  return { wb, ozon, diagnostics, fetchedAt: Date.now() };
}

export async function getLogisticsFact(noCache = false): Promise<LogisticsFact> {
  const cached = await cacheGet<LogisticsFact>(CACHE_KEY);
  if (!noCache && isFresh(cached)) return cached.data;
  try {
    const fresh = await compute();
    // Пустой результат по обеим площадкам не кэшируем надолго — пусть попробует ещё раз.
    const empty = Object.keys(fresh.wb).length === 0 && Object.keys(fresh.ozon).length === 0;
    await cacheSet(CACHE_KEY, fresh, empty ? 10 * 60_000 : TTL_MS);
    return fresh;
  } catch (e) {
    if (cached?.data) return cached.data;
    throw e;
  }
}

/** Из кэша, без похода в площадки (для сборки экономики по артикулу). */
export async function getLogisticsFactCached(): Promise<LogisticsFact | null> {
  const cached = await cacheGet<LogisticsFact>(CACHE_KEY);
  if (!cached?.data) { void getLogisticsFact().catch(() => null); return null; }
  return cached.data;
}
