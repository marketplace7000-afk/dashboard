/**
 * Заказы FBS с площадок — реестр и правила списания (этап 3).
 *
 * Строка реестра = заказ × товар: WB-заказ всегда одна единица одного товара,
 * отправление Ozon может содержать несколько товаров и делиться на части.
 *
 * Состояния (как в FBS.gs Apps Script, проверено на практике в сентябре–октябре):
 *   open             — ещё не собран (лежит на полке как товар);
 *   assembled        — собран, не передан курьеру (лежит упаковкой);
 *   shipped          — передан площадке;
 *   cancelled_before — отменён ДО передачи: товар возвращается в остаток;
 *   cancelled_after  — отменён ПОСЛЕ передачи: ждём возврат, приходуется
 *                      «Возвратом», когда посылка реально вернётся;
 *   removed          — товар ушёл из отправления Ozon (деление на части).
 *
 * Два режима:
 *   • теневой (по умолчанию, пока учёт ведёт таблица) — заказы только
 *     записываются и сверяются с «Отгрузкой» таблицы, остатки не меняются;
 *   • боевой (kv orders_live_since, включается при переходе) — каждый заказ,
 *     созданный после этой отметки, списывается движением «Продажа WB/Ozon»
 *     в момент заказа, отмена до передачи — сторно, деление Ozon —
 *     пересписание на новое количество. Заказы до отметки уже есть в
 *     перенесённой истории.
 */
import { getSkladDb, kvGet } from './db';
import { insertMovement } from './movements';
import { normBarcode } from './catalog';

export type OrderMp = 'wb1' | 'wb2' | 'ozon';
export type OrderState = 'open' | 'assembled' | 'shipped' | 'cancelled_before' | 'cancelled_after' | 'removed';

export type NormOrder = {
  mp: OrderMp;
  orderId: string;
  /** Ключ строки внутри заказа: WB — выбранный баркод, Ozon — offer_id. */
  offer: string;
  /** Все баркоды/артикулы, по которым можно найти товар. */
  keys: string[];
  qty: number;
  extWhId: string;
  orderedAt: number;
  rawStatus: string;
  state: OrderState;
  problem?: string;
};

const SYSTEM = { id: null, name: 'Заказы FBS (API)' };

// ─── Состояния ─────────────────────────────────────────────────────────────
const WB_CANCEL_BEFORE = new Set(['canceled', 'canceled_by_client', 'declined_by_client']);

/** WB: supplierStatus (new/confirm/complete/cancel) + wbStatus (waiting/sorted/sold/canceled…). */
export function wbState(supplierStatus: string, wbStatus: string): { state: OrderState; problem?: string } {
  const s = supplierStatus || 'new';
  if (s === 'cancel') return { state: 'cancelled_before' };
  if ((s === 'new' || s === 'confirm') && WB_CANCEL_BEFORE.has(wbStatus)) return { state: 'cancelled_before' };
  if (s === 'new') return { state: 'open' };
  if (s === 'confirm') return { state: 'assembled' };
  // complete = передан; отмена после этого — ждём возврат
  if (WB_CANCEL_BEFORE.has(wbStatus)) return { state: 'cancelled_after', problem: 'Отменён после передачи — ждём возврат' };
  return { state: 'shipped' };
}

const OZON_OPEN = new Set(['awaiting_registration', 'acceptance_in_progress', 'awaiting_approve', 'awaiting_packaging']);

/** Ozon: статус отправления + признак отмены после отгрузки. */
export function ozonState(status: string, cancelledAfterShip: boolean | undefined, deliveringDate: string | null | undefined): { state: OrderState; problem?: string } {
  if (OZON_OPEN.has(status)) return { state: 'open' };
  if (status === 'awaiting_deliver') return { state: 'assembled' };
  if (status === 'cancelled') {
    const after = cancelledAfterShip ?? !!deliveringDate;
    if (!after) return { state: 'cancelled_before' };
    // cancelled_after_ship без даты передачи: собран и отменён, посылка может лежать на ФФ (CLAUDE.md §4.3)
    if (!deliveringDate) return { state: 'cancelled_after', problem: 'Отменён после сборки, курьеру не передан — проверьте, не лежит ли посылка на складе' };
    return { state: 'cancelled_after', problem: 'Отменён после передачи — ждём возврат' };
  }
  return { state: 'shipped' };
}

