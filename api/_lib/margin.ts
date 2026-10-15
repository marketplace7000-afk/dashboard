/**
 * Маржа и ROI по товарам НА СЕРВЕРЕ (этап Б советника, 15.10.2026).
 *
 * Раньше маржа считалась только в браузере на листах «Цены» (LiveWbPricing /
 * LiveOzonPricing) и попадала на сервер снимком, пока лист открыт. Советник и
 * автопилот в остальное время её не видели («свежего расчёта нет»). Здесь тот же
 * расчёт теми же формулами (src/utils/wbProfit.ts, ozonProfit.ts) и из тех же
 * источников, что у листа: цена ЛК из кэша ценовых API, цена покупателя (витрина →
 * продажи → соинвест → память), экономика товара (productEcon: себестоимость, ДРР,
 * комиссия, логистика, факт возвратов и выкупа), глобальные параметры листа из uiState.
 *
 * Чего здесь нет по сравнению с листом: запасных значений из Google-таблицы
 * (lkPrice/buyerPrice/drr/buyout/purchasePrice) и ручных «крутилок» строк — это
 * маржа «по данным», как верхний уровень снимка листа. Без себестоимости маржа
 * не считается (null), как и на листе.
 */
import { calcWbProfit, WB_DEFAULTS, type WbCalcInput } from '../../src/utils/wbProfit';
import { calcOzonProfit, OZON_DEFAULTS, type OzonCalcInput } from '../../src/utils/ozonProfit';
import { roiStatus, type RoiStatus } from '../../src/utils/roiLogic';
import { buildProductEcon, wbSkuToNm, ozonPriceRows, type ProductEcon } from './productEcon';
import { getWbCardEcon } from './wbCardEcon';
import { getWbBoxTariffs } from './wbBoxTariffs';
import { getWbBuyerPrices } from './wbBuyerPrices';
import { getOzonBuyerPrices } from './ozonBuyerPrices';
import { getWbShowcase } from './wbShowcase';
import { getOzonShowcase } from './ozonShowcase';
import { getUiState } from './uiState';
import { cacheGet, makeUpstreamCacheKey } from './cache';
import { normSku } from './costs';
import { mskDate } from './mskDate';

export type MarginMp = 'wb' | 'ozon';

export type MarginRow = {
  mp: MarginMp;
  /** Артикул продавца (UPPER). */
  article: string;
  /** Номер на площадке: WB — nmId, Ozon — SKU (если известен) / product_id. */
  id: string;
  /** Цена ЛК (серая, после скидки продавца, до СПП / соинвеста). */
  retail: number | null;
  /** Цена покупателя и откуда она. */
  buyer: number | null; buyerSource: string;
  /** СПП / соинвест, % от цены ЛК. */
  spp: number;
  cost: number | null;
  marginPct: number | null; marginRub: number | null; roi: number | null; roiStatus: RoiStatus | null;
  /** Вход калькулятора — для пересчёта при другой цене (пол цены, «что если»). */
  input: WbCalcInput | OzonCalcInput | null;
};

export type MarginReport = {
  mp: MarginMp; at: number;
  items: Record<string, MarginRow>;
  /** Сколько товаров с посчитанной маржой (есть цена и себестоимость). */
  withMargin: number;
  diagnostics: string[];
};

const SHOWCASE_FRESH_MS = 6 * 3600_000;
const FRESH_SALE_DAYS = 7;
const CACHE_MS = 20 * 60_000;
const up = (s: unknown) => String(s ?? '').trim().toUpperCase();
const n0 = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

/** Глобальные параметры панели листа «Цены» (usn, nds, acq, drr, buyout, spp) — из uiState. */
function globalParams(mp: MarginMp): (k: string, fb: number) => number {
  let gpv: Record<string, string> = {};
  try { gpv = JSON.parse(getUiState().state[`prices-${mp}:globalParams`] || '{}') ?? {}; } catch { gpv = {}; }
  return (k, fb) => {
    const s = gpv[k];
    if (s == null || String(s).trim() === '') return fb;
    const n = parseFloat(String(s).replace(',', '.'));
    return Number.isNaN(n) ? fb : n;
  };
}

