/**
 * Справочники «Склада»: склады, склады площадок, товары, баркоды.
 *
 * Начальное заполнение складов и складов площадок повторяет конфигурацию
 * Apps Script «Baloo» (FBS.gs на 16.10.2026): WAREHOUSE_GROUPS,
 * CABINET2_PODOLSK_WAREHOUSES, HEAVY_WAREHOUSES_BY_GROUP,
 * OZON_WAREHOUSE_NAME_BY_GROUP, OZON_EXTRA_ORDER_WAREHOUSES_BY_GROUP.
 * Выполняется один раз — на пустой базе; дальше всё правится на экране.
 */
import { getSkladDb } from './db';
import { audit } from './audit';
import type { AuthUser } from './users';

// ─── Склады ────────────────────────────────────────────────────────────────
export type WarehouseKind = 'own' | 'ff' | 'transit';
export type Warehouse = {
  id: number; code: string; name: string; kind: WarehouseKind; city: string;
  sheetName: string | null; active: boolean; sort: number; notes: string;
};

export type MpCode = 'wb1' | 'wb2' | 'ozon' | 'ym';
export const MP_CODES: MpCode[] = ['wb1', 'wb2', 'ozon', 'ym'];
export type MpMode = 'stock' | 'heavy_only' | 'orders_only';
export type MpWarehouse = {
  id: number; warehouseId: number; mp: MpCode; extName: string; extId: string | null;
  mode: MpMode; active: boolean; notes: string; syncedAt: number | null;
};

const SEED_WAREHOUSES: Array<{ code: string; name: string; kind: WarehouseKind; city: string; sheet: string | null; sort: number; notes?: string }> = [
  { code: 'ufa', name: 'Склад Уфа', kind: 'own', city: 'Уфа', sheet: 'Склад Уфа', sort: 10 },
  { code: 'ff-podolsk', name: 'ФФ Подольск', kind: 'ff', city: 'Подольск', sheet: 'ФФ Подольск', sort: 20 },
  { code: 'ff-ufa', name: 'ФФ Уфа', kind: 'ff', city: 'Уфа', sheet: 'ФФ Уфа', sort: 30 },
  { code: 'ff-spb', name: 'ФФ СПБ', kind: 'ff', city: 'Санкт-Петербург', sheet: 'ФФ СПБ', sort: 40 },
  { code: 'ff-krasnodar', name: 'ФФ Краснодар', kind: 'ff', city: 'Краснодар', sheet: 'ФФ Краснодар', sort: 50 },
  { code: 'yuzhnye-vorota', name: 'Южные ворота', kind: 'transit', city: 'Москва', sheet: null, sort: 90,
    notes: 'Приход карго из Китая в Москве; дальше распределяется на Подольск или Уфу' },
];

const SEED_MP: Array<{ wh: string; mp: MpCode; names: string[]; mode?: MpMode; notes?: string }> = [
  { wh: 'ФФ Уфа', mp: 'wb1', names: ['Склад ФФ Уфа', 'Склад ФФ Уфа-Пермь', 'Склад ФФ Уфа-Самара', 'Склад ФФ Уфа-Саратов',
    'Склад ФФ Уфа-Тюмень', 'Склад ФФ Уфа-Новосибирск', 'Склад ФФ Уфа-Казань', 'Склад ФФ Уфа-Нижний Новгород'] },
  { wh: 'ФФ Подольск', mp: 'wb1', names: ['Склад ФФ Подольск', 'Склад ФФ Подольск-Тверь', 'Склад ФФ Подольск-Воронеж',
    'Склад ФФ Подольск-Тула', 'Склад ФФ Подольск-Рязань', 'Склад ФФ Подольск-Коледино'] },
  { wh: 'ФФ Подольск', mp: 'wb1', names: ['Склад ФФ Подольск-СГТ'], mode: 'heavy_only', notes: 'Только товары тяжелее 25 кг' },
  { wh: 'ФФ СПБ', mp: 'wb1', names: ['Склад ФФ СПБ', 'Склад ФФ СПБ-Псков', 'Склад ФФ СПБ-Великий Новгород', 'Склад ФФ СПБ-Петрозаводск'] },
  { wh: 'ФФ Краснодар', mp: 'wb1', names: ['Склад ФФ Краснодар', 'Склад ФФ Краснодар-Волгоград', 'Склад ФФ Краснодар-Ростов',
    'Склад ФФ Краснодар-Новороссийск', 'Склад ФФ Краснодар-Владикавказ', 'Склад ФФ Краснодар-Симферополь'] },
  { wh: 'ФФ Подольск', mp: 'wb2', names: ['Склад ФФ Подольск-Белая дача', 'Склад ФФ Подольск', 'Склад ФФ Подольск-Пушкино',
    'Склад ФФ Подольск-Шушары', 'Склад ФФ Подольск-Ярославль', 'Склад ФФ Подольск-Радумля'] },
  { wh: 'Склад Уфа', mp: 'ozon', names: ['Склад Уфа'], notes: 'Отдельный пул Ozon: остаток «Склада Уфа» минус открытые заказы' },
  { wh: 'ФФ Подольск', mp: 'ozon', names: ['Склад ФФ Подольск'] },
  { wh: 'ФФ Краснодар', mp: 'ozon', names: ['Склад ФФ Краснодар'] },
  { wh: 'ФФ СПБ', mp: 'ozon', names: ['Склад ФФ СПБ'] },
  { wh: 'ФФ Подольск', mp: 'ozon', names: ['КГТ'], mode: 'orders_only',
    notes: 'Товар, который основной склад Ozon не принимает по габаритам: остатки ставит менеджер вручную, заказы списываются с ФФ Подольск' },
];

