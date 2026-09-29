/**
 * Сводный финансовый расчёт по обоим маркетплейсам — рубль в рубль.
 *
 * Что считается на стороне маркетплейсов (точно):
 *   - Выручка (брутто и нетто после возвратов)
 *   - Комиссии маркетплейса
 *   - Логистика (доставка покупателю, обратная доставка, эквайринг)
 *   - Хранение FBO (если есть в отчёте)
 *   - Реклама — из финансового отчёта (попадает в services/deduction)
 *   - Штрафы, удержания, компенсации
 *
 * Что добавляем со своей стороны:
 *   - Себестоимость = sum(штуки × purchasePrice) — из Google-таблицы по SKU
 *
 * Итоговая чистая прибыль = Выручка − Комиссии − Логистика − Эквайринг −
 *                          Хранение − Реклама − Себестоимость − Штрафы
 */
import { OzonFinTotals, OzonFinList, OzonFinOperation } from '../api/ozonFinance';
import { WbFinanceTotals } from '../api/wbFinance';
import { ProcurementItem } from '../api/googleSheets';

export type MpFinance = {
  mp: 'ozon' | 'wb';
  grossRevenue: number;       // выручка до возвратов
  netRevenue: number;         // после возвратов
  commission: number;         // комиссия МП
  logistics: number;          // доставка + эквайринг + возвраты
  storage: number;            // хранение FBO
  ads: number;                // реклама
  /**
   * Известен ли расход на рекламу вообще.
   * false — источник не ответил (нет кредов / не прогрето / 429 / окно не то),
   * и `ads: 0` здесь означает «не знаем», а НЕ «рекламы не было». Интерфейс
   * обязан показать прочерк: ложный 0% ДРР рядом с подписью «рекламы нет» —
   * это и есть жалоба клиента «ДРР есть, но рекламы нет» (телемост 11.08, п. 3).
   */
  adsKnown: boolean;
  other: number;              // прочие удержания (штрафы, компенсации, услуги)
  unitsSold: number;          // штук продано (минус возвраты)
  unitsBySku: Record<string, number>;
};

export type FinanceSummary = {
  ozon: MpFinance;
  wb: MpFinance;

  totalGrossRevenue: number;
  totalNetRevenue: number;
  totalCommission: number;
  totalLogistics: number;
  totalStorage: number;
  totalAds: number;
  totalOther: number;
  totalCogs: number;          // себестоимость проданных товаров

  // Итоговые показатели
  marginRub: number;          // маржа = netRevenue − комиссии − логистика − хранение − реклама − штрафы − себестоимость
  marginPct: number;          // % от выручки
  roiPortfolio: number;       // ROI портфеля = marginRub / totalCogs × 100
  drr: number;                // ДРР = ads / netRevenue × 100
  roas: number | null;        // ROAS = выручка_от_рекламы / ads — нужны данные кампаний (опционально)
  netProfit: number;          // чистая прибыль = marginRub (для ясности, отдельным именем)

  // Точность данных
  hasWbCogsData: boolean;     // нашли ли себестоимость для проданных WB SKU
  hasOzonCogsData: boolean;
  skusWithoutCost: string[];  // те SKU за которые продали но не нашли purchasePrice
};

// ─── Сборка финансов Ozon из API ──────────────────────────────────────────
export function buildOzonFinance(
  totals: OzonFinTotals | null,
  ops: OzonFinOperation[],
  skuToOffer?: Map<string, string>,   // числовой sku → offer_id (для джойна COGS)
): MpFinance {
  const t = totals?.result;
  const grossRevenue = t?.accruals_for_sale || 0;
  const refunds = t?.refunds_and_cancellations || 0;
  const netRevenue = grossRevenue + refunds; // refunds приходит отрицательным
  const commission = Math.abs(t?.sale_commission || 0);
  const processing = Math.abs(t?.processing_and_delivery || 0);

  // Расходы на рекламу из операций (operation_type содержит Advertising)
  let ads = 0;
  let storage = 0;
  let other = 0;
  const unitsBySku: Record<string, number> = {};
  let unitsSold = 0;
  for (const op of ops) {
    const code = op.operation_type || '';
    if (/Advertising|MarketingAction|Promo/i.test(code)) {
      ads += Math.abs(op.amount || 0);
    } else if (/Storage|FBOStorage|Warehousing/i.test(code)) {
      storage += Math.abs(op.amount || 0);
    } else if (op.type === 'services' || op.type === 'compensation' || op.type === 'other') {
      // Не реклама/хранение, но из тех же категорий — относим в «прочее»
      const isExpense = op.amount < 0;
      if (isExpense) other += Math.abs(op.amount);
    }
    // Штуки и SKU — из items по продажам. Ключ — offer_id (артикул), чтобы он
    // совпал с себестоимостью из таблицы закупок. Если маппинга нет — числовой sku
    // как fallback (тогда COGS по этой позиции не найдётся, но штуки посчитаются).
    if (op.type === 'orders' && op.items?.length) {
      for (const it of op.items) {
        const sku = String(it.sku || '');
        if (!sku) continue;
        const key = skuToOffer?.get(sku) || sku;
        unitsBySku[key] = (unitsBySku[key] || 0) + 1;
        unitsSold += 1;
      }
    } else if (op.type === 'returns' && op.items?.length) {
      for (const it of op.items) {
        const sku = String(it.sku || '');
        if (!sku) continue;
        const key = skuToOffer?.get(sku) || sku;
        unitsBySku[key] = (unitsBySku[key] || 0) - 1;
        unitsSold -= 1;
      }
    }
  }

  return {
    mp: 'ozon',
    grossRevenue,
    netRevenue,
    commission,
    logistics: processing,
    storage,
    ads,
    // Здесь известна только рекламная часть из финансовых операций (промо-акции).
    // Трафареты/Поиск живут в Performance API и добавляются в useFinanceSummary —
    // если их не удалось получить, флаг там же снимается.
    adsKnown: totals != null,
    other,
    unitsSold,
    unitsBySku,
  };
}

