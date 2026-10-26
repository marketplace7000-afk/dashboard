/**
 * «Остатки FBO» (26.10.2026): остатки на складах маркетплейсов по кластерам,
 * поставки к ним, где покупают (FBO/FBS) и остатки своих складов (FBS) из
 * Google-таблицы «Склад». Только чтение API площадок и таблицы.
 *
 * Источники и их особенности (проверено 20–22.10 на живом кабинете):
 *  • Ozon FBO — v2/analytics/stock_on_warehouses (склад × товар), склад → кластер
 *    по v1/cluster/list. Поставки — v3/supply-order/list|get + v1/supply-order/bundle
 *    (поставка идёт на кластер, не на склад).
 *  • Ozon заказы — v3/posting/fbo/list (курсор) и v4/posting/fbs/list (v3 отключён
 *    19.10.2026, см. ozonFbsList.ts); у обоих financial_data.cluster_from/to.
 *  • WB — с августа 2026 все живые склады России одной строкой «Склад WB РФ»
 *    (отчёт warehouse_remains). Склады с названиями городов РФ — остановленные,
 *    остаток на момент остановки: в цифры не берём (это решает страница).
 *  • WB заказы — statistics supplier/orders: округ покупателя и тип склада
 *    (FBO/FBS). Склад отправки FBO WB скрывает.
 *  • FBS — лист каждого склада в таблице «Склад»: C — артикул, K — «Едет на ФФ»,
 *    M — «Остаток, ед.»; заказы WB по складам — строки «Отгрузка» с номером заказа.
 *
 * Сбор долгий (поставки WB — 2 запроса на поставку с паузой из-за лимита), поэтому
 * страница получает последний собранный снимок, а свежий собирается фоном.
 */
import { cacheGet, cacheSet, ageMs } from './cache';
import { readSheetRange } from './googleSheetsApi';
import { listOzonFbsPostings } from './ozonFbsList';

const CACHE_KEY = 'fbo-stocks:v1';
const KEEP_MS = 7 * 24 * 3600_000;     // показывать можно и старый снимок — с датой
export const FBO_REFRESH_MS = 3 * 3600_000;

const FF_SHEETS = ['ФФ Подольск', 'ФФ СПБ', 'ФФ Краснодар', 'ФФ Уфа', 'Склад Уфа'] as const;

export type FboBundle = {
  at: string;
  ozStock: { warehouse_name: string; item_code: string; item_name: string; free_to_sell_amount: number; reserved_amount: number }[];
  ozClusters: { name: string; macro: number; wh: string[] }[];
  ozSupplies: { num: string; state: string; slot?: string; drop?: string; macro: number; items: { art: string; q: number; name?: string; icon?: string }[] }[];
  ozProducts: { art: string; name: string; img: string }[];
  ozOrders: { art: string; to: string; from: string; fbs: boolean; q: number }[];
  wbStock: { vendorCode: string; nmId: number; warehouses: { warehouseName: string; quantity: number }[] }[];
  wbCards: { nm: number; art: string; name: string; img: string }[];
  wbSupplies: { id: number; status: number; created?: string; date?: string | null; fact?: string | null; wh: string; items: { art: string; nm: number; q: number; acc: number }[] }[];
  wbOrders: { art: string; okrug?: string; country?: string; fbs: boolean; q: number }[];
  fbs: {
    wh: { id: number; name: string; own: boolean; way: number }[];
    stock: { art: string; wh: number; q: number }[];
    ord: { mp: 'w' | 'o'; art: string; wh: number; q: number }[];
  };
  notes: string[];
};

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Запрос с повтором на 429 (у обеих площадок лимиты «в секунду/минуту»). */
async function call(url: string, init: RequestInit, tries = 6): Promise<any> {
  for (let i = 0; i < tries; i++) {
    const r = await fetch(url, { ...init, signal: AbortSignal.timeout(60_000) });
    if (r.status === 429) { await sleep(2500 * (i + 1)); continue; }
    const t = await r.text();
    if (!r.ok) throw new Error(`${url.replace(/^https:\/\/[^/]+/, '')} → ${r.status} ${t.slice(0, 160)}`);
    try { return JSON.parse(t); } catch { throw new Error(`${url} → не JSON`); }
  }
  throw new Error(`${url.replace(/^https:\/\/[^/]+/, '')} → 429 после ${tries} попыток`);
}

