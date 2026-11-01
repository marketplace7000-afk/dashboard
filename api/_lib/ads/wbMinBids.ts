/**
 * Минимальные ставки WB (01.11.2026). У каждого товара и площадки минимум свой, и WB его
 * меняет, поэтому автопилот спрашивает его у площадки, а не считает сам. Лимит метода —
 * 20 запросов в минуту (следит шлюз), поэтому держим копию в ads.sqlite и за проход
 * обновляем только самые старые записи.
 */
import { fetchWithRetry } from '../fetchRetry';
import { wbUpstream } from '../../_proxy';
import { adsDb } from './store';

export type WbMinBid = { search: number | null; recommendations: number | null; combined: number | null };

/** Сколько живёт копия минимумов. */
const TTL_MS = 6 * 3600_000;
/** Сколько кампаний обновлять за проход автопилота: ≈ 2 минуты при лимите 20/мин. */
const MAX_REFRESH = 40;

function db(): any | null {
  const d = adsDb();
  if (d) d.exec(`CREATE TABLE IF NOT EXISTS ad_wb_min_bid (
    campaign_id TEXT NOT NULL, sku TEXT NOT NULL,
    search REAL, recommendations REAL, combined REAL,
    fetched_at INTEGER NOT NULL,
    PRIMARY KEY (campaign_id, sku))`);
  return d;
}

/** Разбор ответа POST /api/advert/v1/bids/min: копейки → рубли. */
export function parseWbMinBids(json: unknown): Map<string, WbMinBid> {
  const out = new Map<string, WbMinBid>();
  const list = (json as any)?.bids;
  if (!Array.isArray(list)) return out;
  for (const n of list) {
    if (n?.nm_id == null || !Array.isArray(n.bids)) continue;
    const val = (type: string) => {
      const v = Number(n.bids.find((b: any) => b?.type === type)?.value);
      return Number.isFinite(v) && v > 0 ? v / 100 : null;
    };
    out.set(String(n.nm_id), { search: val('search'), recommendations: val('recommendation'), combined: val('combined') });
  }
  return out;
}

/** Спросить минимумы одной кампании и сохранить. null — WB не ответил (ставку это не блокирует). */
export async function fetchWbMinBids(campaignId: string, skus: string[], payment: string): Promise<Map<string, WbMinBid> | null> {
  const up = wbUpstream('promotion');
  if (!up.headers.Authorization) return null;
  try {
    const r = await fetchWithRetry(`${up.base}/api/advert/v1/bids/min`, {
      method: 'POST',
      headers: { ...up.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ advert_id: Number(campaignId), nm_ids: skus.map(Number), payment_type: payment, placement_types: ['combined', 'search', 'recommendation'] }),
    }, { maxRetries: 1, timeoutMs: 30_000 });
    if (!r.ok) return null;
    const map = parseWbMinBids(await r.json().catch(() => null));
    if (!map.size) return null;
    const d = db();
    if (d) {
      const st = d.prepare(`INSERT OR REPLACE INTO ad_wb_min_bid (campaign_id, sku, search, recommendations, combined, fetched_at) VALUES (?, ?, ?, ?, ?, ?)`);
      const now = Date.now();
      for (const [sku, m] of map) st.run(campaignId, sku, m.search, m.recommendations, m.combined, now);
    }
    return map;
  } catch { return null; }
}

/** Обновить устаревшие минимумы: начиная с кампаний, где данных нет или они самые старые. */
export async function refreshWbMinBids(campaigns: { id: string; payment: string | null; items: { sku: string }[] }[]): Promise<void> {
  const d = db();
  if (!d) return;
  const ages = new Map<string, number>();
  for (const r of d.prepare('SELECT campaign_id, MIN(fetched_at) AS t FROM ad_wb_min_bid GROUP BY campaign_id').all() as any[]) ages.set(r.campaign_id, r.t);
  const now = Date.now();
  const due = campaigns
    .filter(c => (c.payment === 'cpm' || c.payment === 'cpc') && c.items.length && now - (ages.get(c.id) ?? 0) > TTL_MS)
    .sort((a, b) => (ages.get(a.id) ?? 0) - (ages.get(b.id) ?? 0))
    .slice(0, MAX_REFRESH);
  for (const c of due) await fetchWbMinBids(c.id, c.items.map(i => i.sku), c.payment!);
}

/** Сохранённые минимумы: «кампания|товар» → минимумы. */
export function storedWbMinBids(): Map<string, WbMinBid> {
  const out = new Map<string, WbMinBid>();
  const d = db();
  if (!d) return out;
  for (const r of d.prepare('SELECT * FROM ad_wb_min_bid').all() as any[]) {
    out.set(`${r.campaign_id}|${r.sku}`, { search: r.search, recommendations: r.recommendations, combined: r.combined });
  }
  return out;
}

/** Ответ WB об ошибке → понятный текст. Незнакомые ответы оставляем как есть. */
export function humanWbError(text: string): string {
  const bid = /bid value must be no less than ([\d.]+)/.exec(text);
  if (bid) return `WB не принимает ставку ниже минимума ${Number(bid[1])} ₽ для этого товара. Ставка не изменилась.`;
  const lim = /dailyLimit must be at least (\d+)/.exec(text);
  if (lim) return `WB не принимает дневной лимит меньше ${Number(lim[1]) / 100} ₽. Лимит не изменился.`;
  if (/invalid placement/.test(text)) return 'В этой кампании площадка выключена, поэтому ставку для неё изменить нельзя. Ставка не изменилась.';
  return text;
}
