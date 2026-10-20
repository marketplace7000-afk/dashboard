/**
 * Опрос заказов FBS на площадках (этап 3) — только чтение API.
 *
 *   каждые 5 минут — новые заказы WB за 48 ч, отправления Ozon за 48 ч,
 *                    статусы WB незакрытых заказов;
 *   раз в час      — статусы WB всех заказов за 30 дней (отмены после
 *                    передачи), отправления Ozon за 30 дней (отмены, деления).
 *
 * Тот же порядок, что у FBS.gs: при сбое площадки прогон не делает выводов
 * («пропуск безопаснее неверных данных») — ошибка пишется в статус, следующий
 * прогон повторяет. Выключить: SKLAD_ORDERS_DISABLED=1.
 */
import { getSkladDb, kvGet, kvSet } from './db';
import { fetchWithRetry } from '../fetchRetry';
import { listOzonFbsPostings } from '../ozonFbsList';
import { upsertOrders, wbState, ozonState, pickBarcode, type NormOrder, type OrderMp, type UpsertResult } from './orders';

const WB = 'https://marketplace-api.wildberries.ru';
const OZON = 'https://api-seller.ozon.ru';
const QUICK_MS = 5 * 60_000;
const FULL_MS = 60 * 60_000;
const QUICK_HOURS = 48;
const FULL_DAYS = 30;

function wbToken(mp: 'wb1' | 'wb2'): string {
  return ((mp === 'wb1' ? process.env.WB_TOKEN : process.env.WB_TOKEN_2) || '').trim();
}

