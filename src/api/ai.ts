/**
 * Клиент для /api/ai/* и /api/wb-public/*.
 * Все вызовы Claude идут через серверный прокси — ключ Anthropic в браузер не попадает.
 */
import { noteSwallowed } from '../utils/log';

async function postAi<T>(action: string, body: any, opts?: { noCache?: boolean }): Promise<T> {
  const r = await fetch(`/api/ai/${action}`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(opts?.noCache ? { 'x-av-no-cache': '1' } : {}),
    },
    body: JSON.stringify(body || {}),
  });
  const text = await r.text();
  if (!r.ok) {
    let detail = text.slice(0, 300);
    // Тело ошибки бывает не JSON (HTML от nginx, пустая строка). Тогда detail
    // остаётся сырым текстом, и ошибка всё равно уходит наверх со всем, что было:
    // писать в журнал тут нечего, наверх уже проброшено.
    try { const j = JSON.parse(text); detail = j.detail || j.error || detail; } catch {}
    throw new Error(`AI ${r.status}: ${detail}`);
  }
  return JSON.parse(text) as T;
}

// ─── Аудит карточки (с фото через vision) ────────────────────────────────────
export type CardAuditInput = {
  name?: string;
  description?: string;
  characteristics?: string | Record<string, any>;
  images?: string[];                  // URL фото (до 6)
  reviews?: { rating?: number; text?: string }[];
  price?: number;
  brand?: string;
};
export type CardAuditResult = {
  score?: number;
  strengths?: string[];
  weaknesses?: string[];
  photoIssues?: string[];
  missingContent?: string[];
  reviewProblems?: string[];
  actions?: string[];
  raw?: string;
};
export async function aiCardAudit(input: CardAuditInput, opts?: { noCache?: boolean }) {
  return postAi<{ ok: boolean; audit: CardAuditResult; photosAnalyzed: number }>('card-audit', input, opts);
}

// ─── Дневные инсайты ─────────────────────────────────────────────────────────
export type InsightsInput = {
  period?: string;
  marketplaces?: Record<string, { revenue: number; orders: number; products: number }>;
  topProducts?: Array<{ name: string; revenue?: number; orders?: number; sku?: string | number }>;
  kpis?: Record<string, number | string>;
  notes?: string;
  /** Маркетплейсы которые сейчас в ошибке (API не отвечает или rate-limit). */
  errors?: Record<string, string | undefined>;
};
export type InsightsResult = {
  summary?: string;
  insights?: string[];
  actions?: string[];
  raw?: string;
};
export async function aiInsights(input: InsightsInput, opts?: { noCache?: boolean }) {
  return postAi<{ ok: boolean; insights: InsightsResult }>('insights', input, opts);
}

// ─── Ответ на отзыв ──────────────────────────────────────────────────────────
export async function aiReviewReply(input: { text: string; rating?: number; productName?: string; tone?: string }, opts?: { noCache?: boolean }) {
  return postAi<{ ok: boolean; reply: string }>('review-reply', input, opts);
}

// ─── Обоснование цены ────────────────────────────────────────────────────────
export async function aiPriceReason(input: { sku?: string | number; myPrice: number; marketPrice: number; competitors?: any[] }, opts?: { noCache?: boolean }) {
  return postAi<{ ok: boolean; reason: string }>('price-reason', input, opts);
}

// ─── Сравнение с конкурентами ────────────────────────────────────────────────
export type CompetitorsSummaryResult = {
  position?: string;
  priceGap?: string;
  ratingGap?: string;
  advantages?: string[];
  gaps?: string[];
  actions?: string[];
  raw?: string;
};
export async function aiCompetitorsSummary(input: { query: string; our: any; competitors: any[] }, opts?: { noCache?: boolean }) {
  return postAi<{ ok: boolean; summary: CompetitorsSummaryResult }>('competitors-summary', input, opts);
}

// ─── ИИ-советник по модулям ──────────────────────────────────────────────────
export type AdviceModule = 'roi' | 'prices' | 'promos' | 'distribution' | 'procurement' | 'finance' | 'ads' | 'analytics';
export type AdviceAction = { priority: 'high' | 'medium' | 'low'; text: string; sku?: string };
export type Advice = { verdict: string; actions: AdviceAction[]; warnings: string[]; raw?: string };

export async function aiAdvise(module: AdviceModule, context: any, opts?: { noCache?: boolean }) {
  return postAi<{ ok: boolean; module: string; advice: Advice }>('advise', { module, context }, opts);
}

// ─── Публичный поиск WB (без токена) ────────────────────────────────────────
export type WbPublicItem = {
  id: number;
  name: string;
  brand: string;
  supplier: string;
  rating: number;
  feedbacks: number;
  price: number;
  salePrice: number;
  discount: number;
  image: string;
  link: string;
};
export async function wbPublicSearch(query: string, limit = 12): Promise<{ items: WbPublicItem[]; count: number }> {
  const r = await fetch(`/api/wb-public/search?q=${encodeURIComponent(query)}&limit=${limit}`, { credentials: 'include' });
  const text = await r.text();
  if (!r.ok) {
    let detail = text.slice(0, 300);
    // Тело ошибки бывает не JSON (HTML от nginx, пустая строка). Тогда detail
    // остаётся сырым текстом, и ошибка всё равно уходит наверх со всем, что было:
    // писать в журнал тут нечего, наверх уже проброшено.
    try { const j = JSON.parse(text); detail = j.detail || j.error || detail; } catch {}
    throw new Error(`WB search ${r.status}: ${detail}`);
  }
  const json = JSON.parse(text) as { items: WbPublicItem[]; count: number };
  return { items: json.items || [], count: json.count || 0 };
}

// ─── Полная карточка конкурента WB (все фото + описание + характеристики) ────
export type WbPublicCard = {
  ok: boolean;
  nm: number;
  imtId: number | null;
  name: string;
  brand: string;
  description: string;
  characteristics: { name: string; value: string }[];
  photoCount: number;
  images: string[];
  link: string;
};
export async function wbPublicCard(nm: number): Promise<WbPublicCard> {
  const r = await fetch(`/api/wb-public/card?nm=${nm}`, { credentials: 'include' });
  const text = await r.text();
  if (!r.ok) {
    let detail = text.slice(0, 300);
    // Тело ошибки бывает не JSON (HTML от nginx, пустая строка). Тогда detail
    // остаётся сырым текстом, и ошибка всё равно уходит наверх со всем, что было:
    // писать в журнал тут нечего, наверх уже проброшено.
    try { const j = JSON.parse(text); detail = j.detail || j.error || detail; } catch {}
    throw new Error(`WB card ${r.status}: ${detail}`);
  }
  return JSON.parse(text) as WbPublicCard;
}

// ─── localStorage helper для дневного кэша инсайтов ──────────────────────────
export function todayKey(prefix: string): string {
  const d = new Date();
  return `${prefix}:${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export function loadDaily<T>(prefix: string): T | null {
  try {
    const raw = localStorage.getItem(todayKey(prefix));
    return raw ? JSON.parse(raw) as T : null;
  } catch (e) {
    // Битый JSON в localStorage: вернём null и пересчитаем заново. Молча это
    // выглядит как «совет не сгенерировался», поэтому оставляем след.
    noteSwallowed('ai', 'дневной кэш не прочитан', e);
    return null;
  }
}
export function saveDaily<T>(prefix: string, value: T): void {
  try { localStorage.setItem(todayKey(prefix), JSON.stringify(value)); }
  catch (e) { noteSwallowed('ai', 'дневной кэш не записан', e); }
}
