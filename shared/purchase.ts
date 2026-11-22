/**
 * «Закупки» (19.11.2026) — расчёт «что, сколько и когда заказать в Китае».
 * Чистые функции без доступа к базе: их проверяет scripts/check-purchase.ts,
 * данные собирает api/_lib/purchase.ts.
 *
 * Правила владельца (ответы 19.11, заметка «Закупки — вводные для нового чата», раздел 8):
 *  • закупочный товар = артикул без хвоста «-DUBL» (дубли WB Global — тот же товар);
 *  • продажи — WB + Ozon Avto Vibe по ФАКТУ (WB Global с 21.11.2026 не берём — с января 2027 уходим; STILTON и ЯМ тоже нет);
 *  • партии хватает на 30–35 дней + страховой запас ~10 дней;
 *  • срок «оплата → ФФ» — по истории трекера Дениса (в среднем ~37 дней до Москвы);
 *  • мелкими заказами не заказываем: не меньше недели продаж и кратно коробке;
 *  • логистика ≈ $2 за кг; курс юаня/доллара вписывает владелец.
 */

export type PurchaseSettings = {
  /** На сколько дней продаж должно хватать партии после прихода. */
  coverDays: number;
  /** Страховой запас, дней. */
  safetyDays: number;
  /** Срок «оплата → приход на ФФ», если по товару нет своей истории в трекере (0 — брать медиану трекера). */
  leadDays: number;
  /** Москва → ФФ, дней (когда в трекере не указано). */
  moscowFfDays: number;
  /** Самый маленький заказ — на столько дней продаж (чтобы не заказывать по 5–10 шт.). */
  minOrderDays: number;
  /** Логистика Китай → Москва, $ за кг. */
  usdPerKg: number;
  /** Курс доллара и юаня, ₽ (вписывает владелец; 0 — курс ЦБ). */
  usd: number;
  cny: number;
  ratesAt: string;
  /** Сезонность: коэффициент спроса по месяцам 1..12 (1 = как сейчас). Запасная — для товаров без сезонности категории. */
  season: number[];
  /** «Увеличить оборачиваемость»: в товаре на складах лежит не меньше стольких ₽ по себестоимости (владелец 22.11: 100 тыс.). */
  turnMin: number;
};

export const DEFAULT_SETTINGS: PurchaseSettings = {
  coverDays: 35, safetyDays: 10, leadDays: 0, moscowFfDays: 4, minOrderDays: 7, usdPerKg: 2,
  usd: 0, cny: 0, ratesAt: '', season: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1], turnMin: 100_000,
};

/** Партия в пути (из трекера закупщика). */
export type TransitLot = {
  order: string; article: string; qty: number; stage: string;
  /** Ожидаемая дата прихода на ФФ (YYYY-MM-DD) или '' — не знаем. */
  eta: string;
  /** Описки в датах трекера, словами. */
  issues: string[];
};

export type PurchaseInput = {
  key: string;
  name: string;
  articles: string[];
  /** Продажи в день по площадкам (факт, только дни в наличии). */
  rate: { wb: number; wbg: number; ozon: number };
  /** Продано за 7/30 дней, шт. — показать рядом. */
  sold7: number; sold30: number;
  /** Сколько дней из 30 товар был в наличии (хоть на одной площадке). */
  inStockDays: number;
  /**
   * Остатки: свои склады/ФФ (FBS, таблица «Склад», вместе с перемещениями между складами) — годятся
   * любой площадке; FBO лежит на складе площадки и продаётся только там (владелец 19.11: с Ozon на WB не перевезти).
   */
  stockFf: number; stockFbo: number;
  fbo: { wb: number; ozon: number };
  /** Едет из Китая (лист «В доставке»). */
  transit: number;
  lots: TransitLot[];
  boxQty: number;
  weightG: number;
  /** Цена у фабрики за шт., ₽ (последняя партия в «В доставке»), и полная себестоимость. */
  factoryPrice: number; landedCost: number;
  /** Свой срок «оплата → ФФ» по истории трекера (0 — нет истории). */
  leadOwn: number; leadSamples: number;
  skip: boolean;
  /** Почему в архиве (или почему нет): plan — по статусу «Плана», hand — отметка владельца в «Закупках». */
  skipBy?: 'plan' | 'hand' | '';
  planStatus: string;
  /** План месяца в штуках (для новинок без истории продаж). */
  planQty: number;
  /** Заказы ₽ по месяцам год назад (WB, отчёт «Культуры Аналитики») — для сезонности товара. */
  history?: Record<string, number>;
  /** Сезонность категории товара по площадкам (лист «Сезонность», подтверждённая двумя годами Вордстата). */
  seasonCat?: { category: string; wb: number[]; ozon: number[]; trendFrom: string };
};

