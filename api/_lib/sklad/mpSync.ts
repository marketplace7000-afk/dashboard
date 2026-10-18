/**
 * Сверка справочников «Склада» с кабинетами WB и Ozon — только чтение площадок.
 *
 *   • склады площадок: находим id по точному названию (как refreshWarehouseIds /
 *     refreshOzonWarehouses в Apps Script);
 *   • карточки: WB nmID/chrtID и Ozon sku/product_id по артикулу
 *     (vendorCode WB = offer_id Ozon = артикул) — замена BARCODE_CHRTID_MAP.
 *
 * Кабинет WB 2 («广州艾思蒂卡贸易有限公司»): его токен пока есть только в Apps
 * Script (WB_API_TOKEN_2). Если на сервере задан WB_TOKEN_2 — сверяем и его.
 */
import { getSkladDb } from './db';
import { audit } from './audit';
import { fetchAllWbCards } from '../wbCards';
import { fetchWithRetry } from '../fetchRetry';
import type { AuthUser } from './users';
import type { MpCode } from './catalog';

const WB_MARKET = 'https://marketplace-api.wildberries.ru';
const WB_CONTENT = 'https://content-api.wildberries.ru';
const OZON = 'https://api-seller.ozon.ru';

function wbToken(mp: 'wb1' | 'wb2'): string {
  return ((mp === 'wb1' ? process.env.WB_TOKEN : process.env.WB_TOKEN_2) || '').trim();
}
function ozonHeaders(): Record<string, string> {
  return { 'Client-Id': process.env.OZON_CLIENT_ID ?? '', 'Api-Key': process.env.OZON_API_KEY ?? '', 'Content-Type': 'application/json' };
}

async function ozReq(path: string, body: unknown): Promise<any> {
  const res = await fetchWithRetry(`${OZON}/${path}`, { method: 'POST', headers: ozonHeaders(), body: JSON.stringify(body) },
    { maxRetries: 2, timeoutMs: 40_000 });
  if (!res.ok) throw new Error(`ozon ${path} → ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
  return res.json();
}

/** Склад в кабинете, который ещё не привязан ни к одному нашему складу. */
export type UnboundWarehouse = {
  mp: MpCode; extName: string; extId: string;
  /** Наш склад по названию («Склад ФФ Подольск-Рязань» → «ФФ Подольск»), если угадали. */
  suggestWarehouseId: number | null;
  suggestMode: 'stock' | 'heavy_only';
};

export type SyncReport = {
  warehouses: Record<string, { matched: number; missing: string[]; error?: string }>;
  unbound: UnboundWarehouse[];
  cards: Record<string, { linked: number; notInCatalog: string[]; error?: string }>;
  skipped: string[];
};

/**
 * Угадать наш склад по названию склада площадки. Склады продавца в кабинетах
 * называются по схеме «Склад <наш склад>[-<город>]»: «Склад ФФ Подольск»,
 * «Склад ФФ Подольск-Рязань», «Склад ФФ Подольск-СГТ», «Склад Уфа».
 * Берём самое длинное совпадение с названием нашего склада.
 */
export function suggestWarehouse(extName: string, ours: Array<{ id: number; name: string }>): { warehouseId: number | null; mode: 'stock' | 'heavy_only' } {
  const full = extName.trim().toLowerCase();
  const n = full.replace(/^склад\s+/i, '');
  // Наш склад может и сам называться «Склад …» (Склад Уфа) — сверяем и полное название.
  const fits = (x: string, name: string) => x === name || x.startsWith(name + '-') || x.startsWith(name + ' ');
  let best: { id: number; len: number } | null = null;
  for (const w of ours) {
    const name = w.name.toLowerCase();
    if ((fits(n, name) || fits(full, name)) && (!best || name.length > best.len)) best = { id: w.id, len: name.length };
  }
  return { warehouseId: best?.id ?? null, mode: /(^|[-\s])сгт$/i.test(n) ? 'heavy_only' : 'stock' };
}

function findUnbound(mp: MpCode, ids: Map<string, string>): UnboundWarehouse[] {
  const d = getSkladDb();
  const bound = new Set((d.prepare('SELECT ext_name FROM mp_warehouses WHERE mp = ?').all(mp) as any[]).map(r => String(r.ext_name).trim()));
  const ours = d.prepare('SELECT id, name FROM warehouses WHERE active = 1').all() as Array<{ id: number; name: string }>;
  const out: UnboundWarehouse[] = [];
  for (const [extName, extId] of ids) {
    if (bound.has(extName)) continue;
    const s = suggestWarehouse(extName, ours);
    out.push({ mp, extName, extId, suggestWarehouseId: s.warehouseId, suggestMode: s.mode });
  }
  return out;
}

// ─── Склады площадок ───────────────────────────────────────────────────────
async function fetchMpWarehouses(mp: MpCode): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (mp === 'wb1' || mp === 'wb2') {
    const res = await fetchWithRetry(`${WB_MARKET}/api/v3/warehouses`, { headers: { Authorization: wbToken(mp) } }, { maxRetries: 2, timeoutMs: 30_000 });
    if (!res.ok) throw new Error(`wb ${mp} warehouses → ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
    for (const w of (await res.json()) as any[]) if (w?.name) out.set(String(w.name).trim(), String(w.id));
  } else if (mp === 'ozon') {
    const j = await ozReq('v1/warehouse/list', {});
    for (const w of (j?.result ?? [])) if (w?.name) out.set(String(w.name).trim(), String(w.warehouse_id));
  }
  return out;
}

