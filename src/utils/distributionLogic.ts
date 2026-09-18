import { ProcurementItem } from '../api/googleSheets';

export type DistResult = {
  turnOzon: number | null;
  turnWB: number | null;
  needOzon: number;
  needWB: number;
  splitOzon: number;
  splitWB: number;
  splitReasonText: string;
  ozonBlocked: boolean;
  wbBlocked: boolean;
  sendFromWarehouseOzon: number;
  sendFromWarehouseWB: number;
  sendFromTransitOzon: number;
  sendFromTransitWB: number;
  warehouseAfter: number;
  storagWarnOzon: boolean;
  storagWarnWB: boolean;
  shipmentDays: number;
  priority: 'high' | 'medium' | 'low' | 'none';
  hasAction: boolean;
  daysToNextTransit: number | null;
  stockoutBeforeTransit: boolean;
};

export function calcDistribution(
  p: ProcurementItem,
  targetDays: number,
  shipmentDays = 8,
  maxMPDays = 30,
): DistResult {
  const hasOzon = p.dailyOzon > 0;
  const hasWB = p.dailyWB > 0;

  // Транзит учитывается в дефиците/нужде. Реальной разбивки «куда идёт транзит»
  // в Google-таблице сейчас нет — делим пропорционально дневным продажам:
  // что лучше продаётся — туда и поедет бОльшая часть приехавшего.
  const dailySum = p.dailyOzon + p.dailyWB;
  const transitShareOzon = dailySum > 0 ? p.dailyOzon / dailySum : 0.5;
  const expectedTransitOzon = p.tranzitTotal * transitShareOzon;
  const expectedTransitWB = p.tranzitTotal - expectedTransitOzon;

  // Эффективные остатки (на МП + ожидаемая доля транзита) — это то, что
  // фактически будет на площадке после приёмки поставки.
  const effStockOzon = p.stockOzon + expectedTransitOzon;
  const effStockWB = p.stockWB + expectedTransitWB;

  const turnOzon = hasOzon ? Math.round(effStockOzon / p.dailyOzon) : null;
  const turnWB = hasWB ? Math.round(effStockWB / p.dailyWB) : null;

  const mO = p.marginOzon ?? null;
  const mW = p.marginWB ?? null;
  const ozonBlocked = (mO !== null && mO < 0) || !hasOzon;
  const wbBlocked = (mW !== null && mW < 0) || !hasWB;

  let splitOzon: number;
  let splitReasonText: string;

  if (ozonBlocked && wbBlocked) {
    const dSum = p.dailyOzon + p.dailyWB;
    splitOzon = dSum > 0 ? p.dailyOzon / dSum : 0.5;
    splitReasonText = 'Оба МП убыточны — распределение по объёму продаж';
  } else if (ozonBlocked) {
    splitOzon = 0;
    splitReasonText = !hasOzon ? 'Ozon: нет продаж' : `Ozon убыточен (${mO}%) — везём только на WB`;
  } else if (wbBlocked) {
    splitOzon = 1;
    splitReasonText = !hasWB ? 'WB: нет продаж' : `WB убыточен (${mW}%) — везём только на Ozon`;
  } else {
    const dSum = p.dailyOzon + p.dailyWB;
    const velO = dSum > 0 ? p.dailyOzon / dSum : 0.5;
    const velW = 1 - velO;
    const mSum = (mO || 0) + (mW || 0);
    const margO = mSum > 0 ? (mO || 0) / mSum : 0.5;
    const margW = 1 - margO;
    // Дефицит — после учёта ожидаемого транзита
    const defO = hasOzon ? Math.max(0, Math.ceil(p.dailyOzon * targetDays) - effStockOzon) : 0;
    const defW = hasWB ? Math.max(0, Math.ceil(p.dailyWB * targetDays) - effStockWB) : 0;
    const defSum = defO + defW;
    const defFactorO = defSum > 0 ? defO / defSum : 0.5;
    const defFactorW = 1 - defFactorO;
    const scoreO = 0.5 * velO + 0.3 * margO + 0.2 * defFactorO;
    const scoreW = 0.5 * velW + 0.3 * margW + 0.2 * defFactorW;
    const scoreSum = scoreO + scoreW || 1;
    splitOzon = scoreO / scoreSum;
    splitReasonText = `Ozon: скорость ${Math.round(velO * 100)}%, маржа ${mO}% · WB: скорость ${Math.round(velW * 100)}%, маржа ${mW}%`;
  }

  // Нужда тоже с учётом ожидаемого транзита — нет смысла слать на МП ещё столько же,
  // если поставка уже в пути и приедет туда сама.
  const needOzon = hasOzon ? Math.max(0, Math.ceil(p.dailyOzon * targetDays) - effStockOzon) : 0;
  const needWB = hasWB ? Math.max(0, Math.ceil(p.dailyWB * targetDays) - effStockWB) : 0;

  const capOzon = hasOzon ? Math.ceil(p.dailyOzon * maxMPDays) : 0;
  const capWB = hasWB ? Math.ceil(p.dailyWB * maxMPDays) : 0;
  const sendableOzon = Math.max(0, Math.min(needOzon, capOzon - effStockOzon));
  const sendableWB = Math.max(0, Math.min(needWB, capWB - effStockWB));
  const totalSendable = sendableOzon + sendableWB;

  let sendFromWarehouseOzon = 0;
  let sendFromWarehouseWB = 0;
  if (p.warehouseStock > 0 && totalSendable > 0) {
    const canSend = Math.min(p.warehouseStock, totalSendable);
    const rawO = Math.round(canSend * (sendableOzon / totalSendable));
    const rawW = canSend - rawO;
    sendFromWarehouseOzon = Math.min(rawO, sendableOzon);
    sendFromWarehouseWB = Math.min(rawW, sendableWB);
    if (sendFromWarehouseOzon > 0 && sendFromWarehouseOzon < 10) sendFromWarehouseOzon = Math.min(10, p.warehouseStock);
    if (sendFromWarehouseWB > 0 && sendFromWarehouseWB < 10) sendFromWarehouseWB = Math.min(10, p.warehouseStock - sendFromWarehouseOzon);
  }

  const warehouseAfter = p.warehouseStock - sendFromWarehouseOzon - sendFromWarehouseWB;

  let sendFromTransitOzon = 0;
  let sendFromTransitWB = 0;
  if (p.tranzitTotal > 0) {
    const futureStockOzon = p.stockOzon + sendFromWarehouseOzon;
    const futureStockWB = p.stockWB + sendFromWarehouseWB;
    const futureNeedOzon = hasOzon ? Math.max(0, Math.min(capOzon - futureStockOzon, Math.ceil(p.dailyOzon * targetDays) - futureStockOzon)) : 0;
    const futureNeedWB = hasWB ? Math.max(0, Math.min(capWB - futureStockWB, Math.ceil(p.dailyWB * targetDays) - futureStockWB)) : 0;
    const futureTotalNeed = futureNeedOzon + futureNeedWB;
    if (futureTotalNeed > 0) {
      const canSendT = Math.min(p.tranzitTotal, futureTotalNeed);
      const rawO = Math.round(canSendT * (futureNeedOzon / futureTotalNeed));
      const rawW = canSendT - rawO;
      sendFromTransitOzon = Math.min(rawO, futureNeedOzon);
      sendFromTransitWB = Math.min(rawW, futureNeedWB);
    }
  }

  const storagWarnOzon = hasOzon && turnOzon !== null && turnOzon > maxMPDays;
  const storagWarnWB = hasWB && turnWB !== null && turnWB > maxMPDays;

  const minTurn = Math.min(hasOzon ? (turnOzon ?? 999) : 999, hasWB ? (turnWB ?? 999) : 999);

  // Дней до ближайшей поставки в пути
  const today = new Date();
  let daysToNextTransit: number | null = null;
  if (p.tranzitItems && p.tranzitItems.length > 0) {
    const dates = p.tranzitItems
      .map(t => t.date ? new Date(t.date).getTime() : null)
      .filter((d): d is number => d !== null && d >= today.getTime());
    if (dates.length) {
      daysToNextTransit = Math.ceil((Math.min(...dates) - today.getTime()) / 86400000);
    }
  } else if (p.tranzitNext?.date) {
    const t = new Date(p.tranzitNext.date).getTime();
    if (t >= today.getTime()) {
      daysToNextTransit = Math.ceil((t - today.getTime()) / 86400000);
    }
  }

  let priority: DistResult['priority'] = 'none';
  if ((sendFromWarehouseOzon > 0 || sendFromWarehouseWB > 0) && minTurn < 14) priority = 'high';
  else if (sendFromWarehouseOzon > 0 || sendFromWarehouseWB > 0) priority = 'medium';
  else if (sendFromTransitOzon > 0 || sendFromTransitWB > 0) priority = 'low';

  // Эскалация: если МП закончится раньше, чем приедет ближайший транзит — поднимаем приоритет
  const stockoutBeforeTransit =
    daysToNextTransit !== null && minTurn < daysToNextTransit && minTurn < 999;
  if (stockoutBeforeTransit) {
    if (priority === 'medium') priority = 'high';
    else if (priority === 'low') priority = 'medium';
    else if (priority === 'none') priority = 'medium';
  }

  return {
    turnOzon, turnWB, needOzon, needWB,
    splitOzon, splitWB: 1 - splitOzon,
    splitReasonText,
    ozonBlocked, wbBlocked,
    sendFromWarehouseOzon, sendFromWarehouseWB,
    sendFromTransitOzon, sendFromTransitWB,
    warehouseAfter, storagWarnOzon, storagWarnWB,
    shipmentDays, priority,
    hasAction: sendFromWarehouseOzon > 0 || sendFromWarehouseWB > 0 || sendFromTransitOzon > 0 || sendFromTransitWB > 0,
    daysToNextTransit,
    stockoutBeforeTransit,
  };
}
