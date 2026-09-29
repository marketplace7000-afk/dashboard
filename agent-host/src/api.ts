/**
 * Клиент API дашборда (ТЗ раздел 6.1). Связь всегда инициирует хост:
 * ПК за роутером, серверу доступ к ПК не нужен.
 *
 * Локальный журнал: logs/agent.log с ротацией 7 дней — отладка при отсутствии
 * сети. Всё остальное состояние — на сервере (конституция, принцип III).
 */
import { appendFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG } from './config';
import {
  AGENT_HOST_VERSION, DEFAULT_AGENT_SETTINGS,
  type AgentProgress, type AgentSettings, type AgentTask, type AgentTaskType,
  type AgentTaskStatus, type FailReq,
} from '../../shared/agents';

const LOG_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'logs');

export function localLog(line: string): void {
  const ts = new Date().toISOString();
  console.log(`${ts} ${line}`);
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    const day = ts.slice(0, 10);
    appendFileSync(join(LOG_DIR, `agent-${day}.log`), `${ts} ${line}\n`);
    // Ротация: файлы старше 7 дней удаляются.
    const cutoff = Date.now() - 7 * 86_400_000;
    for (const f of readdirSync(LOG_DIR)) {
      const m = f.match(/^agent-(\d{4}-\d{2}-\d{2})\.log$/);
      if (m && new Date(m[1]).getTime() < cutoff) unlinkSync(join(LOG_DIR, f));
    }
  } catch { /* локальный журнал не критичен */ }
}

async function call<T>(path: string, body: unknown): Promise<{ status: number; json: T | null }> {
  const res = await fetch(`${CONFIG.apiUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CONFIG.apiKey}` },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(45_000),
  });
  if (res.status === 204) return { status: 204, json: null };
  let json: T | null = null;
  try { json = await res.json() as T; } catch { /* не-JSON */ }
  if (res.status === 401) { localLog('[api] сервер не принял ключ агента (401) — проверьте AGENT_API_KEY'); }
  return { status: res.status, json };
}

export async function heartbeat(chromeOk: boolean): Promise<{ paused: boolean } | null> {
  try {
    const r = await call<{ ok: boolean; paused: boolean }>(`/api/agent/heartbeat`, {
      name: CONFIG.name, version: AGENT_HOST_VERSION, chrome_ok: chromeOk,
    });
    return r.json ? { paused: !!r.json.paused } : null;
  } catch (e) { localLog(`[api] heartbeat не прошёл: ${(e as Error).message}`); return null; }
}

export async function claim(types: AgentTaskType[]): Promise<{ task: AgentTask; settings: AgentSettings } | null> {
  try {
    const r = await call<{ task: AgentTask; settings: AgentSettings }>(`/api/agent/tasks/claim`, { name: CONFIG.name, types });
    if (r.status === 204 || !r.json?.task) return null;
    return { task: r.json.task, settings: { ...DEFAULT_AGENT_SETTINGS, ...(r.json.settings ?? {}) } };
  } catch (e) { localLog(`[api] claim не прошёл: ${(e as Error).message}`); return null; }
}

export async function start(taskId: number): Promise<void> {
  await call(`/api/agent/tasks/${taskId}/start`, {}).catch(() => null);
}

/** Возвращает актуальный статус задания — 'cancelled' значит прерваться. */
export async function log(taskId: number, level: 'info' | 'warn' | 'error', message: string, data?: unknown): Promise<AgentTaskStatus | null> {
  localLog(`[task ${taskId}] ${level}: ${message}`);
  try {
    const r = await call<{ status: AgentTaskStatus }>(`/api/agent/tasks/${taskId}/log`, { level, message, data });
    return r.json?.status ?? null;
  } catch { return null; }
}

let lastProgressAt = 0;
/** Прогресс: при смене этапа шлётся всегда, внутри этапа — не чаще раза в 5 с. */
export async function progress(taskId: number, p: AgentProgress, stageChanged = false): Promise<AgentTaskStatus | null> {
  const now = Date.now();
  if (!stageChanged && now - lastProgressAt < 5_000) return null;
  lastProgressAt = now;
  try {
    const r = await call<{ status: AgentTaskStatus }>(`/api/agent/tasks/${taskId}/progress`, p);
    return r.json?.status ?? null;
  } catch { return null; } // ошибка отправки прогресса не прерывает задание
}

export async function complete(taskId: number, summary: string, stats?: Record<string, number>): Promise<void> {
  localLog(`[task ${taskId}] done: ${summary}`);
  await call(`/api/agent/tasks/${taskId}/complete`, { summary, stats }).catch(() => null);
}

export async function fail(taskId: number, body: FailReq): Promise<void> {
  localLog(`[task ${taskId}] fail: ${body.error}${body.pause ? ` (пауза ${body.pause.marketplace}: ${body.pause.reason})` : ''}`);
  await call(`/api/agent/tasks/${taskId}/fail`, body).catch(() => null);
}

export async function ingest(path: 'wb-showcase-ingest' | 'ozon-showcase-ingest', items: Record<string, { price: number; oldPrice?: number }>): Promise<boolean> {
  try {
    const r = await call<{ ok: boolean }>(`/api/${path}`, { items });
    return r.status === 200 && !!r.json?.ok;
  } catch (e) { localLog(`[api] ingest не прошёл: ${(e as Error).message}`); return false; }
}
