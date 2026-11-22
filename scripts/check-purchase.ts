/**
 * Проверка расчёта «Закупок» (19.11.2026): FBO одной площадки не помогает другой, коробки,
 * минимальный заказ, сигналы, сезонность по истории, разбор трекера закупщика.
 * Запуск: npx tsx scripts/check-purchase.ts
 */
import {
  DEFAULT_SETTINGS, calcRow, daysUntilOut, matchCalendarPurchase, mergePlanStatuses, moneyCheck, parseTracker, purchaseKey, resolveSkip, roundToBox, seasonFromHistory, seasonRelative, usefulStock,
  type PurchaseInput,
} from '../shared/purchase';
import { addMonths, calcSeason, mainQueries, seasonIndex, winterDrop } from '../shared/season';

let fails = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fails++; console.error(`✗ ${name}: получили ${JSON.stringify(got)}, ждали ${JSON.stringify(want)}`); } else console.log(`✓ ${name}`);
};
const T = '2026-11-19';
const S = { ...DEFAULT_SETTINGS, usd: 100 };
const inp = (p: Partial<PurchaseInput>): PurchaseInput => ({
  key: 'A', name: 'A', articles: ['A'], rate: { wb: 0, wbg: 0, ozon: 0 }, sold7: 0, sold30: 0, inStockDays: 30,
  stockFf: 0, stockFbo: 0, fbo: { wb: 0, ozon: 0 }, transit: 0, lots: [], boxQty: 0, weightG: 1000,
  factoryPrice: 100, landedCost: 150, leadOwn: 0, leadSamples: 0, skip: false, planStatus: '', planQty: 0, ...p,
});

check('дубль WB Global — тот же товар', purchaseKey('cp-carlinkit-mini-dubl'), 'CP-CARLINKIT-MINI');
check('коробка: 101 → 150 при коробке 50', roundToBox(101, 50), 150);
check('без коробки — до целого', roundToBox(10.2, 0), 11);

// FBO Ozon 1000 шт., продаж на Ozon нет, на WB 10 в день: для WB товара нет.
const x1 = inp({ rate: { wb: 10, wbg: 0, ozon: 0 }, fbo: { wb: 0, ozon: 1000 } });
check('FBO Ozon не продаётся на WB', usefulStock(x1, 30, 1), 0);
check('дней до конца — 0', Math.round(daysUntilOut(x1, 10, 1, true)), 0);
// FBS годится всем: 600 шт. при 10+10 в день = 30 дней.
const x2 = inp({ rate: { wb: 10, wbg: 0, ozon: 10 }, stockFf: 600 });
check('FBS общий: 600 / 20 = 30 дней', Math.round(daysUntilOut(x2, 20, 1, true)), 30);
// FBO WB 100 (хватит WB на 10 дней) + FBS 300: всего продастся за 20 дней 100 + 300 = 400 = 20 × 20.
const x3 = inp({ rate: { wb: 10, wbg: 0, ozon: 10 }, stockFf: 300, fbo: { wb: 100, ozon: 0 } });
check('FBO WB + FBS = 20 дней', Math.round(daysUntilOut(x3, 20, 1, true)), 20);

