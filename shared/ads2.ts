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
  /** 22.10.2026 — как в кабинете: цена 1000 показов, клик → корзина, корзина → заказ, клик → заказ (CR), %. */
  cpm: number | null; cartRate: number | null; cartToOrder: number | null; cr: number | null;
  /** WB: заказанные штуки и отмены; у Ozon нет — null. */
  shks: number | null; canceled: number | null;
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
  | 'low_margin' | 'no_ads_opportunity' | 'flagged_but_running' | 'too_early' | 'unprofitable' | 'data_check';

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
  /** Реклама товара за период по всем кампаниям — из статистики кабинета (показы, клики, корзины, заказы). */
  ad: Ads2Stat | null;
  price: number | null; marginPct: number | null; marginRub: number | null;
  /**
   * Экономика рекламы (22.10.2026, разбор менеджера): маржа до рекламы на штуку и
   * допустимая цена рекламного заказа = (маржа до рекламы − плановая прибыль) × выкуп.
   * null — нет себестоимости или цены, считать нечем.
   */
  econ: Ads2Econ | null;
  campaigns: { id: string; name: string; status: string }[];
  flag: { reason: string; note: string | null } | null;
  /** В архиве «Рекламы» (самовыкуп, дубли): скрыт с экранов, автопилот не трогает. */
  archived: boolean;
  issues: Ads2Issue[];
  /** По дням периода. */
  series: { orders: Array<number | null>; spend: Array<number | null> };
};

export type Ads2Econ = {
  /** Маржа на штуку без рекламы, ₽. */
  marginBeforeAds: number;
  /** Плановая прибыль, % от цены (план месяца из «Цены» → «Репрайсер»). */
  planPct: number;
  buyoutPct: number;
  /** Сколько можно отдать рекламе за один заказ, ₽ (≤ 0 — товар без запаса на рекламу). */
  allowedCpo: number;
  /** То же в процентах от цены — допустимый ДРР товара. */
  allowedDrr: number | null;
  /** Прибыль товара за период после всей рекламы: все заказы × выкуп × маржа до рекламы − расход. */
  profit: number;
  how: string;
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
  /** За сколько дней «заказы»: WB сравнение — 30, WB поиск и Ozon рынок — 7. */
  ordersDays: number | null;
  /** Ozon: конверсия из карточки в корзину, %. */
  convPdp: number | null;
  /** Когда снята цена на витрине (мс) и цена сутки / неделю назад — из истории карточек. */
  priceAt: number | null; price1d: number | null; price7d: number | null;
  /** Последний проход агента не нашёл карточку на витрине (для нашего — только при остатке на складе) и с какого времени. */
  hidden: boolean; hiddenSince: number | null;
  /** WB: дата набора «Сравнения карточек», из которого заказы/реклама/акции (набор мог уже закрыться — данные последние известные). */
  compDate?: string | null;
  /** Ozon: за 7 дней продаж нет (в недельном отчёте товара нет, в 28-дневном есть). */
  noSales7?: boolean;
  /** Ozon: те же показатели «Товаров на Ozon» за 28 дней (переключатель периода в «Конкурентах»). */
  oz28?: { orders: number | null; gmv: number | null; convPdp: number | null; drr: number | null; ctr?: number | null; inAds: boolean | null; inPromo: boolean | null } | null;
};

/** Обновление данных конкурентов: последний проход агента и следующий по расписанию. */
export type Ads2CompRefresh = {
  /** Последний полный ночной проход (аналитика кабинета) и последний замер витрины. */
  fullAt: number | null; cardsAt: number | null;
  /** Последнее задание «Конкуренты» по площадке. */
  task: { id: number; status: string; light: boolean; createdAt: number; finishedAt: number | null; message: string | null; progress?: string | null } | null;
  /** Ближайшие запуски по расписанию (мс). */
  nextRuns: number[];
  /** Последний проход по витрине: когда сняты цены, сколько карточек и у скольких есть цена. */
  pass: { at: number; light: boolean; cards: number; priced: number; errors: number } | null;
  /** Расписание по МСК: «05:40» (полный ночной), «11:20», «14:50», «16:50» (быстрые, перед выпусками советника). */
  slots: { time: string; light: boolean }[];
  /** Плановое обновление наступило больше 40 минут назад, а цен после него нет — время этого слота. */
  missedAt: number | null;
};

/** Наш товар (ключ — наш артикул продавца) и его конкуренты. */
export type Ads2WatchProduct = { key: string; ourId: string; name: string; photo: string; our: Ads2WatchLink | null; links: Ads2WatchLink[] };

/** «Сравнение карточек» WB раз в неделю (26.10.2026): лимиты и последний запуск. */
export type Ads2WbCompare = {
  maxWeek: number; weekUsed: number;
  /** Сколько сравнений осталось в лимите кабинета (последний ночной проход); null — неизвестно. */
  limitLeft: number | null;
  /** Наборы, которые можно открыть заново без списания (72 часа с прошлого сравнения тех же карточек). */
  freeSets: number[][];
  running: boolean;
  /** Запланированный пятничный запуск (агент ещё не взял): когда и какие товары. */
  planned?: { runId: number; at: number; keys: string[] } | null;
  /** Товары, отмеченные «В сравнение» (на сервере, общие для всех). */
  picks?: string[];
  /** Слот «пятница 08:30» этой недели; null — уже прошёл. */
  fridayAt?: number | null;
  lastRun: { id: number; at: number; status: string; total: number; created: number | null; message: string | null; doneAt: number | null } | null;
  telegram: boolean;
};

