/**
 * «Сборщики»: живые данные GET /api/agents/live раз в 4 с, пока вкладка видима
 * (скрыта — раз в 30 с), и команды POST. Отказ сервера на команду — в cmdErr.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { notifyUnauthorized } from '../../api/http';
import type { Live } from './model';

export function useAgentsLive() {
  const [live, setLive] = useState<Live | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cmdErr, setCmdErr] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/agents/live', { credentials: 'include' });
      notifyUnauthorized(r.status);
      if (!r.ok) { setErr(`сервер ответил ${r.status}`); return; }
      setLive(await r.json()); setErr(null);
    } catch { setErr('нет связи с сервером'); }
  }, []);

  useEffect(() => {
    void load();
    const start = () => {
      if (timer.current) clearInterval(timer.current);
      timer.current = setInterval(load, document.hidden ? 30_000 : 4_000);
    };
    start();
    document.addEventListener('visibilitychange', start);
    return () => { if (timer.current) clearInterval(timer.current); document.removeEventListener('visibilitychange', start); };
  }, [load]);

  const post = useCallback(async (url: string, bodyObj?: unknown) => {
    setBusy(true);
    // Отказ сервера показываем: раньше «Пауза»/«Запустить» при ошибке молчали,
    // и казалось, что команда выполнилась.
    try {
      const r = await fetch(url, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(bodyObj ?? {}) });
      notifyUnauthorized(r.status);
      if (!r.ok) {
        const j = await r.json().catch(() => null);
        setCmdErr(`Команда не выполнена: ${j?.reason ?? j?.error ?? `сервер ответил ${r.status}`}`);
      } else setCmdErr(null);
    } catch { setCmdErr('Команда не выполнена: нет связи с сервером'); }
    finally { setBusy(false); void load(); }
  }, [load]);

  const cancel = useCallback((id: number) => { void post(`/api/agents/tasks/${id}/cancel`); }, [post]);

  return { live, err, busy, cmdErr, post, cancel };
}
