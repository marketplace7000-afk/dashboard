// Общая память настроек интерфейса (16.09.2026, просьба клиента): архив товаров,
// глобальные параметры цен, ручные крутилки сценариев — всё, что раньше жило только в
// localStorage одного браузера и пропадало у менеджера / на другом компьютере.
// Сервер — источник истины, браузеры держат зеркало в localStorage (см. src/utils/uiState.ts).
// Значения — строки ровно в том виде, в каком фронт кладёт их в localStorage (JSON-строки).
import fs from 'node:fs';
import path from 'node:path';

const DIR = process.env.CACHE_DIR || path.join(process.cwd(), '.av-cache');
const FILE = path.join(DIR, 'ui-state.json');
const MAX_VALUE = 200_000;

type Store = { rev: number; state: Record<string, string> };
let mem: Store | null = null;

function load(): Store {
  if (mem) return mem;
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    mem = { rev: Number(j?.rev) || 0, state: (j?.state && typeof j.state === 'object') ? j.state : {} };
  } catch {
    mem = { rev: 0, state: {} };
  }
  return mem;
}

function persist(): void {
  const st = load();
  fs.mkdirSync(DIR, { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(st));
  fs.renameSync(tmp, FILE);
}

export function getUiState(): Store {
  const st = load();
  return { rev: st.rev, state: { ...st.state } };
}

export function setUiState(key: string, value: string | null): Store {
  const st = load();
  if (value === null) delete st.state[key];
  else st.state[key] = value;
  st.rev += 1;
  persist();
  return getUiState();
}

export function validUiKey(key: unknown): key is string {
  return typeof key === 'string' && key.length > 0 && key.length <= 200 && /^[\w:.\-]+$/.test(key);
}
export function validUiValue(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && value.length <= MAX_VALUE);
}
