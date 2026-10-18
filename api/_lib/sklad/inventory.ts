/**
 * Инвентаризация склада.
 *
 * Сотрудник открывает черновик для своего склада, сканирует баркод (или ищет
 * артикул) и вводит, сколько штук на полке. Черновик сохраняется после каждой
 * позиции — считать можно частями, с телефона. «Провести» сравнивает
 * посчитанное с ожидаемым и проводит разницу движениями:
 *   излишек → «Инвентаризация: излишек», недостача → «Инвентаризация: недостача».
 *
 * Ожидается на полке = остаток + несобранные заказы FBS (они уже списаны в
 * момент заказа, но физически ещё лежат). Без этой поправки корректировка
 * задваивала заказы (СПБ AD-CARLINKIT-ULTRA +3 06.10, Краснодар
 * MANIC-STICK-GREY +2 04.10 — см. Sklad/baloo-cc/CLAUDE.md §5–6). Несобранные
 * берутся из реестра заказов FBS (orders.ts, состояние open).
 *
 * Частичная инвентаризация трогает только посчитанные позиции; полная
 * (full_count) ещё и списывает в ноль всё, что на складе числится, но не
 * посчитано.
 */
import { getSkladDb } from './db';
import { audit } from './audit';
import { insertMovement, canAccessWarehouse, stockOf } from './movements';
import { pendingOnShelf } from './orders';
import type { AuthUser } from './users';

/** Несобранные заказы FBS по товару на складе — из реестра заказов (orders.ts); в проверках подменяется. */
export type PendingFn = (whId: number) => Map<number, number>;
let pendingProvider: PendingFn = pendingOnShelf;
export function setPendingProvider(fn: PendingFn): void { pendingProvider = fn; }

export type InventoryView = {
  id: number; whId: number; status: 'draft' | 'done' | 'cancelled'; fullCount: boolean; note: string;
  createdName: string; createdAt: number; doneAt: number | null; doneName: string;
  lines: Array<{ productId: number; article: string; name: string; barcode: string; counted: number;
    stock: number; pending: number; expected: number; diff: number; countedAt: number }>;
  /** Числится на складе, но ещё не посчитано (подсказка для полной). */
  uncounted: Array<{ productId: number; article: string; name: string; barcode: string; stock: number; pending: number; expected: number }>;
};

function row(id: number): any { return getSkladDb().prepare('SELECT * FROM inventories WHERE id = ?').get(id); }

export function getInventory(id: number): InventoryView | null {
  const inv = row(id);
  if (!inv) return null;
  const d = getSkladDb();
  const pending = inv.status === 'draft' ? pendingProvider(inv.wh_id) : new Map<number, number>();
  const bc = (pid: number) => (d.prepare(`SELECT barcode FROM product_barcodes WHERE product_id = ? ORDER BY CASE kind WHEN 'main' THEN 0 ELSE 1 END LIMIT 1`).get(pid) as any)?.barcode ?? '';
  const lines = (d.prepare(`SELECT il.*, p.article, p.name FROM inventory_lines il JOIN products p ON p.id = il.product_id
    WHERE il.inventory_id = ? ORDER BY il.counted_at DESC`).all(id) as any[]).map(l => {
    const stock = inv.status === 'draft' ? stockOf(inv.wh_id, l.product_id) : 0;
    const pend = pending.get(l.product_id) ?? 0;
    const expected = inv.status === 'draft' ? stock + pend : Number(l.expected ?? 0);
    return { productId: l.product_id, article: l.article, name: l.name, barcode: bc(l.product_id), counted: l.counted,
      stock, pending: pend, expected, diff: l.counted - expected, countedAt: l.counted_at };
  });
  const counted = new Set(lines.map(l => l.productId));
  const uncounted = inv.status !== 'draft' ? [] : (d.prepare(`SELECT l.product_id AS pid, p.article, p.name, SUM(m.sign * l.qty) AS q
    FROM movement_lines l JOIN movements m ON m.id = l.movement_id JOIN products p ON p.id = l.product_id
    WHERE m.wh_id = ? GROUP BY l.product_id HAVING SUM(m.sign * l.qty) <> 0 ORDER BY p.article`).all(inv.wh_id) as any[])
    .filter(r => !counted.has(r.pid))
    .map(r => { const pend = pending.get(r.pid) ?? 0; return { productId: r.pid, article: r.article, name: r.name, barcode: bc(r.pid),
      stock: Number(r.q), pending: pend, expected: Number(r.q) + pend }; });
  return {
    id: inv.id, whId: inv.wh_id, status: inv.status, fullCount: !!inv.full_count, note: inv.note, createdName: inv.created_name,
    createdAt: inv.created_at, doneAt: inv.done_at, doneName: inv.done_name, lines, uncounted,
  };
}

