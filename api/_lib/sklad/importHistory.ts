/**
 * Перенос истории учёта из Google-таблицы «Склад (orig)» в журнал движений.
 *
 * Таблицу после перехода удаляют, поэтому переносим всё: каждая строка
 * «Приемки» и «Отгрузки» (с 20-й) становится движением с source = 'sheet'.
 * Повторный перенос заменяет все движения из таблицы целиком (ручные движения
 * сайта не трогает) — так можно сверяться сколько угодно раз, пока таблица
 * ещё живая. После отметки «переход завершён» перенос запрещён.
 *
 * Соответствие (как считают формулы листов, см. анализ §1.3):
 *   «Отгрузка» D: WB → sale_wb, Ozon → sale_ozon, Яндекс/ЯМ → sale_ym,
 *     Я.Kit → sale_ykit, название склада → transfer_out, Прочее / Прочая
 *     отгрузка → writeoff, пусто → other_out. Склад-отправитель — G.
 *   «Приемка» E: Поставка с ценой в D → purchase (партия для себестоимости),
 *     Поставка без цены → arrival, Возврат WB/Ozon, Инвентаризация,
 *     Прочее поступление, Входящий остаток, Забор выкупов; номер закупки
 *     (348…) → как Поставка. Склад-получатель — G.
 * Артикулы, которых нет в справочнике (выведены из ассортимента, в журналах
 * их 126), заводятся архивными — иначе их история и остатки пропали бы.
 */
import { getSkladDb, kvGet, kvSet } from './db';
import { audit } from './audit';
import { insertMovement, stockSnapshot, type MovementKind } from './movements';
import { normArticle, normBarcode } from './catalog';
import type { AuthUser } from './users';

export const CUTOVER_KEY = 'cutover_done_at';

export type SheetRow = { row: number; date: unknown; sku: unknown; qty: unknown; d: unknown; e: unknown; f: unknown; g: unknown };

export type HistoryReport = {
  dryRun: boolean;
  receipts: number; shipments: number; imported: number;
  skipped: Array<{ sheet: string; row: number; reason: string }>;
  newArchived: string[];
  byKind: Record<string, number>;
  reconcile?: ReconcileReport;
};

/** Дата из таблицы: число-дата Google (дни с 30.12.1899, по Москве) или «дд.мм.гггг». */
export function sheetDate(v: unknown): number | null {
  if (typeof v === 'number' && v > 30000 && v < 80000) return Math.round((v - 25569) * 86400000 - 3 * 3600000);
  const m = String(v ?? '').match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (m) return Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1])) - 3 * 3600000;
  return null;
}

const norm = (v: unknown) => String(v ?? '').trim();
const lc = (v: unknown) => norm(v).toLowerCase();

export function shipmentKind(dest: string, whByName: Map<string, number>): { kind: MovementKind; counterWh: number | null } {
  const d = lc(dest);
  if (d === 'wb') return { kind: 'sale_wb', counterWh: null };
  if (d === 'ozon') return { kind: 'sale_ozon', counterWh: null };
  if (d === 'яндекс' || d === 'ям') return { kind: 'sale_ym', counterWh: null };
  if (d === 'я.kit') return { kind: 'sale_ykit', counterWh: null };
  if (d === 'прочее' || d === 'прочая отгрузка') return { kind: 'writeoff', counterWh: null };
  const wh = whByName.get(d);
  if (wh) return { kind: 'transfer_out', counterWh: wh };
  return { kind: 'other_out', counterWh: null };
}

export function receiptKind(type: string, hasPrice: boolean): MovementKind {
  const t = lc(type);
  if (t === 'возврат wb') return 'return_wb';
  if (t === 'возврат ozon') return 'return_ozon';
  if (t === 'инвентаризация') return 'inventory_plus';
  if (t === 'прочее поступление') return 'other_in';
  if (t === 'входящий остаток') return 'opening';
  if (t === 'забор выкупов') return 'buyout_return';
  // «Поставка», номер закупки из «В доставке» или что-то иное
  return hasPrice ? 'purchase' : 'arrival';
}

