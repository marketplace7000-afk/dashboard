/**
 * Хук для дашборда: живые данные WB (выручка, заказы, ср. чек).
 *
 * Источник №1: Sales Funnel v3 (`/api/analytics/v3/sales-funnel/products`),
 * пришёл на замену v2 nm-report/detail, который WB отключил 09.12.2025.
 * В нём есть selectedPeriod + previousPeriod из коробки — удобно для дельт.
 *
 * Источник №2 (fallback): supplier/sales + supplier/orders из statistics-api —
 * на случай если Sales Funnel сломается или вернёт 429. У statistics-api есть
 * жёсткий лимит (~1 req/min), но он стабильно работает годами.
 */
import { useState, useEffect } from 'react';
import {
  wbCardsCount, wbNmReportAll, type WbNmReportCard,
  wbSupplierSales, wbSupplierOrders,
} from './marketplaces';
import { mskDate } from '../utils/mskDate';
import { noteSwallowed } from '../utils/log';
import { periodRange, prevPeriodRange, type PeriodKey } from '../utils/period';

// Тип периода общий для всех площадок — держим его в utils/period, а здесь
// ре-экспортируем: на него ссылаются экраны WB.
export type { PeriodKey } from '../utils/period';

export type LiveWbState = {
  loading: boolean;
  error?: string;
  totalProducts: number;
  revenue: number;
  orders: number;
  avgCheck: number;
  prevRevenue: number;
  prevOrders: number;
  source?: 'sales-funnel-v3' | 'supplier-sales-orders';
  /** Если данные из БД (живой WB недоступен) — дата снимка YYYY-MM-DD. */
  staleFrom?: string;
  /**
   * true — на экране ПРОШЛЫЕ цифры: свежий запрос вернул пусто/ошибку, и мы
   * намеренно не стали затирать ими хорошие данные. Показывать без пометки нельзя:
   * молча старое число подрывает доверие сильнее, чем видимый пропуск.
   */
  sticky?: boolean;
  /** Когда показанные цифры реально получены (мс). Для подписи «данные от ЧЧ:ММ». */
  shownAt?: number;
};

const EMPTY: LiveWbState = {
  loading: true,
  totalProducts: 0,
  revenue: 0,
  orders: 0,
  avgCheck: 0,
  prevRevenue: 0,
  prevOrders: 0,
};

// Даты — по Москве (utils/mskDate). Раньше был UTC: с 00:00 до 03:00 МСК окно
// съезжало на сутки назад, а ключ кэша переставал совпадать с прогретым сборщиком.
const isoDate = (back: number) => mskDate(back);

// Длина окна и его арифметика — в utils/period.ts, одной точкой на WB, Ozon и
// финансы: раньше это правило было переписано здесь отдельно, и любая правка
// разводила ключ браузера с ключом сборщика.
function dateRange(period: PeriodKey) {
  const { from, to } = periodRange(period);
  return { begin: from, end: to };
}

// Persistent кэш в localStorage. Открытие страницы → instant render прошлых
// данных + фоновый запрос свежих.
// v2 (09.07.2026): инвалидация застрявших нулевых снимков эпохи, когда WB-прокси
// отдавал 503 из-за отравленного ключа кэша. Старые v1-снимки с revenue:0 держались
// 6ч и показывали нули, хотя данные уже чинились. Бамп версии их сбрасывает.
const LS_KEY = 'live-wb-state:v2';
const LS_TTL_MS = 90 * 60_000;      // persistence cache (localStorage)

function loadAllFromLS(): Record<string, { state: LiveWbState; ts: number }> {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return {};
    const all = JSON.parse(raw) as Record<string, { state: LiveWbState; ts: number }>;
    const out: Record<string, { state: LiveWbState; ts: number }> = {};
    for (const k of Object.keys(all)) {
      if (Date.now() - all[k].ts < LS_TTL_MS) out[k] = all[k];
    }
    return out;
  } catch (e) {
    // Кэш не прочитался — начнём с пустого. Молча это выглядит как «WB опять
    // грузится с нуля каждый раз».
    noteSwallowed('wb-live', 'кэш состояния не прочитан', e);
    return {};
  }
}

