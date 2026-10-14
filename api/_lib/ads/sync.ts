/**
 * Сборщик «Рекламы 2.0» (этап 0, 13.10.2026): кампании, ставки, лимиты и
 * статистика по кампаниям → ads.sqlite (см. store.ts).
 *
 * Бережём лимиты площадок:
 *   WB   кампании и ставки — GET /api/advert/v2/adverts (5/с, один-два запроса);
 *        дневные лимиты CPC — GET /api/advert/v0/daily-limits (5/мин, ≤100 id);
 *        статистика — НЕ запрашиваем: берём уже прогретый cron-ом adv/v3/fullstats
 *        (окна 7 и 30 дней) из кэша. Тот же ответ читают «Реклама» и РНП.
 *   Ozon список кампаний — GET /api/client/campaign; товары и ставки —
 *        GET /api/client/campaign/{id}/v2/products по активным кампаниям «Оплата за клик».
 *        Лимит Performance API — 100 000 запросов в сутки, это капля.
 * Все запросы идут через общий шлюз (fetchWithRetry → gateway).
 */
import { fetchWithRetry } from '../fetchRetry';
import { cacheEntriesByPrefix, makeUpstreamCachePrefix } from '../cache';
import { wbUpstream } from '../../_proxy';
import { getOzonPerfToken, PERF_HOST } from '../ozonPerfAuth';
import {
  saveCampaigns, upsertDailyLimits, saveStatDays, adsMetaSet, adsMetaGet,
  type CampaignRow, type CampaignItemRow, type StatDayRow,
} from './store';

const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const numOrNull = (v: unknown) => { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };

// ─── WB ──────────────────────────────────────────────────────────────────────

export const WB_STATUS: Record<number, string> = { [-1]: 'deleted', 4: 'ready', 7: 'finished', 8: 'cancelled', 9: 'active', 11: 'paused' };

type WbAdvert = {
  id?: number; bid_type?: string; status?: number;
  settings?: { name?: string; payment_type?: string; placements?: { search?: boolean; recommendations?: boolean } };
  nm_settings?: { nm_id?: number; bids_kopecks?: { search?: number; recommendations?: number }; subject?: { name?: string } }[];
  timestamps?: { created?: string; started?: string | null };
};

/** Разбор ответа /api/advert/v2/adverts в строки хранилища. */
export function parseWbAdverts(json: unknown): { campaigns: CampaignRow[]; items: CampaignItemRow[] } {
  const adverts: WbAdvert[] = Array.isArray((json as any)?.adverts) ? (json as any).adverts : [];
  const campaigns: CampaignRow[] = [];
  const items: CampaignItemRow[] = [];
  for (const a of adverts) {
    if (typeof a?.id !== 'number') continue;
    const id = String(a.id);
    campaigns.push({
      mp: 'wb', id,
      name: a.settings?.name?.trim() || null,
      status: WB_STATUS[a.status ?? -99] ?? String(a.status ?? ''),
      status_code: a.status ?? null,
      payment: a.settings?.payment_type ?? null,
      bid_type: a.bid_type ?? null,
      placements: a.settings?.placements ?? null,
      daily_limit: null, daily_limit_on: null, spent_today: null, weekly_budget: null,
      created_at: a.timestamps?.created ?? null,
      started_at: a.timestamps?.started ?? null,
      raw: { bid_type: a.bid_type, settings: a.settings },
    });
    for (const n of a.nm_settings ?? []) {
      if (typeof n?.nm_id !== 'number') continue;
      items.push({
        campaign_id: id, sku: String(n.nm_id), subject: n.subject?.name ?? null,
        bid_search_kop: numOrNull(n.bids_kopecks?.search), bid_reco_kop: numOrNull(n.bids_kopecks?.recommendations),
      });
    }
  }
  return { campaigns, items };
}

type NmRow = { nmId?: number; views?: number; clicks?: number; sum?: number; orders?: number; sum_price?: number; atbs?: number };
type FsDay = { date?: string; atbs?: number; nm?: NmRow[]; nms?: NmRow[]; apps?: { atbs?: number; nm?: NmRow[]; nms?: NmRow[] }[] };
type FsCampaign = { advertId?: number; days?: FsDay[]; boosterStats?: { date?: string; nm?: number; avg_position?: number }[] };

