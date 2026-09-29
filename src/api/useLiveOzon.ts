import { useEffect, useState } from 'react';
import { ozonProductList, localDateStr } from './marketplaces';
import { noteSwallowed } from '../utils/log';
import {
  PERIOD_DAYS, periodRange, prevPeriodRange, type PeriodKey, type DateRange,
} from '../utils/period';

// Словарь периодов и арифметика окон переехали в utils/period.ts — они общие для
// WB, Ozon и финансов, и держать их в модуле одной площадки было ошибкой. Здесь
// оставлен ре-экспорт: половина экранов импортирует эти имена отсюда, и менять
// два десятка импортов ради переезда незачем. Новые места берут из utils/period.
export type { PeriodKey } from '../utils/period';
export { PERIOD_DAYS, PERIOD_LABEL, fmtRangeRu, periodLabelRu } from '../utils/period';

export type LiveOzonState = {
  loading: boolean;
  error?: string;
  totalProducts: number;
  revenue: number;
  orders: number;
  avgCheck: number;
  daily: number[];
  prevRevenue: number;
  prevOrders: number;
};

const EMPTY: LiveOzonState = {
  loading: true,
  totalProducts: 0,
  revenue: 0,
  orders: 0,
  avgCheck: 0,
  daily: [],
  prevRevenue: 0,
  prevOrders: 0,
};

// Persistent кэш в localStorage с TTL 90 мин (cron-friendly).
const LS_KEY = 'live-ozon-state:v1';
const LS_TTL_MS = 90 * 60_000;
type StoredState = { state: LiveOzonState; ts: number };

function loadAllFromLS(): Partial<Record<PeriodKey, LiveOzonState>> {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return {};
    const all = JSON.parse(raw) as Partial<Record<PeriodKey, StoredState>>;
    const out: Partial<Record<PeriodKey, LiveOzonState>> = {};
    for (const k of Object.keys(all) as PeriodKey[]) {
      const v = all[k];
      if (v && Date.now() - v.ts < LS_TTL_MS) out[k] = v.state;
    }
    return out;
  } catch { return {}; }
}

function saveAllToLS() {
  try {
    const all: Partial<Record<PeriodKey, StoredState>> = {};
    for (const k of Object.keys(cache) as PeriodKey[]) {
      const s = cache[k]; if (s) all[k] = { state: s, ts: Date.now() };
    }
    localStorage.setItem(LS_KEY, JSON.stringify(all));
  } catch (e) {
    // Кэш не записался (чаще всего переполнение): экран отработает, но при
    // следующем заходе всё будет грузиться заново, и это выглядит как тормоза.
    noteSwallowed('ozon-live', 'состояние не записано в кэш', e);
  }
}

// Кэш по периоду — чтобы переключения день/нед/месяц не дёргали повторно
const cache: Partial<Record<PeriodKey, LiveOzonState>> = loadAllFromLS();
const subs: Record<PeriodKey, Set<(s: LiveOzonState) => void>> = { day: new Set(), week: new Set(), month: new Set() };

// Окно за период: РОВНО N суток, ЗАКАНЧИВАЯ СЕГОДНЯ — как у WB и как в кабинете.
function rangeFor(period: PeriodKey): { cur: DateRange; prev: DateRange } {
  return { cur: periodRange(period), prev: prevPeriodRange(period) };
}

/** Диапазон дат текущего периода (для подписи в интерфейсе). */
export function ozonPeriodRange(period: PeriodKey): DateRange {
  return periodRange(period);
}



async function fetchAnalytics(dateFrom: string, dateTo: string) {
  const r = await fetch('/ozon/v1/analytics/data', {
    method: 'POST',
    body: JSON.stringify({
      date_from: dateFrom,
      date_to: dateTo,
      metrics: ['ordered_units', 'revenue'],
      dimension: ['day'],
      limit: 1000,
      offset: 0,
    }),
  });
  const data = await r.json();
  const rows: { metrics: number[] }[] = data?.result?.data ?? [];
  return {
    orders: rows.reduce((s, x) => s + (x.metrics[0] ?? 0), 0),
    revenue: rows.reduce((s, x) => s + (x.metrics[1] ?? 0), 0),
    daily: rows.map((x) => x.metrics[1] ?? 0),
  };
}

async function load(period: PeriodKey) {
  const { cur: cw, prev: pw } = rangeFor(period);
  try {
    const [products, cur, prev] = await Promise.all([
      ozonProductList(1),
      fetchAnalytics(cw.from, cw.to),
      fetchAnalytics(pw.from, pw.to),
    ]);
    const s: LiveOzonState = {
      loading: false,
      totalProducts: products.total,
      revenue: cur.revenue,
      orders: cur.orders,
      avgCheck: cur.orders > 0 ? Math.round(cur.revenue / cur.orders) : 0,
      daily: cur.daily,
      prevRevenue: prev.revenue,
      prevOrders: prev.orders,
    };
    cache[period] = s;
    saveAllToLS();
    subs[period].forEach((l) => l(s));
  } catch (e: any) {
    const s: LiveOzonState = { ...EMPTY, loading: false, error: String(e?.message ?? e) };
    cache[period] = s;
    subs[period].forEach((l) => l(s));
  }
}

/** Принудительно перезапросить данные за указанный период (без кэша). */
export function refreshLiveOzon(period: PeriodKey) {
  return load(period);
}

export function useLiveOzon(period: PeriodKey = 'day'): LiveOzonState {
  const [state, setState] = useState<LiveOzonState>(() => cache[period] ?? EMPTY);

  useEffect(() => {
    subs[period].add(setState);
    const c = cache[period];
    // Запрос делаем только если данным нет вообще ИЛИ они старше 6 часов.
    // В остальных случаях рендерим то, что cron подтянул — без сетевых вызовов
    // от фронта. Принудительно — через refreshLiveOzon().
    const STALE_MS = 6 * 60 * 60_000;
    const lsKey = LS_KEY;
    let stale = true;
    try {
      const raw = localStorage.getItem(lsKey);
      const all = raw ? JSON.parse(raw) : {};
      const ts = all?.[period]?.ts;
      if (ts && Date.now() - ts < STALE_MS) stale = false;
    } catch (e) {
      // Не смогли определить возраст кэша — считаем его устаревшим и грузим заново.
      noteSwallowed('ozon-live', 'возраст кэша не определён', e);
    }
    if (c) {
      setState(c);
      if (stale) load(period);
    } else {
      load(period);
    }
    return () => { subs[period].delete(setState); };
  }, [period]);

  return state;
}