export type Signal = 'late' | 'soon' | 'ok' | 'none' | 'skip';

export type PurchaseRow = PurchaseInput & {
  ratePerDay: number;
  rateBasis: 'fact' | 'plan' | 'none';
  lead: number;
  /** На сколько дней хватит того, что уже на складах, и вместе с тем, что едет. */
  daysOnHand: number | null;
  daysTotal: number | null;
  stockoutDate: string;
  orderBy: string;
  daysToOrder: number | null;
  signal: Signal;
  /** Сколько заказать (если заказывать к дате orderBy или сегодня, если поздно), кратно коробке. */
  qty: number;
  sumFactory: number;
  sumLogistics: number;
  /** Товар кончится раньше, чем приедет партия в пути. */
  gap: { from: string; to: string } | null;
  /** На сколько дней хватит FBO каждой площадки при её продажах (null — продаж там нет). */
  fboDays: { wb: number | null; ozon: number | null };
  /** Сезонные множители спроса: до прихода партии и пока партия продаётся; own — по истории самого товара. */
  season: { now: number; sell: number; own: boolean; by: 'category' | 'history' | 'settings' };
  /** Деньги в товаре по себестоимости: на складах (FBS + FBO) и в пути из Китая. */
  stockMoney: number; transitMoney: number;
  notes: string[];
};

export type PurchaseTotals = { late: number; soon: number; ok: number; sumLate: number; sumSoon: number; sum30: number };

const DAY = 86_400_000;
export const addDays = (d: string, n: number) => new Date(Date.parse(d + 'T00:00:00Z') + n * DAY).toISOString().slice(0, 10);
export const daysBetween = (a: string, b: string) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / DAY);
export const purchaseKey = (article: string) => String(article ?? '').trim().toUpperCase().replace(/-DUBL$/, '');

/**
 * Архив «Закупок» (решение владельца 20.11): главный источник — «План». «Вывод» или архив в «Плане» →
 * не закупаем. Галочка в «Закупках» — исключение поверх «Плана» (true — не закупать, false — закупать, хоть и «Вывод»).
 */
export const planSaysSkip = (status: string) => status === 'Вывод' || status === 'Архив';
export function resolveSkip(planStatus: string, override: boolean | undefined): { skip: boolean; skipBy: 'plan' | 'hand' | '' } {
  if (override !== undefined) return { skip: override, skipBy: 'hand' };
  return planSaysSkip(planStatus) ? { skip: true, skipBy: 'plan' } : { skip: false, skipBy: '' };
}

