// Кнопка «Обновить цены покупателя» (с паролем): флаг на сервере для обеих витрин + ожидание, пока Claude их снимет.
import { useCallback, useEffect, useRef, useState } from 'react';

export type ShowcaseCheck = {
  pending: { wb: number | null; ozon: number | null };
  lastCheck: { wb: number | null; ozon: number | null };
};

export function useShowcaseCheck(mp: 'wb' | 'ozon', onDone: () => void) {
  const [st, setSt] = useState<ShowcaseCheck | null>(null);
  const [busy, setBusy] = useState(false);
  const [pinOpen, setPinOpen] = useState(false);
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const onDoneRef = useRef(onDone); onDoneRef.current = onDone;
  const load = useCallback(async (): Promise<ShowcaseCheck | null> => {
    try { const r = await fetch('/api/showcase-check', { credentials: 'same-origin' }); if (!r.ok) return null; const j = await r.json(); setSt(j); return j; }
    catch { return null; }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const pending = st?.pending?.[mp] ?? null;
  useEffect(() => {
    if (!pending) return;
    const id = setInterval(async () => { const j = await load(); if (j && !j.pending[mp]) onDoneRef.current(); }, 45_000);
    return () => clearInterval(id);
  }, [pending, mp, load]);
  const openPin = useCallback(() => { setPin(''); setError(null); setPinOpen(true); }, []);
  const closePin = useCallback(() => { setPinOpen(false); setPin(''); setError(null); }, []);
  // Одна кнопка — обе витрины (WB и Ozon): менеджер думает про «цены покупателя», а не про площадки.
  const submit = useCallback(async () => {
    if (!pin.trim()) { setError('Введите пароль'); return; }
    setBusy(true); setError(null);
    try {
      const r = await fetch('/api/showcase-check', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mp: 'all', pin: pin.trim() }) });
      if (r.status === 403) { setError('Неверный пароль'); return; }
      if (!r.ok) { setError('Не удалось отправить запрос'); return; }
      setSt(await r.json()); setPinOpen(false); setPin('');
    } catch { setError('Нет связи с сервером'); }
    finally { setBusy(false); }
  }, [pin]);
  return { pending, lastCheck: st?.lastCheck?.[mp] ?? null, busy, pinOpen, pin, setPin, openPin, closePin, submit, error };
}
