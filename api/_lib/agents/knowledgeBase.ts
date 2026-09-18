/**
 * База знаний по маркетплейсам — единое место, куда агенты складывают тезисы.
 *
 * Зачем: раньше агенты 6, 7 (тарифы/комиссии), новости и юрист жили порознь и
 * писали разрозненные сообщения в Telegram, которые терялись в переписке.
 * Клиент попросил один раздел, где по каждой площадке копится нужная информация
 * тезисно. Теперь агенты пишут сюда, а Telegram-сообщение — лишь уведомление
 * о новом тезисе.
 *
 * Хранилище: тот же встроенный node:sqlite, что и history.ts. Если он недоступен
 * (старый Node) — модуль превращается в no-op, ничего не падает.
 */
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { noteSwallowed } from '../log';

let DatabaseSync: any = null;
try {
  DatabaseSync = require('node:sqlite').DatabaseSync;
} catch {
  DatabaseSync = null;
}

const DB_DIR = process.env.CACHE_DIR || join(process.cwd(), '.av-cache');
const DB_PATH = join(DB_DIR, 'history.sqlite');   // одна БД на проект

export type Marketplace = 'wb' | 'ozon';

/** Категория тезиса — чтобы в интерфейсе можно было отфильтровать. */
export type ThesisCategory = 'тарифы' | 'комиссии' | 'правила' | 'склады' | 'реклама' | 'прочее';

export type Thesis = {
  id?: number;
  mp: Marketplace;
  date: string;              // YYYY-MM-DD — дата события/новости
  category: ThesisCategory;
  text: string;              // сам тезис, 1-3 предложения
  impact?: string | null;    // что это значит для нас
  action?: string | null;    // что делать
  source?: string | null;    // ссылка или «официальный API»
  createdAt?: number;
};

let db: any = null;
let initFailed = false;

function getDb(): any | null {
  if (db) return db;
  if (initFailed || !DatabaseSync) return null;
  try {
    mkdirSync(DB_DIR, { recursive: true });
    db = new DatabaseSync(DB_PATH);
    db.exec(`
      CREATE TABLE IF NOT EXISTS mp_knowledge (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        mp         TEXT NOT NULL,
        date       TEXT NOT NULL,
        category   TEXT NOT NULL,
        text       TEXT NOT NULL,
        impact     TEXT,
        action     TEXT,
        source     TEXT,
        dedup_key  TEXT UNIQUE,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_knowledge_mp_date ON mp_knowledge(mp, date DESC);
    `);
    return db;
  } catch (e) {
    console.warn('[knowledge] SQLite недоступен, база знаний выключена:', (e as Error).message);
    initFailed = true;
    return null;
  }
}

/** Ключ дедупа: один и тот же тезис не должен попасть в базу дважды. */
function dedupKey(t: Thesis): string {
  return `${t.mp}:${t.date}:${t.text.slice(0, 120).toLowerCase().replace(/\s+/g, ' ')}`;
}

/**
 * Добавляет тезисы. Дубликаты игнорируются молча.
 * @returns сколько РЕАЛЬНО добавилось новых
 */
export function addTheses(items: Thesis[]): number {
  const d = getDb();
  if (!d || !items.length) return 0;
  let added = 0;
  const stmt = d.prepare(`
    INSERT OR IGNORE INTO mp_knowledge (mp, date, category, text, impact, action, source, dedup_key, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const t of items) {
    try {
      const r = stmt.run(
        t.mp, t.date, t.category, t.text,
        t.impact ?? null, t.action ?? null, t.source ?? null,
        dedupKey(t), Date.now(),
      );
      if (r?.changes) added++;
    } catch (e) {
      // Один битый тезис не должен ронять остальные, но и пропадать молча тоже:
      // если ломается каждый, база знаний просто перестанет пополняться.
      noteSwallowed('knowledge', 'тезис не записан в базу', e);
    }
  }
  return added;
}

/** Тезисы для интерфейса и для контекста юриста. */
export function getTheses(opts: { mp?: Marketplace; limit?: number; days?: number } = {}): Thesis[] {
  const d = getDb();
  if (!d) return [];
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  try {
    const where: string[] = [];
    const params: any[] = [];
    if (opts.mp) { where.push('mp = ?'); params.push(opts.mp); }
    if (opts.days) {
      const from = new Date(Date.now() - opts.days * 86_400_000).toISOString().slice(0, 10);
      where.push('date >= ?'); params.push(from);
    }
    const sql = `SELECT * FROM mp_knowledge${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY date DESC, id DESC LIMIT ?`;
    params.push(limit);
    const rows = d.prepare(sql).all(...params) as any[];
    return rows.map(r => ({
      id: r.id, mp: r.mp, date: r.date, category: r.category, text: r.text,
      impact: r.impact, action: r.action, source: r.source, createdAt: r.created_at,
    }));
  } catch {
    return [];
  }
}

/** Сводка для контекста юриста: последние тезисы одной строкой на пункт. */
export function thesesAsContext(days = 90): string {
  const rows = getTheses({ days, limit: 60 });
  if (!rows.length) return '';
  return rows
    .map(r => `- [${r.mp.toUpperCase()} ${r.date} · ${r.category}] ${r.text}${r.impact ? ` (влияние: ${r.impact})` : ''}`)
    .join('\n');
}
