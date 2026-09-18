/**
 * ЭКОНОМИКА ТОВАРА — одна точка сборки входных данных для расчёта прибыли.
 *
 * Зачем этот модуль появился. Платформа выросла как надстройка над таблицей
 * клиента: список товаров собирался из листа `Ozon_wb`, экономика бралась
 * оттуда же. Потом таблицы цен переехали на живые API маркетплейсов, а
 * экономика осталась в таблице — и склейка держалась на том, что артикул
 * присутствует в обоих местах. Новый товар появляется в API сразу, а в листе
 * только когда его туда впишут руками. С этого момента строка на экране есть,
 * а себестоимости, комиссии и ДРР у неё нет.
 *
 * Отсюда выросли сразу несколько жалоб клиента 29.08: «для новых товаров не
 * подтягивается себестоимость», «ДРР у всех 7%», «нет расчёта для части
 * позиций». Это не разные баги, а один: не был определён источник истины.
 *
 * Здесь он определён. Экономика собирается ПО АРТИКУЛУ, независимо от того,
 * попал ли товар в чью-то таблицу, и каждое поле несёт признак происхождения.
 *
 * Два правила, ради которых всё это и делается:
 *
 *  1. НЕТ ДАННЫХ — ЭТО NULL, А НЕ ДЕФОЛТ. Раньше неизвестный ДРР превращался в
 *     7%, а неизвестная комиссия в 25%: цифра выглядела посчитанной, хотя была
 *     выдумана. По таким цифрам принимают решения о закупке.
 *
 *  2. «РЕКЛАМЫ НЕ БЫЛО» И «ДРР НЕИЗВЕСТЕН» — РАЗНЫЕ ВЕЩИ. Первое это честный
 *     ноль, второе это отсутствие данных. Смешивать их нельзя: в первом случае
 *     прибыль выше, во втором мы просто не знаем.
 */
import { getCosts, normSku } from './costs';
import { getWbCardEcon } from './wbCardEcon';
import { getWbBoxTariffs } from './wbBoxTariffs';
import { collectAdsBySku } from './agents/adsAdvisor';
import { getTotalRevenue } from './ads/totalRevenue';
import { getLogisticsFactCached, type FactItem } from './logisticsFact';
import { getSettings, type Fulfilment } from './settings';
import { cacheGet, makeUpstreamCacheKey } from './cache';
import { noteSwallowed } from './log';

/** Откуда взялось значение. Показывается в интерфейсе, чтобы цифру можно было оспорить. */
export type Origin =
  | 'reference'      // наш справочник себестоимости
  | 'marketplace'    // живой API площадки
  | 'tariffs'        // тарифы площадки (комиссия, логистика, хранение)
  | 'client-table'   // таблица комиссий из калькулятора клиента
  | 'ads-report'     // отчёт по рекламе
  | 'fact-report'   // факт из финансовых отчётов площадки (логистика, выкуп)
  | 'store-avg'     // среднее по магазину — по товару данных мало
  | 'no-ads'         // реклама достоверно не велась → честный ноль
  | 'none';          // данных нет, значение null

export type Val = { value: number | null; origin: Origin; note?: string };

const none = (note: string): Val => ({ value: null, origin: 'none', note });
const val = (value: number, origin: Origin, note?: string): Val => ({ value, origin, note });

export type ProductEcon = {
  sku: string;
  nmId?: number;
  cost: Val;
  drr: Val;
  commissionPct: Val;
  logisticRub: Val;
  storageRub: Val;
  /** ДРР за оба окна и что из них взято в расчёт (16.09.2026: база — 7 дн, при <5 заказах — 30 дн, иначе среднее по магазину). */
  drr7: number | null;
  drr30: number | null;
  orders7: number;
  drrPick: '7d' | '30d' | 'store' | 'none';
  /** Факт из финотчётов за 30 дн: прямая логистика ₽/доставка, обратная ₽/проданная шт, выкуп %. */
  logisticFact: Val;
  returnFact: Val;
  buyoutFact: Val;
};