const ozHeaders = () => ({ 'Client-Id': process.env.OZON_CLIENT_ID ?? '', 'Api-Key': process.env.OZON_API_KEY ?? '', 'Content-Type': 'application/json' });
const wbHeaders = () => ({ Authorization: (process.env.WB_TOKEN ?? '').trim(), 'Content-Type': 'application/json' });
const oz = (path: string, body: Record<string, unknown>) =>
  call(`https://api-seller.ozon.ru/${path}`, { method: 'POST', headers: ozHeaders(), body: JSON.stringify(body) });

async function collectOzon(notes: string[]) {
  const since30 = new Date(Date.now() - 30 * 864e5).toISOString(), now = new Date().toISOString();
  const stockRows: any[] = (await oz('v2/analytics/stock_on_warehouses', { limit: 1000, offset: 0, warehouse_type: 'ALL' })).result?.rows ?? [];
  const ozStock = stockRows.map(r => ({
    warehouse_name: String(r.warehouse_name), item_code: String(r.item_code), item_name: String(r.item_name ?? ''),
    free_to_sell_amount: Number(r.free_to_sell_amount) || 0, reserved_amount: Number(r.reserved_amount) || 0,
  }));

  const cl = await oz('v1/cluster/list', { cluster_type: 'CLUSTER_TYPE_OZON' });
  const ozClusters = (cl.clusters ?? []).map((c: any) => ({
    name: String(c.name), macro: Number(c.macrolocal_cluster_id),
    wh: (c.logistic_clusters ?? []).flatMap((l: any) => (l.warehouses ?? []).map((w: any) => String(w.name))).filter((w: string) => /РФЦ|МПСЦ/i.test(w)),
  }));

  // Поставки: всё, что ещё не завершено и не отменено.
  const ozSupplies: FboBundle['ozSupplies'] = [];
  try {
    const so = await oz('v3/supply-order/list', {
      filter: { states: ['DATA_FILLING', 'READY_TO_SUPPLY', 'ACCEPTED_AT_SUPPLY_WAREHOUSE', 'IN_TRANSIT', 'ACCEPTANCE_AT_STORAGE_WAREHOUSE', 'REPORTS_CONFIRMATION_AWAITING', 'REPORT_REJECTED'] },
      limit: 100, sort_by: 'ORDER_CREATION', sort_dir: 'DESC',
    });
    const ids: number[] = so.order_ids ?? [];
    const orders: any[] = ids.length ? (await oz('v3/supply-order/get', { order_ids: ids })).orders ?? [] : [];
    for (const o of orders) for (const s of (o.supplies ?? [])) {
      if (['CANCELLED', 'COMPLETED', 'REJECTED_AT_SUPPLY_WAREHOUSE'].includes(s.state)) continue;
      await sleep(1100); // у bundle лимит «в секунду»
      const b = await oz('v1/supply-order/bundle', { bundle_ids: [s.bundle_id], limit: 100 });
      ozSupplies.push({
        num: String(o.order_number), state: String(s.state), slot: o.timeslot?.timeslot?.from, drop: o.drop_off_warehouse?.name,
        macro: Number(s.macrolocal_cluster_id),
        items: (b.items ?? []).map((i: any) => ({ art: String(i.offer_id), q: Number(i.quantity) || 0, name: i.name, icon: i.icon_path })),
      });
    }
  } catch (e) { notes.push('Ozon: поставки не получены — ' + (e as Error).message); }

  // Заказы за 30 дней с кластером покупателя: FBO (v3, курсор) и FBS (v4).
  const raw: { art: string; to: string; from: string; fbs: boolean; q: number }[] = [];
  try {
    let cursor: string | undefined;
    for (let i = 0; i < 100; i++) {
      const r = await oz('v3/posting/fbo/list', { dir: 'ASC', filter: { since: since30, to: now }, limit: 100, with: { financial_data: true }, ...(cursor ? { cursor } : { offset: 0 }) });
      for (const p of (r.postings ?? [])) {
        if (p.status === 'cancelled') continue;
        for (const pr of (p.products ?? [])) raw.push({ art: String(pr.offer_id), to: p.financial_data?.cluster_to ?? '', from: p.financial_data?.cluster_from ?? '', fbs: false, q: Number(pr.quantity) || 1 });
      }
      cursor = r.cursor;
      if (!r.has_next || !cursor) break;
      await sleep(400);
    }
  } catch (e) { notes.push('Ozon: заказы FBO не получены — ' + (e as Error).message); }
  const fbsByWh: { art: string; wh: string; q: number }[] = [];
  try {
    const fbs = await listOzonFbsPostings(oz, { filter: { since: since30, to: now }, with: { financial_data: true } }, { pauseMs: 400 });
    for (const p of fbs) {
      if (p.status === 'cancelled') continue;
      const wh = String(p.delivery_method?.warehouse ?? '');
      if (/Нижнекамск/i.test(wh)) continue; // самовыкупы (mp_wh_ignored в «Складе»)
      for (const pr of (p.products ?? [])) {
        const q = Number(pr.quantity) || 1;
        raw.push({ art: String(pr.offer_id), to: p.financial_data?.cluster_to ?? '', from: p.financial_data?.cluster_from ?? '', fbs: true, q });
        fbsByWh.push({ art: String(pr.offer_id), wh, q });
      }
    }
  } catch (e) { notes.push('Ozon: заказы FBS не получены — ' + (e as Error).message); }
  const agg = new Map<string, FboBundle['ozOrders'][number]>();
  for (const o of raw) {
    if (!o.to) continue;
    const k = `${o.art}|${o.to}|${o.from}|${o.fbs}`;
    const v = agg.get(k) ?? { ...o, q: 0 };
    v.q += o.q; agg.set(k, v);
  }

  // Фото и названия: всё, что в остатках, плюс весь каталог (для товаров только в поставках).
  const ozProducts: FboBundle['ozProducts'] = [];
  try {
    const list = await oz('v3/product/list', { filter: { visibility: 'ALL' }, limit: 1000 });
    const pids: string[] = (list.result?.items ?? []).map((x: any) => String(x.product_id));
    for (let i = 0; i < pids.length; i += 1000) {
      const info = await oz('v3/product/info/list', { product_id: pids.slice(i, i + 1000) });
      for (const p of (info.items ?? [])) ozProducts.push({ art: String(p.offer_id), name: String(p.name ?? ''), img: (p.primary_image?.[0]) || (p.images?.[0]) || '' });
    }
  } catch (e) { notes.push('Ozon: каталог не получен — ' + (e as Error).message); }

  return { ozStock, ozClusters, ozSupplies, ozProducts, ozOrders: [...agg.values()], fbsByWh };
}

