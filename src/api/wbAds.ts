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

// Статистику кампаний браузер не запрашивает: её греет сборщик (api/_lib/cron.ts,
// с 19.11.2026 — /api/advert/v4/fullstats), экраны читают готовое из хранилища.

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
