/**
 * Хук сводных финансов: тянет Ozon (finance/transaction/totals + list)
 * и WB (reportDetailByPeriod), сшивает с себестоимостью из Google-таблицы
 * закупок, возвращает готовый FinanceSummary.
 *
 * Особенности по периодам:
 *  - Ozon отдаёт реальные транзакции за любой день, включая сегодня.
 *  - WB финансовый отчёт о реализации — еженедельный, по понедельникам
 *    закрывается прошлая неделя. За «сегодня» отдельных данных нет — WB
 *    отдаст ближайший закрытый еженедельный отчёт, включающий этот день,
 *    или пустой массив если ещё не сформирован.
 */
import { mskDate, mskDateOf } from '../utils/mskDate';
import { useEffect, useState } from 'react';
import { ozonFinanceTotalsCached, ozonFinanceListCached } from './ozonFinance';
import { ozonSkuToOfferMap } from './marketplaces';
import { wbReportDetail, aggregateWbFinance } from './wbFinance';
import { useProcurement } from './useProcurement';
import {
  buildOzonFinance, buildWbFinance, buildFinanceSummary, FinanceSummary,
} from '../utils/financeLogic';
import { noteSwallowed } from '../utils/log';
import { PERIOD_DAYS, type PeriodKey } from '../utils/period';

// Тот же период, что у выручки и рекламы: отдельный тип-близнец разъезжался бы
// с PeriodKey при добавлении нового окна.
export type FinancePeriod = PeriodKey;

export type FinanceState = {
  loading: boolean;
  error: string | null;
  summary: FinanceSummary | null;
  fetchedAt: number | null;
  warnings: string[];
};

const EMPTY: FinanceState = { loading: false, error: null, summary: null, fetchedAt: null, warnings: [] };

const LS_KEY = 'av_finance_summary_v1';
const STALE_MS = 6 * 60 * 60_000;

type CacheRecord = Partial<Record<FinancePeriod, { state: FinanceState; ts: number }>>;

function loadAllFromLS(): CacheRecord {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return {};
    const all = JSON.parse(raw) as CacheRecord;
    const out: CacheRecord = {};
    for (const k of Object.keys(all) as FinancePeriod[]) {
      const v = all[k];
      if (v && Date.now() - v.ts < STALE_MS) out[k] = v;
    }
    return out;
  } catch (e) {
    // Кэш финансов не прочитался — начнём с пустого и перезапросим.
    noteSwallowed('finance', 'кэш финансов не прочитан', e);
    return {};
  }
}

const cache: CacheRecord = loadAllFromLS();
const subs: Record<FinancePeriod, Set<(s: FinanceState) => void>> = { day: new Set(), week: new Set(), month: new Set() };

function saveLS() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(cache)); }
  catch (e) { noteSwallowed('finance', 'кэш финансов не записан', e); }
}

// Длина периода — из общей точки (utils/period). Своя копия ternary тут уже
// расходилась с WB и Ozon: финансы считались за другое окно, чем выручка рядом.
function dayBack(period: FinancePeriod): number {
  return PERIOD_DAYS[period];
}

// Реальные траты на рекламу WB за период: собираем advertId из promotion/count
// (прогревается cron) и суммируем расход `sum` из adv/v3/fullstats — тот же
// прогретый кэш, что читает раздел «Реклама». cron греет fullstats только для окон
// 7 и 30 дней, поэтому для «Сегодня» расход недоступен → undefined (ДРР WB = «—»).
// best-effort: нет кампаний / не прогрето / 429 → undefined.
async function fetchWbAdSpend(days: number): Promise<number | undefined> {
  const back = days >= 30 ? 30 : days >= 7 ? 7 : 0;
  if (!back) return undefined; // fullstats прогревается только на 7 и 30 дней
  try {
    const { wbGetPromotionCount, wbGetFullStats, daysAgo, today } = await import('./wbAds');
    const cntR = await wbGetPromotionCount();
    const ids: number[] = [];
    for (const g of ((cntR?.data as any)?.adverts || [])) {
      if (g?.status === -1) continue;                       // как cron/фронт: без удалённых
      for (const a of (g?.advert_list || [])) if (typeof a?.advertId === 'number') ids.push(a.advertId);
    }
    if (!ids.length) return undefined;
    // wbGetFullStats сам сортирует ids и строит ключ ровно как cron → попадаем в кэш.
    const stats = await wbGetFullStats(ids, daysAgo(back), today());
    const arr = stats?.data;
    if (!Array.isArray(arr) || !arr.length) return undefined;
    const spend = arr.reduce((s: number, it: any) => s + (Number(it?.sum) || 0), 0);
    return spend > 0 ? spend : undefined;
  } catch {
    return undefined;
  }
}

