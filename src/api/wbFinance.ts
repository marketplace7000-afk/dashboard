/**
 * WB Финансовый отчёт о реализации — рубль в рубль.
 *
 * Endpoint: statistics-api.wildberries.ru /api/v5/supplier/reportDetailByPeriod
 * Параметры: dateFrom=YYYY-MM-DD, dateTo=YYYY-MM-DD, rrdid=0 (или последний rrdid
 * для пагинации), limit (по умолчанию 100000).
 *
 * Каждая строка — одна операция: продажа, возврат, логистика, удержание,
 * штраф и т.д. Поле `supplier_oper_name` — название операции, `ppvz_for_pay` —
 * сумма к перечислению продавцу, `quantity` — штуки.
 *
 * ⚠ WB Statistics API лимитирует ~1 запрос/минуту. Кэшируем агрессивно (60 мин).
 */
import { wbFetch } from './wbQueue';

export type WbFinanceRow = {
  realizationreport_id: number;
  date_from: string;
  date_to: string;
  create_dt: string;
  suppliercontract_code: string | null;
  rrd_id: number;
  gi_id: number;
  subject_name: string;
  nm_id: number;
  brand_name: string;
  sa_name: string;             // артикул продавца
  ts_name: string;             // размер
  barcode: string;
  doc_type_name: string;       // «Продажа» / «Возврат»
  quantity: number;
  retail_price: number;        // цена розничная
  retail_amount: number;       // выручка
  sale_percent: number;
  commission_percent: number;
  office_name: string;
  supplier_oper_name: string;  // тип операции
  order_dt: string;
  sale_dt: string;
  rr_dt: string;
  shk_id: number;
  retail_price_withdisc_rub: number;   // итоговая цена для покупателя
  delivery_amount: number;
  return_amount: number;
  delivery_rub: number;        // логистика к удержанию
  gi_box_type_name: string;
  product_discount_for_report: number;
  supplier_promo: number;
  rid: number;
  ppvz_spp_prc: number;
  ppvz_kvw_prc_base: number;
  ppvz_kvw_prc: number;
  sup_rating_prc_up: number;
  is_kgvp_v2: number;
  ppvz_sales_commission: number;       // комиссия WB ₽
  ppvz_for_pay: number;                // к перечислению продавцу (главное число)
  ppvz_reward: number;
  acquiring_fee: number;
  acquiring_bank: string;
  ppvz_vw: number;
  ppvz_vw_nds: number;
  ppvz_office_id: number;
  ppvz_office_name: string;
  ppvz_supplier_id: number;
  ppvz_supplier_name: string;
  ppvz_inn: string;
  declaration_number: string;
  bonus_type_name: string;
  sticker_id: string;
  site_country: string;
  penalty: number;
  additional_payment: number;
  rebill_logistic_cost: number;
  rebill_logistic_org: string;
  kiz: string;
  storage_fee?: number;        // хранение FBO (бывает в новых отчётах)
  deduction?: number;          // удержания (платная приёмка, реклама и т.п.)
  acceptance?: number;         // платная приёмка
};

// ─── Новый фин-эндпоинт WB (07.2026) ────────────────────────────────────────
// statistics-api /api/v5/supplier/reportDetailByPeriod УДАЛЯЕТСЯ 15.07.2026.
// Замена: POST finance-api.wildberries.ru /api/finance/v1/sales-reports/detailed
// (лимит 1/мин). Поля ответа переехали в camelCase, суммы приходят СТРОКАМИ.
// Нормализуем в старую snake_case-форму WbFinanceRow, чтобы aggregateWbFinance
// и все потребители не менялись.
type WbFinanceRowV1 = Record<string, any>;

const numS = (v: any): number => {
  if (v == null || v === '') return 0;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
};