function saveAllToLS() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(cache)); }
  catch (e) { noteSwallowed('wb-live', 'кэш состояния не записан', e); }
}

const cache: Record<string, { state: LiveWbState; ts: number }> = loadAllFromLS();
const subs = new Set<() => void>();

// Авто-обновление с фронта: 6 часов. Меньше — нагружаем API без причины.
// Реальная свежесть данных гарантируется cron-ом на сервере (1×/сутки).
const STALE_MS = 6 * 60 * 60_000;

function sumReport(cards: WbNmReportCard[], which: 'selectedPeriod' | 'previousPeriod') {
  let revenue = 0;
  let orders = 0;
  for (const c of cards) {
    const p = c.statistics?.[which];
    if (p) {
      orders += p.ordersCount ?? 0;
      revenue += p.ordersSumRub ?? 0;
    }
  }
  return { revenue, orders };
}

async function loadViaSalesFunnel(period: PeriodKey, force = false): Promise<LiveWbState> {
  const { begin, end } = dateRange(period);
  // Выручка/заказы — из воронки. Если воронка упадёт — пробрасываем ошибку наверх
  // (там откат в statistics). А вот счётчик карточек НЕ должен ронять выручку:
  // раньше Promise.all([cards, funnel]) валил ВЕСЬ расчёт из-за сбоя счётчика →
  // KPI показывал 0, хотя воронка отдавала данные. Тянем cards отдельно и терпимо.
  const report = await wbNmReportAll(begin, end, force);
  let totalCards = 0;
  // Счётчик карточек не критичен для выручки, но его ноль на экране надо уметь
  // объяснить: это сбой счётчика, а не пустой каталог.
  try { totalCards = await wbCardsCount(force); }
  catch (e) { noteSwallowed('wb-live', 'счётчик карточек не получен', e); }
  const cur = sumReport(report, 'selectedPeriod');
  const prev = sumReport(report, 'previousPeriod');
  return {
    loading: false,
    totalProducts: totalCards,
    revenue: cur.revenue,
    orders: cur.orders,
    avgCheck: cur.orders > 0 ? Math.round(cur.revenue / cur.orders) : 0,
    prevRevenue: prev.revenue,
    prevOrders: prev.orders,
    source: 'sales-funnel-v3',
  };
}

async function loadViaStatistics(period: PeriodKey, force = false): Promise<LiveWbState> {
  // Тянем ВСЕГДА широкое окно (30 дней) — один прогретый сборщиком датасет —
  // и фильтруем по выбранному периоду на клиенте. Иначе разные периоды
  // (день/неделя/месяц) промахивались по кэшу и отдавали одно и то же окно.
  const month = dateRange('month').begin;
  const [totalCards, sales, orders] = await Promise.all([
    wbCardsCount(force),
    wbSupplierSales(month, force),
    wbSupplierOrders(month, force),
  ]);
  // ⚠ supplier/sales и supplier/orders WB — это «данные по мотивам».
  // Согласно автору похожей BI-системы (habr/alexgmu51), эти эндпоинты могут
  // терять часть заказов (особенно с постоплатой), погрешность 10-15%.
  // Используем только как fallback когда Sales Funnel v3 упал.

  // Считает выручку/заказы в окне [from, end] + предыдущем равном окне (для %).
  const calcWindow = (fromIso: string) => {
    let revenue = 0;
    for (const s of sales) {
      if ((s.date || '').slice(0, 10) < fromIso) continue;
      const sign = (s.saleID || '').startsWith('R') ? -1 : 1;
      revenue += sign * (s.finishedPrice ?? s.priceWithDisc ?? 0);
    }
    const ordersCount = orders.filter(o => !o.isCancel && (o.date || '').slice(0, 10) >= fromIso).length;
    return { revenue: Math.round(revenue), orders: ordersCount };
  };

  // Окно берём из той же точки, что и основной путь: раньше здесь была своя
  // копия правила, и резервный путь считал другой период, чем воронка — при
  // откате на statistics цифра «прыгала» без видимой причины.
  const curFrom = periodRange(period).from;
  const prevFrom = prevPeriodRange(period).from;
  const cur = calcWindow(curFrom);
  // предыдущий период = [prevFrom, curFrom)
  let prevRevenue = 0, prevOrders = 0;
  for (const s of sales) {
    const d = (s.date || '').slice(0, 10);
    if (d >= prevFrom && d < curFrom) { const sign = (s.saleID || '').startsWith('R') ? -1 : 1; prevRevenue += sign * (s.finishedPrice ?? s.priceWithDisc ?? 0); }
  }
  prevOrders = orders.filter(o => !o.isCancel && (o.date || '').slice(0, 10) >= prevFrom && (o.date || '').slice(0, 10) < curFrom).length;

  return {
    loading: false,
    totalProducts: totalCards,
    revenue: cur.revenue,
    orders: cur.orders,
    avgCheck: cur.orders > 0 ? Math.round(cur.revenue / cur.orders) : 0,
    prevRevenue: Math.round(prevRevenue),
    prevOrders,
    source: 'supplier-sales-orders',
  };
}