/**
 * Разбор adv/v3/fullstats в строки «кампания × товар × день».
 * WB раскладывает день по площадкам показа (apps: сайт, Android, iOS) — товар
 * встречается в каждой, поэтому складываем. Корзины WB у части кампаний отдаёт
 * только на уровне дня/площадки — тогда раскладываем пропорционально кликам
 * (так же считает «Реклама» сейчас, см. wbSource.ts).
 */
export function parseWbFullstats(json: unknown): StatDayRow[] {
  const arr: FsCampaign[] = Array.isArray(json) ? json : [];
  const acc = new Map<string, StatDayRow>();
  for (const c of arr) {
    if (typeof c?.advertId !== 'number') continue;
    const cid = String(c.advertId);
    const pos = new Map<string, number>();
    for (const b of c.boosterStats ?? []) {
      if (b?.date && b?.nm) pos.set(`${String(b.date).slice(0, 10)}|${b.nm}`, num(b.avg_position));
    }
    for (const d of c.days ?? []) {
      const date = String(d?.date ?? '').slice(0, 10);
      if (!date) continue;
      // Срез «площадка → товары»; если apps нет — товары лежат прямо в дне.
      const slices: { atbs: number; nms: NmRow[] }[] = (d.apps?.length)
        ? d.apps.map(a => ({ atbs: num(a?.atbs), nms: a?.nms ?? a?.nm ?? [] }))
        : [{ atbs: num(d.atbs), nms: d.nms ?? d.nm ?? [] }];
      for (const s of slices) {
        const hasOwnAtbs = s.nms.some(r => r?.atbs != null);
        const clicks = s.nms.reduce((t, r) => t + num(r?.clicks), 0);
        for (const r of s.nms) {
          if (!r?.nmId) continue;
          const key = `${cid}|${date}|${r.nmId}`;
          const row = acc.get(key) ?? {
            date, campaign_id: cid, sku: String(r.nmId),
            views: 0, clicks: 0, spend: 0, carts: 0, orders: 0, revenue: 0,
            avg_pos: pos.get(`${date}|${r.nmId}`) ?? null,
          };
          row.views += num(r.views);
          row.clicks += num(r.clicks);
          row.spend += num(r.sum);
          row.orders += num(r.orders);
          row.revenue += num(r.sum_price);
          row.carts += hasOwnAtbs ? num(r.atbs) : (clicks > 0 ? s.atbs * num(r.clicks) / clicks : 0);
          acc.set(key, row);
        }
      }
    }
  }
  return [...acc.values()];
}

/**
 * Разбор /api/advert/v0/daily-limits. Принимаем и корневой массив, и обёртки
 * (adverts / limits / data), id — advertId | advert_id | id, суммы — в копейках.
 */
export function parseWbDailyLimits(json: unknown): { id: string; enabled: boolean; limitRub: number | null; spentTodayRub: number | null }[] {
  const j: any = json;
  const list: any[] = Array.isArray(j) ? j : (j?.adverts ?? j?.limits ?? j?.data?.adverts ?? j?.data ?? []);
  if (!Array.isArray(list)) return [];
  const kop = (v: unknown) => (v == null ? null : num(v) / 100);
  return list
    .map(a => ({ a, id: a?.advertId ?? a?.advert_id ?? a?.id }))
    .filter(x => x.id != null)
    .map(({ a, id }) => ({
      id: String(id),
      enabled: !!(a.enabled ?? a.is_enabled ?? a.isEnabled ?? (a.dailyLimit ?? a.daily_limit ?? a.limit) != null),
      limitRub: kop(a.dailyLimit ?? a.daily_limit ?? a.limit),
      spentTodayRub: kop(a.spentToday ?? a.spent_today ?? a.spent),
    }));
}