function normalizeV1Row(r: WbFinanceRowV1): WbFinanceRow {
  return {
    realizationreport_id: r.reportId ?? 0,
    date_from: r.dateFrom ?? '', date_to: r.dateTo ?? '', create_dt: r.createDate ?? '',
    suppliercontract_code: null,
    rrd_id: r.rrdId ?? 0, gi_id: r.giId ?? 0,
    subject_name: r.subjectName ?? '', nm_id: r.nmId ?? 0, brand_name: r.brandName ?? '',
    sa_name: r.vendorCode ?? '',           // артикул продавца: sa_name → vendorCode
    ts_name: r.techSize ?? '', barcode: r.sku ?? '',
    doc_type_name: r.docTypeName ?? '',
    quantity: r.quantity ?? 0,
    retail_price: numS(r.retailPrice),
    retail_amount: numS(r.retailAmount),
    sale_percent: r.salePercent ?? 0, commission_percent: numS(r.commissionPercent),
    office_name: r.officeName ?? '',
    supplier_oper_name: r.sellerOperName ?? '',
    order_dt: r.orderDt ?? '', sale_dt: r.saleDt ?? '', rr_dt: r.rrDate ?? '',
    shk_id: r.shkId ?? 0,
    retail_price_withdisc_rub: numS(r.retailPriceWithDisc),
    delivery_amount: r.deliveryAmount ?? 0, return_amount: r.returnAmount ?? 0,
    delivery_rub: numS(r.deliveryService),  // логистика: delivery_rub → deliveryService
    gi_box_type_name: r.giBoxTypeName ?? '',
    product_discount_for_report: numS(r.productDiscountForReport),
    supplier_promo: numS(r.sellerPromo), rid: 0,
    ppvz_spp_prc: numS(r.spp), ppvz_kvw_prc_base: numS(r.kvwBase), ppvz_kvw_prc: numS(r.kvw),
    sup_rating_prc_up: numS(r.supRatingUp), is_kgvp_v2: numS(r.isKgvpV2),
    ppvz_sales_commission: numS(r.ppvzSalesCommission),
    ppvz_for_pay: numS(r.forPay),
    ppvz_reward: numS(r.ppvzReward),
    acquiring_fee: numS(r.acquiringFee), acquiring_bank: r.acquiringBank ?? '',
    ppvz_vw: numS(r.vw), ppvz_vw_nds: numS(r.vwNds),
    ppvz_office_id: r.ppvzOfficeId ?? 0, ppvz_office_name: r.ppvzOfficeName ?? '',
    ppvz_supplier_id: 0, ppvz_supplier_name: r.ppvzSupplierName ?? '', ppvz_inn: r.ppvzSupplierInn ?? '',
    declaration_number: r.declarationNumber ?? '', bonus_type_name: '',
    sticker_id: r.stickerId ?? '', site_country: r.country ?? '',
    penalty: numS(r.penalty),
    additional_payment: numS(r.additionalPayment),
    rebill_logistic_cost: numS(r.rebillLogisticCost), rebill_logistic_org: '',
    kiz: r.kiz ?? '',
    storage_fee: numS(r.paidStorage),      // хранение: storage_fee → paidStorage
    deduction: numS(r.deduction),
    acceptance: numS(r.paidAcceptance),    // приёмка: acceptance → paidAcceptance
  };
}

/**
 * Получить полный финансовый отчёт за период.
 * Сначала — новый finance-api (sales-reports/detailed), при неудаче — старый
 * v5 reportDetailByPeriod (работает до 15.07.2026, кэш от прежних прогревов).
 */
export async function wbReportDetail(dateFrom: string, dateTo: string): Promise<WbFinanceRow[]> {
  // Новый эндпоинт. Cron-only: сборщик греет одну страницу (rrdId=0, limit=100000)
  // на месячное окно; браузер читает тот же кэш (ключ нормализован по датам).
  try {
    const rows = await wbFetch<WbFinanceRowV1[]>(`/wb/finance/api/finance/v1/sales-reports/detailed`, {
      method: 'POST',
      body: JSON.stringify({ dateFrom, dateTo, limit: 100000, rrdId: 0, period: 'weekly' }),
    });
    if (Array.isArray(rows)) return rows.map(normalizeV1Row);
  } catch (e) {
    console.warn('[wbFinance] finance-api недоступен, пробуем старый v5:', (e as Error)?.message);
  }
  // Fallback: старый v5 (удаляется 15.07.2026). Держим на переходный период.
  const url = `/wb/statistics/api/v5/supplier/reportDetailByPeriod?dateFrom=${dateFrom}&dateTo=${dateTo}&rrdid=0&limit=100000`;
  const batch = await wbFetch<WbFinanceRow[]>(url);
  return Array.isArray(batch) ? batch : [];
}

