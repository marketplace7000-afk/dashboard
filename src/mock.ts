// Все данные ниже — мок для демонстрации UI/UX.
// На проде заменяется выдачей backend (FastAPI) + WB API + LLM.

export type SkuRow = {
  id: string;
  article: string;
  name: string;
  myPrice: number;
  competitorMin: number;
  competitorAvg: number;
  cost: number;
  stock: number;
  status: 'ok' | 'lock' | 'edge';
  lastChange: string;
};

export const skus: SkuRow[] = [
  { id: '1',  article: '218430551', name: 'CarPlay-адаптер беспроводной 7"',         myPrice: 5990, competitorMin: 5790, competitorAvg: 6450, cost: 3400, stock: 84,  status: 'ok',   lastChange: '12 мин назад' },
  { id: '2',  article: '218430552', name: 'Магнитный держатель MagSafe в дефлектор', myPrice: 1290, competitorMin: 1199, competitorAvg: 1380, cost: 540,  stock: 312, status: 'ok',   lastChange: '1 ч назад' },
  { id: '3',  article: '218430553', name: 'Видеорегистратор 4K с GPS',                myPrice: 7490, competitorMin: 6990, competitorAvg: 7820, cost: 4200, stock: 28,  status: 'edge', lastChange: '3 ч назад' },
  { id: '4',  article: '218430554', name: 'Зарядка USB-C PD 65W в прикуриватель',     myPrice: 990,  competitorMin: 949,  competitorAvg: 1080, cost: 380,  stock: 196, status: 'ok',   lastChange: '8 мин назад' },
  { id: '5',  article: '218430555', name: 'Android-магнитола 9" 2K CarPlay',          myPrice: 12490,competitorMin: 11990,competitorAvg: 13200,cost: 7800, stock: 12,  status: 'lock', lastChange: 'Заблокировано: < себестоимости' },
  { id: '6',  article: '218430556', name: 'Камера заднего вида HD ночной режим',      myPrice: 1890, competitorMin: 1790, competitorAvg: 1990, cost: 920,  stock: 64,  status: 'ok',   lastChange: '24 мин назад' },
  { id: '7',  article: '218430557', name: 'FM-трансмиттер Bluetooth 5.3',             myPrice: 690,  competitorMin: 649,  competitorAvg: 740,  cost: 280,  stock: 280, status: 'ok',   lastChange: '46 мин назад' },
  { id: '8',  article: '218430558', name: 'Органайзер в багажник складной',           myPrice: 1290, competitorMin: 1219, competitorAvg: 1390, cost: 560,  stock: 102, status: 'ok',   lastChange: '2 ч назад' },
  { id: '9',  article: '218430559', name: 'Антирадар-комбо с GPS-базой',              myPrice: 8490, competitorMin: 8190, competitorAvg: 8720, cost: 5100, stock: 18,  status: 'edge', lastChange: '15 мин назад' },
  { id: '10', article: '218430560', name: 'Чехол на руль из натуральной кожи',        myPrice: 990,  competitorMin: 949,  competitorAvg: 1090, cost: 420,  stock: 156, status: 'ok',   lastChange: '5 мин назад' },
];

export type PriceLog = {
  ts: string;
  article: string;
  from: number;
  to: number;
  reason: string;
  result: 'success' | 'pending' | 'failed';
};

export const priceLogs: PriceLog[] = [
  { ts: '07.05 14:02', article: '218430551', from: 6190, to: 5990, reason: 'Конкурент снизил цену до 5790₽',     result: 'success' },
  { ts: '07.05 13:48', article: '218430554', from: 1020, to: 990,  reason: 'Удержание коридора ±3%',              result: 'success' },
  { ts: '07.05 13:30', article: '218430560', from: 950,  to: 990,  reason: 'Возврат к коридору после акции',      result: 'success' },
  { ts: '07.05 12:55', article: '218430555', from: 12490,to: 12490,reason: 'Блок: новая цена < себестоимости',    result: 'failed' },
  { ts: '07.05 12:10', article: '218430553', from: 7790, to: 7490, reason: 'Конкурент Min 6990₽',                 result: 'success' },
  { ts: '07.05 11:02', article: '218430557', from: 720,  to: 690,  reason: 'Конкурент Min 649₽',                  result: 'success' },
  { ts: '07.05 10:18', article: '218430558', from: 1320, to: 1290, reason: 'Удержание коридора ±3%',              result: 'success' },
  { ts: '07.05 09:40', article: '218430552', from: 1320, to: 1290, reason: 'Конкурент Min 1199₽',                 result: 'success' },
  { ts: '07.05 09:02', article: '218430556', from: 1990, to: 1890, reason: 'Удержание коридора ±3%',              result: 'success' },
];

export type Review = {
  id: string;
  article: string;
  productName: string;
  author: string;
  rating: number;
  text: string;
  createdAt: string;
  draft: string;
  tone: 'pos' | 'neu' | 'neg';
  status: 'pending' | 'approved' | 'rejected';
};

