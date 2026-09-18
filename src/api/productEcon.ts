/**
 * Клиент /api/product-econ — экономика товара по артикулу.
 *
 * Это ГЛАВНЫЙ источник входных данных для расчёта прибыли на экранах цен.
 * Важное свойство, ради которого он и появился: неизвестное значение приходит
 * как `null` с причиной, а не как правдоподобный дефолт. Экран обязан это
 * показывать — по таким цифрам принимают решения о закупке.
 */
import { apiGet, apiPost } from './http';

export type Origin =
  | 'reference' | 'marketplace' | 'tariffs' | 'client-table'
  | 'ads-report' | 'no-ads' | 'none';

export type Val = { value: number | null; origin: Origin; note?: string };

export type ProductEcon = {
  sku: string;
  nmId?: number;
  cost: Val;
  drr: Val;
  commissionPct: Val;
  logisticRub: Val;
  storageRub: Val;
};

export type Fulfilment = 'fbs' | 'fbo';

export type EconReport = {
  ok: boolean;
  fulfilment: { wb: Fulfilment; ozon: Fulfilment };
  wb: Record<string, ProductEcon>;
  ozon: Record<string, ProductEcon>;
  diagnostics: string[];
  generatedAt: number;
};

export type AppSettings = {
  wbFulfilment: Fulfilment;
  ozonFulfilment: Fulfilment;
  updatedAt: number;
};

export async function fetchProductEcon(days = 7): Promise<EconReport> {
  const { data } = await apiGet<EconReport>(`/api/product-econ?days=${days}`, { timeoutMs: 60_000 });
  return data;
}

export async function fetchAppSettings(): Promise<AppSettings> {
  const { data } = await apiGet<{ ok: boolean; settings: AppSettings }>('/api/settings');
  return data.settings;
}

export async function saveAppSettings(settings: Partial<AppSettings>): Promise<AppSettings> {
  const { data } = await apiPost<{ ok: boolean; settings: AppSettings }>('/api/settings', { settings });
  return data.settings;
}

/** Человеческая подпись под цифрой: откуда она и можно ли ей верить. */
export function originLabel(v: Val | undefined): string {
  if (!v) return '';
  switch (v.origin) {
    case 'reference': return v.note ?? 'из справочника';
    case 'tariffs': return v.note ? `тарифы площадки · ${v.note}` : 'тарифы площадки';
    case 'client-table': return 'из таблицы клиента';
    case 'marketplace': return 'из API площадки';
    case 'ads-report': return 'факт по рекламе';
    case 'no-ads': return v.note ?? 'рекламы не было';
    case 'none': return v.note ?? 'нет данных';
  }
}
