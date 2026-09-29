/**
 * ОЧЕРЕДЬ СЕТИ АГЕНТОВ (ТЗ «Сеть агентов», спека 1 «Панель и очередь»).
 *
 * Хранилище — SQLite (node:sqlite, как history.ts): .av-cache/agents.sqlite.
 * Агент без состояния: очередь, журнал, паузы площадок и настройки живут здесь,
 * на ПК — только код и .env (конституция, принцип III).
 *
 * Правила очереди — maintainQueue(): выполняется лениво в начале каждого
 * heartbeat/claim (хост опрашивает раз в 30–60 с, cron не обязателен):
 *   - расписания agent_schedules (enabled, next_run_at <= now) → новое задание;
 *   - running без progress/log > stale_after_min → failed 'stale' (retryable);
 *   - claimed, не ставший running за unclaim_after_min → обратно в queued;
 *   - паузы площадок с истёкшим paused_until → закрываются (cleared_by 'timer');
 *   - поднятый флаг «Проверить цены на витрине» (showcaseRequest) → задание
 *     showcase_prices, если такого нет в очереди. Так существующая кнопка
 *     дашборда работает через агента без изменений на фронте.
 */
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { createHash, timingSafeEqual } from 'node:crypto';
import {
  DEFAULT_AGENT_SETTINGS, SCENARIO_STAGES, TASK_TYPE_TITLES,
  type AgentSettings, type AgentTask, type AgentTaskType, type AgentTaskStatus,
  type AgentProgress, type AgentRunLevel, type Marketplace, type PauseReason,
} from '../../shared/agents';

let DatabaseSync: any = null;
try { DatabaseSync = require('node:sqlite').DatabaseSync; } catch { DatabaseSync = null; }

const DB_DIR = process.env.CACHE_DIR || join(process.cwd(), '.av-cache');
const DB_PATH = join(DB_DIR, 'agents.sqlite');

let db: any = null;
let initFailed = false;