/** Медиана (для сроков доставки). */
export function median(xs: number[]): number {
  const a = xs.filter(x => Number.isFinite(x)).sort((x, y) => x - y);
  if (!a.length) return 0;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/** Средний сезонный коэффициент на отрезке дат (по дням). */
export function seasonFactor(season: number[], from: string, days: number): number {
  if (!season?.length || days <= 0) return 1;
  let s = 0;
  for (let i = 0; i < days; i++) {
    const m = Number(addDays(from, i).slice(5, 7)) - 1;
    const k = Number(season[m]);
    s += k > 0 ? k : 1;
  }
  return s / days;
}

/**
 * Сезонный множитель по коэффициентам месяцев: среднее за дни [from, from+days) ÷ среднее за последние 30 дней
 * (окно, по которому посчитан темп продаж — его сезон уже «внутри» темпа). 0,6–1,6.
 */
export function seasonRelative(k: number[], today: string, from: string, days: number): number {
  const avgK = (a: string, n: number) => { let s = 0; for (let i = 0; i < n; i++) s += k[Number(addDays(a, i).slice(5, 7)) - 1] || 1; return s / n; };
  if (days <= 0) return 1;
  return Math.min(1.6, Math.max(0.6, avgK(from, days) / avgK(addDays(today, -30), 30)));
}

/**
 * Сезонность товара по его же продажам год назад (заказы ₽ по месяцам, ключ 'YYYY-MM').
 * Коэффициент = среднее «месяц год назад» за дни [from, from+days) ÷ среднее за месяцы, которые год назад
 * приходились на наше окно факта (последние 30 дней). Нет данных или слишком мало — null (тогда берётся
 * общая сезонность из настроек). Рост бизнеса за год тоже попадает в коэффициент, поэтому он ограничен 0,6–1,6.
 */
export function seasonFromHistory(hist: Record<string, number> | undefined, today: string, from: string, days: number): number | null {
  if (!hist || days <= 0) return null;
  const yearAgo = (d: string) => `${Number(d.slice(0, 4)) - 1}${d.slice(4, 7)}`;
  const val = (d: string) => hist[yearAgo(d)];
  let ref = 0, nRef = 0;
  for (let i = 1; i <= 30; i++) { const v = val(addDays(today, -i)); if (!(v > 0)) return null; ref += v; nRef++; }
  ref /= nRef;
  if (ref < 30_000) return null;   // меньше ~30 тыс. ₽ в месяц год назад — не показатель
  // Товар год назад только раскручивался (сейчас продаёт вдвое больше) — его прошлогодний рост
  // выглядел бы как сезон. Такой истории не верим.
  let cur = 0;
  for (let i = 1; i <= 30; i++) cur += hist[addDays(today, -i).slice(0, 7)] ?? 0;
  if (cur / 30 > ref * 2) return null;
  let s = 0;
  for (let i = 0; i < days; i++) { const v = val(addDays(from, i)); if (v === undefined) return null; s += v; }
  return Math.min(1.6, Math.max(0.6, s / days / ref));
}

/** Округлить заказ вверх до коробки. */
export function roundToBox(q: number, box: number): number {
  if (q <= 0) return 0;
  return box > 1 ? Math.ceil(q / box) * box : Math.ceil(q);
}

/**
 * Сколько товара реально продастся за `days` дней: FBS и едущее — любой площадке, а FBO площадки —
 * не больше её собственных продаж за этот срок (остальное там залежится). WB Global — только FBS.
 */
export function usefulStock(x: Pick<PurchaseInput, 'stockFf' | 'transit' | 'fbo' | 'rate'>, days: number, k: number, withTransit = true): number {
  return x.stockFf + (withTransit ? x.transit : 0)
    + Math.min(x.fbo.wb, x.rate.wb * k * days) + Math.min(x.fbo.ozon, x.rate.ozon * k * days);
}

/** Через сколько дней товар кончится с учётом того, что FBO одной площадки другой не поможет. */
export function daysUntilOut(x: Pick<PurchaseInput, 'stockFf' | 'transit' | 'fbo' | 'rate'>, rate: number, k: number, withTransit: boolean): number {
  if (rate <= 0) return Infinity;
  // Остаток, который продаётся, растёт медленнее спроса: ищем первый день, когда спрос его перегонит.
  let lo = 0, hi = 2000;
  if (usefulStock(x, hi, k, withTransit) >= rate * k * hi) return hi;
  while (hi - lo > 0.01) {
    const mid = (lo + hi) / 2;
    if (usefulStock(x, mid, k, withTransit) >= rate * k * mid) lo = mid; else hi = mid;
  }
  return lo;
}

/**
 * Расчёт одной строки.
 *  daysOnHand = (свои склады + FBO) / продажи в день;
 *  дата «заказать до» = сегодня + (всё, включая едущее) / продажи − срок доставки − страховой запас;
 *  к приходу новой партии (сегодня/«заказать до» + срок) на складе должно остаться ≥ страхового запаса,
 *  а партия покрывает ещё coverDays дней → qty = продажи × (cover + safety) − остаток к приходу.
 *  Сезонность умножает продажи на средний коэффициент месяцев, которые партия будет продаваться.
 */
export function calcRow(x: PurchaseInput, s: PurchaseSettings, today: string, leadDefault: number): PurchaseRow {
  const notes: string[] = [];
  const factRate = x.rate.wb + x.rate.wbg + x.rate.ozon;
  let rate = factRate, basis: PurchaseRow['rateBasis'] = factRate > 0 ? 'fact' : 'none';
  if (factRate <= 0 && x.planQty > 0) { rate = x.planQty / 30; basis = 'plan'; notes.push('продаж ещё нет — темп по плану месяца'); }
  const lead = x.leadOwn > 0 && x.leadSamples >= 2 ? Math.round(x.leadOwn) : leadDefault;
  // Темп по плану не делится по площадкам — тогда FBO считаем годным целиком.
  const v = basis === 'plan' ? { ...x, stockFf: x.stockFf + x.fbo.wb + x.fbo.ozon, fbo: { wb: 0, ozon: 0 } } : x;
  const base: PurchaseRow = {
    ...x, ratePerDay: rate, rateBasis: basis, lead, daysOnHand: null, daysTotal: null, stockoutDate: '', orderBy: '', daysToOrder: null,
    signal: x.skip ? 'skip' : 'none', qty: 0, sumFactory: 0, sumLogistics: 0, gap: null, season: { now: 1, sell: 1, own: false, by: 'settings' },
    stockMoney: Math.round((x.stockFf + x.stockFbo) * x.landedCost), transitMoney: Math.round(x.transit * x.landedCost),
    fboDays: { wb: x.rate.wb > 0 ? Math.round(x.fbo.wb / x.rate.wb) : null, ozon: x.rate.ozon > 0 ? Math.round(x.fbo.ozon / x.rate.ozon) : null }, notes,
  };
  if (rate <= 0) {
    if (!x.skip) notes.push('продаж за 30 дней нет — заказ не считаем');
    return base;
  }
  // Продажи впереди с учётом сезонности: на время до прихода и на время продажи партии.
  // 22.11: главная — сезонность категории по площадкам (повторилась два года, без новых трендов); нет её —
  // своя история товара год назад; нет и её — запасные цифры из настроек.
  const sc = x.seasonCat;
  const catK = sc ? (() => {
    const wbW = x.rate.wb + x.rate.wbg, ozW = x.rate.ozon, w = wbW + ozW;
    return sc.wb.map((kw, m) => (w > 0 ? (wbW * kw + ozW * sc.ozon[m]) / w : (kw + sc.ozon[m]) / 2));
  })() : null;
  const ownSeason = !catK && seasonFromHistory(x.history, today, today, 1) !== null;
  const by: PurchaseRow['season']['by'] = catK ? 'category' : ownSeason ? 'history' : 'settings';
  const season = (from: string, days: number) => catK ? seasonRelative(catK, today, from, days)
    : (seasonFromHistory(x.history, today, from, days) ?? seasonFactor(s.season, from, days));
  const kNow = season(today, Math.max(1, lead));
  const daysOnHand = daysUntilOut(v, rate, kNow, false);
  const daysTotal = daysUntilOut(v, rate, kNow, true);
  base.daysOnHand = Math.round(Math.min(daysOnHand, 999));
  base.daysTotal = Math.round(Math.min(daysTotal, 999));
  base.stockoutDate = addDays(today, Math.floor(Math.min(daysTotal, 999)));
  const dOrder = Math.round(Math.min(daysTotal, 999)) - lead - s.safetyDays;
  base.daysToOrder = dOrder;
  const orderDay = dOrder > 0 ? addDays(today, dOrder) : today;
  base.orderBy = addDays(today, dOrder);
  if (!x.skip) base.signal = dOrder <= 0 ? 'late' : dOrder <= 7 ? 'soon' : 'ok';
  // Сколько заказать в день заказа: остаток к приходу партии и спрос на cover + safety.
  // В остаток идёт только то, что продастся: FBO площадки — не больше её продаж за весь срок.
  const tArr = lead + Math.max(0, dOrder);
  const arrive = addDays(orderDay, lead);
  const kSell = season(arrive, s.coverDays + s.safetyDays);
  const horizon = tArr + s.coverDays + s.safetyDays;
  const useful = usefulStock(v, horizon, (kNow * tArr + kSell * (s.coverDays + s.safetyDays)) / horizon, true);
  const leftAtArrival = Math.max(0, useful - rate * kNow * tArr);
  const need = rate * kSell * (s.coverDays + s.safetyDays) - leftAtArrival;
  for (const [mp, label] of [['wb', 'WB'], ['ozon', 'Ozon']] as const) {
    const extra = Math.round(v.fbo[mp] - v.rate[mp] * kSell * horizon);
    if (v.fbo[mp] > 0 && extra > 0) notes.push(`на FBO ${label} лишние ~${extra} шт. (на другую площадку не перевезти)`);
  }
  const minQty = rate * kSell * s.minOrderDays;
  base.qty = need > 0 ? roundToBox(Math.max(need, minQty), x.boxQty) : 0;
  const usd = s.usd > 0 ? s.usd : 0;
  base.sumFactory = Math.round(base.qty * x.factoryPrice);
  base.sumLogistics = Math.round(base.qty * (x.weightG / 1000) * s.usdPerKg * usd);
  if (!x.factoryPrice) notes.push('нет цены фабрики — сумма не посчитана');
  if (!x.weightG) notes.push('в «Складе» нет веса — логистика не посчитана');
  if (!usd) notes.push('не вписан курс доллара — логистика не посчитана');
  // Дыра: свои остатки кончатся раньше, чем приедет партия в пути.
  const etas = x.lots.map(l => l.eta).filter(Boolean).sort();
  if (x.transit > 0 && etas.length && daysOnHand < 999) {
    const out = addDays(today, Math.floor(daysOnHand));
    if (out < etas[0]) base.gap = { from: out, to: etas[0] };
  }
  if (x.inStockDays < 30 && basis === 'fact') notes.push(`в наличии был ${x.inStockDays} дн. из 30 — темп по этим дням`);
  base.season = { now: kNow, sell: kSell, own: ownSeason, by };
  const how = by === 'category' ? `категории «${sc!.category}» (WB и Ozon, повторилась два года по Вордстату)` : by === 'history' ? 'по продажам товара год назад' : 'из настроек';
  if (Math.abs(kNow - 1) > 0.01 || Math.abs(kSell - 1) > 0.01) notes.push(`сезонность ${how}: до прихода ×${kNow.toFixed(2)}, партия ×${kSell.toFixed(2)}`);
  else if (by === 'category') notes.push(`сезонность категории «${sc!.category}»: на эти месяцы спрос обычный (×1)`);
  if (sc?.trendFrom) notes.push(`с ${sc.trendFrom.slice(5, 7)}.${sc.trendFrom.slice(0, 4)} спрос категории вырос в разы — это новый тренд, в сезонность не взят`);
  return base;
}

export function totals(rows: PurchaseRow[]): PurchaseTotals {
  const t: PurchaseTotals = { late: 0, soon: 0, ok: 0, sumLate: 0, sumSoon: 0, sum30: 0 };
  for (const r of rows) {
    const sum = r.sumFactory + r.sumLogistics;
    if (r.signal === 'late') { t.late++; t.sumLate += sum; }
    else if (r.signal === 'soon') { t.soon++; t.sumSoon += sum; }
    else if (r.signal === 'ok') t.ok++;
    if ((r.signal === 'late' || r.signal === 'soon' || r.signal === 'ok') && r.daysToOrder != null && r.daysToOrder <= 30) t.sum30 += sum;
  }
  return t;
}

/** Excel-дата (число дней с 30.12.1899) → YYYY-MM-DD. */
export function serialToDate(v: unknown): string {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 40000 || n > 60000) return '';
  return new Date(Date.UTC(1899, 11, 30) + Math.floor(n) * DAY).toISOString().slice(0, 10);
}