async function collectWb(notes: string[]) {
  const h = wbHeaders();
  const since30 = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
  // Остатки — асинхронный отчёт: заказать, дождаться, скачать.
  let wbStock: FboBundle['wbStock'] = [];
  try {
    const t = await call('https://seller-analytics-api.wildberries.ru/api/v1/warehouse_remains?groupByNm=true&groupBySa=true', { headers: h });
    const id = t?.data?.taskId;
    for (let i = 0; i < 24; i++) {
      await sleep(5000);
      const s = await call(`https://seller-analytics-api.wildberries.ru/api/v1/warehouse_remains/tasks/${id}/status`, { headers: h });
      if (s?.data?.status === 'done') break;
    }
    const rows: any[] = await call(`https://seller-analytics-api.wildberries.ru/api/v1/warehouse_remains/tasks/${id}/download`, { headers: h });
    wbStock = rows.map(x => ({ vendorCode: String(x.vendorCode ?? ''), nmId: Number(x.nmId), warehouses: (x.warehouses ?? []).map((w: any) => ({ warehouseName: String(w.warehouseName), quantity: Number(w.quantity) || 0 })) }));
  } catch (e) { notes.push('WB: остатки не получены — ' + (e as Error).message); }

  const wbCards: FboBundle['wbCards'] = [];
  try {
    let cursor: any = { limit: 100 };
    for (let i = 0; i < 20; i++) {
      const c = await call('https://content-api.wildberries.ru/content/v2/get/cards/list', { method: 'POST', headers: h, body: JSON.stringify({ settings: { cursor, filter: { withPhoto: -1 } } }) });
      for (const k of (c.cards ?? [])) wbCards.push({ nm: Number(k.nmID), art: String(k.vendorCode ?? ''), name: String(k.title ?? ''), img: k.photos?.[0]?.c246x328 || k.photos?.[0]?.tm || '' });
      if ((c.cards ?? []).length < 100) break;
      cursor = { limit: 100, updatedAt: c.cursor?.updatedAt, nmID: c.cursor?.nmID };
      await sleep(700);
    }
  } catch (e) { notes.push('WB: карточки не получены — ' + (e as Error).message); }

  // Поставки: не принятые + принятые за 14 дней. У supplies-api жёсткий лимит — паузы.
  const wbSupplies: FboBundle['wbSupplies'] = [];
  try {
    const till = new Date().toISOString().slice(0, 10), from = new Date(Date.now() - 90 * 864e5).toISOString().slice(0, 10);
    const sl: any[] = await call('https://supplies-api.wildberries.ru/api/v1/supplies?limit=100&offset=0', { method: 'POST', headers: h, body: JSON.stringify({ dates: [{ from, till, type: 'createDate' }] }) });
    const wanted = sl.filter(x => x.statusID !== 5 || (x.factDate && Date.now() - Date.parse(x.factDate) < 14 * 864e5));
    for (const s of wanted) {
      const id = s.supplyID || s.preorderID, q = s.supplyID ? '' : '?isPreorderID=true';
      await sleep(2200);
      const d = await call(`https://supplies-api.wildberries.ru/api/v1/supplies/${id}${q}`, { headers: h }).catch(() => ({}));
      await sleep(2200);
      const g = await call(`https://supplies-api.wildberries.ru/api/v1/supplies/${id}/goods${q}${q ? '&' : '?'}limit=100`, { headers: h }).catch(() => []);
      wbSupplies.push({
        id: Number(id), status: Number(s.statusID), created: s.createDate, date: s.supplyDate, fact: s.factDate, wh: String(d?.warehouseName ?? ''),
        items: (Array.isArray(g) ? g : []).map((x: any) => ({ art: String(x.vendorCode ?? ''), nm: Number(x.nmID), q: Number(x.quantity) || 0, acc: Number(x.acceptedQuantity) || 0 })),
      });
    }
  } catch (e) { notes.push('WB: поставки не получены — ' + (e as Error).message); }

  let wbOrders: FboBundle['wbOrders'] = [];
  try {
    const ord: any[] = await call(`https://statistics-api.wildberries.ru/api/v1/supplier/orders?dateFrom=${since30}`, { headers: h });
    const agg = new Map<string, FboBundle['wbOrders'][number]>();
    for (const x of ord) {
      if (x.isCancel) continue;
      const fbs = x.warehouseType === 'Склад продавца';
      const k = `${x.supplierArticle}|${x.oblastOkrugName || x.countryName}|${fbs}`;
      const v = agg.get(k) ?? { art: String(x.supplierArticle), okrug: x.oblastOkrugName, country: x.countryName, fbs, q: 0 };
      v.q++; agg.set(k, v);
    }
    wbOrders = [...agg.values()];
  } catch (e) { notes.push('WB: заказы не получены — ' + (e as Error).message); }

  return { wbStock, wbCards, wbSupplies, wbOrders };
}

