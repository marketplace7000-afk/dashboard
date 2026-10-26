/**
 * «Остатки FBO» — расчёты страницы (без отрисовки). Снимок приходит с сервера
 * (api/_lib/fboStocks.ts), здесь он раскладывается по кластерам Ozon / регионам WB.
 *
 * Правила (согласованы с владельцем 20–26.10.2026):
 *  • по кластерам и регионам — только FBO; свои склады (FBS) — отдельным блоком;
 *  • WB: живой остаток России — одна строка «Склад WB РФ» (WB не раскрывает склад);
 *    склады с названиями городов РФ — остановленные, в цифры не входят, только сноской;
 *  • «Где покупают» — заказы за 30 дней, FBO и FBS раздельно; у Ozon ещё «издалека»
 *    (заказ вёз в кластер покупателя склад из другого кластера).
 */

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
  fbs: { wh: { id: number; name: string; own: boolean; way: number }[]; stock: { art: string; wh: number; q: number }[]; ord: { mp: 'w' | 'o'; art: string; wh: number; q: number }[] };
  notes: string[];
};

export type Mp = 'o' | 'w';
export type Kind = 'go' | 'soon' | 'idle' | 'stuck' | 'done';
export type Status = { kind: Kind; label: string; note: string };
export type StockRow = { art: string; name?: string; wh: string; cluster: string; q: number };
export type Supply = { id: string; cluster: string; status: Status; sortDate?: string; from?: string; to?: string; items: { art: string; q: number; name?: string; img?: string }[] };
export type Order = { art: string; q: number; key: string; from?: string; fbs: boolean };
export type Source = {
  mp: Mp; noun: 'кластер' | 'регион';
  stock: StockRow[]; supplies: Supply[]; orders: Order[];
  info: (art: string) => { name?: string; img?: string };
  stopped: Map<string, number>;
};

export const fmt = (n: number) => n.toLocaleString('ru-RU');
export const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);
export const plural = (n: number, a: string, b: string, c: string) => {
  const m = n % 10, h = n % 100;
  return m === 1 && h !== 11 ? a : m >= 2 && m <= 4 && (h < 12 || h > 14) ? b : c;
};
const day = (s?: string | null) => (s ? new Date(s).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }).replace('.', '') : '');

function ozStatus(s: FboBundle['ozSupplies'][number], now: number): Status {
  const slot = day(s.slot);
  switch (s.state) {
    case 'IN_TRANSIT': {
      const d = s.slot ? Math.floor((now - Date.parse(s.slot)) / 864e5) : 0;
      return d > 14
        ? { kind: 'stuck', label: `В пути ${d} ${plural(d, 'день', 'дня', 'дней')}`, note: `отгружена ${slot}, до сих пор не принята` }
        : { kind: 'go', label: 'В пути', note: `отгружена ${slot}` };
    }
    case 'ACCEPTANCE_AT_STORAGE_WAREHOUSE': return { kind: 'go', label: 'Приёмка на складе', note: `привезли ${slot}` };
    case 'ACCEPTED_AT_SUPPLY_WAREHOUSE': return { kind: 'go', label: 'Принята в точке отгрузки', note: `сдана ${slot}` };
    case 'READY_TO_SUPPLY': return { kind: 'soon', label: 'Готова к отгрузке', note: `отгрузка ${slot}` };
    case 'REPORTS_CONFIRMATION_AWAITING': return { kind: 'soon', label: 'Принята, ждёт подтверждения акта', note: 'подтвердите акт приёмки в кабинете Ozon' };
    case 'REPORT_REJECTED': return { kind: 'stuck', label: 'Акт приёмки оспорен', note: 'идёт разбор расхождений' };
    case 'DATA_FILLING': return { kind: 'idle', label: 'Заполняется', note: `слот ${slot}, ещё не отправлена` };
    default: return { kind: 'idle', label: s.state, note: '' };
  }
}
function wbStatus(s: FboBundle['wbSupplies'][number]): Status {
  switch (s.status) {
    case 1: return { kind: 'idle', label: 'Черновик', note: `создан ${day(s.created)}, дата не назначена — не едет` };
    case 2: return { kind: 'soon', label: 'Запланирована', note: `на ${day(s.date)}` };
    case 3: return { kind: 'soon', label: 'Отгрузка разрешена', note: `отгрузка ${day(s.date)}` };
    case 4: return { kind: 'go', label: 'Идёт приёмка', note: `с ${day(s.date)}` };
    case 5: return { kind: 'done', label: 'Принята', note: `принята ${day(s.fact)}` };
    case 6: return { kind: 'go', label: 'Отгружена на воротах', note: day(s.date) };
    default: return { kind: 'idle', label: 'Статус ' + s.status, note: '' };
  }
}

