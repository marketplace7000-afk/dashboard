/**
 * Отчёты «разведки кабинета» (Агент 3 «Реклама», сценарий cabinet_recon, 14.10.2026).
 *
 * Хост на ПК открывает разделы аналитики кабинетов WB/Ozon и присылает, какие
 * JSON-запросы делает страница и как устроены ответы (структура, не данные).
 * По этим отчётам пишутся постоянные сценарии сбора конкурентов и воронки.
 * Храним файлами в CACHE_DIR/recon, последние 20.
 */
import { join } from 'node:path';
import { mkdirSync, writeFileSync, readdirSync, readFileSync, unlinkSync, statSync } from 'node:fs';

const DIR = join(process.env.CACHE_DIR || join(process.cwd(), '.av-cache'), 'recon');
const KEEP = 20;

export function saveRecon(mp: 'wb' | 'ozon', pages: unknown[]): { file: string; pages: number; calls: number } {
  mkdirSync(DIR, { recursive: true });
  const at = new Date();
  const file = `${mp}-${at.toISOString().replace(/[:.]/g, '-')}.json`;
  const calls = (pages as any[]).reduce<number>((s, p) => s + (Array.isArray(p?.calls) ? p.calls.length : 0), 0);
  writeFileSync(join(DIR, file), JSON.stringify({ mp, at: at.getTime(), pages }, null, 1));
  const files = readdirSync(DIR).filter(f => f.endsWith('.json')).sort();
  for (const f of files.slice(0, Math.max(0, files.length - KEEP))) { try { unlinkSync(join(DIR, f)); } catch { /* не критично */ } }
  console.warn(`[agent-recon] ${mp}: разделов ${pages.length}, запросов ${calls} → ${file}`);
  return { file, pages: pages.length, calls };
}

export function listRecon(): { file: string; size: number; at: number }[] {
  try {
    return readdirSync(DIR).filter(f => f.endsWith('.json')).sort().reverse()
      .map(f => { const st = statSync(join(DIR, f)); return { file: f, size: st.size, at: st.mtimeMs }; });
  } catch { return []; }
}

export function readRecon(file: string): unknown | null {
  if (!/^(wb|ozon)-[\w-]+\.json$/.test(file)) return null;
  try { return JSON.parse(readFileSync(join(DIR, file), 'utf8')); } catch { return null; }
}