export function listInventories(whIds: number[] | null): Array<Omit<InventoryView, 'lines' | 'uncounted'> & { linesCount: number }> {
  const d = getSkladDb();
  const filt = whIds ? `WHERE i.wh_id IN (${whIds.map(() => '?').join(',') || 'NULL'})` : '';
  return (d.prepare(`SELECT i.*, (SELECT COUNT(*) FROM inventory_lines il WHERE il.inventory_id = i.id) AS n
    FROM inventories i ${filt} ORDER BY i.id DESC LIMIT 100`).all(...(whIds ?? [])) as any[]).map(i => ({
    id: i.id, whId: i.wh_id, status: i.status, fullCount: !!i.full_count, note: i.note, createdName: i.created_name,
    createdAt: i.created_at, doneAt: i.done_at, doneName: i.done_name, linesCount: Number(i.n),
  }));
}

export function createInventory(input: any, by: AuthUser): { inventory?: InventoryView; error?: string } {
  const whId = Number(input?.whId);
  const d = getSkladDb();
  if (!d.prepare('SELECT 1 FROM warehouses WHERE id = ?').get(whId)) return { error: 'Выберите склад' };
  if (!canAccessWarehouse(by, whId)) return { error: 'Нет доступа к этому складу' };
  const open = d.prepare(`SELECT id FROM inventories WHERE wh_id = ? AND status = 'draft'`).get(whId) as any;
  if (open) return { inventory: getInventory(open.id)! }; // одна открытая на склад — продолжаем её
  const r = d.prepare(`INSERT INTO inventories (wh_id, full_count, note, created_by, created_name, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(whId, input?.fullCount ? 1 : 0, String(input?.note ?? ''), by.id, by.name, Date.now());
  const id = Number(r.lastInsertRowid);
  audit(by, 'inventory', id, 'create', { whId: [null, whId] });
  return { inventory: getInventory(id)! };
}

function editable(id: number, by: AuthUser): { inv?: any; error?: string } {
  const inv = row(id);
  if (!inv) return { error: 'Инвентаризация не найдена' };
  if (inv.status !== 'draft') return { error: 'Инвентаризация уже закрыта' };
  if (!canAccessWarehouse(by, inv.wh_id)) return { error: 'Нет доступа к этому складу' };
  return { inv };
}

/** Записать посчитанное по товару. add = true — прибавить (каждое сканирование +1). */
export function setCount(id: number, input: any, by: AuthUser): { inventory?: InventoryView; error?: string } {
  const e = editable(id, by);
  if (e.error) return e;
  const productId = Number(input?.productId);
  const qty = Number(input?.qty);
  const d = getSkladDb();
  if (!d.prepare('SELECT 1 FROM products WHERE id = ?').get(productId)) return { error: 'Неизвестный товар' };
  if (input?.remove) {
    d.prepare('DELETE FROM inventory_lines WHERE inventory_id = ? AND product_id = ?').run(id, productId);
    return { inventory: getInventory(id)! };
  }
  if (!Number.isInteger(qty) || qty < 0 || qty > 100000) return { error: 'Количество — целое число от 0' };
  const prev = (d.prepare('SELECT counted FROM inventory_lines WHERE inventory_id = ? AND product_id = ?').get(id, productId) as any)?.counted ?? 0;
  const next = input?.add ? prev + qty : qty;
  d.prepare(`INSERT INTO inventory_lines (inventory_id, product_id, counted, counted_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(inventory_id, product_id) DO UPDATE SET counted = excluded.counted, counted_at = excluded.counted_at`).run(id, productId, next, Date.now());
  return { inventory: getInventory(id)! };
}

export function updateInventory(id: number, input: any, by: AuthUser): { inventory?: InventoryView; error?: string } {
  const e = editable(id, by);
  if (e.error) return e;
  const d = getSkladDb();
  if (input?.fullCount !== undefined) d.prepare('UPDATE inventories SET full_count = ? WHERE id = ?').run(input.fullCount ? 1 : 0, id);
  if (input?.note !== undefined) d.prepare('UPDATE inventories SET note = ? WHERE id = ?').run(String(input.note), id);
  if (input?.cancel) {
    d.prepare(`UPDATE inventories SET status = 'cancelled', done_at = ?, done_name = ? WHERE id = ?`).run(Date.now(), by.name, id);
    audit(by, 'inventory', id, 'cancel', {});
  }
  return { inventory: getInventory(id)! };
}

/** Провести: разница → движения; снимок «ожидалось» сохраняется в строках. */
export function finishInventory(id: number, by: AuthUser): { inventory?: InventoryView; plus?: number; minus?: number; error?: string } {
  const e = editable(id, by);
  if (e.error) return e;
  const view = getInventory(id)!;
  if (!view.lines.length && !(view.fullCount && view.uncounted.length)) return { error: 'Ничего не посчитано' };
  const plus: Array<{ productId: number; qty: number }> = [];
  const minus: Array<{ productId: number; qty: number }> = [];
  for (const l of view.lines) {
    if (l.diff > 0) plus.push({ productId: l.productId, qty: l.diff });
    if (l.diff < 0) minus.push({ productId: l.productId, qty: -l.diff });
  }
  if (view.fullCount) for (const u of view.uncounted) if (u.expected > 0) minus.push({ productId: u.productId, qty: u.expected });
  const d = getSkladDb();
  const ref = `ИНВ-${id}`;
  const note = `Инвентаризация №${id}${view.note ? `: ${view.note}` : ''}`;
  d.exec('BEGIN IMMEDIATE');
  try {
    const now = Date.now();
    const upd = d.prepare('UPDATE inventory_lines SET expected = ? WHERE inventory_id = ? AND product_id = ?');
    for (const l of view.lines) upd.run(l.expected, id, l.productId);
    if (view.fullCount) {
      const ins = d.prepare('INSERT INTO inventory_lines (inventory_id, product_id, counted, expected, counted_at) VALUES (?, ?, 0, ?, ?)');
      for (const u of view.uncounted) ins.run(id, u.productId, u.expected, now);
    }
    if (plus.length) insertMovement({ whId: view.whId, sign: 1, kind: 'inventory_plus', ref, note, source: 'inventory', lines: plus }, by);
    if (minus.length) insertMovement({ whId: view.whId, sign: -1, kind: 'inventory_minus', ref, note, source: 'inventory', lines: minus }, by);
    d.prepare(`UPDATE inventories SET status = 'done', done_at = ?, done_name = ? WHERE id = ?`).run(now, by.name, id);
    audit(by, 'inventory', id, 'done', { plus: [null, plus.reduce((s, x) => s + x.qty, 0)], minus: [null, minus.reduce((s, x) => s + x.qty, 0)] });
    d.exec('COMMIT');
  } catch (err) {
    d.exec('ROLLBACK');
    throw err;
  }
  return { inventory: getInventory(id)!, plus: plus.reduce((s, x) => s + x.qty, 0), minus: minus.reduce((s, x) => s + x.qty, 0) };
}