export type EconReport = {
  fulfilment: { wb: Fulfilment; ozon: Fulfilment };
  wb: Record<string, ProductEcon>;    // ключ — vendorCode (UPPER)
  ozon: Record<string, ProductEcon>;  // ключ — offer_id (UPPER)
  /** Чего не хватило целиком — чтобы пустые колонки были объяснимы. */
  diagnostics: string[];
  generatedAt: number;
  /** Средний ДРР магазина (расход на рекламу / выручка по всем кампаниям) за 7 и 30 дн, % — для сводки «Цены». */
  storeDrr: { wb: { d7: number | null; d30: number | null }; ozon: { d7: number | null; d30: number | null } };
};

// ─── Реклама ────────────────────────────────────────────────────────────────

type AdsIndex = {
  /** Есть ли вообще данные по площадке. Без этого «нет в списке» ничего не значит. */
  available: boolean;
  byKey: Map<string, number>;   // ключ → ДРР, %
  /** Средний ДРР площадки за окно: Σрасход / Σвыручка по всем заказам. */
  avgDrr: number | null;
};

/**
 * ДРР по товарам. Ключ для WB — nmId, для Ozon — артикул продавца.
 *
 * `available` принципиально важен. Если отчёт не собрался, отсутствие товара в
 * нём НЕ означает, что рекламы не было: мы просто не знаем. Именно на этом
 * различии и держится правило 2 из шапки модуля.
 */
async function loadAds(days: number): Promise<{ wb: AdsIndex; ozon: AdsIndex }> {
  const empty = { available: false, byKey: new Map<string, number>(), avgDrr: null as number | null };
  try {
    const r = await collectAdsBySku(days);
    const wb: AdsIndex = { available: !!r.sources?.wb, byKey: new Map(), avgDrr: null };
    const ozon: AdsIndex = { available: !!r.sources?.ozon, byKey: new Map(), avgDrr: null };
    for (const it of r.items) {
      if (it.drr == null) continue;
      const pct = Math.round(it.drr * 10) / 10;
      if (it.platform === 'wb' && it.id) wb.byKey.set(String(it.id), pct);
      if (it.platform === 'ozon') ozon.byKey.set(normSku(it.sku), pct);
    }
    const agg = { wb: { s: 0, r: 0 }, ozon: { s: 0, r: 0 } };
    for (const it of r.items) { const a = agg[it.platform]; if (!a) continue; a.s += it.spend || 0; a.r += it.totalRevenue || 0; }
    wb.avgDrr = agg.wb.r > 0 ? Math.round((agg.wb.s / agg.wb.r) * 1000) / 10 : null;
    ozon.avgDrr = agg.ozon.r > 0 ? Math.round((agg.ozon.s / agg.ozon.r) * 1000) / 10 : null;
    return { wb, ozon };
  } catch (e) {
    noteSwallowed('product-econ', 'отчёт по рекламе не собран, ДРР будет неизвестен', e);
    return { wb: { ...empty }, ozon: { ...empty } };
  }
}

function drrFor(idx: AdsIndex, key: string, period: string): Val {
  const hit = idx.byKey.get(key);
  if (hit != null) return val(hit, 'ads-report');
  if (!idx.available) {
    return none('статистика рекламы за период не собрана — ДРР неизвестен');
  }
  // Данные есть, товара в них нет: значит расхода по нему не было. Это ноль, а
  // не «неизвестно», и разница существенная — с выдуманными 7% прибыль занижена.
  return val(0, 'no-ads', `рекламы за ${period} не было`);
}

// Сколько заказов за 7 дней нужно, чтобы недельный ДРР был не шумом, а сигналом.
// Одна продажа с рекламы при 2 заказах даёт «ДРР 50%» — это не про рекламу, а про случайность.
const MIN_ORDERS_7D = 5;

