/**
 * Активность сотрудников (06.11.2026) — лист «Активность» в «Доступах».
 *
 * Владелец хочет видеть, когда человек начал и закончил работу, сколько был
 * на месте и какие разделы открывал. Источники:
 *   - кабинет раз в минуту, пока вкладка открыта на экране, шлёт
 *     POST /api/activity/ping { section, active } — active = за последние
 *     3 минуты были мышь, клавиатура или касание;
 *   - при переходе в другой раздел — ping с view: true (журнал посещений);
 *   - вход (удачный и нет) и выход пишет /api/auth/*.
 *
 * Минута хранится одной строкой (uid, minute): сколько ни шли запросов —
 * 1 человек × 1440 минут в сутки максимум. Вход по общему паролю владельца —
 * uid 0. Хранится 180 дней. База .av-cache/activity.sqlite (своя, чтобы не
 * делить номера миграций со «Складом»).
 *
 *   GET /api/access/activity?day=YYYY-MM-DD      → сводка по всем за день (МСК)
 *   GET /api/access/activity?uid=N&days=14       → один человек по дням
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { VercelRequest } from '@vercel/node';
import { mskDate } from './mskDate';

let DatabaseSync: any = null;
try { DatabaseSync = require('node:sqlite').DatabaseSync; } catch { DatabaseSync = null; }

const MSK_OFFSET_MS = 3 * 3_600_000;
const DAY_MS = 86_400_000;
const KEEP_DAYS = 180;
/** uid для входа по общему паролю владельца. */
export const OWNER_UID = 0;

let db: any = null;
function getDb(): any {
  if (db) return db;
  if (!DatabaseSync) throw new Error('База активности недоступна на сервере (нужен Node 22.5+)');
  const dir = process.env.CACHE_DIR || join(process.cwd(), '.av-cache');
  mkdirSync(dir, { recursive: true });
  db = new DatabaseSync(join(dir, 'activity.sqlite'));
  db.exec(`
    PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS act_minute (
      uid INTEGER NOT NULL, minute INTEGER NOT NULL, section TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (uid, minute));
    CREATE TABLE IF NOT EXISTS act_event (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, uid INTEGER, login TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL, section TEXT NOT NULL DEFAULT '', ip TEXT NOT NULL DEFAULT '', ua TEXT NOT NULL DEFAULT '');
    CREATE INDEX IF NOT EXISTS act_event_ts ON act_event(ts);
    CREATE INDEX IF NOT EXISTS act_event_uid ON act_event(uid, ts);
  `);
  return db;
}

/** Только для проверок: закрыть базу, чтобы удалить временный файл. */
export function closeActivityDb(): void {
  if (db) { try { db.close(); } catch { /* уже закрыта */ } db = null; }
}

let lastPrune = 0;
function prune(): void {
  if (Date.now() - lastPrune < 6 * 3_600_000) return;
  lastPrune = Date.now();
  const edge = Date.now() - KEEP_DAYS * DAY_MS;
  getDb().prepare('DELETE FROM act_minute WHERE minute < ?').run(Math.floor(edge / 60_000));
  getDb().prepare('DELETE FROM act_event WHERE ts < ?').run(edge);
}

const SECTION_RE = /^[a-z0-9-]{1,32}$/;

/** Отметка «человек на месте» за текущую минуту. */
export function notePing(uid: number, section: string, active: boolean, view: boolean, at = Date.now()): void {
  const s = SECTION_RE.test(section) ? section : '';
  const minute = Math.floor(at / 60_000);
  getDb().prepare(`INSERT INTO act_minute (uid, minute, section, active) VALUES (?, ?, ?, ?)
    ON CONFLICT(uid, minute) DO UPDATE SET section = CASE WHEN excluded.section <> '' THEN excluded.section ELSE section END,
      active = MAX(active, excluded.active)`).run(uid, minute, s, active ? 1 : 0);
  if (view && s) getDb().prepare('INSERT INTO act_event (ts, uid, kind, section) VALUES (?, ?, ?, ?)').run(at, uid, 'view', s);
  prune();
}

/** Вход, неудачный вход, выход. uid null — неудачный вход по неизвестному логину. */
export function noteAuthEvent(req: VercelRequest, kind: 'login' | 'login_fail' | 'logout', uid: number | null, login: string, ip: string): void {
  const ua = String(req.headers['user-agent'] ?? '').slice(0, 300);
  getDb().prepare('INSERT INTO act_event (ts, uid, login, kind, ip, ua) VALUES (?, ?, ?, ?, ?, ?)')
    .run(Date.now(), uid, login.slice(0, 64), kind, ip.slice(0, 64), ua);
}

// ─── Отчёт ─────────────────────────────────────────────────────────────────