function syncWarehouseIds(mp: MpCode, ids: Map<string, string>, by: AuthUser): { matched: number; missing: string[] } {
  const d = getSkladDb();
  const rows = d.prepare('SELECT * FROM mp_warehouses WHERE mp = ?').all(mp) as any[];
  let matched = 0;
  const missing: string[] = [];
  const now = Date.now();
  for (const r of rows) {
    const id = ids.get(String(r.ext_name).trim()) ?? null;
    if (!id) { missing.push(r.ext_name); continue; }
    matched++;
    if (id !== r.ext_id) {
      d.prepare('UPDATE mp_warehouses SET ext_id = ?, synced_at = ? WHERE id = ?').run(id, now, r.id);
      audit(by, 'mp_warehouse', r.id, 'sync', { extId: [r.ext_id, id] });
    } else {
      d.prepare('UPDATE mp_warehouses SET synced_at = ? WHERE id = ?').run(now, r.id);
    }
  }
  return { matched, missing };
}

// ─── Карточки ──────────────────────────────────────────────────────────────
type Card = { article: string; extSku: string; extItem: string; barcodes: string[]; title: string };

async function fetchWbCards(mp: 'wb1' | 'wb2'): Promise<Card[]> {
  const { cards, partial } = await fetchAllWbCards({ base: WB_CONTENT, headers: { Authorization: wbToken(mp) } });
  if (partial) console.warn(`[sklad] каталог WB ${mp} получен не полностью`);
  return cards.map((c: any) => {
    const sizes: any[] = c?.sizes ?? [];
    return {
      article: String(c?.vendorCode ?? '').trim(),
      extSku: String(c?.nmID ?? ''),
      extItem: sizes.map(s => s?.chrtID).filter(Boolean).join(','),
      barcodes: sizes.flatMap(s => (s?.skus ?? []).map((x: any) => String(x))),
      title: String(c?.title ?? ''),
    };
  }).filter(c => c.article);
}

async function fetchOzonCards(): Promise<Card[]> {
  const pids: number[] = [];
  let lastId = '';
  for (let page = 0; page < 20; page++) {
    const pl = await ozReq('v3/product/list', { filter: { visibility: 'ALL' }, last_id: lastId, limit: 1000 });
    const items: any[] = pl?.result?.items ?? [];
    for (const it of items) if (it.product_id) pids.push(it.product_id);
    lastId = pl?.result?.last_id ?? '';
    if (!lastId || items.length < 1000) break;
  }
  const out: Card[] = [];
  for (let i = 0; i < pids.length; i += 1000) {
    const info = await ozReq('v3/product/info/list', { product_id: pids.slice(i, i + 1000) });
    for (const it of (info?.items ?? [])) {
      const sku = it?.sku ?? (it?.sources ?? []).find((s: any) => s?.sku)?.sku;
      out.push({
        article: String(it?.offer_id ?? '').trim(),
        extSku: sku ? String(sku) : '',
        extItem: String(it?.id ?? ''),
        barcodes: (it?.barcodes ?? []).map((x: any) => String(x)),
        title: String(it?.name ?? ''),
      });
    }
  }
  return out.filter(c => c.article);
}

