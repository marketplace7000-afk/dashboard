import { useEffect, useState } from 'react';
import { noteSwallowed } from '../utils/log';
import {
  ozonProductPricesAll, ozonProductInfoList, ozonStocksList, ozonSkuToProductMap, ozonAnalyticsBySku,
  OzonPriceRow, OzonProductInfo, OzonStockRow, OzonTopSku,
} from './marketplaces';

/**
 * Кэш живых Ozon-данных, общий для всех модулей.
 * Не дёргает API повторно при переключении вкладок — данные тянутся один раз и
 * остаются в module-scope до явного `refresh()`.
 *
 * Это решает 429 Too Many Requests от Ozon при быстром переключении табов.
 */

export type LiveOzonBundle = {
  prices: OzonPriceRow[];
  products: OzonProductInfo[];
  stocks: OzonStockRow[];
  skuToPid: Map<string, number>;
  topByWeek: OzonTopSku[];
  topByMonth: OzonTopSku[];
  fetchedAt: Date | null;
  loading: boolean;
  error?: string;
};

const EMPTY: LiveOzonBundle = {
  prices: [],
  products: [],
  stocks: [],
  skuToPid: new Map(),
  topByWeek: [],
  topByMonth: [],
  fetchedAt: null,
  loading: false,
};

// Persistent кэш в localStorage. Идея: при перезагрузке страницы пользователь
// сразу видит вчерашние данные (instant render), а фоном идёт fresh-запрос.
// TTL — 6 часов: дольше нет смысла, цены/остатки на Ozon могут заметно меняться.
const LS_KEY = 'live-ozon-bundle:v1';
const LS_TTL_MS = 6 * 60 * 60_000;

type Serialized = Omit<LiveOzonBundle, 'skuToPid' | 'fetchedAt'> & {
  fetchedAt: string | null;
  skuToPidEntries: [string, number][];
};

function saveToLS(b: LiveOzonBundle) {
  try {
    const ser: Serialized = {
      prices: b.prices,
      products: b.products,
      stocks: b.stocks,
      topByWeek: b.topByWeek,
      topByMonth: b.topByMonth,
      fetchedAt: b.fetchedAt ? b.fetchedAt.toISOString() : null,
      loading: false,
      skuToPidEntries: Array.from(b.skuToPid.entries()),
    };
    localStorage.setItem(LS_KEY, JSON.stringify(ser));
  } catch (e) {
    noteSwallowed('ozon-live-cache', 'справочник товаров не записан', e);
  }
}

function loadFromLS(): LiveOzonBundle | null {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    const ser = JSON.parse(raw) as Serialized;
    const fetchedAt = ser.fetchedAt ? new Date(ser.fetchedAt) : null;
    if (!fetchedAt || Date.now() - fetchedAt.getTime() > LS_TTL_MS) return null;
    return {
      prices: ser.prices,
      products: ser.products,
      stocks: ser.stocks,
      skuToPid: new Map(ser.skuToPidEntries),
      topByWeek: ser.topByWeek,
      topByMonth: ser.topByMonth,
      fetchedAt,
      loading: false,
    };
  } catch { return null; }
}

let cache: LiveOzonBundle = loadFromLS() ?? EMPTY;
let loadPromise: Promise<void> | null = null;
const subs = new Set<(b: LiveOzonBundle) => void>();

function notify() {
  subs.forEach((cb) => cb(cache));
}

async function fetchAll() {
  cache = { ...cache, loading: true, error: undefined };
  notify();
  try {
    const [prices, stocks, top7, top30] = await Promise.all([
      // Все страницы, а не первая сотня: иначе хвост каталога остаётся без цены
      // и комиссии, а значит и без расчёта прибыли.
      ozonProductPricesAll(),
      ozonStocksList(200),
      ozonAnalyticsBySku(7, 200),
      ozonAnalyticsBySku(30, 300),
    ]);
    // product_info_list бьём раз, по уникальным product_id
    const allIds = Array.from(new Set([
      ...prices.map((p) => p.product_id),
      ...stocks.map((s) => s.product_id),
    ]));
    const products = await ozonProductInfoList(allIds);

    const skuToPid = new Map<string, number>();
    for (const s of stocks) {
      for (const stock of s.stocks ?? []) {
        if (stock.sku) skuToPid.set(String(stock.sku), s.product_id);
      }
    }

    cache = {
      prices,
      products,
      stocks,
      skuToPid,
      topByWeek: top7,
      topByMonth: top30,
      fetchedAt: new Date(),
      loading: false,
    };
    saveToLS(cache);
  } catch (e: any) {
    cache = { ...cache, loading: false, error: String(e?.message ?? e) };
  } finally {
    notify();
    loadPromise = null;
  }
}

/** Фоновая предзагрузка при входе в приложение: греем кэш заранее, чтобы
 *  вкладки Ozon открывались мгновенно (просьба клиента 20.07). */
export function prefetchOzonBundle() {
  const STALE_MS = 6 * 60 * 60_000;
  const isStale = !cache.fetchedAt || (Date.now() - cache.fetchedAt.getTime() > STALE_MS);
  if (isStale && !cache.loading) loadPromise ||= fetchAll();
}

export function useLiveOzonBundle(): LiveOzonBundle & { refresh: () => void } {
  const [, force] = useState(0);

  useEffect(() => {
    const cb = () => force((x) => x + 1);
    subs.add(cb);
    // Грузим, если:
    //  - кэша вообще нет (первый заход)
    //  - кэш старше 30 мин (фоновое обновление, UI остаётся со старыми данными)
    // 6 часов: фронт НЕ дёргает API сам, пока данным меньше 6ч.
    // Свежесть обеспечивает cron на сервере (1×/сутки) + ручная кнопка «Обновить».
    const STALE_MS = 6 * 60 * 60_000;
    const isStale = !cache.fetchedAt || (Date.now() - cache.fetchedAt.getTime() > STALE_MS);
    if (isStale && !cache.loading) {
      loadPromise ||= fetchAll();
    }
    return () => { subs.delete(cb); };
  }, []);

  return {
    ...cache,
    refresh: () => {
      loadPromise ||= fetchAll();
    },
  };
}

// Хелперы для готовых индексов:
export function productInfoIndex(b: LiveOzonBundle): Map<number, OzonProductInfo> {
  return new Map(b.products.map((p) => [p.id, p]));
}
