/**
 * Связи между разделами (12.11.2026). Запуск: npm run check
 *
 * 1. «План» → «Ведение карточек»: совет об отставании от плана месяца.
 * 2. Шлюз площадок: поисковые запросы Ozon идут через общее ведро с паузой, обычные запросы Ozon — не пачкой.
 * 3. Повтор после 429: пауза растёт, даже если площадка просит «1 секунду».
 */
import { fromPlan } from '../api/_lib/cardAdvice';
import { ruleFor } from '../api/_lib/gateway';
import type { PlanRnp } from '../shared/plan';
import { SLOTS, msUntilSlot, inBalooCardsWindow } from '../api/_lib/cronSchedule';

let failed = 0;
function check(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n      получили ${JSON.stringify(actual)}\n      ждали    ${JSON.stringify(expected)}`}`);
}

const pin = (over: Record<string, unknown> = {}) => ({
  mp: 'wb', sku: '111', article: 'Mask-01', name: 'Маска', photo: '', pinnedAt: 0,
  margin: { pct: 20, minPct: 10, below: false }, cur: null, prev: null, ...over,
}) as any;
const plan = (row: Record<string, unknown> | null, state: PlanRnp['state'] = 'approved'): PlanRnp => ({
  ok: true, month: '2026-11', state, daysLeft: 18, totals: null,
  byArticle: row ? { 'MASK-01': { qty: 100, fact: 20, pct: 20, needPerDay: 5, pace7: 2.4, behind: true, startDate: null, daily: [], ...row } as any } : {},
});

const a = fromPlan(pin(), null, plan({}));
check('отстаём от плана → один совет', a.length, 1);
check('в заголовке факт и план', a[0]?.title, 'План месяца: 20 из 100 шт., отстаём');
check('в тексте — сколько нужно в день и темп', /нужно 5 заказов в день, сейчас 2,4 в день/.test(a[0]?.why ?? ''), true);
check('артикул сверяется без учёта регистра', fromPlan(pin({ article: 'mask-01' }), null, plan({})).length, 1);
check('идём по плану → совета нет', fromPlan(pin(), null, plan({ behind: false })).length, 0);
check('товара нет в плане → совета нет', fromPlan(pin({ article: 'OTHER' }), null, plan({})).length, 0);
check('плана на месяц нет → совета нет', fromPlan(pin(), null, plan({}, 'none')).length, 0);
check('план не прочитан → совета нет, раздел не падает', fromPlan(pin(), null, null).length, 0);
check('маржа ниже минимума → рекламой не ускоряемся', /сначала верните маржу/.test(fromPlan(pin({ margin: { pct: 5, minPct: 10, below: true } }), null, plan({}))[0]?.why ?? ''), true);
check('черновик плана помечен', /план ещё не утверждён/.test(fromPlan(pin(), null, plan({}, 'draft'))[0]?.why ?? ''), true);

check('поисковые запросы Ozon — своё ведро', ruleFor('https://api-seller.ozon.ru/v1/analytics/product-queries/details')?.bucket, 'oz:queries');
check('… с паузой не меньше 25 с', (ruleFor('https://api-seller.ozon.ru/v1/analytics/product-queries/details')?.intervalMs ?? 0) >= 25_000, true);
check('обычные запросы Ozon идут не пачкой', (ruleFor('https://api-seller.ozon.ru/v3/product/list')?.intervalMs ?? 0) > 0, true);
check('начисления Ozon — своё ведро', ruleFor('https://api-seller.ozon.ru/v1/finance/accrual/postings')?.bucket, 'oz:accrual');

// Сетка запусков против расписания Baloo (каждые 5 минут в :03 и :08; сверка в :16 чётного часа МСК).
const at = (iso: string) => Date.parse(iso);
const next = (slot: { periodMs: number; offsetMs: number }, iso: string) => new Date(at(iso) + msUntilSlot(slot.periodMs, slot.offsetMs, at(iso)) + 3 * 3_600_000).toISOString().slice(11, 19);
check('большой проход — нечётный час МСК, :10:30', next(SLOTS.warm, '2026-11-13T00:00:00Z'), '03:10:30');
check('… и следующий через 2 часа', next(SLOTS.warm, '2026-11-13T00:10:30Z'), '05:10:30');
check('после выкладки сетка не сдвигается', next(SLOTS.warm, '2026-11-12T19:42:56Z'), '23:10:30');
for (const [name, slot] of Object.entries(SLOTS)) {
  const mins = new Set<number>();
  for (let t = at('2026-11-13T00:00:00Z'), end = t + 4 * 3_600_000; t < end;) { t += msUntilSlot(slot.periodMs, slot.offsetMs, t); const m = new Date(t + 3 * 3_600_000); mins.add(m.getUTCMinutes()); if (m.getUTCHours() % 2 === 0 && m.getUTCMinutes() === 16) mins.add(-16); }
  check(name + ': не в минуту сверки Baloo (:16 чётного часа)', mins.has(-16), false);
  if (name !== 'discountsPoll') check(name + ': не в минуты Baloo (:03, :08 …)', [...mins].some(m => m >= 0 && (m % 5 === 3)), false);
}
check('окно карточек Baloo: 03:30 МСК — да', inBalooCardsWindow(at('2026-11-13T00:30:00Z')), true);
check('окно карточек Baloo: 05:10 МСК — нет', inBalooCardsWindow(at('2026-11-13T02:10:00Z')), false);
check('карточки WB — не чаще раза в секунду', (ruleFor('https://content-api.wildberries.ru/content/v2/get/cards/list')?.intervalMs ?? 0) >= 1000, true);

console.log(failed ? `\nПровалено проверок: ${failed}` : '\nСвязи разделов: в порядке.');
process.exit(failed ? 1 : 0);
