// Проверка решений агента «Заявки на скидку» (08.11.2026).
import { decide, toTask, apiPrice, unsetProducts, isBuyoutCard, ozonMinDiscount, asAskedRetry, discountOrderRows, orderProfit, marginAtDiscount, maxPctForMargin, saveRules, listRules, type DiscountRule } from '../api/_lib/discounts';
import { _useAdsDbForTests } from '../api/_lib/ads/store';
import { calcOzonProfit } from "../src/utils/ozonProfit";
const calcProfit1000 = () => calcOzonProfit(inp)!.profit;
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
eq('цена покупателя 112 984 → в ЛК (вниз)', sent, 188235);
eq('после пересчёта Ozon цена покупателя — в пределах 1 ₽', Math.abs(sent * 113323 / 188800 - 112984) < 1, true);
eq('«как просили» ≈ requested_price из заявки', Math.abs(apiPrice(live, 107657) - 179360) <= 1, true);
let threw = ''; try { apiPrice(live, 50000); } catch (e) { threw = (e as Error).message; }
eq('скидка 40 % от ЛК не уходит', threw.includes('больше 10 %'), true);
let t11 = ''; try { apiPrice(live, Math.floor(113323 * 0.89)); } catch (e) { t11 = (e as Error).message; }
eq('скидка 11 % не уходит', t11.includes('больше 10 %'), true);
eq('скидка ровно 10 % уходит', apiPrice(live, Math.ceil(113323 * 0.9)) >= 188800 * 0.9, true);
eq('без скидки не уходит: ниже цены ЛК хотя бы на 1 ₽', apiPrice(live, 113323), 188799);

// Напоминание в чат Ozon (08.11): товар без правила, режим снят или «Одобрять» без размера.
const un = unsetProducts({ A: rule({ maxPct: 1 }), B: rule({ mode: 'decline' }), C: rule({ mode: 'manual' }), D: rule({}), E: rule({ minMargin: 15 }) }, ['A', 'B', 'C', 'D', 'E', 'F']);
eq('без правила: C (снят), D (без размера), F (нет правила)', un.map(x => x.article), ['C', 'D', 'F']);

eq('карточка выкупов: 199 ₽ — да, 200 ₽ — нет, нет цены — нет', [isBuyoutCard(199), isBuyoutCard(200), isBuyoutCard(null), isBuyoutCard(0)], [true, false, false, false]);

// Заказ по заявке (08.11): метка WANNADISCOUNT в financial_data.products[].actions. Живой FBS-заказ, деньги v4 — { amount }.
const fbs = { posting_number: "0150258733-0324-1", status: "awaiting_packaging", in_process_at: "2026-11-08T12:28:49Z",
  products: [{ sku: 1, offer_id: "allpowers-stan2kwh-ap-r2500-v2", quantity: 1, price: { amount: "112984", currency: "RUB" } }],
  financial_data: { products: [{ product_id: 1, customer_price: { amount: "60734" }, actions: ["Округление", "WANNADISCOUNT-20261108"] }] } };
const rows = discountOrderRows(fbs, "FBS");
eq("заказ по заявке распознан", rows.map(r => [r.article, r.price, r.customerPrice, r.qty]), [["ALLPOWERS-STAN2KWH-AP-R2500-V2", 112984, 60734, 1]]);
eq("заказ без метки — не по заявке", discountOrderRows({ ...fbs, financial_data: { products: [{ product_id: 1, actions: ["Округление"] }] } }, "FBS").length, 0);
eq("FBO: деньги строкой", discountOrderRows({ posting_number: "x", products: [{ sku: 5, offer_id: "a", price: "990.00", quantity: 2 }], financial_data: { products: [{ product_id: 5, actions: ["WANNADISCOUNT-20261101"] }] } }, "FBO")[0].price, 990);
eq("прибыль заказа = прибыль при цене ЛК × шт", orderProfit(inp, 1000, 2), 2 * (calcProfit1000()));

// Минимум Ozon (12.11): живые отказы. Скидка для покупателя ≥ 300 ₽ (у дешёвых — 5 % витрины).
eq('минимум Ozon: 300 ₽ / 5 % у дешёвых', [ozonMinDiscount(87930), ozonMinDiscount(4928)], [300, 246]);
const eco = toTask({ id: 1, offer_id: 'e', base_price: 151000, original_price: 87930, discount: 63370, requested_price: 150485, status: 'NEW' });
const ecoD = decide(eco, rule({ maxPct: 0.1 }), 'manual', null);
eq('ECOFLOW: правило 0,1 %, просят −300 ₽ → как просили', [ecoD.action, ecoD.price], ['approve', 87630]);
const ecoLk = apiPrice(eco, ecoD.price!);
eq('… в ЛК скидка не меньше 300 ₽ для покупателя', 87930 - ecoLk * 87930 / 151000 >= 300, true);
const afe = toTask({ id: 2, offer_id: 'a', base_price: 184458, original_price: 111143, discount: 73615, requested_price: 183960, status: 'NEW' });
const afeD = decide(afe, rule({ maxPct: 0.3 }), 'manual', null);
eq('AFERIY: как просили, в ЛК = requested_price', [afeD.price, apiPrice(afe, afeD.price!)], [110843, 183960]);
const allp = toTask({ id: 3, offer_id: 'b', base_price: 104848, original_price: 65626, discount: 39522 + 623, requested_price: 103373, status: 'NEW' });
const bigD = decide(allp, rule({ maxPct: 0.3 }), 'manual', null);
eq('просят больше минимума, правило меньше → минимум Ozon 300 ₽', [bigD.action, 65626 - bigD.price!], ['approve', 300]);
eq('правило по марже: минимум Ozon роняет маржу → отклонить', decide({ showcase: 600, requested: 540 }, rule({ minMargin: 23.4 }), 'manual', inp).action, 'decline');
eq('повтор после отказа: как просили', asAskedRetry(eco, rule({ maxPct: 0.1 }), null)?.price, 87630);
eq('повтор: больше 10 % — нет', asAskedRetry(toTask({ id: 4, offer_id: 'x', base_price: 1000, original_price: 600, discount: 1000 - 500 }), rule({ maxPct: 1 }), null), null);

console.log(ok ? '\nЗаявки на скидку: в порядке.' : '\nОШИБКА');
if (!ok) process.exit(1);
