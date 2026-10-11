/**
 * «Рука на пульсе» (РНП) — справочник метрик, общий для сервера и экрана.
 *
 * Сервер хранит только БАЗОВЫЕ метрики (kind 'sum' и 'last') по дням и товарам
 * (api/_lib/rnp.ts). Производные (средний чек, ДРР, CTR, конверсии) считаются из
 * них на лету — так они верны при любой свёртке: по неделям, по категориям, итого.
 * Складывать проценты нельзя, а делить суммы можно.
 */

export type RnpMp = 'wb' | 'ozon';

export type RnpMetricKind =
  | 'sum'    // складывается по дням и товарам (заказы, рубли, расход)
  | 'last'   // снимок на дату: при свёртке периода берём последнее значение, по товарам — сумму (остатки)
  | 'ratio'; // num / den × scale, считается из базовых

export type RnpUnit = 'pcs' | 'rub' | 'pct' | 'num' | 'days';

export type RnpMetric = {
  key: string;
  label: string;
  short?: string;            // короткая подпись для узкой колонки
  group: 'Продажи' | 'Воронка' | 'Реклама' | 'Остатки';
  unit: RnpUnit;
  kind: RnpMetricKind;
  num?: string; den?: string; scale?: number;   // для ratio
  /** Что считать хорошим ростом: 'up' — больше лучше, 'down' — меньше лучше. Для тепловой карты. */
  better?: 'up' | 'down';
  mps: RnpMp[];
  hint?: string;
};

const BOTH: RnpMp[] = ['wb', 'ozon'];