// Реальные траты на рекламу Ozon Performance (Трафареты / Поиск / Брендовая полка)
// за период. ВАЖНО: эти расходы НЕ попадают в операции Finance API — они в
// отдельном рекламном кабинете (/ozon-perf, OAuth по серверным env-кредам).
// Поэтому без этого вызова Ozon-реклама = 0 и ДРР не подтягивается (жалоба №2).
// best-effort: нет кредов / 401 / не прогрето / нет кампаний → undefined.
async function fetchOzonAdSpend(days: number): Promise<number | undefined> {
  try {
    const { ozonGetDailyExpenses, parseRu, daysAgo, today } = await import('./ozonAds');
    // ВАЖНО: окно дат — теми же helper'ами, что и раздел «Реклама» (чистые UTC-даты
    // daysAgo..today). Раньше финансы считали окно через локальную полночь +
    // toISOString() → дата сдвигалась, расход не подтягивался → «Реклама 0 ₽» в P&L
    // при работающем разделе «Реклама».
    const r = await ozonGetDailyExpenses(daysAgo(days), today());
    const rows = r?.data?.rows ?? [];
    if (!rows.length) return undefined;
    return rows.reduce((s, row) => s + parseRu(row.moneySpent), 0);
  } catch {
    return undefined;
  }
}

// Ozon transaction/list не принимает окно > 1 месяца ("too long period, only one
// month allowed"). Режем длинные окна (30 дней) на куски ≤28 дней и склеиваем
// операции — иначе за 30 дней список падал 400 (баг 23.07).
async function ozonFinanceListChunked(fromISO: string, toISO: string): Promise<any> {
  const from = new Date(fromISO).getTime();
  const to = new Date(toISO).getTime();
  const MAX = 28 * 86_400_000;
  if (to - from <= MAX) return ozonFinanceListCached(fromISO, toISO);
  const operations: any[] = [];
  let cur = from;
  while (cur < to) {
    const chunkTo = Math.min(cur + MAX, to);
    const r = await ozonFinanceListCached(new Date(cur).toISOString(), new Date(chunkTo).toISOString()).catch(() => null);
    const ops = r?.data?.result?.operations;
    if (Array.isArray(ops)) operations.push(...ops);
    cur = chunkTo + 1;
  }
  return { data: { result: { operations } }, fromCache: false, fetchedAt: Date.now() };
}

