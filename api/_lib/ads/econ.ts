/**
 * Экономика и достаточность данных для советов по рекламе (22.10.2026).
 *
 * Основание — разбор менеджера «Аудит алгоритма рекомендаций» (Замечания по
 * рекламе.pdf, 22.10.2026): нельзя приравнивать плохую рекламную метрику к плохому
 * бизнес-результату. Перед любым советом проверяем: данные достоверны → товар
 * доступен → статистики достаточно → экономика подтверждена → причина найдена.
 *
 *   • Допустимая цена заказа = (маржа до рекламы − плановая прибыль) × выкуп.
 *     Маржа листа «Цены» уже включает рекламу (ДРР листа), поэтому её прибавляем
 *     обратно — иначе реклама вычитается дважды.
 *   • «Ноль заказов» — сигнал, только если при обычной конверсии такой ноль
 *     маловероятен: P(0) = (1 − CR)^клики < 5 %. 59 кликов при CR 2 % дают P(0) ≈ 30 % —
 *     это не повод для паузы; 293 клика — ≈ 0,3 %, уже серьёзно.
 */
import type { Ads2Econ, Ads2Stat } from '../../../shared/ads2';

/** Запасная конверсия клика в заказ, если своей истории у товара и площадки нет. */
export const BASE_CR = 0.02;
/** Ноль заказов считаем значимым, если его вероятность при обычной конверсии ниже этого. */
export const P0_MAX = 0.05;
/** Цена заказа выше допустимой в столько раз — скорее ошибка данных, чем реальность. */
export const ANOMALY_X = 10;

const r2 = (v: number) => Math.round(v * 100) / 100;
const rub = (v: number) => `${Math.round(v).toLocaleString('ru-RU')} ₽`;

/** Вероятность не получить ни одного заказа за `clicks` кликов при конверсии `cr`. */
export function zeroOrdersChance(clicks: number, cr: number): number {
  if (clicks <= 0 || cr <= 0) return 1;
  return Math.pow(1 - Math.min(cr, 0.99), clicks);
}

/** Сколько кликов нужно, чтобы ноль заказов стал значимым (P(0) < P0_MAX). */
export function clicksForSignal(cr: number): number {
  if (cr <= 0) return Infinity;
  return Math.ceil(Math.log(P0_MAX) / Math.log(1 - Math.min(cr, 0.99)));
}

/**
 * Экономика товара для рекламы. null — нет маржи (себестоимости или цены):
 * советы по ставке тогда не даём, только просим данные.
 */
export function productEcon(o: {
  marginRub: number | null; adsRub: number | null | undefined; base: number | null | undefined; price: number | null;
  buyout: number | null | undefined; planPct: number; orders: number; revenue: number; spend: number;
}): Ads2Econ | null {
  if (o.marginRub == null) return null;
  const base = o.base ?? o.price;
  if (!base || base <= 0) return null;
  const marginBeforeAds = o.marginRub + (o.adsRub ?? 0);
  const buyoutPct = o.buyout != null && o.buyout > 0 ? Math.min(o.buyout, 100) : 100;
  const target = base * o.planPct / 100;
  const allowedCpo = r2((marginBeforeAds - target) * buyoutPct / 100);
  const avgOrder = o.orders > 0 ? o.revenue / o.orders : base;
  return {
    marginBeforeAds: Math.round(marginBeforeAds), planPct: o.planPct, buyoutPct,
    allowedCpo,
    allowedDrr: avgOrder > 0 ? r2(Math.max(0, allowedCpo) / avgOrder * 100) : null,
    profit: Math.round(o.orders * buyoutPct / 100 * marginBeforeAds - o.spend),
    how: `маржа до рекламы ${rub(marginBeforeAds)} − план прибыли ${o.planPct.toLocaleString('ru-RU')}% (${rub(target)})${buyoutPct < 100 ? `, × выкуп ${buyoutPct.toLocaleString('ru-RU')}%` : ''}`,
  };
}

/** Медиана, без пустых. */
export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export type FunnelBench = { ctr: number | null; cartRate: number | null; cartToOrder: number | null; cr: number | null };

/** Медианы рекламной воронки площадки по товарам с достаточной статистикой. */
export function funnelBench(stats: Ads2Stat[]): FunnelBench {
  return {
    ctr: median(stats.filter(s => s.views >= 1000 && s.ctr != null).map(s => s.ctr!)),
    cartRate: median(stats.filter(s => s.clicks >= 100 && s.cartRate != null).map(s => s.cartRate!)),
    cartToOrder: median(stats.filter(s => s.carts >= 10 && s.cartToOrder != null).map(s => s.cartToOrder!)),
    cr: median(stats.filter(s => s.clicks >= 100 && s.orders >= 1 && s.cr != null).map(s => s.cr!)),
  };
}

/**
 * Где рвётся рекламная воронка: показы → клики → корзины → заказы. Звено «слабое»,
 * если хуже 60 % медианы площадки при достаточной выборке.
 */
export function funnelCause(s: Ads2Stat | null, b: FunnelBench): { stage: 'ctr' | 'cart' | 'order'; text: string } | null {
  if (!s) return null;
  const f = (v: number) => `${r2(v).toLocaleString('ru-RU')}%`;
  if (b.ctr != null && s.views >= 1000 && s.ctr != null && s.ctr < b.ctr * 0.6) {
    return { stage: 'ctr', text: `показы → клики: CTR ${f(s.ctr)} против ${f(b.ctr)} в среднем — проверить главное фото, заголовок, цену в выдаче и соответствие запросу` };
  }
  if (b.cartRate != null && s.clicks >= 100 && s.cartRate != null && s.cartRate < b.cartRate * 0.6) {
    return { stage: 'cart', text: `клики → корзины: ${f(s.cartRate)} против ${f(b.cartRate)} — карточка не убеждает: характеристики, фото, отзывы, доверие` };
  }
  if (b.cartToOrder != null && s.carts >= 10 && s.cartToOrder != null && s.cartToOrder < b.cartToOrder * 0.6) {
    return { stage: 'order', text: `корзины → заказы: ${f(s.cartToOrder)} против ${f(b.cartToOrder)} — итоговая цена, срок доставки, наличие на складах, акции` };
  }
  return null;
}
