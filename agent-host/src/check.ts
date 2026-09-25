/**
 * Проверка установки хоста (npm run check): конфиг, доступность сервера,
 * ключ, Chrome с CDP. Ничего не меняет — только диагностика.
 */
import { CONFIG } from './config';
import { heartbeat } from './api';
import { ensureChrome, getBrowser } from './chrome';

async function main(): Promise<void> {
  console.log(`Хост: ${CONFIG.name}`);
  console.log(`Сервер: ${CONFIG.apiUrl}`);

  const chromeOk = await ensureChrome();
  console.log(`Chrome (профиль ${CONFIG.profileDir}, порт ${CONFIG.debugPort}): ${chromeOk ? 'OK' : 'НЕ ПОДНЯЛСЯ — проверьте CHROME_PATH'}`);
  if (chromeOk) {
    try {
      const b = await getBrowser();
      console.log(`CDP: подключение OK (контекстов: ${b.contexts().length})`);
    } catch (e) { console.log(`CDP: ошибка подключения — ${(e as Error).message}`); }
  }

  const hb = await heartbeat(chromeOk);
  console.log(`Heartbeat: ${hb ? `OK (paused: ${hb.paused})` : 'ошибка — проверьте DASHBOARD_API_URL и AGENT_API_KEY'}`);
  if (hb) console.log('\nГотово: хост должен появиться в дашборде, раздел «Сборщики».');
  process.exit(0);
}

void main();