// ─── Привязка к нашим справочникам ─────────────────────────────────────────
function resolveWarehouse(mp: OrderMp, extWhId: string): { whId: number | null; mode: string | null } {
  if (!extWhId) return { whId: null, mode: null };
  const r = getSkladDb().prepare(`SELECT warehouse_id, mode FROM mp_warehouses WHERE mp = ? AND ext_id = ? AND active = 1`).get(mp, extWhId) as any;
  return r ? { whId: r.warehouse_id, mode: r.mode } : { whId: null, mode: null };
}

function resolveProduct(keys: string[]): number | null {
  const d = getSkladDb();
  for (const k of keys) {
    const code = normBarcode(k);
    if (code.length >= 6 && /^\d+$/.test(k.replace(/\s/g, ''))) {
      const r = d.prepare('SELECT product_id FROM product_barcodes WHERE barcode = ?').get(code) as any;
      if (r) return r.product_id;
    }
    const a = d.prepare('SELECT id FROM products WHERE article = ?').get(String(k).trim()) as any;
    if (a) return a.id;
  }
  return null;
}

/** Выбрать баркод WB-заказа: известный справочнику, иначе первый (как pickOrderBarcode_). */
export function pickBarcode(skus: string[]): string {
  const d = getSkladDb();
  for (const s of skus) if (d.prepare('SELECT 1 FROM product_barcodes WHERE barcode = ?').get(normBarcode(s))) return normBarcode(s);
  return normBarcode(skus[0] ?? '');
}

// ─── Боевой режим ──────────────────────────────────────────────────────────
export function liveSince(): number | null {
  const v = Number(kvGet('orders_live_since'));
  return Number.isFinite(v) && v > 0 ? v : null;
}

const SALE_KIND: Record<OrderMp, 'sale_wb' | 'sale_ozon'> = { wb1: 'sale_wb', wb2: 'sale_wb', ozon: 'sale_ozon' };
const ACTIVE = new Set<OrderState>(['open', 'assembled', 'shipped', 'cancelled_after']);

/** Уже списан в перенесённой истории (строка «Отгрузки» с этим номером)? */
function inHistory(orderId: string, productId: number): boolean {
  return !!getSkladDb().prepare(`SELECT 1 FROM movements m JOIN movement_lines l ON l.movement_id = m.id
    WHERE m.ref = ? AND l.product_id = ? AND m.kind IN ('sale_wb','sale_ozon') AND m.source = 'sheet' AND m.reversed = 0`).get(orderId, productId);
}

function storno(movementId: number, note: string): number {
  const d = getSkladDb();
  const m = d.prepare('SELECT * FROM movements WHERE id = ?').get(movementId) as any;
  const lines = d.prepare('SELECT product_id, qty FROM movement_lines WHERE movement_id = ?').all(movementId) as any[];
  const id = insertMovement({ whId: m.wh_id, sign: (m.sign * -1) as 1 | -1, kind: 'storno', counterpart: m.counterpart, ref: m.ref,
    note: `${note} (движение №${m.id})`, linkId: m.id, source: m.source, lines: lines.map(l => ({ productId: l.product_id, qty: l.qty })) }, SYSTEM);
  d.prepare('UPDATE movements SET reversed = 1 WHERE id = ?').run(movementId);
  return id;
}