export const reviews: Review[] = [
  {
    id: 'r1',
    article: '218430551',
    productName: 'CarPlay-адаптер беспроводной 7"',
    author: 'Анна К.',
    rating: 5,
    text: 'Огонь адаптер! Подключился к штатной магнитоле за минуту, iPhone цепляется автоматически. Качество звука и картинки супер.',
    createdAt: '07.05 13:20',
    tone: 'pos',
    status: 'pending',
    draft: 'Анна, спасибо за такой тёплый отзыв! Рады, что подключение прошло легко — мы специально оптимизировали прошивку под автоматический коннект iPhone. Если появятся вопросы по обновлению ПО или настройкам, напишите — поможем. Хорошей дороги!',
  },
  {
    id: 'r2',
    article: '218430555',
    productName: 'Android-магнитола 9" 2K CarPlay',
    author: 'Сергей В.',
    rating: 2,
    text: 'Пришла с битым тачем в углу, плюс CarPlay отваливается каждые 10 минут, приходится переподключать. За такие деньги — обидно.',
    createdAt: '07.05 12:48',
    tone: 'neg',
    status: 'pending',
    draft: 'Сергей, очень жаль, что столкнулись с этим — битый тач это явно брак при доставке, оформим замену по гарантии без возврата товара (отправим новый, старый заберёт курьер). По обрывам CarPlay: пришлите, пожалуйста, в чат WB версию прошивки (Настройки → О системе) — у нас как раз вышло обновление 2.4.1, которое лечит эту проблему. Извините за неудобства, сделаем всё, чтобы исправить впечатление.',
  },
  {
    id: 'r3',
    article: '218430554',
    productName: 'Зарядка USB-C PD 65W в прикуриватель',
    author: 'Дмитрий П.',
    rating: 4,
    text: 'Зарядка работает быстро, MacBook от неё реально питается в дороге. Минус — короткий кабель в комплекте, пришлось докупить свой.',
    createdAt: '07.05 11:10',
    tone: 'neu',
    status: 'pending',
    draft: 'Дмитрий, спасибо за честный отзыв! По кабелю учли — в следующей партии (с июня) кладём кабель 1.5 м вместо 0.8. Если хотите, можем выслать длинный отдельно бесплатно — напишите в чат WB номер заказа.',
  },
  {
    id: 'r4',
    article: '218430553',
    productName: 'Видеорегистратор 4K с GPS',
    author: 'Елена М.',
    rating: 5,
    text: 'Качество съёмки на ночной трассе огонь, номера читаются. GPS-метки на видео — удобно для страховой. Установила сама за 15 минут.',
    createdAt: '07.05 10:30',
    tone: 'pos',
    status: 'pending',
    draft: 'Елена, спасибо! Над ночной матрицей реально много работали — приятно, что разница заметна. Удачи на дорогах, и пусть видеозаписи пригождаются только для красивых пейзажей, а не для разбирательств.',
  },
  {
    id: 'r5',
    article: '218430552',
    productName: 'Магнитный держатель MagSafe в дефлектор',
    author: 'Ольга Т.',
    rating: 3,
    text: 'Держит нормально, но крепление к дефлектору слабоватое — на кочках телефон вместе с держателем подпрыгивает. Магнит сам — ок.',
    createdAt: '07.05 09:14',
    tone: 'neg',
    status: 'pending',
    draft: 'Ольга, спасибо за обратную связь — эту проблему знаем, в комплекте есть резиновые подкладки разной толщины (в маленьком пакетике), они плотно фиксируют клипсу под любой профиль дефлектора. Если их не было — напишите в чат WB, отправим бесплатно. На будущих партиях усиливаем металлический язычок клипсы.',
  },
];

export const dailyReport = {
  date: '06 мая 2026',
  revenue: 184320,
  orders: 47,
  avgCheck: 3922,
  returns: 3,
  topSku: [
    { article: '218430551', name: 'CarPlay-адаптер беспроводной 7"',         qty: 14, revenue: 83860 },
    { article: '218430552', name: 'Магнитный держатель MagSafe в дефлектор', qty: 22, revenue: 28380 },
    { article: '218430554', name: 'Зарядка USB-C PD 65W в прикуриватель',     qty: 18, revenue: 17820 },
    { article: '218430553', name: 'Видеорегистратор 4K с GPS',                qty: 4,  revenue: 29960 },
    { article: '218430556', name: 'Камера заднего вида HD ночной режим',      qty: 8,  revenue: 15120 },
  ],
};

export type Competitor = {
  seller: string;
  article: string;
  price: number;
  rating: number;
  reviews: number;
  delivery: string;
};

