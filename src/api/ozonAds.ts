// Ozon Performance API клиент: ходит через наш backend proxy /ozon-perf/*.
// OAuth (client_credentials → Bearer) делает СЕРВЕР: подставляет креды из env,
// кэширует токен в Vercel KV. Фронт просто зовёт нужные эндпоинты.
//
// Кэш на сервере: 30 минут. Локальный browser-cache добавляет мгновенный UI
// между навигациями страниц.

import { mskDateOf } from '../utils/mskDate';
import { noteSwallowed } from '../utils/log';

const LS_CLIENT_ID = 'av_ozon_perf_client_id';
const LS_CLIENT_SECRET = 'av_ozon_perf_client_secret';
const LS_CACHE_PREFIX = 'av_ozon_perf_cache_';

const PROXY_BASE = '/ozon-perf';

// ─── Credentials (опционально, по умолчанию используется env на сервере) ──
export function getOzonPerfCreds(): { clientId: string | null; clientSecret: string | null } {
  return {
    clientId: localStorage.getItem(LS_CLIENT_ID),
    clientSecret: localStorage.getItem(LS_CLIENT_SECRET),
  };
}

export function setOzonPerfCreds(clientId: string | null, clientSecret: string | null) {
  if (clientId) localStorage.setItem(LS_CLIENT_ID, clientId);
  else localStorage.removeItem(LS_CLIENT_ID);
  if (clientSecret) localStorage.setItem(LS_CLIENT_SECRET, clientSecret);
  else localStorage.removeItem(LS_CLIENT_SECRET);
}

export function hasOzonPerfCreds(): boolean {
  const { clientId, clientSecret } = getOzonPerfCreds();
  return !!(clientId && clientSecret);
}

// ─── Token ──────────────────────────────────────────────────────────────────
export class OzonPerfAuthError extends Error {
  constructor(message: string) { super(message); this.name = 'OzonPerfAuthError'; }
}

// ─── Универсальный fetch ───────────────────────────────────────────────
// OAuth полностью на сервере — фронт просто ходит на /ozon-perf/api/client/*.
// Если у клиента в localStorage есть свои Client-Id/Secret (например, для
// мульти-кабинетного режима в будущем) — пробрасываем через спец-заголовки.
export async function ozonPerfFetch<T = any>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  // Опционально: если у юзера есть свои креды в Настройках — пробросим, бэк подставит
  const { clientId, clientSecret } = getOzonPerfCreds();
  if (clientId) headers.set('X-Ozon-Perf-Client-Id', clientId);
  if (clientSecret) headers.set('X-Ozon-Perf-Client-Secret', clientSecret);
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');

  const res = await fetch(PROXY_BASE + path, { ...init, headers });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    if (res.status === 401 || res.status === 403) {
      throw new OzonPerfAuthError(`Ozon Performance ${res.status}: ${text.slice(0, 240)}`);
    }
    throw new Error(`Ozon Performance ${res.status}: ${text.slice(0, 240)}`);
  }
  const ct = res.headers.get('content-type') || '';
  return (ct.includes('application/json') ? res.json() : res.text()) as Promise<T>;
}

// ─── localStorage TTL-кэш ─────────────────────────────────────────────────
type CachedResp<T> = { data: T; fetchedAt: number; ttlMs: number };

function cacheKey(path: string, init?: RequestInit): string {
  const method = init?.method || 'GET';
  const body = typeof init?.body === 'string' ? init.body : '';
  return LS_CACHE_PREFIX + method + ':' + path + (body ? ':' + body.slice(0, 100) : '');
}

export function readOzonPerfCache<T = any>(path: string, init?: RequestInit): CachedResp<T> | null {
  try {
    const raw = localStorage.getItem(cacheKey(path, init));
    if (!raw) return null;
    return JSON.parse(raw) as CachedResp<T>;
  } catch { return null; }
}

export function clearOzonPerfCache() {
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const k = localStorage.key(i);
    if (k && k.startsWith(LS_CACHE_PREFIX)) localStorage.removeItem(k);
  }
}