/** Привести движения заказа в соответствие с состоянием (только боевой режим). */
function applyLive(row: any): { created?: number; reversed?: number } {
  const since = liveSince();
  if (!since || row.ordered_at < since || !row.product_id || !row.wh_id) return {};
  const d = getSkladDb();
  const out: { created?: number; reversed?: number } = {};
  const mov = row.movement_id ? d.prepare('SELECT m.reversed, l.qty FROM movements m JOIN movement_lines l ON l.movement_id = m.id WHERE m.id = ?').get(row.movement_id) as any : null;
  const live = mov && !mov.reversed;
  if (ACTIVE.has(row.state) && row.qty > 0) {
    if (live && mov.qty !== row.qty) {
      // Ozon поделил отправление — пересписываем на текущее количество.
      d.prepare('UPDATE mp_orders SET storno_id = ? WHERE id = ?').run(storno(row.movement_id, `Ozon изменил количество в отправлении ${row.order_id}: ${mov.qty} → ${row.qty}`), row.id);
      out.reversed = 1;
    } else if (live) return out;
    if (inHistory(row.order_id, row.product_id)) return out;
    const id = insertMovement({ ts: row.ordered_at, whId: row.wh_id, sign: -1, kind: SALE_KIND[row.mp as OrderMp],
      counterpart: row.mp === 'ozon' ? 'Ozon' : row.mp === 'wb2' ? 'WB (кабинет 2)' : 'WB', ref: row.order_id,
      note: 'Заказ FBS', source: row.mp === 'ozon' ? 'ozon' : 'wb', lines: [{ productId: row.product_id, qty: row.qty }] }, SYSTEM);
    d.prepare('UPDATE mp_orders SET movement_id = ? WHERE id = ?').run(id, row.id);
    out.created = 1;
  } else if (live && (row.state === 'cancelled_before' || row.state === 'removed' || row.qty <= 0)) {
    const why = row.state === 'removed' ? `Товар ушёл из отправления ${row.order_id} (деление Ozon)` : `Заказ ${row.order_id} отменён до передачи`;
    d.prepare('UPDATE mp_orders SET storno_id = ? WHERE id = ?').run(storno(row.movement_id, why), row.id);
    out.reversed = 1;
  }
  return out;
}

// ─── Запись в реестр ───────────────────────────────────────────────────────
export type UpsertResult = { added: number; changed: number; created: number; reversed: number; unmapped: number };

/**
 * Записать заказы. ozonPostings — номера отправлений Ozon, прочитанные
 * целиком: товары, которых в них больше нет, помечаются removed.
 */