export const competitorsBySku: Record<string, Competitor[]> = {
  '218430551': [
    { seller: 'AutoSmart Pro',     article: '198223451', price: 5790, rating: 4.7, reviews: 1284, delivery: 'завтра'  },
    { seller: 'CarTech',           article: '201554732', price: 5990, rating: 4.6, reviews: 942,  delivery: '2 дня'   },
    { seller: 'iGadget Auto',      article: '187994120', price: 6190, rating: 4.8, reviews: 2104, delivery: 'завтра'  },
    { seller: 'Drive Plus',        article: '209887541', price: 6490, rating: 4.5, reviews: 388,  delivery: '3 дня'   },
    { seller: 'TopCar Accessory',  article: '215443190', price: 6790, rating: 4.6, reviews: 612,  delivery: '2 дня'   },
  ],
  '218430555': [
    { seller: 'CarTech',           article: '201554798', price: 11990,rating: 4.5, reviews: 421,  delivery: '2 дня'   },
    { seller: 'AutoSmart Pro',     article: '198223999', price: 12490,rating: 4.6, reviews: 318,  delivery: 'завтра'  },
    { seller: 'GearMaster',        article: '210054321', price: 13200,rating: 4.4, reviews: 156,  delivery: '4 дня'   },
    { seller: 'iGadget Auto',      article: '187994455', price: 13490,rating: 4.7, reviews: 540,  delivery: '2 дня'   },
  ],
  '218430553': [
    { seller: 'DriveCam',          article: '212334109', price: 6990, rating: 4.4, reviews: 278,  delivery: '3 дня'   },
    { seller: 'AutoSmart Pro',     article: '198223881', price: 7290, rating: 4.7, reviews: 615,  delivery: 'завтра'  },
    { seller: 'CarTech',           article: '201554120', price: 7790, rating: 4.5, reviews: 432,  delivery: '2 дня'   },
    { seller: 'TopCar Accessory',  article: '215443009', price: 8190, rating: 4.6, reviews: 290,  delivery: '2 дня'   },
  ],
  '218430552': [
    { seller: 'iGadget Auto',      article: '187994001', price: 1199, rating: 4.7, reviews: 3201, delivery: 'завтра'  },
    { seller: 'MagSafe Store',     article: '220011432', price: 1290, rating: 4.6, reviews: 1845, delivery: 'завтра'  },
    { seller: 'AutoSmart Pro',     article: '198223112', price: 1390, rating: 4.5, reviews: 720,  delivery: 'завтра'  },
    { seller: 'CarTech',           article: '201554990', price: 1490, rating: 4.4, reviews: 412,  delivery: '2 дня'   },
  ],
};

export type ThrottleEvent = {
  ts: string;
  article: string;
  reason: 'throttle' | 'cost' | 'invalid';
  proposed: number;
  current: number;
  detail: string;
};

export const throttleLog: ThrottleEvent[] = [
  { ts: '07.05 14:18', article: '218430551', reason: 'throttle', proposed: 5890, current: 5990, detail: 'Изменение запрещено: предыдущее было 16 минут назад (правило: ≥ 60 мин)' },
  { ts: '07.05 13:42', article: '218430555', reason: 'cost',     proposed: 7600, current: 12490,detail: 'Новая цена ниже себестоимости 7800 ₽ + минимальная маржа 20%' },
  { ts: '07.05 12:15', article: '218430553', reason: 'throttle', proposed: 7290, current: 7490, detail: 'Изменение запрещено: предыдущее 32 минуты назад' },
  { ts: '07.05 11:48', article: '218430559', reason: 'cost',     proposed: 6100, current: 8490, detail: 'Новая цена ниже себестоимости 5100 ₽ + минимальная маржа 20%' },
  { ts: '07.05 10:22', article: '218430554', reason: 'invalid',  proposed: 0,    current: 990,  detail: 'Невалидный ответ парсера конкурентов (timeout), пропуск цикла' },
  { ts: '07.05 08:54', article: '218430552', reason: 'throttle', proposed: 1240, current: 1290, detail: 'Изменение запрещено: предыдущее 41 минуту назад' },
];

export const systemHealth = {
  workers:    { up: 3, total: 3 },
  sentry:     { errors24h: 0, lastError: null as string | null },
  uptime:     { pct: 99.94, since: '14 дней' },
  llm: {
    spentToday:  47.20,
    budgetToday: 500,
    cacheHitPct: 71,
    avgLatencyMs: 1320,
  },
  wbApi: {
    lastPing: '12 сек назад',
    rateUsedPct: 34,
    backoffActive: false,
  },
  timeSaved: { hoursThisWeek: 6.4, target: 5 },
};

export type MarketShare = { seller: string; pct: number; trend: number };
export const marketShare: MarketShare[] = [
  { seller: 'AutoSmart Pro',    pct: 22.4, trend: -1.2 },
  { seller: 'iGadget Auto',     pct: 18.1, trend: +0.6 },
  { seller: 'CarTech',          pct: 14.7, trend: -0.3 },
  { seller: 'ИП Алешко (вы)',   pct: 11.2, trend: +1.8 },
  { seller: 'TopCar Accessory', pct:  9.4, trend: +0.2 },
  { seller: 'Drive Plus',       pct:  6.8, trend: -0.5 },
  { seller: 'Прочие (24)',      pct: 17.4, trend: -0.6 },
];