/** Витрина: цена с учётом сдвига цены ЛК с момента снятия (как на листе). */
function showcasePrice(sc: { price: number; greyPrice?: number; at: number } | undefined, grey: number, now: number): { price: number; source: 'showcase' | 'showcase-mem' } | null {
  if (!sc || !(sc.price > 0)) return null;
  const fresh = now - sc.at <= SHOWCASE_FRESH_MS;
  const capturedGrey = sc.greyPrice && sc.greyPrice > 0 ? sc.greyPrice : null;
  if (fresh) {
    if (capturedGrey && grey > 0 && Math.abs(grey - capturedGrey) >= 1) return { price: Math.max(0, Math.round(grey * (1 - (capturedGrey - sc.price) / capturedGrey))), source: 'showcase' };
    return { price: sc.price, source: 'showcase' };
  }
  if (capturedGrey && grey > 0) return { price: Math.max(0, Math.round(grey * (1 - (capturedGrey - sc.price) / capturedGrey))), source: 'showcase-mem' };
  return { price: sc.price, source: 'showcase-mem' };
}

const finish = (row: MarginRow, calc: { margin: number; profit: number; roi: number } | null): MarginRow => {
  if (!calc) return row;
  row.marginPct = Math.round(calc.margin); row.marginRub = Math.round(calc.profit); row.roi = Math.round(calc.roi);
  row.roiStatus = row.cost && row.cost > 0 ? roiStatus(row.roi, row.cost).status : null;
  return row;
};

// ─── WB ─────────────────────────────────────────────────────────────────────

async function wbMargins(now: number): Promise<MarginReport> {
  const diagnostics: string[] = [];
  const key = makeUpstreamCacheKey('wb:discounts', 'GET', 'api/v2/list/goods/filter', '?limit=1000', undefined);
  const cached = await cacheGet<{ text: string }>(key);
  let goods: any[] = [];
  try { goods = cached?.data?.text ? JSON.parse(cached.data.text)?.data?.listGoods ?? [] : []; } catch { goods = []; }
  if (!goods.length) diagnostics.push('WB: цены не прогреты');
  const [econ, cardEcon, tariffs, buyer, showcase] = await Promise.all([
    buildProductEcon(7).catch(e => { diagnostics.push(`экономика: ${(e as Error).message}`); return null; }),
    getWbCardEcon().catch(() => null), getWbBoxTariffs().catch(() => null),
    getWbBuyerPrices().catch(() => null), getWbShowcase().catch(() => null),
  ]);
  const gp = globalParams('wb');
  // средний СПП магазина по снимку витрины — запасной путь к цене покупателя
  let avgSpp = 0;
  if (showcase) {
    const fr = (Object.values(showcase.items) as { price: number; greyPrice?: number }[]).filter(x => x.greyPrice && x.greyPrice > 0 && x.price > 0 && x.price < x.greyPrice).map(x => (x.greyPrice! - x.price) / x.greyPrice!);
    if (fr.length) avgSpp = fr.reduce((a, b) => a + b, 0) / fr.length;
  }
  const items: Record<string, MarginRow> = {};
  for (const g of goods) {
    const art = normSku(g?.vendorCode);
    const nm = String(g?.nmID ?? g?.nmId ?? '');
    if (!art || !nm) continue;
    const size = g?.sizes?.[0] ?? {};
    const sale = buyer?.items?.[nm];
    const grey = Math.round(n0(size.discountedPrice) > 0 ? n0(size.discountedPrice) : n0(sale?.beforeSpp));
    const row: MarginRow = { mp: 'wb', article: art, id: nm, retail: grey > 0 ? grey : null, buyer: null, buyerSource: 'none', spp: 0, cost: null, marginPct: null, marginRub: null, roi: null, roiStatus: null, input: null };
    // Цена покупателя — по свежести источника, как на листе.
    const sc = showcasePrice(showcase?.items?.[nm], grey, now);
    const saleAge = sale?.date ? Math.round((Date.parse(mskDate(0)) - Date.parse(sale.date)) / 86_400_000) : Infinity;
    let bp = 0, src = 'none';
    if (sc) { bp = sc.price; src = sc.source; }
    else if (sale && sale.price > 0 && !sale.fromMemory && saleAge <= FRESH_SALE_DAYS) { bp = sale.price; src = 'sale'; }
    else if (sale && sale.price > 0) { bp = sale.price; src = 'old-sale'; }
    else if (gp('spp', 0) > 0 && grey > 0) { bp = Math.round(grey * (1 - gp('spp', 0) / 100)); src = 'gp'; }
    else if (avgSpp > 0 && grey > 0) { bp = Math.round(grey * (1 - avgSpp)); src = 'store-avg'; }
    else if (n0(size.clubDiscountedPrice) > 0) { bp = n0(size.clubDiscountedPrice); src = 'club'; }
    else if (grey > 0) { bp = grey; src = 'lk'; }
    row.buyer = bp > 0 ? bp : null; row.buyerSource = src;
    row.spp = src === 'sale' && sale?.spp && sale.spp > 0 ? sale.spp : grey > 0 && bp > 0 && bp < grey ? Math.round((grey - bp) / grey * 100) : 0;
    const e: ProductEcon | undefined = econ?.wb?.[art];
    const cost = e?.cost.value ?? 0;
    row.cost = cost > 0 ? cost : null;
    const ce = cardEcon?.items?.[nm];
    const volL = ce?.volumeL || 0, volExtra = Math.max(0, volL - 1);
    const logFromApi = tariffs && volL > 0 ? tariffs.deliveryBase + tariffs.deliveryLiter * volExtra : undefined;
    const storFromApi = tariffs && volL > 0 ? (tariffs.storageBase + tariffs.storageLiter * volExtra) * 30 : undefined;
    const catComm = ce?.commission != null && ce.commission > 0 ? ce.commission : undefined;
    if (grey > 0 && cost > 0) {
      const input: WbCalcInput = {
        retail: grey, cost,
        spp: row.spp > 0 ? row.spp : gp('spp', 0),
        drr: e?.drr.value ?? gp('drr', WB_DEFAULTS.drr),
        buyout: e?.buyoutFact?.value ?? gp('buyout', 88),
        commission: e?.commissionPct.value ?? catComm ?? WB_DEFAULTS.commission,
        acquiring: gp('acq', WB_DEFAULTS.acquiring),
        logistic: e?.logisticFact?.value ?? e?.logisticRub.value ?? logFromApi ?? WB_DEFAULTS.logistic,
        storage: e?.storageRub.value ?? storFromApi ?? WB_DEFAULTS.storage,
        returnBase: logFromApi ?? WB_DEFAULTS.returnBase,
        returnCostPerSale: e?.returnFact?.value ?? undefined,
        usn: gp('usn', WB_DEFAULTS.usn), nds: gp('nds', WB_DEFAULTS.nds),
      };
      row.input = input;
      finish(row, calcWbProfit(input));
    }
    items[art] = row;
  }
  for (const d of econ?.diagnostics ?? []) if (/WB|Факт/.test(d)) diagnostics.push(d);
  return { mp: 'wb', at: now, items, withMargin: Object.values(items).filter(r => r.marginPct != null).length, diagnostics };
}

