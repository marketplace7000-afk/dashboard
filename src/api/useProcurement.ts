import { useEffect, useState, useCallback } from 'react';
import { fetchAllGoogleSheetsData, ProcurementItem } from './googleSheets';
import { applyLogic, getGlobalSettings, GlobalSettings } from '../utils/procurementLogic';
import { noteSwallowed } from '../utils/log';

type State = {
  raw: ProcurementItem[];
  loadedAt: number | null;
  loading: boolean;
  error: string | null;
};

const state: State = { raw: [], loadedAt: null, loading: false, error: null };
const listeners = new Set<() => void>();
let inflight: Promise<void> | null = null;

/**
 * Себестоимость из НАШЕГО справочника (раздел «Себестоимость», /api/costs).
 * Она главнее листа таблицы: лист «Склад» бывает недоступен (11.08 на проде
 * «Лист не найден: Склад»), и тогда ROI считался без себестоимости вовсе.
 * Ключи — артикулы в верхнем регистре.
 */
let costOverrides: Record<string, number> = {};

async function loadCostOverrides(): Promise<void> {
  try {
    const r = await fetch('/api/costs', { credentials: 'include', signal: AbortSignal.timeout(20_000) });
    if (!r.ok) return;                       // нет доступа/сервера — остаёмся на таблице
    const j = await r.json();
    const out: Record<string, number> = {};
    for (const [sku, e] of Object.entries<any>(j?.items ?? {})) {
      if (e?.cost > 0) out[String(sku).trim().toUpperCase()] = e.cost;
    }
    costOverrides = out;
  } catch (e) {
    // Справочник себестоимости необязателен: закупки покажем на данных таблицы.
    // Но именно молчание тут месяц скрывало, что ключ Google не читается.
    noteSwallowed('procurement', 'справочник себестоимости не получен', e);
  }
}

/** Накладывает наши закупочные цены поверх данных таблицы. */
function withOurCosts(items: ProcurementItem[]): ProcurementItem[] {
  if (!Object.keys(costOverrides).length) return items;
  return items.map(p => {
    const own = costOverrides[String((p as any).sku ?? '').trim().toUpperCase()];
    return own ? { ...p, purchasePrice: own } : p;
  });
}

function notify() { listeners.forEach(l => l()); }

// Компактный ROI/маржа-снимок в localStorage — чтобы AI-копилот (collectContext
// в aiChat.ts) видел данные листа «Маржа». Без этого копилот на вопрос про ROI
// честно отвечал «нет данных в контексте», хотя в модуле ROI они есть.
const PROCUREMENT_CTX_KEY = 'procurement-context:v1';
function persistProcurementContext(data: ProcurementItem[]) {
  try {
    const withData = data.filter(p =>
      p.roiOzonMarzha != null || p.roiWbMarzha != null ||
      p.marginOzon != null || p.marginWB != null);
    const items = withData
      .slice()
      .sort((a, b) => ((b.sales7Ozon + b.sales7WB) - (a.sales7Ozon + a.sales7WB)))
      .slice(0, 60)
      .map(p => ({
        sku: p.sku,
        name: p.name,
        roiOzon: p.roiOzonMarzha ?? null,
        roiWb: p.roiWbMarzha ?? null,
        marginOzon: p.marginOzon ?? null,
        marginWb: p.marginWB ?? null,
        cost: p.purchasePrice || null,
        priceOzon: p.lkPriceOzon ?? p.priceOzon ?? null,
        priceWb: p.lkPriceWb ?? p.priceWB ?? null,
        profitWeekOzon: p.profitWeekOzon ?? null,
        profitWeekWb: p.profitWeekWb ?? null,
        sales7Ozon: p.sales7Ozon || 0,
        sales7Wb: p.sales7WB || 0,
      }));
    localStorage.setItem(PROCUREMENT_CTX_KEY, JSON.stringify({ ts: Date.now(), count: withData.length, items }));
  } catch (e) {
    // Снимок для ИИ-контекста не обновится, и копилот будет отвечать по старым
    // цифрам, не сообщая об этом.
    noteSwallowed('procurement', 'снимок для ИИ-контекста не записан', e);
  }
}

async function load(force = false) {
  if (inflight) return inflight;
  if (!force && state.loadedAt && Date.now() - state.loadedAt < 5 * 60_000) return;
  state.loading = true; state.error = null; notify();
  inflight = (async () => {
    try {
      // Справочник тянем параллельно с таблицей: он маленький и не должен
      // задерживать загрузку, но должен успеть к первому расчёту.
      const [data] = await Promise.all([fetchAllGoogleSheetsData(), loadCostOverrides()]);
      state.raw = data;
      state.loadedAt = Date.now();
      persistProcurementContext(data);
    } catch (e: any) {
      state.error = e?.message || 'Ошибка загрузки данных';
    } finally {
      state.loading = false;
      inflight = null;
      notify();
    }
  })();
  return inflight;
}

/** Фоновая предзагрузка закупочной таблицы при входе в приложение. */
export function prefetchProcurement() {
  if (!state.loadedAt && !state.loading) load();
}

export function useProcurement(settings?: GlobalSettings, transitBySku?: Record<string, number>) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const l = () => setTick(t => t + 1);
    listeners.add(l);
    if (!state.loadedAt && !state.loading) load();
    return () => { listeners.delete(l); };
  }, []);

  const reload = useCallback(() => load(true), []);
  const s = settings || getGlobalSettings();
  const raw = withOurCosts(state.raw);
  const processed = raw.length ? applyLogic(raw, s, transitBySku) : [];

  return {
    raw,
    items: processed,
    /** Сколько артикулов закрыто нашим справочником — видно, что он подключён. */
    ownCostsCount: Object.keys(costOverrides).length,
    loading: state.loading,
    error: state.error,
    loadedAt: state.loadedAt,
    reload,
  };
}
