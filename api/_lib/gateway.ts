/**
 * Шлюз к API площадок (этап 0 «Рекламы 2.0», 13.10.2026).
 *
 * Зачем. Лимиты WB считаются на ВЕСЬ кабинет продавца, а не на ключ: второй ключ
 * квоту не прибавляет. До шлюза каждый модуль (прогрев cron, РНП, остатки,
 * отзывы, логистика) ходил в WB сам и выдерживал паузы только внутри себя —
 * два модуля легко били в один метод одновременно и получали общий штраф.
 *
 * Как работает. Каждый запрос через fetchWithRetry сначала проходит gate():
 *   • по хосту и пути выбирается «ведро» с минимальным интервалом между
 *     запросами (интервалы — из таблиц лимитов в официальных спецификациях);
 *   • ожидающие встают в очередь по приоритету: 0 — действие пользователя или
 *     автопилота, 1 — свежая статистика (по умолчанию), 2 — догрузка истории;
 *   • 429 от площадки ставит паузу на всё ведро — её видят все модули сразу.
 * Хосты без правила (Anthropic, Google, витрины) идут без задержки.
 *
 * Если ждать пришлось бы дольше maxWaitMs, gate() не держит вызывающего, а
 * бросает GatewayBusy: fetchWithRetry превращает это в обычный 429 с
 * X-Ratelimit-Retry, и вызывающий ставит свой cooldown, как и раньше.
 */

export type Priority = 0 | 1 | 2;

type Rule = { bucket: string; host: string; path?: RegExp; intervalMs: number };

