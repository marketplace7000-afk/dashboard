/**
 * Реестр и раннер фоновых агентов.
 *
 * Все агенты регистрируются здесь. Раннер вызывается из telegramBot.ts по
 * расписанию, дедуп берёт из alert_sent (SQLite) — тот же механизм, что у
 * порогов alerts.ts, поэтому агент не спамит одним и тем же сообщением.
 */
import { cacheGet, cacheSet } from '../cache';
import { Agent, AgentSchedule, agentEnabled } from './types';
import { procurementAuditAgent } from './procurementAudit';
import { legalAdvisorAgent } from './legalAdvisor';
import { ozonChangesAgent, wbChangesAgent } from './marketplaceChanges';
import { ozonNewsAgent, wbNewsAgent } from './mpNews';
import { supplyTrackerAgent } from './supplyTracker';
import { adsOzonAgent, adsWbAgent } from './adsAdvisor';

/** Все агенты платформы. Новый агент — добавить строку сюда. */
export const AGENTS: Agent[] = [
  procurementAuditAgent,
  legalAdvisorAgent,
  ozonChangesAgent,
  wbChangesAgent,
  ozonNewsAgent,
  wbNewsAgent,
  supplyTrackerAgent,
  adsWbAgent,
  adsOzonAgent,
];

// Дедуп: одно и то же сообщение не чаще раза в сутки.
const DEDUP_MS = 20 * 60 * 60_000;

/**
 * Дедуп на ДИСКОВОМ кэше, а не в SQLite и не в памяти.
 *
 * Память не переживает рестарт, а SQLite (node:sqlite) на сервере оказался
 * недоступен — из-за этого после каждого деплоя приходили повторы одних и тех же
 * сообщений (жалоба 31.07). Дисковый кэш работает точно: на нём держится весь
 * прогрев данных.
 */
async function alreadySent(key: string): Promise<boolean> {
  const cacheKey = `agent-sent:${key}`;
  const prev = await cacheGet<{ at: number }>(cacheKey);
  if (prev?.data?.at && Date.now() - prev.data.at < DEDUP_MS) return true;
  await cacheSet(cacheKey, { at: Date.now() }, DEDUP_MS);
  return false;
}

/**
 * Прогоняет агентов с нужным расписанием и отправляет новые сообщения.
 * @returns сколько сообщений реально отправлено
 */
export async function runAgents(
  schedule: AgentSchedule,
  send: (text: string) => Promise<void>,
): Promise<number> {
  let sent = 0;
  for (const agent of AGENTS) {
    if (agent.schedule !== schedule) continue;
    if (!agentEnabled(agent.id)) continue;
    try {
      const messages = await agent.run();
      for (const m of messages) {
        if (await alreadySent(m.key)) continue;
        await send(m.text);
        sent++;
      }
    } catch (e) {
      console.warn(`[agent:${agent.id}] сбой:`, (e as Error).message);
    }
  }
  return sent;
}

/** Прогон одного агента по id — для ручной проверки из Telegram. */
export async function runAgentById(
  id: string,
  send: (text: string) => Promise<void>,
): Promise<boolean> {
  const agent = AGENTS.find(a => a.id === id);
  if (!agent) return false;
  const messages = await agent.run();
  if (!messages.length) {
    await send(`✅ <b>${agent.name}</b>: замечаний нет.`);
    return true;
  }
  for (const m of messages) await send(m.text);
  return true;
}