async function syncWbCampaigns(): Promise<string> {
  const up = wbUpstream('promotion');
  if (!up.headers.Authorization) return 'WB: нет ключа Продвижения';
  const r = await fetchWithRetry(`${up.base}/api/advert/v2/adverts?statuses=4,9,11`, { method: 'GET', headers: up.headers }, { maxRetries: 1 });
  if (!r.ok) return `WB кампании: ответ ${r.status} ${(await r.text().catch(() => '')).slice(0, 120)}`;
  const { campaigns, items } = parseWbAdverts(await r.json());
  saveCampaigns('wb', campaigns, items);

  // Дневные лимиты есть только у кампаний с оплатой за клик (и только по
  // персональному или сервисному ключу — иначе 401/403, это не ошибка сбора).
  const cpc = campaigns.filter(c => c.payment === 'cpc').map(c => c.id);
  let limits = 0;
  let limitsNote = '';
  for (let i = 0; i < cpc.length; i += 100) {
    const ids = cpc.slice(i, i + 100).join(',');
    const lr = await fetchWithRetry(`${up.base}/api/advert/v0/daily-limits?advertIds=${ids}`, { method: 'GET', headers: up.headers }, { maxRetries: 1 });
    if (!lr.ok) { limitsNote = ` (лимиты: ответ ${lr.status}${lr.status === 401 || lr.status === 403 ? ' — нужен персональный ключ' : ''})`; break; }
    const text = await lr.text().catch(() => '');
    let lj: any = null;
    try { lj = JSON.parse(text); } catch { /* разбор ниже вернёт пусто */ }
    const rows = parseWbDailyLimits(lj);
    // На проде 14.10 ответ 200 дал 0 строк — форма ответа не та, что ждали.
    // Пока не сверим, печатаем начало ответа в итог сбора (он идёт в журнал).
    if (!rows.length && !limitsNote) limitsNote = ` (лимиты: 200, но не разобраны: ${text.slice(0, 300)})`;
    upsertDailyLimits('wb', rows);
    limits += rows.length;
  }
  return `WB: кампаний ${campaigns.length}, товаров ${items.length}, лимитов ${limits}${limitsNote}`;
}

function ingestWbFullstats(): string {
  // Все прогретые окна (7 и 30 дней), от старых к свежим: свежие перезапишут дни.
  const entries = cacheEntriesByPrefix<{ status: number; text: string }>(
    makeUpstreamCachePrefix('wb:promotion', 'GET', 'adv/v3/fullstats', '', undefined),
  );
  let rows = 0;
  for (const e of entries) {
    if (!e?.data?.text || e.data.status >= 400) continue;
    try { rows += saveStatDays('wb', parseWbFullstats(JSON.parse(e.data.text))); } catch (err) {
      console.warn('[ads-sync] fullstats не разобран:', (err as Error).message);
    }
  }
  return entries.length ? `WB статистика: окон ${entries.length}, строк ${rows}` : 'WB статистика: fullstats ещё не прогрет';
}

// ─── Ozon ────────────────────────────────────────────────────────────────────

const OZ_LIVE = new Set(['CAMPAIGN_STATE_RUNNING', 'CAMPAIGN_STATE_STOPPED', 'CAMPAIGN_STATE_INACTIVE', 'CAMPAIGN_STATE_PLANNED']);
const OZ_STATUS: Record<string, string> = {
  CAMPAIGN_STATE_RUNNING: 'active', CAMPAIGN_STATE_STOPPED: 'out_of_budget', CAMPAIGN_STATE_INACTIVE: 'paused',
  CAMPAIGN_STATE_PLANNED: 'planned', CAMPAIGN_STATE_ARCHIVED: 'archived', CAMPAIGN_STATE_FINISHED: 'finished',
};
/**
 * Деньги Performance API — в миллионных долях рубля (1 000 000 = 1 ₽).
 * Ставки товаров тоже: на проде 14.10 bid "8000000" = 8 ₽. Ставка 0 —
 * у кампаний с автостратегией (MAX_CLICKS, TOP_MAX_CLICKS): её ведёт Ozon.
 */
export const micro = (v: unknown) => { const n = numOrNull(v); return n == null ? null : Math.round(n / 10_000) / 100; };