/**
 * Отчёт «Сравнение карточек» → «Показатели» (27.10.2026): значения кабинета WB как есть, без пересчётов.
 * null — WB этот показатель не отдал (на экране «Нет данных»).
 */
export type Ads2WbRepRow = {
  created: string | null; brand: string | null; cardRating: number | null; fbRating: number | null; fbCount: number | null;
  minPrice: number | null; delivery: { days?: number; hours?: number; mins?: number } | null; avgPos: number | null;
  /** Статус продвижения: в рекламе, названия акций ([] — без акций), подменный артикул. */
  ads: boolean | null; promo: string[] | null; subst: boolean;
  views: number | null; open: number | null; ctr: number | null; cart: number | null; toCart: number | null;
  orders: number | null; toOrder: number | null; buyouts: number | null; buyoutPct: number | null; cancels: number | null;
};
export type Ads2WbReport = {
  setId: string; date: string;
  /** Период отчёта (с 29.10.2026 — целые дни до дня создания набора); null у старых наборов. */
  per7?: { start: string; end: string } | null; per30?: { start: string; end: string } | null;
  /** Карточки набора, каждая отдельной строкой; d7/d30 — null, если за этот период отчёт не снят. */
  nms: { nm: string; name: string; photo: string; ours: boolean; d7: Ads2WbRepRow | null; d30: Ads2WbRepRow | null }[];
};

