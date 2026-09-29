/**
 * Учёт реальных трат на Anthropic API.
 *
 * После каждого вызова `callAnthropic` пишем строку в KV/память: дата, агент,
 * модель, токены, рассчитанная цена в ₽. Потом `/api/ai/usage` агрегирует
 * это в дневные/недельные/месячные суммы для UI.
 *
 * Дизайн KV ключей:
 *   ai-usage:list:<YYYY-MM-DD>:<random>   → одна строка лога
 *   ai-usage:agg:<YYYY-MM-DD>             → агрегат за день (для быстрого чтения)
 *
 * TTL логов: 90 дней. Агрегатов: 365 дней.
 */
import { cacheGet, cacheSet, makeCacheKey } from './cache';
import { noteSwallowed } from './log';

/**
 * Тарифы Anthropic в USD за 1 млн токенов, база (вход/выход).
 * Источник: platform.claude.com/docs/en/about-claude/pricing, сверено 26.08.2026.
 *
 * Цены кэша НЕ храним отдельно: Anthropic задаёт их множителями от входной цены,
 * и записанные руками они разъезжаются при каждом изменении прайса. Множители
 * ниже — из той же таблицы.
 *
 * Что было не так раньше: у opus-4-6 и opus-4-7 стояло 15/75 — это цены Opus 4.1
 * и старше. Реальные с Opus 4.5 это 5/25, то есть расход по Opus завышался втрое.
 */
const MODEL_PRICING: Record<string, { in: number; out: number }> = {
  'claude-fable-5':     { in: 10, out: 50 },
  'claude-opus-5':      { in: 5,  out: 25 },
  'claude-opus-4-8':    { in: 5,  out: 25 },
  'claude-opus-4-7':    { in: 5,  out: 25 },
  'claude-opus-4-6':    { in: 5,  out: 25 },
  'claude-opus-4-5':    { in: 5,  out: 25 },
  'claude-sonnet-5':    { in: 2,  out: 10 },
  'claude-sonnet-4-6':  { in: 3,  out: 15 },
  'claude-sonnet-4-5':  { in: 3,  out: 15 },
  'claude-haiku-4-5':   { in: 1,  out: 5  },
};
/** Множители к входной цене: запись в кэш на 5 минут и чтение из кэша. */
const CACHE_WRITE_MULT = 1.25;
const CACHE_READ_MULT = 0.1;
/** Незнакомая модель: считаем по самой дорогой из известных, чтобы не занижать. */
const DEFAULT_PRICING = MODEL_PRICING['claude-fable-5'];

// ─── Курс доллара ───────────────────────────────────────────────────────────
// Раньше курс был прибит константой 90, и рублёвая цифра в кабинете тихо врала
// тем сильнее, чем дальше курс уходил. Берём у ЦБ, обновляем раз в 12 часов.
// Если ЦБ недоступен, работаем на последнем известном и ГОВОРИМ об этом: подпись
// под цифрой должна отличать «курс ЦБ на сегодня» от «курс на прошлой неделе».
const CBR_URL = 'https://www.cbr.ru/scripts/XML_daily.asp';
const FX_TTL_MS = 12 * 60 * 60_000;
const USD_TO_RUB_FALLBACK = 90;

export type FxRate = { rub: number; at: number; source: 'cbr' | 'fallback' };
let fx: FxRate = { rub: USD_TO_RUB_FALLBACK, at: 0, source: 'fallback' };
let fxInFlight: Promise<void> | null = null;

/** Текущий курс, каким считаются рубли. Отдаётся в кабинет вместе с суммой. */
export function getUsdRate(): FxRate {
  if (Date.now() - fx.at > FX_TTL_MS) void refreshUsdRate();   // фоном, не ждём
  return fx;
}

/** Обновить курс у ЦБ. Безопасно звать часто: параллельные вызовы схлопываются. */
export function refreshUsdRate(): Promise<void> {
  if (fxInFlight) return fxInFlight;
  fxInFlight = (async () => {
    try {
      const r = await fetch(CBR_URL, { signal: AbortSignal.timeout(10_000) });
      if (!r.ok) throw new Error(`ЦБ ответил ${r.status}`);
      // XML небольшой и стабильный по форме, отдельный парсер тут был бы лишним.
      const xml = await r.text();
      const block = xml.match(/<Valute[^>]*ID="R01235"[\s\S]*?<\/Valute>/)?.[0];
      const value = block?.match(/<Value>([\d,\.]+)<\/Value>/)?.[1];
      const nominal = Number(block?.match(/<Nominal>(\d+)<\/Nominal>/)?.[1] ?? 1) || 1;
      const rub = Number(String(value ?? '').replace(',', '.')) / nominal;
      if (!Number.isFinite(rub) || rub <= 0) throw new Error('курс не разобран');
      fx = { rub, at: Date.now(), source: 'cbr' };
    } catch (e) {
      // Остаёмся на прошлом значении: пересчитывать по выдуманному курсу хуже,
      // чем показать вчерашний и честно подписать.
      fx = { ...fx, at: Date.now() - FX_TTL_MS + 30 * 60_000 };   // повтор через 30 мин
      noteSwallowed('ai-usage', 'курс ЦБ не получен, считаем по прошлому', e);
    } finally {
      fxInFlight = null;
    }
  })();
  return fxInFlight;
}

