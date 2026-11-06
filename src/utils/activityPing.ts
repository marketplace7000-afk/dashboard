/**
 * Отметки «человек на месте» для листа «Активность» в «Доступах»
 * (сервер: api/_lib/activity.ts). Раз в минуту, пока вкладка открыта на
 * экране, и сразу при смене раздела. active — за последние 3 минуты были
 * мышь, клавиатура, прокрутка или касание. Ошибки молча пропускаем: учёт не
 * должен мешать работе.
 */
import { useEffect } from 'react';

const ACTIVE_WINDOW_MS = 3 * 60_000;
let lastInput = Date.now();
let listening = false;

function listen(): void {
  if (listening || typeof window === 'undefined') return;
  listening = true;
  const mark = () => { lastInput = Date.now(); };
  for (const ev of ['pointerdown', 'pointermove', 'keydown', 'wheel', 'scroll', 'touchstart']) {
    window.addEventListener(ev, mark, { passive: true, capture: true });
  }
}

function ping(section: string, view: boolean): void {
  if (document.visibilityState !== 'visible') return;
  fetch('/api/activity/ping', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ section, view, active: Date.now() - lastInput < ACTIVE_WINDOW_MS }),
    keepalive: true,
  }).catch(() => { /* учёт активности необязателен */ });
}

export function useActivityPing(enabled: boolean, section: string): void {
  useEffect(() => {
    if (!enabled) return;
    listen();
    ping(section, true);
    const t = setInterval(() => ping(section, false), 60_000);
    const onShow = () => { if (document.visibilityState === 'visible') ping(section, false); };
    document.addEventListener('visibilitychange', onShow);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', onShow); };
  }, [enabled, section]);
}