function getDb(): any | null {
  if (db) return db;
  if (initFailed || !DatabaseSync) return null;
  try {
    mkdirSync(DB_DIR, { recursive: true });
    db = new DatabaseSync(DB_PATH);
    db.exec(`
      CREATE TABLE IF NOT EXISTS agents (
        name TEXT PRIMARY KEY,
        last_seen_at INTEGER,
        paused INTEGER NOT NULL DEFAULT 0,
        version TEXT,
        chrome_ok INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        params TEXT NOT NULL DEFAULT '{}',
        priority INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'queued',
        scheduled_for INTEGER NOT NULL,
        claimed_by TEXT, claimed_at INTEGER,
        started_at INTEGER, finished_at INTEGER,
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 2,
        error TEXT,
        created_by TEXT NOT NULL DEFAULT 'panel',
        schedule_id INTEGER,
        progress TEXT, progress_updated_at INTEGER,
        summary TEXT, stats TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON agent_tasks(status, scheduled_for);
      CREATE TABLE IF NOT EXISTS agent_schedules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        params TEXT NOT NULL DEFAULT '{}',
        cron TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 0,
        next_run_at INTEGER,
        last_task_id INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL,
        agent_name TEXT,
        level TEXT NOT NULL DEFAULT 'info',
        message TEXT NOT NULL,
        data TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_runs_task ON agent_runs(task_id, id);
      CREATE TABLE IF NOT EXISTS marketplace_pauses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        marketplace TEXT NOT NULL,
        reason TEXT NOT NULL,
        paused_until INTEGER,           -- NULL = до ручного снятия (login_required)
        task_id INTEGER,
        created_at INTEGER NOT NULL,
        cleared_by TEXT, cleared_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS agent_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    return db;
  } catch (e) {
    initFailed = true;
    console.warn('[agents] SQLite недоступен, очередь агентов выключена:', (e as Error)?.message);
    return null;
  }
}

const now = () => Date.now();
const J = (v: unknown) => JSON.stringify(v ?? null);
const P = <T,>(s: unknown, fb: T): T => { try { return s ? JSON.parse(String(s)) : fb; } catch { return fb; } };

function rowToTask(r: any): AgentTask {
  return {
    id: Number(r.id), type: r.type, params: P(r.params, {} as any), priority: Number(r.priority) || 0,
    status: r.status, scheduled_for: Number(r.scheduled_for),
    claimed_by: r.claimed_by ?? null, claimed_at: r.claimed_at ?? null,
    started_at: r.started_at ?? null, finished_at: r.finished_at ?? null,
    attempts: Number(r.attempts) || 0, max_attempts: Number(r.max_attempts) || 2,
    error: r.error ?? null, created_by: r.created_by, schedule_id: r.schedule_id ?? null,
    progress: P(r.progress, null), progress_updated_at: r.progress_updated_at ?? null,
    summary: r.summary ?? null, stats: P(r.stats, null), created_at: Number(r.created_at),
  };
}

// ─── Авторизация хоста ──────────────────────────────────────────────────────
// Ключ в env AGENT_API_KEY (как RELAY_SECRET/CRON_SECRET — единый .env на
// сервере). Сравнение — по SHA-256, чтобы не гонять строку через timingSafeEqual
// разной длины.
export function agentKeyOk(req: { headers: Record<string, unknown> }): boolean {
  const expected = (process.env.AGENT_API_KEY || '').trim();
  if (!expected) return false;
  const h = String(req.headers['authorization'] || '');
  const got = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  if (!got) return false;
  const a = createHash('sha256').update(got).digest();
  const b = createHash('sha256').update(expected).digest();
  try { return timingSafeEqual(a, b); } catch { return false; }
}

// ─── Настройки ──────────────────────────────────────────────────────────────

export function getSettings(): AgentSettings {
  const d = getDb();
  const out: AgentSettings = { ...DEFAULT_AGENT_SETTINGS };
  if (!d) return out;
  try {
    for (const r of d.prepare('SELECT key, value FROM agent_settings').all()) {
      const k = String(r.key) as keyof AgentSettings;
      if (k in out) (out as any)[k] = P(r.value, (out as any)[k]);
    }
  } catch { /* дефолты */ }
  return out;
}

export function patchSettings(patch: Partial<AgentSettings>): AgentSettings {
  const d = getDb();
  if (d) {
    const st = d.prepare('INSERT INTO agent_settings(key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at');
    for (const [k, v] of Object.entries(patch || {})) {
      if (k in DEFAULT_AGENT_SETTINGS) st.run(k, J(v), now());
    }
  }
  return getSettings();
}

// ─── Хосты ──────────────────────────────────────────────────────────────────

export function heartbeat(name: string, version: string, chromeOk: boolean): { paused: boolean } {
  const d = getDb();
  if (!d) return { paused: false };
  d.prepare(`INSERT INTO agents(name, last_seen_at, version, chrome_ok, created_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(name) DO UPDATE SET last_seen_at=excluded.last_seen_at,
               version=excluded.version, chrome_ok=excluded.chrome_ok`)
    .run(name, now(), version || '', chromeOk ? 1 : 0, now());
  const r = d.prepare('SELECT paused FROM agents WHERE name = ?').get(name);
  return { paused: !!(r?.paused) };
}

export function setAgentPaused(name: string, paused: boolean): boolean {
  const d = getDb();
  if (!d) return false;
  return d.prepare('UPDATE agents SET paused = ? WHERE name = ?').run(paused ? 1 : 0, name).changes > 0;
}

// ─── Журнал ─────────────────────────────────────────────────────────────────

export function addRun(taskId: number, level: AgentRunLevel, message: string, data?: unknown, agentName?: string): void {
  const d = getDb();
  if (!d) return;
  d.prepare('INSERT INTO agent_runs(task_id, agent_name, level, message, data, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(taskId, agentName ?? null, level, String(message).slice(0, 2000), data === undefined ? null : J(data), now());
}

// ─── Паузы площадок ─────────────────────────────────────────────────────────

export function activePauses(): Array<{ id: number; marketplace: Marketplace; reason: PauseReason; paused_until: number | null; task_id: number | null; created_at: number }> {
  const d = getDb();
  if (!d) return [];
  return d.prepare('SELECT id, marketplace, reason, paused_until, task_id, created_at FROM marketplace_pauses WHERE cleared_at IS NULL ORDER BY id DESC').all()
    .map((r: any) => ({ id: Number(r.id), marketplace: r.marketplace, reason: r.reason, paused_until: r.paused_until ?? null, task_id: r.task_id ?? null, created_at: Number(r.created_at) }));
}

export function addPause(marketplace: Marketplace, reason: PauseReason, taskId?: number): void {
  const d = getDb();
  if (!d) return;
  // Одна активная пауза на площадку: свежая заменяет предыдущую.
  d.prepare("UPDATE marketplace_pauses SET cleared_by='replaced', cleared_at=? WHERE marketplace=? AND cleared_at IS NULL").run(now(), marketplace);
  const until = reason === 'login_required' ? null : now() + getSettings().pause_after_captcha_min * 60_000;
  d.prepare('INSERT INTO marketplace_pauses(marketplace, reason, paused_until, task_id, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(marketplace, reason, until, taskId ?? null, now());
}

export function clearPause(id: number, by: string): boolean {
  const d = getDb();
  if (!d) return false;
  return d.prepare('UPDATE marketplace_pauses SET cleared_by=?, cleared_at=? WHERE id=? AND cleared_at IS NULL').run(by, now(), id).changes > 0;
}

// ─── Задания ────────────────────────────────────────────────────────────────

export function createTask(
  type: AgentTaskType,
  params: Record<string, unknown>,
  createdBy: string,
  opts?: { scheduledFor?: number; priority?: number; scheduleId?: number },
): AgentTask | null {
  const d = getDb();
  if (!d) return null;
  const r = d.prepare(`INSERT INTO agent_tasks(type, params, priority, status, scheduled_for, created_by, schedule_id, created_at)
                       VALUES (?, ?, ?, 'queued', ?, ?, ?, ?)`)
    .run(type, J(params ?? {}), opts?.priority ?? 0, opts?.scheduledFor ?? now(), createdBy, opts?.scheduleId ?? null, now());
  const t = getTask(Number(r.lastInsertRowid));
  if (t) addRun(t.id, 'info', `задание создано (${TASK_TYPE_TITLES[type] ?? type}, ${String((params as any)?.marketplace ?? '')})`, { created_by: createdBy });
  return t;
}

export function getTask(id: number): AgentTask | null {
  const d = getDb();
  if (!d) return null;
  const r = d.prepare('SELECT * FROM agent_tasks WHERE id = ?').get(id);
  return r ? rowToTask(r) : null;
}

export function listTasks(filter?: { status?: AgentTaskStatus[]; type?: AgentTaskType; limit?: number }): AgentTask[] {
  const d = getDb();
  if (!d) return [];
  const cond: string[] = []; const args: unknown[] = [];
  if (filter?.status?.length) { cond.push(`status IN (${filter.status.map(() => '?').join(',')})`); args.push(...filter.status); }
  if (filter?.type) { cond.push('type = ?'); args.push(filter.type); }
  const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
  return d.prepare(`SELECT * FROM agent_tasks ${where} ORDER BY id DESC LIMIT ?`).all(...args, filter?.limit ?? 50).map(rowToTask);
}

/** Атомарный claim: queued, срок подошёл, площадка без активной паузы. */
export function claimTask(agentName: string, types: AgentTaskType[]): AgentTask | null {
  const d = getDb();
  if (!d || !types.length) return null;
  const paused = new Set(activePauses().map(p => p.marketplace));
  const rows = d.prepare(`SELECT * FROM agent_tasks WHERE status='queued' AND scheduled_for <= ? AND type IN (${types.map(() => '?').join(',')})
                          ORDER BY priority DESC, id ASC LIMIT 20`).all(now(), ...types);
  for (const r of rows) {
    const mp = P<any>(r.params, {})?.marketplace;
    if (mp && paused.has(mp)) continue;
    const u = d.prepare(`UPDATE agent_tasks SET status='claimed', claimed_by=?, claimed_at=? WHERE id=? AND status='queued'`)
      .run(agentName, now(), r.id);
    if (u.changes > 0) {
      const t = getTask(Number(r.id))!;
      addRun(t.id, 'info', `забрано хостом ${agentName}`, undefined, agentName);
      return t;
    }
  }
  return null;
}

export function startTask(id: number, agentName?: string): AgentTask | null {
  const d = getDb();
  if (!d) return null;
  d.prepare(`UPDATE agent_tasks SET status='running', started_at=?, attempts=attempts+1, progress_updated_at=? WHERE id=? AND status IN ('claimed','running')`).run(now(), now(), id);
  const t = getTask(id);
  if (t) addRun(id, 'info', 'выполнение начато', undefined, agentName);
  return t;
}

export function setProgress(id: number, progress: AgentProgress): AgentTaskStatus | null {
  const d = getDb();
  if (!d) return null;
  const t = getTask(id);
  if (!t) return null;
  if (t.status === 'running') {
    // Смена этапа — в журнал: из этих записей строится таймлайн завершённых заданий.
    if (t.progress?.stage !== progress.stage) {
      addRun(id, 'info', 'stage', { stage: progress.stage, stage_index: progress.stage_index }, t.claimed_by ?? undefined);
    }
    d.prepare('UPDATE agent_tasks SET progress=?, progress_updated_at=? WHERE id=?').run(J(progress), now(), id);
  }
  return getTask(id)?.status ?? null;
}

export function completeTask(id: number, summary: string, stats?: Record<string, number>): AgentTask | null {
  const d = getDb();
  if (!d) return null;
  d.prepare(`UPDATE agent_tasks SET status='done', finished_at=?, summary=?, stats=? WHERE id=? AND status IN ('claimed','running')`)
    .run(now(), String(summary ?? '').slice(0, 500), J(stats ?? null), id);
  const t = getTask(id);
  if (t?.status === 'done') addRun(id, 'info', `готово: ${summary}`, stats);
  return t;
}

export function failTask(id: number, error: string, retryable: boolean, pause?: { marketplace: Marketplace; reason: PauseReason }): AgentTask | null {
  const d = getDb();
  if (!d) return null;
  const t = getTask(id);
  if (!t) return null;
  if (t.status === 'cancelled') {
    // Отменено пользователем: статус не меняем, попытки не растим.
    addRun(id, 'info', 'cancelled_by_user', { error });
    return t;
  }
  const retry = retryable && t.attempts < t.max_attempts && !pause;
  if (retry) {
    d.prepare(`UPDATE agent_tasks SET status='queued', claimed_by=NULL, claimed_at=NULL, error=?, scheduled_for=? WHERE id=?`)
      .run(String(error).slice(0, 500), now() + 5 * 60_000, id);
    addRun(id, 'warn', `ошибка, вернётся в очередь: ${error}`);
  } else {
    d.prepare(`UPDATE agent_tasks SET status='failed', finished_at=?, error=? WHERE id=?`).run(now(), String(error).slice(0, 500), id);
    addRun(id, 'error', `провал: ${error}`);
  }
  if (pause) {
    addPause(pause.marketplace, pause.reason, id);
    addRun(id, 'error', pause.reason, { marketplace: pause.marketplace });
  }
  return getTask(id);
}

export function cancelTask(id: number): AgentTask | null {
  const d = getDb();
  if (!d) return null;
  d.prepare(`UPDATE agent_tasks SET status='cancelled', finished_at=? WHERE id=? AND status IN ('queued','claimed','running')`).run(now(), id);
  const t = getTask(id);
  if (t?.status === 'cancelled') addRun(id, 'info', 'отменено пользователем');
  return t;
}

// ─── Расписания ─────────────────────────────────────────────────────────────
// Cron-формат: только вид "0 6,13,20 * * *" (минута часы * * *) — большего не
// нужно, а полный парсер cron — лишняя зависимость. Время московское.

export function nextCronRun(cron: string, fromMs: number): number | null {
  const m = cron.trim().match(/^(\d{1,2})\s+([\d,]+)\s+\*\s+\*\s+\*$/);
  if (!m) return null;
  const minute = Number(m[1]);
  const hours = m[2].split(',').map(Number).filter(h => h >= 0 && h <= 23).sort((a, b) => a - b);
  if (!hours.length || minute > 59) return null;
  // МСК = UTC+3 без переходов.
  const MSK = 3 * 3600_000;
  const from = fromMs + MSK;
  const day = Math.floor(from / 86_400_000) * 86_400_000;
  for (let d = 0; d < 2; d++) {
    for (const h of hours) {
      const t = day + d * 86_400_000 + h * 3600_000 + minute * 60_000;
      if (t > from) return t - MSK;
    }
  }
  return null;
}

export function listSchedules(): any[] {
  const d = getDb();
  if (!d) return [];
  return d.prepare('SELECT * FROM agent_schedules ORDER BY id').all().map((r: any) => ({
    id: Number(r.id), type: r.type, params: P(r.params, {}), cron: r.cron,
    enabled: !!r.enabled, next_run_at: r.next_run_at ?? null, last_task_id: r.last_task_id ?? null,
  }));
}

export function upsertSchedule(s: { id?: number; type: AgentTaskType; params?: Record<string, unknown>; cron: string; enabled?: boolean }): any {
  const d = getDb();
  if (!d) return null;
  const next = s.enabled ? nextCronRun(s.cron, now()) : null;
  if (s.id) {
    d.prepare('UPDATE agent_schedules SET type=?, params=?, cron=?, enabled=?, next_run_at=? WHERE id=?')
      .run(s.type, J(s.params ?? {}), s.cron, s.enabled ? 1 : 0, next, s.id);
  } else {
    d.prepare('INSERT INTO agent_schedules(type, params, cron, enabled, next_run_at, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(s.type, J(s.params ?? {}), s.cron, s.enabled ? 1 : 0, next, now());
  }
  return listSchedules();
}

// ─── Правила очереди ────────────────────────────────────────────────────────

export function maintainQueue(): void {
  const d = getDb();
  if (!d) return;
  const s = getSettings();
  const t = now();

  // 1. Просроченные паузы площадок — закрыть.
  d.prepare("UPDATE marketplace_pauses SET cleared_by='timer', cleared_at=? WHERE cleared_at IS NULL AND paused_until IS NOT NULL AND paused_until <= ?").run(t, t);

  // 2. running без прогресса — failed 'stale' (вернётся в очередь, если попытки есть).
  for (const r of d.prepare("SELECT id FROM agent_tasks WHERE status='running' AND COALESCE(progress_updated_at, started_at, claimed_at, 0) < ?").all(t - s.stale_after_min * 60_000)) {
    failTask(Number(r.id), 'stale', true);
  }

  // 3. claimed, не ставшие running, — обратно в очередь (без роста attempts).
  d.prepare("UPDATE agent_tasks SET status='queued', claimed_by=NULL, claimed_at=NULL WHERE status='claimed' AND claimed_at < ?").run(t - s.unclaim_after_min * 60_000);

  // 4. Расписания.
  for (const sc of d.prepare('SELECT * FROM agent_schedules WHERE enabled=1 AND next_run_at IS NOT NULL AND next_run_at <= ?').all(t)) {
    const prev = sc.last_task_id ? getTask(Number(sc.last_task_id)) : null;
    const busy = prev && ['queued', 'claimed', 'running'].includes(prev.status);
    const next = nextCronRun(String(sc.cron), t);
    if (busy) {
      if (prev) addRun(prev.id, 'warn', 'запуск по расписанию пропущен: предыдущее задание ещё не завершено');
      d.prepare('UPDATE agent_schedules SET next_run_at=? WHERE id=?').run(next, sc.id);
      continue;
    }
    const task = createTask(sc.type, P(sc.params, {}), 'schedule', { scheduleId: Number(sc.id) });
    d.prepare('UPDATE agent_schedules SET next_run_at=?, last_task_id=? WHERE id=?').run(next, task?.id ?? null, sc.id);
  }

  // 5. Мост со старой кнопкой: поднят флаг «Проверить цены на витрине» → задание.
  try {
    const { getShowcaseRequest } = require('./showcaseRequest');
    const req = getShowcaseRequest();
    for (const mp of ['wb', 'ozon'] as Marketplace[]) {
      if (!req[mp]) continue;
      const open = d.prepare(`SELECT COUNT(*) AS n FROM agent_tasks WHERE type='showcase_prices'
                              AND status IN ('queued','claimed','running')
                              AND params LIKE ?`).get(`%"marketplace":"${mp}"%`);
      if (!Number(open?.n)) createTask('showcase_prices', { marketplace: mp }, 'button');
    }
  } catch { /* модуль флага не критичен */ }
}

// ─── Данные для экрана «В работе» ───────────────────────────────────────────

export function liveState() {
  const d = getDb();
  const s = getSettings();
  if (!d) return { ok: true, disabled: true, hosts: [], tasks: [], queued: [], finished_today: [], pauses: [], runs: [], stages: SCENARIO_STAGES, titles: TASK_TYPE_TITLES, settings: s, now: now() };
  maintainQueue();
  const t = now();
  const hosts = d.prepare('SELECT * FROM agents ORDER BY name').all().map((r: any) => ({
    name: r.name, last_seen_at: r.last_seen_at ?? null, paused: !!r.paused,
    version: r.version ?? '', chrome_ok: !!r.chrome_ok,
    online: !!r.last_seen_at && (t - Number(r.last_seen_at)) < s.offline_after_min * 60_000,
  }));
  const active = listTasks({ status: ['running', 'claimed'], limit: 10 });
  const queued = listTasks({ status: ['queued'], limit: 10 });
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  const finished = d.prepare(`SELECT * FROM agent_tasks WHERE status IN ('done','failed','cancelled') AND finished_at >= ? ORDER BY finished_at DESC LIMIT 20`)
    .all(dayStart.getTime()).map(rowToTask);
  const activeIds = active.map(x => x.id);
  const runs = activeIds.length
    ? d.prepare(`SELECT task_id, level, message, data, created_at FROM agent_runs WHERE task_id IN (${activeIds.map(() => '?').join(',')}) ORDER BY id DESC LIMIT 20`)
      .all(...activeIds).map((r: any) => ({ task_id: Number(r.task_id), level: r.level, message: r.message, data: P(r.data, null), created_at: Number(r.created_at) }))
    : [];
  const schedules = listSchedules();
  return { ok: true, hosts, tasks: active, queued, finished_today: finished, pauses: activePauses(), runs, schedules, stages: SCENARIO_STAGES, titles: TASK_TYPE_TITLES, settings: s, now: t };
}

export function taskTimeline(taskId: number) {
  const d = getDb();
  if (!d) return { ok: true, stages: [] };
  const t = getTask(taskId);
  const rows = d.prepare(`SELECT message, data, created_at FROM agent_runs WHERE task_id=? AND message='stage' ORDER BY id`).all(taskId);
  const stages: Array<{ stage: string; started_at: number; finished_at: number | null }> = [];
  for (const r of rows) {
    const data = P<any>(r.data, {});
    if (stages.length) stages[stages.length - 1].finished_at = Number(r.created_at);
    stages.push({ stage: String(data?.stage ?? '?'), started_at: Number(r.created_at), finished_at: null });
  }
  if (stages.length && t?.finished_at) stages[stages.length - 1].finished_at = t.finished_at;
  return { ok: true, task: t, stages };
}

export function taskRuns(taskId: number, limit = 200) {
  const d = getDb();
  if (!d) return [];
  return d.prepare('SELECT id, agent_name, level, message, data, created_at FROM agent_runs WHERE task_id=? ORDER BY id DESC LIMIT ?')
    .all(taskId, limit)
    .map((r: any) => ({ id: Number(r.id), agent_name: r.agent_name, level: r.level, message: r.message, data: P(r.data, null), created_at: Number(r.created_at) }));
}

// ─── Dev-режим: фиктивное задание, прогресс двигает сам сервер ──────────────
// Спека 1 проверяется до появления хоста: экран «В работе» оживает от таймера.

let devTimer: ReturnType<typeof setInterval> | null = null;

export function startDevTask(marketplace: Marketplace = 'wb'): AgentTask | null {
  const d = getDb();
  if (!d) return null;
  heartbeat('dev-sim', 'dev', true);
  const task = createTask('showcase_prices', { marketplace, skus: [] }, 'dev');
  if (!task) return null;
  claimTask('dev-sim', ['showcase_prices']);
  startTask(task.id, 'dev-sim');
  const stages = SCENARIO_STAGES.showcase_prices;
  let si = 0; let done = 0; const total = 166;
  if (devTimer) clearInterval(devTimer);
  devTimer = setInterval(() => {
    try {
      const cur = getTask(task.id);
      if (!cur || cur.status !== 'running') { if (devTimer) clearInterval(devTimer); devTimer = null; return; }
      const st = stages[si];
      done += st.counted ? Math.ceil(Math.random() * 14) : 0;
      const finishedStage = !st.counted || done >= total;
      setProgress(task.id, {
        stage: st.stage, stage_index: si + 1, stages_total: stages.length,
        items_done: st.counted ? Math.min(done, total) : undefined,
        items_total: st.counted ? total : undefined,
        current_item: st.counted ? `demo:${1000000 + done}` : null,
        message: `${st.title} (демо) — ${st.counted ? `${Math.min(done, total)} из ${total}` : 'выполняется'}`,
        eta_sec: (stages.length - si) * 8,
      });
      heartbeat('dev-sim', 'dev', true);
      if (finishedStage) { si++; done = 0; }
      if (si >= stages.length) {
        completeTask(task.id, `демо-прогон завершён, ${total} из ${total}`, { found_on_showcase: total, found_direct: 0, missing: 0, total });
        if (devTimer) clearInterval(devTimer); devTimer = null;
      }
    } catch { if (devTimer) clearInterval(devTimer); devTimer = null; }
  }, 2000);
  return getTask(task.id);
}
