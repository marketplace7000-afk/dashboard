/**
 * Клиент раздела «Склад» (/api/sklad/*). Типы повторяют api/_lib/sklad/*.
 */
import { apiGet, apiPost, errText } from './http';

export type Role = 'owner' | 'manager' | 'buyer' | 'warehouse';
export type MpCode = 'wb1' | 'wb2' | 'ozon' | 'ym';
export type MpMode = 'stock' | 'heavy_only' | 'orders_only';
export type ProductStatus = 'draft' | 'active' | 'phaseout' | 'archived';
export type WarehouseKind = 'own' | 'ff' | 'transit';

export type Me = { id: number | null; name: string; login: string; role: Role; warehouseIds: number[] | null; sections: string[] };

export type Warehouse = {
  id: number; code: string; name: string; kind: WarehouseKind; city: string;
  sheetName: string | null; active: boolean; sort: number; notes: string;
};
export type MpWarehouse = {
  id: number; warehouseId: number; mp: MpCode; extName: string; extId: string | null;
  mode: MpMode; active: boolean; notes: string; syncedAt: number | null;
};
export type Product = {
  id: number; article: string; name: string; status: ProductStatus;
  lengthCm: number | null; widthCm: number | null; heightCm: number | null; weightG: number | null;
  perBox: number | null; photoUrl: string; diskUrl: string; notes: string; source: string;
  barcodes: Array<{ barcode: string; kind: string }>;
  mp: Array<{ mp: MpCode; extSku: string; extItem: string; barcode: string; title: string; syncedAt: number }>;
  createdAt: number; updatedAt: number; volumeL: number | null;
};
export type User = {
  id: number; login: string; name: string; role: Role; tgId: number | null;
  active: boolean; hasPassword: boolean; warehouseIds: number[]; sections: string[]; customSections: boolean;
  createdAt: number; lastLoginAt: number | null;
};
export type AuditRow = {
  id: number; ts: number; userName: string; entity: string; entityId: string; action: string; diff: Record<string, unknown>;
};
export type Bootstrap = {
  me: Me; warehouses: Warehouse[]; mpWarehouses: MpWarehouse[]; products: Product[]; users: User[];
  ignoredWh: Array<{ mp: MpCode; extId: string; extName: string; reason: string }>;
  dict: { kinds: Array<{ value: string; label: string; sign: 1 | -1 | 0; canPost: boolean }>; roles: Array<{ value: Role; label: string; sections: string[] }>; sections: Array<{ value: string; label: string }>; productStatuses: ProductStatus[]; mps: MpCode[]; heavyWeightG: number; sheetConfigured: boolean };
};
export type ImportReport = {
  dryRun: boolean; master: number; created: string[]; updated: Array<{ article: string; fields: string[] }>;
  reactivated: string[]; archivedNew: string[]; archivedGone: string[]; barcodesAdded: number;
  barcodeConflicts: string[]; warnings: string[];
};
export type UnboundWarehouse = { mp: MpCode; extName: string; extId: string; suggestWarehouseId: number | null; suggestMode: MpMode };
export type SyncReport = {
  warehouses: Record<string, { matched: number; missing: string[]; error?: string }>;
  unbound: UnboundWarehouse[];
  cards: Record<string, { linked: number; notInCatalog: string[]; error?: string }>;
  skipped: string[];
};

export const ROLE_LABEL: Record<Role, string> = { owner: 'Владелец', manager: 'Менеджер', buyer: 'Закупщик', warehouse: 'Сотрудник склада' };
export const MP_LABEL: Record<MpCode, string> = { wb1: 'WB кабинет 1', wb2: 'WB кабинет 2', ozon: 'Ozon', ym: 'Яндекс Маркет' };
export const MODE_LABEL: Record<MpMode, string> = { stock: 'остатки и заказы', heavy_only: 'только тяжёлые (СГТ)', orders_only: 'только заказы (КГТ)' };
export const STATUS_LABEL: Record<ProductStatus, string> = { draft: 'Готовится', active: 'Активен', phaseout: 'Выводится', archived: 'Архив' };
export const KIND_LABEL: Record<WarehouseKind, string> = { own: 'Свой склад', ff: 'Фулфилмент', transit: 'Транзит' };

/** Текст ошибки без технической приставки «сервер ответил 400:». */
export function skladErr(e: unknown): string {
  return errText(e).replace(/^сервер ответил \d+:\s*/, '');
}

const T_LONG = { timeoutMs: 180_000 };

