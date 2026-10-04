/**
 * Вызовы Claude для агента 2: учёт расхода раздела + подлимит (раздел 15 ТЗ).
 * Идёт через общий callAnthropic (релей Vercel), там же пишется общий учёт ИИ.
 * Batch API через релей пока не ходит (релей пересылает только /v1/messages) —
 * поэтому сейчас обычный вызов + кэширование промпта; Batch — следующий шаг.
 */
import { callAnthropic } from '../anthropic';
import { addUsage, spendThisMonth, getSettings, rlog } from './db';

/** $ за 1 млн токенов (platform.claude.com/docs/en/about-claude/pricing, 04.10.2026). */
const PRICES: Record<string, { in: number; out: number; cacheRead: number }> = {
  'claude-sonnet-5-5': { in: 2, out: 10, cacheRead: 0.2 },
  'claude-sonnet-5':   { in: 2, out: 10, cacheRead: 0.2 },
  'claude-haiku-4-5':  { in: 1, out: 5,  cacheRead: 0.1 },
  'claude-opus-5-5':   { in: 4, out: 20, cacheRead: 0.2 },
};
const FALLBACK = { in: 10, out: 50, cacheRead: 1 };

export function costOf(model: string, usage: any): number {
  const p = PRICES[model] || FALLBACK;
  const inT = usage?.input_tokens ?? 0;
  const outT = usage?.output_tokens ?? 0;
  const cr = usage?.cache_read_input_tokens ?? 0;
  const cw = usage?.cache_creation_input_tokens ?? 0;
  return (inT * p.in + outT * p.out + cr * p.cacheRead + cw * p.in * 1.25) / 1e6;
}

export class BudgetExceeded extends Error {
  constructor() { super('Подлимит раздела на Claude исчерпан'); }
}

export function budgetState(): { spent: number; limit: number; ratio: number } {
  const s = getSettings();
  const spent = spendThisMonth();
  const limit = s.monthlyBudgetUsd;
  return { spent, limit, ratio: limit > 0 ? spent / limit : 1 };
}

export async function askClaude(purpose: string, opts: {
  model: string; system?: any; messages: any[]; max_tokens: number; temperature?: number;
}): Promise<{ text: string; cost: number; usage: any; stop: string | null }> {
  if (budgetState().ratio >= 1) throw new BudgetExceeded();
  const { text, raw } = await callAnthropic({
    model: opts.model, system: opts.system, messages: opts.messages as any,
    max_tokens: opts.max_tokens, temperature: opts.temperature ?? 0.3, agent: `reviews:${purpose}`,
  });
  const usage = raw?.usage || {};
  const cost = costOf(opts.model, usage);
  // У моделей 5.x часть лимита может уйти на размышления — тогда текст обрезается.
  if (raw?.stop_reason === 'max_tokens') {
    rlog('warn', `Claude упёрся в лимит токенов (${purpose})`, { model: opts.model, max_tokens: opts.max_tokens, out: usage.output_tokens });
  }
  addUsage(purpose, opts.model, {
    in: usage.input_tokens ?? 0, out: usage.output_tokens ?? 0,
    cacheRead: usage.cache_read_input_tokens ?? 0, cacheWrite: usage.cache_creation_input_tokens ?? 0,
  }, cost);
  return { text, cost, usage, stop: raw?.stop_reason ?? null };
}