async function load(period: PeriodKey, force = false): Promise<LiveWbState> {
  let totalProducts = 0;
  try {
    totalProducts = await wbCardsCount(force);
  } catch (e) {
    // Оставим 0 и попробуем хотя бы выручку/заказы. Ноль товаров при живой
    // выручке — частый вопрос клиента, причина должна быть видна в консоли.
    noteSwallowed('wb-live', 'счётчик товаров не получен', e);
  }

  // ЕДИНСТВЕННЫЙ верный источник «Выручки по заказам» = воронка (ordersSumRub) —
  // это ТА ЖЕ метрика, что «Заказы · Сумма» в ЛК WB (за 7 дней = 2 158 384).
  // supplier/orders (priceWithDisc) давал ДРУГОЕ число (3.6М за неделю) — откатили
  // 23.07. Воронка отдаёт данные по вчера → «сегодня» = последний закрытый день.
  try {
    const state = await loadViaSalesFunnel(period, force);
    return { ...state, totalProducts: state.totalProducts || totalProducts };
  } catch (e: any) {
    // 429 / 5xx / временная недоступность v3 → откатываемся на старый statistics-api.
    // Если и он упадёт — отдаём ошибку наверх.
    try {
      const state = await loadViaStatistics(period, force);
      return { ...state, totalProducts: state.totalProducts || totalProducts };
    } catch (e2: any) {
      // Оба живых источника WB упали (лимит 429). Берём последний снимок из БД,
      // чтобы цифры не «пропадали» — показываем «на дату X» вместо пустоты.
      const hist = await loadFromHistory(totalProducts);
      if (hist) return hist;
      return {
        ...EMPTY,
        loading: false,
        totalProducts,
        error: `${e?.message ?? e} | fallback: ${e2?.message ?? e2}`,
      };
    }
  }
}

/** Fallback на историю из БД (/api/history/latest), когда живой WB недоступен. */
async function loadFromHistory(totalProducts: number): Promise<LiveWbState | null> {
  try {
    const r = await fetch('/api/history/latest');
    if (!r.ok) return null;
    const j = await r.json() as { latest?: { wbRevenue: number | null; wbOrders: number | null; wbProducts: number | null; date: string } };
    const h = j.latest;
    if (!h || h.wbRevenue == null) return null;
    const orders = h.wbOrders ?? 0;
    return {
      loading: false,
      totalProducts: totalProducts || (h.wbProducts ?? 0),
      revenue: h.wbRevenue,
      orders,
      avgCheck: orders > 0 ? Math.round(h.wbRevenue / orders) : 0,
      prevRevenue: 0,
      prevOrders: 0,
      source: 'supplier-sales-orders',
      staleFrom: h.date,
    };
  } catch { return null; }
}

/**
 * Нужен ли перезапрос. Три причины, а не две:
 *  1) данные старше STALE_MS;
 *  2) на экране пусто или ошибка;
 *  3) состояние «липкое» — прошлая попытка провалилась, и мы показываем прошлые
 *     цифры. Без этого пункта сбой замораживал экран на часы: липкий коммит
 *     оставлял непустое состояние, условие перезапроса не срабатывало, и WB
 *     не перепрашивался до истечения шестичасового окна.
 */