export type SearchPosition = { query: string; me: number; topCompetitor: { seller: string; pos: number }; volume: number };
export const searchPositions: SearchPosition[] = [
  { query: 'carplay адаптер беспроводной',   me: 3,  topCompetitor: { seller: 'AutoSmart Pro', pos: 1 },  volume: 18400 },
  { query: 'магнитола 2din carplay 9 дюймов', me: 7,  topCompetitor: { seller: 'CarTech', pos: 2 },        volume: 12100 },
  { query: 'видеорегистратор 4k с gps',       me: 12, topCompetitor: { seller: 'DriveCam', pos: 1 },       volume: 24600 },
  { query: 'держатель magsafe в дефлектор',   me: 2,  topCompetitor: { seller: 'iGadget Auto', pos: 1 },   volume: 31200 },
  { query: 'зарядка в прикуриватель usb-c',   me: 5,  topCompetitor: { seller: 'AutoSmart Pro', pos: 1 },  volume: 28900 },
  { query: 'fm трансмиттер bluetooth',        me: 4,  topCompetitor: { seller: 'AutoSmart Pro', pos: 1 },  volume: 15800 },
  { query: 'антирадар комбо с gps',           me: 9,  topCompetitor: { seller: 'TopCar Accessory', pos: 3 }, volume: 8400 },
  { query: 'органайзер в багажник',           me: 6,  topCompetitor: { seller: 'Drive Plus', pos: 2 },     volume: 11200 },
];

export type CompetitorActivity = { ts: string; seller: string; type: 'price_drop' | 'price_up' | 'new_sku' | 'promo' | 'review_spike'; text: string; impact: 'high' | 'mid' | 'low' };
export const competitorActivity: CompetitorActivity[] = [
  { ts: '07.05 13:50', seller: 'AutoSmart Pro',    type: 'price_drop',   text: 'Снизил цену на CarPlay-адаптер 7" на 6.2% (6190 → 5790 ₽)',                  impact: 'high' },
  { ts: '07.05 12:30', seller: 'iGadget Auto',     type: 'new_sku',      text: 'Добавил новый SKU: «Магнитный держатель MagSafe 15W с подсветкой»',         impact: 'mid'  },
  { ts: '07.05 11:18', seller: 'CarTech',          type: 'promo',        text: 'Запустил акцию −15% на Android-магнитолы 9" до 12 мая',                      impact: 'high' },
  { ts: '07.05 10:42', seller: 'DriveCam',         type: 'review_spike', text: 'Резкий рост отзывов на видеорегистратор: +47 за сутки (рейтинг 4.4)',        impact: 'mid'  },
  { ts: '07.05 09:55', seller: 'TopCar Accessory', type: 'price_up',     text: 'Поднял цену на антирадар-комбо на 3.4% (8190 → 8470 ₽)',                     impact: 'low'  },
  { ts: '06.05 18:22', seller: 'GearMaster',       type: 'new_sku',      text: 'Добавил Android-магнитолу 10" 4K с QLED-экраном',                            impact: 'mid'  },
  { ts: '06.05 14:08', seller: 'AutoSmart Pro',    type: 'promo',        text: 'Бандл: CarPlay-адаптер + держатель = −500 ₽',                                 impact: 'high' },
  { ts: '06.05 11:00', seller: 'iGadget Auto',     type: 'price_drop',   text: 'Снизил цену на держатель MagSafe на 4% (1249 → 1199 ₽)',                     impact: 'mid'  },
];

export type PriceMapPoint = { name: string; price: number; rating: number; reviews: number; mine?: boolean };
export const priceMap: PriceMapPoint[] = [
  { name: 'CarPlay-адаптер 7" (моя)',     price: 5990,  rating: 4.7, reviews: 612,  mine: true },
  { name: 'CarPlay AutoSmart',            price: 5790,  rating: 4.7, reviews: 1284 },
  { name: 'CarPlay CarTech',              price: 5990,  rating: 4.6, reviews: 942 },
  { name: 'CarPlay iGadget',              price: 6190,  rating: 4.8, reviews: 2104 },
  { name: 'Держатель MagSafe (моя)',      price: 1290,  rating: 4.6, reviews: 445,  mine: true },
  { name: 'Держатель iGadget',            price: 1199,  rating: 4.7, reviews: 3201 },
  { name: 'Видеорегистратор (моя)',       price: 7490,  rating: 4.5, reviews: 188,  mine: true },
  { name: 'Регистратор DriveCam',         price: 6990,  rating: 4.4, reviews: 278 },
  { name: 'Регистратор AutoSmart',        price: 7290,  rating: 4.7, reviews: 615 },
  { name: 'Регистратор TopCar',           price: 8190,  rating: 4.6, reviews: 290 },
  { name: 'Магнитола 9" (моя)',           price: 12490, rating: 4.6, reviews: 84,   mine: true },
  { name: 'Магнитола CarTech',            price: 11990, rating: 4.5, reviews: 421 },
  { name: 'Магнитола GearMaster',         price: 13200, rating: 4.4, reviews: 156 },
  { name: 'Магнитола iGadget',            price: 13490, rating: 4.7, reviews: 540 },
];

export type TopCompetitor = {
  seller: string;
  skuCount: number;
  monthlyRevenue: number;
  avgRating: number;
  avgDelivery: string;
  pricePolicy: 'aggressive' | 'premium' | 'balanced';
  threat: 'high' | 'mid' | 'low';
};

