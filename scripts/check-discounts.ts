// Проверка решений агента «Заявки на скидку» (08.11.2026).
import { decide, toTask, apiPrice, unsetProducts, marginAtDiscount, maxPctForMargin, saveRules, listRules, type DiscountRule } from '../api/_lib/discounts';
import { _useAdsDbForTests } from '../api/_lib/ads/store';
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

eq('режим не выбран → вручную', decide(t, undefined, 'manual', null).action, 'skip');
eq('нет правила, умолчание — отклонять', decide(t, undefined, 'decline', null).action, 'decline');
eq('товар «отклонять»', decide(t, rule({ mode: 'decline' }), 'manual', null).action, 'decline');
eq('режим снят → вручную', decide(t, rule({ mode: 'manual', maxPct: 10 }), 'decline', null).action, 'skip');
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
const lim18 = maxPctForMargin(inp, 18)!;
const byMargin = decide(small, rule({ minMargin: 18 }), 'manual', inp);
eq('маржа ограничивает скидку', [byMargin.action, byMargin.price, lim18 < 10], ['approve', Math.ceil(600 * (1 - lim18 / 100)), true]);
eq('… и маржа после — не ниже порога', (byMargin.marginPct ?? 0) >= 18, true);
// Потолок 10 % от цены ЛК (решение владельца 08.11).
eq('маржа позволяет 19,7 % → всё равно не больше 10 %', decide(small, rule({ minMargin: 10 }), 'manual', inp).price, 540);
eq('старое правило 25 % → не больше 10 %', decide(small, rule({ maxPct: 25 }), 'manual', inp).price, 540);
eq('просят в рамках → как просили', decide({ showcase: 600, requested: 570 }, rule({ maxPct: 25, minMargin: 10 }), 'manual', inp).price, 570);
eq('маржа уже ниже порога → отклонить', decide(small, rule({ maxPct: 20, minMargin: 30 }), 'manual', inp).action, 'decline');
eq('скидка 0 % → отклонить', decide(small, rule({ maxPct: 0 }), 'manual', inp).action, 'decline');
eq('маржа без себестоимости → вручную', decide(small, rule({ minMargin: 10 }), 'manual', null).action, 'skip');

// Пример владельца 08.11: мин. маржа задана. Скидка покупателя опускает маржу ниже порога —
// даём цену ровно под порог; не опускает — одобряем как просили (разница остаётся в прибыли).
// inp: маржа без скидки 23,5 %, при −5 % — 20,6 %, при −10 % — 17,3 %.
const own1 = decide({ showcase: 600, requested: 540 }, rule({ minMargin: 20 }), 'manual', inp); // просят −10 % → 17,3 % < 20
eq('просьба роняет маржу ниже порога → цена под порог', [own1.action, (own1.marginPct ?? 0) >= 20 && (own1.marginPct ?? 0) < 20.2], ['approve', true]);
const own2 = decide({ showcase: 600, requested: 570 }, rule({ minMargin: 20 }), 'manual', inp); // просят −5 % → 20,6 % ≥ 20
eq('после скидки маржа выше порога → как просили', [own2.action, own2.price, own2.marginPct], ['approve', 570, 20.6]);

// Либо макс. скидка, либо мин. маржа (решение владельца 08.11).
_useAdsDbForTests(':memory:');
let capErr = ''; try { saveRules({ article: 'Y', mode: 'approve', maxPct: 11 }, 't'); } catch (e) { capErr = (e as Error).message; }
eq('правило больше 10 % не сохраняется', capErr.includes('до 10'), true);
saveRules({ article: 'X', mode: 'approve', maxPct: 7 }, 't');
saveRules({ article: 'X', minMargin: 17 }, 't');
eq('мин. маржа стирает скидку', [listRules().X.maxPct, listRules().X.minMargin], [null, 17]);
saveRules({ article: 'X', maxPct: 5 }, 't');
eq('скидка стирает мин. маржу', [listRules().X.maxPct, listRules().X.minMargin], [5, null]);

// Ошибка 08.11: в approve Ozon ждёт цену в масштабе ЛК. Живая заявка: ЛК 188 800, витрина 113 323;
// отправили цену покупателя 112 984 — Ozon записал 67 816 (= 112 984 × 113 323 / 188 800).
const live = { base: 188800, showcase: 113323 };
const sent = apiPrice(live, 112984);
eq('цена покупателя 112 984 → в ЛК', sent, 188236);
eq('после пересчёта Ozon покупатель платит не меньше', Math.round(sent * 113323 / 188800) >= 112984, true);
eq('«как просили» ≈ requested_price из заявки', Math.abs(apiPrice(live, 107657) - 179360) <= 1, true);
let threw = ''; try { apiPrice(live, 50000); } catch (e) { threw = (e as Error).message; }
eq('скидка 40 % от ЛК не уходит', threw.includes('больше 10 %'), true);
let t11 = ''; try { apiPrice(live, Math.floor(113323 * 0.89)); } catch (e) { t11 = (e as Error).message; }
eq('скидка 11 % не уходит', t11.includes('больше 10 %'), true);
eq('скидка ровно 10 % уходит', apiPrice(live, Math.ceil(113323 * 0.9)) >= 188800 * 0.9, true);
eq('не выше цены ЛК', apiPrice(live, 113323), 188800);

// Напоминание в чат Ozon (08.11): товар без правила, режим снят или «Одобрять» без размера.
const un = unsetProducts({ A: rule({ maxPct: 1 }), B: rule({ mode: 'decline' }), C: rule({ mode: 'manual' }), D: rule({}), E: rule({ minMargin: 15 }) }, ['A', 'B', 'C', 'D', 'E', 'F']);
eq('без правила: C (снят), D (без размера), F (нет правила)', un.map(x => x.article), ['C', 'D', 'F']);

console.log(ok ? '\nЗаявки на скидку: в порядке.' : '\nОШИБКА');
if (!ok) process.exit(1);
