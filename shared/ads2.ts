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
  /** Остаток к продаже (наличие − резерв) по схемам, последний снимок РНП. */
  stockFbo: number | null; stockFbs: number | null;
  /** Нет остатка с этой даты (YYYY-MM-DD) и сколько ушло на рекламу с тех пор. */
  outSince: string | null; spendSinceOut: number;
  cardViews: number | null; carts: number | null; pdpToCart: number | null; cartToOrder: number | null;
  avgPos: number | null;
  price: number | null; marginPct: number | null; marginRub: number | null;
  campaigns: { id: string; name: string; status: string }[];
  flag: { reason: string; note: string | null } | null;
  /** В архиве «Рекламы» (самовыкуп, дубли): скрыт с экранов, автопилот не трогает. */
  archived: boolean;
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

// ─── Конкуренты из аналитики кабинетов (Агент 3, competitor_watch, 14.10.2026) ──

export type Ads2WbPosItem = {
  nmId: string; name: string; vendorCode: string; photo: string; subject: string; isAdvertised: boolean;
  price: number | null; rating: number | null; feedbackRating: number | null;
  avgPos: number | null; avgPosDyn: number | null; views: number | null; viewsDyn: number | null;
  ctr: number | null; openCard: number | null; orders: number | null; ordersDyn: number | null; visibility: number | null;
  /** Что WB считает плохим для ранжирования (подписи по-русски). */
  bad: string[];
};

export type Ads2WbCompSet = { date: string; free: boolean; opened: boolean; nms: { nmId: string; name: string; photo: string; ours: boolean }[] };

export type Ads2OzMarketItem = {
  rank: number; sku: string; name: string; link: string; photo: string; seller: string; ours: boolean;
  price: number | null; gmv: number | null; sold: number | null; salesDyn: number | null;
  convSearch: number | null; convPdp: number | null; drr: number | null; daysInPromo: number | null; daysWithTrafarets: number | null;
};

/**
 * Конкурент, привязанный к нашему товару (или сам наш товар — строка «мы» для сравнения).
 * Источники цифр: карточка на витрине (цена, рейтинг, отзывы, остаток) — каждую ночь;
 * WB «Сравнение карточек» за 30 дней (заказы, позиция, CTR) — если конкурент есть в открытом наборе;
 * Ozon «Товары на Ozon» (выручка за неделю, ДРР) — если конкурент в топ-50 своей категории.
 */
export type Ads2WatchLink = {
  id: string; url: string;
  source: 'manual' | 'auto'; status: 'active' | 'suggested' | 'ignored';
  title: string; brand: string; seller: string; note: string; photo: string;
  price: number | null; rating: number | null; feedbacks: number | null; stock: number | null;
  orders: number | null; ordersDyn: number | null; avgPos: number | null; ctr: number | null; openCard: number | null;
  inAds: boolean | null; inPromo: boolean | null;
  gmv: number | null; drr: number | null;
};

/** Наш товар (ключ — наш артикул продавца) и его конкуренты. */
export type Ads2WatchProduct = { key: string; ourId: string; name: string; photo: string; our: Ads2WatchLink | null; links: Ads2WatchLink[] };

export type Ads2Competitors = {
  ok: true; mp: Ads2Mp; at: number | null;
  /** Нет снимка — задание ещё не отработало. */
  empty: boolean;
  /** Привязки конкурентов к товарам: правят менеджеры (добавить по ссылке/артикулу, подтвердить, «не тот»). */
  watch: Ads2WatchProduct[];
  /** Наши товары для выбора при добавлении: артикул и название. */
  catalog: { key: string; name: string }[];
  wb?: {
    period: { start: string; end: string } | null;
    summary: { avgPos: number | null; avgPosDyn: number | null; medianPos: number | null; visibility: number | null; advertised: number | null; total: number | null };
    items: Ads2WbPosItem[];
    comparisons: { thisMonth: number | null; remaining: number | null; agentLimit: number; sets: Ads2WbCompSet[] };
  };
  ozon?: {
    categories: { category3Id: string; name: string; updateDate: string | null; ours: Ads2OzMarketItem[]; top: Ads2OzMarketItem[];
      benchmark: { price: number | null; convSearch: number | null; convPdp: number | null; drr: number | null } }[];
    positions: { category2Id: string; name: string; myPosition: number | null; myPositionDyn: number | null; sellers: number | null;
      competitor: string | null; percentDiff: number | null; series: { date: string; my: number | null; competitor: number | null; best: number | null }[] }[];
  };
  errors: string[];
};

// ─── Автопилот, этап 2 «советник» (14.10.2026) ──────────────────────────────

/** off — выключен; confirm — готовит предложения, применяет менеджер. Режим «сам» — этап 3. */
export type Ads2AutopilotMode = 'off' | 'confirm';

/** task — задача команде (карточка/цена), new_campaign — кандидат на кампанию: без команды площадке. */
export type Ads2ProposalKind = 'bid' | 'pause' | 'daily_limit' | 'weekly_budget' | 'task' | 'new_campaign';

export type Ads2EffectSide = { spend: number; orders: number; drr: number | null; perDay: number } | null;

export type Ads2Proposal = {
  id: number; createdAt: number; mp: Ads2Mp;
  campaignId: string | null; campaignName: string | null;
  sku: string | null; productName: string | null; article: string | null; photo: string | null;
  kind: Ads2ProposalKind; placement: 'search' | 'recommendations' | 'combined' | null;
  /** Рубли: ставка, лимит или бюджет до и после. */
  fromValue: number | null; toValue: number | null;
  rule: string; level: 'critical' | 'warn' | 'growth' | 'info';
  title: string; reason: string; fp: string;
  status: 'pending' | 'applied' | 'rejected' | 'failed' | 'expired' | 'superseded';
  decidedAt: number | null; decidedBy: string | null; note: string | null;
  result: { message?: string; error?: string } | null;
  /** Замер: 3 дня до решения и до 3 дней после. */
  effect: { days: number; before: Ads2EffectSide; after: Ads2EffectSide } | null;
};

export type Ads2AutopilotState = {
  mode: Ads2AutopilotMode; since: number | null; confirmUntil: number | null;
  lastRun: { at: number; result: string[] } | null;
  counts14d: Record<string, number>;
  expireHours: number;
};
