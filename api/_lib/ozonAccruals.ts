/**
 * НАЧИСЛЕНИЯ OZON по дням — замена отключённых методов финансов.
 *
 * 08.09.2026 Ozon отключил v3/finance/transaction/list и v3/finance/transaction/totals
 * (сначала 400 «obsolete method cannot be used», к 18.10.2026 — 404 page not found).
 * Всё, что на них строилось (ОПиУ, удержания, факт-прибыль, раздел «Финансы»),
 * месяц показывало кэш от 08.09. Замена из канала Ozon Seller API —
 * v1/finance/accrual/by-day: ОДИН день за запрос ({ date: 'YYYY-MM-DD' }),
 * курсор last_id (пустая строка — страниц больше нет). Проверено с прод-сервера
 * 18.10.2026: 200, 300–420 начислений в день, обычно одной страницей.
 *
 * Формат начисления (accrued_category):
 *   POSTING  — по отправлению: posting.products[] с commission (продажа/возврат:
 *              sale_amount, commission) и delivery.services[] (логистика);
 *   ITEM     — по товару отправления: item_fees.fees[].fees[] (эквайринг и пр.);
 *   NON_ITEM — без отправления: non_item_fee (реклама, бейджи, штрафы, хранение);
 *   container_fees — по грузоместу (структура не встречалась, обходим рекурсивно).
 * Названий услуг в ответе нет, только type_id → справочник v1/finance/accrual/types.
 *
 * Чтобы не переписывать все экраны, начисление приводится к виду старой операции
 * transaction/list (LegacyOp): те же поля amount, accruals_for_sale, sale_commission,
 * services, items, type. operation_type — старый код, где у него есть явный аналог
 * (OperationAgentDeliveredToCustomer, ClientReturnAgentOperation, OperationItemReturn,
 * MarketplaceRedistributionOfAcquiringOperation), иначе «Группа:ИмяТипа»
 * (Delivery:LastMileCourier, Advertising:PayPerClick, Storage:Placements …) —
 * по этим словам экраны и раскладывают операции по статьям.
 */
import { fetchWithRetry } from './fetchRetry';
import { cacheGet, cacheSet } from './cache';
import { mskDate } from './mskDate';

const DAY_KEY = 'oz-accrual-day:v1:';
const TYPES_KEY = 'oz-accrual-types:v1';
const TYPES_TTL = 7 * 24 * 60 * 60_000;
// Свежие дни ещё дописываются (начисления приходят с задержкой) — их перечитываем
// часто; дни старше трёх суток уже не меняются, их держим неделю.
const TTL_RECENT = 60 * 60_000;
const TTL_SETTLED = 7 * 24 * 60 * 60_000;
const SETTLED_AFTER_DAYS = 3;

export type Money = { amount?: string | number; currency?: string } | null | undefined;
export type RawAccrual = {
  accrual_id: number;
  date: string;
  total_amount?: Money;
  unit_number?: string;
  accrued_category?: 'POSTING' | 'ITEM' | 'NON_ITEM' | string;
  posting?: {
    delivery_schema?: string;
    products?: Array<{
      sku?: number;
      quantity?: number;
      delivery?: { total_accrued?: Money; services?: Array<{ type_id: number; accrued?: Money }> } | null;
      commission?: { seller_price?: Money; sale_price?: Money; sale_amount?: Money; sale_commission?: Money; commission?: Money; bonus?: Money; coinvestment?: Money } | null;
    }>;
  } | null;
  item_fees?: { fees?: Array<{ sku?: number; quantity?: number; fees?: Array<{ type_id: number; accrued?: Money }> }> } | null;
  non_item_fee?: { type_id: number; accrued?: Money } | null;
  container_fees?: unknown;
};

export type AccrualType = { id: number; name: string; description: string };