// ─── Сборка финансов WB ───────────────────────────────────────────────────
// wbAdsRub — реальные траты на рекламу WB из advert-api (adv/v3/fullstats),
// передаются хуком. Раньше рекламу ошибочно брали из колонки `deduction` отчёта
// (это прочие удержания, не реклама) → ДРР был кривой. Теперь deduction идёт в
// «прочее», а реклама — отдельным числом (0, если промо-API недоступен).
export function buildWbFinance(wb: WbFinanceTotals | null, wbAdsRub?: number): MpFinance {
  if (!wb) {
    return {
      mp: 'wb',
      grossRevenue: 0, netRevenue: 0, commission: 0, logistics: 0,
      storage: 0, ads: wbAdsRub ?? 0, adsKnown: wbAdsRub !== undefined,
      other: 0, unitsSold: 0, unitsBySku: {},
    };
  }
  return {
    mp: 'wb',
    grossRevenue: wb.retailRevenue,
    netRevenue: wb.netRevenue,
    commission: wb.commissionTotal,
    logistics: wb.deliveryTotal + wb.acquiringTotal + wb.rebillLogisticTotal,
    storage: wb.storageTotal,
    // ?? 0 нужен для арифметики итогов, но сам факт незнания несём отдельно —
    // иначе «не смогли получить» и «расхода не было» на экране неразличимы.
    ads: wbAdsRub ?? 0,
    adsKnown: wbAdsRub !== undefined,
    // additional_payment бывает доходом (+) и расходом (−): вычитаем со знаком,
    // чтобы доплата не превращалась ошибочно в расход.
    other: wb.penaltyTotal + wb.acceptanceTotal + wb.deductionTotal - wb.additionalPayment,
    unitsSold: wb.unitsSold - wb.unitsReturned,
    unitsBySku: { ...wb.unitsBySku },
  };
}

// ─── Расчёт себестоимости из Google-таблицы по SKU ────────────────────────
function calcCogs(unitsBySku: Record<string, number>, costMap: Map<string, number>): { cogs: number; missing: string[] } {
  let cogs = 0;
  const missing: string[] = [];
  for (const [sku, units] of Object.entries(unitsBySku)) {
    if (units <= 0) continue;
    const cost = costMap.get(sku.toUpperCase());
    if (cost && cost > 0) {
      cogs += units * cost;
    } else {
      missing.push(sku);
    }
  }
  return { cogs, missing };
}

// ─── Главный сборщик ──────────────────────────────────────────────────────
export function buildFinanceSummary(
  ozon: MpFinance,
  wb: MpFinance,
  procurement: ProcurementItem[],
): FinanceSummary {
  const costMap = new Map<string, number>();
  for (const p of procurement) {
    if (p.purchasePrice > 0) costMap.set(p.sku.toUpperCase(), p.purchasePrice);
  }

  const ozonCogs = calcCogs(ozon.unitsBySku, costMap);
  const wbCogs = calcCogs(wb.unitsBySku, costMap);
  const totalCogs = ozonCogs.cogs + wbCogs.cogs;

  const totalGrossRevenue = ozon.grossRevenue + wb.grossRevenue;
  const totalNetRevenue = ozon.netRevenue + wb.netRevenue;
  const totalCommission = ozon.commission + wb.commission;
  const totalLogistics = ozon.logistics + wb.logistics;
  const totalStorage = ozon.storage + wb.storage;
  const totalAds = ozon.ads + wb.ads;
  const totalOther = ozon.other + wb.other;

  const marginRub = totalNetRevenue - totalCommission - totalLogistics - totalStorage - totalAds - totalOther - totalCogs;
  const marginPct = totalNetRevenue > 0 ? (marginRub / totalNetRevenue) * 100 : 0;
  const roiPortfolio = totalCogs > 0 ? (marginRub / totalCogs) * 100 : 0;
  const drr = totalNetRevenue > 0 ? (totalAds / totalNetRevenue) * 100 : 0;
  const roas = totalAds > 0 ? totalNetRevenue / totalAds : null;

  return {
    ozon, wb,
    totalGrossRevenue, totalNetRevenue,
    totalCommission, totalLogistics, totalStorage,
    totalAds, totalOther, totalCogs,
    marginRub, marginPct, roiPortfolio, drr, roas,
    netProfit: marginRub,
    hasOzonCogsData: Object.keys(ozon.unitsBySku).length > 0 && ozonCogs.cogs > 0,
    hasWbCogsData: Object.keys(wb.unitsBySku).length > 0 && wbCogs.cogs > 0,
    skusWithoutCost: [...ozonCogs.missing, ...wbCogs.missing],
  };
}