function needsReload(c: { state: LiveWbState; ts: number } | undefined): boolean {
  if (!c) return true;
  if (Date.now() - c.ts >= STALE_MS) return true;
  if (c.state.error != null || (c.state.revenue || 0) === 0) return true;
  return !!c.state.sticky;
}

// «Липкий» коммит: НЕ затираем уже показанные ненулевые цифры пустым/ошибочным
// результатом. Раньше при переходе между вкладками фоновый перезапрос, поймавший
// транзиентный сбой (0/ошибка), обнулял хорошие данные — цифры «пропадали».
// Для активного селлера 0 за неделю — почти всегда сбой, а не реальность.
function commit(period: PeriodKey, s: LiveWbState) {
  const prevEntry = cache[period];
  const prev = prevEntry?.state;
  const newEmpty = !s || s.error != null || (s.revenue || 0) === 0;
  const prevGood = !!prev && (prev.revenue || 0) > 0;

  if (newEmpty && prevGood) {
    // Показываем прошлые цифры, но НЕ выдаём их за свежие:
    //  1) sticky/shownAt — интерфейс подписывает, на какой момент число;
    //  2) ts НЕ обновляем. Раньше он ставился в «сейчас», и хук считал данные
    //     свежими: перезапроса не было 6 часов, то есть один транзиентный сбой
    //     замораживал старую цифру на полдня. Сохраняя прежний ts, мы позволяем
    //     следующему заходу сразу попробовать снова.
    const finalState: LiveWbState = {
      ...prev,
      loading: false,
      sticky: true,
      shownAt: prev.shownAt ?? prevEntry?.ts,
    };
    cache[period] = { state: finalState, ts: prevEntry?.ts ?? 0 };
    saveAllToLS();
    subs.forEach((fn) => fn());
    return finalState;
  }

  const finalState: LiveWbState = { ...s, sticky: false, shownAt: Date.now() };
  cache[period] = { state: finalState, ts: Date.now() };
  saveAllToLS();
  subs.forEach((fn) => fn());
  return finalState;
}

/**
 * Принудительно перезапросить данные за период.
 * force=true доходит до сервера заголовком x-av-no-cache: он один раз сходит в WB
 * по этим ключам (не чаще раза в 5 минут на ключ). Это ответ на просьбу клиента
 * сверить сегодняшнюю цифру с кабинетом по требованию, а не ждать сборщика.
 */
export async function refreshLiveWb(period: PeriodKey, force = true) {
  return commit(period, await load(period, force));
}

/** Фоновая предзагрузка периода при входе в приложение (без форса — уважает кэш). */
export function prefetchLiveWb(period: PeriodKey) {
  if (needsReload(cache[period])) load(period).then((s) => commit(period, s));
}

export function useLiveWb(period: PeriodKey = 'day'): LiveWbState {
  // Как Ozon: стартуем СРАЗУ с последних данных из модульного кэша (без лимита
  // «моложе 10 мин»). При переходе между вкладками цифры видны мгновенно и не
  // «пропадают» — фоновое обновление лишь освежит их, если протухли (>6ч).
  const [state, setState] = useState<LiveWbState>(() => cache[period]?.state ?? { ...EMPTY });

  useEffect(() => {
    const update = () => {
      const c = cache[period];
      if (c) setState(c.state);
    };
    subs.add(update);
    const c = cache[period];
    // Сразу показываем значение ТЕКУЩЕГО периода (как в useLiveOzon). Без этого при
    // переключении день/7/30 на экране висело число прошлого периода: эффект менял
    // подпись, но не сумму, если данные нового периода не требовали перезапроса
    // (баг 23.07 — «выручка по заказам не меняется, всегда 196 тыс»).
    setState(c?.state ?? { ...EMPTY });
    // Запрос идёт если: данных нет / они старше 6ч / прошлый снимок был ПУСТОЙ
    // (revenue 0 или ошибка). Последнее важно: транзиентный сбой (503/таймаут) не
    // должен «залипать» нулём на 6 часов — при следующем заходе перепросим.
    if (needsReload(c)) {
      load(period).then((s) => commit(period, s));
    }
    return () => { subs.delete(update); };
  }, [period]);

  return state;
}