/**
 * Строки трекера закупщика (лист «Tracker», A:AC) → партии в пути и сроки доставки.
 * Столбцы (0-based, проверено 19.11.2026): 0 заказ, 1 дата заявки, 2 название, 3 артикул, 4 кол-во,
 * 9 оплата, 10 срок изгот., 11 готовность, 12 срок до карго, 13 сдача в карго, 14 срок Китай→Москва,
 * 15 прибытие в Москву, 16 куда, 17 срок Москва→ФФ, 18 прибытие на ФФ, 19 статус, 20 следующий этап, 21 план. дата след. этапа.
 */
export function parseTracker(rows: unknown[][], today: string, moscowFfDays: number): { lots: TransitLot[]; leads: Map<string, number[]>; allLeads: number[] } {
  const lots: TransitLot[] = [];
  const leads = new Map<string, number[]>();
  const allLeads: number[] = [];
  const year = Number(today.slice(0, 4));
  for (const r of rows) {
    const article = String(r?.[3] ?? '').trim();
    if (!article) continue;
    const key = purchaseKey(article);
    const status = String(r?.[19] ?? '');
    const d = (i: number) => serialToDate(r?.[i]);
    const ordered = d(1), pay = d(9), ready = d(11), cargo = d(13), moscow = d(15), ff = d(18), next = d(21);
    if (/Доставлено/i.test(status)) {
      if (pay && ff) {
        const L = daysBetween(pay, ff);
        if (L >= 5 && L <= 150) { allLeads.push(L); (leads.get(key) ?? leads.set(key, []).get(key)!).push(L); }
      }
      continue;
    }
    const issues: string[] = [];
    for (const [label, v] of [['оплата', pay], ['готовность', ready], ['карго', cargo], ['Москва', moscow], ['ФФ', ff]] as const) {
      if (v && Number(v.slice(0, 4)) > year + 1) issues.push(`${label}: год ${v.slice(0, 4)}`);
    }
    if (pay && ordered && daysBetween(ordered, pay) < -14) issues.push(`оплата ${fmt(pay)} раньше заявки ${fmt(ordered)}`);
    if (pay && cargo && cargo < pay) issues.push(`карго ${fmt(cargo)} раньше оплаты ${fmt(pay)}`);
    if (moscow && ff && ff < moscow) issues.push(`ФФ ${fmt(ff)} раньше Москвы ${fmt(moscow)}`);
    // Ожидаемый приход на ФФ: факт/план ФФ → Москва + дни до ФФ → план. дата этапа «Москва» + дни до ФФ.
    const ffDays = Number(r?.[17]) > 0 ? Number(r?.[17]) : moscowFfDays;
    let eta = ff;
    if (!eta && moscow) eta = addDays(moscow, ffDays);
    if (!eta && next && /Москв/i.test(String(r?.[20] ?? ''))) eta = addDays(next, ffDays);
    if (!eta && cargo && Number(r?.[14]) > 0) eta = addDays(cargo, Number(r?.[14]) + ffDays);
    if (!eta) issues.push('нет даты прихода');
    lots.push({ order: String(r?.[0] ?? ''), article: key, qty: Number(r?.[4]) || 0, stage: status.replace(/^[^\p{L}]+/u, ''), eta, issues });
  }
  return { lots, leads, allLeads };
}

