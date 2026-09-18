// Общая память настроек (16.09.2026): сервер — источник истины, localStorage — зеркало.
// Зачем: архив товаров, глобальные параметры и крутилки сценариев должны быть
// одинаковыми у всех пользователей сайта и переживать смену компьютера/браузера.
// Как: при старте приложения тянем состояние с сервера в localStorage; каждая запись
// через safeSetItem уходит на сервер; раз в 30 с и при фокусе окна проверяем rev и
// подтягиваем чужие изменения, уведомляя подписчиков (компоненты перечитывают себя).
// Синхронизируются только ключи настроек — кэши данных (wb:*, ozon:*) остаются локальными.

const SYNC_PREFIXES = ['avtovibe_', 'prices-wb:', 'prices-ozon:'];
type Snapshot = { rev: number; state: Record<string, string> };

let rev = -1;
let applying = false;
let started = false;
const listeners = new Set<() => void>();

export function isSyncedKey(key: string): boolean {
  return SYNC_PREFIXES.some(p => key.startsWith(p));
}

async function fetchSnapshot(): Promise<Snapshot | null> {
  const r = await fetch('/api/ui-state', { credentials: 'same-origin' });
  if (!r.ok) return null;
  const j = await r.json();
  if (!j || typeof j.rev !== 'number' || !j.state) return null;
  return { rev: j.rev, state: j.state as Record<string, string> };
}

function applySnapshot(state: Record<string, string>): void {
  applying = true;
  try {
    for (const [k, v] of Object.entries(state)) {
      if (!isSyncedKey(k)) continue;
      try { if (localStorage.getItem(k) !== v) localStorage.setItem(k, v); } catch { /* хранилище недоступно */ }
    }
  } finally {
    applying = false;
  }
}

/** Отправить значение на сервер (вызывается из safeSetItem). Не блокирует интерфейс. */
export function pushUiState(key: string, value: string | null): void {
  if (applying || !isSyncedKey(key)) return;
  void fetch('/api/ui-state', {
    method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, value }),
  }).then(r => (r.ok ? r.json() : null)).then(j => { if (j && typeof j.rev === 'number') rev = j.rev; }).catch(() => { /* сеть — подтянем при следующем опросе */ });
}

/** Первая загрузка — до рендера, чтобы компоненты сразу читали серверное состояние. */
export async function loadUiState(): Promise<void> {
  try {
    const snap = await fetchSnapshot();
    if (!snap) return;
    if (snap.rev === 0 && Object.keys(snap.state).length === 0) {
      // Сервер ещё пуст (первый запуск после внедрения): поднимаем туда то, что уже
      // накопилось в этом браузере, чтобы архив и настройки не потерялись.
      rev = 0;
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && isSyncedKey(k)) pushUiState(k, localStorage.getItem(k));
      }
      return;
    }
    applySnapshot(snap.state);
    rev = snap.rev;
  } catch { /* без сети работаем на локальном зеркале */ }
}

/** Подписка компонента: пришли чужие изменения — перечитай себя из localStorage. */
export function onUiStateChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

async function poll(): Promise<void> {
  try {
    const snap = await fetchSnapshot();
    if (!snap || snap.rev === rev) return;
    applySnapshot(snap.state);
    rev = snap.rev;
    listeners.forEach(fn => { try { fn(); } catch { /* подписчик сам разберётся */ } });
  } catch { /* следующий опрос */ }
}

export function startUiStateSync(): void {
  if (started) return;
  started = true;
  setInterval(() => { void poll(); }, 30_000);
  window.addEventListener('focus', () => { void poll(); });
}
