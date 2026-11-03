// Юнит-экономика WB Global (китайский кабинет, FBS со склада в России).
//
// Формула 1-в-1 из калькулятора клиента avtovibe-oz-wb-calculator.ru (версия 5.1,
// проверено 03.11.2026 пересчётом его сохранённого расчёта CARLINKIT-ULTRA2:
// совпало до копейки). Сверено с отчётом финменеджера «Отчет Китай WB_2026»
// (детализация WB июль–октябрь, 03.11.2026), отсюда три поправки:
//   - эквайринг 0 %: к перечислению приходит ровно цена × (1 − кВВ), эквайринг
//     уже внутри комиссии (в отчёте «Эквайринг» = 0);
//   - фулфилмент 45 ₽ за заказ (у финменеджера «заказы × 45 ₽»), на продажу — 45 / выкуп;
//   - логистика НЕ округляется: в отчёте 9,12 ¥, 15,92 ¥, 16,55 ¥ и т.п. =
//     8 + (V − 1) × 2 ровно. Объём меньше литра считается за литр.
// Курс у финменеджера — курс ЦБ на дату продажи (не «курс WB»).
//
//   цена ₽          = цена ¥ × курс
//   цена покупателя = цена ₽ × (1 − СПП)        — только для налога и справки
//   комиссия, реклама, эквайринг — % от цены ₽
//   логистика ₽     = (8 + (max(V,1) − 1) × 2) ¥ × курс / выкуп
//   фулфилмент ₽    = ФФ / выкуп
//   поступление     = цена − комиссия − логистика − ФФ − реклама − эквайринг
//   Payful          = поступление × %
//   налог           = цена покупателя × %
//   на счёт         = поступление − Payful − налог
//   прибыль         = на счёт − себестоимость − доп. расходы

export type WbgInput = {
  priceCny: number;     // цена продавца со скидкой, ¥
  rate: number;         // ₽ за 1 ¥
  cost: number;         // себестоимость, ₽
  extra: number;        // доп. расходы на единицу, ₽
  commission: number;   // %
  spp: number;          // %
  buyout: number;       // %
  fulfillment: number;  // ₽ за заказ (ФФ)
  drr: number;          // %
  acquiring: number;    // %
  tax: number;          // % от цены покупателя
  payful: number;       // %
  volumeL: number;      // объём упаковки, л
  logFirst: number;     // ¥ за первый литр
  logExtra: number;     // ¥ за каждый следующий литр
};

export type WbgResult = {
  price: number; buyer: number;
  logisticsCny: number;
  commission: number; logistics: number; fulfillment: number; advertising: number; acquiring: number;
  gross: number; payful: number; tax: number; cash: number;
  cost: number; extra: number;
  profit: number; margin: number; roi: number | null;
  /** Цена безубыточности, ¥ (null — при любой цене в минусе). */
  breakevenCny: number | null;
};

export const WBG_DEFAULTS = {
  rate: 11.58, spp: 10, buyout: 90, fulfillment: 45, drr: 0, acquiring: 0,
  tax: 6.5, payful: 0.8, logFirst: 8, logExtra: 2, commission: 20,
};

export function wbgLogisticsCny(volumeL: number, first: number, extra: number): number {
  const v = Math.max(volumeL || 0, 1);
  return Math.round((first + (v - 1) * extra) * 100) / 100;
}

export function calcWbGlobal(i: WbgInput): WbgResult | null {
  if (!(i.priceCny > 0) || !(i.rate > 0)) return null;
  const b = Math.max(1, i.buyout) / 100;
  const price = i.priceCny * i.rate;
  const buyer = price * (1 - i.spp / 100);
  const logisticsCny = wbgLogisticsCny(i.volumeL, i.logFirst, i.logExtra);
  const logistics = logisticsCny * i.rate / b;
  const fulfillment = i.fulfillment / b;
  const pctOfPrice = (i.commission + i.drr + i.acquiring) / 100;
  const commission = price * i.commission / 100;
  const advertising = price * i.drr / 100;
  const acquiring = price * i.acquiring / 100;
  const gross = price - commission - logistics - fulfillment - advertising - acquiring;
  const payful = gross * i.payful / 100;
  const tax = buyer * i.tax / 100;
  const cash = gross - payful - tax;
  const profit = cash - i.cost - i.extra;
  // Прибыль линейна по цене: profit(P) = P·k − fixed.
  const pf = 1 - i.payful / 100;
  const k = (1 - pctOfPrice) * pf - (1 - i.spp / 100) * i.tax / 100;
  const fixed = (logistics + fulfillment) * pf + i.cost + i.extra;
  const breakevenRub = k > 0 ? fixed / k : null;
  return {
    price, buyer, logisticsCny, commission, logistics, fulfillment, advertising, acquiring,
    gross, payful, tax, cash, cost: i.cost, extra: i.extra, profit,
    margin: price > 0 ? profit / price * 100 : 0,
    roi: i.cost > 0 ? profit / i.cost * 100 : null,
    breakevenCny: breakevenRub != null ? breakevenRub / i.rate : null,
  };
}
