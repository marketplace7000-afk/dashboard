/**
 * Клиент /api/repricer — пороги и предложения по цене.
 *
 * Предложения, а не действия: цены отсюда никуда не отправляются. Экран обязан
 * это проговаривать, пока пороги не согласованы с клиентом.
 */
import { apiGet, apiPost } from './http';

export type Strategy = 'match-min' | 'undercut-min' | 'match-avg';

export type RepricerSettings = {
  mode: 'suggest';
  strategy: Strategy;
  minMarginPct: number;
  undercutRub: number;
  maxStepPct: number;
  minIntervalHours: number;
  stopList: string[];
  confirmedByClient: boolean;
  updatedAt: number;
};

export type Suggestion = {
  sku: string;
  nmId?: number;
  currentPrice: number | null;
  suggestedPrice: number | null;
  floorPrice: number | null;
  marginNow: number | null;
  marginSuggested: number | null;
  market: { min: number | null; avg: number | null; max: number | null; rank: number | null; total: number; vsMinPct: number | null };
  reason: string;
  blocker?: string;
};

export type RepricerReport = {
  ok: boolean;
  settings: RepricerSettings;
  suggestions: Suggestion[];
  skipped: { sku: string; why: string }[];
  generatedAt: number;
};

export async function fetchRepricer(): Promise<RepricerReport> {
  const { data } = await apiGet<RepricerReport>('/api/repricer', { timeoutMs: 60_000 });
  return data;
}

export async function saveRepricerSettings(settings: Partial<RepricerSettings>): Promise<RepricerSettings> {
  const { data } = await apiPost<{ ok: boolean; settings: RepricerSettings }>('/api/repricer', { settings });
  return data.settings;
}