export const topCompetitors: TopCompetitor[] = [
  { seller: 'AutoSmart Pro',    skuCount: 142, monthlyRevenue: 8400000, avgRating: 4.6, avgDelivery: '1.2 дня', pricePolicy: 'aggressive', threat: 'high' },
  { seller: 'iGadget Auto',     skuCount:  88, monthlyRevenue: 6700000, avgRating: 4.7, avgDelivery: '1.4 дня', pricePolicy: 'premium',    threat: 'high' },
  { seller: 'CarTech',          skuCount: 210, monthlyRevenue: 5200000, avgRating: 4.5, avgDelivery: '2.1 дня', pricePolicy: 'aggressive', threat: 'high' },
  { seller: 'TopCar Accessory', skuCount:  64, monthlyRevenue: 3100000, avgRating: 4.6, avgDelivery: '1.8 дня', pricePolicy: 'balanced',   threat: 'mid'  },
  { seller: 'Drive Plus',       skuCount:  47, monthlyRevenue: 2400000, avgRating: 4.4, avgDelivery: '2.4 дня', pricePolicy: 'balanced',   threat: 'mid'  },
];

export const skuCompare = [
  { article: '218430551', name: 'CarPlay-адаптер беспроводной 7"',         my: 5990,  avg: 6115, min: 5790, deviation: -2.0, rec: 'OK · вы у Min+3.5%',          status: 'good' as const },
  { article: '218430555', name: 'Android-магнитола 9" 2K CarPlay',          my: 12490, avg: 12793, min: 11990, deviation: -2.4, rec: 'CarTech запустил −15%, риск',  status: 'warn' as const },
  { article: '218430553', name: 'Видеорегистратор 4K с GPS',                my: 7490,  avg: 7415, min: 6990, deviation: +1.0, rec: 'Снизить до 7290',              status: 'warn' as const },
  { article: '218430552', name: 'Магнитный держатель MagSafe в дефлектор',  my: 1290,  avg: 1345, min: 1199, deviation: -4.1, rec: 'OK · вы у Min+7.6%',           status: 'good' as const },
  { article: '218430554', name: 'Зарядка USB-C PD 65W в прикуриватель',     my: 990,   avg: 1014, min: 949,  deviation: -2.4, rec: 'OK',                            status: 'good' as const },
  { article: '218430556', name: 'Камера заднего вида HD ночной режим',      my: 1890,  avg: 1890, min: 1790, deviation:  0.0, rec: 'На уровне рынка',              status: 'good' as const },
  { article: '218430559', name: 'Антирадар-комбо с GPS-базой',              my: 8490,  avg: 8455, min: 8190, deviation: +0.4, rec: 'TopCar поднял до 8470 — держим', status: 'good' as const },
  { article: '218430557', name: 'FM-трансмиттер Bluetooth 5.3',             my: 690,   avg: 694, min: 649,  deviation: -0.6, rec: 'OK',                            status: 'good' as const },
];

export type Marketplace = 'wb' | 'ozon';
export type MarketplaceMeta = {
  id: Marketplace;
  label: string;
  shortLabel: string;
  color: string;
  status: 'connected' | 'pending' | 'off';
  apiStatus: string;
  skuCount: number;
};

export const marketplaces: MarketplaceMeta[] = [
  { id: 'wb',   label: 'Wildberries', shortLabel: 'WB',   color: '#cb11ab', status: 'connected', apiStatus: 'Suppliers + Statistics + Feedbacks API', skuCount: 142 },
  { id: 'ozon', label: 'Ozon',        shortLabel: 'Ozon', color: '#005bff', status: 'connected', apiStatus: 'Seller API · Performance API',           skuCount:  96 },
];

export type MarketplaceMetrics = {
  revenue: number;
  orders: number;
  avgCheck: number;
  returns: number;
  weeklySpark: number[];
  weeklyRevenue: { current: number; prev: number };
  weeklyOrders:  { current: number; prev: number };
  weeklyAvg:     { current: number; prev: number };
  weeklyReturns: { current: number; prev: number };
  topSku: { article: string; name: string; qty: number; revenue: number }[];
  priceChangesToday: number;
  pendingReviews: number;
  negativeReviews: number;
};

export const marketplaceData: Record<Marketplace, MarketplaceMetrics> = {
  wb: {
    revenue: 184320, orders: 47, avgCheck: 3922, returns: 3,
    weeklySpark: [142000, 168000, 175000, 154000, 198000, 163000, 184320],
    weeklyRevenue: { current: 1184320, prev: 1052100 },
    weeklyOrders:  { current: 312,     prev: 287 },
    weeklyAvg:     { current: 3796,    prev: 3666 },
    weeklyReturns: { current: 18,      prev: 22 },
    topSku: [
      { article: '218430551', name: 'CarPlay-адаптер беспроводной 7"',         qty: 14, revenue: 83860 },
      { article: '218430552', name: 'Магнитный держатель MagSafe в дефлектор', qty: 22, revenue: 28380 },
      { article: '218430554', name: 'Зарядка USB-C PD 65W в прикуриватель',     qty: 18, revenue: 17820 },
      { article: '218430553', name: 'Видеорегистратор 4K с GPS',                qty:  4, revenue: 29960 },
      { article: '218430556', name: 'Камера заднего вида HD ночной режим',      qty:  8, revenue: 15120 },
    ],
    priceChangesToday: 9,
    pendingReviews: 5,
    negativeReviews: 2,
  },
  ozon: {
    revenue: 142680, orders: 38, avgCheck: 3754, returns: 2,
    weeklySpark: [98000, 124000, 138000, 117000, 156000, 132000, 142680],
    weeklyRevenue: { current: 907420, prev: 781200 },
    weeklyOrders:  { current: 246,    prev: 218 },
    weeklyAvg:     { current: 3688,   prev: 3583 },
    weeklyReturns: { current: 12,     prev: 14 },
    topSku: [
      { article: '1602334551', name: 'CarPlay-адаптер беспроводной 7"',         qty: 11, revenue: 66990 },
      { article: '1602334555', name: 'Android-магнитола 9" 2K CarPlay',          qty:  3, revenue: 38970 },
      { article: '1602334552', name: 'Магнитный держатель MagSafe в дефлектор', qty: 18, revenue: 23220 },
      { article: '1602334554', name: 'Зарядка USB-C PD 65W в прикуриватель',     qty: 14, revenue: 13860 },
      { article: '1602334557', name: 'FM-трансмиттер Bluetooth 5.3',             qty: 17, revenue: 11730 },
    ],
    priceChangesToday: 6,
    pendingReviews: 3,
    negativeReviews: 1,
  },
};