export function upsertOrders(list: NormOrder[], ozonPostings?: Set<string>): UpsertResult {
  const d = getSkladDb();
  const res: UpsertResult = { added: 0, changed: 0, created: 0, reversed: 0, unmapped: 0 };
  const now = Date.now();
  const sel = d.prepare('SELECT * FROM mp_orders WHERE mp = ? AND order_id = ? AND offer = ?');
  d.exec('BEGIN IMMEDIATE');
  try {
    const seen = new Map<string, Set<string>>(); // posting → offers
    const ignoredWh = new Set((d.prepare('SELECT mp, ext_id FROM mp_wh_ignored').all() as any[]).map(r => `${r.mp}|${r.ext_id}`));
    for (const o of list) {
      // Склад «не учитывать» (самовыкупы) — заказ в реестре для справки, без привязки и без списания.
      const ignored = ignoredWh.has(`${o.mp}|${o.extWhId}`) ? 1 : 0;
      const { whId: wh0 } = resolveWarehouse(o.mp, o.extWhId);
      const whId = ignored ? null : wh0;
      const productId = resolveProduct(o.keys);
      const problems = ignored ? '' : [o.problem, !whId ? `склад площадки ${o.extWhId || '—'} не привязан` : '', !productId ? `товар ${o.offer} не найден в справочнике` : '']
        .filter(Boolean).join('; ');
      if (!ignored && (!whId || !productId)) res.unmapped++;
      if (o.mp === 'ozon') (seen.get(o.orderId) ?? seen.set(o.orderId, new Set()).get(o.orderId)!).add(o.offer);
      const cur = sel.get(o.mp, o.orderId, o.offer) as any;
      if (!cur) {
        d.prepare(`INSERT INTO mp_orders (mp, order_id, offer, product_id, qty, ext_wh_id, wh_id, ordered_at, raw_status, state, problem, ignored, first_seen, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(o.mp, o.orderId, o.offer, productId, o.qty, o.extWhId, whId, o.orderedAt,
          o.rawStatus, o.state, problems, ignored, now, now);
        res.added++;
      } else if (cur.state !== o.state || cur.qty !== o.qty || cur.raw_status !== o.rawStatus || cur.problem !== problems
        || cur.wh_id !== whId || cur.product_id !== productId || cur.ignored !== ignored) {
        d.prepare(`UPDATE mp_orders SET product_id = ?, qty = ?, ext_wh_id = ?, wh_id = ?, raw_status = ?, state = ?, problem = ?, ignored = ?, updated_at = ? WHERE id = ?`)
          .run(productId, o.qty, o.extWhId, whId, o.rawStatus, o.state, problems, ignored, now, cur.id);
        res.changed++;
      }
      const row = sel.get(o.mp, o.orderId, o.offer);
      const a = applyLive(row);
      res.created += a.created ?? 0;
      res.reversed += a.reversed ?? 0;
    }
    // Деление отправлений Ozon: товар, которого в отправлении больше нет.
    if (ozonPostings) {
      for (const pn of ozonPostings) {
        const offers = seen.get(pn) ?? new Set<string>();
        const rows = d.prepare(`SELECT * FROM mp_orders WHERE mp = 'ozon' AND order_id = ? AND state <> 'removed'`).all(pn) as any[];
        for (const r of rows) {
          if (offers.has(r.offer)) continue;
          d.prepare(`UPDATE mp_orders SET state = 'removed', problem = 'товар ушёл в другое отправление (деление Ozon)', updated_at = ? WHERE id = ?`).run(now, r.id);
          res.changed++;
          const a = applyLive({ ...r, state: 'removed' });
          res.reversed += a.reversed ?? 0;
        }
      }
    }
    d.exec('COMMIT');
    return res;
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
}

// ─── Чтение ────────────────────────────────────────────────────────────────
/** Несобранные заказы по товарам склада: уже списаны, но ещё лежат на полке. */
export function pendingOnShelf(whId: number): Map<number, number> {
  const rows = getSkladDb().prepare(`SELECT product_id, SUM(qty) q FROM mp_orders
    WHERE wh_id = ? AND state = 'open' AND product_id IS NOT NULL GROUP BY product_id`).all(whId) as any[];
  return new Map(rows.map(r => [Number(r.product_id), Number(r.q)]));
}

/**
 * Резерв для отправки остатков (этап 4): открытые и собранные заказы,
 * которые ещё НЕ списаны движением (иначе двойное вычитание — ошибка,
 * исправленная в Apps Script 01.10). В теневом режиме — пусто: остаток
 * берётся из перенесённой истории, где заказы уже списаны таблицей.
 */
export function reserveNotWrittenOff(): Map<string, number> {
  const rows = getSkladDb().prepare(`SELECT wh_id, product_id, SUM(qty) q FROM mp_orders
    WHERE state IN ('open','assembled') AND movement_id IS NULL AND wh_id IS NOT NULL AND product_id IS NOT NULL
      AND ordered_at >= COALESCE((SELECT CAST(value AS INTEGER) FROM kv WHERE key = 'orders_live_since'), 9e15)
    GROUP BY wh_id, product_id`).all() as any[];
  return new Map(rows.map(r => [`${r.wh_id}|${r.product_id}`, Number(r.q)]));
}

export type OrderRow = {
  id: number; mp: OrderMp; orderId: string; offer: string; productId: number | null; article: string | null; qty: number;
  extWhId: string; whId: number | null; orderedAt: number; rawStatus: string; state: OrderState; problem: string;
  movementId: number | null; stornoId: number | null; updatedAt: number;
};

// ─── Склады «не учитывать» ─────────────────────────────────────────────────
export function listIgnoredWh(): Array<{ mp: string; extId: string; extName: string; reason: string }> {
  return (getSkladDb().prepare('SELECT * FROM mp_wh_ignored ORDER BY mp, ext_name').all() as any[])
    .map(r => ({ mp: r.mp, extId: r.ext_id, extName: r.ext_name, reason: r.reason }));
}

/** Пометить склад площадки «не учитывать» (или снять пометку) и пересчитать его заказы. */
export function setIgnoredWh(mp: string, extId: string, extName: string, reason: string, ignore: boolean): void {
  const d = getSkladDb();
  if (ignore) d.prepare('INSERT INTO mp_wh_ignored (mp, ext_id, ext_name, reason) VALUES (?, ?, ?, ?) ON CONFLICT(mp, ext_id) DO UPDATE SET ext_name = excluded.ext_name, reason = excluded.reason').run(mp, extId, extName, reason);
  else d.prepare('DELETE FROM mp_wh_ignored WHERE mp = ? AND ext_id = ?').run(mp, extId);
  // Уже записанные заказы этого склада: пометка сразу, привязка — при следующем опросе.
  d.prepare("UPDATE mp_orders SET ignored = ?, problem = CASE WHEN ? = 1 THEN '' ELSE problem END, wh_id = CASE WHEN ? = 1 THEN NULL ELSE wh_id END WHERE mp = ? AND ext_wh_id = ?").run(ignore ? 1 : 0, ignore ? 1 : 0, ignore ? 1 : 0, mp, extId);
}

export function listOrders(f: { whIds?: number[] | null; mp?: string; state?: string; q?: string; problems?: boolean; days?: number; limit?: number; ignored?: boolean }):
  { items: OrderRow[]; total: number; counts: Record<string, number> } {
  const where: string[] = [f.ignored ? 'o.ignored = 1' : 'o.ignored = 0'];
  const args: unknown[] = [];
  if (f.whIds) { where.push(`o.wh_id IN (${f.whIds.map(() => '?').join(',') || 'NULL'})`); args.push(...f.whIds); }
  if (f.mp) { where.push('o.mp = ?'); args.push(f.mp); }
  if (f.days) { where.push('o.ordered_at >= ?'); args.push(Date.now() - f.days * 86400000); }
  const base = [...where];
  const baseArgs = [...args];
  if (f.state) { where.push('o.state = ?'); args.push(f.state); }
  if (f.problems) where.push(`o.problem <> ''`);
  if (f.q) { where.push('(o.order_id LIKE ? OR o.offer LIKE ? OR p.article LIKE ?)'); const l = `%${f.q}%`; args.push(l, l, l); }
  const d = getSkladDb();
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = Number((d.prepare(`SELECT COUNT(*) n FROM mp_orders o LEFT JOIN products p ON p.id = o.product_id ${w}`).get(...args) as any).n);
  const rows = d.prepare(`SELECT o.*, p.article FROM mp_orders o LEFT JOIN products p ON p.id = o.product_id ${w}
    ORDER BY o.ordered_at DESC LIMIT ${Math.min(Math.max(f.limit ?? 200, 1), 1000)}`).all(...args) as any[];
  const counts: Record<string, number> = {};
  for (const r of d.prepare(`SELECT state, COUNT(*) n FROM mp_orders o ${base.length ? 'WHERE ' + base.join(' AND ') : ''} GROUP BY state`).all(...baseArgs) as any[]) counts[r.state] = Number(r.n);
  counts.problems = Number((d.prepare(`SELECT COUNT(*) n FROM mp_orders o ${base.length ? 'WHERE ' + base.join(' AND ') + ' AND' : 'WHERE'} o.problem <> ''`).get(...baseArgs) as any).n);
  return {
    total, counts,
    items: rows.map(r => ({ id: r.id, mp: r.mp, orderId: r.order_id, offer: r.offer, productId: r.product_id, article: r.article, qty: r.qty,
      extWhId: r.ext_wh_id, whId: r.wh_id, orderedAt: r.ordered_at, rawStatus: r.raw_status, state: r.state, problem: r.problem,
      movementId: r.movement_id, stornoId: r.storno_id, updatedAt: r.updated_at })),
  };
}
