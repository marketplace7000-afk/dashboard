/**
 * «Остатки» (до 28.10.2026 — «Остатки FBO») — расчёты страницы (без отрисовки). Снимок приходит с сервера
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
  ozOrders: { art: string; to: string; from: string; fbs: boolean; q: number; w7?: boolean }[];
  wbStock: { vendorCode: string; nmId: number; warehouses: { warehouseName: string; quantity: number }[] }[];
  wbCards: { nm: number; art: string; name: string; img: string }[];
  wbSupplies: { id: number; status: number; created?: string; date?: string | null; fact?: string | null; wh: string; items: { art: string; nm: number; q: number; acc: number }[] }[];
  wbOrders: { art: string; okrug?: string; country?: string; fbs: boolean; q: number; w7?: boolean }[];
  fbs: { wh: { id: number; name: string; own: boolean; way: number }[]; stock: { art: string; wh: number; q: number }[]; ord: { mp: 'w' | 'o'; art: string; wh: number; q: number }[] };
  notes: string[];
};

export type Mp = 'o' | 'w';
export type Kind = 'go' | 'soon' | 'idle' | 'stuck' | 'done';
/** inStock — товар поставки уже принят и лежит в остатке FBO (акт ещё не подписан): в «едет» не считаем (28.10.2026). */
export type Status = { kind: Kind; label: string; note: string; short?: string; inStock?: boolean };

/** Короткие названия длинных кластеров для таблицы (полные — в подсказках и подробностях). */
const SHORT_PLACE: Record<string, string> = {
  'Москва, МО и Дальние регионы': 'Москва и МО',
  'Санкт-Петербург и СЗО': 'СПб и СЗО',
  'Россия — все склады WB': 'Россия (Склад WB РФ)',
};
export const shortPlace = (s: string) => SHORT_PLACE[s] ?? s;
export type StockRow = { art: string; name?: string; wh: string; cluster: string; q: number };
export type Supply = { id: string; cluster: string; status: Status; sortDate?: string; from?: string; to?: string; items: { art: string; q: number; name?: string; img?: string }[] };
/** w7 — заказ за последние 7 дней (снимки до 28.10.2026 этого не знают — там 0). */
export type Order = { art: string; q: number; key: string; from?: string; fbs: boolean; w7: boolean };
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
        ? { kind: 'stuck', label: `В пути ${d} ${plural(d, 'день', 'дня', 'дней')}`, short: `В пути ${d} дн`, note: `отгружена ${slot}, до сих пор не принята` }
        : { kind: 'go', label: 'В пути', note: `отгружена ${slot}` };
    }
    case 'ACCEPTANCE_AT_STORAGE_WAREHOUSE': return { kind: 'go', label: 'Приёмка на складе', short: 'Приёмка', note: `привезли ${slot}` };
    case 'ACCEPTED_AT_SUPPLY_WAREHOUSE': return { kind: 'go', label: 'Принята в точке отгрузки', short: 'Сдана', note: `сдана ${slot}` };
    case 'READY_TO_SUPPLY': return { kind: 'soon', label: 'Готова к отгрузке', short: 'К отгрузке', note: `отгрузка ${slot}` };
    // Проверено 28.10 по снимку: товар таких поставок уже в остатке кластера (BOARD-JSK-X08, Краснодар: 20 в поставке = 20 на FBO).
    case 'REPORTS_CONFIRMATION_AWAITING': return { kind: 'soon', label: 'Принята, ждёт подтверждения акта', short: 'Ждёт акта', note: 'подтвердите акт приёмки в кабинете Ozon', inStock: true };
    case 'REPORT_REJECTED': return { kind: 'stuck', label: 'Акт приёмки оспорен', short: 'Акт оспорен', note: 'идёт разбор расхождений', inStock: true };
    case 'DATA_FILLING': return { kind: 'idle', label: 'Заполняется', note: `слот ${slot}, ещё не отправлена` };
    default: return { kind: 'idle', label: s.state, note: '' };
  }
}
function wbStatus(s: FboBundle['wbSupplies'][number]): Status {
  switch (s.status) {
    case 1: return { kind: 'idle', label: 'Черновик', note: `создан ${day(s.created)}, дата не назначена — не едет` };
    case 2: return { kind: 'soon', label: 'Запланирована', note: `на ${day(s.date)}` };
    case 3: return { kind: 'soon', label: 'Отгрузка разрешена', short: 'Разрешена', note: `отгрузка ${day(s.date)}` };
    case 4: return { kind: 'go', label: 'Идёт приёмка', short: 'Приёмка', note: `с ${day(s.date)}` };
    case 5: return { kind: 'done', label: 'Принята', note: `принята ${day(s.fact)}` };
    case 6: return { kind: 'go', label: 'Отгружена на воротах', short: 'На воротах', note: day(s.date) };
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
    orders: D.ozOrders.filter(o => o.to).map(o => ({ art: o.art, q: o.q, key: o.to, from: o.from, fbs: o.fbs, w7: !!o.w7 })),
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
    orders: D.wbOrders.map(o => ({ art: o.art, q: o.q, fbs: o.fbs, w7: !!o.w7, key: (o.okrug && OKRUG[o.okrug]) || o.okrug || o.country || 'Не указан' })),
    info: art => { const c = card.get(art.toUpperCase()); return { name: c?.name, img: c?.img }; },
  };
}