/**
 * Свернуть строки отчёта в агрегаты по статьям расходов / доходов.
 * Знаки: продажи положительные, возвраты/комиссии/логистика — со знаком к перечислению (минус если удержание).
 */
export type WbFinanceTotals = {
  // Продажи (выручка для покупателя)
  retailRevenue: number;        // sum(retail_amount) для doc_type=Продажа
  refundRevenue: number;        // sum(retail_amount) для doc_type=Возврат
  netRevenue: number;           // retail - refund (выручка нетто)

  // К перечислению (сумма продавцу до удержаний доп. услуг)
  forPayTotal: number;          // sum(ppvz_for_pay)

  // Комиссии WB
  commissionTotal: number;      // sum(ppvz_sales_commission)
  acquiringTotal: number;       // sum(acquiring_fee)

  // Логистика
  deliveryTotal: number;        // sum(delivery_rub) — к удержанию
  rebillLogisticTotal: number;  // sum(rebill_logistic_cost)

  // Прочие удержания
  penaltyTotal: number;         // sum(penalty)
  additionalPayment: number;    // sum(additional_payment)
  storageTotal: number;         // sum(storage_fee)
  deductionTotal: number;       // sum(deduction) — обычно «Реклама» сюда попадает
  acceptanceTotal: number;      // sum(acceptance)

  // Штуки
  unitsSold: number;
  unitsReturned: number;

  // Разбивка для дальнейших расчётов себестоимости
  unitsBySku: Record<string, number>; // sa_name → штуки (продажа − возврат)
};

export function aggregateWbFinance(rows: WbFinanceRow[]): WbFinanceTotals {
  const t: WbFinanceTotals = {
    retailRevenue: 0, refundRevenue: 0, netRevenue: 0,
    forPayTotal: 0,
    commissionTotal: 0, acquiringTotal: 0,
    deliveryTotal: 0, rebillLogisticTotal: 0,
    penaltyTotal: 0, additionalPayment: 0,
    storageTotal: 0, deductionTotal: 0, acceptanceTotal: 0,
    unitsSold: 0, unitsReturned: 0,
    unitsBySku: {},
  };
  for (const r of rows) {
    const sku = (r.sa_name || '').toUpperCase();
    const q = r.quantity || 0;
    const isReturn = r.doc_type_name === 'Возврат';
    if (isReturn) {
      t.refundRevenue += r.retail_amount || 0;
      t.unitsReturned += q;
      if (sku) t.unitsBySku[sku] = (t.unitsBySku[sku] || 0) - q;
    } else if (r.doc_type_name === 'Продажа') {
      t.retailRevenue += r.retail_amount || 0;
      t.unitsSold += q;
      if (sku) t.unitsBySku[sku] = (t.unitsBySku[sku] || 0) + q;
    }
    t.forPayTotal += r.ppvz_for_pay || 0;
    t.commissionTotal += r.ppvz_sales_commission || 0;
    t.acquiringTotal += r.acquiring_fee || 0;
    t.deliveryTotal += r.delivery_rub || 0;
    t.rebillLogisticTotal += r.rebill_logistic_cost || 0;
    t.penaltyTotal += r.penalty || 0;
    t.additionalPayment += r.additional_payment || 0;
    t.storageTotal += r.storage_fee || 0;
    t.deductionTotal += r.deduction || 0;
    t.acceptanceTotal += r.acceptance || 0;
  }
  t.netRevenue = t.retailRevenue - t.refundRevenue;
  return t;
}
