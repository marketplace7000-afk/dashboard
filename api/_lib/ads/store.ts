/**
 * Хранилище «Рекламы 2.0» (этап 0, 13.10.2026) — ads.sqlite.
 *
 * Что здесь, а что в РНП. РНП (rnp.sqlite) уже хранит рекламу по дням и
 * ТОВАРАМ для обеих площадок (adv_expenses, adv_views… — сумма по всем
 * кампаниям). Здесь — то, чего в РНП нет и без чего нельзя управлять:
 *   • кампании с их типом, статусом, местами показа и лимитами;
 *   • товары кампаний со ставками (снимок на момент синхронизации);
 *   • статистика «кампания × товар × день» (WB — из прогретого fullstats);
 *   • журнал изменений (кто, что, почему, что стало) — на нём стоит автопилот;
 *   • отметка товара «Не рекламировать» с причиной (самовыкуп, вывод и т.д.):
 *     такие товары автопилот не трогает и не предлагает (решение владельца 13.10).
 *
 * Деньги: ставки WB — в копейках (как отдаёт API), расход — в рублях.
 * Ставки Ozon храним «как есть» (bid_raw): единицу измерения проверим на живом
 * ответе, прежде чем показывать её в интерфейсе.
 */
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

let DatabaseSync: any = null;
try {
  DatabaseSync = require('node:sqlite').DatabaseSync;
} catch {
  DatabaseSync = null;
}

export type AdMp = 'wb' | 'ozon';

const DB_DIR = process.env.CACHE_DIR || join(process.cwd(), '.av-cache');
let dbPath = join(DB_DIR, 'ads.sqlite');
let db: any = null;
let initFailed = false;

/** Только для проверочных скриптов: открыть базу в другом месте (например ':memory:'). */
export function _useAdsDbForTests(path: string): void {
  if (db) { try { db.close(); } catch { /* уже закрыта */ } }
  db = null; initFailed = false; dbPath = path;
}