const fmt = (d: string) => d ? `${d.slice(8, 10)}.${d.slice(5, 7)}` : '';

// ─── Деньги (шаг 2, 19.11.2026) ─────────────────────────────────────────────
/**
 * Хватит ли денег на рекомендованные закупки. Прогноз остатка по дням — из «Финансов» (там уже все выплаты,
 * кредиты, инвесторы и закупки, которые владелец поставил сам). Сверху вычитаем рекомендации раздела:
 * оплата фабрике 100 % в день заказа (владелец 19.11), логистика — к приходу в Москву (срок − дни до ФФ).
 * Если остаток падает ниже неснижаемого (500 000 ₽) — сколько не хватает, к какой дате и во что обойдутся
 * деньги инвестора (25 % годовых) до дня, когда остаток сам вернётся выше порога.
 */
export type CashDay = { date: string; end: number };
export type MoneyPay = { key: string; name: string; date: string; amount: number; kind: 'фабрика' | 'логистика' };
export type MoneyCheck = {
  horizon: string;
  pays: MoneyPay[];
  total: number;
  /** Минимум остатка без рекомендаций и с ними. */
  minBefore: CashDay | null;
  minAfter: CashDay | null;
  /** Первый день ниже порога из-за рекомендаций (или уже без них). */
  firstShort: string | null;
  shortfall: number;
  /** Когда остаток с закупками снова выше порога. */
  backOn: string | null;
  /** Когда начать искать деньги: за 21 день до нехватки (не раньше сегодня). */
  askBy: string | null;
  investCost: number;
  /** Что оплатить можно без нехватки, по очереди срочности. */
  affordable: string[];
  postpone: string[];
};