export type AgentProvider = 'claude' | 'openai' | 'gemini' | 'mistral' | 'deepseek' | 'yandex' | 'grok' | 'perplexity';
export type AgentModel = {
  id: string;
  provider: AgentProvider;
  name: string;
  pricePer1kIn: number;
  pricePer1kOut: number;
};

export const availableModels: AgentModel[] = [
  { id: 'claude-opus-4-7',     provider: 'claude',     name: 'Claude Opus 4.7',      pricePer1kIn: 15,  pricePer1kOut: 75 },
  { id: 'claude-sonnet-4-6',   provider: 'claude',     name: 'Claude Sonnet 4.6',    pricePer1kIn: 3,   pricePer1kOut: 15 },
  { id: 'claude-haiku-4-5',    provider: 'claude',     name: 'Claude Haiku 4.5',     pricePer1kIn: 0.8, pricePer1kOut: 4 },
  { id: 'gpt-4o',              provider: 'openai',     name: 'GPT-4o',               pricePer1kIn: 2.5, pricePer1kOut: 10 },
  { id: 'gpt-4o-mini',         provider: 'openai',     name: 'GPT-4o mini',          pricePer1kIn: 0.15,pricePer1kOut: 0.6 },
  { id: 'o3',                  provider: 'openai',     name: 'OpenAI o3',            pricePer1kIn: 10,  pricePer1kOut: 40 },
  { id: 'gemini-2-pro',        provider: 'gemini',     name: 'Gemini 2.0 Pro',       pricePer1kIn: 1.25,pricePer1kOut: 5 },
  { id: 'gemini-2-flash',      provider: 'gemini',     name: 'Gemini 2.0 Flash',     pricePer1kIn: 0.1, pricePer1kOut: 0.4 },
  { id: 'mistral-large',       provider: 'mistral',    name: 'Mistral Large',        pricePer1kIn: 2,   pricePer1kOut: 6 },
  { id: 'deepseek-v3',         provider: 'deepseek',   name: 'DeepSeek V3',          pricePer1kIn: 0.27,pricePer1kOut: 1.1 },
  { id: 'yandexgpt-5-pro',     provider: 'yandex',     name: 'YandexGPT 5 Pro',      pricePer1kIn: 1.2, pricePer1kOut: 4.8 },
  { id: 'grok-3',              provider: 'grok',       name: 'Grok 3',               pricePer1kIn: 5,   pricePer1kOut: 15 },
];

export type Agent = {
  id: string;
  name: string;
  role: string;
  modelId: string;
  status: 'active' | 'paused' | 'planned';
  apiKeyMasked: string;
  responsibilities: string[];
  metrics: { requestsToday: number; tokensIn: number; tokensOut: number; costToday: number; successRate: number; avgLatencyMs: number };
  reportsTo?: string;
  systemPrompt: string;
};