export type Ads2Competitors = {
  ok: true; mp: Ads2Mp; at: number | null;
  /** Нет снимка — задание ещё не отработало. */
  empty: boolean;
  refresh: Ads2CompRefresh;
  /** Привязки конкурентов к товарам: правят менеджеры (добавить по ссылке/артикулу, подтвердить, «не тот»). */
  watch: Ads2WatchProduct[];
  /** Наши товары для выбора при добавлении: артикул и название. */
  catalog: { key: string; name: string }[];
  wbCompare?: Ads2WbCompare;
  /** Последний отчёт сравнения по каждому нашему товару WB: наш nmId → набор. */
  wbReports?: Record<string, Ads2WbReport>;
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

// ─── Советник по продажам дня (15.10.2026) ──────────────────────────────────
// Почему в конкретный день просели (или выросли) заказы: день против среднего
// за 7 дней до него, по товарам, с причинами из РНП, рекламы, остатков, позиций
// и цен конкурентов. Правила — api/_lib/ads/advisor.ts.

export type Ads2AdvisorCause = {
  code: string; level: 'critical' | 'warn' | 'info' | 'good';
  /** Что видно в данных — с цифрами. */
  text: string;
  /** Что сделать. */
  action?: string;
};

export type Ads2AdvisorProduct = {
  key: string; adSku: string | null; article: string; name: string; photo: string; link: string | null;
  orders: number; ordersBase: number; revenue: number; revenueBase: number;
  /** Разница выручки день − среднее, ₽ (вклад товара в просадку/рост). */
  delta: number;
  causes: Ads2AdvisorCause[];
  /** Главная причина (код), по ней товар попадает в «главные причины дня». */
  primary: string;
};

export type Ads2AdvisorTotals = {
  orders: number; revenue: number; spend: number; drr: number | null; views: number | null; cartConv: number | null;
};

export type Ads2Advisor = {
  ok: true; mp: Ads2Mp;
  /** Разбираемый день и база сравнения (7 дней до него). */
  date: string; baseFrom: string; baseTo: string;
  /** Дни, которые можно выбрать (полные, последние 14). */
  dates: string[];
  day: Ads2AdvisorTotals; base: Ads2AdvisorTotals; weekAgo: { orders: number; revenue: number } | null;
  /** Короткий вывод: 2–5 фраз. */
  summary: string[];
  /** Главные причины дня: сколько выручки «съела» каждая (по главной причине товаров). */
  drivers: { code: string; label: string; delta: number; products: number; action: string }[];
  down: Ads2AdvisorProduct[];
  up: Ads2AdvisorProduct[];
  notes: string[];
};

// ─── Сигналы и выпуски советника (этап А, 15.10.2026) ───────────────────────
// Один сигнальный слой для всех экранов: товар × код × уровень, «что случилось ·
// сколько ₽ · что сделать · кому». Живёт, пока условие держится; менеджер отмечает
// «сделано» или откладывает. Правила — api/_lib/ads/signals.ts.

/** Кому адресован сигнал: реклама, цены, контент карточки, остатки и поставки, сама карточка (скрыта/заблокирована). */
export type Ads2SignalRole = 'ads' | 'price' | 'content' | 'supply' | 'card';

export const SIGNAL_ROLE_LABEL: Record<Ads2SignalRole, string> = {
  card: 'Карточки', supply: 'Остатки и поставки', ads: 'Реклама', price: 'Цены', content: 'Контент карточки',
};

export type Ads2Signal = {
  id: number; mp: Ads2Mp;
  /** Ключ РНП товара (WB — nmId, Ozon — артикул) или `camp:<id>` для сигнала по кампании. */
  sku: string; adSku: string | null;
  article: string; name: string; photo: string; link: string | null;
  code: string; level: 'critical' | 'warn' | 'info'; role: Ads2SignalRole;
  title: string; text: string; action: string;
  /** Сколько денег на кону (расход впустую, недополученная выручка), ₽. */
  rub: number | null;
  /** С какого момента условие держится и сколько это дней подряд. */
  since: number; lastSeen: number; days: number;
  status: 'open' | 'done' | 'snoozed' | 'gone';
  statusAt: number | null; statusBy: string | null; snoozedUntil: number | null; note: string | null;
};

/** Темп дня: заказы, выручка и расход к моменту выпуска против того же часа в прошлые дни. */
export type Ads2Pace = {
  at: number; orders: number; revenue: number; spend: number; drr: number | null;
  /** Среднее к этому же выпуску за прошлые дни (копится по выпускам; null — базы ещё нет). */
  base: { orders: number; revenue: number; spend: number; days: number } | null;
  /** Средний полный день за 7 дней — ориентир, пока база по часам копится. */
  fullDay: { orders: number; revenue: number; spend: number } | null;
  note: string | null;
};

export type Ads2IssueSlot = 'morning' | 'noon' | 'day' | 'evening' | 'manual';

export type Ads2AdvisorIssue = {
  id: number; mp: Ads2Mp; slot: Ads2IssueSlot; date: string; at: number;
  pace: Ads2Pace | null;
  /** Разбор вчерашнего дня (как раньше в «Советнике по продажам»). */
  yesterday: { date: string; baseFrom: string; baseTo: string; summary: string[]; drivers: Ads2Advisor['drivers'];
    day: Ads2AdvisorTotals; base: Ads2AdvisorTotals; weekAgo: { orders: number; revenue: number } | null;
    down: Ads2AdvisorProduct[]; up: Ads2AdvisorProduct[] } | null;
  /** Снимок сигналов на момент выпуска (статусы — свежие, из таблицы). */
  signals: Ads2Signal[];
  /**
   * Маржа месяца по площадке (этап Б, план владельца 15.10): средневзвешенная по заказам с начала
   * месяца при текущей марже товаров; план, край (план + запас) и цель; доля выручки, по которой маржа известна.
   */
  monthMargin: { month: string; pct: number | null; plan: number; floor: number; target: number; revenue: number; covered: number } | null;
  /** Когда обновлялись источники (мс): РНП, реклама, витрина конкурентов. */
  dataAt: { rnp: number | null; ads: number | null; comp: number | null };
  notes: string[];
};

export type Ads2SignalsResponse = {
  ok: true; mp: Ads2Mp; date: string;
  /** Дни, за которые есть выпуски или можно собрать (последние 14). */
  dates: string[];
  /** Расписание выпусков по МСК. */
  slots: { slot: Ads2IssueSlot; time: string; label: string }[];
  /** Выпуски выбранного дня. */
  issues: { id: number; slot: Ads2IssueSlot; at: number }[];
  issue: Ads2AdvisorIssue | null;
  /** Сделано сегодня (для свёрнутого блока). */
  doneToday: Ads2Signal[];
  building: boolean;
};

// ─── Автопилот, этап 2 «советник» (14.10.2026) ──────────────────────────────

/** off — выключен; confirm — готовит предложения, применяет менеджер. Режим «сам» — этап 3. */
export type Ads2AutopilotMode = 'off' | 'confirm';

/** task — задача команде (карточка/цена), new_campaign — кандидат на кампанию: без команды площадке. */
export type Ads2ProposalKind = 'bid' | 'pause' | 'daily_limit' | 'weekly_budget' | 'task' | 'new_campaign';

export type Ads2EffectSide = { spend: number; orders: number; drr: number | null; perDay: number; ordersPerDay: number } | null;

/**
 * Обязательные поля рекомендации (22.10.2026, разбор менеджера): что проверено,
 * чего не хватает, уверенность, альтернатива, риск, срок замера и условие отката.
 */
export type Ads2ProposalDetails = {
  confidence: 'high' | 'medium' | 'low';
  checks: string[]; missing: string[];
  alternative: string | null; risk: string | null;
  controlDays: number; rollback: string | null;
};

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
  details: Ads2ProposalDetails | null;
  /** Замер: 3 дня до решения и до 3 дней после; вывод — стало лучше, хуже (откатить) или без разницы. */
  effect: { days: number; before: Ads2EffectSide; after: Ads2EffectSide; verdict: 'better' | 'worse' | 'neutral' | null; verdictText: string | null } | null;
};

export type Ads2AutopilotState = {
  mode: Ads2AutopilotMode; since: number | null; confirmUntil: number | null;
  lastRun: { at: number; result: string[] } | null;
  counts14d: Record<string, number>;
  expireHours: number;
};
