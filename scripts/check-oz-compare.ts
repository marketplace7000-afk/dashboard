/**
 * «Конкуренты» Ozon → расширенные показатели (05.11.2026): формулы и правила по ТЗ менеджера, раздел 5 и 9.
 * Запуск: npm run check
 */
import { ozInsights, ozMetrics, ozRow } from '../shared/ozCompare';

let failed = 0;
function check(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n      получили ${JSON.stringify(actual)}\n      ждали    ${JSON.stringify(expected)}`}`);
}
const r2 = (v: number | null) => (v == null ? null : Math.round(v * 100) / 100);
const r0 = (v: number | null) => (v == null ? null : Math.round(v));

// Поля — как их отдаёт what_to_sell/data/v3 (строки и числа вперемешку, как в жизни).
const raw = (o: Record<string, unknown>) => ({ category3: 'Внешний аккумулятор', sumMissedGmv: 0, accessibilityByDays: 0, ...o });
const zar = ozRow(raw({ gmvSum: 4447789, soldCount: '2000', views: '1834503', sessionCountSearch: '389254', qtyViewPdp: '67468', daysWithTrafarets: 0, daysInPromo: 3, promoRevenueShare: 0, drr: 9.5, stock: '0' }), 7)!;
const hoco = ozRow(raw({ gmvSum: 4142860, soldCount: '1628', views: '4080718', sessionCountSearch: '319551', qtyViewPdp: '68372', daysWithTrafarets: 7, daysInPromo: 0, promoRevenueShare: 0, drr: 9.5, stock: '1365' }), 7)!;
const ruipu = ozRow(raw({ gmvSum: 3483420, soldCount: '2570', views: '2737213', sessionCountSearch: '366259', qtyViewPdp: '75200', daysWithTrafarets: 7, daysInPromo: 7, promoRevenueShare: 14.1, drr: 13.9, stock: '3530' }), 7)!;

const z = ozMetrics(zar), h = ozMetrics(hoco), u = ozMetrics(ruipu);
check('ZarGrad: CTR proxy 3,68 %', r2(z.ctrProxy), 3.68);
check('ZarGrad: разница счётчиков 1 445 249', z.gap, 1445249);
check('ZarGrad: заказы ÷ карточка 2,96 %', r2(z.crPdp), 2.96);
check('ZarGrad: оборот / 1000 показов 2 425 ₽', r0(z.gmvPer1k), 2425);
check('hoco: CTR proxy 1,68 %', r2(h.ctrProxy), 1.68);
check('hoco: разница 3 761 167', h.gap, 3761167);
check('hoco: доля разницы 92,17 %', r2(h.gapShare), 92.17);
check('hoco: заказы ÷ карточка 2,38 %', r2(h.crPdp), 2.38);
check('hoco: оборот / 1000 показов 1 015 ₽', r0(h.gmvPer1k), 1015);
check('RUIPU: CTR proxy 2,75 %', r2(u.ctrProxy), 2.75);
check('RUIPU: заказы ÷ карточка 3,42 %', r2(u.crPdp), 3.42);
check('RUIPU: оборот / 1000 показов 1 273 ₽', r0(u.gmvPer1k), 1273);
check('RUIPU: промо 7 из 7, ДРР 13,9', [ruipu.promoDays, ruipu.drr], [7, 13.9]);
check('RUIPU: доля дней акций 100 %', u.promoDaysShare, 100);

const peers = [zar, hoco, ruipu];
const ids = (r: typeof zar) => ozInsights(r, peers).map(i => `${i.id}:${i.level}`);
check('hoco: 7 из 7 продвижения — только наблюдение, без «92 % рекламы»', ids(hoco), ['ads:Наблюдение', 'reach:Гипотеза']);
check('hoco: ни один вывод не называет разницу рекламой', ozInsights(hoco, peers).some(i => /92/.test(i.text + i.basis)), false);
check('ZarGrad: 0 дней продвижения при ДРР > 0 — предупреждение; остаток 0 — риск', ids(zar), ['stock:Риск', 'adsdrr:Предупреждение']);
check('RUIPU: продвижение и акции', ids(ruipu), ['ads:Наблюдение', 'promo:Гипотеза']);

// Пустые и нулевые знаменатели — «н/д», не 0 и не Infinity.
const empty = ozRow({ views: '0', qtyViewPdp: '10', soldCount: '0', gmvSum: 0, drr: 0 }, 7)!;
const e = ozMetrics(empty);
check('показы 0 → CTR proxy н/д', e.ctrProxy, null);
check('заказов 0 → средний чек н/д', e.avgCheck, null);
check('ДРР 0 → ROAS н/д', e.roasProxy, null);
check('пропуск остаётся пропуском, не нулём', [ozRow({}, 7)!.stock, ozRow({ drr: '-' }, 7)!.drr], [null, null]);
check('просмотры без заказов — наблюдение', ozInsights(empty, [empty]).map(i => i.id), ['noorders']);
check('нет строки в отчёте — недостаточно данных', ozInsights(null, []).map(i => i.level), ['Недостаточно данных']);
check('28 дней: порог продвижения 20 из 28', ozInsights(ozRow({ daysWithTrafarets: 20, views: '1' }, 28), []).map(i => i.id), ['ads']);
check('дата создания — ISO', ozRow({ nullableCreateDate: '2026-08-05T00:00:00Z' }, 7)!.created, '2026-08-05');

if (failed) { console.log(`\nОшибок: ${failed}`); process.exit(1); }
console.log('\nРасширенные показатели Ozon: всё сходится');