/** Тип оплаты: поле paymentType Ozon в списке не отдаёт — выводим из объекта рекламы. */
function ozPayment(c: any): string | null {
  if (c?.paymentType) return String(c.paymentType).toLowerCase();
  if (c?.advObjectType === 'SKU') return 'cpc';
  if (c?.advObjectType === 'SEARCH_PROMO' || c?.advObjectType === 'ALL_SKU_PROMO') return 'cpo';
  return null;
}

export function parseOzonCampaigns(json: unknown): CampaignRow[] {
  const list: any[] = Array.isArray((json as any)?.list) ? (json as any).list : [];
  return list.filter(c => c?.id != null).map(c => ({
    mp: 'ozon' as const, id: String(c.id),
    name: c.title ?? null,
    status: OZ_STATUS[c.state] ?? c.state ?? null,
    status_code: null,
    payment: ozPayment(c),
    bid_type: c.productAutopilotStrategy ?? null,
    placements: c.placement ?? null,
    daily_limit: micro(c.dailyBudget), daily_limit_on: null, spent_today: null,
    weekly_budget: micro(c.weeklyBudget),
    created_at: c.createdAt ?? null, started_at: c.fromDate ?? null,
    raw: { advObjectType: c.advObjectType, state: c.state, budget: c.budget, productCampaignMode: c.productCampaignMode },
  }));
}

async function ozPerf(path: string, token: string): Promise<Response> {
  return fetchWithRetry(`${PERF_HOST}/${path}`, { method: 'GET', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } }, { maxRetries: 1 });
}

async function syncOzonCampaigns(): Promise<string> {
  if (!process.env.OZON_PERF_CLIENT_ID || !process.env.OZON_PERF_CLIENT_SECRET) return 'Ozon: нет ключей Performance';
  const token = await getOzonPerfToken();
  const r = await ozPerf('api/client/campaign', token);
  if (!r.ok) return `Ozon кампании: ответ ${r.status}`;
  const all = parseOzonCampaigns(await r.json());
  const live = all.filter(c => OZ_LIVE.has((c.raw as any)?.state));
  const items: CampaignItemRow[] = [];
  let fetched = 0, failed = 0;
  // Товары и ставки — только у товарных кампаний «Оплата за клик». У «Оплаты за
  // заказ» товары живут в отдельном методе (search_promo), их добавим на этапе 1.
  for (const c of live.filter(x => (x.raw as any)?.advObjectType === 'SKU').slice(0, 40)) {
    const pr = await ozPerf(`api/client/campaign/${c.id}/v2/products`, token);
    if (!pr.ok) { failed++; continue; }
    const pj: any = await pr.json().catch(() => null);
    for (const p of (pj?.products ?? [])) {
      if (p?.sku == null) continue;
      items.push({
        campaign_id: c.id, sku: String(p.sku), title: p.title ?? null,
        bid_raw: p.bid == null ? null : String(p.bid),
        target_cir: numOrNull(p.targetCir), top_position: p.topPosition ?? null,
      });
    }
    fetched++;
  }
  saveCampaigns('ozon', live, items);
  return `Ozon: кампаний ${live.length} (всего ${all.length}), со ставками ${fetched}${failed ? `, не ответили ${failed}` : ''}, товаров ${items.length}`;
}

// ─── Точка входа ─────────────────────────────────────────────────────────────

let running: Promise<string[]> | null = null;

/** Синхронизировать хранилище рекламы. Повторный вызов во время работы ждёт текущий. */
export function syncAds(): Promise<string[]> {
  if (running) return running;
  running = (async () => {
    const out: string[] = [];
    for (const [name, step] of [
      ['wb', syncWbCampaigns], ['wb-stats', async () => ingestWbFullstats()], ['ozon', syncOzonCampaigns],
    ] as [string, () => Promise<string>][]) {
      try { out.push(await step()); } catch (e) { out.push(`${name}: сбой — ${(e as Error).message}`); }
    }
    adsMetaSet('last_sync', JSON.stringify({ at: Date.now(), result: out }));
    return out;
  })().finally(() => { running = null; });
  return running;
}

export function lastAdsSync(): { at: number; result: string[] } | null {
  const v = adsMetaGet('last_sync');
  if (!v) return null;
  try { return JSON.parse(v); } catch { return null; }
}