export const RNP_METRICS: RnpMetric[] = [
  // ── Продажи ──
  { key: 'ordered_cnt', label: 'Заказано, шт', group: 'Продажи', unit: 'pcs', kind: 'sum', better: 'up', mps: BOTH },
  { key: 'ordered_amount', label: 'Заказано, ₽', group: 'Продажи', unit: 'rub', kind: 'sum', better: 'up', mps: BOTH,
    hint: 'WB — цена со скидкой продавца (без СПП); Ozon — «Заказано на сумму» из аналитики' },
  { key: 'avg_bill', label: 'Средний чек, ₽', group: 'Продажи', unit: 'rub', kind: 'ratio', num: 'ordered_amount', den: 'ordered_cnt', mps: BOTH },
  { key: 'ma7_ordered', label: 'Заказы в день, ср. 7 дн', short: 'Ср. 7 дн', group: 'Продажи', unit: 'num', kind: 'last', better: 'up', mps: BOTH,
    hint: 'Среднее число заказов в день за 7 дней, заканчивающихся этой датой' },
  { key: 'cancel_cnt', label: 'Отмены, шт', group: 'Продажи', unit: 'pcs', kind: 'sum', better: 'down', mps: BOTH },
  { key: 'bought_cnt', label: 'Выкуплено, шт', group: 'Продажи', unit: 'pcs', kind: 'sum', better: 'up', mps: ['wb'] },
  { key: 'bought_amount', label: 'Выкуплено, ₽', group: 'Продажи', unit: 'rub', kind: 'sum', better: 'up', mps: ['wb'] },
  { key: 'delivered_cnt', label: 'Доставлено, шт', group: 'Продажи', unit: 'pcs', kind: 'sum', better: 'up', mps: ['ozon'] },
  { key: 'return_cnt', label: 'Возвраты, шт', group: 'Продажи', unit: 'pcs', kind: 'sum', better: 'down', mps: BOTH },

  // ── Воронка (Ozon отдаёт по дням и товарам; у WB по дням — только рекламная часть) ──
  { key: 'hits_view', label: 'Показы', group: 'Воронка', unit: 'num', kind: 'sum', better: 'up', mps: ['ozon'] },
  { key: 'hits_view_search', label: 'Показы в поиске и каталоге', short: 'Показы в поиске', group: 'Воронка', unit: 'num', kind: 'sum', better: 'up', mps: ['ozon'] },
  { key: 'session_view', label: 'Посетители', group: 'Воронка', unit: 'num', kind: 'sum', better: 'up', mps: ['ozon'] },
  { key: 'session_view_pdp', label: 'Посетители карточки', group: 'Воронка', unit: 'num', kind: 'sum', better: 'up', mps: ['ozon'] },
  { key: 'hits_tocart', label: 'Корзина', group: 'Воронка', unit: 'num', kind: 'sum', better: 'up', mps: ['ozon'] },
  { key: 'pct_pdp_to_cart', label: '% в корзину', group: 'Воронка', unit: 'pct', kind: 'ratio', num: 'hits_tocart', den: 'session_view_pdp', scale: 100, better: 'up', mps: ['ozon'],
    hint: 'Корзины ÷ посетители карточки' },
  { key: 'pct_cart_to_order', label: '% заказов из корзины', group: 'Воронка', unit: 'pct', kind: 'ratio', num: 'ordered_cnt', den: 'hits_tocart', scale: 100, better: 'up', mps: ['ozon'] },
  { key: 'pct_session_to_order', label: 'CR в заказ, %', group: 'Воронка', unit: 'pct', kind: 'ratio', num: 'ordered_cnt', den: 'session_view', scale: 100, better: 'up', mps: ['ozon'],
    hint: 'Заказы ÷ посетители' },

  // ── Реклама ──
  { key: 'adv_expenses', label: 'Реклама, расход ₽', short: 'Расход ₽', group: 'Реклама', unit: 'rub', kind: 'sum', better: 'down', mps: BOTH },
  { key: 'percent_drr', label: 'ДРР, %', group: 'Реклама', unit: 'pct', kind: 'ratio', num: 'adv_expenses', den: 'ordered_amount', scale: 100, better: 'down', mps: BOTH,
    hint: 'Расход на рекламу ÷ все заказы товара в рублях' },
  { key: 'adv_views', label: 'Реклама, показы', group: 'Реклама', unit: 'num', kind: 'sum', better: 'up', mps: BOTH },
  { key: 'adv_clicks', label: 'Реклама, клики', group: 'Реклама', unit: 'num', kind: 'sum', better: 'up', mps: BOTH },
  { key: 'adv_ctr', label: 'Реклама, CTR %', group: 'Реклама', unit: 'pct', kind: 'ratio', num: 'adv_clicks', den: 'adv_views', scale: 100, better: 'up', mps: BOTH },
  { key: 'adv_cpc', label: 'CPC, ₽', group: 'Реклама', unit: 'rub', kind: 'ratio', num: 'adv_expenses', den: 'adv_clicks', better: 'down', mps: BOTH },
  { key: 'adv_cpm', label: 'CPM, ₽', group: 'Реклама', unit: 'rub', kind: 'ratio', num: 'adv_expenses', den: 'adv_views', scale: 1000, better: 'down', mps: BOTH },
  { key: 'adv_orders', label: 'Реклама, заказы', group: 'Реклама', unit: 'pcs', kind: 'sum', better: 'up', mps: BOTH },
  { key: 'adv_revenue', label: 'Реклама, заказано ₽', group: 'Реклама', unit: 'rub', kind: 'sum', better: 'up', mps: BOTH },
  { key: 'adv_cpo', label: 'CPO, ₽', group: 'Реклама', unit: 'rub', kind: 'ratio', num: 'adv_expenses', den: 'adv_orders', better: 'down', mps: BOTH,
    hint: 'Расход ÷ заказы из рекламы' },
  { key: 'percent_adv_drr', label: 'ДРР от рекламы, %', group: 'Реклама', unit: 'pct', kind: 'ratio', num: 'adv_expenses', den: 'adv_revenue', scale: 100, better: 'down', mps: BOTH },
  { key: 'adv_share', label: 'Доля заказов из рекламы, %', short: 'Доля рекламы', group: 'Реклама', unit: 'pct', kind: 'ratio', num: 'adv_orders', den: 'ordered_cnt', scale: 100, mps: BOTH },

  // ── Остатки (снимок раз в 2 часа, на дату — последний за день) ──
  { key: 'stocks', label: 'Остатки, шт', group: 'Остатки', unit: 'pcs', kind: 'last', better: 'up', mps: BOTH },
  { key: 'stocks_fbo', label: 'Остатки FBO, шт', group: 'Остатки', unit: 'pcs', kind: 'last', mps: BOTH },
  { key: 'stocks_fbs', label: 'Остатки FBS, шт', group: 'Остатки', unit: 'pcs', kind: 'last', mps: BOTH },
  { key: 'days_of_stock', label: 'Запас, дней', group: 'Остатки', unit: 'days', kind: 'ratio', num: 'stocks', den: 'ma7_ordered', better: 'up', mps: BOTH,
    hint: 'Остаток ÷ средние заказы в день за 7 дней' },
];

export const RNP_METRIC: Record<string, RnpMetric> = Object.fromEntries(RNP_METRICS.map(m => [m.key, m]));

/** Базовые метрики, которые хранит сервер (всё, что не ratio). */
export const RNP_BASE_KEYS = RNP_METRICS.filter(m => m.kind !== 'ratio').map(m => m.key);

export type RnpItem = {
  sku: string;          // ключ: WB — nmId, Ozon — артикул продавца (offer_id)
  article: string;      // артикул продавца
  name: string;
  category: string;
  brand: string;
  photo: string;
  extId?: string;       // Ozon — числовой SKU
};

export type RnpResponse = {
  ok: true;
  mp: RnpMp;
  from: string;
  to: string;
  dates: string[];                                   // YYYY-MM-DD по возрастанию
  items: RnpItem[];
  /** sku → метрика → значения по dates (null — нет данных за день). */
  facts: Record<string, Record<string, Array<number | null>>>;
  /** Метрики, по которым за период есть хоть одно значение. */
  present: string[];
  collectedAt: Record<string, number>;               // источник → когда собирали
  notes: string[];
};
