import { useEffect, useState } from 'react';
import { apiGet, errText } from './http';

/**
 * Побочные серверные ресурсы страницы цен (цена покупателя, реклама по SKU,
 * экономика карточек, тарифы). Раньше каждый такой ресурс грузился одноразовым
 * useEffect без возможности перезапросить: кнопка «Обновить» дёргала только
 * основной бандл и Google-таблицу, а цены оставались из кэша — отсюда жалоба
 * клиента 05.08 «даже после кнопки обновить цена не обновлялась».
 *
 * Здесь ресурс живёт в module-scope (переключение вкладок не перезапрашивает)
 * и умеет ФОРС-обновление: заголовок `x-av-no-cache: 1`, который сервер уже
 * понимает (см. api/route.ts) и идёт мимо своего кэша в площадку.
 */

export type SideState<T> = {
  data: T | null;
  /** Когда данные реально пришли к нам в браузер. */
  fetchedAt: number | null;
  loading: boolean;
  error?: string;
};

export type SideResource<T> = SideState<T> & {
  /** force = true → серверу уходит x-av-no-cache и он перезапрашивает площадку. */
  refresh: (force?: boolean) => Promise<void>;
};

/** Сколько данные считаются свежими при обычном (не форс) заходе. */
const STALE_MS = 30 * 60_000;

export function createSideResource<T>(url: string) {
  let state: SideState<T> = { data: null, fetchedAt: null, loading: false };
  const subs = new Set<() => void>();
  let inflight: Promise<void> | null = null;

  const notify = () => subs.forEach(cb => cb());

  async function load(force: boolean): Promise<void> {
    // Обычные заходы дедуплицируем, форс — всегда живой запрос: пользователь
    // нажал кнопку и ждёт свежую цифру, отдавать ему текущий полёт нечестно.
    if (inflight && !force) return inflight;
    state = { ...state, loading: true, error: undefined };
    notify();
    const run = (async () => {
      try {
        // Через общий клиент: таймаут, куки и заголовок принудительного
        // обновления заданы там один раз для всего фронта.
        const { data } = await apiGet<T>(url, { force });
        state = { data, fetchedAt: Date.now(), loading: false };
      } catch (e) {
        // Данные оставляем прежние: лучше показать вчерашнюю цену, чем пустоту.
        state = { ...state, loading: false, error: errText(e) };
      } finally {
        notify();
      }
    })();
    inflight = run.finally(() => { inflight = null; });
    return inflight;
  }

  return {
    refresh: (force = false) => load(force),

    /** Хук: подписка + автозагрузка, если данных нет или они протухли. */
    use(): SideResource<T> {
      const [, force] = useState(0);
      useEffect(() => {
        const cb = () => force(x => x + 1);
        subs.add(cb);
        const stale = !state.fetchedAt || Date.now() - state.fetchedAt > STALE_MS;
        if (stale && !state.loading) void load(false);
        return () => { subs.delete(cb); };
      }, []);
      return { ...state, refresh: (f = false) => load(f) };
    },
  };
}

/** «14:32» — для подписи «цены обновлены в …». */
export function fmtClock(ts: number | null | undefined): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

/** «15.09.2026, 18:32» — дата и время последнего реального обновления данных (для показа свежести цены покупателя). */
export function fmtDateClock(ts: number | null | undefined): string {
  if (!ts) return 'ещё не обновлялось';
  return new Date(ts).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
