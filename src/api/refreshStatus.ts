/**
 * Клиент для /api/meta/status и троттлинг ручного обновления.
 *
 * Идея: данные с маркетплейсов обновляются автоматически по cron-у (раз в сутки
 * на Vercel Hobby; на проде — каждый час). Пользователь видит «последнее
 * обновление: дата/время». Кнопка «Обновить» работает, но с лимитом —
 * не чаще 1 раза в 10 минут на namespace, чтобы не словить 429 от WB/Ozon.
 */
import { noteSwallowed } from '../utils/log';

export type MetaStatus = {
  ok: boolean;
  now: number;
  cronSchedule: string;
  cronSource: string;
  /** dataAt — когда сами данные получены от площадки (а не когда отработал сборщик). */
  namespaces: Record<string, { lastRefreshAt: number; freshness: number; dataAt?: number | null } | null>;
};

const THROTTLE_MS = 10 * 60_000; // 10 минут между ручными обновлениями на ns

let cached: { at: number; data: MetaStatus } | null = null;
const subs = new Set<(s: MetaStatus | null) => void>();

export async function fetchMetaStatus(force = false): Promise<MetaStatus | null> {
  if (!force && cached && Date.now() - cached.at < 60_000) return cached.data;
  try {
    const r = await fetch('/api/meta/status', { credentials: 'include' });
    if (!r.ok) return cached?.data ?? null;
    const data = await r.json() as MetaStatus;
    cached = { at: Date.now(), data };
    subs.forEach(cb => cb(data));
    return data;
  } catch { return cached?.data ?? null; }
}

export function subscribeMetaStatus(cb: (s: MetaStatus | null) => void): () => void {
  subs.add(cb);
  if (cached) cb(cached.data);
  return () => subs.delete(cb);
}

// ─── Ручной троттл ──────────────────────────────────────────────────────────
function lsKey(ns: string) { return `refresh-throttle:${ns}`; }

export function canManualRefresh(ns: string): { allowed: boolean; nextAt?: number; remainingMs?: number } {
  try {
    const raw = localStorage.getItem(lsKey(ns));
    if (!raw) return { allowed: true };
    const last = Number(raw);
    if (!last) return { allowed: true };
    const remaining = THROTTLE_MS - (Date.now() - last);
    if (remaining <= 0) return { allowed: true };
    return { allowed: false, nextAt: last + THROTTLE_MS, remainingMs: remaining };
  } catch (e) {
    // Не смогли прочитать отметку — разрешаем обновление. Без записи неисправный
    // localStorage превратил бы защиту от частых обновлений в фикцию.
    noteSwallowed('refresh', 'отметка обновления не прочитана', e);
    return { allowed: true };
  }
}

export function markManualRefresh(ns: string): void {
  try { localStorage.setItem(lsKey(ns), String(Date.now())); }
  catch (e) { noteSwallowed('refresh', 'отметка обновления не записана', e); }
}

// ─── Форматирование «обновлено N назад» ─────────────────────────────────────
export function fmtAgo(at?: number): string {
  if (!at) return 'нет данных';
  const diffMs = Date.now() - at;
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return 'только что';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} мин назад`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} ч назад`;
  const d = Math.floor(h / 24);
  return `${d} дн назад`;
}

export function fmtTime(at?: number): string {
  if (!at) return '—';
  return new Date(at).toLocaleString('ru-RU', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}