// Заказ: 10 в день, срок 37, запас 35+10. Остатка нет → поздно, заказ 450, кратно 100 → 500.
const r1 = calcRow(inp({ rate: { wb: 10, wbg: 0, ozon: 0 }, boxQty: 100 }), S, T, 37);
check('нет остатка — поздно', r1.signal, 'late');
check('заказ на 45 дней кратно коробке', r1.qty, 500);
check('сумма фабрике', r1.sumFactory, 50_000);
check('логистика $2/кг × 1 кг × 100 ₽', r1.sumLogistics, 100_000);
// Остатка на 100 дней: заказать через 100 − 37 − 10 = 53 дня → зелёный, к приходу останется страховой запас 100, заказ 350 — после прихода снова 45 дней.
const r2 = calcRow(inp({ rate: { wb: 10, wbg: 0, ozon: 0 }, stockFf: 1000 }), S, T, 37);
check('запас есть — зелёный', [r2.signal, r2.daysToOrder, r2.qty], ['ok', 53, 350]);
// Через 5 дней пора — жёлтый.
const r3 = calcRow(inp({ rate: { wb: 10, wbg: 0, ozon: 0 }, stockFf: 520 }), S, T, 37);
check('заказать в течение недели — жёлтый', [r3.signal, r3.daysToOrder], ['soon', 5]);
// Лишнее на FBO площадки — пометка.
const r4 = calcRow(inp({ rate: { wb: 1, wbg: 0, ozon: 5 }, fbo: { wb: 500, ozon: 0 } }), S, T, 37);
check('лишний FBO WB помечен', r4.notes.some(n => n.includes('FBO WB лишние')), true);
check('Ozon без товара — поздно, хотя на WB полно', r4.signal, 'late');
check('не закупаем — без сигнала', calcRow(inp({ rate: { wb: 10, wbg: 0, ozon: 0 }, skip: true }), S, T, 37).signal, 'skip');
check('«Вывод» в «Плане» — сам в архиве', resolveSkip('Вывод', undefined), { skip: true, skipBy: 'plan' });
check('архив «Плана» — в архиве', resolveSkip('Архив', undefined).skip, true);
check('статус: старый «Рабочий» на площадке без товара не перебивает «Вывод»', mergePlanStatuses([{ status: 'Рабочий', seen: false }, { status: 'Вывод', seen: true }]), 'Вывод');
check('статус: на обеих живых площадках главнее «Рабочий»', mergePlanStatuses([{ status: 'Рабочий', seen: true }, { status: 'Вывод', seen: true }]), 'Рабочий');
check('статус: нигде не виден — по всем площадкам', mergePlanStatuses([{ status: 'Вывод', seen: false }, { status: 'Новинка', seen: false }]), 'Новинка');
{
  const K = ['ALLPOWERS-STAN1,5KWH-AP-S2000-PRO', 'ALLPOWERS-STAN3,5KWH-AP-R4000', 'ALLPOWERS-STAN1.8KWH-AP-P1800', 'CARLINKIT-ULTRA2-KRUG-8-128', 'CARLINKIT-ULTRA3-KRUG-8-128-SCREEN', 'AFERIY-STAN-AF-P280-2KWH', 'AFERIY-DOPBAT-AF-P280-B--2KWH'];
  check('календарь: s2000 pro 60 шт', matchCalendarPurchase('s2000 pro - 60 шт ,если можно меньше будет гуд', K), { key: 'ALLPOWERS-STAN1,5KWH-AP-S2000-PRO', qty: 60 });
  check('календарь: ULTRA2-KRUG 400 шт', matchCalendarPurchase('ULTRA2-KRUG-8-128 - 400 шт', K), { key: 'CARLINKIT-ULTRA2-KRUG-8-128', qty: 400 });
  check('календарь: P1800 200 штук', matchCalendarPurchase('Allpowers p1800 - 200 штук', K), { key: 'ALLPOWERS-STAN1.8KWH-AP-P1800', qty: 200 });
  check('календарь: без количества — не берём', matchCalendarPurchase('Логистика', K), null);
  check('календарь: P280 без уточнения — не угадываем', matchCalendarPurchase('Эфери p280 - 10 шт', K), null);
}
check('«Рабочий» — закупаем', resolveSkip('Рабочий', undefined), { skip: false, skipBy: '' });
check('галочка главнее «Плана»: закупаем, хоть «Вывод»', resolveSkip('Вывод', false), { skip: false, skipBy: 'hand' });
check('галочка: в архив, хоть «Рабочий»', resolveSkip('Рабочий', true), { skip: true, skipBy: 'hand' });
check('новинка без продаж — темп по плану', calcRow(inp({ planQty: 300 }), S, T, 37).ratePerDay, 10);

// Сезонность по истории: окно факта (окт–ноя) год назад 100 тыс./мес., январь 150 тыс. → ×1,5.
const hist = { '2025-10': 100_000, '2025-11': 100_000, '2025-12': 120_000, '2026-01': 150_000, '2026-10': 150_000, '2026-11': 150_000 };
check('сезонность января ×1,5', seasonFromHistory(hist, T, '2027-01-01', 31), 1.5);
check('нет истории на месяц — null', seasonFromHistory(hist, T, '2027-03-01', 10), null);
const young = { ...hist, '2026-10': 500_000, '2026-11': 500_000 };
check('товар год назад только раскручивался — не верим', seasonFromHistory(young, T, '2027-01-01', 31), null);