export function moneyCheck(rows: PurchaseRow[], cash: CashDay[], minBalance: number, today: string, moscowFfDays: number, horizonDays = 60, rate = 0.25): MoneyCheck {
  const horizon = addDays(today, horizonDays);
  const pays: MoneyPay[] = [];
  const order = rows.filter(r => (r.signal === 'late' || r.signal === 'soon' || r.signal === 'ok') && r.qty > 0 && r.daysToOrder !== null && r.daysToOrder <= horizonDays)
    .sort((a, b) => (a.daysToOrder ?? 0) - (b.daysToOrder ?? 0));
  for (const r of order) {
    const d = r.daysToOrder! > 0 ? r.orderBy : today;
    if (r.sumFactory > 0) pays.push({ key: r.key, name: r.name, date: d, amount: r.sumFactory, kind: 'фабрика' });
    if (r.sumLogistics > 0) pays.push({ key: r.key, name: r.name, date: addDays(d, Math.max(0, r.lead - moscowFfDays)), amount: r.sumLogistics, kind: 'логистика' });
  }
  const series = cash.filter(c => c.date >= today && c.date <= addDays(horizon, 60)).map(c => ({ date: c.date, end: Math.round(c.end) }));
  const minOf = (xs: CashDay[]) => xs.reduce<CashDay | null>((a, c) => (!a || c.end < a.end ? c : a), null);
  const paidBy = (d: string, ps: MoneyPay[]) => ps.reduce((s, p) => s + (p.date <= d ? p.amount : 0), 0);
  const after = series.map(c => ({ date: c.date, end: Math.round(c.end - paidBy(c.date, pays)) }));
  const inH = (xs: CashDay[]) => xs.filter(c => c.date <= horizon);
  const minBefore = minOf(inH(series)), minAfter = minOf(inH(after));
  const short = inH(after).find(c => c.end < minBalance) ?? null;
  const shortfall = minAfter && minAfter.end < minBalance ? Math.round(minBalance - minAfter.end) : 0;
  let backOn: string | null = null, investCost = 0;
  if (short && minAfter) {
    backOn = after.find(c => c.date > minAfter.date && c.end >= minBalance)?.date ?? null;
    const days = daysBetween(short.date, backOn ?? addDays(horizon, 60));
    investCost = Math.round(shortfall * rate * days / 365);
  }
  // Что влезает без нехватки: добавляем товары по срочности, пока остаток не уходит ниже порога.
  const affordable: string[] = [], postpone: string[] = [];
  const taken: MoneyPay[] = [];
  for (const r of order) {
    const mine = pays.filter(p => p.key === r.key);
    const test = [...taken, ...mine];
    const ok = inH(series).every(c => c.end - paidBy(c.date, test) >= minBalance || c.end - paidBy(c.date, taken) < minBalance && paidBy(c.date, mine) === 0);
    if (ok) { taken.push(...mine); affordable.push(r.key); } else postpone.push(r.key);
  }
  return {
    horizon, pays, total: pays.reduce((s, p) => s + p.amount, 0), minBefore, minAfter,
    firstShort: short?.date ?? null, shortfall, backOn,
    askBy: short ? (addDays(short.date, -21) < today ? today : addDays(short.date, -21)) : null,
    investCost, affordable, postpone,
  };
}

