/**
 * Журнал движений «Склада» — единственный источник остатков.
 *
 * Остаток товара на складе = Σ sign × qty по всем движениям этого склада
 * (как формула M в таблице: приёмка минус отгрузки), только без закрытого
 * списка колонок: новый склад, площадка или вид расхода не требуют формул.
 *
 * Правила (из Sklad/baloo-cc/CLAUDE.md §6, проверены на практике):
 *   • продажа FBS списывается в момент заказа; отмена до передачи — сторно;
 *   • возврат приходуется, только когда посылка реально вернулась на склад;
 *   • ошибки не удаляются, а сторнируются — история видна целиком;
 *   • перемещение: отправитель списывает (товар «в пути»), получатель
 *     принимает фактическое количество — расхождение видно сразу.
 */
import { getSkladDb } from './db';
import { audit } from './audit';
import type { AuthUser } from './users';

export type MovementKind =
  | 'purchase' | 'arrival' | 'transfer_in' | 'return_wb' | 'return_ozon' | 'buyout_return' | 'opening' | 'other_in' | 'inventory_plus'
  | 'sale_wb' | 'sale_ozon' | 'sale_ym' | 'sale_ykit' | 'fbo_wb' | 'fbo_ozon' | 'transfer_out' | 'writeoff' | 'other_out' | 'inventory_minus'
  | 'storno';

export const KIND_INFO: Record<MovementKind, { label: string; sign: 1 | -1 | 0; manual: boolean }> = {
  purchase:        { label: 'Закупка (партия с ценой)', sign: 1, manual: true },
  arrival:         { label: 'Поступление без цены', sign: 1, manual: false },
  transfer_in:     { label: 'Приёмка перемещения', sign: 1, manual: false },
  return_wb:       { label: 'Возврат WB', sign: 1, manual: true },
  return_ozon:     { label: 'Возврат Ozon', sign: 1, manual: true },
  buyout_return:   { label: 'Забор выкупов', sign: 1, manual: true },
  opening:         { label: 'Входящий остаток', sign: 1, manual: false },
  other_in:        { label: 'Прочее поступление', sign: 1, manual: true },
  inventory_plus:  { label: 'Инвентаризация: излишек', sign: 1, manual: false },
  sale_wb:         { label: 'Продажа WB (FBS)', sign: -1, manual: false },
  sale_ozon:       { label: 'Продажа Ozon (FBS)', sign: -1, manual: false },
  sale_ym:         { label: 'Продажа Яндекс Маркет', sign: -1, manual: true },
  sale_ykit:       { label: 'Продажа Я.Kit', sign: -1, manual: true },
  fbo_wb:          { label: 'Поставка FBO на WB', sign: -1, manual: true },
  fbo_ozon:        { label: 'Поставка FBO на Ozon', sign: -1, manual: true },
  transfer_out:    { label: 'Перемещение на другой склад', sign: -1, manual: false },
  writeoff:        { label: 'Списание (брак, недостача, образцы)', sign: -1, manual: true },
  other_out:       { label: 'Прочий расход', sign: -1, manual: false },
  inventory_minus: { label: 'Инвентаризация: недостача', sign: -1, manual: false },
  storno:          { label: 'Сторно (исправление ошибки)', sign: 0, manual: false },
};

/** Кто может проводить вид движения руками. Склад — без цен и закупок. */
export function canPostKind(user: AuthUser, kind: MovementKind): boolean {
  if (!KIND_INFO[kind]?.manual) return false;
  if (user.role === 'warehouse') return kind !== 'purchase';
  return true;
}

export function canAccessWarehouse(user: AuthUser, whId: number): boolean {
  return !user.warehouseIds || user.warehouseIds.includes(whId);
}

export type LineInput = { productId: number; qty: number; price?: number | null };

export type Movement = {
  id: number; ts: number; whId: number; sign: 1 | -1; kind: MovementKind; counterWh: number | null;
  counterpart: string; ref: string; note: string; status: 'done' | 'in_transit' | 'received';
  linkId: number | null; reversed: boolean; source: string; createdName: string; createdAt: number;
  lines: Array<{ productId: number; article: string; name: string; qty: number; price: number | null; barcode: string }>;
};

