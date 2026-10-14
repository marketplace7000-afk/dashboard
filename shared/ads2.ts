/**
 * «Реклама 2.0» — общие типы сервера и экрана (этап 1, 14.10.2026).
 * Сервер: api/_lib/ads/overview.ts, экран: src/pages/Ads.tsx.
 */
export type Ads2Mp = 'wb' | 'ozon';

/** Бюджет рекламы по решению владельца 13.10.2026: 5% от суммы заказов по цене продавца. */
export const ADS_BUDGET_SHARE = 0.05;

export type Ads2Day = { date: string; orders: number; spend: number; budget: number };

export type Ads2Budget = {
  sharePct: number;
  /** За выбранный период. */
  orders: number; spend: number; budget: number; drrPct: number | null;
  /** Текущий месяц: факт и прогноз по темпу последних 7 дней. */
  month: { label: string; orders: number; spend: number; budget: number; daysPassed: number; daysInMonth: number;
           forecastOrders: number; forecastSpend: number; forecastBudget: number };
  /** Сегодня: расход против дневной нормы (5% от среднего за 7 дней). */
  today: { spend: number; norm: number };
};

export type Ads2Stat = {
  views: number; clicks: number; spend: number; carts: number; orders: number; revenue: number;
  ctr: number | null; cpc: number | null; cpo: number | null; drr: number | null; avgPos: number | null;
};

export type Ads2CampaignItem = {
  sku: string; article: string; name: string; photo: string; productKey: string | null;
  /** WB — по месту размещения, Ozon — одна ставка. Рубли. */
  bidSearch: number | null; bidReco: number | null; bid: number | null;
  targetCir: number | null; noAds: boolean;
  stat: Ads2Stat | null;
};

export type Ads2Campaign = {
  mp: Ads2Mp; id: string; name: string; status: string; statusCode: number | null;
  /** cpm — за показы, cpc — за клик, cpo — за заказ. */
  payment: string | null;
  /** WB: unified | manual; Ozon: стратегия. */
  bidType: string | null;
  dailyLimit: number | null; dailyLimitOn: boolean | null; spentToday: number | null;
  weeklyBudget: number | null;
  /** Что можно менять вручную. */
  can: { pause: boolean; start: boolean; bid: boolean; dailyLimit: boolean; weeklyBudget: boolean };
  items: Ads2CampaignItem[];
  stat: Ads2Stat | null;
};

export type Ads2IssueCode =
  | 'stock_critical' | 'stock_low' | 'drr_high' | 'spend_no_orders' | 'card_to_cart' | 'cart_to_order'
  | 'low_margin' | 'no_ads_opportunity' | 'flagged_but_running';

export type Ads2Issue = { code: Ads2IssueCode; level: 'critical' | 'warn' | 'info'; text: string };

export type Ads2Product = {
  /** Ключ РНП: WB — nmId, Ozon — артикул продавца. */
  key: string;
  /** Ключ рекламы: WB — nmId, Ozon — SKU. */
  adSku: string | null;
  article: string; name: string; photo: string; category: string; link: string | null;
  orders: number; revenue: number;
  spend: number; drr: number | null; advOrders: number; advShare: number | null;
  stock: number | null; daysOfStock: number | null;
  cardViews: number | null; carts: number | null; pdpToCart: number | null; cartToOrder: number | null;
  avgPos: number | null;
  price: number | null; marginPct: number | null; marginRub: number | null;
  campaigns: { id: string; name: string; status: string }[];
  flag: { reason: string; note: string | null } | null;
  issues: Ads2Issue[];
  /** По дням периода. */
  series: { orders: Array<number | null>; spend: Array<number | null> };
};

export type Ads2Overview = {
  ok: true; mp: Ads2Mp; from: string; to: string; dates: string[];
  budget: Ads2Budget;
  days: Ads2Day[];
  campaigns: Ads2Campaign[];
  products: Ads2Product[];
  /** Медианы конверсий по площадке — от них считаются узкие места. */
  medians: { pdpToCart: number | null; cartToOrder: number | null };
  lastSync: { at: number; result: string[] } | null;
  notes: string[];
};

export const NO_ADS_REASON_LABEL: Record<string, string> = {
  self_buyout: 'Самовыкупы', phase_out: 'Вывод из ассортимента', inactive: 'Карточка неактивна', other: 'Другое',
};

export type Ads2ActionKind = 'pause' | 'start' | 'bid' | 'daily_limit' | 'weekly_budget';