// Порядок важен: первое совпадение по пути выигрывает, правило без path — запасное для хоста.
const RULES: Rule[] = [
  // ── WB Продвижение (advert-api) ── интервалы из 08-promotion.yaml, персональный ключ
  { bucket: 'wb-adv:fullstats',  host: 'advert-api.wildberries.ru', path: /^\/adv\/v3\/fullstats/,                 intervalMs: 20_000 },
  { bucket: 'wb-adv:daily-lim',  host: 'advert-api.wildberries.ru', path: /^\/api\/advert\/v0\/daily-limits/,       intervalMs: 12_000 },
  { bucket: 'wb-adv:bids-reco',  host: 'advert-api.wildberries.ru', path: /^\/api\/advert\/v0\/bids\/recommendations/, intervalMs: 12_000 },
  { bucket: 'wb-adv:bids-min',   host: 'advert-api.wildberries.ru', path: /^\/api\/advert\/v1\/bids\/min/,          intervalMs: 3_000 },
  { bucket: 'wb-adv:bids',       host: 'advert-api.wildberries.ru', path: /^\/api\/advert\/v1\/bids/,               intervalMs: 200 },
  { bucket: 'wb-adv:budget',     host: 'advert-api.wildberries.ru', path: /^\/api\/advert\/v2\/budget/,             intervalMs: 3_000 },
  { bucket: 'wb-adv:adverts',    host: 'advert-api.wildberries.ru', path: /^\/api\/advert\/v2\/adverts/,            intervalMs: 200 },
  { bucket: 'wb-adv:cluster-st', host: 'advert-api.wildberries.ru', path: /^\/adv\/v[01]\/normquery\/stats/,        intervalMs: 6_000 },
  { bucket: 'wb-adv:lifecycle',  host: 'advert-api.wildberries.ru', path: /^\/adv\/v0\/(start|pause|stop)/,         intervalMs: 200 },
  { bucket: 'wb-adv:other',      host: 'advert-api.wildberries.ru',                                                 intervalMs: 1_000 },
  // ── WB Аналитика ── 3 запроса в минуту, всплеск 1 → интервал 20 с
  { bucket: 'wb-an:funnel',      host: 'seller-analytics-api.wildberries.ru', path: /^\/api\/analytics\/v3\/sales-funnel/, intervalMs: 20_000 },
  { bucket: 'wb-an:search',      host: 'seller-analytics-api.wildberries.ru', path: /^\/api\/v2\/search-report/,     intervalMs: 20_000 },
  { bucket: 'wb-an:nm-report',   host: 'seller-analytics-api.wildberries.ru', path: /^\/api\/v2\/nm-report/,         intervalMs: 20_000 },
  { bucket: 'wb-an:other',       host: 'seller-analytics-api.wildberries.ru',                                       intervalMs: 1_000 },
  // ── WB Статистика ── supplier/* — 1 запрос в минуту на кабинет
  { bucket: 'wb-stat:supplier',  host: 'statistics-api.wildberries.ru', path: /^\/api\/v1\/supplier\//,             intervalMs: 60_000 },
  { bucket: 'wb-stat:other',     host: 'statistics-api.wildberries.ru',                                             intervalMs: 1_000 },
  // Остальные хосты WB: интервал маленький, но 429 всё равно ставит общую паузу.
  { bucket: 'wb-feedbacks',      host: 'feedbacks-api.wildberries.ru',   intervalMs: 350 },
  { bucket: 'wb-content',        host: 'content-api.wildberries.ru',     intervalMs: 600 },
  { bucket: 'wb-common',         host: 'common-api.wildberries.ru',      intervalMs: 1_000 },
  { bucket: 'wb-prices',         host: 'discounts-prices-api.wildberries.ru', intervalMs: 600 },
  { bucket: 'wb-finance',        host: 'finance-api.wildberries.ru',     intervalMs: 60_000 },
  { bucket: 'wb-marketplace',    host: 'marketplace-api.wildberries.ru', intervalMs: 300 },
  { bucket: 'wb-supplies',       host: 'supplies-api.wildberries.ru',    intervalMs: 1_000 },
  // ── Ozon Seller ── analytics/data — 1 запрос в минуту
  { bucket: 'oz:analytics',      host: 'api-seller.ozon.ru', path: /^\/v1\/analytics\/data/,                        intervalMs: 60_000 },
  // Начисления: прод 14.10 — серия 429 «rate limit per second» при запросах подряд
  // без паузы (факт логистики). Лимит в документации не назван — держим 2 с.
  { bucket: 'oz:accrual',        host: 'api-seller.ozon.ru', path: /^\/v1\/finance\/accrual\//,                     intervalMs: 2_000 },
  { bucket: 'oz:seller',         host: 'api-seller.ozon.ru',                                                        intervalMs: 0 },
  // ── Ozon Performance ── 100 000 в сутки; отчёты сериализует ozonSkuAds сам
  { bucket: 'oz-perf',           host: 'api-performance.ozon.ru',                                                   intervalMs: 0 },
];

/** Дольше этого вызывающего не держим — отдаём «занято», как отдала бы площадка. */
const DEFAULT_MAX_WAIT_MS = 210_000;

type Waiter = { prio: Priority; seq: number; resolve: () => void };
type Bucket = {
  id: string;
  intervalMs: number;
  lastAt: number;
  pausedUntil: number;
  queue: Waiter[];
  timer: ReturnType<typeof setTimeout> | null;
  // учёт для экрана настроек
  requests: number;
  throttled: number;
  waitedMs: number;
  lastStatus: number;
  last429At: number;
  hourStart: number;
  hourRequests: number;
};

// Вёдра — на process, как кэш в cache.ts: под tsx модуль грузится в двух копиях,
// и у каждой были свои вёдра — общий лимит кабинета не соблюдался, прилетали 429.
const G: { buckets: Map<string, Bucket>; seq: number } = ((process as any).__AV_GATEWAY__ ??= { buckets: new Map<string, Bucket>(), seq: 0 });
const buckets = G.buckets;

export class GatewayBusy extends Error {
  retryAfterSec: number;
  bucket: string;
  constructor(bucket: string, waitMs: number) {
    super(`gateway: ведро ${bucket} занято ещё ${Math.ceil(waitMs / 1000)} с`);
    this.name = 'GatewayBusy';
    this.bucket = bucket;
    this.retryAfterSec = Math.ceil(waitMs / 1000);
  }
}

export function ruleFor(url: string): Rule | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  for (const r of RULES) {
    if (r.host !== u.host) continue;
    if (r.path && !r.path.test(u.pathname)) continue;
    return r;
  }
  return null;
}

function bucketOf(rule: Rule): Bucket {
  let b = buckets.get(rule.bucket);
  if (!b) {
    b = {
      id: rule.bucket, intervalMs: rule.intervalMs, lastAt: 0, pausedUntil: 0, queue: [], timer: null,
      requests: 0, throttled: 0, waitedMs: 0, lastStatus: 0, last429At: 0, hourStart: Date.now(), hourRequests: 0,
    };
    buckets.set(rule.bucket, b);
  }
  return b;
}

function readyAt(b: Bucket): number {
  return Math.max(b.lastAt + b.intervalMs, b.pausedUntil);
}

function pump(b: Bucket): void {
  if (b.timer) return;
  if (!b.queue.length) return;
  const wait = readyAt(b) - Date.now();
  if (wait > 0) {
    b.timer = setTimeout(() => { b.timer = null; pump(b); }, wait);
    return;
  }
  b.queue.sort((x, y) => x.prio - y.prio || x.seq - y.seq);
  const w = b.queue.shift()!;
  b.lastAt = Date.now();
  w.resolve();
  if (b.queue.length) pump(b);
}

/**
 * Дождаться своей очереди к площадке. Для хостов без правила возвращается сразу.
 * Бросает GatewayBusy, если ждать дольше maxWaitMs.
 */
export async function gate(url: string, prio: Priority = 1, maxWaitMs = DEFAULT_MAX_WAIT_MS): Promise<string | null> {
  const rule = ruleFor(url);
  if (!rule) return null;
  const b = bucketOf(rule);
  // Оценка ожидания: пауза ведра + интервалы тех, кто стоит впереди нас.
  const ahead = b.queue.filter(w => w.prio <= prio).length;
  const estimate = Math.max(0, readyAt(b) - Date.now()) + ahead * b.intervalMs;
  if (estimate > maxWaitMs) throw new GatewayBusy(b.id, estimate);
  const t0 = Date.now();
  await new Promise<void>(resolve => { b.queue.push({ prio, seq: G.seq++, resolve }); pump(b); });
  b.waitedMs += Date.now() - t0;
  return b.id;
}

/** Отметить ответ площадки: считаем запросы, на 429 ставим паузу всему ведру. */
export function note(url: string, status: number, retryAfterSec?: number): void {
  const rule = ruleFor(url);
  if (!rule) return;
  const b = bucketOf(rule);
  const now = Date.now();
  if (now - b.hourStart > 3_600_000) { b.hourStart = now; b.hourRequests = 0; }
  b.requests++;
  b.hourRequests++;
  b.lastStatus = status;
  if (status === 429) {
    b.throttled++;
    b.last429At = now;
    const sec = Number.isFinite(retryAfterSec) && retryAfterSec! > 0 ? retryAfterSec! : 60;
    b.pausedUntil = Math.max(b.pausedUntil, now + sec * 1000 + 1_000);
  }
}

export type GatewayBucketStatus = {
  bucket: string; intervalMs: number; queued: number; pausedForSec: number;
  requests: number; requestsLastHour: number; throttled: number; avgWaitMs: number;
  lastStatus: number; last429At: number | null;
};

/** Состояние всех ведер — для экрана настроек и диагностики. */
export function gatewayStatus(): GatewayBucketStatus[] {
  const now = Date.now();
  return [...buckets.values()].map(b => ({
    bucket: b.id,
    intervalMs: b.intervalMs,
    queued: b.queue.length,
    pausedForSec: Math.max(0, Math.ceil((b.pausedUntil - now) / 1000)),
    requests: b.requests,
    requestsLastHour: now - b.hourStart > 3_600_000 ? 0 : b.hourRequests,
    throttled: b.throttled,
    avgWaitMs: b.requests ? Math.round(b.waitedMs / b.requests) : 0,
    lastStatus: b.lastStatus,
    last429At: b.last429At || null,
  })).sort((a, b) => a.bucket.localeCompare(b.bucket));
}

/** Только для проверочных скриптов: начать с чистого листа. */
export function _resetGatewayForTests(): void {
  for (const b of buckets.values()) if (b.timer) clearTimeout(b.timer);
  buckets.clear();
}