export const agents: Agent[] = [
  {
    id: 'orchestrator',
    name: 'Главный агент · Диспетчер',
    role: 'Маршрутизирует входящие события WB между специализированными агентами, контролирует SLA и бюджеты',
    modelId: 'claude-opus-4-7',
    status: 'active',
    apiKeyMasked: 'sk-ant-***************qN8x',
    responsibilities: [
      'Приём вебхуков WB и cron-триггеров',
      'Маршрутизация задач по агентам-исполнителям',
      'Контроль дневного бюджета LLM',
      'Эскалация к человеку при критичных ошибках',
    ],
    metrics: { requestsToday: 412, tokensIn: 38400, tokensOut: 12100, costToday: 14.20, successRate: 99.8, avgLatencyMs: 480 },
    systemPrompt: 'Ты — главный диспетчер платформы Avto Vibe. Принимай события и направляй их соответствующему агенту. Не выполняй задачи самостоятельно.',
  },
  {
    id: 'reviews',
    name: 'Агент отзывов',
    role: 'Генерирует ответы на отзывы покупателей по 3 шаблонам тональности',
    modelId: 'claude-sonnet-4-6',
    status: 'active',
    apiKeyMasked: 'sk-ant-***************qN8x',
    responsibilities: [
      'Анализ тональности входящего отзыва',
      'Подбор шаблона ответа (позитив/нейтрал/негатив)',
      'Генерация черновика с подписью продавца',
      'Передача на модерацию перед публикацией',
    ],
    metrics: { requestsToday: 47, tokensIn: 22100, tokensOut: 8200, costToday: 9.80, successRate: 100, avgLatencyMs: 1320 },
    reportsTo: 'orchestrator',
    systemPrompt: 'Ты — менеджер поддержки магазина автотоваров и CarPlay-аксессуаров. Отвечай тёпло, по делу. На негатив — извиняйся, предлагай решение. Подпись — «Команда поддержки ИП Алешко».',
  },
  {
    id: 'pricing',
    name: 'Агент-советник по ценам',
    role: 'Анализирует индексы Ozon и цены конкурентов, готовит рекомендации. Цены не меняет — только предлагает',
    modelId: 'claude-haiku-4-5',
    status: 'active',
    apiKeyMasked: 'sk-ant-***************qN8x',
    responsibilities: [
      'Сбор рыночных индексов и цен конкурентов раз в час',
      'Расчёт рекомендованной цены с учётом коридора и min_price',
      'Подготовка предложений для продавца (без авто-применения)',
      'Логирование рекомендаций и их обоснований',
    ],
    metrics: { requestsToday: 240, tokensIn: 18400, tokensOut: 4200, costToday: 2.10, successRate: 98.7, avgLatencyMs: 620 },
    reportsTo: 'orchestrator',
    systemPrompt: 'Ты — аналитик-советник по ценам. На вход — индексы Ozon, конкуренты, себестоимость, параметры коридора. Возвращай JSON с рекомендованной ценой и обоснованием. Применение делает человек.',
  },
  {
    id: 'competitors',
    name: 'Агент конкурентов',
    role: 'Парсит и классифицирует активность конкурентов: снижения цен, акции, новые SKU',
    modelId: 'gemini-2-pro',
    status: 'active',
    apiKeyMasked: 'AIza************************Lz1k',
    responsibilities: [
      'Парсинг витрин конкурентов раз в час',
      'Классификация событий (price_drop / promo / new_sku)',
      'Оценка уровня угрозы (high / mid / low)',
      'Алерт на high-impact события',
    ],
    metrics: { requestsToday: 168, tokensIn: 31200, tokensOut: 5800, costToday: 4.30, successRate: 99.4, avgLatencyMs: 940 },
    reportsTo: 'orchestrator',
    systemPrompt: 'Ты — конкурентный разведчик. Обрабатывай выдачу WB и определяй значимые изменения у конкурентов. Возвращай structured JSON.',
  },
  {
    id: 'analytics',
    name: 'Агент аналитики',
    role: 'Готовит дневные и недельные отчёты, формирует выжимки и инсайты',
    modelId: 'gpt-4o',
    status: 'active',
    apiKeyMasked: 'sk-proj-************************4kM2',
    responsibilities: [
      'Сбор метрик из WB Statistics API',
      'Сравнение с предыдущим периодом',
      'Генерация естественноязыкового резюме',
      'Подготовка топ-5 SKU и ключевых выводов',
    ],
    metrics: { requestsToday: 14, tokensIn: 9800, tokensOut: 3400, costToday: 0.85, successRate: 100, avgLatencyMs: 2100 },
    reportsTo: 'orchestrator',
    systemPrompt: 'Ты — аналитик-копирайтер. На вход — JSON с метриками магазина. Возвращай краткое и понятное резюме на русском, выделяй главное.',
  },
  {
    id: 'telegram',
    name: 'Агент Telegram',
    role: 'Форматирует исходящие сообщения для бота и интерпретирует команды продавца',
    modelId: 'claude-haiku-4-5',
    status: 'active',
    apiKeyMasked: 'sk-ant-***************qN8x',
    responsibilities: [
      'Форматирование сообщений в стиле Markdown V2',
      'Сборка inline-кнопок одобрения',
      'Интерпретация свободных команд (/sku, /pause, ...)',
      'Доставка дневных и недельных отчётов',
    ],
    metrics: { requestsToday: 84, tokensIn: 12400, tokensOut: 4100, costToday: 0.74, successRate: 100, avgLatencyMs: 410 },
    reportsTo: 'orchestrator',
    systemPrompt: 'Ты — форматировщик для Telegram. Превращай JSON-события в красивые сообщения. Соблюдай Markdown V2.',
  },
  {
    id: 'moderation',
    name: 'Агент модерации',
    role: 'Финальная проверка ответов на отзывы перед публикацией: тон, факты, подпись',
    modelId: 'claude-sonnet-4-6',
    status: 'paused',
    apiKeyMasked: 'sk-ant-***************qN8x',
    responsibilities: [
      'Проверка соответствия тональности',
      'Поиск рискованных фраз и обещаний',
      'Контроль наличия подписи и оформления',
      'Возврат на доработку при нарушениях',
    ],
    metrics: { requestsToday: 0, tokensIn: 0, tokensOut: 0, costToday: 0, successRate: 0, avgLatencyMs: 0 },
    reportsTo: 'orchestrator',
    systemPrompt: 'Ты — модератор. На вход — черновик ответа от агента отзывов. Если всё ок — пропусти. Если есть замечания — верни список правок.',
  },
  {
    id: 'roi',
    name: 'ROI-агент',
    role: 'Считает прибыль с учётом комиссий, эквайринга, доставки. Алерты при падении ROI ниже порога',
    modelId: 'claude-haiku-4-5',
    status: 'planned',
    apiKeyMasked: '—',
    responsibilities: [
      'Сбор комиссий FBO/FBS, эквайринга, доставки из Ozon API',
      'Загрузка себестоимостей из CSV',
      'Расчёт unit-экономики и ROI по каждому SKU',
      'Telegram-алерты при падении ROI ниже порога',
    ],
    metrics: { requestsToday: 0, tokensIn: 0, tokensOut: 0, costToday: 0, successRate: 0, avgLatencyMs: 0 },
    reportsTo: 'orchestrator',
    systemPrompt: 'Ты — финансовый аналитик. Возвращай ROI и прибыль по каждому SKU + объясняй где теряются деньги (высокая комиссия, длинная доставка, низкая маржа).',
  },
  {
    id: 'card-audit',
    name: 'Агент аудита карточек',
    role: 'Сравнивает наш контент с конкурентами: описание, фото, FAQ, частые проблемы из отзывов',
    modelId: 'claude-sonnet-4-6',
    status: 'planned',
    apiKeyMasked: '—',
    responsibilities: [
      'Парсинг карточек топ-3 конкурентов по каждому нашему SKU',
      'LLM-сравнение наших описаний и фото с конкурентами',
      'Извлечение частых проблем из отзывов и FAQ',
      'Чек-лист отсутствующих характеристик',
    ],
    metrics: { requestsToday: 0, tokensIn: 0, tokensOut: 0, costToday: 0, successRate: 0, avgLatencyMs: 0 },
    reportsTo: 'orchestrator',
    systemPrompt: 'Ты — контент-аудитор маркетплейса. Сравнивай нашу карточку с топ-3 конкурентами по: длине описания, кол-ву фото, упомянутым характеристикам. Возвращай 3-5 конкретных рекомендаций.',
  },
  {
    id: 'ads',
    name: 'Агент рекламы',
    role: 'Управление РК WB/Ozon: ставки, алерты при падении CTR, автопауза неэффективных кампаний',
    modelId: 'gpt-4o',
    status: 'planned',
    apiKeyMasked: '—',
    responsibilities: [
      'Подключение Ozon Performance API + WB Adv API',
      'Мониторинг CTR/ДРР по каждой кампании',
      'Рекомендации по корректировке ставок',
      'Автопауза при превышении ДРР (по правилам)',
    ],
    metrics: { requestsToday: 0, tokensIn: 0, tokensOut: 0, costToday: 0, successRate: 0, avgLatencyMs: 0 },
    reportsTo: 'orchestrator',
    systemPrompt: 'Ты — рекламный таргетолог. На вход — метрики кампаний за период. Возвращай: какие кампании эффективны, какие пора паузить, рекомендации по ставкам.',
  },
  {
    id: 'stock',
    name: 'Агент остатков',
    role: 'Алерты на критические остатки, прогноз окончания запасов, рекомендации по распределению',
    modelId: 'claude-haiku-4-5',
    status: 'planned',
    apiKeyMasked: '—',
    responsibilities: [
      'Мониторинг остатков FBO/FBS через Ozon stocks API',
      'Прогноз окончания запасов по средним продажам',
      'Алерты в Telegram при критическом уровне',
      'Рекомендации по распределению WB ↔ Ozon ↔ склады',
    ],
    metrics: { requestsToday: 0, tokensIn: 0, tokensOut: 0, costToday: 0, successRate: 0, avgLatencyMs: 0 },
    reportsTo: 'orchestrator',
    systemPrompt: 'Ты — логист маркетплейсов. Возвращай: какие SKU критичны, через сколько дней закончатся, куда перераспределить остатки.',
  },
  {
    id: 'keywords',
    name: 'Агент позиций',
    role: 'Отслеживание выдачи по ключевикам, сравнение с конкурентами, алерты при падении',
    modelId: 'gemini-2-flash',
    status: 'planned',
    apiKeyMasked: '—',
    responsibilities: [
      'Парсинг выдачи WB и Ozon по списку ключевиков (раз в сутки)',
      'Запись позиций наших SKU и топ-3 конкурентов',
      'Алерт при падении позиции > 5 или вылете из топа',
      'Анализ корреляции позиций с продажами',
    ],
    metrics: { requestsToday: 0, tokensIn: 0, tokensOut: 0, costToday: 0, successRate: 0, avgLatencyMs: 0 },
    reportsTo: 'orchestrator',
    systemPrompt: 'Ты — SEO-аналитик маркетплейса. На вход — позиции по ключам за период. Возвращай: что просело, что выросло, гипотезы причин.',
  },
];

export const weekly = {
  revenue: { current: 1184320, prev: 1052100 },
  orders:  { current: 312,     prev: 287 },
  avg:     { current: 3796,    prev: 3666 },
  returns: { current: 18,      prev: 22 },
  daily: [142000, 168000, 175000, 154000, 198000, 163000, 184320],
};