/**
 * Выбор окна ДРР (решение клиента 16.09.2026): база — 7 дней, чтобы цена следовала за
 * текущими кампаниями менеджера. Предохранитель: если за 7 дней меньше MIN_ORDERS_7D
 * заказов — берём 30 дней; если и за 30 дней рекламы по товару не было, а за 7 — была
 * (только что включили), берём средний ДРР магазина за 30 дней.
 */
function pickDrr(idx7: AdsIndex, idx30: AdsIndex, key: string, orders7: number, period: string) {
  const v7 = drrFor(idx7, key, period);
  const v30 = drrFor(idx30, key, '30 дн.');
  const drr7 = v7.value, drr30 = v30.value;
  let drr: Val; let drrPick: '7d' | '30d' | 'store' | 'none';
  if (v7.value == null && v30.value == null) { drr = v7; drrPick = 'none'; }
  else if (orders7 >= MIN_ORDERS_7D && v7.value != null) {
    drr = { ...v7, note: `окно 7 дн · заказов ${orders7}` + (v7.origin === 'no-ads' ? ' · рекламы не было' : '') }; drrPick = '7d';
  } else if (v30.value != null && (v30.origin === 'ads-report' || v7.value == null || v7.value === 0)) {
    drr = { ...v30, note: `окно 30 дн — за 7 дн мало заказов (${orders7})` + (v30.origin === 'no-ads' ? ' · рекламы не было' : '') }; drrPick = '30d';
  } else if (idx30.avgDrr != null && v7.value != null && v7.value > 0) {
    drr = val(idx30.avgDrr, 'store-avg', `средний ДРР магазина за 30 дн — по товару реклама только началась (за 7 дн заказов ${orders7})`); drrPick = 'store';
  } else { drr = v7; drrPick = '7d'; }
  return { drr, drr7, drr30, orders7, drrPick };
}

/** Факт логистики и выкупа за 30 дн — или честное «мало данных», тогда фронт берёт тариф. */
function factVals(f: FactItem | undefined) {
  const w = f?.d30;
  const tail = w ? `факт за 30 дн · продано ${w.units} шт` : '';
  return {
    logisticFact: w && w.fwdPerUnit != null && w.fwdCount >= 3
      ? val(w.fwdPerUnit, 'fact-report', `${tail} · доставок ${w.fwdCount} на ${w.fwdRub} ₽`)
      : none('мало доставок за 30 дн — берём тариф'),
    returnFact: w && w.returnPerSale != null && w.units >= 3
      ? val(w.returnPerSale, 'fact-report', `${tail} · отмен/невыкупов ${w.cancels}, возвратов ${w.retUnits} · обратная логистика ${w.retRub} ₽`)
      : none('мало продаж за 30 дн — считаем по тарифу и % выкупа'),
    buyoutFact: w && w.buyoutPct != null ? val(w.buyoutPct, 'fact-report', tail) : none('мало данных за 30 дн'),
  };
}

// ─── Wildberries ────────────────────────────────────────────────────────────

/** Цены WB из прогретого кэша: даёт связку артикул ↔ nmId. */
async function wbSkuToNm(): Promise<Map<string, number>> {
  const key = makeUpstreamCacheKey('wb:discounts', 'GET', 'api/v2/list/goods/filter', '?limit=1000', undefined);
  const out = new Map<string, number>();
  const cached = await cacheGet<{ text: string }>(key);
  if (!cached?.data?.text) return out;
  try {
    for (const g of (JSON.parse(cached.data.text)?.data?.listGoods ?? [])) {
      const sku = normSku(g?.vendorCode);
      const nm = Number(g?.nmID ?? g?.nmId) || 0;
      if (sku && nm) out.set(sku, nm);
    }
  } catch (e) {
    noteSwallowed('product-econ', 'кэш цен WB не разобран', e);
  }
  return out;
}