export const sklad = {
  bootstrap: () => apiGet<Bootstrap & { ok: true }>('/api/sklad/bootstrap').then(r => r.data),
  product: (id: number) => apiGet<{ product: Product; audit: AuditRow[] }>(`/api/sklad/products/${id}`).then(r => r.data),
  saveProduct: (id: number | null, input: Record<string, unknown>) =>
    apiPost<{ product: Product }>(`/api/sklad/products${id ? `/${id}` : ''}`, input).then(r => r.data.product),
  find: (q: string) => apiGet<{ product: Product }>(`/api/sklad/find?q=${encodeURIComponent(q)}`).then(r => r.data.product),
  saveWarehouse: (id: number | null, input: Partial<Warehouse>) =>
    apiPost<{ warehouse: Warehouse }>(`/api/sklad/warehouses${id ? `/${id}` : ''}`, input).then(r => r.data.warehouse),
  saveMpWarehouse: (id: number | null, input: Partial<MpWarehouse> & { extId?: string | null }) =>
    apiPost<{ mpWarehouse: MpWarehouse }>(`/api/sklad/mp-warehouses${id ? `/${id}` : ''}`, input).then(r => r.data.mpWarehouse),
  deleteMpWarehouse: (id: number) => apiPost(`/api/sklad/mp-warehouses/${id}/delete`, {}),
  saveUser: (id: number | null, input: Record<string, unknown>) =>
    apiPost<{ user: User }>(`/api/sklad/users${id ? `/${id}` : ''}`, input).then(r => r.data.user),
  importSheet: (dryRun: boolean) => apiPost<{ report: ImportReport }>('/api/sklad/import', { dryRun }, T_LONG).then(r => r.data.report),
  mpSync: () => apiPost<{ report: SyncReport }>('/api/sklad/mp-sync', {}, T_LONG).then(r => r.data.report),
  audit: (limit = 200) => apiGet<{ audit: AuditRow[] }>(`/api/sklad/audit?limit=${limit}`).then(r => r.data.audit),
};

// ─── Этап 2: остатки, движения, инвентаризация, перенос истории ─────────────
export type MovementKind = string;
export type Movement = {
  id: number; ts: number; whId: number; sign: 1 | -1; kind: MovementKind; counterWh: number | null;
  counterpart: string; ref: string; note: string; status: 'done' | 'in_transit' | 'received';
  linkId: number | null; reversed: boolean; source: string; createdName: string; createdAt: number;
  lines: Array<{ productId: number; article: string; name: string; qty: number; price: number | null; barcode: string }>;
};
export type StockData = {
  stock: Array<{ productId: number; whId: number; qty: number }>;
  inTransit: Array<{ productId: number; toWhId: number; qty: number }>;
};
export type InventoryLine = { productId: number; article: string; name: string; barcode: string; counted: number;
  stock: number; pending: number; expected: number; diff: number; countedAt: number };
export type Inventory = {
  id: number; whId: number; status: 'draft' | 'done' | 'cancelled'; fullCount: boolean; note: string;
  createdName: string; createdAt: number; doneAt: number | null; doneName: string;
  lines: InventoryLine[];
  uncounted: Array<{ productId: number; article: string; name: string; barcode: string; stock: number; pending: number; expected: number }>;
};
export type InventoryBrief = Omit<Inventory, 'lines' | 'uncounted'> & { linesCount: number };
export type ReconcileReport = {
  checkedAt: number;
  warehouses: Array<{ name: string; sheet: string; items: number; matched: number; diffs: Array<{ article: string; sheet: number; site: number }>; error?: string }>;
};
export type HistoryReport = {
  dryRun: boolean; receipts: number; shipments: number; imported: number;
  skipped: Array<{ sheet: string; row: number; reason: string }>; newArchived: string[]; byKind: Record<string, number>;
  reconcile?: ReconcileReport;
};
export type LineInput = { productId: number; qty: number; price?: number | string | null };

const q = (o: Record<string, unknown>) => Object.entries(o).filter(([, v]) => v !== undefined && v !== '' && v !== null)
  .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&');