// ─── Ozon ───────────────────────────────────────────────────────────────────

async function ozonMargins(now: number): Promise<MarginReport> {
  const diagnostics: string[] = [];
  const [rows, econ, buyer, showcase] = await Promise.all([
    ozonPriceRows(),
    buildProductEcon(7).catch(e => { diagnostics.push(`экономика: ${(e as Error).message}`); return null; }),
    getOzonBuyerPrices().catch(() => null), getOzonShowcase().catch(() => null),
  ]);
  if (!rows.length) diagnostics.push('Ozon: цены не прогреты');
  const gp = globalParams('ozon');
  const items: Record<string, MarginRow> = {};
  for (const r of rows) {
    const art = normSku(r?.offer_id);
    if (!art) continue;
    const cur = n0(r?.price?.marketing_seller_price) || n0(r?.price?.price);
    const row: MarginRow = { mp: 'ozon', article: art, id: String(r?.sources?.[0]?.sku ?? r?.product_id ?? ''), retail: cur > 0 ? Math.round(cur) : null, buyer: null, buyerSource: 'none', spp: 0, cost: null, marginPct: null, marginRub: null, roi: null, roiStatus: null, input: null };
    const ob = buyer?.items?.[art];
    const sc = showcasePrice(showcase?.items?.[art], cur, now);
    const hist = buyer?.sppHistory?.[art];
    let bp = 0, src = 'none';
    if (sc) { bp = sc.price; src = sc.source; }
    else if (ob && ob.spp > 0 && cur > 0) { bp = Math.round(cur * (1 - ob.spp / 100)); src = 'coinvest'; }
    else if (hist && hist.spp > 0 && cur > 0) { bp = Math.round(cur * (1 - hist.spp / 100)); src = 'memory'; }
    else if (gp('spp', 0) > 0 && cur > 0) { bp = Math.round(cur * (1 - gp('spp', 0) / 100)); src = 'gp'; }
    else if (cur > 0) { bp = Math.round(cur); src = 'lk'; }
    row.buyer = bp > 0 ? bp : null; row.buyerSource = src;
    row.spp = bp > 0 && bp < cur ? Math.round((cur - bp) / cur * 100) : 0;
    const e: ProductEcon | undefined = econ?.ozon?.[art];
    const cost = e?.cost.value ?? 0;
    row.cost = cost > 0 ? cost : null;
    const cm: any = r?.commissions ?? {};
    const apiComm = e?.commissionPct.value ?? (n0(cm.sales_percent_fbo) || 0);
    const deliv = n0(cm.fbo_deliv_to_customer_amount), tMin = n0(cm.fbo_direct_flow_trans_min_amount), tMax = n0(cm.fbo_direct_flow_trans_max_amount);
    const apiLog = e?.logisticRub.value ?? (deliv + (tMin && tMax ? (tMin + tMax) / 2 : 0));
    const apiReturn = n0(cm.fbs_return_flow_amount) || n0(cm.fbo_return_flow_amount) || OZON_DEFAULTS.returnBase;
    const apiAcq = n0(r?.acquiring);
    const acqPct = cur > 0 && apiAcq > 0 ? apiAcq / cur * 100 : gp('acq', 1.5);
    if (cur > 0 && cost > 0) {
      const buyout = e?.buyoutFact?.value ?? gp('buyout', 88);
      const input: OzonCalcInput = {
        price: cur, cost,
        commission: apiComm || OZON_DEFAULTS.commission,
        spp: row.spp,
        drr: e?.drr.value ?? gp('drr', OZON_DEFAULTS.drr),
        acquiring: Math.round(acqPct / 100 * cur),
        logistic: e?.logisticFact?.value ?? (apiLog || OZON_DEFAULTS.logistic),
        storage: OZON_DEFAULTS.storage,
        returnBase: apiReturn,
        returnCostPerSale: e?.returnFact?.value ?? undefined,
        returnRate: Math.max(0, 100 - buyout),
        usn: gp('usn', OZON_DEFAULTS.usn), nds: gp('nds', OZON_DEFAULTS.nds),
      };
      row.input = input;
      finish(row, calcOzonProfit(input));
    }
    items[art] = row;
  }
  for (const d of econ?.diagnostics ?? []) if (/Ozon|Факт/.test(d)) diagnostics.push(d);
  return { mp: 'ozon', at: now, items, withMargin: Object.values(items).filter(r => r.marginPct != null).length, diagnostics };
}