export function adsDb(): any | null {
  if (db) return db;
  if (initFailed || !DatabaseSync) return null;
  try {
    if (dbPath !== ':memory:') mkdirSync(DB_DIR, { recursive: true });
    db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE IF NOT EXISTS ad_campaign (
        mp TEXT NOT NULL, id TEXT NOT NULL,
        name TEXT, status TEXT, status_code INTEGER,
        payment TEXT,            -- cpm | cpc | cpo
        bid_type TEXT,           -- WB: unified | manual; Ozon: стратегия (TARGET_CIR и т.д.)
        placements TEXT,         -- JSON: {search, recommendations} или список Ozon
        daily_limit REAL,        -- ₽; WB — дневной лимит CPC-кампании
        daily_limit_on INTEGER,
        spent_today REAL,        -- ₽, если площадка отдаёт
        weekly_budget REAL,      -- ₽; Ozon
        created_at TEXT, started_at TEXT,
        raw TEXT, seen_at INTEGER, updated_at INTEGER,
        PRIMARY KEY (mp, id)
      );
      CREATE TABLE IF NOT EXISTS ad_campaign_item (
        mp TEXT NOT NULL, campaign_id TEXT NOT NULL, sku TEXT NOT NULL,
        title TEXT, subject TEXT,
        bid_search_kop INTEGER, bid_reco_kop INTEGER,   -- WB, копейки
        bid_raw TEXT,                                   -- Ozon, как в ответе
        target_cir REAL, top_position TEXT,             -- Ozon: целевой ДРР, «Вывод в топ»
        seen_at INTEGER,
        PRIMARY KEY (mp, campaign_id, sku)
      );
      CREATE INDEX IF NOT EXISTS ad_item_sku ON ad_campaign_item (mp, sku);
      CREATE TABLE IF NOT EXISTS ad_stat_day (
        mp TEXT NOT NULL, date TEXT NOT NULL, campaign_id TEXT NOT NULL, sku TEXT NOT NULL,
        views REAL, clicks REAL, spend REAL, carts REAL, orders REAL, revenue REAL, avg_pos REAL,
        PRIMARY KEY (mp, date, campaign_id, sku)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS ad_stat_sku ON ad_stat_day (mp, sku, date);
      CREATE TABLE IF NOT EXISTS ad_change_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL, mp TEXT NOT NULL, campaign_id TEXT, sku TEXT,
        actor TEXT NOT NULL,     -- autopilot | manager | owner
        action TEXT NOT NULL,    -- bid | daily_limit | pause | start | ...
        before TEXT, after TEXT, reason TEXT,
        status TEXT NOT NULL,    -- proposed | applied | rejected | failed | rolled_back
        result TEXT              -- JSON: ответ площадки и замер эффекта
      );
      CREATE INDEX IF NOT EXISTS ad_log_at ON ad_change_log (at);
      CREATE TABLE IF NOT EXISTS ad_product_flag (
        mp TEXT NOT NULL, sku TEXT NOT NULL,
        no_ads INTEGER NOT NULL DEFAULT 0,
        reason TEXT,             -- self_buyout | phase_out | inactive | other
        note TEXT, updated_at INTEGER, updated_by TEXT,
        PRIMARY KEY (mp, sku)
      );
      CREATE TABLE IF NOT EXISTS ad_meta (key TEXT PRIMARY KEY, value TEXT);
    `);
    // 14.10: архив товара (карточки под самовыкуп, дубли) — скрыт со всех экранов «Рекламы».
    const flagCols = (db.prepare('PRAGMA table_info(ad_product_flag)').all() as any[]).map(c => c.name);
    if (!flagCols.includes('archived')) db.exec('ALTER TABLE ad_product_flag ADD COLUMN archived INTEGER NOT NULL DEFAULT 0');
    return db;
  } catch (e) {
    console.warn('[ads-store] sqlite init failed:', (e as Error).message);
    initFailed = true;
    return null;
  }
}

export function adsMetaGet(key: string): string | null {
  const d = adsDb();
  if (!d) return null;
  try { return (d.prepare('SELECT value FROM ad_meta WHERE key = ?').get(key) as any)?.value ?? null; } catch { return null; }
}
export function adsMetaSet(key: string, value: string): void {
  const d = adsDb();
  if (!d) return;
  try { d.prepare('INSERT INTO ad_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value); } catch { /* не критично */ }
}

// ─── Кампании ────────────────────────────────────────────────────────────────

export type CampaignRow = {
  mp: AdMp; id: string; name: string | null; status: string | null; status_code: number | null;
  payment: string | null; bid_type: string | null; placements: unknown;
  daily_limit: number | null; daily_limit_on: boolean | null; spent_today: number | null; weekly_budget: number | null;
  created_at: string | null; started_at: string | null; raw?: unknown;
};

export type CampaignItemRow = {
  campaign_id: string; sku: string; title?: string | null; subject?: string | null;
  bid_search_kop?: number | null; bid_reco_kop?: number | null; bid_raw?: string | null;
  target_cir?: number | null; top_position?: string | null;
};

/**
 * Записать снимок кампаний площадки. Товары кампании заменяются целиком: товар,
 * который убрали из кампании, не должен висеть в ней со старой ставкой.
 * Лимиты (daily_limit…) обновляются отдельно — upsertDailyLimits.
 */
export function saveCampaigns(mp: AdMp, campaigns: CampaignRow[], items: CampaignItemRow[]): number {
  const d = adsDb();
  if (!d) return 0;
  const now = Date.now();
  const upC = d.prepare(`
    INSERT INTO ad_campaign (mp, id, name, status, status_code, payment, bid_type, placements, weekly_budget, created_at, started_at, raw, seen_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(mp, id) DO UPDATE SET
      name = excluded.name, status = excluded.status, status_code = excluded.status_code,
      payment = excluded.payment, bid_type = excluded.bid_type, placements = excluded.placements,
      weekly_budget = COALESCE(excluded.weekly_budget, ad_campaign.weekly_budget),
      created_at = excluded.created_at, started_at = excluded.started_at,
      raw = excluded.raw, seen_at = excluded.seen_at, updated_at = excluded.updated_at`);
  const delI = d.prepare('DELETE FROM ad_campaign_item WHERE mp = ? AND campaign_id = ?');
  const insI = d.prepare(`
    INSERT OR REPLACE INTO ad_campaign_item (mp, campaign_id, sku, title, subject, bid_search_kop, bid_reco_kop, bid_raw, target_cir, top_position, seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const byCampaign = new Map<string, CampaignItemRow[]>();
  for (const it of items) {
    const arr = byCampaign.get(it.campaign_id) ?? [];
    arr.push(it);
    byCampaign.set(it.campaign_id, arr);
  }
  d.exec('BEGIN');
  try {
    for (const c of campaigns) {
      upC.run(mp, c.id, c.name, c.status, c.status_code, c.payment, c.bid_type,
        c.placements == null ? null : JSON.stringify(c.placements), c.weekly_budget,
        c.created_at, c.started_at, c.raw == null ? null : JSON.stringify(c.raw), now, now);
      // Товары меняем только у кампаний, по которым они пришли: у Ozon товары
      // приходят отдельным запросом и могут не прийти (лимит, ошибка).
      const its = byCampaign.get(c.id);
      if (its) {
        delI.run(mp, c.id);
        for (const it of its) {
          insI.run(mp, c.id, it.sku, it.title ?? null, it.subject ?? null, it.bid_search_kop ?? null, it.bid_reco_kop ?? null,
            it.bid_raw ?? null, it.target_cir ?? null, it.top_position ?? null, now);
        }
      }
    }
    d.exec('COMMIT');
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
  return campaigns.length;
}

export function upsertDailyLimits(mp: AdMp, rows: { id: string; enabled: boolean; limitRub: number | null; spentTodayRub: number | null }[]): void {
  const d = adsDb();
  if (!d || !rows.length) return;
  const st = d.prepare('UPDATE ad_campaign SET daily_limit = ?, daily_limit_on = ?, spent_today = ? WHERE mp = ? AND id = ?');
  d.exec('BEGIN');
  try {
    for (const r of rows) st.run(r.limitRub, r.enabled ? 1 : 0, r.spentTodayRub, mp, r.id);
    d.exec('COMMIT');
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
}

export function listCampaigns(mp?: AdMp): (CampaignRow & { items: number; seen_at: number })[] {
  const d = adsDb();
  if (!d) return [];
  const rows = d.prepare(`
    SELECT c.*, (SELECT COUNT(*) FROM ad_campaign_item i WHERE i.mp = c.mp AND i.campaign_id = c.id) AS items
    FROM ad_campaign c ${mp ? 'WHERE c.mp = ?' : ''} ORDER BY c.mp, c.seen_at DESC, c.id DESC`).all(...(mp ? [mp] : [])) as any[];
  return rows.map(r => ({
    ...r,
    placements: r.placements ? JSON.parse(r.placements) : null,
    daily_limit_on: r.daily_limit_on == null ? null : !!r.daily_limit_on,
    raw: undefined,
  }));
}

export type CampaignItemFull = CampaignItemRow & { mp: AdMp; seen_at: number };

export function listItems(mp?: AdMp): CampaignItemFull[] {
  const d = adsDb();
  if (!d) return [];
  return d.prepare(`SELECT * FROM ad_campaign_item ${mp ? 'WHERE mp = ?' : ''}`).all(...(mp ? [mp] : [])) as any[];
}

export function getCampaign(mp: AdMp, id: string): (CampaignRow & { items: CampaignItemFull[] }) | null {
  const d = adsDb();
  if (!d) return null;
  const r = d.prepare('SELECT * FROM ad_campaign WHERE mp = ? AND id = ?').get(mp, id) as any;
  if (!r) return null;
  const items = d.prepare('SELECT * FROM ad_campaign_item WHERE mp = ? AND campaign_id = ?').all(mp, id) as any[];
  return {
    ...r,
    placements: r.placements ? JSON.parse(r.placements) : null,
    daily_limit_on: r.daily_limit_on == null ? null : !!r.daily_limit_on,
    raw: r.raw ? JSON.parse(r.raw) : null,
    items,
  };
}

/** Точечные правки после успешной команды — чтобы экран сразу видел новое, не дожидаясь сбора. */
export function patchCampaign(mp: AdMp, id: string, p: { status?: string; status_code?: number | null; weekly_budget?: number | null }): void {
  const d = adsDb();
  if (!d) return;
  if (p.status !== undefined) d.prepare('UPDATE ad_campaign SET status = ?, status_code = COALESCE(?, status_code), updated_at = ? WHERE mp = ? AND id = ?')
    .run(p.status, p.status_code ?? null, Date.now(), mp, id);
  if (p.weekly_budget !== undefined) d.prepare('UPDATE ad_campaign SET weekly_budget = ?, updated_at = ? WHERE mp = ? AND id = ?')
    .run(p.weekly_budget, Date.now(), mp, id);
}

export function patchItemBid(mp: AdMp, campaignId: string, sku: string, p: { bid_search_kop?: number; bid_reco_kop?: number; bid_raw?: string }): void {
  const d = adsDb();
  if (!d) return;
  for (const [col, v] of Object.entries(p)) {
    if (v === undefined || !['bid_search_kop', 'bid_reco_kop', 'bid_raw'].includes(col)) continue;
    d.prepare(`UPDATE ad_campaign_item SET ${col} = ? WHERE mp = ? AND campaign_id = ? AND sku = ?`).run(v, mp, campaignId, sku);
  }
}

export type CampaignStat = { campaign_id: string; sku: string | null; views: number; clicks: number; spend: number; carts: number; orders: number; revenue: number; avg_pos: number | null; days: number };

/** Сумма статистики за период: по кампании (sku = null) или по кампании × товару. */
export function campaignStats(mp: AdMp, from: string, to: string, bySku = false): CampaignStat[] {
  const d = adsDb();
  if (!d) return [];
  return d.prepare(`SELECT campaign_id, ${bySku ? 'sku' : 'NULL AS sku'},
      ROUND(SUM(views)) AS views, ROUND(SUM(clicks)) AS clicks, ROUND(SUM(spend), 2) AS spend,
      ROUND(SUM(carts), 1) AS carts, ROUND(SUM(orders), 1) AS orders, ROUND(SUM(revenue), 2) AS revenue,
      ROUND(SUM(avg_pos * views) / NULLIF(SUM(CASE WHEN avg_pos IS NOT NULL THEN views END), 0), 1) AS avg_pos,
      COUNT(DISTINCT date) AS days
    FROM ad_stat_day WHERE mp = ? AND date >= ? AND date <= ?
    GROUP BY campaign_id${bySku ? ', sku' : ''}`).all(mp, from, to) as any[];
}

/** Расход по дням (для графика темпа бюджета). */
export function spendByDay(mp: AdMp, from: string, to: string): { date: string; spend: number }[] {
  const d = adsDb();
  if (!d) return [];
  return d.prepare('SELECT date, ROUND(SUM(spend), 2) AS spend FROM ad_stat_day WHERE mp = ? AND date >= ? AND date <= ? GROUP BY date ORDER BY date')
    .all(mp, from, to) as any[];
}

// ─── Статистика кампания × товар × день ─────────────────────────────────────

export type StatDayRow = {
  date: string; campaign_id: string; sku: string;
  views: number; clicks: number; spend: number; carts: number; orders: number; revenue: number; avg_pos: number | null;
};

/**
 * Записать статистику: для каждой пары (кампания, день), пришедшей в rows,
 * старые строки удаляются и пишутся новые. Так товар, у которого за день
 * статистика исчезла (WB пересчитал), не остаётся со старой цифрой.
 */
export function saveStatDays(mp: AdMp, rows: StatDayRow[]): number {
  const d = adsDb();
  if (!d || !rows.length) return 0;
  const del = d.prepare('DELETE FROM ad_stat_day WHERE mp = ? AND date = ? AND campaign_id = ?');
  const ins = d.prepare(`INSERT OR REPLACE INTO ad_stat_day (mp, date, campaign_id, sku, views, clicks, spend, carts, orders, revenue, avg_pos)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const pairs = new Set(rows.map(r => `${r.campaign_id}\u0000${r.date}`));
  const r2 = (v: number) => Math.round(v * 100) / 100;
  d.exec('BEGIN');
  try {
    for (const p of pairs) { const [cid, date] = p.split('\u0000'); del.run(mp, date, cid); }
    for (const r of rows) {
      ins.run(mp, r.date, r.campaign_id, r.sku, r2(r.views), r2(r.clicks), r2(r.spend), r2(r.carts), r2(r.orders), r2(r.revenue),
        r.avg_pos == null ? null : r2(r.avg_pos));
    }
    d.exec('COMMIT');
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
  return rows.length;
}

export function statSummary(): { mp: string; days: number; from: string | null; to: string | null; rows: number; spend: number }[] {
  const d = adsDb();
  if (!d) return [];
  return d.prepare(`SELECT mp, COUNT(DISTINCT date) AS days, MIN(date) AS "from", MAX(date) AS "to", COUNT(*) AS rows, ROUND(SUM(spend), 2) AS spend
    FROM ad_stat_day GROUP BY mp`).all() as any[];
}

// ─── Журнал изменений ───────────────────────────────────────────────────────

export type ChangeEntry = {
  mp: AdMp; campaign_id?: string | null; sku?: string | null;
  actor: 'autopilot' | 'manager' | 'owner'; action: string;
  before?: unknown; after?: unknown; reason?: string | null;
  status: 'proposed' | 'applied' | 'rejected' | 'failed' | 'rolled_back';
  result?: unknown;
};

export function logChange(e: ChangeEntry): number | null {
  const d = adsDb();
  if (!d) return null;
  const r = d.prepare(`INSERT INTO ad_change_log (at, mp, campaign_id, sku, actor, action, before, after, reason, status, result)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    Date.now(), e.mp, e.campaign_id ?? null, e.sku ?? null, e.actor, e.action,
    e.before === undefined ? null : JSON.stringify(e.before), e.after === undefined ? null : JSON.stringify(e.after),
    e.reason ?? null, e.status, e.result === undefined ? null : JSON.stringify(e.result));
  return Number(r.lastInsertRowid);
}

/** Журнал изменений. `mp` — только одна площадка: иначе лимит делился на обе. */
export function listChanges(limit = 100, mp?: AdMp): any[] {
  const d = adsDb();
  if (!d) return [];
  const n = Math.min(Math.max(limit, 1), 500);
  const rows = mp
    ? d.prepare('SELECT * FROM ad_change_log WHERE mp = ? ORDER BY at DESC, id DESC LIMIT ?').all(mp, n)
    : d.prepare('SELECT * FROM ad_change_log ORDER BY at DESC, id DESC LIMIT ?').all(n);
  return (rows as any[])
    .map(r => ({ ...r, before: r.before ? JSON.parse(r.before) : null, after: r.after ? JSON.parse(r.after) : null, result: r.result ? JSON.parse(r.result) : null }));
}

// ─── Отметка «Не рекламировать» ─────────────────────────────────────────────

export const NO_ADS_REASONS = ['self_buyout', 'phase_out', 'inactive', 'other'] as const;
export type NoAdsReason = typeof NO_ADS_REASONS[number];

export type ProductFlag = { mp: AdMp; sku: string; no_ads: boolean; archived: boolean; reason: NoAdsReason | null; note: string | null; updated_at: number; updated_by: string | null };

export function listFlags(): ProductFlag[] {
  const d = adsDb();
  if (!d) return [];
  return (d.prepare('SELECT * FROM ad_product_flag WHERE no_ads = 1 OR archived = 1 ORDER BY updated_at DESC').all() as any[])
    .map(r => ({ ...r, no_ads: !!r.no_ads, archived: !!r.archived }));
}

/**
 * Архив: товар пропадает из «Товаров», «Обзора» и «Конкурентов» и одновременно получает
 * «Не рекламировать» (автопилот его не трогает). Возврат из архива снимает только архив —
 * отметку «Не рекламировать» менеджер снимает сам, осознанно.
 */
export function setArchived(mp: AdMp, skus: string[], archived: boolean, reason: NoAdsReason | null, by: string): number {
  const d = adsDb();
  if (!d) throw new Error('хранилище рекламы недоступно');
  if (archived && (!reason || !NO_ADS_REASONS.includes(reason))) throw new Error('укажите причину: ' + NO_ADS_REASONS.join(', '));
  const now = Date.now();
  const on = d.prepare(`INSERT INTO ad_product_flag (mp, sku, no_ads, archived, reason, note, updated_at, updated_by) VALUES (?, ?, 1, 1, ?, NULL, ?, ?)
    ON CONFLICT(mp, sku) DO UPDATE SET archived = 1, reason = CASE WHEN ad_product_flag.no_ads = 1 THEN ad_product_flag.reason ELSE excluded.reason END,
      no_ads = 1, updated_at = excluded.updated_at, updated_by = excluded.updated_by`);
  const off = d.prepare('UPDATE ad_product_flag SET archived = 0, updated_at = ?, updated_by = ? WHERE mp = ? AND sku = ?');
  let n = 0;
  d.exec('BEGIN');
  try {
    for (const sku of [...new Set(skus.map(s => String(s).trim()).filter(Boolean))].slice(0, 500)) {
      if (archived) on.run(mp, sku, reason, now, by); else off.run(now, by, mp, sku);
      n++;
    }
    d.exec('COMMIT');
  } catch (e) { d.exec('ROLLBACK'); throw e; }
  return n;
}

export function setFlag(mp: AdMp, sku: string, noAds: boolean, reason: NoAdsReason | null, note: string | null, by: string): ProductFlag {
  const d = adsDb();
  if (!d) throw new Error('хранилище рекламы недоступно');
  if (noAds && (!reason || !NO_ADS_REASONS.includes(reason))) throw new Error('укажите причину: ' + NO_ADS_REASONS.join(', '));
  const now = Date.now();
  d.prepare(`INSERT INTO ad_product_flag (mp, sku, no_ads, reason, note, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(mp, sku) DO UPDATE SET no_ads = excluded.no_ads, reason = excluded.reason, note = excluded.note,
      updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
    .run(mp, sku, noAds ? 1 : 0, noAds ? reason : null, note, now, by);
  const archived = !!(d.prepare('SELECT archived FROM ad_product_flag WHERE mp = ? AND sku = ?').get(mp, sku) as any)?.archived;
  return { mp, sku, no_ads: noAds, archived, reason: noAds ? reason : null, note, updated_at: now, updated_by: by };
}

/**
 * Нельзя ли автопилоту трогать товар. Если база недоступна — считаем, что нельзя:
 * отметку «Не рекламировать» ставят под самовыкуп и вывод, и молча её
 * проигнорировать хуже, чем пропустить один проход автопилота.
 */
export function isNoAds(mp: AdMp, sku: string): boolean {
  const d = adsDb();
  if (!d) return true;
  try { return !!(d.prepare('SELECT no_ads FROM ad_product_flag WHERE mp = ? AND sku = ?').get(mp, sku) as any)?.no_ads; } catch { return true; }
}