const num = (v: unknown): number => {
  if (typeof v === 'number') return v;
  const x = Number(String(v ?? '').replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(x) ? x : NaN;
};

/** Применить строки к базе (в одной транзакции; dryRun — откатить). */
export function applyHistory(receipts: SheetRow[], shipments: SheetRow[], by: AuthUser, dryRun: boolean): HistoryReport {
  if (kvGet(CUTOVER_KEY)) throw new Error('Переход с таблицы уже завершён — перенос истории отключён');
  const d = getSkladDb();
  const rep: HistoryReport = { dryRun, receipts: receipts.length, shipments: shipments.length, imported: 0, skipped: [], newArchived: [], byKind: {} };
  const whByName = new Map((d.prepare('SELECT id, name FROM warehouses').all() as any[]).map(w => [String(w.name).toLowerCase(), w.id as number]));
  const whName = new Map((d.prepare('SELECT id, name FROM warehouses').all() as any[]).map(w => [w.id as number, String(w.name)]));
  const productId = new Map<string, number>();
  const now = Date.now();
  const sys = { id: by.id, name: `${by.name} (перенос из таблицы)` };

  const findProduct = (sku: string, barcode: string): number => {
    const key = sku.toUpperCase();
    const cached = productId.get(key);
    if (cached) return cached;
    let r = d.prepare('SELECT id FROM products WHERE article = ?').get(sku) as any;
    if (!r && barcode.length >= 6) r = d.prepare('SELECT product_id AS id FROM product_barcodes WHERE barcode = ?').get(barcode) as any;
    if (!r) {
      const ins = d.prepare(`INSERT INTO products (article, status, source, notes, created_at, updated_at, updated_by)
        VALUES (?, 'archived', 'sheet', 'Заведён при переносе истории: есть в журналах таблицы, нет в справочнике', ?, ?, ?)`).run(sku, now, now, by.id);
      r = { id: Number(ins.lastInsertRowid) };
      if (barcode.length >= 6 && !d.prepare('SELECT 1 FROM product_barcodes WHERE barcode = ?').get(barcode)) {
        d.prepare(`INSERT INTO product_barcodes (barcode, product_id, kind, created_at) VALUES (?, ?, 'main', ?)`).run(barcode, r.id, now);
      }
      rep.newArchived.push(sku);
    }
    productId.set(key, r.id);
    return r.id;
  };

  d.exec('BEGIN IMMEDIATE');
  try {
    d.exec(`DELETE FROM movement_lines WHERE movement_id IN (SELECT id FROM movements WHERE source = 'sheet');
            DELETE FROM movements WHERE source = 'sheet';`);
    const take = (sheet: 'Приемка' | 'Отгрузка', r: SheetRow) => {
      const sku = normArticle(r.sku);
      const qty = num(r.qty);
      if (!sku) { rep.skipped.push({ sheet, row: r.row, reason: 'нет артикула' }); return; }
      if (!Number.isFinite(qty) || qty === 0 || !Number.isInteger(qty)) { rep.skipped.push({ sheet, row: r.row, reason: `количество «${norm(r.qty)}»` }); return; }
      const wh = whByName.get(lc(r.g));
      if (!wh) { rep.skipped.push({ sheet, row: r.row, reason: `неизвестный склад «${norm(r.g)}» (${sku}, ${qty} шт.)` }); return; }
      const ts = sheetDate(r.date);
      if (ts === null) { rep.skipped.push({ sheet, row: r.row, reason: `дата «${norm(r.date)}»` }); return; }
      const pid = findProduct(sku, normBarcode(r.f));
      if (sheet === 'Отгрузка') {
        const k = shipmentKind(norm(r.d), whByName);
        insertMovement({ ts, whId: wh, sign: -1, kind: k.kind, counterWh: k.counterWh,
          counterpart: k.counterWh ? whName.get(k.counterWh)! : norm(r.d), ref: norm(r.e), status: k.kind === 'transfer_out' ? 'received' : 'done',
          note: `Отгрузка, строка ${r.row}`, source: 'sheet', lines: [{ productId: pid, qty }] }, sys);
        rep.byKind[k.kind] = (rep.byKind[k.kind] ?? 0) + 1;
      } else {
        const price = num(r.d);
        const hasPrice = Number.isFinite(price) && price > 0;
        const kind = receiptKind(norm(r.e), hasPrice);
        insertMovement({ ts, whId: wh, sign: 1, kind, counterpart: kind === 'purchase' || kind === 'arrival' ? norm(r.f).replace(/\d{8,}/, '').trim() : '',
          ref: norm(r.e), note: `Приемка, строка ${r.row}`, source: 'sheet', lines: [{ productId: pid, qty, price: hasPrice ? price : null }] }, sys);
        rep.byKind[kind] = (rep.byKind[kind] ?? 0) + 1;
      }
      rep.imported++;
    };
    for (const r of receipts) take('Приемка', r);
    for (const r of shipments) take('Отгрузка', r);
    if (!dryRun) {
      kvSet('history_imported_at', String(Date.now()));
      audit(by, 'history', '*', 'import', { imported: [null, rep.imported], skipped: [null, rep.skipped.length], archived: [null, rep.newArchived.length] });
    }
    if (dryRun) d.exec('ROLLBACK'); else d.exec('COMMIT');
    return rep;
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
}

// ─── Сверка с колонкой M листов складов ────────────────────────────────────
export type ReconcileReport = {
  checkedAt: number;
  warehouses: Array<{ name: string; sheet: string; items: number; matched: number;
    diffs: Array<{ article: string; sheet: number; site: number }>; error?: string }>;
};

/** Сравнить остатки сайта с колонкой M каждого листа. sheetStock: лист → артикул → M. */
export function reconcile(sheetStock: Map<string, Map<string, number>>, errors: Map<string, string>): ReconcileReport {
  const d = getSkladDb();
  const whs = d.prepare('SELECT id, name, sheet_name FROM warehouses WHERE sheet_name IS NOT NULL ORDER BY sort').all() as any[];
  const { stock } = stockSnapshot(null);
  const art = new Map((d.prepare('SELECT id, article FROM products').all() as any[]).map(p => [p.id as number, String(p.article).toUpperCase()]));
  const site = new Map<string, number>(); // wh|ARTICLE → qty
  for (const s of stock) site.set(`${s.whId}|${art.get(s.productId)}`, s.qty);
  const rep: ReconcileReport = { checkedAt: Date.now(), warehouses: [] };
  for (const w of whs) {
    const sheet = sheetStock.get(w.sheet_name);
    if (!sheet) { rep.warehouses.push({ name: w.name, sheet: w.sheet_name, items: 0, matched: 0, diffs: [], error: errors.get(w.sheet_name) ?? 'лист не прочитан' }); continue; }
    const diffs: Array<{ article: string; sheet: number; site: number }> = [];
    let matched = 0;
    for (const [a, m] of sheet) {
      const s = site.get(`${w.id}|${a}`) ?? 0;
      if (s === m) matched++; else diffs.push({ article: a, sheet: m, site: s });
    }
    rep.warehouses.push({ name: w.name, sheet: w.sheet_name, items: sheet.size, matched, diffs });
  }
  return rep;
}

// ─── Чтение таблицы ────────────────────────────────────────────────────────
async function readJournal(id: string, sheet: string, read: (id: string, r: string) => Promise<any[][]>): Promise<SheetRow[]> {
  const rows = await read(id, `'${sheet}'!A20:G20000`);
  const out: SheetRow[] = [];
  rows.forEach((r, i) => {
    if (!r || r.every(c => c === '' || c === null || c === undefined)) return;
    out.push({ row: 20 + i, date: r[0], sku: r[1], qty: r[2], d: r[3], e: r[4], f: r[5], g: r[6] });
  });
  return out;
}

async function readSheetStocks(id: string, read: (id: string, r: string) => Promise<any[][]>): Promise<{ stock: Map<string, Map<string, number>>; errors: Map<string, string> }> {
  const d = getSkladDb();
  const sheets = (d.prepare('SELECT sheet_name FROM warehouses WHERE sheet_name IS NOT NULL').all() as any[]).map(r => String(r.sheet_name));
  const stock = new Map<string, Map<string, number>>();
  const errors = new Map<string, string>();
  for (const sh of sheets) {
    try {
      const rows = await read(id, `'${sh}'!A1:M1000`);
      // Колонки по заголовкам (строки 2–3): артикул «SKU…», остаток «Остаток, ед.».
      const h2 = (rows[1] ?? []).map(c => lc(c));
      const h3 = (rows[2] ?? []).map(c => lc(c));
      const aCol = h2.findIndex(c => c.startsWith('sku'));
      const mCol = h3.findIndex(c => c.startsWith('остаток, ед'));
      if (aCol < 0 || mCol < 0) throw new Error('не найдены колонки артикула или «Остаток, ед.»');
      const m = new Map<string, number>();
      for (let i = 3; i < rows.length; i++) {
        const a = norm(rows[i]?.[aCol]).toUpperCase();
        if (!a || m.has(a)) continue;
        const q = num(rows[i]?.[mCol]);
        m.set(a, Number.isFinite(q) ? q : 0);
      }
      stock.set(sh, m);
    } catch (e) {
      errors.set(sh, (e as Error).message);
    }
  }
  return { stock, errors };
}

async function sheetsReader(): Promise<{ id: string; read: (id: string, r: string) => Promise<any[][]> }> {
  const id = (process.env.SKLAD_SHEET_ID || '').trim();
  if (!id) throw new Error('SKLAD_SHEET_ID не задан на сервере');
  const { hasServiceAccount, readSheetRange } = await import('../googleSheetsApi');
  if (!hasServiceAccount()) throw new Error('ключ сервисного аккаунта Google не настроен');
  return { id, read: (sid, r) => readSheetRange(sid, r) };
}

/** Перенести историю и сразу сверить с листами. */
export async function importHistoryFromSheet(by: AuthUser, dryRun: boolean): Promise<HistoryReport> {
  const { id, read } = await sheetsReader();
  const [receipts, shipments] = await Promise.all([readJournal(id, 'Приемка', read), readJournal(id, 'Отгрузка', read)]);
  const rep = applyHistory(receipts, shipments, by, dryRun);
  if (!dryRun) {
    const { stock, errors } = await readSheetStocks(id, read);
    rep.reconcile = reconcile(stock, errors);
    kvSet('last_reconcile', JSON.stringify(rep.reconcile));
  }
  return rep;
}

/** Только сверка (без переноса). */
export async function reconcileWithSheet(): Promise<ReconcileReport> {
  const { id, read } = await sheetsReader();
  const { stock, errors } = await readSheetStocks(id, read);
  const r = reconcile(stock, errors);
  kvSet('last_reconcile', JSON.stringify(r));
  return r;
}
