/**
 * Ozon «Конкуренты» → «Расширенные показатели» (05.11.2026, по ТЗ менеджера «Ozon Competitor Intelligence» v1.0).
 *
 * Источник — тот же отчёт, что менеджер выгружает в XLSX: кабинет Ozon → Аналитика → «Товары на Ozon»
 * (what_to_sell/data/v3). Агент снимает его каждую ночь по каждому SKU за 7 и 28 дней.
 * Здесь три слоя: ozRow — значения отчёта как есть (пропуск = null, не 0); ozMetrics — формулы раздела 4
 * (знаменатель 0 или пусто → null, «н/д»); ozInsights — правила раздела 6 (без выдуманных фактов).
 * Проверка: scripts/check-oz-compare.ts (пример трёх карточек из ТЗ).
 */

/** Значения «Товаров на Ozon» по одной карточке за один период. */
export type Ads2OzRow = {
  period: 7 | 28;
  category: string | null;
  /** Заказано на сумму, ₽ и Заказано, штуки. */
  gmv: number | null; orders: number | null;
  /** Динамика оборота к прошлому периоду, %. */
  dyn: number | null;
  /** Показы всего; Просмотры в поиске и каталоге; Просмотры карточки. */
  views: number | null; searchViews: number | null; pdpViews: number | null;
  /** Конверсия из показа в заказ; В корзину из поиска и каталога; В корзину из карточки, % — как в отчёте. */
  viewToOrder: number | null; toCartSearch: number | null; toCartPdp: number | null;
  /** Средняя и минимальная цена, ₽; скидка от медианной цены, %. */
  avgPrice: number | null; minPrice: number | null; discount: number | null;
  /** Дней в акциях / с продвижением — из period дней. */
  promoDays: number | null; adsDays: number | null;
  /** Доля суммы заказов по акциям, %; Доля рекламных расходов (ДРР), %. */
  promoShare: number | null; drr: number | null;
  /** Остаток на конец периода, шт; «Дней без остатка» (Ozon всегда считает из 28); упущенные продажи, ₽. */
  stock: number | null; stockDays: number | null; missed: number | null;
  /** Доля выкупа, %; дата создания карточки (ISO-дата). */
  buyout: number | null; created: string | null;
  /** Схема (FBO, FBS); признак товара (лидер по продажам и т. п.). */
  schema: string | null; bin: string | null;
};

