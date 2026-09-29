// Высокоуровневые методы для рекламы WB. Используют wbFetchCached с TTL.
// Все возвращают типизированные данные.
import { wbFetchCached } from './wb';
import { mskDateOf } from '../utils/mskDate';

const ADS_TTL = 30 * 60_000;       // 30 минут стандартный кэш
const ADS_TTL_REALTIME = 5 * 60_000; // баланс — 5 мин

// ─── /adv/v1/balance ───────────────────────────────────────────────────────
// Возвращает { balance, net, bonus }. WB переделали с v3 на v1.
export type WbBalance = { balance: number; net: number; bonus: number };

export async function wbGetBalance(force = false) {
  return wbFetchCached<WbBalance>('promotion', '/adv/v1/balance', { ttlMs: ADS_TTL_REALTIME, force, noRetryOn429: true });
}

// ─── /adv/v1/promotion/adverts ──────────────────────────────────────────────
export type WbAdvertMeta = {
  advertId: number;
  type: number;      // 4..9
  status: number;    // -1, 4, 7, 8, 9, 11
  changeTime?: string;
  name?: string;
};

export async function wbGetAdverts(force = false) {
  // Этот эндпоинт принимает status и type через query или возвращает все группированно
  return wbFetchCached<any>('promotion', '/adv/v1/promotion/adverts', {
    ttlMs: ADS_TTL,
    force,
    noRetryOn429: true,
    init: { method: 'POST', body: JSON.stringify({}) }, // body — массив фильтров; пустой = все
  });
}

// ─── /adv/v1/promotion/count — счётчики ────────────────────────────────────
export type WbPromotionCount = {
  all: number;
  adverts?: Array<{
    type: number;
    status: number;
    count: number;
    advert_list?: Array<{ advertId: number; changeTime?: string }>;
  }>;
};

export async function wbGetPromotionCount(force = false) {
  return wbFetchCached<WbPromotionCount>('promotion', '/adv/v1/promotion/count', { ttlMs: ADS_TTL, force, noRetryOn429: true });
}

// ─── /adv/v3/fullstats — детальная статистика ──────────────────────────────
// Лимит WB (обновлено 07.2026): 1 req/min, МАКС 50 кампаний за запрос, до 31 дня.
// ⚠ WB сменил формат ids: теперь `ids=1,2,3` ОДНИМ параметром через запятую
// (было `ids=1&ids=2&ids=3`). Старый формат отдаёт 400 «ids is not exploded».
// Больше 50 кампаний → 400 «number of advert cannot be more than 50» — их греет
// сборщик чанками по 50 и склеивает под этим же ключом (см. api/route.ts).
export type WbFullStatsItem = {
  advertId: number;
  views: number;       // показы
  clicks: number;
  ctr: number;
  cpc: number;
  sum: number;         // расход
  atbs: number;        // в корзину
  orders: number;
  cr: number;          // conversion rate
  shks: number;        // заказано штук
  sum_price: number;   // выручка
  days?: Array<{
    date: string;
    views: number;
    clicks: number;
    ctr: number;
    cpc: number;
    sum: number;
    atbs: number;
    orders: number;
    cr: number;
    shks: number;
    sum_price: number;
    apps?: Array<{ appType: number; views: number; clicks: number; sum: number; orders: number }>;
    nm?: Array<{ nmId: number; name?: string; views: number; clicks: number; sum: number; orders: number; sum_price?: number }>;
  }>;
};

export async function wbGetFullStats(
  advertIds: number[],
  begin: string,
  end: string,
  force = false,
) {
  if (!advertIds.length) return { data: [] as WbFullStatsItem[], fromCache: false, fetchedAt: Date.now() };
  // Ключ строим на все ids (до 100) одним параметром через запятую — ровно так же
  // его прогревает сборщик (склеивая чанки по 50). Формат `ids=1,2,3` обязателен.
  // СОРТИРУЕМ ids: WB отдаёт кампании в разном порядке между запросами, а ключ
  // кэша зависит от порядка → при переходе между вкладками ключ не совпадал и
  // цифры «пропадали». Сортировка делает ключ детерминированным и стабильным.
  // 100 самых свежих кампаний (высокий advertId) — тратящие обычно недавние;
  // «первые 100» их обрезали → расход 0. Затем ASC для стабильного ключа кэша.
  const ids = advertIds.slice().sort((a, b) => b - a).slice(0, 100).sort((a, b) => a - b);
  const queryIds = `ids=${ids.join(',')}`;
  return wbFetchCached<WbFullStatsItem[]>('promotion', `/adv/v3/fullstats?${queryIds}&beginDate=${begin}&endDate=${end}`, {
    ttlMs: ADS_TTL,
    force,
    noRetryOn429: true,
    init: { method: 'GET' },
  });
}

// ─── /adv/v1/payments — история пополнений ─────────────────────────────────
export type WbPayment = {
  id: number;
  date: string;
  sum: number;
  type: number;        // 0 — банк.карта, 1 — счёт
  paymentType?: string;
  statusId?: number;
};

export async function wbGetPayments(from: string, to: string, force = false) {
  return wbFetchCached<WbPayment[]>(
    'promotion',
    `/adv/v1/payments?from=${from}&to=${to}`,
    { ttlMs: ADS_TTL, force, noRetryOn429: true },
  );
}

// ─── Утилиты для дат ────────────────────────────────────────────────────────
// По МОСКВЕ: рекламный API WB отдаёт дни московскими сутками, и на UTC-границе
// окно съезжало на день (см. utils/mskDate).
export function isoDate(d: Date): string {
  return mskDateOf(d);
}
export function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return isoDate(d);
}
export function today(): string {
  return isoDate(new Date());
}

// ─── Метрики ────────────────────────────────────────────────────────────────
export function roas(sumPrice: number, sum: number): number | null {
  if (!sum) return null;
  return sumPrice / sum;
}