export type AiUsageEntry = {
  ts: number;
  agent: string;           // 'card-audit' | 'insights' | 'chat' | ...
  model: string;           // claude-sonnet-4-6
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  costUsd: number;
  costRub: number;
  /** Если был fail (4xx/5xx) — заполняем тут для аналитики. */
  errorStatus?: number;
};

export type DailyAgg = {
  date: string;            // YYYY-MM-DD
  totalRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostRub: number;
  /** Счёт Anthropic выставляется в долларах, и эта цифра не зависит от курса.
   *  Может отсутствовать в старых записях — читать через `?? 0`. */
  totalCostUsd?: number;
  byAgent: Record<string, { requests: number; costRub: number; tokensIn: number; tokensOut: number }>;
  byModel: Record<string, { requests: number; costRub: number; tokensIn: number; tokensOut: number }>;
};

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function priceFor(model: string) {
  // Модель приезжает из env и может быть с датой-снимком (claude-opus-5-20260601)
  // или алиасом. Ищем точное совпадение, потом самый длинный известный префикс.
  if (MODEL_PRICING[model]) return MODEL_PRICING[model];
  const hit = Object.keys(MODEL_PRICING)
    .filter(k => model.startsWith(k))
    .sort((a, b) => b.length - a.length)[0];
  return hit ? MODEL_PRICING[hit] : DEFAULT_PRICING;
}

/** Рассчитать цену одного запроса (в USD и ₽ по текущему курсу). */
export function calcCost(model: string, usage: {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}): { costUsd: number; costRub: number } {
  const p = priceFor(model);
  const m = 1_000_000;
  const costUsd =
    (usage.input_tokens ?? 0)                * p.in                          / m +
    (usage.output_tokens ?? 0)               * p.out                         / m +
    (usage.cache_read_input_tokens ?? 0)     * p.in * CACHE_READ_MULT        / m +
    (usage.cache_creation_input_tokens ?? 0) * p.in * CACHE_WRITE_MULT       / m;
  return { costUsd, costRub: costUsd * getUsdRate().rub };
}

/** Записать одно событие. Тихо игнорируем ошибки записи — учёт не должен ронять запросы. */
export async function logAiUsage(entry: Omit<AiUsageEntry, 'ts'>): Promise<void> {
  const ts = Date.now();
  const date = todayKey();
  const id = `${ts}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    // 1) запись в лог (на случай детального аудита)
    await cacheSet(makeCacheKey('ai-usage:list', date, id), { ts, ...entry }, 90 * 24 * 60 * 60_000);

    // 2) инкрементируем дневной агрегат
    const aggKey = makeCacheKey('ai-usage:agg', date);
    const prev = await cacheGet<DailyAgg>(aggKey);
    const agg: DailyAgg = prev?.data ?? {
      date,
      totalRequests: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCostRub: 0,
      totalCostUsd: 0,
      byAgent: {},
      byModel: {},
    };
    agg.totalRequests += 1;
    agg.totalInputTokens += entry.inputTokens;
    agg.totalOutputTokens += entry.outputTokens;
    agg.totalCostRub += entry.costRub;
    agg.totalCostUsd = (agg.totalCostUsd ?? 0) + entry.costUsd;
    const aSlot = agg.byAgent[entry.agent] ??= { requests: 0, costRub: 0, tokensIn: 0, tokensOut: 0 };
    aSlot.requests += 1;
    aSlot.costRub += entry.costRub;
    aSlot.tokensIn += entry.inputTokens;
    aSlot.tokensOut += entry.outputTokens;
    const mSlot = agg.byModel[entry.model] ??= { requests: 0, costRub: 0, tokensIn: 0, tokensOut: 0 };
    mSlot.requests += 1;
    mSlot.costRub += entry.costRub;
    mSlot.tokensIn += entry.inputTokens;
    mSlot.tokensOut += entry.outputTokens;
    await cacheSet(aggKey, agg, 365 * 24 * 60 * 60_000);
  } catch (e) {
    // Учёт не блокирует основной запрос, но без записи мы бы не узнали, что
    // счётчик трат перестал наполняться, и цифры в кабинете тихо замерли бы.
    noteSwallowed('ai-usage', 'событие расхода не записано', e);
  }
}

/** Прочитать агрегат за конкретный день. */
export async function readDailyAgg(date: string): Promise<DailyAgg | null> {
  const v = await cacheGet<DailyAgg>(makeCacheKey('ai-usage:agg', date));
  return v?.data ?? null;
}

/** Агрегат за N последних дней (today included). */
export async function readRecentAgg(days: number): Promise<DailyAgg[]> {
  const out: DailyAgg[] = [];
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 24 * 60 * 60_000);
    const date = d.toISOString().slice(0, 10);
    const agg = await readDailyAgg(date);
    if (agg) out.push(agg);
    else out.push({ date, totalRequests: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCostRub: 0, totalCostUsd: 0, byAgent: {}, byModel: {} });
  }
  return out;
}

/** Текущий дневной лимит (₽). Может задаваться через env `AI_DAILY_LIMIT_RUB`. */
export function getDailyLimitRub(): number {
  const raw = Number(process.env.AI_DAILY_LIMIT_RUB);
  if (Number.isFinite(raw) && raw > 0) return raw;
  return 500; // дефолт
}
