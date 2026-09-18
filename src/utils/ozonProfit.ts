// Формула прибыли Ozon — как в калькуляторе клиента (calcul-ozon), но комиссия,
// логистика и эквайринг подставляются ЖИВЬЁМ из ценового API Ozon
// (v5/product/info/prices → commissions.sales_percent_fbo, fbo_deliv_to_customer_amount, acquiring).
// См. docs/КАЛЬКУЛЯТОРЫ_КЛИЕНТА_ЛОГИКА.md.

export type OzonCalcInput = {
  price: number;      // цена продавца (ЛК)
  cost: number;       // себестоимость, ₽
  commission: number; // комиссия Ozon, % (sales_percent_fbo)
  spp: number;        // скидка площадки, % (цена покупателя = price × (1 − spp/100))
  drr: number;        // реклама, %
  acquiring: number;  // эквайринг, ₽/шт (Ozon отдаёт абсолютом, не %)
  logistic: number;   // логистика Ozon, ₽/шт (доставка + магистраль)
  storage: number;    // хранение, ₽/шт
  returnBase: number; // стоимость обработки возврата, ₽ (fbo_return_flow_amount)
  returnRate: number;
  /** Факт: обратная логистика на 1 проданную шт (отмены+возвраты), ₽. Если задано — вместо returnBase×returnRate. */
  returnCostPerSale?: number; // % возвратов
  usn: number;        // УСН, %
  nds: number;        // НДС, %
};

export type OzonCalcResult = {
  profit: number;
  margin: number;   // %
  roi: number;      // %
  buyerPrice: number;
  breakdown: {
    cost: number; commission: number; acquiring: number; logistic: number;
    storage: number; returnCost: number; usn: number; nds: number; ads: number;
  };
};

export const OZON_DEFAULTS = {
  usn: 1, nds: 5, acquiring: 15, drr: 7, spp: 30, commission: 41, logistic: 156, storage: 5,
  returnBase: 85, returnRate: 5,
};

export function calcOzonProfit(i: OzonCalcInput): OzonCalcResult | null {
  if (!(i.price > 0)) return null;
  const buyerPrice = i.price * (1 - i.spp / 100);          // цена покупателя (база налога/показа)
  const commission = i.price * (i.commission / 100);        // комиссия — от цены продавца
  const acquiring = i.acquiring;                            // эквайринг (₽ из API)
  const usn = buyerPrice * (i.usn / 100);                   // УСН сверху от цены покупателя
  const nds = (buyerPrice - usn) * (i.nds / (100 + i.nds)); // НДС выделяется изнутри
  const ads = i.price * (i.drr / 100);                      // реклама (ДРР)
  const returnCost = i.returnCostPerSale != null && Number.isFinite(i.returnCostPerSale) ? i.returnCostPerSale : i.returnBase * (i.returnRate / 100);   // обратная логистика (возвраты)
  const totalCosts = i.cost + commission + acquiring + i.logistic + i.storage + returnCost + usn + nds + ads;
  const profit = i.price - totalCosts;
  const margin = i.price > 0 ? profit / i.price * 100 : 0;
  const roi = i.cost > 0 ? profit / i.cost * 100 : 0;
  return { profit, margin, roi, buyerPrice, breakdown: { cost: i.cost, commission, acquiring, logistic: i.logistic, storage: i.storage, returnCost, usn, nds, ads } };
}