// Трекер: доставленная строка даёт срок, едущая — дату прихода (план. дата «Москва» + дни до ФФ).
const ser = (d: string) => (Date.parse(d + 'T00:00:00Z') - Date.UTC(1899, 11, 30)) / 86_400_000;
const row = (o: number, art: string, pay: string, ff: string, status: string, next = '', nextDate = '') => {
  const r: unknown[] = Array(24).fill('');
  r[0] = o; r[1] = ser(pay); r[3] = art; r[4] = 100; r[9] = ser(pay); r[18] = ff ? ser(ff) : ''; r[19] = status; r[20] = next; r[21] = nextDate ? ser(nextDate) : '';
  return r;
};
const tr = parseTracker([
  row(1, 'A', '2026-09-01', '2026-10-08', '✅ Доставлено'),
  row(2, 'A-DUBL', '2026-09-10', '2026-10-20', '✅ Доставлено'),
  row(3, 'A', '2026-11-01', '', '🚚 Китай → Москва', '✈️ Прибытие в Москву', '2026-12-01'),
], T, 4);
check('срок по истории', tr.leads.get('A'), [37, 40]);
check('партия в пути: приход = Москва + 4 дня', tr.lots.map(l => [l.order, l.eta]), [['3', '2026-12-05']]);
const bad = parseTracker([row(4, 'B', '2028-11-01', '', '🚚 Китай → Москва')], T, 4);
check('описка в годе замечена', bad.lots[0].issues.some(i => i.includes('2028')), true);

// Деньги: остаток 1 млн все дни, порог 500 тыс. Срочный товар на 300 тыс. влезает, второй на 400 тыс. — уже нет.
const cash = Array.from({ length: 200 }, (_, i) => ({ date: new Date(Date.parse(T + 'T00:00:00Z') + i * 864e5).toISOString().slice(0, 10), end: 1_000_000 }));
const mk = (key: string, d: number, sum: number) => ({ ...calcRow(inp({ key, rate: { wb: 10, wbg: 0, ozon: 0 } }), S, T, 37), key, daysToOrder: d, orderBy: T, signal: 'late' as const, qty: 1, sumFactory: sum, sumLogistics: 0 });
const m1 = moneyCheck([mk('A', -1, 300_000), mk('B', 0, 400_000)], cash, 500_000, T, 4);
check('деньги: первый влезает, второй нет', [m1.affordable, m1.postpone], [['A'], ['B']]);
check('деньги: не хватает 200 тыс. с сегодня', [m1.firstShort, m1.shortfall], [T, 200_000]);
check('деньги: искать — сразу', m1.askBy, T);
check('деньги: инвестор 25 % на 120 дней', m1.investCost, Math.round(200_000 * 0.25 * 120 / 365));
const m2 = moneyCheck([mk('A', -1, 300_000)], cash, 500_000, T, 4);
check('деньги: хватает — нехватки нет', [m2.firstShort, m2.shortfall, m2.investCost], [null, 0, 0]);