async function load(period: FinancePeriod, procurement: ReturnType<typeof useProcurement>['items']): Promise<FinanceState> {
  const warnings: string[] = [];
  const days = dayBack(period);
  const now = new Date();
  const from = new Date(now); from.setDate(from.getDate() - days); from.setHours(0, 0, 0, 0);
  const to = new Date(now); to.setHours(23, 59, 59, 999);
  const fromISO = from.toISOString();
  const toISO = to.toISOString();
  // WB финансовый отчёт о реализации — недельный/месячный, за «день» данных нет.
  // Всегда запрашиваем фиксированное МЕСЯЧНОЕ окно, чтобы ключ кэша совпадал с тем,
  // что прогревает cron (режим cron-only: браузер читает только прогретый кэш).
  // Даты — по Москве: из них строится ключ серверного кэша, и он обязан совпасть
  // с тем, что прогрел сборщик (он тоже считает по МСК, см. api/_lib/mskDate).
  const fromDate = mskDate(30);
  const toDate = mskDate(0);

  // Параллельно: Ozon финансы (всегда есть) + WB отчёт (может быть пустым)
  const ozonTotalsP = ozonFinanceTotalsCached(fromISO, toISO).catch(e => {
    warnings.push(`Ozon totals: ${String(e?.message ?? e).slice(0, 120)}`);
    return null;
  });
  const ozonListP = ozonFinanceListChunked(fromISO, toISO).catch(e => {
    warnings.push(`Ozon list: ${String(e?.message ?? e).slice(0, 120)}`);
    return null;
  });
  const wbRowsP = wbReportDetail(fromDate, toDate).catch(e => {
    warnings.push(`WB report: ${String(e?.message ?? e).slice(0, 120)}`);
    return [];
  });
  // Маппинг sku→offer_id для джойна себестоимости Ozon.
  const ozonOfferP = ozonSkuToOfferMap().catch(() => new Map<string, string>());
  // Реальные траты на рекламу WB за то же месячное окно (0.9). best-effort:
  // если промо-API не прогрет/недоступен — вернёт undefined, реклама = 0 + варнинг.
  const wbAdsP = fetchWbAdSpend(days);
  // Траты Ozon Performance за то же окно, что и раздел «Реклама» (daysAgo..today).
  const ozonAdsP = fetchOzonAdSpend(days);

  const [ozonTotalsR, ozonListR, wbRows, ozonOfferMap, wbAdSpend, ozonAdSpend] = await Promise.all([ozonTotalsP, ozonListP, wbRowsP, ozonOfferP, wbAdsP, ozonAdsP]);

  const ozonMp = buildOzonFinance(
    ozonTotalsR?.data ?? null,
    ozonListR?.data?.result?.operations ?? [],
    ozonOfferMap,
  );

  // Добавляем расход Ozon Performance к рекламе из операций (это разные источники:
  // в Finance — промо-акции/маркетинг, в Performance — Трафареты/Поиск). Без этого
  // ДРР по Ozon занижен/нулевой. Если выгрузить не удалось — предупреждаем явно.
  if (ozonAdSpend !== undefined) {
    ozonMp.ads += ozonAdSpend;
  } else {
    // Performance не ответил → полного расхода мы НЕ знаем. Помечаем явно, чтобы
    // интерфейс показал прочерк, а не ДРР, посчитанный по неполной рекламе.
    ozonMp.adsKnown = false;
    if (ozonMp.netRevenue > 0) {
      warnings.push('Реклама Ozon Performance не подтянулась (нет OZON_PERF-кредов, кампаний или не прогрето) — ДРР по Ozon показан прочерком.');
    }
  }

  // WB-отчёт тянем за фиксированное 30-дневное окно (ключ кэша), но РЕЖЕМ строки
  // под выбранный период по дате операции (rr_dt/sale_dt). Иначе WB-часть финсводки
  // всегда была 30-дневной и не реагировала на «7 дней»/«Сегодня» — показывала одно
  // и то же число (баг 23.07: «чистая прибыль WB всегда 5 млн»). ⚠ Отчёт WB
  // недельный: короткие окна приблизительны (текущая неделя ещё не закрыта).
  const periodFrom = mskDateOf(from);
  const wbRowsPeriod = wbRows.filter(r => {
    const rd = (r.rr_dt || r.sale_dt || r.order_dt || r.date_to || '').slice(0, 10);
    return rd !== '' && rd >= periodFrom && rd <= toDate;
  });
  if (period === 'day' && wbRowsPeriod.length === 0) {
    warnings.push('WB финансовый отчёт за сегодня недоступен — отчёт еженедельный, формируется по понедельникам.');
  }
  const wbTotals = wbRowsPeriod.length > 0 ? aggregateWbFinance(wbRowsPeriod) : null;
  const wbMp = buildWbFinance(wbTotals, wbAdSpend);

  const summary = buildFinanceSummary(ozonMp, wbMp, procurement);

  if (summary.skusWithoutCost.length > 0) {
    warnings.push(`Себестоимости нет для ${summary.skusWithoutCost.length} SKU — добавьте в Google-таблицу закупок для точного расчёта прибыли.`);
  }

  return {
    loading: false,
    error: null,
    summary,
    fetchedAt: Date.now(),
    warnings,
  };
}

export function useFinanceSummary(period: FinancePeriod = 'week'): FinanceState & { refresh: () => void } {
  const procurement = useProcurement();
  const [state, setState] = useState<FinanceState>(() => cache[period]?.state ?? EMPTY);

  useEffect(() => {
    subs[period].add(setState);
    const c = cache[period];
    if (c) setState(c.state);
    if (!c) {
      // Первая загрузка: ждём пока procurement подтянется (иначе себестоимости не будет)
      if (procurement.items.length > 0) {
        setState(s => ({ ...s, loading: true }));
        load(period, procurement.items).then(next => {
          cache[period] = { state: next, ts: Date.now() };
          saveLS();
          subs[period].forEach(l => l(next));
        });
      }
    }
    return () => { subs[period].delete(setState); };
  }, [period, procurement.items.length]);

  const refresh = () => {
    setState(s => ({ ...s, loading: true }));
    // Обновляем ВСЕ периоды разом (день/7/30), а не только текущий — чтобы не жать
    // «Обновить» на каждой вкладке отдельно (жалоба 23.07).
    (['day', 'week', 'month'] as FinancePeriod[]).forEach(p => {
      load(p, procurement.items).then(next => {
        cache[p] = { state: next, ts: Date.now() };
        saveLS();
        subs[p].forEach(l => l(next));
      });
    });
  };

  return { ...state, refresh };
}