export type ActivityDay = {
  day: string;
  /** Первая и последняя минута на сайте (мс), null — не заходил. */
  first: number | null; last: number | null;
  /** Минут на сайте (вкладка открыта на экране) и из них активных. */
  onlineMin: number; activeMin: number;
  /** Активные минуты по часам МСК, 24 значения. */
  hours: number[];
  /** Минуты по разделам, по убыванию. */
  sections: Array<{ section: string; min: number; views: number }>;
  logins: Array<{ ts: number; ip: string; device: string }>;
  failedLogins: number;
};

function dayBounds(day: string): [number, number] {
  const start = Date.parse(day + 'T00:00:00Z') - MSK_OFFSET_MS;
  return [start, start + DAY_MS];
}

/** «Chrome · Windows» из user-agent — чтобы видеть, с чего заходили. */
export function deviceOf(ua: string): string {
  if (!ua) return '';
  const os = /iPhone|iPad/.test(ua) ? 'iPhone/iPad' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows'
    : /Mac OS X/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : '';
  const br = /YaBrowser/.test(ua) ? 'Яндекс Браузер' : /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera'
    : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '';
  return [br, os].filter(Boolean).join(' · ') || ua.slice(0, 40);
}

/** login — для неудачных входов (их пишем по логину: пароль не подошёл — учётка неизвестна); у владельца ''. */
export function dayReport(uid: number, login: string, day: string): ActivityDay {
  const [from, to] = dayBounds(day);
  const d = getDb();
  const mins = d.prepare('SELECT minute, section, active FROM act_minute WHERE uid = ? AND minute >= ? AND minute < ? ORDER BY minute')
    .all(uid, Math.floor(from / 60_000), Math.floor(to / 60_000)) as Array<{ minute: number; section: string; active: number }>;
  const events = d.prepare(`SELECT ts, kind, section, ip, ua FROM act_event WHERE uid = ? AND ts >= ? AND ts < ? ORDER BY ts`)
    .all(uid, from, to) as Array<{ ts: number; kind: string; section: string; ip: string; ua: string }>;
  const hours = Array(24).fill(0);
  const bySection = new Map<string, { min: number; views: number }>();
  let activeMin = 0;
  for (const m of mins) {
    if (m.active) { activeMin++; hours[Math.floor((m.minute * 60_000 - from) / 3_600_000)]++; }
    const s = bySection.get(m.section) ?? { min: 0, views: 0 };
    s.min++; bySection.set(m.section, s);
  }
  for (const e of events) {
    if (e.kind !== 'view') continue;
    const s = bySection.get(e.section) ?? { min: 0, views: 0 };
    s.views++; bySection.set(e.section, s);
  }
  return {
    day,
    first: mins.length ? mins[0].minute * 60_000 : null,
    last: mins.length ? mins[mins.length - 1].minute * 60_000 + 59_999 : null,
    onlineMin: mins.length, activeMin, hours,
    sections: [...bySection].filter(([s]) => s).map(([section, v]) => ({ section, ...v })).sort((a, b) => b.min - a.min || b.views - a.views),
    logins: events.filter(e => e.kind === 'login').map(e => ({ ts: e.ts, ip: e.ip, device: deviceOf(e.ua) })),
    failedLogins: Number((d.prepare(`SELECT COUNT(*) AS n FROM act_event WHERE kind = 'login_fail' AND lower(login) = lower(?) AND ts >= ? AND ts < ?`)
      .get(login, from, to) as any).n),
  };
}

/** Последнее появление на сайте — для людей, которые сегодня не заходили. */
export function lastSeen(uid: number): number | null {
  const r = getDb().prepare('SELECT MAX(minute) AS m FROM act_minute WHERE uid = ?').get(uid) as any;
  return r?.m ? r.m * 60_000 : null;
}

/** Неудачные входы по логинам, которых нет среди учёток (подбор) — за день. */
export function unknownFailures(day: string, knownLogins: string[]): Array<{ login: string; count: number; lastTs: number; ip: string }> {
  const [from, to] = dayBounds(day);
  const rows = getDb().prepare(`SELECT login, COUNT(*) AS n, MAX(ts) AS t, MAX(ip) AS ip FROM act_event
    WHERE kind = 'login_fail' AND login <> '' AND ts >= ? AND ts < ? GROUP BY login ORDER BY n DESC LIMIT 50`).all(from, to) as any[];
  const known = new Set(knownLogins.map(l => l.toLowerCase()));
  return rows.filter(r => !known.has(String(r.login).toLowerCase())).map(r => ({ login: r.login || '(без логина)', count: Number(r.n), lastTs: Number(r.t), ip: r.ip }));
}

export function isDay(s: unknown): s is string {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

export function daysBack(n: number): string[] {
  return Array.from({ length: n }, (_, i) => mskDate(i));
}