export const sklad2 = {
  stock: () => apiGet<StockData>('/api/sklad/stock').then(r => r.data),
  movements: (f: Record<string, unknown>) => apiGet<{ items: Movement[]; total: number }>(`/api/sklad/movements?${q(f)}`).then(r => r.data),
  postMovement: (input: { kind: string; whId: number; lines: LineInput[]; note?: string; ref?: string; counterpart?: string }) =>
    apiPost<{ movement: Movement }>('/api/sklad/movements', input).then(r => r.data.movement),
  reverse: (id: number, reason: string) => apiPost<{ movement: Movement }>(`/api/sklad/movements/${id}/reverse`, { reason }).then(r => r.data.movement),
  sendTransfer: (input: { whId: number; toWhId: number; lines: LineInput[]; note?: string; ref?: string }) =>
    apiPost<{ movement: Movement }>('/api/sklad/transfers', input).then(r => r.data.movement),
  receiveTransfer: (id: number, lines?: Array<{ productId: number; qty: number }>, note?: string) =>
    apiPost<{ movement: Movement }>(`/api/sklad/transfers/${id}/receive`, { lines, note }).then(r => r.data.movement),
  inventories: () => apiGet<{ inventories: InventoryBrief[] }>('/api/sklad/inventories').then(r => r.data.inventories),
  inventory: (id: number) => apiGet<{ inventory: Inventory }>(`/api/sklad/inventories/${id}`).then(r => r.data.inventory),
  createInventory: (whId: number, fullCount: boolean) => apiPost<{ inventory: Inventory }>('/api/sklad/inventories', { whId, fullCount }).then(r => r.data.inventory),
  count: (id: number, productId: number, qty: number, add = false, remove = false) =>
    apiPost<{ inventory: Inventory }>(`/api/sklad/inventories/${id}/count`, { productId, qty, add, remove }).then(r => r.data.inventory),
  updateInventory: (id: number, input: { fullCount?: boolean; note?: string; cancel?: boolean }) =>
    apiPost<{ inventory: Inventory }>(`/api/sklad/inventories/${id}`, input).then(r => r.data.inventory),
  finishInventory: (id: number) => apiPost<{ inventory: Inventory; plus: number; minus: number }>(`/api/sklad/inventories/${id}/finish`, {}).then(r => r.data),
  historyStatus: () => apiGet<{ importedAt: number | null; cutoverAt: number | null; reconcile: ReconcileReport | null }>('/api/sklad/history/status').then(r => r.data),
  importHistory: (dryRun: boolean) => apiPost<{ report: HistoryReport }>('/api/sklad/history/import', { dryRun }, { timeoutMs: 300_000 }).then(r => r.data.report),
  reconcile: () => apiPost<{ reconcile: ReconcileReport }>('/api/sklad/history/reconcile', {}, { timeoutMs: 180_000 }).then(r => r.data.reconcile),
};

// ─── Этап 3: заказы FBS ───────────────────────────────────────────────────
export type OrderState = 'open' | 'assembled' | 'shipped' | 'cancelled_before' | 'cancelled_after' | 'removed';
export type OrderRow = {
  id: number; mp: 'wb1' | 'wb2' | 'ozon'; orderId: string; offer: string; productId: number | null; article: string | null; qty: number;
  extWhId: string; whId: number | null; orderedAt: number; rawStatus: string; state: OrderState; problem: string;
  movementId: number | null; stornoId: number | null; updatedAt: number;
};
export type PollResult = { added: number; changed: number; created: number; reversed: number; unmapped: number; fetched: number } | { error: string } | { skipped: string };
export type PollStatus = { at: number; full: boolean; ms: number; results: Record<string, PollResult> };
export type OrdersCompare = {
  checkedAt: number; days: number; orders: number; matched: number; unmapped: number;
  missingInTable: Array<{ mp: string; orderId: string; article: string | null; qty: number; wh: string; state: string }>;
  cancelledButInTable: Array<{ mp: string; orderId: string; article: string | null; row: number; state: string }>;
  qtyMismatch: Array<{ orderId: string; article: string | null; site: number; table: number }>;
  whMismatch: Array<{ orderId: string; article: string | null; site: string; table: string }>;
  tableOnly: Array<{ row: number; ref: string; sku: string; dest: string; from: string }>;
  manual?: Array<{ wh: string; mp: string; from: string; to: string; items: Array<{ article: string; site: number; table: number }>;
    fbo?: Array<{ row: number; article: string; qty: number; note: string }> }>;
};
export const ORDER_STATE_LABEL: Record<OrderState, string> = {
  open: 'Не собран', assembled: 'Собран', shipped: 'Передан', cancelled_before: 'Отменён до передачи',
  cancelled_after: 'Отменён после передачи', removed: 'Ушёл из отправления',
};

export const sklad3 = {
  orders: (f: Record<string, unknown>) => apiGet<{ items: OrderRow[]; total: number; counts: Record<string, number> }>(`/api/sklad/orders?${q(f)}`).then(r => r.data),
  status: () => apiGet<{ quick: PollStatus | null; full: PollStatus | null; liveSince: number | null; enabled: boolean; compare: OrdersCompare | null }>('/api/sklad/orders/status').then(r => r.data),
  poll: (full: boolean) => apiPost<{ status: PollStatus }>('/api/sklad/orders/poll', { full }, { timeoutMs: 300_000 }).then(r => r.data.status),
  compare: (days: number) => apiPost<{ report: OrdersCompare }>('/api/sklad/orders/compare', { days }, { timeoutMs: 180_000 }).then(r => r.data.report),
};

export const ignoreWh = (mp: string, extId: string, extName: string, ignore: boolean, reason = '') =>
  apiPost('/api/sklad/orders/ignore', { mp, extId, extName, ignore, reason });