// ─── Ozon ───────────────────────────────────────────────────────────────────

type OzonRates = { commissionPct: number | null; logisticRub: number | null };

/**
 * Комиссия и логистика Ozon по выбранной схеме.
 *
 * У Ozon в ответе лежат обе схемы рядом: `sales_percent_fbo` и
 * `sales_percent_fbs`, а логистика — парами `fbo_*` / `fbs_*`. Кабинет брал
 * только FBO, хотя клиент перешёл на FBS — отсюда завышенная прибыль по всему
 * каталогу. Теперь схема выбирается настройкой, а если нужных полей в ответе
 * нет, отдаём null: подставить ставку соседней схемы значит соврать.
 */
function ozonRatesFor(row: any, model: Fulfilment): OzonRates {
  const c = row?.commissions ?? {};
  const num = (v: unknown): number | null => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const pct = num(model === 'fbs' ? c.sales_percent_fbs : c.sales_percent_fbo);

  // Логистика: доставка до покупателя + средняя магистраль по выбранной схеме.
  const deliv = num(model === 'fbs' ? c.fbs_deliv_to_customer_amount : c.fbo_deliv_to_customer_amount);
  const tMin = num(model === 'fbs' ? c.fbs_direct_flow_trans_min_amount : c.fbo_direct_flow_trans_min_amount);
  const tMax = num(model === 'fbs' ? c.fbs_direct_flow_trans_max_amount : c.fbo_direct_flow_trans_max_amount);
  const trans = tMin != null && tMax != null ? (tMin + tMax) / 2 : null;
  const logistic = deliv != null || trans != null ? (deliv ?? 0) + (trans ?? 0) : null;

  return { commissionPct: pct, logisticRub: logistic };
}

/** Цены и комиссии Ozon из прогретого кэша. */
async function ozonPriceRows(): Promise<any[]> {
  const key = makeUpstreamCacheKey('ozon-seller', 'POST', 'v5/product/info/prices', '',
    JSON.stringify({ filter: { visibility: 'ALL' }, limit: 100 }));
  const cached = await cacheGet<{ text: string }>(key);
  if (!cached?.data?.text) return [];
  try { return JSON.parse(cached.data.text)?.items ?? []; }
  catch (e) { noteSwallowed('product-econ', 'кэш цен Ozon не разобран', e); return []; }
}

// ─── Сборка ─────────────────────────────────────────────────────────────────

/**
 * Собрать экономику по всем товарам обеих площадок.
 *
 * Ходит только в прогретые датасеты и наш справочник — в площадки отсюда не
 * стучимся, поэтому вызов дешёвый и его можно дёргать на каждый заход в раздел.
 */
