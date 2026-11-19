/**
 * Рекламные метрики WB в разрезе товара.
 *
 * Основной источник — хранилище «Рекламы» (ad_stat_day), куда сборщик пишет
 * прогретую cron-ом статистику кампаний. Запасной путь — сам кэш статистики:
 * с 19.11.2026 это /api/advert/v4/fullstats (плоские строки), до него —
 * /adv/v3/fullstats (days[].apps[].nms[]). Оба разбираются функциями сборщика,
 * чтобы правила сложения жили в одном месте.
 *
 * Благодаря дневной детализации оба периода (текущий и предыдущий) считаются из
 * ОДНОГО ответа — дополнительных запросов к WB не нужно, а лимиты у них жёсткие.
 */
import { cacheGetNewestByPrefix, makeUpstreamCachePrefix } from '../cache';
import { mskDate } from '../mskDate';
import { AdFunnel, emptyFunnel } from './metrics';
import { skuStatsByDay, type StatDayRow } from './store';
import { parseWbFullstats, parseWbFullstatsV4 } from './sync';

export type WbAdsByNm = {
  /** nmId → метрики за период */
  current: Map<number, AdFunnel>;
  previous: Map<number, AdFunnel>;
  /** Названия товаров. WB перестал отдавать их в статистике (поле name пустое), v4 их не знает. */
  names: Map<number, string>;
  daysCovered: number;
};

const num = (v: any) => (Number.isFinite(Number(v)) ? Number(v) : 0);
// Границы окон — по Москве: WB отдаёт даты московскими сутками, и на
// UTC-границе последний день выпадал из текущего окна в предыдущее.
const isoDay = (daysBack: number) => mskDate(daysBack);

/** Свежайшая статистика из кэша (v4, иначе v3) в виде строк «кампания × товар × день». */
function readCachedRows(): StatDayRow[] | null {
  for (const [rest, parse] of [
    ['api/advert/v4/fullstats', (j: unknown) => parseWbFullstatsV4(j)],
    ['adv/v3/fullstats', (j: unknown) => parseWbFullstats(j)],
  ] as const) {
    const near = cacheGetNewestByPrefix<{ status: number; text: string }>(
      makeUpstreamCachePrefix('wb:promotion', 'GET', rest, '', undefined),
    );
    if (!near || near.data.status >= 400) continue;
    try { return parse(JSON.parse(near.data.text)); } catch (e) {
      console.warn(`[wb-ads] кэш ${rest} не разобран:`, (e as Error).message);
    }
  }
  return null;
}

/** Почему метрик нет — чтобы в интерфейсе не писать «нет в кэше», когда кэш полон. */
export type WbAdsMiss = 'no-cache' | 'no-product-breakdown' | 'no-data-in-window';
let lastMiss: WbAdsMiss | null = null;

/** Причина последнего пустого ответа `getWbAdsByNm`. */
export function wbAdsMissReason(): WbAdsMiss | null { return lastMiss; }

/**
 * Метрики по товарам за два окна.
 * @param days длина окна в днях (7 — текущая неделя против предыдущей)
 */
export function getWbAdsByNm(days = 7): WbAdsByNm | null {
  // 22.10.2026: метрики — из хранилища «Рекламы» (ad_stat_day). Свежее окно кэша
  // бывает неполным (429 на часть кампаний) и занижало расход; хранилище копит
  // строки по «кампания × день» и неполным ответом не стирается. Кэш — запасной путь.
  const stored = skuStatsByDay('wb', isoDay(2 * days - 1), isoDay(0));
  const fromStore = stored.length > 0;
  let rows: { date: string; sku: string; views: number; clicks: number; spend: number; carts: number; orders: number; revenue: number }[] = stored;
  if (!fromStore) {
    const cached = readCachedRows();
    if (!cached) { lastMiss = 'no-cache'; return null; }
    if (!cached.length) { lastMiss = 'no-product-breakdown'; return null; }
    rows = cached;
  }

  const curFrom = isoDay(days - 1);
  const prevFrom = isoDay(2 * days - 1);
  const current = new Map<number, AdFunnel>();
  const previous = new Map<number, AdFunnel>();
  const seen = new Set<string>();
  for (const r of rows) {
    const nmId = Number(r.sku);
    if (!nmId) continue;
    seen.add(r.date);
    const map = r.date >= curFrom ? current : r.date >= prevFrom ? previous : null;
    if (!map) continue;
    const f = map.get(nmId) ?? emptyFunnel();
    f.views += num(r.views); f.clicks += num(r.clicks); f.spend += num(r.spend);
    f.orders += num(r.orders); f.revenue += num(r.revenue); f.carts += num(r.carts);
    map.set(nmId, f);
  }

  if (!current.size && !previous.size) {
    // Статистика есть, но за нужные дни пусто — это НЕ «нет в кэше».
    lastMiss = 'no-data-in-window';
    return null;
  }
  lastMiss = null;
  return { current, previous, names: new Map(), daysCovered: seen.size };
}