const n = (v: unknown): number | null => {
  if (v == null || v === '' || v === '-' || v === '—') return null;
  const x = typeof v === 'number' ? v : Number(String(v).replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(x) ? x : null;
};
const s = (v: unknown): string | null => (v == null || v === '' ? null : String(v));

const BIN: Record<string, string> = { leader: 'Лидер по продажам', top_50: 'Топ-50', NoStatus: '' };

/** Строка «Товаров на Ozon» → значения как есть. Пустое остаётся пустым (null), не нулём. */
export function ozRow(x: any, period: 7 | 28): Ads2OzRow | null {
  if (!x || typeof x !== 'object') return null;
  const created = s(x.nullableCreateDate);
  return {
    period,
    category: s(x.category3),
    gmv: n(x.gmvSum ?? x.soldSum), orders: n(x.soldCount), dyn: n(x.salesDynamics),
    views: n(x.views), searchViews: n(x.sessionCountSearch), pdpViews: n(x.qtyViewPdp),
    viewToOrder: n(x.convViewToOrder), toCartSearch: n(x.convToCartSearch), toCartPdp: n(x.pdpToCartConversion ?? x.convToCartPdp),
    avgPrice: n(x.avgPrice), minPrice: n(x.minSellerPrice), discount: n(x.meanPriceDiscount),
    promoDays: n(x.daysInPromo), adsDays: n(x.daysWithTrafarets),
    promoShare: n(x.promoRevenueShare), drr: n(x.drr),
    stock: n(x.stock), stockDays: n(x.accessibilityByDays), missed: n(x.sumMissedGmv),
    buyout: n(x.nullableRedemptionRate), created: created ? created.slice(0, 10) : null,
    schema: s(x.salesSchema), bin: x.bin != null ? (BIN[String(x.bin)] ?? String(x.bin)) || null : null,
  };
}

/** Деление с защитой: пустой или нулевой знаменатель → null (в интерфейсе «н/д»), не 0 и не Infinity. */
export function ratio(a: number | null, b: number | null, k = 1): number | null {
  if (a == null || b == null || !Number.isFinite(a) || !Number.isFinite(b) || b === 0) return null;
  return (k * a) / b;
}

/** Расчётный слой раздела 4 ТЗ — по одной карточке, в пределах одного периода. */
export type Ads2OzMetrics = {
  ctrProxy: number | null;        // 100 × просмотры карточки / показы
  gap: number | null;             // показы − просмотры поиска/каталога
  gapShare: number | null;        // 100 × gap / показы
  pdpToSearch: number | null;     // 100 × просмотры карточки / просмотры поиска
  crPdp: number | null;           // 100 × заказы / просмотры карточки
  ordersPer1k: number | null;     // 1000 × заказы / показы
  gmvPer1k: number | null;        // 1000 × оборот / показы
  avgCheck: number | null;        // оборот / заказы
  adsDaysShare: number | null;    // 100 × дни продвижения / дни периода
  promoDaysShare: number | null;  // 100 × дни акций / дни периода
  adCostEst: number | null;       // оборот × ДРР / 100 — непроверенная оценка
  roasProxy: number | null;       // 100 / ДРР
  stockCover: number | null;      // остаток / (заказы / дни периода)
};

export function ozMetrics(r: Ads2OzRow): Ads2OzMetrics {
  const gap = r.views != null && r.searchViews != null ? r.views - r.searchViews : null;
  const perDay = ratio(r.orders, r.period);
  return {
    ctrProxy: ratio(r.pdpViews, r.views, 100),
    gap,
    gapShare: ratio(gap, r.views, 100),
    pdpToSearch: ratio(r.pdpViews, r.searchViews, 100),
    crPdp: ratio(r.orders, r.pdpViews, 100),
    ordersPer1k: ratio(r.orders, r.views, 1000),
    gmvPer1k: ratio(r.gmv, r.views, 1000),
    avgCheck: ratio(r.gmv, r.orders),
    adsDaysShare: ratio(r.adsDays, r.period, 100),
    promoDaysShare: ratio(r.promoDays, r.period, 100),
    adCostEst: r.gmv != null && r.drr != null ? (r.gmv * r.drr) / 100 : null,
    roasProxy: ratio(100, r.drr),
    stockCover: r.stock != null && r.stock > 0 ? ratio(r.stock, perDay) : null,
  };
}

/** Уровень вывода — как в разделе 6 ТЗ. */
export type OzInsightLevel = 'Наблюдение' | 'Гипотеза' | 'Риск' | 'Предупреждение' | 'Недостаточно данных';
export type OzInsight = { id: string; level: OzInsightLevel; text: string; basis: string; alt: string; check: string };

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const a = [...xs].sort((p, q) => p - q), m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};
const f1 = (v: number) => v.toLocaleString('ru-RU', { maximumFractionDigits: 2 });

/**
 * Правила раздела 6 по одной карточке; peers — все сравниваемые карточки того же периода (для медиан).
 * Никаких категоричных утверждений о каналах рекламы и «органике».
 */