/**
 * Статус товара для «Закупок» по статусам площадок (21.11.2026). Учитываются только площадки, где товар
 * сейчас виден в «Плане» (есть продажи за 30 дней, остаток или план месяца): старый «Рабочий» там, где
 * товара давно нет и поменять статус негде, не перебивает «Вывод» на живой площадке. Из видимых берётся
 * самый «живой» (Новинка > Рабочий > Вывод > Архив). Нигде не виден — по всем площадкам.
 */
export function mergePlanStatuses(list: { status: string; seen: boolean }[]): string {
  if (!list.length) return '';
  const rank = (x: string) => x === 'Новинка' ? 2 : x === 'Вывод' ? 0 : x === 'Архив' ? -1 : 1;
  const use = list.some(x => x.seen) ? list.filter(x => x.seen) : list;
  return use.reduce((best, x) => rank(x.status) > rank(best) ? x.status : best, use[0].status);
}

/**
 * Закупка, уже стоящая в календаре «Финансов» (21.11.2026): по тексту строки («s2000 pro - 60 шт»,
 * «ULTRA2-KRUG-8-128 - 400 шт») найти товар и количество. Товар — по «модельным» кускам артикула
 * (S2000, ULTRA2, P1800, KRUG…); общие куски (бренд, ёмкость 2KWH, память 8-128) не различают товары.
 * Нужен хотя бы один кусок с цифрой; два товара набрали поровну — не угадываем (null).
 */