/** Свои склады (FBS) из таблицы «Склад»: остатки, «едет на склад», заказы WB по «Отгрузке». */
async function collectFbs(notes: string[], ozFbsByWh: { art: string; wh: string; q: number }[]): Promise<FboBundle['fbs']> {
  const id = (process.env.SKLAD_SHEET_ID ?? '').trim();
  const wh = FF_SHEETS.map((name, i) => ({ id: i + 1, name: name.replace(/^ФФ /, ''), own: name === 'Склад Уфа', way: 0 }));
  const idOf = new Map<string, number>(FF_SHEETS.map((n, i) => [n, i + 1]));
  const stock: FboBundle['fbs']['stock'] = [];
  const ord: FboBundle['fbs']['ord'] = [];
  if (!id) { notes.push('Свои склады: не задан SKLAD_SHEET_ID'); return { wh, stock, ord }; }
  for (const name of FF_SHEETS) {
    try {
      const rows = await readSheetRange(id, `'${name}'!A4:M600`);
      const w = wh[idOf.get(name)! - 1];
      for (const r of rows) {
        const art = String(r[2] ?? '').trim();
        if (!art) continue;
        const q = Number(r[12]) || 0, way = Number(r[10]) || 0;
        w.way += way;
        if (q !== 0) stock.push({ art, wh: w.id, q });
      }
    } catch (e) { notes.push(`Свои склады: лист «${name}» не прочитан — ${(e as Error).message}`); }
  }
  // WB по складам — строки «Отгрузка» с номером заказа за 30 дней (их пишет скрипт таблицы).
  try {
    const sh = await readSheetRange(id, "'Отгрузка'!A:G");
    const from = (Date.now() - 30 * 864e5) / 864e5 + 25569; // серийная дата Google
    const agg = new Map<string, number>();
    for (const r of sh.slice(1)) {
      if (!(Number(r[0]) >= from) || String(r[3]) !== 'WB' || !/\d{6,}/.test(String(r[4] ?? ''))) continue;
      const w = idOf.get(String(r[6]).trim()); if (!w) continue;
      const k = `${w}|${String(r[1]).trim()}`;
      agg.set(k, (agg.get(k) ?? 0) + (Number(r[2]) || 0));
    }
    for (const [k, q] of agg) { const [w, art] = k.split('|'); ord.push({ mp: 'w', art, wh: Number(w), q }); }
  } catch (e) { notes.push('Свои склады: лист «Отгрузка» не прочитан — ' + (e as Error).message); }
  // Ozon по складам — из самих заказов Ozon (склад отправки в отправлении).
  const ozAgg = new Map<string, number>();
  for (const o of ozFbsByWh) {
    const name = /КГТ/.test(o.wh) ? 'ФФ Подольск' : o.wh.replace(/^Склад ФФ /, 'ФФ ');
    const w = idOf.get(name); if (!w) continue;
    const k = `${w}|${o.art}`;
    ozAgg.set(k, (ozAgg.get(k) ?? 0) + o.q);
  }
  for (const [k, q] of ozAgg) { const [w, art] = k.split('|'); ord.push({ mp: 'o', art, wh: Number(w), q }); }
  return { wh, stock, ord };
}