type NewMovement = {
  ts?: number; whId: number; sign: 1 | -1; kind: MovementKind; counterWh?: number | null; counterpart?: string;
  ref?: string; note?: string; status?: 'done' | 'in_transit' | 'received'; linkId?: number | null; source?: string;
  lines: LineInput[];
};

/** Низкоуровневая запись (без проверок прав) — внутри уже открытой транзакции. */
export function insertMovement(m: NewMovement, by: Pick<AuthUser, 'id' | 'name'>): number {
  const d = getSkladDb();
  const now = Date.now();
  const r = d.prepare(`INSERT INTO movements (ts, wh_id, sign, kind, counter_wh, counterpart, ref, note, status, link_id, source, created_by, created_name, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    m.ts ?? now, m.whId, m.sign, m.kind, m.counterWh ?? null, m.counterpart ?? '', m.ref ?? '', m.note ?? '',
    m.status ?? 'done', m.linkId ?? null, m.source ?? 'manual', by.id, by.name, now);
  const id = Number(r.lastInsertRowid);
  const ins = d.prepare('INSERT INTO movement_lines (movement_id, product_id, qty, price, barcode) VALUES (?, ?, ?, ?, ?)');
  const bc = d.prepare(`SELECT barcode FROM product_barcodes WHERE product_id = ? ORDER BY CASE kind WHEN 'main' THEN 0 ELSE 1 END LIMIT 1`);
  for (const l of m.lines) ins.run(id, l.productId, l.qty, l.price ?? null, (bc.get(l.productId) as any)?.barcode ?? '');
  return id;
}

function cleanLines(lines: unknown): { lines?: LineInput[]; error?: string } {
  if (!Array.isArray(lines) || !lines.length) return { error: 'Добавьте хотя бы один товар' };
  const d = getSkladDb();
  const merged = new Map<number, LineInput>();
  for (const raw of lines as any[]) {
    const productId = Number(raw?.productId);
    const qty = Number(raw?.qty);
    if (!Number.isInteger(productId) || !d.prepare('SELECT 1 FROM products WHERE id = ?').get(productId)) return { error: 'Неизвестный товар' };
    if (!Number.isInteger(qty) || qty <= 0) return { error: 'Количество — целое число больше нуля' };
    const price = raw?.price === undefined || raw?.price === null || raw?.price === '' ? null : Number(String(raw.price).replace(',', '.'));
    if (price !== null && !(price > 0)) return { error: 'Цена — число больше нуля' };
    const prev = merged.get(productId);
    if (prev) prev.qty += qty; else merged.set(productId, { productId, qty, price });
  }
  return { lines: [...merged.values()] };
}

/**
 * Ручное движение: приход, продажа Яндекс, поставка FBO, списание.
 * Расход больше остатка не пропускаем — это почти всегда ошибка ввода.
 */
export function postMovement(input: any, by: AuthUser): { movement?: Movement; error?: string } {
  const kind = input?.kind as MovementKind;
  const whId = Number(input?.whId);
  if (!KIND_INFO[kind]) return { error: 'Неизвестный вид движения' };
  if (!canPostKind(by, kind)) return { error: 'Этот вид движения вам недоступен' };
  if (!getSkladDb().prepare('SELECT 1 FROM warehouses WHERE id = ?').get(whId)) return { error: 'Выберите склад' };
  if (!canAccessWarehouse(by, whId)) return { error: 'Нет доступа к этому складу' };
  const c = cleanLines(input?.lines);
  if (c.error) return { error: c.error };
  const sign = KIND_INFO[kind].sign as 1 | -1;
  if (kind === 'purchase' && c.lines!.some(l => !l.price)) return { error: 'У закупки нужна цена за единицу — из неё считается себестоимость' };
  if (kind !== 'purchase') c.lines!.forEach(l => { l.price = null; });
  if (kind === 'writeoff' && !String(input?.note ?? '').trim()) return { error: 'Укажите причину списания' };
  const d = getSkladDb();
  d.exec('BEGIN IMMEDIATE');
  try {
    if (sign < 0) {
      const short = shortages(whId, c.lines!);
      if (short.length) { d.exec('ROLLBACK'); return { error: `Не хватает остатка: ${short.join(', ')}` }; }
    }
    const id = insertMovement({ whId, sign, kind, counterpart: String(input?.counterpart ?? ''), ref: String(input?.ref ?? '').trim(),
      note: String(input?.note ?? '').trim(), ts: input?.ts ? Number(input.ts) : undefined, lines: c.lines! }, by);
    audit(by, 'movement', id, 'create', { kind: [null, kind], lines: [null, c.lines!.length] });
    d.exec('COMMIT');
    return { movement: getMovement(id)! };
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
}

function shortages(whId: number, lines: LineInput[]): string[] {
  const d = getSkladDb();
  const out: string[] = [];
  for (const l of lines) {
    const have = stockOf(whId, l.productId);
    if (have < l.qty) {
      const art = (d.prepare('SELECT article FROM products WHERE id = ?').get(l.productId) as any)?.article;
      out.push(`${art} (есть ${have}, нужно ${l.qty})`);
    }
  }
  return out;
}

export function stockOf(whId: number, productId: number): number {
  const r = getSkladDb().prepare(`SELECT COALESCE(SUM(m.sign * l.qty), 0) AS q FROM movement_lines l JOIN movements m ON m.id = l.movement_id
    WHERE m.wh_id = ? AND l.product_id = ?`).get(whId, productId) as any;
  return Number(r?.q ?? 0);
}

// ─── Перемещения ───────────────────────────────────────────────────────────
/** Отправить на другой склад: списание у отправителя, товар «в пути». */
export function sendTransfer(input: any, by: AuthUser): { movement?: Movement; error?: string } {
  const fromWh = Number(input?.whId);
  const toWh = Number(input?.toWhId);
  const d = getSkladDb();
  if (!d.prepare('SELECT 1 FROM warehouses WHERE id = ?').get(fromWh) || !d.prepare('SELECT 1 FROM warehouses WHERE id = ?').get(toWh)) return { error: 'Выберите оба склада' };
  if (fromWh === toWh) return { error: 'Склад отправителя и получателя совпадают' };
  if (!canAccessWarehouse(by, fromWh)) return { error: 'Нет доступа к складу-отправителю' };
  const c = cleanLines(input?.lines);
  if (c.error) return { error: c.error };
  c.lines!.forEach(l => { l.price = null; });
  d.exec('BEGIN IMMEDIATE');
  try {
    const short = shortages(fromWh, c.lines!);
    if (short.length) { d.exec('ROLLBACK'); return { error: `Не хватает остатка: ${short.join(', ')}` }; }
    const toName = (d.prepare('SELECT name FROM warehouses WHERE id = ?').get(toWh) as any).name;
    const id = insertMovement({ whId: fromWh, sign: -1, kind: 'transfer_out', counterWh: toWh, counterpart: toName, status: 'in_transit',
      ref: String(input?.ref ?? '').trim(), note: String(input?.note ?? '').trim(), lines: c.lines! }, by);
    audit(by, 'movement', id, 'transfer-send', { to: [null, toName] });
    d.exec('COMMIT');
    return { movement: getMovement(id)! };
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
}

/**
 * Принять перемещение: приход на получателе по факту. Если пришло меньше —
 * разница остаётся видна в журнале (отправлено N, принято M), а не теряется.
 */
export function receiveTransfer(outId: number, input: any, by: AuthUser): { movement?: Movement; error?: string } {
  const d = getSkladDb();
  const out = getMovement(outId);
  if (!out || out.kind !== 'transfer_out') return { error: 'Перемещение не найдено' };
  if (out.status !== 'in_transit') return { error: 'Это перемещение уже принято' };
  if (out.reversed) return { error: 'Перемещение отменено' };
  if (!canAccessWarehouse(by, out.counterWh!)) return { error: 'Нет доступа к складу-получателю' };
  // По умолчанию принимаем ровно отправленное; можно передать факт по строкам.
  const fact = new Map<number, number>(out.lines.map(l => [l.productId, l.qty]));
  if (Array.isArray(input?.lines)) {
    for (const l of input.lines) {
      const q = Number(l?.qty);
      if (!fact.has(Number(l?.productId))) continue;
      if (!Number.isInteger(q) || q < 0) return { error: 'Принятое количество — целое число не меньше нуля' };
      fact.set(Number(l.productId), q);
    }
  }
  const lines = [...fact.entries()].filter(([, q]) => q > 0).map(([productId, qty]) => ({ productId, qty }));
  const sent = out.lines.reduce((s, l) => s + l.qty, 0);
  const got = lines.reduce((s, l) => s + l.qty, 0);
  const fromName = (d.prepare('SELECT name FROM warehouses WHERE id = ?').get(out.whId) as any).name;
  d.exec('BEGIN IMMEDIATE');
  try {
    let id: number | null = null;
    if (lines.length) {
      id = insertMovement({ whId: out.counterWh!, sign: 1, kind: 'transfer_in', counterWh: out.whId, counterpart: fromName, linkId: out.id,
        ref: out.ref, note: [String(input?.note ?? '').trim(), got !== sent ? `Отправлено ${sent}, принято ${got}` : ''].filter(Boolean).join('. '), lines }, by);
    }
    d.prepare(`UPDATE movements SET status = 'received' WHERE id = ?`).run(out.id);
    audit(by, 'movement', out.id, 'transfer-receive', { sent: [null, sent], received: [null, got] });
    d.exec('COMMIT');
    return { movement: id ? getMovement(id)! : getMovement(out.id)! };
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
}

// ─── Сторно ────────────────────────────────────────────────────────────────
/** Отменить движение обратным. Перемещение в пути отменяется целиком (товар возвращается отправителю). */
export function reverseMovement(id: number, reason: string, by: AuthUser): { movement?: Movement; error?: string } {
  if (by.role === 'warehouse' || by.role === 'buyer') return { error: 'Исправлять проведённые движения может владелец или менеджер' };
  if (!reason.trim()) return { error: 'Укажите причину исправления' };
  const m = getMovement(id);
  if (!m) return { error: 'Движение не найдено' };
  if (m.reversed) return { error: 'Движение уже исправлено' };
  if (m.kind === 'storno') return { error: 'Сторно не исправляется — проведите движение заново' };
  if (m.kind === 'transfer_out' && m.status === 'received') return { error: 'Перемещение уже принято получателем — исправьте сначала приёмку' };
  const d = getSkladDb();
  d.exec('BEGIN IMMEDIATE');
  try {
    const sid = insertMovement({ whId: m.whId, sign: (m.sign * -1) as 1 | -1, kind: 'storno', counterWh: m.counterWh, counterpart: m.counterpart,
      ref: m.ref, note: `Исправление движения №${m.id} (${KIND_INFO[m.kind].label}): ${reason.trim()}`, linkId: m.id,
      lines: m.lines.map(l => ({ productId: l.productId, qty: l.qty, price: null })) }, by);
    d.prepare('UPDATE movements SET reversed = 1 WHERE id = ?').run(m.id);
    // Отменили приёмку перемещения — расход отправителя снова «в пути».
    if (m.kind === 'transfer_in' && m.linkId) d.prepare(`UPDATE movements SET status = 'in_transit' WHERE id = ?`).run(m.linkId);
    audit(by, 'movement', m.id, 'reverse', { reason: [null, reason.trim()], storno: [null, sid] });
    d.exec('COMMIT');
    return { movement: getMovement(sid)! };
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
}

// ─── Чтение ────────────────────────────────────────────────────────────────
function mapMovements(rows: any[], showMoney: boolean): Movement[] {
  if (!rows.length) return [];
  const d = getSkladDb();
  const ids = rows.map(r => r.id);
  const lines = d.prepare(`SELECT l.*, p.article, p.name FROM movement_lines l JOIN products p ON p.id = l.product_id
    WHERE l.movement_id IN (${ids.map(() => '?').join(',')}) ORDER BY l.id`).all(...ids) as any[];
  const byMov = new Map<number, any[]>();
  for (const l of lines) (byMov.get(l.movement_id) ?? byMov.set(l.movement_id, []).get(l.movement_id)!).push(l);
  return rows.map(r => ({
    id: r.id, ts: r.ts, whId: r.wh_id, sign: r.sign, kind: r.kind, counterWh: r.counter_wh, counterpart: r.counterpart,
    ref: r.ref, note: r.note, status: r.status, linkId: r.link_id, reversed: !!r.reversed, source: r.source,
    createdName: r.created_name, createdAt: r.created_at,
    lines: (byMov.get(r.id) ?? []).map(l => ({ productId: l.product_id, article: l.article, name: l.name, qty: l.qty,
      price: showMoney ? l.price : null, barcode: l.barcode })),
  }));
}

export function getMovement(id: number, showMoney = true): Movement | null {
  const r = getSkladDb().prepare('SELECT * FROM movements WHERE id = ?').get(id);
  return r ? mapMovements([r], showMoney)[0] : null;
}

export type MovementFilter = {
  whIds?: number[] | null; whId?: number; productId?: number; kind?: string; from?: number; to?: number;
  q?: string; inTransit?: boolean; limit?: number; offset?: number;
};

export function listMovements(f: MovementFilter, showMoney: boolean): { items: Movement[]; total: number } {
  const where: string[] = [];
  const args: unknown[] = [];
  if (f.whIds) {
    // Сотрудник склада видит свои движения и перемещения, идущие к нему.
    const ph = f.whIds.map(() => '?').join(',') || 'NULL';
    where.push(`(m.wh_id IN (${ph}) OR (m.kind = 'transfer_out' AND m.counter_wh IN (${ph})))`);
    args.push(...f.whIds, ...f.whIds);
  }
  if (f.whId) { where.push('(m.wh_id = ? OR (m.kind = \'transfer_out\' AND m.status = \'in_transit\' AND m.counter_wh = ?))'); args.push(f.whId, f.whId); }
  if (f.kind) { where.push('m.kind = ?'); args.push(f.kind); }
  if (f.from) { where.push('m.ts >= ?'); args.push(f.from); }
  if (f.to) { where.push('m.ts < ?'); args.push(f.to); }
  if (f.inTransit) where.push(`m.kind = 'transfer_out' AND m.status = 'in_transit' AND m.reversed = 0`);
  if (f.productId) { where.push('EXISTS (SELECT 1 FROM movement_lines l WHERE l.movement_id = m.id AND l.product_id = ?)'); args.push(f.productId); }
  if (f.q) {
    where.push(`(m.ref LIKE ? OR m.note LIKE ? OR EXISTS (SELECT 1 FROM movement_lines l JOIN products p ON p.id = l.product_id
      WHERE l.movement_id = m.id AND (p.article LIKE ? OR l.barcode = ?)))`);
    const like = `%${f.q}%`;
    args.push(like, like, like, f.q.replace(/\D+/g, ''));
  }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const d = getSkladDb();
  const total = Number((d.prepare(`SELECT COUNT(*) AS n FROM movements m ${w}`).get(...args) as any).n);
  const limit = Math.min(Math.max(f.limit ?? 100, 1), 500);
  const rows = d.prepare(`SELECT m.* FROM movements m ${w} ORDER BY m.ts DESC, m.id DESC LIMIT ${limit} OFFSET ${Math.max(f.offset ?? 0, 0)}`).all(...args) as any[];
  return { items: mapMovements(rows, showMoney), total };
}

export type StockRow = { productId: number; whId: number; qty: number };
export type InTransitRow = { productId: number; toWhId: number; qty: number };

/** Остатки по всем складам и товарам (только ненулевые) + что едет на склад. */
export function stockSnapshot(whIds: number[] | null): { stock: StockRow[]; inTransit: InTransitRow[] } {
  const d = getSkladDb();
  const filt = whIds ? `AND m.wh_id IN (${whIds.map(() => '?').join(',') || 'NULL'})` : '';
  const stock = (d.prepare(`SELECT l.product_id AS productId, m.wh_id AS whId, SUM(m.sign * l.qty) AS qty
    FROM movement_lines l JOIN movements m ON m.id = l.movement_id WHERE 1=1 ${filt}
    GROUP BY l.product_id, m.wh_id HAVING SUM(m.sign * l.qty) <> 0`).all(...(whIds ?? [])) as any[])
    .map(r => ({ productId: r.productId, whId: r.whId, qty: Number(r.qty) }));
  const filtT = whIds ? `AND m.counter_wh IN (${whIds.map(() => '?').join(',') || 'NULL'})` : '';
  const inTransit = (d.prepare(`SELECT l.product_id AS productId, m.counter_wh AS toWhId, SUM(l.qty) AS qty
    FROM movement_lines l JOIN movements m ON m.id = l.movement_id
    WHERE m.kind = 'transfer_out' AND m.status = 'in_transit' AND m.reversed = 0 ${filtT}
    GROUP BY l.product_id, m.counter_wh`).all(...(whIds ?? [])) as any[])
    .map(r => ({ productId: r.productId, toWhId: r.toWhId, qty: Number(r.qty) }));
  return { stock, inTransit };
}