const GENERIC = /^(\d+([.,]\d+)?(KWH|W|MAH|ML|МЛ|Л)|\d+)$/;
export function matchCalendarPurchase(descr: string, keys: string[]): { key: string; qty: number } | null {
  const text = ` ${descr.toUpperCase().replace(/[^A-Z0-9А-ЯЁ]+/g, ' ')} `;
  const qm = descr.match(/(\d[\d\s]*)\s*(шт|штук|pcs)/i);
  const qty = qm ? Number(qm[1].replace(/\s/g, '')) : 0;
  if (!(qty > 0)) return null;
  const count = new Map<string, number>();
  const tokensOf = (k: string) => [...new Set(k.toUpperCase().split(/[^A-Z0-9А-ЯЁ]+/).filter(t => t.length >= 4 && !GENERIC.test(t)))];
  for (const k of keys) for (const t of tokensOf(k)) count.set(t, (count.get(t) ?? 0) + 1);
  let best: { key: string; score: number } | null = null, tie = false;
  for (const k of keys) {
    let score = 0, digit = false;
    for (const t of tokensOf(k)) {
      if (!text.includes(` ${t} `)) continue;
      score += t.length / (count.get(t) ?? 1);   // кусок, который есть у многих товаров, почти ничего не решает
      if (/\d/.test(t)) digit = true;
    }
    if (!digit || score < 2) continue;
    if (!best || score > best.score + 1e-9) { best = { key: k, score }; tie = false; }
    else if (Math.abs(score - best.score) < 1e-9) tie = true;
  }
  return best && !tie ? { key: best.key, qty } : null;
}
