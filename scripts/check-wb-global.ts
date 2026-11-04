// Проверка формулы WB Global на эталоне из калькулятора клиента (v5.1, расчёт
// CARLINKIT-ULTRA2-KRUG-8-128-DUBL, сохранён в калькуляторе). Запуск: tsx scripts/check-wb-global.ts
import assert from 'node:assert/strict';
import { calcWbGlobal, wbgLogisticsCny, WBG_DEFAULTS } from '../src/utils/wbGlobalProfit';

const near = (a: number, b: number, eps = 0.01, what = '') =>
  assert.ok(Math.abs(a - b) <= eps, `${what}: ${a} ≠ ${b}`);

// Эталон: курс 12.58, цена 1650 ¥, себест. 10048 ₽, 11.5×11×4.3 см (0.544 л).
const r = calcWbGlobal({
  priceCny: 1650, rate: 12.58, cost: 10048, extra: 0, commission: 20, spp: 15.5, buyout: 90,
  fulfillment: 30, drr: 5, acquiring: 2, tax: 6.5, payful: 0.8, volumeL: 0.54395, logFirst: 8, logExtra: 2,
})!;
near(r.price, 20757, 0.01, 'цена');
near(r.buyer, 17539.665, 0.01, 'цена покупателя');
near(r.logistics, 111.8222, 0.01, 'логистика');
near(r.fulfillment, 33.3333, 0.01, 'фулфилмент');
near(r.commission, 4151.4, 0.01, 'комиссия');
near(r.gross, 15007.4544, 0.01, 'поступление');
near(r.payful, 120.0596, 0.01, 'payful');
near(r.tax, 1140.0782, 0.01, 'налог');
near(r.cash, 13747.3166, 0.01, 'на счёт');
near(r.profit, 3699.3166, 0.01, 'прибыль');
near(r.margin, 17.822, 0.001, 'маржа');
near(r.roi!, 36.8164, 0.001, 'ROI');
near(r.breakevenCny! * 12.58, 15229.3205, 0.05, 'безубыточность');

// Логистика без округления — как в детализации WB (отчёт финменеджера):
// 1,56 л → 9,12 ¥ (MANIC-STICK), 4,96 л → 15,92 ¥ (SODA-SIPHON), меньше литра → 8 ¥.
assert.equal(wbgLogisticsCny(1.56, 8, 2), 9.12);
assert.equal(wbgLogisticsCny(4.96, 8, 2), 15.92);
assert.equal(wbgLogisticsCny(0.2, 8, 2), 8);
assert.equal(wbgLogisticsCny(3, 8, 2), 12);
// Безубыточность: при этой цене прибыль ≈ 0.
const be = calcWbGlobal({ priceCny: r.breakevenCny!, rate: 12.58, cost: 10048, extra: 0, commission: 20, spp: 15.5, buyout: 90,
  fulfillment: 30, drr: 5, acquiring: 2, tax: 6.5, payful: 0.8, volumeL: 0.54395, logFirst: 8, logExtra: 2 })!;
near(be.profit, 0, 0.01, 'прибыль в точке безубыточности');
assert.equal(calcWbGlobal({ priceCny: 0, rate: 12, cost: 1, extra: 0, commission: 20, spp: 0, buyout: 90, fulfillment: 0, drr: 0, acquiring: 0, tax: 0, payful: 0, volumeL: 1, logFirst: 8, logExtra: 2 }), null);
console.log('check-wb-global: ok');

// 04.11.2026: цены «как на сайте» — по курсу WB, деньги — по ЦБ.
{
  const r = calcWbGlobal({ ...WBG_DEFAULTS, priceCny: 8680, rate: 12.1816, rateWb: 12.791, cost: 50000, extra: 0, commission: 20, spp: 20, volumeL: 50 } as any)!;
  if (Math.round(r.priceShown) !== 111026) throw new Error('priceShown ' + r.priceShown);
  if (Math.abs(r.buyerShown - 88818) > 5) throw new Error('buyerShown ' + r.buyerShown);
  if (Math.round(r.price) !== Math.round(8680 * 12.1816)) throw new Error('price must use CBR');
  console.log('check-wb-global: rateWb ok');
}