let running: Promise<FboBundle> | null = null;

/** Собрать снимок заново (одновременно идёт только один сбор). */
export function collectFbo(): Promise<FboBundle> {
  if (running) return running;
  running = (async () => {
    const t0 = Date.now();
    const notes: string[] = [];
    const [o, w] = await Promise.all([collectOzon(notes), collectWb(notes)]);
    const fbs = await collectFbs(notes, o.fbsByWh);
    const { fbsByWh: _skip, ...ozon } = o;
    const bundle: FboBundle = { at: new Date().toISOString(), ...ozon, ...w, fbs, notes };
    // Пустой снимок (обе площадки не ответили) не затирает прежний.
    if (bundle.ozStock.length || bundle.wbStock.length) await cacheSet(CACHE_KEY, bundle, KEEP_MS);
    console.warn(`[fbo] собрано за ${Math.round((Date.now() - t0) / 1000)} с: Ozon складов-строк ${bundle.ozStock.length}, поставок ${bundle.ozSupplies.length}; WB товаров ${bundle.wbStock.length}, поставок ${bundle.wbSupplies.length}; свои склады ${bundle.fbs.stock.length}${notes.length ? ' · ' + notes.join('; ') : ''}`);
    return bundle;
  })().finally(() => { running = null; });
  return running;
}

export const fboCollecting = () => running !== null;

/** Последний снимок; если он старше FBO_REFRESH_MS — запускает сбор фоном. */
export async function getFbo(): Promise<{ data: FboBundle | null; collecting: boolean; ageMin: number | null }> {
  const entry = await cacheGet<FboBundle>(CACHE_KEY);
  if (ageMs(entry) >= FBO_REFRESH_MS) void collectFbo().catch(e => console.warn('[fbo] сбор не удался:', (e as Error)?.message));
  return { data: entry?.data ?? null, collecting: fboCollecting(), ageMin: entry ? Math.round(ageMs(entry) / 60_000) : null };
}
