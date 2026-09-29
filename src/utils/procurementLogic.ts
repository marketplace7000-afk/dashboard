import { ProcurementItem } from '../api/googleSheets';
import { safeSetItem } from './safeStorage';
import { calcROI, roiStatus } from './roiLogic';

const GLOBAL_SETTINGS_KEY = 'avtovibe_global_settings';
const CUSTOM_LEAD_KEY = 'avtovibe_custom_lead';
const CUSTOM_PACK_KEY = 'avtovibe_custom_packaging';
const CUSTOM_TARGET_KEY = 'avtovibe_custom_target';
const ARCHIVE_KEY = 'avtovibe_archived_skus';

export type GlobalSettings = {
  leadTime: number;
  packaging: number;
  targetDays: number;
};

export const defaultSettings: GlobalSettings = {
  leadTime: 52,
  packaging: 14,
  targetDays: 60,
};

export function getGlobalSettings(): GlobalSettings {
  try {
    const s = JSON.parse(localStorage.getItem(GLOBAL_SETTINGS_KEY) || '{}');
    return {
      leadTime: s.leadTime ?? defaultSettings.leadTime,
      packaging: s.packaging ?? defaultSettings.packaging,
      targetDays: s.targetDays ?? defaultSettings.targetDays,
    };
  } catch {
    return defaultSettings;
  }
}

export function saveGlobalSettings(s: GlobalSettings) {
  safeSetItem(GLOBAL_SETTINGS_KEY, JSON.stringify(s));
}

function getCustomSetting(key: string): Record<string, number> {
  try { return JSON.parse(localStorage.getItem(key) || '{}'); } catch { return {}; }
}

function setCustomSetting(key: string, sku: string, val: number | null) {
  const dict = getCustomSetting(key);
  if (val !== null && !isNaN(val)) {
    dict[sku] = val;
  } else {
    delete dict[sku];
  }
  safeSetItem(key, JSON.stringify(dict));
}

export function getCustomLeads() { return getCustomSetting(CUSTOM_LEAD_KEY); }
export function setCustomLeadTime(sku: string, val: number | null) { setCustomSetting(CUSTOM_LEAD_KEY, sku, val); }

export function getCustomPackagings() { return getCustomSetting(CUSTOM_PACK_KEY); }
export function setCustomPackaging(sku: string, val: number | null) { setCustomSetting(CUSTOM_PACK_KEY, sku, val); }

export function getCustomTargetDays() { return getCustomSetting(CUSTOM_TARGET_KEY); }
export function setCustomTargetDays(sku: string, val: number | null) { setCustomSetting(CUSTOM_TARGET_KEY, sku, val); }

// Архив теперь РАЗДЕЛЬНЫЙ по разделам: раньше все разделы писали в один ключ
// ARCHIVE_KEY, поэтому товар, скрытый в «Прогнозе закупок», пропадал и в «Ценах»,
// «Распределении» и «Маржинальности». Теперь каждый раздел передаёт свой scope —
// получается отдельный ключ localStorage. Без scope — старый общий ключ (на случай
// если где-то остался вызов без параметра). Унаследованный общий архив НЕ
// мигрируем в scope'ы намеренно: иначе вернулась бы та самая «общность».
export type ArchiveScope =
  | 'procurement'   // Прогноз закупок
  | 'prices-ozon'   // Цены · Ozon
  | 'prices-wb'     // Цены · WB
  | 'distribution'  // Распределение
  | 'card-audit'    // Аудит карточек
  | 'margins';      // Маржинальность

function archiveKey(scope?: ArchiveScope): string {
  return scope ? `${ARCHIVE_KEY}_${scope}` : ARCHIVE_KEY;
}

export function getArchivedSKUs(scope?: ArchiveScope): string[] {
  try { return JSON.parse(localStorage.getItem(archiveKey(scope)) || '[]'); } catch { return []; }
}
export function saveArchivedSKUs(arr: string[], scope?: ArchiveScope): boolean {
  return safeSetItem(archiveKey(scope), JSON.stringify(arr));
}
/** @returns удалось ли сохранить (место в хранилище могло кончиться). */
export function archiveSKU(sku: string, scope?: ArchiveScope): boolean {
  const arr = getArchivedSKUs(scope);
  if (arr.includes(sku)) return true;
  arr.push(sku);
  return saveArchivedSKUs(arr, scope);
}
export function unarchiveSKU(sku: string, scope?: ArchiveScope): boolean {
  const arr = getArchivedSKUs(scope).filter(s => s !== sku);
  return saveArchivedSKUs(arr, scope);
}