/** Операция в формате старого v3/finance/transaction/list. */
export type LegacyOp = {
  operation_id: number;
  operation_type: string;
  operation_type_name: string;
  operation_date: string;          // 'YYYY-MM-DD 00:00:00'
  delivery_charge: number;         // логистика внутри продажи/возврата (≤ 0)
  return_delivery_charge: number;
  accruals_for_sale: number;
  sale_commission: number;         // ≤ 0
  amount: number;
  type: 'orders' | 'returns' | 'services' | 'compensation' | 'other';
  /** Статья расходов — для серверных расчётов (ОПиУ, удержания). */
  group: AccrualGroup;
  posting?: { delivery_schema?: string; posting_number?: string };
  items?: Array<{ sku?: number }>;
  services?: Array<{ name?: string; price: number }>;
};

export type AccrualGroup =
  | 'sale' | 'return' | 'logistics' | 'packaging' | 'returnLogistics' | 'acquiring'
  | 'ads' | 'storage' | 'compensation' | 'fine' | 'other';

export type LegacyTotals = {
  accruals_for_sale: number;
  sale_commission: number;
  processing_and_delivery: number;
  refunds_and_cancellations: number;
  services_amount: number;
  compensation_amount: number;
  money_transfer: number;
  others_amount: number;
};

const num = (m: Money): number => {
  const n = Number((m as any)?.amount ?? 0);
  return Number.isFinite(n) ? n : 0;
};

// ─── Справочник типов → статьи ───────────────────────────────────────────────
// Имена — из v1/finance/accrual/types (снято с прод-кабинета 18.10.2026, 135 типов).
const RETURN_LOGISTICS = new Set([
  'BackwardShipment', 'Cancellation', 'ClientReturn', 'PartialReturn', 'PickUpPointReturnAcceptance',
  'PreparingToReturn', 'ReturnFlowLogistic', 'ReturnStorageInTheWarehouse', 'TemporaryPlacement',
  'B2CPickUpPointReturnAcceptance', 'B2CBackwardLogistics', 'RfbsEasyReturn', 'SellerReturns',
]);
const PACKAGING = new Set([
  'PackageCost', 'PackingFee', 'ItemPacking', 'ItemSealing', 'PackmanCisPacking',
  'B2CContainerPacking', 'B2CContainerPackage', 'PackageUnitProcessing', 'Marking',
]);
const LOGISTICS = new Set([
  'Logistic', 'LastMile', 'LastMileCourier', 'LastMilePickUpPoint', 'Drop-Off', 'Drop-Off Agent',
  'Pick-Up', 'PickUpCourierArrangement', 'PickUpCourierDelivery', 'CrossDock', 'CrossDockPickUpCourierDelivery',
  'CrossDockHandlingAtDropOff', 'CrossDockDeliveryToAcceptancePoint', 'CrossDockPartnerHandling',
  'Shipment', 'Fulfillment', 'QuantProcessingDrop', 'SupplyInbound', 'Replenishment',
  'DeliveryToHandoverPlaceByOzon', 'CourierPickUpByOzon', 'CourierPickUpReinvoice', 'OversizedExtraHandling',
  'VolumeWeightCharacteristicsProcessing', 'InternationalLogisticDelta', 'OzonGlobalLogisticsDelivery',
  'B2CLogistics', 'B2C Drop-Off', 'B2C Drop-Off Agent', 'B2CCourierClientReinvoice',
  'B2CDeliveryToHandoverPlaceByOzon', 'B2CPickUpPointClientReinvoice', 'ClickAndCollect',
  'RfbsDomesticDelivery', 'RfbsGlobalDelivery', 'RfbsServiceFee', 'MicroFulfillmentSupply', 'MicroFulfillmentPicking',
]);
const ADS = new Set([
  'PayPerClick', 'Promotion', 'BrandPromotion', 'BrandShelf', 'BrandCommission', 'ExternalPromotion',
  'InternetSiteAdvertising', 'SocialMediaAdvertising', 'DisplayAdvertisingPlacement', 'Marketing',
  'PushCampaign', 'Stencil', 'PremiumCashbackPromotion', 'OrdersBooking', 'LeadGeneration',
  'PointsForReviews', 'AcceleratedReviewCollection', 'FirstCustomerReview', 'SaleReview', 'ReviewsPin',
  'CustomerChatPoints', 'PremiumCashbackIndividualPoints', 'PremiumMailingCommission', 'StarsMembership',
]);
const STORAGE = new Set(['Placements', 'TemporaryPlacementsAgent', 'B2CTemporaryPlacement', 'Disposal', 'B2CDisposal']);
const COMPENSATION = new Set(['Compensation', 'ItemCompensation', 'B2CInsuranceCompensation', 'ClaimCommission', 'VolumeObligationReward']);

