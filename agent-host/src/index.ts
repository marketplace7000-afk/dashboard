/**
 * Хост сети агентов (ТЗ раздел 8): одна программа на ПК, забирает задания из
 * очереди дашборда. Цикл: heartbeat → claim → run → report. Одновременно —
 * одно задание (один браузер, один IP).
 *
 * Запуск: npm start (или планировщик Windows, см. README.md).
 * Остановка: Ctrl+C; текущее задание вернётся в очередь по правилу stale.
 */
import { CONFIG } from './config';
import * as api from './api';
import { ensureChrome } from './chrome';
import { runShowcasePrices } from './scenarios/showcasePrices';
import type { AgentTaskType } from '../../shared/agents';

const SUPPORTED: AgentTaskType[] = ['showcase_prices'];

let running = false;
let stop = false;

async function tick(): Promise<void> {
  if (running) return; // одно задание одновременно
  const chromeOk = await ensureChrome();
  const hb = await api.heartbeat(chromeOk);
  if (!hb) return;                       // сервер недоступен — подождём следующего тика
  if (hb.paused) return;                 // хост на паузе из панели
  if (!chromeOk) {
    api.localLog('[host] Chrome не поднялся — задания не забираю');
    return;
  }
  const claimed = await api.claim(SUPPORTED);
  if (!claimed) return;
  const { task, settings } = claimed;
  running = true;
  api.localLog(`[host] задание #${task.id}: ${task.type} (${String(task.params?.marketplace ?? '')})`);
  try {
    await api.start(task.id);
    if (task.type === 'showcase_prices') {
      await runShowcasePrices(task, settings);
    } else {
      await api.fail(task.id, { error: `сценарий ${task.type} этим хостом не поддерживается`, retryable: false });
    }
  } catch (e) {
    await api.fail(task.id, { error: `хост упал: ${String((e as Error)?.message ?? e).slice(0, 300)}`, retryable: true });
  } finally {
    running = false;
  }
}

async function main(): Promise<void> {
  api.localLog(`[host] старт: ${CONFIG.name} → ${CONFIG.apiUrl}, опрос раз в ${CONFIG.pollSec} с`);
  process.on('SIGINT', () => { stop = true; api.localLog('[host] останавливаюсь…'); });
  while (!stop) {
    try { await tick(); } catch (e) { api.localLog(`[host] tick упал: ${(e as Error).message}`); }
    await new Promise(r => setTimeout(r, CONFIG.pollSec * 1000));
  }
  process.exit(0);
}

void main();