/** «НИЖНИЙ_НОВГОРОД_2_РФЦ» → «Нижний Новгород 2». */
function prettyOzon(n: string): string {
  let s = n.replace(/_(М?РФЦ|МПСЦ)(_НОВЫЙ)?$/i, '').replace(/_/g, ' ').toLowerCase();
  s = s.replace(/(^|[\s-])([а-яё])/g, (_m, a, b) => a + b.toUpperCase());
  return s.replace(/^Спб/, 'СПб').replace('Ростов На Дону', 'Ростов-на-Дону').replace('Санкт Петербург', 'Санкт-Петербург');
}

export function buildOzon(D: FboBundle): Source {
  const whCluster = new Map<string, string>(), macro = new Map<number, string>();
  for (const c of D.ozClusters) { macro.set(c.macro, c.name); for (const w of c.wh) whCluster.set(w.toUpperCase(), c.name); }
  const prod = new Map(D.ozProducts.map(p => [p.art.toUpperCase(), p]));
  const now = Date.parse(D.at);
  return {
    mp: 'o', noun: 'кластер', stopped: new Map(),
    stock: D.ozStock.map(r => ({
      art: r.item_code, name: r.item_name, wh: prettyOzon(r.warehouse_name),
      cluster: whCluster.get(r.warehouse_name.toUpperCase()) || 'Другие страны',
      q: r.free_to_sell_amount + r.reserved_amount,
    })).filter(r => r.q > 0),
    supplies: D.ozSupplies.map(s => ({
      id: s.num, cluster: macro.get(s.macro) || 'Кластер ' + s.macro, status: ozStatus(s, now), sortDate: s.slot,
      from: s.drop ? prettyOzon(s.drop.replace(/_КРОССДОКИНГ|_ХАБ(_ДО)?/g, '')) : '',
      items: s.items.map(i => ({ art: i.art, q: i.q, name: i.name, img: i.icon })),
    })),
    orders: D.ozOrders.filter(o => o.to).map(o => ({ art: o.art, q: o.q, key: o.to, from: o.from, fbs: o.fbs })),
    info: art => { const p = prod.get(art.toUpperCase()); return { name: p?.name, img: p?.img }; },
  };
}

export const WB_RUSSIA = 'Россия — все склады WB';
const WB_ABROAD: [RegExp, string][] = [[/великий камень|минск|брест/i, 'Беларусь'], [/ереван/i, 'Армения'], [/астана|алматы|караганд/i, 'Казахстан'], [/бишкек/i, 'Киргизия']];
const wbLive = (n: string) => /^Склад WB (СГТ )?РФ$/.test(n) || WB_ABROAD.some(([re]) => re.test(n));
const wbRegion = (n: string) => (WB_ABROAD.find(([re]) => re.test(n)) ?? [null, WB_RUSSIA])[1];
const WB_SKIP = new Set(['В пути до получателей', 'В пути возвраты на склад WB', 'Всего находится на складах']);
const OKRUG: Record<string, string> = {
  'Центральный федеральный округ': 'Центр', 'Северо-Западный федеральный округ': 'Северо-Запад',
  'Южный федеральный округ': 'Юг', 'Северо-Кавказский федеральный округ': 'Северный Кавказ',
  'Приволжский федеральный округ': 'Поволжье', 'Уральский федеральный округ': 'Урал',
  'Сибирский федеральный округ': 'Сибирь', 'Дальневосточный федеральный округ': 'Дальний Восток',
};

export function buildWb(D: FboBundle): Source {
  const card = new Map(D.wbCards.map(c => [c.art.toUpperCase(), c]));
  const byNm = new Map(D.wbCards.map(c => [c.nm, c]));
  const stock: StockRow[] = [], stopped = new Map<string, number>();
  for (const r of D.wbStock) for (const w of r.warehouses) {
    if (WB_SKIP.has(w.warehouseName) || w.quantity <= 0) continue;
    if (!wbLive(w.warehouseName)) { stopped.set(w.warehouseName, (stopped.get(w.warehouseName) ?? 0) + w.quantity); continue; }
    const wh = /РФ$/.test(w.warehouseName) ? w.warehouseName : w.warehouseName.replace(/^СК /, '').replace(' Карагандинское шоссе', '');
    stock.push({ art: r.vendorCode || byNm.get(r.nmId)?.art || 'WB ' + r.nmId, wh, cluster: wbRegion(w.warehouseName), q: w.quantity });
  }
  return {
    mp: 'w', noun: 'регион', stock, stopped,
    // В некоторых поставках WB не присылает артикул — берём его из карточки по номеру WB.
    supplies: D.wbSupplies.map(s => ({
      id: String(s.id), cluster: wbRegion(s.wh), status: wbStatus(s), sortDate: s.fact || s.date || s.created || '',
      to: s.wh.replace(/: .*/, ''),
      items: s.items.map(i => ({ art: i.art || byNm.get(i.nm)?.art || 'WB ' + i.nm, q: s.status === 5 && i.acc ? i.acc : i.q })),
    })),
    orders: D.wbOrders.map(o => ({ art: o.art, q: o.q, fbs: o.fbs, key: (o.okrug && OKRUG[o.okrug]) || o.okrug || o.country || 'Не указан' })),
    info: art => { const c = card.get(art.toUpperCase()); return { name: c?.name, img: c?.img }; },
  };
}

