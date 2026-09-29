/**
 * Серверный helper для Anthropic API.
 * Ключ — только в env (ANTHROPIC_API_KEY), никогда не попадает в браузер.
 *
 * Используется из api/route.ts (секция /api/ai/*).
 */

import { logAiUsage, calcCost } from './aiUsage';

// Anthropic гео-блокирует РФ-IP (403 "Request not allowed"). На московском
// сервере вызываем не напрямую, а через релей на не-РФ хосте (наш Vercel):
//   ANTHROPIC_PROXY_URL = https://<app>.vercel.app/api/anthropic-relay
//   RELAY_SECRET        = общий секрет (валидируется релеем)
// Если ANTHROPIC_PROXY_URL не задан — бьём в Anthropic напрямую (локалка/Vercel).
const ANTHROPIC_DIRECT_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_PROXY_URL = (process.env.ANTHROPIC_PROXY_URL || '').trim();
const ANTHROPIC_URL = ANTHROPIC_PROXY_URL || ANTHROPIC_DIRECT_URL;
// На аккаунте проверены и работают: claude-sonnet-4-5, claude-sonnet-4-6,
// claude-opus-4-6, claude-opus-4-7. По умолчанию используем 4-6 (новейший Sonnet,
// в 5× дешевле Opus).
//
// ⚠ Если в env лежит мусор типа "# claude-sonnet-4-6" (так Vercel записывает
// значения с # как часть значения, а не комментарий) — Anthropic вернёт 404
// "model: # claude-sonnet-4-6". Поэтому жёстко санитизируем: убираем '#' и пробелы.
function sanitizeModel(raw: string | undefined): string {
  if (!raw) return '';
  return raw.replace(/^#+\s*/, '').replace(/\s+/g, '').trim();
}
const DEFAULT_MODEL = sanitizeModel(process.env.ANTHROPIC_DEFAULT_MODEL) || 'claude-sonnet-4-6';

export type ImageBlock = {
  type: 'image';
  source: { type: 'base64'; media_type: string; data: string }
        | { type: 'url'; url: string };
};
export type TextBlock = { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } };
export type ContentBlock = TextBlock | ImageBlock;

export type Message = {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
};

export type AnthropicOptions = {
  model?: string;
  system?: string | TextBlock[];
  messages: Message[];
  max_tokens?: number;
  temperature?: number;
  /** Метка агента для учёта трат (card-audit, insights, chat, и т.д.). */
  agent?: string;
};

export class AnthropicError extends Error {
  status: number;
  body: string;
  constructor(status: number, body: string) {
    super(`Anthropic ${status}: ${body.slice(0, 300)}`);
    this.status = status;
    this.body = body;
  }
}

export async function callAnthropic(opts: AnthropicOptions): Promise<{ text: string; raw: any }> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new AnthropicError(503, 'ANTHROPIC_API_KEY not configured');

  const body = {
    model: opts.model || DEFAULT_MODEL,
    max_tokens: opts.max_tokens ?? 1024,
    temperature: opts.temperature ?? 0.4,
    ...(opts.system ? { system: opts.system } : {}),
    messages: opts.messages,
  };

  const modelUsed = body.model;
  // Через релей ключ не шлём (его подставит релей на стороне Vercel), вместо
  // него — общий секрет. Напрямую — обычный x-api-key.
  const headers: Record<string, string> = {
    'anthropic-version': '2023-06-01',
    'content-type': 'application/json',
  };
  if (ANTHROPIC_PROXY_URL) headers['x-relay-secret'] = (process.env.RELAY_SECRET || '').trim();
  else headers['x-api-key'] = apiKey;

  const r = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  const text = await r.text();
  if (!r.ok) {
    // Логируем неудачный вызов с нулевыми токенами (для отслеживания ошибок).
    logAiUsage({
      agent: opts.agent || 'unknown',
      model: modelUsed,
      inputTokens: 0, outputTokens: 0,
      cacheReadTokens: 0, cacheCreateTokens: 0,
      costUsd: 0, costRub: 0,
      errorStatus: r.status,
    });
    throw new AnthropicError(r.status, text);
  }

  let json: any;
  try { json = JSON.parse(text); } catch { throw new AnthropicError(500, text); }

  const blocks = Array.isArray(json?.content) ? json.content : [];
  const out = blocks
    .filter((b: any) => b?.type === 'text')
    .map((b: any) => b.text as string)
    .join('\n')
    .trim();

  // Учёт трат
  const usage = json?.usage || {};
  const { costUsd, costRub } = calcCost(modelUsed, usage);
  logAiUsage({
    agent: opts.agent || 'unknown',
    model: modelUsed,
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheCreateTokens: usage.cache_creation_input_tokens ?? 0,
    costUsd, costRub,
  });

  return { text: out, raw: json };
}