export function applyLogic(data: ProcurementItem[], settings: GlobalSettings, transitBySku?: Record<string, number>): ProcurementItem[] {
  const leads = getCustomLeads();
  const packs = getCustomPackagings();
  const targets = getCustomTargetDays();
  const today = new Date();

  return data.map(p => {
    const item = { ...p };

    item.customLeadTime = leads[item.sku];
    item.customPackaging = packs[item.sku];
    item.customTargetDays = targets[item.sku];

    // Транзит на склады МП (FBO) — товары уже едут, скоро в продаже. Учитываем в
    // покрытии наравне с транзитом из Китая: уменьшает рекомендуемый докуп (10.3).
    const mpTransit = transitBySku?.[item.sku.toUpperCase()] ?? 0;
    item.mpTransit = mpTransit;

    const effectiveLeadTime = item.customLeadTime || settings.leadTime;
    const effectivePackaging = (item.customPackaging !== undefined) ? item.customPackaging : settings.packaging;
    const effectiveTargetDays = (item.customTargetDays !== undefined) ? item.customTargetDays : settings.targetDays;
    const totalCycleDays = effectiveLeadTime + effectivePackaging;

    const totalStock = item.stockOzon + item.stockWB + item.warehouseStock;
    const currentTotal = totalStock + item.tranzitTotal + mpTransit;

    const arrivalDays = totalCycleDays;
    const arrivalDate = new Date(today);
    arrivalDate.setDate(arrivalDate.getDate() + arrivalDays);
    const arrivalMonth = arrivalDate.getMonth() + 1;

    function getDailyByMonth(monthIdx: number) {
      const idx = monthIdx - 1;
      const planO = item.planOzon?.[idx] ?? null;
      const planW = item.planWB?.[idx] ?? null;
      const planDaily = ((planO || 0) + (planW || 0)) / 30;
      // План используем ТОЛЬКО если он положительный. Если план по месяцу
      // отсутствует ИЛИ равен нулю (пустая ячейка), но товар реально продаётся —
      // откатываемся на фактическую скорость. Иначе товар с продажами, но нулём
      // в плане, давал потребность 0 → «Закупка не требуется» рядом со статусом
      // «Сейчас» (жалоба клиента 03.07).
      return planDaily > 0 ? planDaily : item.dailyTotal;
    }

    const trendFactor = (() => {
      if (!item.dailyTotal || item.dailyTotal === 0) return 1;
      const daily7 = (item.sales7Ozon + item.sales7WB) / 7;
      const daily30 = item.dailyTotal;
      if (daily30 === 0) return 1;
      const ratio = daily7 / daily30;
      return Math.max(0.5, Math.min(1.5, ratio));
    })();

    const coverageDays = effectiveTargetDays;
    let totalPlanSales = 0;
    let daysLeft = coverageDays;
    let mIdx = 0;
    while (daysLeft > 0) {
      const mo = ((arrivalMonth - 1 + mIdx) % 12) + 1;
      const daysThisMonth = Math.min(daysLeft, 30);
      totalPlanSales += getDailyByMonth(mo) * daysThisMonth;
      daysLeft -= daysThisMonth;
      mIdx++;
    }
    const avgDailyPlan = totalPlanSales / coverageDays;

    const neededTotal = Math.ceil(avgDailyPlan * coverageDays * 1.0);
    const rawQty = Math.max(0, neededTotal - currentTotal);
    // Мин. партия из Китая — 100 шт: заказать меньше физически нельзя.
    // rawSuggestedQty хранит исходный расчёт (для честного UI).
    //  - расчёт ≥ 100        → рекомендуем как есть;
    //  - 0 < расчёт < 100    → округляем ВВЕРХ до партии 100, НО только если она
    //    разойдётся за разумный срок (≤ 1 года). Иначе (медленный SKU: партия =
    //    запас на годы) докуп из Китая не окупается — не пушим заказ, помечаем
    //    batchUneconomical, UI честно объясняет вместо пустого количества.
    const MIN_BATCH = 100;
    const MAX_BATCH_COVER_DAYS = 365;
    const batchCoverDays = item.dailyTotal > 0 ? MIN_BATCH / item.dailyTotal : Infinity;
    item.rawSuggestedQty = rawQty;
    item.batchRoundedUp = false;
    item.batchUneconomical = false;
    if (rawQty <= 0) {
      item.suggestedQty = 0;
    } else if (rawQty >= MIN_BATCH) {
      item.suggestedQty = rawQty;
    } else if (batchCoverDays <= MAX_BATCH_COVER_DAYS) {
      item.suggestedQty = MIN_BATCH;
      item.batchRoundedUp = true;
    } else {
      item.suggestedQty = 0;
      item.batchUneconomical = true;
    }
    item.totalPurchaseCost = Math.round(item.suggestedQty * item.purchasePrice);

    const effectiveDailyNow = item.dailyTotal * trendFactor;
    const daysUntilStockout = effectiveDailyNow > 0 ? Math.floor(currentTotal / effectiveDailyNow) : 999;
    const orderByDays = Math.max(0, daysUntilStockout - totalCycleDays);
    const orderDate = new Date(today);
    orderDate.setDate(orderDate.getDate() + orderByDays);
    item.orderByDate = orderDate.toISOString().split('T')[0];

    item.trendFactor = Math.round(trendFactor * 100) / 100;
    item.planArrivalMonth = arrivalMonth;
    item.avgDailyPlan = Math.round(avgDailyPlan * 100) / 100;
    item.effectiveTargetDays = effectiveTargetDays;

    // «На сколько хватит» и статус считаем с учётом транзита: товар уже в пути
    // фактически уменьшает риск стокаута, даже если на складе сейчас ноль.
    // Если есть и сток и транзит — берём суммарно. Если только транзит —
    // пометка «critical» (не «stop»), т.к. поставка не приехала ещё.
    const stockWithTransit = totalStock + item.tranzitTotal + mpTransit;
    item.daysSupplyTotal = item.dailyTotal > 0 ? Math.round(stockWithTransit / item.dailyTotal) : 999;

    if (stockWithTransit <= 0) item.status = 'stop';
    else if (totalStock <= 0 && item.tranzitTotal > 0) item.status = 'critical';
    else if (item.daysSupplyTotal <= 14) item.status = 'critical';
    else if (item.daysSupplyTotal <= 30) item.status = 'low';
    else item.status = 'ok';

    // ── urgency: пороги привязаны к циклу поставки, а не к фиксированным 14/30 ──
    // При lead=52 + packaging=14 цикл = 66 дн. Если запаса 30 дн — старый статус
    // показывал «low», хотя заказ уже опоздал на 36 дн. urgency лечит это.
    const buffer = Math.max(7, Math.round(totalCycleDays * 0.15)); // ~15% цикла, минимум неделя
    item.urgencyCycleDays = totalCycleDays;
    item.urgencyBufferDays = buffer;
    const covered = item.daysSupplyTotal;
    if (item.dailyTotal <= 0) {
      // продаж нет — не алертим про остатки, отдельная категория
      item.urgency = 'no_movement';
    } else if (covered < totalCycleDays) {
      item.urgency = 'order_now';
    } else if (covered < totalCycleDays + buffer) {
      item.urgency = 'order_soon';
    } else if (covered > 90 && (item.suggestedQty || 0) === 0) {
      item.urgency = 'excess';
    } else {
      item.urgency = 'healthy';
    }

    // ROI per MP
    item.roiOzon = calcROI(item.priceOzon, item.marginOzon, item.purchasePrice);
    item.roiWB = calcROI(item.priceWB, item.marginWB, item.purchasePrice);
    item.roiStatusOzon = roiStatus(item.roiOzon, item.purchasePrice).status;
    item.roiStatusWB = roiStatus(item.roiWB, item.purchasePrice).status;

    return item;
  });
}
