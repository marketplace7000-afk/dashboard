/**
 * Рекламные метрики WB в разрезе товара.
 *
 * Источник — прогретая cron-ом статистика кампаний (adv/v3/fullstats). Внутри
 * каждой кампании есть массив days[], а в каждом дне — nm[] с разбивкой по
 * товарам. Мы этой разбивкой раньше не пользовались, хотя она уже лежала в кэше.
 *
 * Благодаря дневной детализации оба периода (текущий и предыдущий) считаются из
 * ОДНОГО ответа — дополнительных запросов к WB не нужно, а лимиты у них жёсткие.
 */
import { cacheGetNewestByPrefix, makeUpstreamCachePrefix } from '../cache';
import { mskDate } from '../mskDate';
import { AdFunnel, emptyFunnel } from './metrics';

type NmRow = { nmId: number; name?: string; views?: number; clicks?: number; sum?: number; orders?: number; sum_price?: number };
// ⚠ У WB разбивка по товарам лежит в поле `nms`, а НЕ `nm`. Проверено на живом
// ответе 01.09.2026: days[].apps[].nms[] = [{nmId, name, views, clicks, sum,
// orders, sum_price, atbs}]. Мы читали `nm`, получали undefined, и вся реклама
// WB по товарам была пустой — отсюда «WB 0 строк» в таблице и ДРР 7% у всех
// товаров WB (жалоба клиента 29.08, п.2). Держим оба имени: у части кампаний
// встречается и `nm`, а лишняя проверка дешевле повторения этой истории.
type AppRow = { appType?: number; atbs?: number; nm?: NmRow[]; nms?: NmRow[] };
type DayRow = { date?: string; atbs?: number; nm?: NmRow[]; nms?: NmRow[]; apps?: AppRow[] };
type Campaign = { advertId?: number; days?: DayRow[] };

export type WbAdsByNm = {
  /** nmId → метрики за период */
  current: Map<number, AdFunnel>;
  previous: Map<number, AdFunnel>;
  names: Map<number, string>;
  daysCovered: number;
};

const num = (v: any) => (Number.isFinite(Number(v)) ? Number(v) : 0);
// Границы окон — по Москве: WB отдаёт days[].date московскими сутками, и на
// UTC-границе последний день выпадал из текущего окна в предыдущее.
const isoDay = (daysBack: number) => mskDate(daysBack);

/** Свежайшая статистика из кэша: точный ключ зависит от списка кампаний, поэтому ищем по префиксу. */
function readFullStats(): Campaign[] | null {
  const near = cacheGetNewestByPrefix<{ status: number; text: string }>(
    makeUpstreamCachePrefix('wb:promotion', 'GET', 'adv/v3/fullstats', '', undefined),
  );
  if (!near || near.data.status >= 400) return null;
  try {
    const arr = JSON.parse(near.data.text);
    return Array.isArray(arr) ? arr as Campaign[] : null;
  } catch {
    return null;
  }
}

function add(map: Map<number, AdFunnel>, nmId: number, r: NmRow, atbsShare: number): void {
  const f = map.get(nmId) ?? emptyFunnel();
  f.views += num(r.views);
  f.clicks += num(r.clicks);
  f.spend += num(r.sum);
  f.orders += num(r.orders);
  f.revenue += num(r.sum_price);
  // Корзины WB отдаёт только на уровне ДНЯ целиком (atbs), без разбивки по
  // товарам. Раскладываем пропорционально кликам товара — точнее, чем ноль,
  // но это оценка, и сценарии по корзинам стоит трактовать мягче.
  f.carts += atbsShare;
  map.set(nmId, f);
}

/**
 * Метрики по товарам за два окна.
 * @param days длина окна в днях (7 — текущая неделя против предыдущей)
 */
/** Почему метрик нет — чтобы в интерфейсе не писать «нет в кэше», когда кэш полон. */
export type WbAdsMiss = 'no-cache' | 'no-product-breakdown' | 'no-data-in-window';
let lastMiss: WbAdsMiss | null = null;

/** Причина последнего пустого ответа `getWbAdsByNm`. */
export function wbAdsMissReason(): WbAdsMiss | null { return lastMiss; }

export function getWbAdsByNm(days = 7): WbAdsByNm | null {
  const campaigns = readFullStats();
  if (!campaigns) { lastMiss = 'no-cache'; return null; }

  const curFrom = isoDay(days - 1);
  const prevFrom = isoDay(2 * days - 1);
  const prevTo = isoDay(days);

  const current = new Map<number, AdFunnel>();
  const previous = new Map<number, AdFunnel>();
  const names = new Map<number, string>();
  const seenDays = new Set<string>();

  for (const c of campaigns) {
    for (const d of (c.days ?? [])) {
      const date = String(d.date ?? '').slice(0, 10);
      if (!date) continue;
      // WB кладёт разбивку по товарам либо прямо в день (`nm`), либо внутрь
      // площадок показа (`apps[].nm` — сайт, приложение и т.д.). Формат зависит
      // от типа кампании, поэтому читаем оба варианта и склеиваем: раньше при
      // формате с apps таблица по WB оставалась пустой при живом расходе.
      const nms: NmRow[] = [
        ...(d.nms ?? d.nm ?? []),
        ...(d.apps ?? []).flatMap(a => a?.nms ?? a?.nm ?? []),
      ];
      if (!nms.length) continue;
      seenDays.add(date);

      const target = date >= curFrom ? current
        : (date >= prevFrom && date <= prevTo) ? previous
        : null;
      if (!target) continue;

      const dayClicks = nms.reduce((s, r) => s + num(r.clicks), 0);
      // Корзины WB отдаёт на уровне дня; в формате с apps — по площадкам.
      const dayAtbs = num(d.atbs) || (d.apps ?? []).reduce((s, a) => s + num(a?.atbs), 0);
      for (const r of nms) {
        if (!r?.nmId) continue;
        if (r.name && !names.has(r.nmId)) names.set(r.nmId, r.name);
        const share = dayClicks > 0 ? (dayAtbs * num(r.clicks)) / dayClicks : 0;
        add(target, r.nmId, r, share);
      }
    }
  }

  if (!current.size && !previous.size) {
    // Статистика есть, но товарной разбивки в ней нет — это НЕ «нет в кэше».
    // Раньше оба случая давали одну и ту же надпись, и месяц было непонятно,
    // сборщик не отработал или WB не отдаёт разбивку.
    lastMiss = seenDays.size ? 'no-data-in-window' : 'no-product-breakdown';
    return null;
  }
  lastMiss = null;
  return { current, previous, names, daysCovered: seenDays.size };
}