export type ClusterRow = { name: string; q: number; whs: Map<string, number>; go: number; soon: number; idle: number; done: number; ord: number };

export function clustersOf(src: Source): ClusterRow[] {
  const map = new Map<string, ClusterRow>();
  const get = (n: string) => { if (!map.has(n)) map.set(n, { name: n, q: 0, whs: new Map(), go: 0, soon: 0, idle: 0, done: 0, ord: 0 }); return map.get(n)!; };
  for (const r of src.stock) { const c = get(r.cluster); c.q += r.q; c.whs.set(r.wh, (c.whs.get(r.wh) ?? 0) + r.q); }
  for (const s of src.supplies) {
    if (s.status.inStock) continue; // уже в остатке кластера
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



// ───────── Строки таблицы: один товар — одна строка (27.10.2026) ─────────

/** Данные товара по одному кластеру (Ozon) / региону (WB) — для раскрытия строки. */
export type PlaceRow = {
  key: string; stock: number; whs: [string, number][];
  ordFbo: number; ordFbs: number; far: number; from: [string, number][];
  ord7Fbo: number; ord7Fbs: number;
  going: number; lines: { s: Supply; q: number }[];
};

export type ProductRow = {
  art: string; name: string; img?: string;
  /** FBO в выбранном кластере (или всего). */
  fbo: number;
  /** Где лежит FBO: кластер (при «все») или склад (при выбранном кластере) → шт. */
  where: [string, number][];
  /** Заказы за 30 и за 7 дней в выбранном кластере (или все). */
  ordFbo: number; ordFbs: number; far: number;
  ord7Fbo: number; ord7Fbs: number;
  /** Где покупают: кластер/округ покупателя → шт (по всем заказам товара). */
  buyers: [string, number][];
  /** Поставки в выбранный кластер (или все), без черновиков в сумме «едет». */
  lines: { s: Supply; q: number }[]; going: number;
  /** Сколько поставок сейчас едет или готовится (без черновиков, принятых и «ждёт акта»). */
  goingN: number;
  /** Свои склады (FBS) из таблицы «Склад»: склад → шт. */
  fbs: [string, number][]; fbsTotal: number;
  /**
   * Запас в днях при темпе заказов за 30 дней (28.10.2026, просьба владельца — один прогноз по FBO и FBS):
   *  fboDays — FBO этой площадки ÷ её заказы FBO;
   *  fbsDays — свои склады ÷ заказы FBS обеих площадок (склады общие для WB и Ozon);
   *  days — всё вместе: (FBO + FBS) ÷ (заказы FBO + заказы FBS обеих площадок).
   * При выбранном кластере FBS к кластеру не относится — days считается только по FBO кластера.
   */
  days: number | null; fboDays: number | null; fbsDays: number | null;
  /** Раскрытие строки: по каждому кластеру/региону. */
  places: PlaceRow[];
};

export type SortKey = 'fbo' | 'orders' | 'orders7' | 'fbs' | 'days' | 'going' | 'name';
export type RowFilter = 'all' | 'instock' | 'short';

const up = (s: string) => s.toUpperCase();

export function productRows(src: Source, D: FboBundle, cluster: string | null): ProductRow[] {
  const inCl = (c: string) => !cluster || c === cluster;
  const ffName = new Map(D.fbs.wh.map(w => [w.id, w.own ? w.name : `ФФ ${w.name}`]));
  const acc = new Map<string, { art: string; name?: string; img?: string }>();
  const touch = (art: string, name?: string, img?: string) => {
    const k = up(art); const v = acc.get(k) ?? { art };
    v.name ||= name; v.img ||= img; acc.set(k, v);
  };
  // Товар попадает в список, если в выбранном месте у него есть остаток FBO, поставка или заказы.
  for (const r of src.stock) if (inCl(r.cluster)) touch(r.art, r.name);
  for (const s of src.supplies) if (inCl(s.cluster)) for (const i of s.items) touch(i.art, i.name, i.img);
  // У WB заказ знает только округ покупателя, а не склад — к региону склада не привязываем.
  for (const o of src.orders) if (src.mp === 'w' || inCl(o.key)) touch(o.art);

  return [...acc.values()].map(({ art, name, img }) => {
    const k = up(art);
    const stock = src.stock.filter(r => up(r.art) === k);
    const orders = src.orders.filter(o => up(o.art) === k);
    const sups = src.supplies.flatMap(s => s.items.filter(i => up(i.art) === k).map(i => ({ s, q: i.q })));

    // По местам (кластер/регион) — для раскрытия.
    const places = new Map<string, PlaceRow>();
    const place = (key: string) => {
      if (!places.has(key)) places.set(key, { key, stock: 0, whs: [], ordFbo: 0, ordFbs: 0, far: 0, from: [], ord7Fbo: 0, ord7Fbs: 0, going: 0, lines: [] });
      return places.get(key)!;
    };
    const whMap = new Map<string, Map<string, number>>(), fromMap = new Map<string, Map<string, number>>();
    for (const r of stock) {
      const p = place(r.cluster); p.stock += r.q;
      const m = whMap.get(r.cluster) ?? new Map(); m.set(r.wh, (m.get(r.wh) ?? 0) + r.q); whMap.set(r.cluster, m);
    }
    const wbBuyers = new Map<string, number>();
    let wbFbo = 0, wbFbs = 0, wb7Fbo = 0, wb7Fbs = 0;
    for (const o of orders) {
      if (src.mp === 'w') {
        wbBuyers.set(o.key, (wbBuyers.get(o.key) ?? 0) + o.q);
        if (o.fbs) { wbFbs += o.q; if (o.w7) wb7Fbs += o.q; } else { wbFbo += o.q; if (o.w7) wb7Fbo += o.q; }
        continue;
      }
      const p = place(o.key);
      if (o.fbs) p.ordFbs += o.q; else p.ordFbo += o.q;
      if (o.w7) { if (o.fbs) p.ord7Fbs += o.q; else p.ord7Fbo += o.q; }
      if (o.from && o.from !== o.key) {
        p.far += o.q;
        const m = fromMap.get(o.key) ?? new Map(); m.set(o.from, (m.get(o.from) ?? 0) + o.q); fromMap.set(o.key, m);
      }
    }
    const isGoing = (st: Status) => st.kind !== 'idle' && st.kind !== 'done' && !st.inStock;
    for (const l of sups) { const p = place(l.s.cluster); p.lines.push(l); if (isGoing(l.s.status)) p.going += l.q; }
    for (const p of places.values()) {
      p.whs = [...(whMap.get(p.key) ?? new Map())].sort((a, b) => b[1] - a[1]);
      p.from = [...(fromMap.get(p.key) ?? new Map())].sort((a, b) => b[1] - a[1]);
      p.lines.sort((a, b) => KIND_ORDER[a.s.status.kind] - KIND_ORDER[b.s.status.kind]);
    }

    const scope = cluster ? [places.get(cluster)].filter(Boolean) as PlaceRow[] : [...places.values()];
    const sum = (f: (p: PlaceRow) => number) => scope.reduce((a, p) => a + f(p), 0);
    const fbo = sum(p => p.stock), far = sum(p => p.far), going = sum(p => p.going);
    const ordFbo = src.mp === 'w' ? wbFbo : sum(p => p.ordFbo), ordFbs = src.mp === 'w' ? wbFbs : sum(p => p.ordFbs);
    const ord7Fbo = src.mp === 'w' ? wb7Fbo : sum(p => p.ord7Fbo), ord7Fbs = src.mp === 'w' ? wb7Fbs : sum(p => p.ord7Fbs);
    const where: [string, number][] = cluster
      ? (places.get(cluster)?.whs ?? [])
      : [...places.values()].filter(p => p.stock > 0).map(p => [p.key, p.stock] as [string, number]).sort((a, b) => b[1] - a[1]);
    const buyers: [string, number][] = (src.mp === 'w' ? [...wbBuyers] : [...places.values()].map(p => [p.key, p.ordFbo + p.ordFbs] as [string, number]))
      .filter(x => x[1] > 0).sort((a, b) => b[1] - a[1]);
    const fbsRows = D.fbs.stock.filter(r => up(r.art) === k && r.q !== 0).sort((a, b) => b.q - a.q).map(r => [ffName.get(r.wh) ?? '?', r.q] as [string, number]);
    const inf = src.info(art);
    const fbsTotal = fbsRows.reduce((a, r) => a + r[1], 0);
    // Свои склады общие для WB и Ozon: к заказам FBS этой площадки добавляем FBS-заказы другой (по таблице «Склад»).
    const otherFbs = D.fbs.ord.filter(o => o.mp !== src.mp && up(o.art) === k).reduce((a, o) => a + o.q, 0);
    const rateFbo = ordFbo / 30, rateFbs = (ordFbs + otherFbs) / 30;
    const daysOf = (stock: number, rate: number) => (rate > 0 ? Math.round(stock / rate) : null);
    const fboDays = daysOf(fbo, rateFbo), fbsDays = daysOf(Math.max(0, fbsTotal), rateFbs);
    const scopeLines = scope.flatMap(p => p.lines).sort((a, b) => KIND_ORDER[a.s.status.kind] - KIND_ORDER[b.s.status.kind]);
    return {
      art, name: inf.name || name || art, img: inf.img || img,
      fbo, where, ordFbo, ordFbs, far, buyers, ord7Fbo, ord7Fbs,
      lines: scopeLines, going,
      goingN: new Set(scopeLines.filter(l => isGoing(l.s.status)).map(l => l.s.id)).size,
      fbs: fbsRows, fbsTotal,
      fboDays, fbsDays,
      days: cluster ? fboDays : daysOf(fbo + Math.max(0, fbsTotal), rateFbo + rateFbs),
      places: [...places.values()].sort((a, b) => (b.stock + b.ordFbo + b.ordFbs) - (a.stock + a.ordFbo + a.ordFbs)),
    };
  });
}

export function sortRows(rows: ProductRow[], key: SortKey, desc: boolean): ProductRow[] {
  const v = (r: ProductRow): number | string => {
    switch (key) {
      case 'fbo': return r.fbo;
      case 'orders': return r.ordFbo + r.ordFbs;
      case 'orders7': return r.ord7Fbo + r.ord7Fbs;
      case 'fbs': return r.fbsTotal;
      case 'going': return r.going;
      case 'days': return r.days ?? (desc ? -1 : Infinity);
      case 'name': return r.name.toLowerCase();
    }
  };
  return rows.slice().sort((a, b) => {
    const x = v(a), y = v(b);
    const c = typeof x === 'string' ? x.localeCompare(String(y)) : (x as number) - (y as number);
    return (desc ? -c : c) || (b.fbo - a.fbo) || ((b.ordFbo + b.ordFbs) - (a.ordFbo + a.ordFbs));
  });
}

export function filterRows(rows: ProductRow[], f: RowFilter, query: string): ProductRow[] {
  const q = query.trim().toLowerCase();
  return rows.filter(r =>
    (!q || r.name.toLowerCase().includes(q) || r.art.toLowerCase().includes(q)) &&
    (f === 'all' || (f === 'instock' ? r.fbo > 0 : r.fbo === 0 && r.ordFbo + r.ordFbs > 0)));
}
