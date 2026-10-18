/**
 * Сверка реестра заказов сайта с листом «Отгрузка» таблицы (теневой режим).
 *
 * Правило таблицы (CLAUDE.md §4.3): строка в «Отгрузке» на каждый заказ,
 * физически ушедший или уходящий с полки; отменённые до передачи удаляются.
 * Сверка показывает, где сайт и Apps Script видят заказы по-разному —
 * пока расхождений нет, сайту можно доверить списание (этап 4).
 */
import { getSkladDb } from './db';

export type CompareReport = {
  checkedAt: number; days: number; orders: number; matched: number;
  missingInTable: Array<{ mp: string; orderId: string; article: string | null; qty: number; wh: string; state: string }>;
  cancelledButInTable: Array<{ mp: string; orderId: string; article: string | null; row: number; state: string }>;
  qtyMismatch: Array<{ orderId: string; article: string | null; site: number; table: number }>;
  whMismatch: Array<{ orderId: string; article: string | null; site: string; table: string }>;
  tableOnly: Array<{ row: number; ref: string; sku: string; dest: string; from: string }>;
  unmapped: number;
};

type SheetRow = { row: number; date: unknown; sku: string; qty: number; dest: string; ref: string; from: string };

const sheetTs = (v: unknown): number | null => {
  if (typeof v === 'number' && v > 30000) return Math.round((v - 25569) * 86400000 - 3 * 3600000);
  const m = String(v ?? '').match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  return m ? Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1])) - 3 * 3600000 : null;
};

/** Похоже на номер заказа площадки (WB — длинное число, Ozon — 0123-4567-1). */
const looksLikeOrder = (ref: string) => /^\d{7,}$/.test(ref) || /^\d+-\d+-\d+$/.test(ref);

export function compareOrders(rows: SheetRow[], days: number): CompareReport {
  const d = getSkladDb();
  const now = Date.now();
  const from = now - days * 86400000;
  const settle = now - 20 * 60000; // Apps Script пишет раз в 5 мин — свежие не судим
  const whName = new Map((d.prepare('SELECT id, name FROM warehouses').all() as any[]).map(w => [w.id as number, String(w.name)]));
  const orders = d.prepare(`SELECT o.*, p.article FROM mp_orders o LEFT JOIN products p ON p.id = o.product_id
    WHERE o.ordered_at >= ? AND o.ordered_at < ?`).all(from, settle) as any[];

  const table = new Map<string, SheetRow[]>();
  for (const r of rows) if (r.ref) (table.get(r.ref) ?? table.set(r.ref, []).get(r.ref)!).push(r);

  const rep: CompareReport = { checkedAt: now, days, orders: 0, matched: 0, missingInTable: [], cancelledButInTable: [],
    qtyMismatch: [], whMismatch: [], tableOnly: [], unmapped: 0 };
  const known = new Set<string>();
  for (const o of orders) {
    known.add(o.order_id);
    if (!o.wh_id || !o.product_id) { rep.unmapped++; continue; }
    rep.orders++;
    const art = String(o.article ?? '').toUpperCase();
    const trs = (table.get(o.order_id) ?? []).filter(r => r.sku.toUpperCase() === art);
    const active = ['open', 'assembled', 'shipped', 'cancelled_after'].includes(o.state) && o.qty > 0;
    if (!active) {
      if (trs.length) rep.cancelledButInTable.push({ mp: o.mp, orderId: o.order_id, article: o.article, row: trs[0].row, state: o.state });
      else rep.matched++;
      continue;
    }
    if (!trs.length) { rep.missingInTable.push({ mp: o.mp, orderId: o.order_id, article: o.article, qty: o.qty, wh: whName.get(o.wh_id) ?? '', state: o.state }); continue; }
    const tq = trs.reduce((s, r) => s + r.qty, 0);
    let ok = true;
    if (tq !== o.qty) { rep.qtyMismatch.push({ orderId: o.order_id, article: o.article, site: o.qty, table: tq }); ok = false; }
    const tw = trs[0].from;
    if (tw.toLowerCase() !== String(whName.get(o.wh_id) ?? '').toLowerCase()) { rep.whMismatch.push({ orderId: o.order_id, article: o.article, site: whName.get(o.wh_id) ?? '', table: tw }); ok = false; }
    if (ok) rep.matched++;
  }
  // Строки таблицы с номером заказа, которого сайт не видел (кабинет WB 2 без токена и т.п.).
  for (const r of rows) {
    const ts = sheetTs(r.date);
    if (ts === null || ts < from || ts >= settle) continue;
    if (!looksLikeOrder(r.ref) || known.has(r.ref)) continue;
    rep.tableOnly.push({ row: r.row, ref: r.ref, sku: r.sku, dest: r.dest, from: r.from });
  }
  const cap = <T,>(a: T[]) => a.slice(0, 300);
  rep.missingInTable = cap(rep.missingInTable); rep.cancelledButInTable = cap(rep.cancelledButInTable);
  rep.qtyMismatch = cap(rep.qtyMismatch); rep.whMismatch = cap(rep.whMismatch); rep.tableOnly = cap(rep.tableOnly);
  return rep;
}

export async function compareWithSheet(days: number): Promise<CompareReport> {
  const id = (process.env.SKLAD_SHEET_ID || '').trim();
  if (!id) throw new Error('SKLAD_SHEET_ID не задан на сервере');
  const { hasServiceAccount, readSheetRange } = await import('../googleSheetsApi');
  if (!hasServiceAccount()) throw new Error('ключ сервисного аккаунта Google не настроен');
  // Новые строки «Отгрузки» вставляются сверху (с 20-й) — за несколько дней хватает первых тысяч.
  const raw = await readSheetRange(id, `'Отгрузка'!A20:G6000`);
  const rows: SheetRow[] = raw.map((r, i) => ({
    row: 20 + i, date: r?.[0], sku: String(r?.[1] ?? '').trim(), qty: Number(r?.[2]) || 0,
    dest: String(r?.[3] ?? '').trim(), ref: String(r?.[4] ?? '').trim(), from: String(r?.[6] ?? '').trim(),
  })).filter(r => r.sku);
  return compareOrders(rows, days);
}