// ─── Доступ ─────────────────────────────────────────────────────────────────

const mem: Partial<Record<MarginMp, { at: number; p: Promise<MarginReport> }>> = {};

/** Маржа по площадке; результат живёт 20 минут (кэши площадок обновляются реже). */
export function getMargins(mp: MarginMp, fresh = false): Promise<MarginReport> {
  const now = Date.now();
  const c = mem[mp];
  if (!fresh && c && now - c.at < CACHE_MS) return c.p;
  const p = (mp === 'wb' ? wbMargins(now) : ozonMargins(now)).catch(e => {
    delete mem[mp];
    throw e;
  });
  mem[mp] = { at: now, p };
  return p;
}

/** Маржа, % при другой цене ЛК (остальные входы те же). Ozon: эквайринг пересчитывается от цены. */
export function marginAt(row: MarginRow, retail: number): number | null {
  if (!row.input || !(retail > 0)) return null;
  if (row.mp === 'wb') return calcWbProfit({ ...(row.input as WbCalcInput), retail })?.margin ?? null;
  const i = row.input as OzonCalcInput;
  const acqPct = i.price > 0 ? i.acquiring / i.price * 100 : 0;
  return calcOzonProfit({ ...i, price: retail, acquiring: Math.round(acqPct / 100 * retail) })?.margin ?? null;
}

/**
 * Пол цены ЛК: минимальная цена, при которой маржа не ниже порога. Подбор по тому же
 * калькулятору (маржа растёт по цене монотонно). null — порог недостижим.
 */
export function priceFloor(row: MarginRow, minMarginPct: number): number | null {
  if (!row.input || !row.cost) return null;
  const at = (p: number) => marginAt(row, p) ?? -Infinity;
  let lo = Math.max(1, row.cost), hi = Math.max(lo * 2, row.cost * 50, 1000);
  if (at(hi) < minMarginPct) return null;
  for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (at(mid) < minMarginPct) lo = mid; else hi = mid; }
  return Math.ceil(hi);
}