function syncCards(mp: MpCode, cards: Card[]): { linked: number; notInCatalog: string[] } {
  const d = getSkladDb();
  const now = Date.now();
  let linked = 0;
  const notInCatalog: string[] = [];
  const findId = (article: string) => (d.prepare('SELECT id FROM products WHERE article = ?').get(article) as any)?.id as number | undefined;
  for (const c of cards) {
    const pid = findId(c.article);
    if (!pid) { notInCatalog.push(c.article); continue; }
    d.prepare(`INSERT INTO product_mp (product_id, mp, ext_sku, ext_item, barcode, title, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(product_id, mp) DO UPDATE SET ext_sku = excluded.ext_sku, ext_item = excluded.ext_item,
        barcode = excluded.barcode, title = excluded.title, synced_at = excluded.synced_at`)
      .run(pid, mp, c.extSku, c.extItem, c.barcodes[0] ?? '', c.title, now);
    // Баркоды карточки, которых у нас ещё нет. У каб.2 свои баркоды (мост
    // BARCODE_2_TO_1_MAP в Apps Script) — помечаем их kind = 'wb2'.
    for (const raw of c.barcodes) {
      const code = raw.replace(/\D+/g, '');
      if (code.length < 6) continue;
      const owner = d.prepare('SELECT product_id FROM product_barcodes WHERE barcode = ?').get(code) as any;
      if (owner) continue;
      d.prepare('INSERT INTO product_barcodes (barcode, product_id, kind, created_at) VALUES (?, ?, ?, ?)')
        .run(code, pid, mp === 'wb2' ? 'wb2' : 'extra', now);
    }
    linked++;
  }
  return { linked, notInCatalog };
}

export async function syncWithMarketplaces(by: AuthUser): Promise<SyncReport> {
  const rep: SyncReport = { warehouses: {}, unbound: [], cards: {}, skipped: [] };
  const mps: MpCode[] = [];
  if (wbToken('wb1')) mps.push('wb1'); else rep.skipped.push('WB кабинет 1: нет WB_TOKEN');
  if (wbToken('wb2')) mps.push('wb2'); else rep.skipped.push('WB кабинет 2: токен есть только в Apps Script (нужен WB_TOKEN_2 на сервере)');
  if (process.env.OZON_CLIENT_ID && process.env.OZON_API_KEY) mps.push('ozon'); else rep.skipped.push('Ozon: нет OZON_CLIENT_ID / OZON_API_KEY');

  for (const mp of mps) {
    try {
      const ids = await fetchMpWarehouses(mp);
      rep.warehouses[mp] = syncWarehouseIds(mp, ids, by);
      rep.unbound.push(...findUnbound(mp, ids));
    } catch (e) {
      rep.warehouses[mp] = { matched: 0, missing: [], error: (e as Error).message };
    }
    try {
      const cards = mp === 'ozon' ? await fetchOzonCards() : await fetchWbCards(mp as 'wb1' | 'wb2');
      rep.cards[mp] = syncCards(mp, cards);
    } catch (e) {
      rep.cards[mp] = { linked: 0, notInCatalog: [], error: (e as Error).message };
    }
  }
  audit(by, 'mp-sync', '*', 'run', {
    warehouses: Object.fromEntries(Object.entries(rep.warehouses).map(([k, v]) => [k, v.error ?? `${v.matched} найдено, ${v.missing.length} нет`])),
    cards: Object.fromEntries(Object.entries(rep.cards).map(([k, v]) => [k, v.error ?? `${v.linked} привязано`])),
  });
  return rep;
}