export async function buildProductEcon(days = 7): Promise<EconReport> {
  const settings = getSettings();
  const diagnostics: string[] = [];

  const [costs, ads, ads30, totals7, fact, skuNm, wbEcon, boxTariffs, ozRows] = await Promise.all([
    Promise.resolve(getCosts()),
    loadAds(days),
    loadAds(30),
    getTotalRevenue(7).catch(() => null),
    getLogisticsFactCached().catch(() => null),
    wbSkuToNm(),
    getWbCardEcon().catch(() => null),
    getWbBoxTariffs().catch(() => null),
    ozonPriceRows(),
  ]);

  if (!ads.wb.available) diagnostics.push('WB: статистика рекламы не собрана — ДРР неизвестен');
  if (!ads.ozon.available) diagnostics.push('Ozon: статистика рекламы не собрана — ДРР неизвестен');
  if (!wbEcon) diagnostics.push('WB: комиссии и габариты карточек недоступны');
  if (!boxTariffs) diagnostics.push('WB: тарифы логистики недоступны');
  if (!ozRows.length) diagnostics.push('Ozon: цены и комиссии не прогреты');
  if (!fact) diagnostics.push('Факт логистики ещё не собран — пока тарифы');
  for (const d of (fact?.diagnostics ?? [])) diagnostics.push('Факт логистики: ' + d);

  const costOf = (sku: string): Val => {
    const c = costs.items[normSku(sku)];
    return c && c.cost > 0
      ? val(c.cost, 'reference', c.source === 'sheet' ? 'из таблицы «Склад»' : 'из справочника')
      : none('себестоимость не заведена — заполните её в разделе «Себестоимость»');
  };

  const period = `${days} дн.`;

  // ── WB ──
  const wb: Record<string, ProductEcon> = {};
  for (const [sku, nmId] of skuNm) {
    const econ = wbEcon?.items?.[String(nmId)];
    const volL = econ?.volumeL ?? 0;
    const volExtra = Math.max(0, volL - 1);

    wb[sku] = {
      sku, nmId,
      cost: costOf(sku),
      ...pickDrr(ads.wb, ads30.wb, String(nmId), totals7?.wbOrdersByNm.get(String(nmId)) ?? 0, period),
      ...factVals(fact?.wb?.[String(nmId)]),
      commissionPct: econ?.commission != null
        ? val(econ.commission, econ.commissionSource === 'client-table' ? 'client-table' : 'tariffs',
              `схема ${settings.wbFulfilment.toUpperCase()}`)
        : none(`WB не дал ставку комиссии для схемы ${settings.wbFulfilment.toUpperCase()}`),
      // Логистика и хранение считаются от объёма карточки. Без габаритов их
      // считать не от чего — это тоже «нет данных», а не ноль.
      logisticRub: boxTariffs && volL > 0
        ? val(Math.round(boxTariffs.deliveryBase + boxTariffs.deliveryLiter * volExtra), 'tariffs')
        : none(volL > 0 ? 'тарифы логистики недоступны' : 'в карточке не заполнены габариты'),
      storageRub: boxTariffs && volL > 0
        ? val(Math.round((boxTariffs.storageBase + boxTariffs.storageLiter * volExtra) * 30), 'tariffs')
        : none(volL > 0 ? 'тарифы хранения недоступны' : 'в карточке не заполнены габариты'),
    };
  }

  // ── Ozon ──
  const ozon: Record<string, ProductEcon> = {};
  for (const row of ozRows) {
    const sku = normSku(row?.offer_id);
    if (!sku) continue;
    const rates = ozonRatesFor(row, settings.ozonFulfilment);
    const model = settings.ozonFulfilment.toUpperCase();
    ozon[sku] = {
      sku,
      cost: costOf(sku),
      ...pickDrr(ads.ozon, ads30.ozon, sku, totals7?.ozonOrdersBySku.get(sku) ?? 0, period),
      ...factVals(fact?.ozon?.[sku]),
      commissionPct: rates.commissionPct != null
        ? val(rates.commissionPct, 'tariffs', `схема ${model}`)
        : none(`Ozon не дал ставку комиссии для схемы ${model}`),
      logisticRub: rates.logisticRub != null
        ? val(Math.round(rates.logisticRub), 'tariffs', `схема ${model}`)
        : none(`Ozon не дал тарифы логистики для схемы ${model}`),
      // У Ozon хранение не приходит в этом ответе и зависит от склада — не выдумываем.
      storageRub: none('Ozon не отдаёт стоимость хранения по товару'),
    };
  }

  // Товары, которые есть в справочнике себестоимости, но которых нет ни в одной
  // площадке, специально НЕ добавляем: экономика без цены бессмысленна, а
  // строка-призрак в таблице только путает.

  return {
    fulfilment: { wb: settings.wbFulfilment, ozon: settings.ozonFulfilment },
    wb, ozon, diagnostics, generatedAt: Date.now(),
    storeDrr: { wb: { d7: ads.wb.avgDrr, d30: ads30.wb.avgDrr }, ozon: { d7: ads.ozon.avgDrr, d30: ads30.ozon.avgDrr } },
  };
}
