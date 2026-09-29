/**
 * Центральный кэш для WB-компонентов (цены, карточки).
 * Аналог useLiveOzonCache.ts — module-scope singleton + pub/sub.
 */
import { useState, useEffect } from 'react';
import { wbPrices, wbCardsList, type WbPriceRow, type WbCard } from './marketplaces';
import { noteSwallowed } from '../utils/log';

export type LiveWbBundle = {
  prices: WbPriceRow[];
  cards: WbCard[];
  fetchedAt: Date | null;
  loading: boolean;
  error?: string;
};

// Persistent кэш в localStorage. Открытие страницы «Цены» показывает
// прошлые данные мгновенно, фоном идёт fresh-запрос. TTL 6 часов.
// v2: строки прайса теперь с нормализованным nmId (было поле nmID) — старый
// кэш без nmId невалиден, поэтому бампаем ключ, чтобы браузер перезагрузил.
const LS_KEY = 'live-wb-bundle:v2';
const LS_TTL_MS = 6 * 60 * 60_000;
// 6 часов: фронт НЕ дёргает API пока данным меньше 6ч.
// Свежесть гарантирует cron + ручная кнопка «Обновить».
const STALE_MS = 6 * 60 * 60_000;

type Serialized = { prices: WbPriceRow[]; cards: WbCard[]; fetchedAt: string | null };

function saveToLS() {
  try {
    const ser: Serialized = {
      prices: bundle.prices,
      cards: bundle.cards,
      fetchedAt: bundle.fetchedAt ? bundle.fetchedAt.toISOString() : null,
    };
    localStorage.setItem(LS_KEY, JSON.stringify(ser));
  } catch (e) {
    noteSwallowed('wb-live-cache', 'цены и карточки не записаны', e);
  }
}

function loadFromLS(): LiveWbBundle | null {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    const ser = JSON.parse(raw) as Serialized;
    const fetchedAt = ser.fetchedAt ? new Date(ser.fetchedAt) : null;
    if (!fetchedAt || Date.now() - fetchedAt.getTime() > LS_TTL_MS) return null;
    return { prices: ser.prices, cards: ser.cards, fetchedAt, loading: false };
  } catch { return null; }
}

let bundle: LiveWbBundle = loadFromLS() ?? { prices: [], cards: [], fetchedAt: null, loading: false };
let fetching = false;
const subs = new Set<() => void>();

function notify() { subs.forEach((fn) => fn()); }

async function fetchAll() {
  if (fetching) return;
  fetching = true;
  // Не очищаем prices/cards — оставляем прошлые на экране пока грузим фон.
  // loading=true ставим только если данных вообще нет (первый заход).
  const hadData = !!bundle.fetchedAt;
  if (!hadData) {
    bundle = { ...bundle, loading: true, error: undefined };
    notify();
  } else {
    bundle = { ...bundle, error: undefined };
  }

  try {
    const [pricesResult, cardsResult] = await Promise.allSettled([
      wbPrices(1000),
      wbCardsList(100),
    ]);

    const errorParts: string[] = [];
    const nextBundle: LiveWbBundle = { ...bundle, loading: false };

    if (pricesResult.status === 'fulfilled') {
      nextBundle.prices = pricesResult.value;
    } else {
      errorParts.push(`prices: ${String(pricesResult.reason?.message ?? pricesResult.reason ?? 'failed')}`);
    }

    if (cardsResult.status === 'fulfilled') {
      nextBundle.cards = cardsResult.value.cards;
    } else {
      errorParts.push(`cards: ${String(cardsResult.reason?.message ?? cardsResult.reason ?? 'failed')}`);
    }

    if (pricesResult.status === 'fulfilled' || cardsResult.status === 'fulfilled') {
      nextBundle.fetchedAt = new Date();
      nextBundle.error = errorParts.length ? errorParts.join(' | ') : undefined;
      saveToLS();
    } else {
      nextBundle.error = errorParts.join(' | ') || 'WB: no data';
    }

    bundle = nextBundle;
  } catch (e: any) {
    bundle = { ...bundle, loading: false, error: e?.message ?? String(e) };
  } finally {
    fetching = false;
    notify();
  }
}

/** Фоновая предзагрузка при входе в приложение: греем кэш заранее, чтобы
 *  вкладка «Цены» открывалась мгновенно (просьба клиента 20.07). */
export function prefetchWbBundle() {
  const isStale = !bundle.fetchedAt || (Date.now() - bundle.fetchedAt.getTime() > STALE_MS);
  if (isStale && !fetching) fetchAll();
}

export function useLiveWbBundle(): LiveWbBundle & { refresh: () => void } {
  const [, tick] = useState(0);

  useEffect(() => {
    const update = () => tick((n) => n + 1);
    subs.add(update);

    // Грузим если: нет данных вообще, или они старше 30 минут (фоновое обновление)
    const isStale = !bundle.fetchedAt || (Date.now() - bundle.fetchedAt.getTime() > STALE_MS);
    if (isStale && !fetching) fetchAll();

    return () => { subs.delete(update); };
  }, []);

  return { ...bundle, refresh: fetchAll };
}

/** Map nmId → WbCard для обогащения строк прайсинга */
export function wbCardIndex(b: LiveWbBundle): Map<number, WbCard> {
  const m = new Map<number, WbCard>();
  for (const c of b.cards) m.set(c.nmID, c);
  return m;
}