async function getJson(url: string, init: RequestInit, label: string): Promise<any> {
  const res = await fetchWithRetry(url, init, { maxRetries: 3, timeoutMs: 40_000 });
  if (!res.ok) throw new Error(`${label} → ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
  return res.json();
}

// ─── WB ────────────────────────────────────────────────────────────────────
type WbOrder = { id: number; createdAt: string; warehouseId: number; skus?: string[]; article?: string };

async function wbOrdersSince(mp: 'wb1' | 'wb2', fromMs: number): Promise<WbOrder[]> {
  const out: WbOrder[] = [];
  let next = 0;
  for (let page = 0; page < 50; page++) {
    const url = `${WB}/api/v3/orders?limit=1000&next=${next}&dateFrom=${Math.floor(fromMs / 1000)}`;
    const j = await getJson(url, { headers: { Authorization: wbToken(mp) } }, `wb ${mp} orders`);
    const list: WbOrder[] = j?.orders ?? [];
    out.push(...list);
    next = Number(j?.next ?? 0);
    if (!next || list.length < 1000) break;
  }
  return out;
}

async function wbStatuses(mp: 'wb1' | 'wb2', ids: number[]): Promise<Map<number, { supplierStatus: string; wbStatus: string }>> {
  const out = new Map<number, { supplierStatus: string; wbStatus: string }>();
  for (let i = 0; i < ids.length; i += 1000) {
    const j = await getJson(`${WB}/api/v3/orders/status`, {
      method: 'POST', headers: { Authorization: wbToken(mp), 'Content-Type': 'application/json' },
      body: JSON.stringify({ orders: ids.slice(i, i + 1000) }),
    }, `wb ${mp} status`);
    for (const s of (j?.orders ?? [])) out.set(Number(s.id), { supplierStatus: String(s.supplierStatus ?? ''), wbStatus: String(s.wbStatus ?? '') });
  }
  return out;
}

async function pollWb(mp: 'wb1' | 'wb2', full: boolean): Promise<UpsertResult & { fetched: number }> {
  const d = getSkladDb();
  // Полный прогон забирает заказы за 30 дней (предел WB для dateFrom), быстрый — за 48 ч.
  const fresh = await wbOrdersSince(mp, Date.now() - (full ? FULL_DAYS * 86400_000 - 3600_000 : QUICK_HOURS * 3600_000));
  // Статусы: новые + уже известные незакрытые (быстрый прогон) или все за 30 дней (полный).
  const known = d.prepare(`SELECT order_id, ext_wh_id, offer, ordered_at, qty FROM mp_orders WHERE mp = ? AND ordered_at >= ?
    ${full ? `AND state NOT IN ('cancelled_before','cancelled_after')` : `AND state IN ('open','assembled')`}`)
    .all(mp, Date.now() - FULL_DAYS * 86400_000) as any[];
  const byId = new Map<number, { createdAt: number; warehouseId: string; skus: string[] }>();
  for (const o of fresh) byId.set(Number(o.id), { createdAt: Date.parse(o.createdAt), warehouseId: String(o.warehouseId), skus: (o.skus ?? []).map(String) });
  for (const k of known) if (!byId.has(Number(k.order_id))) byId.set(Number(k.order_id), { createdAt: k.ordered_at, warehouseId: k.ext_wh_id, skus: [k.offer] });
  const st = await wbStatuses(mp, [...byId.keys()]);
  const list: NormOrder[] = [];
  for (const [id, o] of byId) {
    const s = st.get(id);
    if (!s) continue; // статус не пришёл — не делаем выводов
    const { state, problem } = wbState(s.supplierStatus, s.wbStatus);
    const offer = pickBarcode(o.skus);
    list.push({ mp, orderId: String(id), offer, keys: [offer, ...o.skus], qty: 1, extWhId: o.warehouseId, orderedAt: o.createdAt,
      rawStatus: `${s.supplierStatus}/${s.wbStatus}`, state, problem });
  }
  return { ...upsertOrders(list), fetched: fresh.length };
}

// ─── Ozon ──────────────────────────────────────────────────────────────────
function ozHeaders(): Record<string, string> {
  return { 'Client-Id': process.env.OZON_CLIENT_ID ?? '', 'Api-Key': process.env.OZON_API_KEY ?? '', 'Content-Type': 'application/json' };
}

async function ozonPostings(fromMs: number): Promise<any[]> {
  const since = new Date(fromMs).toISOString();
  const to = new Date(Date.now() + 86400_000).toISOString();
  const post = (path: string, body: Record<string, unknown>) =>
    getJson(`${OZON}/${path}`, { method: 'POST', headers: ozHeaders(), body: JSON.stringify(body) }, 'ozon fbs/list');
  return listOzonFbsPostings(post, { filter: { since, to }, with: {} }, { pauseMs: 400 });
}

async function pollOzon(full: boolean): Promise<UpsertResult & { fetched: number }> {
  const postings = await ozonPostings(Date.now() - (full ? FULL_DAYS * 86400_000 : QUICK_HOURS * 3600_000));
  const list: NormOrder[] = [];
  const seen = new Set<string>();
  for (const p of postings) {
    const pn = String(p.posting_number ?? '');
    if (!pn) continue;
    seen.add(pn);
    const { state, problem } = ozonState(String(p.status ?? ''), p?.cancellation?.cancelled_after_ship, p?.delivering_date);
    const at = Date.parse(p.in_process_at ?? p.shipment_date ?? '') || Date.now();
    const qtyByOffer = new Map<string, { qty: number; sku: string }>();
    for (const it of (p.products ?? [])) {
      const offer = String(it.offer_id ?? '').trim();
      if (!offer) continue;
      const prev = qtyByOffer.get(offer);
      qtyByOffer.set(offer, { qty: (prev?.qty ?? 0) + Number(it.quantity ?? 0), sku: String(it.sku ?? '') });
    }
    for (const [offer, v] of qtyByOffer) {
      list.push({ mp: 'ozon', orderId: pn, offer, keys: [offer], qty: v.qty, extWhId: String(p?.delivery_method?.warehouse_id ?? ''),
        orderedAt: at, rawStatus: String(p.status ?? ''), state, problem });
    }
  }
  return { ...upsertOrders(list, seen), fetched: postings.length };
}

// ─── Прогон и расписание ───────────────────────────────────────────────────
export type PollStatus = {
  at: number; full: boolean; ms: number;
  results: Record<string, (UpsertResult & { fetched: number }) | { error: string } | { skipped: string }>;
};

const G = globalThis as any; // модуль может загрузиться дважды (ESM server.ts + CJS api/) — замок один на процесс

export async function pollOrders(full: boolean): Promise<PollStatus> {
  if (G.__skladOrdersBusy) throw new Error('Прошлый опрос заказов ещё идёт');
  G.__skladOrdersBusy = true;
  const t0 = Date.now();
  const status: PollStatus = { at: t0, full, ms: 0, results: {} };
  try {
    const jobs: Array<[string, () => Promise<UpsertResult & { fetched: number }>]> = [];
    for (const mp of ['wb1', 'wb2'] as const) {
      if (wbToken(mp)) jobs.push([mp, () => pollWb(mp, full)]);
      else status.results[mp] = { skipped: mp === 'wb2' ? 'нет WB_TOKEN_2 на сервере' : 'нет WB_TOKEN' };
    }
    if (process.env.OZON_CLIENT_ID && process.env.OZON_API_KEY) jobs.push(['ozon', () => pollOzon(full)]);
    else status.results.ozon = { skipped: 'нет ключей Ozon' };
    for (const [mp, job] of jobs) {
      try { status.results[mp] = await job(); }
      catch (e) { status.results[mp] = { error: (e as Error).message.slice(0, 300) }; console.warn(`[sklad-orders] ${mp}:`, (e as Error).message); }
    }
  } finally {
    G.__skladOrdersBusy = false;
  }
  status.ms = Date.now() - t0;
  kvSet(full ? 'orders_last_full' : 'orders_last_quick', JSON.stringify(status));
  return status;
}

export function pollStatus(): { quick: PollStatus | null; full: PollStatus | null; liveSince: number | null; enabled: boolean } {
  const parse = (k: string) => { try { return JSON.parse(kvGet(k) ?? 'null'); } catch { return null; } };
  return { quick: parse('orders_last_quick'), full: parse('orders_last_full'), liveSince: Number(kvGet('orders_live_since')) || null,
    enabled: process.env.SKLAD_ORDERS_DISABLED !== '1' };
}

/** Запуск из server.ts. Первый полный прогон — через минуту после старта. */
export function scheduleOrdersPoller(): void {
  if (process.env.SKLAD_ORDERS_DISABLED === '1') { console.warn('[sklad-orders] опрос выключен (SKLAD_ORDERS_DISABLED=1)'); return; }
  if (G.__skladOrdersScheduled) return;
  G.__skladOrdersScheduled = true;
  let lastFull = 0;
  const tick = async () => {
    const full = Date.now() - lastFull >= FULL_MS;
    try {
      const s = await pollOrders(full);
      if (full) lastFull = Date.now();
      const brief = Object.entries(s.results).map(([k, v]) => `${k}: ${'error' in v ? 'ОШИБКА' : 'skipped' in v ? 'пропуск' : `+${v.added} ~${v.changed}`}`).join(', ');
      console.warn(`[sklad-orders] ${full ? 'полный' : 'быстрый'} прогон ${s.ms} мс — ${brief}`);
    } catch (e) {
      console.warn('[sklad-orders]', (e as Error).message);
    }
  };
  setTimeout(() => { void tick(); }, 60_000);
  setInterval(() => { void tick(); }, QUICK_MS).unref();
}

export type { OrderMp };
