/**
 * Агент 2 «Отзывы и вопросы» — хранилище.
 * SQLite (node:sqlite, как agentQueue.ts): .av-cache/reviews.sqlite.
 * Тексты отзывов, база знаний и пары из Telegram — только здесь, в git не попадают.
 */
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import {
  DEFAULT_REVIEW_SETTINGS,
  type ReviewItem, type ReviewSettings, type ReviewDirection, type CollectState,
} from '../../../shared/reviews';

let DatabaseSync: any = null;
try { DatabaseSync = require('node:sqlite').DatabaseSync; } catch { DatabaseSync = null; }

const DB_DIR = process.env.CACHE_DIR || join(process.cwd(), '.av-cache');
const DB_PATH = process.env.REVIEWS_DB || join(DB_DIR, 'reviews.sqlite');

let db: any = null;
let initFailed = false;

export function getDb(): any {
  if (db) return db;
  if (initFailed || !DatabaseSync) throw new Error('reviews: node:sqlite недоступен');
  try {
    mkdirSync(DB_DIR, { recursive: true });
    db = new DatabaseSync(DB_PATH);
    db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        marketplace TEXT NOT NULL,
        kind TEXT NOT NULL,
        external_id TEXT NOT NULL,
        sku TEXT, offer_id TEXT, product_name TEXT, product_url TEXT,
        rating INTEGER, text TEXT NOT NULL DEFAULT '', pros TEXT, cons TEXT, author TEXT,
        created_at INTEGER NOT NULL,
        answered_on_mp INTEGER NOT NULL DEFAULT 0,
        mp_answer TEXT,
        status TEXT NOT NULL DEFAULT 'new',
        draft_answer TEXT, draft_model TEXT, draft_cost REAL,
        confidence TEXT, category TEXT, escalation_reason TEXT,
        sources_used TEXT NOT NULL DEFAULT '[]',
        draft_attempts INTEGER NOT NULL DEFAULT 0,
        published_at INTEGER, published_by TEXT, publish_error TEXT,
        first_seen_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(marketplace, external_id)
      );
      CREATE INDEX IF NOT EXISTS items_open ON items(answered_on_mp, status, created_at);
      CREATE INDEX IF NOT EXISTS items_offer ON items(offer_id);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS kb_texts (key TEXT PRIMARY KEY, text TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS kb_folders (
        path TEXT PRIMARY KEY,
        offer_ids TEXT NOT NULL DEFAULT '[]',
        suggested TEXT NOT NULL DEFAULT '[]',
        confirmed INTEGER NOT NULL DEFAULT 0,
        files TEXT NOT NULL DEFAULT '[]',
        text TEXT NOT NULL DEFAULT '',
        updated_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS kb_tg (
        dialog_id TEXT NOT NULL, message_id TEXT NOT NULL,
        question TEXT NOT NULL, answer TEXT NOT NULL, date TEXT,
        PRIMARY KEY (dialog_id, message_id)
      );
      CREATE TABLE IF NOT EXISTS collect_state (
        direction TEXT PRIMARY KEY, at INTEGER, ok INTEGER NOT NULL DEFAULT 0, error TEXT, note TEXT
      );
      CREATE TABLE IF NOT EXISTS log (
        id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL,
        level TEXT NOT NULL, message TEXT NOT NULL, data TEXT
      );
      CREATE TABLE IF NOT EXISTS usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, purpose TEXT NOT NULL,
        model TEXT NOT NULL, input_tokens INTEGER, output_tokens INTEGER,
        cache_read INTEGER, cache_write INTEGER, cost_usd REAL NOT NULL
      );
      CREATE TABLE IF NOT EXISTS kb_cards (
        marketplace TEXT NOT NULL, offer_id TEXT NOT NULL, name TEXT, text TEXT NOT NULL DEFAULT '',
        updated_at INTEGER NOT NULL, PRIMARY KEY (marketplace, offer_id)
      );
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
    `);
    // Миграции: переписка из чатов площадок лежит рядом с Telegram (source = tg | wb_chat | ozon_chat).
    for (const sql of [
      "ALTER TABLE kb_tg ADD COLUMN source TEXT NOT NULL DEFAULT 'tg'",
      'ALTER TABLE kb_tg ADD COLUMN offer_id TEXT',
      'ALTER TABLE kb_folders ADD COLUMN first_seen_at INTEGER',
    ]) { try { db.exec(sql); } catch { /* колонка уже есть */ } }
    return db;
  } catch (e) {
    initFailed = true;
    throw e;
  }
}

// ─── Журнал ────────────────────────────────────────────────────────────────
export function rlog(level: 'info' | 'warn' | 'error', message: string, data?: unknown): void {
  try {
    getDb().prepare('INSERT INTO log (at, level, message, data) VALUES (?, ?, ?, ?)')
      .run(Date.now(), level, message.slice(0, 500), data === undefined ? null : JSON.stringify(data).slice(0, 4000));
    if (level !== 'info') console.warn(`[reviews] ${level}: ${message}`);
  } catch { /* журнал не должен ронять работу */ }
}

export function readLog(limit = 200): { at: number; level: string; message: string; data: any }[] {
  return getDb().prepare('SELECT at, level, message, data FROM log ORDER BY id DESC LIMIT ?').all(limit)
    .map((r: any) => ({ at: r.at, level: r.level, message: r.message, data: r.data ? safeJson(r.data) : null }));
}

export function safeJson(s: string | null | undefined, fallback: any = null): any {
  if (!s) return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
}

// ─── Настройки ─────────────────────────────────────────────────────────────
export function getSettings(): ReviewSettings {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = 'main'").get() as any;
  const saved = row ? safeJson(row.value, {}) : {};
  return {
    ...DEFAULT_REVIEW_SETTINGS,
    ...saved,
    autoPublish: { ...DEFAULT_REVIEW_SETTINGS.autoPublish, ...(saved.autoPublish || {}) },
  };
}

export function saveSettings(patch: Partial<ReviewSettings>): ReviewSettings {
  const cur = getSettings();
  const next: ReviewSettings = {
    ...cur,
    ...patch,
    autoPublish: { ...cur.autoPublish, ...(patch.autoPublish || {}) },
  };
  next.escalateRatingMax = Math.min(Math.max(Math.round(Number(next.escalateRatingMax) || 0), 0), 5);
  next.monthlyBudgetUsd = Math.max(0, Number(next.monthlyBudgetUsd) || 0);
  next.keyBudgetUsd = Math.max(0, Number(next.keyBudgetUsd) || 0);
  next.draftModel = String(next.draftModel || DEFAULT_REVIEW_SETTINGS.draftModel).trim();
  next.indexModel = String(next.indexModel || DEFAULT_REVIEW_SETTINGS.indexModel).trim();
  next.yandexDiskUrl = String(next.yandexDiskUrl || '').trim();
  getDb().prepare("INSERT INTO settings (key, value) VALUES ('main', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(JSON.stringify(next));
  return next;
}

// ─── Состояние сбора ────────────────────────────────────────────────────────
export function setCollectState(direction: ReviewDirection, ok: boolean, error: string | null, note: string | null = null): void {
  getDb().prepare(`INSERT INTO collect_state (direction, at, ok, error, note) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(direction) DO UPDATE SET at = excluded.at, ok = excluded.ok, error = excluded.error, note = excluded.note`)
    .run(direction, Date.now(), ok ? 1 : 0, error, note);
}

export function readCollectState(): CollectState[] {
  return getDb().prepare('SELECT * FROM collect_state').all().map((r: any) => ({
    direction: r.direction, at: r.at, ok: !!r.ok, error: r.error, note: r.note,
  }));
}

// ─── Записи ────────────────────────────────────────────────────────────────
export function rowToItem(r: any): ReviewItem {
  return {
    id: r.id,
    marketplace: r.marketplace,
    kind: r.kind,
    externalId: r.external_id,
    sku: r.sku, offerId: r.offer_id, productName: r.product_name, productUrl: r.product_url,
    rating: r.rating, text: r.text, pros: r.pros, cons: r.cons, author: r.author,
    createdAt: r.created_at,
    answeredOnMarketplace: !!r.answered_on_mp,
    marketplaceAnswer: r.mp_answer,
    status: r.status,
    draftAnswer: r.draft_answer, draftModel: r.draft_model, draftCostUsd: r.draft_cost,
    confidence: r.confidence, category: r.category, escalationReason: r.escalation_reason,
    sourcesUsed: safeJson(r.sources_used, []),
    publishedAt: r.published_at, publishedBy: r.published_by, publishError: r.publish_error,
  };
}

export type UpsertInput = {
  marketplace: 'wb' | 'ozon'; kind: 'review' | 'question'; externalId: string;
  sku?: string | null; offerId?: string | null; productName?: string | null; productUrl?: string | null;
  rating?: number | null; text: string; pros?: string | null; cons?: string | null; author?: string | null;
  createdAt: number; answered: boolean; mpAnswer?: string | null;
};

/** Вставить или обновить запись. Черновик и статус не трогает (кроме «отвечено на площадке»). */
export function upsertItem(x: UpsertInput): { inserted: boolean } {
  const d = getDb();
  const now = Date.now();
  const existing = d.prepare('SELECT id FROM items WHERE marketplace = ? AND external_id = ?').get(x.marketplace, x.externalId) as any;
  if (!existing) {
    d.prepare(`INSERT INTO items (marketplace, kind, external_id, sku, offer_id, product_name, product_url, rating,
      text, pros, cons, author, created_at, answered_on_mp, mp_answer, status, first_seen_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?)`)
      .run(x.marketplace, x.kind, x.externalId, x.sku ?? null, x.offerId ?? null, x.productName ?? null, x.productUrl ?? null,
        x.rating ?? null, x.text || '', x.pros ?? null, x.cons ?? null, x.author ?? null, x.createdAt,
        x.answered ? 1 : 0, x.mpAnswer ?? null, now, now);
    return { inserted: true };
  }
  d.prepare(`UPDATE items SET sku = COALESCE(?, sku), offer_id = COALESCE(?, offer_id), product_name = COALESCE(?, product_name),
      product_url = COALESCE(?, product_url), rating = COALESCE(?, rating), text = ?, pros = COALESCE(?, pros), cons = COALESCE(?, cons),
      answered_on_mp = CASE WHEN ? = 1 THEN 1 ELSE answered_on_mp END,
      mp_answer = COALESCE(?, mp_answer), updated_at = ?
    WHERE id = ?`)
    .run(x.sku ?? null, x.offerId ?? null, x.productName ?? null, x.productUrl ?? null, x.rating ?? null, x.text || '',
      x.pros ?? null, x.cons ?? null, x.answered ? 1 : 0, x.mpAnswer ?? null, now, existing.id);
  return { inserted: false };
}

/**
 * После ПОЛНОГО сбора неотвеченных по направлению: всё, что у нас числится
 * неотвеченным, но площадка больше не отдаёт как неотвеченное, — отвечено
 * (в т.ч. вручную в кабинете). Черновик поверх такого не публикуется.
 */
export function markAnsweredExcept(marketplace: string, kind: string, stillOpenIds: Set<string>): number {
  const d = getDb();
  const open = d.prepare('SELECT id, external_id FROM items WHERE marketplace = ? AND kind = ? AND answered_on_mp = 0')
    .all(marketplace, kind) as any[];
  let n = 0;
  const upd = d.prepare('UPDATE items SET answered_on_mp = 1, updated_at = ? WHERE id = ?');
  for (const r of open) {
    if (!stillOpenIds.has(r.external_id)) { upd.run(Date.now(), r.id); n++; }
  }
  return n;
}

export function getItem(id: number): ReviewItem | null {
  const r = getDb().prepare('SELECT * FROM items WHERE id = ?').get(id);
  return r ? rowToItem(r) : null;
}

export function patchItem(id: number, fields: Record<string, unknown>): void {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  const sql = `UPDATE items SET ${keys.map(k => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`;
  getDb().prepare(sql).run(...keys.map(k => fields[k] as any), Date.now(), id);
}

// ─── Расход Claude ─────────────────────────────────────────────────────────
export function addUsage(purpose: string, model: string, u: { in: number; out: number; cacheRead: number; cacheWrite: number }, costUsd: number): void {
  getDb().prepare('INSERT INTO usage (at, purpose, model, input_tokens, output_tokens, cache_read, cache_write, cost_usd) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(Date.now(), purpose, model, u.in, u.out, u.cacheRead, u.cacheWrite, costUsd);
}

/** Расход раздела с 1-го числа текущего месяца (МСК). */
export function spendThisMonth(): number {
  const now = new Date(Date.now() + 3 * 3600_000);
  const startMsk = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) - 3 * 3600_000;
  const r = getDb().prepare('SELECT COALESCE(SUM(cost_usd), 0) AS s FROM usage WHERE at >= ?').get(startMsk) as any;
  return Number(r?.s || 0);
}

export function usageByDay(days = 31): { day: string; purpose: string; cost: number; calls: number }[] {
  const since = Date.now() - days * 86400_000;
  return getDb().prepare(`SELECT strftime('%Y-%m-%d', (at / 1000) + 10800, 'unixepoch') AS day, purpose,
      SUM(cost_usd) AS cost, COUNT(*) AS calls FROM usage WHERE at >= ? GROUP BY day, purpose ORDER BY day DESC`)
    .all(since) as any[];
}

// ─── Служебные значения (курсоры догрузки истории, профиль стиля) ────────────
export function kvGet<T = any>(key: string, fallback: T): T {
  const r = getDb().prepare('SELECT value FROM kv WHERE key = ?').get(key) as any;
  return r ? safeJson(r.value, fallback) : fallback;
}
export function kvSet(key: string, value: unknown): void {
  getDb().prepare(`INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .run(key, JSON.stringify(value), Date.now());
}
export function kvUpdatedAt(key: string): number | null {
  const r = getDb().prepare('SELECT updated_at FROM kv WHERE key = ?').get(key) as any;
  return r ? r.updated_at : null;
}