// ─── Живая проверка ключа ───────────────────────────────────────────────────
// «Ключ задан в env» и «ключом можно пользоваться» — разные вещи, и клиента
// волнует вторая. Кончившиеся кредиты выглядят как 400 у каждого ИИ-блока, и без
// отдельной проверки это неотличимо от поломки платформы.
//
// Остатка кредитов у Anthropic по API нет вообще: есть отчёты о РАСХОДЕ
// (/v1/organizations/cost_report), они требуют отдельный admin-ключ и организацию,
// а для индивидуального аккаунта Admin API недоступен. Поэтому честный максимум —
// «ключ работает / кредиты кончились», а остаток смотрят в консоли Anthropic.

export type AiKeyState = 'ok' | 'no_credit' | 'invalid_key' | 'not_configured' | 'unreachable';
export type AiKeyStatus = {
  state: AiKeyState;
  /** Человеческая строка для кабинета: что именно не так и что делать. */
  detail: string;
  model: string;
  checkedAt: number;
};

const PING_TTL_MS = 10 * 60_000;
let lastPing: AiKeyStatus | null = null;
let pingInFlight: Promise<AiKeyStatus> | null = null;

function classify(status: number, body: string): { state: AiKeyState; detail: string } {
  const low = body.toLowerCase();
  // Формулировка Anthropic: «Your credit balance is too low to access the API».
  if (status === 400 && /credit balance|insufficient|too low/.test(low)) {
    return { state: 'no_credit', detail: 'Кредиты Anthropic закончились. Пополните баланс на console.anthropic.com — платформа подхватит сама.' };
  }
  if (status === 401 || status === 403) {
    return { state: 'invalid_key', detail: `Ключ Anthropic не принят (${status}). Нужен новый ключ в .env на сервере.` };
  }
  // Лимит запросов означает, что ключ рабочий: просто сейчас частим.
  if (status === 429) return { state: 'ok', detail: 'Ключ работает, сейчас упёрлись в лимит запросов.' };
  if (status >= 500) return { state: 'unreachable', detail: `Anthropic отвечает ${status}. Это на их стороне, ключ ни при чём.` };
  return { state: 'unreachable', detail: `Неожиданный ответ ${status}: ${body.slice(0, 120)}` };
}

/**
 * Проверить ключ самым дешёвым запросом: одна модель, один токен на выходе.
 * Результат держим 10 минут — статус меняется редко, а кабинет опрашивает часто.
 */
export async function pingAnthropic(force = false): Promise<AiKeyStatus> {
  if (!force && lastPing && Date.now() - lastPing.checkedAt < PING_TTL_MS) return lastPing;
  if (pingInFlight) return pingInFlight;

  pingInFlight = (async (): Promise<AiKeyStatus> => {
    const model = DEFAULT_MODEL;
    const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim();
    if (!apiKey) {
      return { state: 'not_configured', detail: 'Ключ Anthropic не задан на сервере (ANTHROPIC_API_KEY).', model, checkedAt: Date.now() };
    }
    const headers: Record<string, string> = {
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    };
    if (ANTHROPIC_PROXY_URL) headers['x-relay-secret'] = (process.env.RELAY_SECRET || '').trim();
    else headers['x-api-key'] = apiKey;

    try {
      const r = await fetch(ANTHROPIC_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: '.' }] }),
        signal: AbortSignal.timeout(20_000),
      });
      const text = await r.text();
      const res: AiKeyStatus = r.ok
        ? { state: 'ok', detail: 'Ключ работает, кредиты есть.', model, checkedAt: Date.now() }
        : { ...classify(r.status, text), model, checkedAt: Date.now() };
      lastPing = res;
      return res;
    } catch (e) {
      // Сюда попадаем, если недоступен сам релей на Vercel: с московского адреса
      // Anthropic отвечает 403 напрямую, поэтому вызовы идут через него.
      const res: AiKeyStatus = {
        state: 'unreachable',
        detail: `Не достучались до Anthropic: ${(e as Error)?.message ?? e}.` +
          (ANTHROPIC_PROXY_URL ? ' Вызовы идут через релей — проверьте, что он жив.' : ''),
        model, checkedAt: Date.now(),
      };
      lastPing = res;
      return res;
    } finally {
      pingInFlight = null;
    }
  })();
  return pingInFlight;
}

/** Скачивает картинку и возвращает base64 + media_type. Нужно для vision-запросов. */
export async function fetchImageAsBase64(url: string): Promise<{ data: string; media_type: string } | null> {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 AutoVibe' } });
    if (!r.ok) return null;
    const ct = (r.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
    if (!ct.startsWith('image/')) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    // Anthropic ограничение: ≤5 МБ на картинку
    if (buf.length > 4.5 * 1024 * 1024) return null;
    return { data: buf.toString('base64'), media_type: ct };
  } catch { return null; }
}

/** Достаёт первый JSON-объект из текста ответа (Claude иногда оборачивает в ```json). */
export function extractJson<T = any>(text: string): T | null {
  if (!text) return null;
  const cleaned = text.replace(/```json\s*|\s*```/g, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end < 0 || end < start) return null;
  try { return JSON.parse(cleaned.slice(start, end + 1)) as T; } catch { return null; }
}
