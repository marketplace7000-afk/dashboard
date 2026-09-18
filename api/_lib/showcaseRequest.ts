// Запрос «Проверить цены на витрине» из дашборда (17.09.2026).
// Сервер сам витрину открыть не может (антибот WB/Ozon), её снимает Routine через Chrome
// пользователя. Кнопка ставит флаг, Routine (раз в час) читает /api/showcase-check и
// открывает витрину только если флаг поднят или прошлый снимок старше STALE_MS.
import fs from 'node:fs';
import path from 'node:path';

const DIR = process.env.CACHE_DIR || path.join(process.cwd(), '.av-cache');
const FILE = path.join(DIR, 'showcase-request.json');
export const STALE_MS = 3.5 * 60 * 60_000; // без запроса — как раньше, примерно раз в 4 часа

export type Mp = 'wb' | 'ozon';
export type ShowcaseRequest = { wb: number | null; ozon: number | null }; // время запроса (ms) или null

function load(): ShowcaseRequest {
  try { const j = JSON.parse(fs.readFileSync(FILE, 'utf8')); return { wb: Number(j?.wb) || null, ozon: Number(j?.ozon) || null }; }
  catch { return { wb: null, ozon: null }; }
}
function save(r: ShowcaseRequest): void { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(r)); }

export function getShowcaseRequest(): ShowcaseRequest { return load(); }
export function requestShowcaseCheck(mp: Mp | 'all'): ShowcaseRequest {
  const r = load(); const now = Date.now();
  if (mp !== 'ozon') r.wb = now;
  if (mp !== 'wb') r.ozon = now;
  save(r); return r;
}
export function clearShowcaseRequest(mp: Mp): void { const r = load(); if (r[mp] == null) return; r[mp] = null; save(r); }
