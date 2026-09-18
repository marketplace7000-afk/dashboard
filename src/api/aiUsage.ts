/**
 * Клиент для /api/ai/usage — реальная статистика трат на Claude.
 */

export type DailyAgg = {
  date: string;
  totalRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostRub: number;
  totalCostUsd?: number;
  byAgent: Record<string, { requests: number; costRub: number; tokensIn: number; tokensOut: number }>;
  byModel: Record<string, { requests: number; costRub: number; tokensIn: number; tokensOut: number }>;
};

export type UsageResponse = {
  ok: boolean;
  limitRub: number;
  today: DailyAgg | null;
  days: DailyAgg[];
  totalRub: number;
  /** Счёт Anthropic в долларах: не зависит от курса и не меняется задним числом. */
  totalUsd?: number;
  totalRequests: number;
  /** Каким курсом посчитаны рубли и откуда он взят. */
  fx?: { rub: number; source: 'cbr' | 'fallback'; at: number };
};

/** Ответ /api/ai/health — живой статус ключа, а не «прописан ли он в env». */
export type AiHealth = {
  ok: boolean;
  configured: boolean;
  state: 'ok' | 'no_credit' | 'invalid_key' | 'not_configured' | 'unreachable';
  detail: string;
  model: string | null;
  checkedAt: number;
  consoleUrl: string;
};

let cached: { data: UsageResponse; ts: number } | null = null;
const subs = new Set<(r: UsageResponse) => void>();
const CACHE_MS = 60_000;

export async function fetchAiUsage(days = 7, force = false): Promise<UsageResponse | null> {
  if (!force && cached && Date.now() - cached.ts < CACHE_MS) return cached.data;
  try {
    const r = await fetch(`/api/ai/usage?days=${days}`, { credentials: 'include' });
    if (!r.ok) return cached?.data ?? null;
    const data = await r.json() as UsageResponse;
    cached = { data, ts: Date.now() };
    subs.forEach(cb => cb(data));
    return data;
  } catch { return cached?.data ?? null; }
}

export function subscribeAiUsage(cb: (r: UsageResponse) => void): () => void {
  subs.add(cb);
  if (cached) cb(cached.data);
  return () => subs.delete(cb);
}