/** Заполнить склады и склады площадок, если база пустая. */
export function ensureSeed(): void {
  const d = getSkladDb();
  const n = Number((d.prepare('SELECT COUNT(*) AS n FROM warehouses').get() as any).n);
  if (n > 0) return;
  const now = Date.now();
  d.exec('BEGIN IMMEDIATE');
  try {
    const insW = d.prepare(`INSERT INTO warehouses (code, name, kind, city, sheet_name, sort, notes, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const w of SEED_WAREHOUSES) insW.run(w.code, w.name, w.kind, w.city, w.sheet, w.sort, w.notes ?? '', now, now);
    const idByName = new Map((d.prepare('SELECT id, name FROM warehouses').all() as any[]).map(r => [r.name, r.id]));
    const insM = d.prepare(`INSERT INTO mp_warehouses (warehouse_id, mp, ext_name, mode, notes) VALUES (?, ?, ?, ?, ?)`);
    for (const g of SEED_MP) for (const name of g.names) insM.run(idByName.get(g.wh), g.mp, name, g.mode ?? 'stock', g.notes ?? '');
    audit({ id: null, name: 'система' }, 'warehouse', '*', 'seed', { from: 'FBS.gs 16.10.2026' });
    d.exec('COMMIT');
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
}

function toWarehouse(r: any): Warehouse {
  return { id: r.id, code: r.code, name: r.name, kind: r.kind, city: r.city, sheetName: r.sheet_name,
    active: !!r.active, sort: r.sort, notes: r.notes };
}
function toMp(r: any): MpWarehouse {
  return { id: r.id, warehouseId: r.warehouse_id, mp: r.mp, extName: r.ext_name, extId: r.ext_id,
    mode: r.mode, active: !!r.active, notes: r.notes, syncedAt: r.synced_at };
}

export function listWarehouses(onlyIds?: number[] | null): Warehouse[] {
  const rows = getSkladDb().prepare('SELECT * FROM warehouses ORDER BY sort, name').all() as any[];
  return rows.map(toWarehouse).filter(w => !onlyIds || onlyIds.includes(w.id));
}

export function listMpWarehouses(onlyWarehouseIds?: number[] | null): MpWarehouse[] {
  const rows = getSkladDb().prepare('SELECT * FROM mp_warehouses ORDER BY warehouse_id, mp, ext_name').all() as any[];
  return rows.map(toMp).filter(m => !onlyWarehouseIds || onlyWarehouseIds.includes(m.warehouseId));
}

export type WarehouseInput = Partial<Pick<Warehouse, 'code' | 'name' | 'kind' | 'city' | 'sheetName' | 'active' | 'sort' | 'notes'>>;

export function saveWarehouse(id: number | null, input: WarehouseInput, by: AuthUser): { warehouse?: Warehouse; error?: string } {
  const d = getSkladDb();
  const before = id ? (d.prepare('SELECT * FROM warehouses WHERE id = ?').get(id) as any) : null;
  if (id && !before) return { error: 'Склад не найден' };
  const name = input.name !== undefined ? String(input.name).trim() : before?.name;
  const code = input.code !== undefined ? String(input.code).trim().toLowerCase() : before?.code;
  const kind = input.kind ?? before?.kind ?? 'ff';
  if (!name) return { error: 'Укажите название склада' };
  if (!/^[a-z0-9-]{2,32}$/.test(code ?? '')) return { error: 'Код — 2–32 символа: латиница, цифры, дефис' };
  if (!['own', 'ff', 'transit'].includes(kind)) return { error: 'Неизвестный тип склада' };
  const vals = {
    code, name, kind,
    city: input.city !== undefined ? String(input.city).trim() : before?.city ?? '',
    sheet_name: input.sheetName !== undefined ? (input.sheetName ? String(input.sheetName).trim() : null) : before?.sheet_name ?? null,
    active: input.active !== undefined ? (input.active ? 1 : 0) : before?.active ?? 1,
    sort: input.sort !== undefined ? Number(input.sort) || 100 : before?.sort ?? 100,
    notes: input.notes !== undefined ? String(input.notes) : before?.notes ?? '',
  };
  const now = Date.now();
  try {
    d.exec('BEGIN IMMEDIATE');
    let wid = id;
    if (before) {
      d.prepare(`UPDATE warehouses SET code=?, name=?, kind=?, city=?, sheet_name=?, active=?, sort=?, notes=?, updated_at=? WHERE id=?`)
        .run(vals.code, vals.name, vals.kind, vals.city, vals.sheet_name, vals.active, vals.sort, vals.notes, now, id);
      audit(by, 'warehouse', id!, 'update', diffOf(before, vals));
    } else {
      const r = d.prepare(`INSERT INTO warehouses (code, name, kind, city, sheet_name, active, sort, notes, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(vals.code, vals.name, vals.kind, vals.city, vals.sheet_name, vals.active, vals.sort, vals.notes, now, now);
      wid = Number(r.lastInsertRowid);
      audit(by, 'warehouse', wid, 'create', { name: [null, vals.name] });
    }
    d.exec('COMMIT');
    return { warehouse: toWarehouse(d.prepare('SELECT * FROM warehouses WHERE id = ?').get(wid)) };
  } catch (e) {
    d.exec('ROLLBACK');
    if (/UNIQUE/.test(String((e as Error).message))) return { error: 'Склад с таким кодом или названием уже есть' };
    throw e;
  }
}

export type MpWarehouseInput = Partial<Pick<MpWarehouse, 'warehouseId' | 'mp' | 'extName' | 'mode' | 'active' | 'notes'>> & {
  /** id склада площадки, если уже известен (привязка из сверки). */
  extId?: string | null;
};

export function saveMpWarehouse(id: number | null, input: MpWarehouseInput, by: AuthUser): { mpWarehouse?: MpWarehouse; error?: string } {
  const d = getSkladDb();
  const before = id ? (d.prepare('SELECT * FROM mp_warehouses WHERE id = ?').get(id) as any) : null;
  if (id && !before) return { error: 'Склад площадки не найден' };
  const vals = {
    warehouse_id: input.warehouseId ?? before?.warehouse_id,
    mp: input.mp ?? before?.mp,
    ext_name: input.extName !== undefined ? String(input.extName).trim() : before?.ext_name,
    mode: input.mode ?? before?.mode ?? 'stock',
    active: input.active !== undefined ? (input.active ? 1 : 0) : before?.active ?? 1,
    notes: input.notes !== undefined ? String(input.notes) : before?.notes ?? '',
  };
  if (!vals.warehouse_id || !d.prepare('SELECT 1 FROM warehouses WHERE id = ?').get(vals.warehouse_id)) return { error: 'Выберите наш склад' };
  if (!MP_CODES.includes(vals.mp)) return { error: 'Неизвестная площадка' };
  if (!vals.ext_name) return { error: 'Укажите название склада точно как в кабинете площадки' };
  if (!['stock', 'heavy_only', 'orders_only'].includes(vals.mode)) return { error: 'Неизвестный режим' };
  try {
    d.exec('BEGIN IMMEDIATE');
    let mid = id;
    if (before) {
      // Переименовали — id площадки надо найти заново.
      const resetExt = vals.ext_name !== before.ext_name || vals.mp !== before.mp;
      d.prepare(`UPDATE mp_warehouses SET warehouse_id=?, mp=?, ext_name=?, mode=?, active=?, notes=?${resetExt ? ', ext_id=NULL, synced_at=NULL' : ''} WHERE id=?`)
        .run(vals.warehouse_id, vals.mp, vals.ext_name, vals.mode, vals.active, vals.notes, id);
      audit(by, 'mp_warehouse', id!, 'update', diffOf(before, vals));
    } else {
      const extId = input.extId ? String(input.extId) : null;
      const r = d.prepare(`INSERT INTO mp_warehouses (warehouse_id, mp, ext_name, mode, active, notes, ext_id, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(vals.warehouse_id, vals.mp, vals.ext_name, vals.mode, vals.active, vals.notes, extId, extId ? Date.now() : null);
      mid = Number(r.lastInsertRowid);
      audit(by, 'mp_warehouse', mid, 'create', { mp: [null, vals.mp], extName: [null, vals.ext_name] });
    }
    d.exec('COMMIT');
    return { mpWarehouse: toMp(d.prepare('SELECT * FROM mp_warehouses WHERE id = ?').get(mid)) };
  } catch (e) {
    d.exec('ROLLBACK');
    if (/UNIQUE/.test(String((e as Error).message))) return { error: 'Этот склад площадки уже привязан' };
    throw e;
  }
}

export function deleteMpWarehouse(id: number, by: AuthUser): { ok: boolean; error?: string } {
  const d = getSkladDb();
  const before = d.prepare('SELECT * FROM mp_warehouses WHERE id = ?').get(id) as any;
  if (!before) return { ok: false, error: 'Склад площадки не найден' };
  d.exec('BEGIN IMMEDIATE');
  try {
    d.prepare('DELETE FROM mp_warehouses WHERE id = ?').run(id);
    audit(by, 'mp_warehouse', id, 'delete', { mp: [before.mp, null], extName: [before.ext_name, null] });
    d.exec('COMMIT');
    return { ok: true };
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
}

function diffOf(before: Record<string, unknown>, after: Record<string, unknown>): Record<string, [unknown, unknown]> {
  const out: Record<string, [unknown, unknown]> = {};
  for (const k of Object.keys(after)) if (after[k] !== undefined && after[k] !== before[k]) out[k] = [before[k], after[k]];
  return out;
}

// ─── Товары ────────────────────────────────────────────────────────────────
export type ProductStatus = 'draft' | 'active' | 'phaseout' | 'archived';
export const PRODUCT_STATUSES: ProductStatus[] = ['draft', 'active', 'phaseout', 'archived'];

export type Product = {
  id: number; article: string; name: string; status: ProductStatus;
  lengthCm: number | null; widthCm: number | null; heightCm: number | null; weightG: number | null;
  perBox: number | null; photoUrl: string; diskUrl: string; notes: string; source: string;
  barcodes: Array<{ barcode: string; kind: string }>;
  mp: Array<{ mp: MpCode; extSku: string; extItem: string; barcode: string; title: string; syncedAt: number }>;
  createdAt: number; updatedAt: number;
  /** Вычисляемое: литры на единицу (для хранения и коробок). */
  volumeL: number | null;
};

/** Тяжёлый товар (СГТ WB) — тот же порог, что в FBS.gs. */
export const HEAVY_WEIGHT_G = 25000;

function toProduct(r: any, barcodes: any[], mps: any[]): Product {
  const vol = r.length_cm && r.width_cm && r.height_cm ? Math.round(r.length_cm * r.width_cm * r.height_cm) / 1000 : null;
  return {
    id: r.id, article: r.article, name: r.name, status: r.status,
    lengthCm: r.length_cm, widthCm: r.width_cm, heightCm: r.height_cm, weightG: r.weight_g, perBox: r.per_box,
    photoUrl: r.photo_url, diskUrl: r.disk_url, notes: r.notes, source: r.source,
    barcodes: barcodes.map(b => ({ barcode: b.barcode, kind: b.kind })),
    mp: mps.map(m => ({ mp: m.mp, extSku: m.ext_sku, extItem: m.ext_item, barcode: m.barcode, title: m.title, syncedAt: m.synced_at })),
    createdAt: r.created_at, updatedAt: r.updated_at, volumeL: vol,
  };
}

export function listProducts(): Product[] {
  const d = getSkladDb();
  const rows = d.prepare('SELECT * FROM products ORDER BY CASE status WHEN \'active\' THEN 0 WHEN \'draft\' THEN 1 WHEN \'phaseout\' THEN 2 ELSE 3 END, article').all() as any[];
  const bc = new Map<number, any[]>();
  for (const b of d.prepare('SELECT * FROM product_barcodes ORDER BY kind, barcode').all() as any[]) {
    (bc.get(b.product_id) ?? bc.set(b.product_id, []).get(b.product_id)!).push(b);
  }
  const mp = new Map<number, any[]>();
  for (const m of d.prepare('SELECT * FROM product_mp ORDER BY mp').all() as any[]) {
    (mp.get(m.product_id) ?? mp.set(m.product_id, []).get(m.product_id)!).push(m);
  }
  return rows.map(r => toProduct(r, bc.get(r.id) ?? [], mp.get(r.id) ?? []));
}

export function getProduct(id: number): Product | null {
  const d = getSkladDb();
  const r = d.prepare('SELECT * FROM products WHERE id = ?').get(id);
  if (!r) return null;
  return toProduct(r,
    d.prepare('SELECT * FROM product_barcodes WHERE product_id = ? ORDER BY kind, barcode').all(id) as any[],
    d.prepare('SELECT * FROM product_mp WHERE product_id = ? ORDER BY mp').all(id) as any[]);
}

export function normBarcode(v: unknown): string {
  // Как Штрихкода.gs: только цифры (снимает пробелы, апострофы, 6.43E+12 и мусор из копирования).
  if (typeof v === 'number') return Number.isInteger(v) ? v.toFixed(0) : String(v).replace(/\D+/g, '');
  return String(v ?? '').replace(/\D+/g, '');
}

export function normArticle(v: unknown): string {
  return String(v ?? '').trim();
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const x = Number(String(v).replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(x) && x >= 0 ? x : null;
};

export type ProductInput = {
  article?: string; name?: string; status?: ProductStatus;
  lengthCm?: number | string | null; widthCm?: number | string | null; heightCm?: number | string | null;
  weightG?: number | string | null; perBox?: number | string | null;
  photoUrl?: string; diskUrl?: string; notes?: string;
  /** Полный список баркодов товара (заменяет текущий). */
  barcodes?: Array<{ barcode: string; kind?: string }>;
};

/** Какие поля карточки может менять роль. Склад правит габариты, вес, коробку. */
const WAREHOUSE_FIELDS = new Set(['lengthCm', 'widthCm', 'heightCm', 'weightG', 'perBox', 'barcodes']);

const COLS: Array<[keyof ProductInput, string, (v: any) => unknown]> = [
  ['article', 'article', v => normArticle(v)],
  ['name', 'name', v => String(v ?? '').trim()],
  ['status', 'status', v => v],
  ['lengthCm', 'length_cm', num],
  ['widthCm', 'width_cm', num],
  ['heightCm', 'height_cm', num],
  ['weightG', 'weight_g', num],
  ['perBox', 'per_box', v => { const x = num(v); return x === null ? null : Math.round(x); }],
  ['photoUrl', 'photo_url', v => String(v ?? '').trim()],
  ['diskUrl', 'disk_url', v => String(v ?? '').trim()],
  ['notes', 'notes', v => String(v ?? '')],
];

export function saveProduct(id: number | null, input: ProductInput, by: AuthUser, source = 'manual'): { product?: Product; error?: string } {
  const d = getSkladDb();
  const before = id ? (d.prepare('SELECT * FROM products WHERE id = ?').get(id) as any) : null;
  if (id && !before) return { error: 'Товар не найден' };
  if (by.role === 'warehouse') {
    const extra = Object.keys(input).filter(k => (input as any)[k] !== undefined && !WAREHOUSE_FIELDS.has(k));
    if (extra.length || !id) return { error: 'Сотрудник склада может менять только габариты, вес, штук в коробке и баркоды' };
  }
  if (input.status !== undefined && !PRODUCT_STATUSES.includes(input.status)) return { error: 'Неизвестный статус' };
  if (!before && !normArticle(input.article)) return { error: 'Укажите артикул' };
  if (input.article !== undefined && !normArticle(input.article)) return { error: 'Артикул не может быть пустым' };
  if (input.diskUrl && !/^https?:\/\//i.test(String(input.diskUrl).trim())) return { error: 'Ссылка на Яндекс Диск должна начинаться с https://' };

  const set: string[] = [];
  const args: unknown[] = [];
  const diff: Record<string, [unknown, unknown]> = {};
  for (const [field, col, conv] of COLS) {
    if (input[field] === undefined) continue;
    const v = conv(input[field]);
    if (before && v === before[col]) continue;
    set.push(col); args.push(v); diff[field] = [before ? before[col] : null, v];
  }
  const now = Date.now();
  try {
    d.exec('BEGIN IMMEDIATE');
    let pid = id;
    if (before) {
      if (set.length) d.prepare(`UPDATE products SET ${set.map(c => `${c} = ?`).join(', ')}, updated_at = ?, updated_by = ? WHERE id = ?`)
        .run(...args, now, by.id, id);
    } else {
      const cols = [...set, 'source', 'created_at', 'updated_at', 'updated_by'];
      const r = d.prepare(`INSERT INTO products (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
        .run(...args, source, now, now, by.id);
      pid = Number(r.lastInsertRowid);
    }
    if (input.barcodes !== undefined) {
      const bcDiff = replaceBarcodes(pid!, input.barcodes);
      if (bcDiff) diff.barcodes = bcDiff;
    }
    if (Object.keys(diff).length) audit(by, 'product', pid!, before ? 'update' : 'create', diff);
    d.exec('COMMIT');
    return { product: getProduct(pid!)! };
  } catch (e) {
    d.exec('ROLLBACK');
    const m = String((e as Error).message);
    if (/products\.article/.test(m)) return { error: 'Товар с таким артикулом уже есть' };
    if (/product_barcodes\.barcode/.test(m) || /BarcodeTaken/.test(m)) return { error: m.replace(/^.*BarcodeTaken: /, '') };
    throw e;
  }
}

/** Заменить баркоды товара. Чужой баркод не отбираем — это почти всегда ошибка ввода. */
function replaceBarcodes(productId: number, list: Array<{ barcode: string; kind?: string }>): [string[], string[]] | null {
  const d = getSkladDb();
  const next = new Map<string, string>();
  for (const b of list) {
    const code = normBarcode(b.barcode);
    if (code.length < 6) continue;
    next.set(code, ['main', 'wb2', 'extra'].includes(String(b.kind)) ? String(b.kind) : 'extra');
  }
  for (const code of next.keys()) {
    const owner = d.prepare(`SELECT p.article FROM product_barcodes b JOIN products p ON p.id = b.product_id
      WHERE b.barcode = ? AND b.product_id <> ?`).get(code, productId) as any;
    if (owner) throw new Error(`BarcodeTaken: Баркод ${code} уже принадлежит товару ${owner.article}`);
  }
  const prev = (d.prepare('SELECT barcode FROM product_barcodes WHERE product_id = ? ORDER BY barcode').all(productId) as any[]).map(r => r.barcode);
  d.prepare('DELETE FROM product_barcodes WHERE product_id = ?').run(productId);
  const ins = d.prepare('INSERT INTO product_barcodes (barcode, product_id, kind, created_at) VALUES (?, ?, ?, ?)');
  for (const [code, kind] of next) ins.run(code, productId, kind, Date.now());
  const now = [...next.keys()].sort();
  return JSON.stringify(prev) === JSON.stringify(now) ? null : [prev, now];
}

/** Поиск товара по артикулу или любому баркоду (для сканера). */
export function findProduct(q: string): Product | null {
  const d = getSkladDb();
  const code = normBarcode(q);
  let r: any = null;
  if (code.length >= 6) r = d.prepare('SELECT product_id AS id FROM product_barcodes WHERE barcode = ?').get(code);
  if (!r) r = d.prepare('SELECT id FROM products WHERE article = ?').get(normArticle(q));
  return r ? getProduct(Number(r.id)) : null;
}