export async function ozonPerfFetchCached<T = any>(
  path: string,
  opts: { ttlMs?: number; force?: boolean; init?: RequestInit } = {},
): Promise<{ data: T; fromCache: boolean; fetchedAt: number }> {
  const ttlMs = opts.ttlMs ?? 30 * 60_000;
  const init = opts.init;
  const cached = readOzonPerfCache<T>(path, init);
  if (!opts.force && cached && Date.now() - cached.fetchedAt < cached.ttlMs) {
    return { data: cached.data, fromCache: true, fetchedAt: cached.fetchedAt };
  }
  const data = await ozonPerfFetch<T>(path, init);
  const payload: CachedResp<T> = { data, fetchedAt: Date.now(), ttlMs };
  // Переполнение localStorage: ответ отдадим, но кэш молча перестанет работать,
  // и каждый заход будет заново дёргать API Ozon.
  try { localStorage.setItem(cacheKey(path, init), JSON.stringify(payload)); }
  catch (e) { noteSwallowed('ozon-ads', 'ответ не закэширован', e); }
  return { data, fromCache: false, fetchedAt: payload.fetchedAt };
}

// ─── Высокоуровневые методы ────────────────────────────────────────────────

// GET /api/client/campaign — список кампаний
// Возвращает list[] с полями campaignId, paymentType, state, advObjectType, title, fromDate, toDate, dailyBudget, productCampaignMode
export type OzonCampaign = {
  id: string;                    // Ozon отдаёт это поле как "id", не "campaignId"
  paymentType?: string;          // CPC | CPM | CPO
  state?: string;                // CAMPAIGN_STATE_RUNNING / PAUSED / FINISHED / DISABLED / DRAFT
  advObjectType?: string;        // SKU / SEARCH_PROMO / BANNER / BRAND_SHELF
  title?: string;
  fromDate?: string;
  toDate?: string;
  dailyBudget?: string | number;
  budget?: string | number;
  productCampaignMode?: string;
};

export async function ozonGetCampaigns(force = false) {
  return ozonPerfFetchCached<{ list: OzonCampaign[]; total?: number }>(
    '/api/client/campaign',
    { ttlMs: 30 * 60_000, force },
  );
}

// GET /api/client/statistics/expense/json?from=YYYY-MM-DD&to=YYYY-MM-DD
// Возвращает дневные расходы по всем кампаниям (синхронно, без UUID)
export type OzonDailyExpense = {
  id: string;          // campaignId
  title?: string;
  rows?: Array<{ date: string; views?: number; clicks?: number; moneySpent?: string | number; ordersMoney?: string | number; orders?: number }>;
};

export async function ozonGetDailyExpenses(from: string, to: string, force = false) {
  // /api/client/statistics/daily/json — дневная разбивка
  return ozonPerfFetchCached<{ rows: Array<{
    id: string;
    title?: string;
    date: string;
    views?: number;
    clicks?: number;
    moneySpent?: string | number;
    avgBid?: string | number;
    orders?: number;
    ordersMoney?: string | number;
    models?: number;
  }> }>(
    `/api/client/statistics/daily/json?dateFrom=${from}&dateTo=${to}`,
    { ttlMs: 30 * 60_000, force },
  );
}

// GET /api/client/statistics/expense — общий расход по всем кампаниям
export async function ozonGetTotalExpense(from: string, to: string, force = false) {
  return ozonPerfFetchCached<{ totalExpense?: string | number; rows?: any[] }>(
    `/api/client/statistics/expense?dateFrom=${from}&dateTo=${to}`,
    { ttlMs: 30 * 60_000, force },
  );
}

// Утилиты для дат
// По МОСКВЕ — Ozon считает сутки по МСК (см. utils/mskDate).
export function isoDate(d: Date): string { return mskDateOf(d); }
export function daysAgo(n: number): string {
  const d = new Date(); d.setDate(d.getDate() - n); return isoDate(d);
}
export function today(): string { return isoDate(new Date()); }

// Парсинг чисел в любом формате: "1 234,56" / "1234.56" / 1234 / null → number
export function parseRu(v: any): number {
  if (v == null) return 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const s = String(v)
    .replace(/ /g, '')   // non-breaking space
    .replace(/\s+/g, '')      // обычные пробелы
    .replace(',', '.');        // десятичная запятая → точка
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}
