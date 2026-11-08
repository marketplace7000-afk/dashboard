// Проверка решений агента «Заявки на скидку» (08.11.2026).
import { decide, toTask, marginAtDiscount, maxPctForMargin, type DiscountRule } from '../api/_lib/discounts';
import type { OzonCalcInput } from '../src/utils/ozonProfit';

let ok = true;
const eq = (name: string, a: unknown, b: unknown) => { const pass = JSON.stringify(a) === JSON.stringify(b); ok &&= pass; console.log(`  ${pass ? '✓' : '✗'} ${name}: ${JSON.stringify(a)}${pass ? '' : ` ≠ ${JSON.stringify(b)}`}`); };
const rule = (p: Partial<DiscountRule>): DiscountRule => ({ article: 'A', mode: 'approve', maxPct: null, minMargin: null, updatedAt: 0, updatedBy: '', ...p });

// Заявка из живого кабинета 08.11: наша цена 181 725, витрина 113 024, просили скидку 74 352 от нашей цены.
const t = toTask({ id: 163517556571854498, offer_id: 'aferiy-stan', base_price: 181725, original_price: 113024, discount: 74352, requested_price: 172639, requested_price_with_fee: 107685, requested_quantity_min: 1, requested_quantity_max: 1, status: 'NEW' });
eq('просят = наша цена − скидка', t.requested, 107373);
eq('скидка от витрины', t.requestedPct, 5);
eq('артикул — заглавными', t.article, 'AFERIY-STAN');

const big = toTask(JSON.parse('{"id":"163517556571854498","offer_id":"x"}'));
eq('номер заявки не теряет цифры', big.id, '163517556571854498');

eq('нет правила, умолчание — менеджеры', decide(t, undefined, 'manual', null).action, 'skip');
eq('нет правила, умолчание — отклонять', decide(t, undefined, 'decline', null).action, 'decline');
eq('товар «отклонять»', decide(t, rule({ mode: 'decline' }), 'manual', null).action, 'decline');
eq('товар «менеджеры»', decide(t, rule({ mode: 'manual', maxPct: 10 }), 'decline', null).action, 'skip');
eq('одобрять, % не задан', decide(t, rule({}), 'manual', null).action, 'skip');

const ok10 = decide(t, rule({ maxPct: 10 }), 'manual', null);
eq('просят 5 %, можно 10 % → как просили', [ok10.action, ok10.price, ok10.pct], ['approve', 107373, 5]);
const cut = decide(t, rule({ maxPct: 3 }), 'manual', null);
eq('просят 5 %, можно 3 % → встречная цена', [cut.action, cut.price, cut.pct], ['approve', Math.ceil(113024 * 0.97), 3]);

// Экономика: цена ЛК 1000, себестоимость 500, комиссия 20 %, эквайринг 15, логистика 50.
// Скидка N % от витрины уменьшает цену ЛК на те же N % (соинвест Ozon сохраняется).
const inp: OzonCalcInput = { price: 1000, cost: 500, commission: 20, spp: 30, drr: 0, acquiring: 15, logistic: 50, storage: 0, returnBase: 0, returnRate: 0, usn: 0, nds: 0 };
eq('маржа без скидки', marginAtDiscount(inp, 0), 23.5);
eq('маржа при −10 % (цена ЛК 900)', marginAtDiscount(inp, 10), 17.3);
const lim = maxPctForMargin(inp, 10)!;
eq('сколько можно дать при марже ≥ 10 %', lim, 19.7);
const small = { showcase: 600, requested: 420 }; // просят −30 %
const byMargin = decide(small, rule({ maxPct: 25, minMargin: 10 }), 'manual', inp);
eq('маржа ограничивает скидку', [byMargin.action, byMargin.price, byMargin.pct], ['approve', Math.ceil(600 * (1 - lim / 100)), 19.7]);
eq('… и маржа после — не ниже порога', (byMargin.marginPct ?? 0) >= 10, true);
eq('просят в рамках → как просили', decide({ showcase: 600, requested: 570 }, rule({ maxPct: 25, minMargin: 10 }), 'manual', inp).price, 570);
eq('маржа уже ниже порога → отклонить', decide(small, rule({ maxPct: 20, minMargin: 30 }), 'manual', inp).action, 'decline');
eq('скидка 0 % → отклонить', decide(small, rule({ maxPct: 0 }), 'manual', inp).action, 'decline');
eq('маржа без себестоимости → менеджеры', decide(small, rule({ minMargin: 10 }), 'manual', null).action, 'skip');

console.log(ok ? '\nЗаявки на скидку: в порядке.' : '\nОШИБКА');
if (!ok) process.exit(1);
