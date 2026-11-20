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
// С 20.11.2026 налог — 6,5 % от полной цены в кабинете, до СПП, без вычетов (было: от
// цены покупателя, как в калькуляторе клиента 5.1 — 1140,08 ₽): 20757 × 6,5 %.
near(r.tax, 1349.205, 0.01, 'налог');
near(r.cash, 13538.1899, 0.01, 'на счёт');
near(r.profit, 3490.1899, 0.01, 'прибыль');
near(r.margin, 16.8145, 0.001, 'маржа');
near(r.roi!, 34.7352, 0.001, 'ROI');
near(r.breakevenCny! * 12.58, 15462.1, 0.5, 'безубыточность');
// СПП на налог больше не влияет.
near(calcWbGlobal({ ...WBG_DEFAULTS, priceCny: 1000, rate: 12, cost: 1, extra: 0, spp: 30, volumeL: 1 } as any)!.tax, 1000 * 12 * 0.065, 0.001, 'налог не зависит от СПП');
// Пример владельцев: цена в кабинете 1000 ¥ → налог 65 ¥, реклама его не уменьшает.
near(calcWbGlobal({ ...WBG_DEFAULTS, priceCny: 1000, rate: 1, cost: 1, extra: 0, spp: 20, drr: 10, volumeL: 1 } as any)!.tax, 65, 0.001, 'налог 6,5 % от 1000 ¥');

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

// 20.11.2026: факты кабинета — логистика из финотчёта на проданную шт не делится на выкуп.
{
  const base = { ...WBG_DEFAULTS, priceCny: 1000, rate: 12, cost: 5000, extra: 0, spp: 20, volumeL: 3, buyout: 50 } as any;
  const t = calcWbGlobal(base)!;
  if (Math.abs(t.logistics - 12 * 12 / 0.5) > 0.001) throw new Error('тариф ÷ выкуп ' + t.logistics);
  const f = calcWbGlobal({ ...base, logisticsFactCny: 15.5 })!;
  if (Math.abs(f.logistics - 15.5 * 12) > 0.001) throw new Error('факт логистики ' + f.logistics);
}
// Факты по товару: свой ДРР/выкуп при ≥ 3 продажах, иначе среднее кабинета; без рекламы — 0.
{
  const { rowFacts } = await import('../api/_lib/wbGlobalFacts');
  const facts: any = { from: '2026-10-21', to: '2026-11-19', finRows: 1, campaigns: 1, finAt: 1, adsAt: 1, acquiringCny: 0, errors: [], byNm: {
    1: { sales: 10, returns: 1, cancels: 2, revenueCny: 9000, deliveryCny: 180, adSpendCny: 900 },
    2: { sales: 1, returns: 1, cancels: 0, revenueCny: 0, deliveryCny: 20, adSpendCny: 100 },
    4: { sales: 1, returns: 0, cancels: 0, revenueCny: 500, deliveryCny: 9, adSpendCny: 50 },
    3: { sales: 5, returns: 0, cancels: 5, revenueCny: 5000, deliveryCny: 100, adSpendCny: 0 },
  } };
  const a = rowFacts(facts, 1);
  if (a.drr.value !== 10 || a.buyout.value !== 83.3 || a.logisticsCny.value !== 20 || a.acquiring.value !== 0) throw new Error('факты товара ' + JSON.stringify(a));
  const b = rowFacts(facts, 2);
  if (b.drr.value !== 7.2 || b.logisticsCny.value !== null || b.buyout.value !== Math.round(17 / 24 * 1000) / 10) throw new Error('среднее кабинета ' + JSON.stringify(b));
  const c = rowFacts(facts, 4);
  if (c.drr.value !== 10 || c.logisticsCny.value !== 9) throw new Error('одна продажа — свой ДРР ' + JSON.stringify(c));
  if (rowFacts(facts, 3).drr.value !== 0 || rowFacts(facts, 99).drr.value !== 0) throw new Error('без рекламы — 0');
  console.log('check-wb-global: facts ok');
}
// Тихие минуты (диспетчер API 20.11): старт Baloo :x3, сверка :16 чётного часа, Мэй :26/:56.
{
  const { busyMinuteWaitMs } = await import('../api/_lib/wbGlobalFacts');
  const at = (h: number, m: number, s = 0) => Date.UTC(2026, 10, 20, h - 3, m, s);
  if (busyMinuteWaitMs(at(10, 13, 10)) <= 0 || busyMinuteWaitMs(at(10, 12, 0)) !== 0) throw new Error('Baloo :x3');
  if (busyMinuteWaitMs(at(10, 16)) <= 0 || busyMinuteWaitMs(at(11, 16)) !== 0) throw new Error(':16 чётного часа');
  if (busyMinuteWaitMs(at(11, 26)) <= 0 || busyMinuteWaitMs(at(6, 0)) <= 0 || busyMinuteWaitMs(at(11, 30)) !== 0) throw new Error('Мэй');
  console.log('check-wb-global: quiet minutes ok');
}
