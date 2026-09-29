// Формула прибыли WB (FBW) — 1-в-1 из калькулятора клиента (kalkulyator-wb-rus).
// См. docs/КАЛЬКУЛЯТОРЫ_КЛИЕНТА_ЛОГИКА.md.

export type WbCalcInput = {
  retail: number;     // СЕРАЯ цена (реальная цена продавца после скидки, не «приманочный» ценник) — база расчёта
  cost: number;       // себестоимость, ₽
  commission: number; // комиссия WB, %
  spp: number;        // СПП, % (цена покупателя = retail × (1 − spp/100))
  drr: number;        // ДРР (реклама), %
  buyout: number;     // % выкупа
  acquiring: number;  // эквайринг, %
  logistic: number;   // логистика, ₽/шт
  storage: number;    // хранение, ₽/шт
  returnBase: number;
  /** Факт: обратная логистика на 1 проданную шт (отмены+возвраты), ₽. Если задано — вместо returnBase×невыкуп. */
  returnCostPerSale?: number; // база обратной логистики при невыкупе, ₽
  usn: number;        // УСН, %
  nds: number;        // НДС, %
};

export type WbCalcResult = {
  profit: number;
  margin: number;   // %
  roi: number;      // %
  sppPrice: number; // цена покупателя с СПП
  breakdown: {
    cost: number; commission: number; acquiring: number; logistic: number;
    storage: number; returnCost: number; usn: number; nds: number; ads: number;
  };
};

export const WB_DEFAULTS = {
  usn: 1, nds: 5, acquiring: 2.5, drr: 7, buyout: 90,
  spp: 30, commission: 25, logistic: 90, storage: 5, returnBase: 46,
};

export function calcWbProfit(i: WbCalcInput): WbCalcResult | null {
  if (!(i.retail > 0)) return null;
  const sppPrice = i.retail * (1 - i.spp / 100);          // цена с СПП (база налога/показа)
  const commission = i.retail * (i.commission / 100);      // комиссия — от ценника
  const acquiring = i.retail * (i.acquiring / 100);        // эквайринг
  const buyoutR = Math.max(1, i.buyout) / 100;
  const returnCost = i.returnCostPerSale != null && Number.isFinite(i.returnCostPerSale) ? i.returnCostPerSale : i.returnBase * (1 - buyoutR) / buyoutR; // возврат невыкупа на 1 выкупленный
  const usn = sppPrice * (i.usn / 100);                    // УСН от цены с СПП
  const nds = (sppPrice - usn) * (i.nds / 100);            // НДС
  const ads = i.retail * (i.drr / 100);                    // реклама (ДРР)
  const totalCosts = i.cost + commission + acquiring + i.logistic + i.storage + returnCost + usn + nds + ads;
  const profit = i.retail - totalCosts;
  const margin = i.retail > 0 ? profit / i.retail * 100 : 0;
  const roi = i.cost > 0 ? profit / i.cost * 100 : 0;
  return { profit, margin, roi, sppPrice, breakdown: { cost: i.cost, commission, acquiring, logistic: i.logistic, storage: i.storage, returnCost, usn, nds, ads } };
}