export function ozInsights(r: Ads2OzRow | null, peers: (Ads2OzRow | null)[]): OzInsight[] {
  if (!r) return [{ id: 'nodata', level: 'Недостаточно данных', text: 'Карточки нет в отчёте «Товары на Ozon» за этот период', basis: 'отчёт не вернул строку по SKU', alt: 'за 7 дней Ozon не включает товары без продаж за неделю', check: 'переключить период на 28 дней' }];
  const out: OzInsight[] = [];
  const P = r.period;
  if (r.adsDays != null && r.adsDays >= Math.ceil(P * 5 / 7)) out.push({ id: 'ads', level: 'Наблюдение',
    text: 'Активное продвижение по числу дней; эффективность и канал не подтверждены',
    basis: `дней с продвижением ${r.adsDays} из ${P}`, alt: 'показатель Ozon считает дни, а не бюджет и не каналы',
    check: 'посмотреть карточку в выдаче по ключевым запросам — есть ли пометка «Реклама»' });
  if (r.promoDays != null && r.promoDays >= Math.ceil(P * 5 / 7) && (r.promoShare ?? 0) > 0) out.push({ id: 'promo', level: 'Гипотеза',
    text: 'Акционная механика может быть заметной частью продаж',
    basis: `дней в акциях ${r.promoDays} из ${P}, доля суммы заказов по акциям ${f1(r.promoShare!)} %`, alt: 'акция могла совпасть с сезонным спросом',
    check: 'сравнить цену в акции и без неё, какие акции Ozon у карточки' });
  const cr = ozMetrics(r).crPdp;
  const viewsMed = median(peers.map(p => p?.views).filter((v): v is number => v != null));
  const crMed = median(peers.map(p => (p ? ozMetrics(p).crPdp : null)).filter((v): v is number => v != null));
  if (peers.filter(Boolean).length >= 2 && r.views != null && viewsMed != null && cr != null && crMed != null && r.views > viewsMed && cr < crMed) out.push({ id: 'reach', level: 'Гипотеза',
    text: 'Большой охват, но относительно слабое превращение просмотра в заказ; изучить цену, контент, рейтинг',
    basis: `показы ${f1(r.views)} выше медианы сравниваемых (${f1(viewsMed)}), заказы ÷ просмотры карточки ${f1(cr)} % ниже медианы (${f1(crMed)} %)`,
    alt: 'показы и просмотры — разные счётчики Ozon, окна и пользователи могут не совпадать',
    check: 'открыть карточку: цена против соседей, фото, рейтинг и свежие отзывы' });
  if ((r.pdpViews ?? 0) > 0 && r.orders === 0) out.push({ id: 'noorders', level: 'Наблюдение',
    text: 'Есть просмотры без заказов за период — требуется проверка доступности, цены и релевантности',
    basis: `просмотров карточки ${f1(r.pdpViews!)}, заказов 0`, alt: 'товар мог появиться в наличии только в конце периода',
    check: 'наличие на складах, цена, соответствие запросам' });
  // «Дней без остатка» Ozon у карточек с большим остатком почти всегда близко к 28 (сверено 05.11) — по нему одному
  // вывод не делаем; ограничение наличием видно по нулевому остатку и упущенным продажам.
  if (r.stock === 0 || (r.missed ?? 0) > 0) out.push({ id: 'stock', level: 'Риск',
    text: 'Результаты продаж могли ограничиваться наличием',
    basis: [r.stock === 0 ? 'остаток на конец периода 0' : '', (r.missed ?? 0) > 0 ? `упущенные продажи ${f1(r.missed!)} ₽` : ''].filter(Boolean).join(', '),
    alt: 'остаток мог закончиться в последний день, а продажи шли весь период',
    check: 'есть ли поставка, наличие по складам' });
  if (r.adsDays === 0 && (r.drr ?? 0) > 0) out.push({ id: 'adsdrr', level: 'Предупреждение',
    text: 'Сигналы продвижения расходятся; проверить определение полей и окно атрибуции',
    basis: `дней с продвижением 0 из ${P}, ДРР ${f1(r.drr!)} %`, alt: 'ДРР может включать другие виды рекламы или иное окно',
    check: 'не делать вывод «рекламы не было»; данные не исправлять' });
  return out;
}

/** Методология — для подписи отчёта и экспорта. */
export const OZ_METHOD = 'Источник: кабинет Ozon → Аналитика → «Товары на Ozon», значения отчёта без изменений. '
  + 'CTR proxy = просмотры карточки ÷ показы всего × 100 — условный коэффициент, не официальный CTR Ozon. '
  + 'Разница «показы − просмотры поиска/каталога» — разница разных счётчиков, не рекламные показы. '
  + 'Оценка расходов = оборот × ДРР — непроверенная оценка, не фактический расход. Пустое значение — «н/д», не 0.';