export function groupOfType(name: string): AccrualGroup {
  if (name === 'Acquiring') return 'acquiring';
  if (RETURN_LOGISTICS.has(name)) return 'returnLogistics';
  if (PACKAGING.has(name)) return 'packaging';
  if (LOGISTICS.has(name)) return 'logistics';
  if (ADS.has(name)) return 'ads';
  if (STORAGE.has(name)) return 'storage';
  if (COMPENSATION.has(name)) return 'compensation';
  if (name.startsWith('DefectFine') || name === 'DefectRate') return 'fine';
  return 'other';
}

/** Код операции в духе старого API — по нему раскладывают экраны. */
function legacyCode(group: AccrualGroup, name: string): string {
  switch (group) {
    case 'acquiring': return 'MarketplaceRedistributionOfAcquiringOperation';
    case 'returnLogistics': return 'OperationItemReturn';
    case 'logistics': return `Delivery:${name}`;
    case 'packaging': return `Package:${name}`;
    case 'ads': return `Advertising:${name}`;
    case 'storage': return `Storage:${name}`;
    case 'compensation': return `Compensation:${name}`;
    default: return name || 'Other';
  }
}

// ─── Запросы ─────────────────────────────────────────────────────────────────
async function ozPost(path: string, body: unknown): Promise<any> {
  const res = await fetchWithRetry(`https://api-seller.ozon.ru/${path}`, {
    method: 'POST',
    headers: { 'Client-Id': process.env.OZON_CLIENT_ID ?? '', 'Api-Key': process.env.OZON_API_KEY ?? '', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, { maxRetries: 2, timeoutMs: 40_000 });
  if (!res.ok) throw new Error(`ozon ${path} → ${res.status} ${(await res.text().catch(() => '')).slice(0, 160)}`);
  return res.json();
}

export async function getAccrualTypes(): Promise<Map<number, AccrualType>> {
  const cached = await cacheGet<AccrualType[]>(TYPES_KEY);
  let list = cached?.data;
  if (!list || Date.now() - cached!.fetchedAt > TYPES_TTL) {
    try {
      const j = await ozPost('v1/finance/accrual/types', {});
      const fresh: AccrualType[] = (j?.accrual_types ?? []).map((t: any) => ({ id: Number(t?.id), name: String(t?.name ?? ''), description: String(t?.description ?? '') }));
      if (fresh.length) { list = fresh; await cacheSet(TYPES_KEY, fresh, TYPES_TTL * 4); }
    } catch (e) { if (!list) throw e; }
  }
  return new Map((list ?? []).map(t => [t.id, t]));
}

const inflight = new Map<string, Promise<RawAccrual[]>>();

/** Все начисления за одни МСК-сутки (с кэшем и склейкой одновременных запросов). */
export async function getAccrualsForDay(date: string, force = false): Promise<RawAccrual[]> {
  const key = DAY_KEY + date;
  const today = mskDate(0);
  const settled = Date.parse(today) - Date.parse(date) > SETTLED_AFTER_DAYS * 86_400_000;
  const ttl = settled ? TTL_SETTLED : TTL_RECENT;
  const cached = await cacheGet<RawAccrual[]>(key);
  if (!force && cached?.data && Date.now() - cached.fetchedAt < ttl) return cached.data;
  const running = inflight.get(date);
  if (running) return running;
  const p = (async () => {
    try {
      const out: RawAccrual[] = [];
      let lastId = '';
      for (let page = 0; page < 50; page++) {
        const j = await ozPost('v1/finance/accrual/by-day', lastId ? { date, last_id: lastId } : { date });
        out.push(...(j?.accruals ?? []));
        lastId = String(j?.last_id ?? '');
        if (!lastId) break;
      }
      await cacheSet(key, out, ttl * 4);
      return out;
    } catch (e) {
      if (cached?.data) return cached.data;   // лучше прошлые цифры, чем дыра
      throw e;
    } finally {
      inflight.delete(date);
    }
  })();
  inflight.set(date, p);
  return p;
}

/** Список МСК-дат YYYY-MM-DD от from до to включительно. */
export function datesBetween(from: string, to: string): string[] {
  const out: string[] = [];
  const end = Date.parse(to + 'T00:00:00Z');
  for (let t = Date.parse(from + 'T00:00:00Z'); t <= end && out.length < 400; t += 86_400_000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

export type AccrualRange = { ops: LegacyOp[]; days: number; failedDays: string[] };

/** Начисления за диапазон МСК-дат, сразу в формате старых операций. */
export async function getLegacyOps(from: string, to: string): Promise<AccrualRange> {
  const types = await getAccrualTypes();
  const ops: LegacyOp[] = [];
  const failedDays: string[] = [];
  const dates = datesBetween(from, to);
  for (const d of dates) {
    try { for (const a of await getAccrualsForDay(d)) ops.push(toLegacyOp(a, types)); }
    catch { failedDays.push(d); }
  }
  return { ops, days: dates.length, failedDays };
}

/** Прогрев кэша по дням (для cron): старые дни берутся из кэша, свежие перечитываются. */
export async function warmOzonAccruals(days: number): Promise<{ ok: number; failed: number }> {
  let ok = 0, failed = 0;
  await getAccrualTypes();
  for (const d of datesBetween(mskDate(Math.max(0, days - 1)), mskDate(0))) {
    try { await getAccrualsForDay(d); ok++; } catch { failed++; }
  }
  return { ok, failed };
}

/** Последние `days` суток по Москве, включая сегодня. */
export function getLegacyOpsLastDays(days: number): Promise<AccrualRange> {
  return getLegacyOps(mskDate(Math.max(0, days - 1)), mskDate(0));
}

// ─── Приведение к старому формату ───────────────────────────────────────────
type Fee = { type_id: number; accrued?: Money };

function collectFees(node: unknown, out: Fee[]): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const x of node) collectFees(x, out); return; }
  const o = node as Record<string, unknown>;
  if (typeof o.type_id === 'number' && o.accrued) { out.push(o as unknown as Fee); return; }
  for (const v of Object.values(o)) collectFees(v, out);
}

export function toLegacyOp(a: RawAccrual, types: Map<number, AccrualType>): LegacyOp {
  const amount = num(a.total_amount);
  const nameOf = (id: number) => types.get(id)?.name || `type_${id}`;
  const descOf = (id: number) => types.get(id)?.description || nameOf(id);
  const base = {
    operation_id: a.accrual_id,
    operation_date: `${a.date} 00:00:00`,
    amount,
    return_delivery_charge: 0,
    posting: a.unit_number ? { delivery_schema: a.posting?.delivery_schema, posting_number: a.unit_number } : undefined,
  };

  const products = a.posting?.products ?? [];
  const withCommission = products.filter(p => p.commission);
  if (withCommission.length) {
    let sale = 0, commission = 0, delivery = 0;
    const items: Array<{ sku?: number }> = [];
    const services: Array<{ name?: string; price: number }> = [];
    for (const p of products) {
      sale += num(p.commission?.sale_amount ?? p.commission?.seller_price);
      commission += num(p.commission?.commission ?? p.commission?.sale_commission);
      for (const s of p.delivery?.services ?? []) {
        const v = num(s.accrued);
        delivery += v;
        services.push({ name: nameOf(s.type_id), price: v });
      }
      if (p.commission) for (let i = 0; i < Math.min(Math.max(1, Number(p.quantity) || 1), 50); i++) items.push({ sku: p.sku });
    }
    const isReturn = sale < 0;
    return {
      ...base,
      operation_type: isReturn ? 'ClientReturnAgentOperation' : 'OperationAgentDeliveredToCustomer',
      operation_type_name: isReturn ? 'Возврат покупателем' : 'Доставка покупателю',
      delivery_charge: delivery,
      accruals_for_sale: sale,
      sale_commission: commission,
      type: isReturn ? 'returns' : 'orders',
      group: isReturn ? 'return' : 'sale',
      items, services,
    };
  }

  // Без продажи: услуга/удержание. Статью определяет самая крупная по модулю строка.
  const fees: Fee[] = [];
  collectFees(a.posting, fees);
  collectFees(a.item_fees, fees);
  collectFees(a.non_item_fee, fees);
  collectFees(a.container_fees, fees);
  const main = fees.slice().sort((x, y) => Math.abs(num(y.accrued)) - Math.abs(num(x.accrued)))[0];
  const name = main ? nameOf(main.type_id) : 'Other';
  const group = groupOfType(name);
  const type: LegacyOp['type'] = group === 'compensation' ? 'compensation'
    : group === 'returnLogistics' ? 'returns'
    : group === 'other' && amount > 0 ? 'other'
    : 'services';
  return {
    ...base,
    operation_type: legacyCode(group, name),
    operation_type_name: main ? descOf(main.type_id) : 'Прочее',
    delivery_charge: 0,
    // Как в старом API: логистика отмены/невыкупа/возврата — в return_delivery_charge.
    return_delivery_charge: group === 'returnLogistics' ? amount : 0,
    accruals_for_sale: 0,
    sale_commission: 0,
    type, group,
    items: [],
    services: fees.map(f => ({ name: nameOf(f.type_id), price: num(f.accrued) })),
  };
}

/**
 * Итоги в формате старого v3/finance/transaction/totals. Раскладка сверена
 * 18.10.2026 с последним ответом старого метода (неделя 01–08.09.2026): там
 * accruals_for_sale — продажи ЗА ВЫЧЕТОМ возвращённых, refunds_and_cancellations —
 * только логистика отмен и возвратов, эквайринг — в others_amount.
 */
export function legacyTotals(ops: LegacyOp[]): LegacyTotals {
  const t: LegacyTotals = {
    accruals_for_sale: 0, sale_commission: 0, processing_and_delivery: 0, refunds_and_cancellations: 0,
    services_amount: 0, compensation_amount: 0, money_transfer: 0, others_amount: 0,
  };
  for (const op of ops) {
    if (op.group === 'sale' || op.group === 'return') {
      t.accruals_for_sale += op.accruals_for_sale;
      t.sale_commission += op.sale_commission;
      t.processing_and_delivery += op.delivery_charge;
      // Остаток (то, что Ozon не разложил по полям) — в «прочее», чтобы итог сошёлся.
      t.others_amount += op.amount - op.accruals_for_sale - op.sale_commission - op.delivery_charge;
      continue;
    }
    if (op.group === 'logistics' || op.group === 'packaging') t.processing_and_delivery += op.amount;
    else if (op.group === 'returnLogistics') t.refunds_and_cancellations += op.amount;
    else if (op.group === 'compensation') t.compensation_amount += op.amount;
    else if (op.group === 'acquiring' || (op.group === 'other' && op.amount > 0)) t.others_amount += op.amount;
    else t.services_amount += op.amount;
  }
  for (const k of Object.keys(t) as (keyof LegacyTotals)[]) t[k] = Math.round(t[k] * 100) / 100;
  return t;
}