// Сезонность по категориям (21.11): форма года, а не объём — частый и редкий запрос весят одинаково.
const flat = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`2025-${String(i + 1).padStart(2, '0')}`, 100]));
const peak = { ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`2025-${String(i + 1).padStart(2, '0')}`, 10])), '2025-12': 40 };
const si = seasonIndex([{ query: 'ровный', months: flat }, { query: 'пик', months: peak }]);
check('сезон: среднее месяцев = 1', Math.round(si.k.reduce((a: number, b) => a + (b ?? 0), 0) / 12 * 1000) / 1000, 1);
check('сезон: декабрь выше января', (si.k[11] ?? 0) > (si.k[0] ?? 0), true);
check('сезон: частый ровный запрос не гасит пик редкого', Math.round((si.k[11] ?? 0) * 100) / 100, Math.round((1 + 40 / 12.5) / 2 / ((11 * (1 + 10 / 12.5) / 2 + (1 + 40 / 12.5) / 2) / 12) * 100) / 100);
check('сезон: меньше 3 месяцев — не берём', seasonIndex([{ query: 'x', months: { '2025-01': 5, '2025-02': 6 } }]).queries, 0);
check('сезон: пропуск месяцев', seasonIndex([{ query: 'x', months: { '2025-01': 5, '2025-02': 5, '2025-03': 5, '2026-07': 99 } }], ['2026-07']).k[6], null);
check('сезон: спад янв–фев к ноя–дек', winterDrop([0.5, 0.5, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]), 0.5);
check('сезон: без зимы — нет спада', winterDrop([null, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]), null);
check('главные запросы без бренда', mainQueries([{ query: 'allpowers r600', freq: 900 }, { query: 'Портативная электростанция', freq: 500 }, { query: '123456', freq: 999 }, { query: 'электростанция', freq: 300 }, { query: 'зарядная станция', freq: 100 }], ['allpowers'], 2), ['портативная электростанция', 'электростанция']);

// Сезонность для расчёта (22.11): только повторившаяся два года; новый тренд не берём.
const yr = (from: string, vals: number[]) => Object.fromEntries(vals.map((v, i) => [addMonths(from, i), v]));
// Ноябрь 2024 … октябрь 2026; декабрь (индекс 1 от ноября) — пик оба года.
const both = { ...yr('2024-11', [10, 30, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10]), ...yr('2025-11', [10, 25, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10]) };
const cs = calcSeason([{ query: 'q', months: both }], null, '2026-10')!;
check('сезон расчёта: декабрь повторился — поднят', cs.k[11] > 1.3, true);
check('сезон расчёта: обычный месяц чуть ниже пика', cs.k[5] < 1 && cs.k[5] > 0.85, true);
check('сезон расчёта: тренда нет', cs.trendFrom, '');
// Пик только во втором году — не сезон.
const once = { ...yr('2024-11', Array(12).fill(10)), ...yr('2025-11', [10, 10, 10, 10, 10, 10, 10, 10, 10, 30, 10, 10]) };
check('сезон расчёта: пик один год — не берём', calcSeason([{ query: 'q', months: once }], null, '2026-10')!.k[7], 1);
// Летом 2026 рост в 3 раза к 2025 — тренд; в сезонность идёт форма первого года (июль +20 %).
const trend = { ...yr('2024-11', [10, 10, 10, 10, 10, 10, 10, 10, 12, 12, 10, 10]), ...yr('2025-11', [10, 10, 10, 10, 10, 10, 10, 15, 36, 36, 30, 30]) };
const ct = calcSeason([{ query: 'q', months: trend }], null, '2026-10')!;
check('сезон расчёта: новый тренд найден', ct.trendFrom, '2026-07');
check('сезон расчёта: при тренде пик не раздут', ct.k[6] < 1.25, true);
check('сезон расчёта: площадка только смягчает', calcSeason([{ query: 'q', months: both }], [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1.1], '2026-10')!.k[11], 1.1);
check('сезон расчёта: Вордстата за 2 года нет — null', calcSeason([{ query: 'q', months: yr('2025-11', Array(12).fill(10)) }], null, '2026-10'), null);
const kDec = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1.5];
check('множитель: декабрь к ноябрю ×1,5', Math.round(seasonRelative(kDec, '2026-12-01', '2026-12-01', 31) * 100) / 100, 1.5);
const xs = calcRow(inp({ rate: { wb: 10, wbg: 0, ozon: 0 }, sold30: 300, seasonCat: { category: 'Доски', wb: kDec, ozon: Array(12).fill(1), trendFrom: '' } }), S, '2026-11-01', 20);
check('категория главнее истории', xs.season.by, 'category');
check('деньги в товаре', calcRow(inp({ stockFf: 1000, stockFbo: 500, transit: 100, landedCost: 150 }), S, T, 20).stockMoney, 225000);

if (fails) { console.error(`\nОшибок: ${fails}`); process.exit(1); }
console.log('\nЗакупки: всё сходится');