export type ClusterRow = { name: string; q: number; whs: Map<string, number>; go: number; soon: number; idle: number; done: number; ord: number };

export function clustersOf(src: Source): ClusterRow[] {
  const map = new Map<string, ClusterRow>();
  const get = (n: string) => { if (!map.has(n)) map.set(n, { name: n, q: 0, whs: new Map(), go: 0, soon: 0, idle: 0, done: 0, ord: 0 }); return map.get(n)!; };
  for (const r of src.stock) { const c = get(r.cluster); c.q += r.q; c.whs.set(r.wh, (c.whs.get(r.wh) ?? 0) + r.q); }
  for (const s of src.supplies) {
    const c = get(s.cluster); const n = s.items.reduce((a, i) => a + i.q, 0);
    c[s.status.kind === 'stuck' ? 'go' : s.status.kind] += n;
  }
  // У Ozon кластер покупателя — тот же кластер, что у склада: спрос рядом с остатком.
  if (src.mp === 'o') for (const o of src.orders) get(o.key).ord += o.q;
  return [...map.values()].sort((a, b) => b.q - a.q || (b.go + b.soon) - (a.go + a.soon));
}

export type DemandRow = { key: string; q: number; fbo: number; far: number; from: Map<string, number> };

export function demandRows(orders: Order[]): DemandRow[] {
  const m = new Map<string, DemandRow>();
  for (const o of orders) {
    if (!m.has(o.key)) m.set(o.key, { key: o.key, q: 0, fbo: 0, far: 0, from: new Map() });
    const r = m.get(o.key)!; r.q += o.q; if (!o.fbs) r.fbo += o.q;
    if (o.from && o.from !== o.key) { r.far += o.q; r.from.set(o.from, (r.from.get(o.from) ?? 0) + o.q); }
  }
  return [...m.values()].sort((a, b) => b.q - a.q);
}

export const KIND_ORDER: Record<Kind, number> = { stuck: 0, go: 1, soon: 2, idle: 3, done: 4 };

export type Item = {
  art: string; name: string; img?: string; q: number; whs: [string, number][];
  lines: { s: Supply; q: number }[];
};

/** Карточки товаров для выбранного кластера/склада: остаток здесь + что сюда едет. */
export function itemsFor(src: Source, cluster: string | null, wh: string | null, query: string): { items: Item[]; supplies: Supply[] } {
  const inCl = (c: string) => !cluster || c === cluster;
  const stock = src.stock.filter(r => inCl(r.cluster) && (!wh || r.wh === wh));
  const supplies = wh ? [] : src.supplies.filter(s => inCl(s.cluster));
  const acc = new Map<string, { art: string; q: number; whs: Map<string, number>; lines: Item['lines']; name?: string; img?: string }>();
  const get = (art: string) => { const k = art.toUpperCase(); if (!acc.has(k)) acc.set(k, { art, q: 0, whs: new Map(), lines: [] }); return acc.get(k)!; };
  for (const r of stock) { const it = get(r.art); it.q += r.q; it.whs.set(r.wh, (it.whs.get(r.wh) ?? 0) + r.q); it.name ||= r.name; }
  for (const s of supplies) for (const i of s.items) { const it = get(i.art); it.lines.push({ s, q: i.q }); it.name ||= i.name; it.img ||= i.img; }
  const q = query.trim().toLowerCase();
  const items: Item[] = [...acc.values()].map(it => {
    const inf = src.info(it.art);
    return {
      art: it.art, name: inf.name || it.name || it.art, img: inf.img || it.img, q: it.q,
      whs: [...it.whs].sort((a, b) => b[1] - a[1]),
      lines: it.lines.sort((a, b) => KIND_ORDER[a.s.status.kind] - KIND_ORDER[b.s.status.kind]),
    };
  }).filter(it => !q || it.name.toLowerCase().includes(q) || it.art.toLowerCase().includes(q));
  const going = (it: Item) => it.lines.reduce((a, l) => a + l.q, 0);
  items.sort((a, b) => b.q - a.q || going(b) - going(a));
  return { items, supplies };
}
