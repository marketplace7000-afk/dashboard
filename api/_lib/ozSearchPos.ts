/**
 * «Конкуренты» → Ozon, столбец «Позиция» (07.11.2026): место в поиске Ozon нашего товара и каждого
 * привязанного конкурента по главному запросу нашего товара.
 *
 * Главный запрос — тот, по которому нашу карточку за месяц увидело больше всего покупателей (Seller API
 * «product-queries/details»), без запросов с брендом из нашего артикула: «повербанк» ищут в 6 раз чаще,
 * чем «портативная электростанция», но электростанцию по нему почти не видят, а «allpowers» — поиск
 * своего бренда, где конкурентов нет. Собирает сервер не чаще раза в неделю на товар (429 уже на 4-й запрос подряд).
 * Места снимает агент в полном ночном проходе Ozon: «Видимость в поиске» (explanation_by_id) принимает
 * сразу несколько SKU и отдаёт точное место каждого — один запрос на наш товар (проверено 07.11 на ALLPOWERS:
 * мы 496, конкуренты 50/73/93). Только чтение.
 */
import { adsDb } from './ads/store';
import { rnpItems } from './rnp';
import { getFbo } from './fboStocks';
import { fetchOzon } from './cards';
import { pickRegion, type VisRegion } from './cardVisibility';
import { getAllLinks } from './competitorWatch';

const REFRESH_MS = 7 * 86_400_000;
/** За один прогрев — не больше стольких товаров: 25 с между запросами, чтобы не ловить 429. */
const PER_RUN = 12;

let ready = false;
function db(): any {
  const d = adsDb();
  if (!d) throw new Error('хранилище недоступно');
  if (!ready) {
    d.exec(`CREATE TABLE IF NOT EXISTS oz_main_query (
        key TEXT PRIMARY KEY, ozon_sku TEXT NOT NULL, query TEXT NOT NULL, freq REAL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS oz_search_pos (
        key TEXT NOT NULL, date TEXT NOT NULL, at INTEGER NOT NULL, json TEXT NOT NULL, PRIMARY KEY (key, date));`);
    ready = true;
  }
  return d;
}

const up = (s: unknown) => String(s ?? '').trim().toUpperCase();

/** Наши товары Ozon с привязанными конкурентами (без архива): артикул → SKU Ozon и SKU конкурентов. */
function targets(): { key: string; ozonSku: string; comps: string[] }[] {
  const links = getAllLinks('ozon');
  const sku = new Map<string, string>();
  for (const r of rnpItems('ozon')) { const k = up(r.article || r.sku); if (k && r.extId && !sku.has(k)) sku.set(k, String(r.extId)); }
  const out = [];
  for (const [key, ls] of Object.entries(links)) {
    const comps = ls.filter(l => l.status === 'active').map(l => String(l.nmId));
    const ozonSku = sku.get(up(key));
    if (comps.length && ozonSku) out.push({ key: up(key), ozonSku, comps });
  }
  return out;
}

let collecting = false;
/** Обновить главные запросы товаров, у которых их нет или они старше недели. */
/** Слова артикула, похожие на бренд/модель (от 4 латинских букв): ALLPOWERS-STAN2KWH-AP-R2500 → allpowers. */
function brandWords(key: string): string[] {
  return key.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 4 && /^[a-z]+$/.test(w));
}

/** Главный запрос из списка запросов карточки: больше всего увидевших, без бренда из артикула. */
export function pickMainQuery(key: string, list: { text: string; freq: number | null; reach: number | null }[]): { text: string; freq: number | null } | null {
  const qs = list.filter(q => q.text.trim());
  const brands = brandWords(key);
  const clean = qs.filter(q => !brands.some(b => q.text.toLowerCase().includes(b)));
  const by = (a: typeof qs[0], b: typeof qs[0]) => (b.reach ?? 0) - (a.reach ?? 0) || (b.freq ?? 0) - (a.freq ?? 0);
  return (clean.length ? clean : qs).sort(by)[0] ?? null;
}

export async function collectMainQueries(force = false): Promise<string> {
  if (collecting) return 'уже идёт';
  collecting = true;
  try {
    const d = db();
    const known = new Map((d.prepare('SELECT key, ozon_sku, at FROM oz_main_query').all() as { key: string; ozon_sku: string; at: number }[]).map(r => [r.key, r]));
    const due = targets().filter(t => { const k = known.get(t.key); return force || !k || k.ozon_sku !== t.ozonSku || Date.now() - k.at > REFRESH_MS; })
      .sort((a, b) => (known.get(a.key)?.at ?? 0) - (known.get(b.key)?.at ?? 0)).slice(0, PER_RUN);
    let ok = 0, empty = 0; const errors: string[] = [];
    for (const [i, t] of due.entries()) {
      if (i) await new Promise(r => setTimeout(r, 25_000));
      try {
        const q = pickMainQuery(t.key, await fetchOzon(t.ozonSku));
        if (!q) { empty++; continue; }
        d.prepare(`INSERT INTO oz_main_query (key, ozon_sku, query, freq, at) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(key) DO UPDATE SET ozon_sku = excluded.ozon_sku, query = excluded.query, freq = excluded.freq, at = excluded.at`)
          .run(t.key, t.ozonSku, q.text.toLowerCase().replace(/ё/g, 'е').trim(), q.freq ?? null, Date.now());
        ok++;
      } catch (e) { errors.push(`${t.key}: ${(e as Error).message.slice(0, 60)}`); }
    }
    return `главные запросы Ozon: обновлено ${ok}${empty ? `, без запросов ${empty}` : ''}${due.length ? '' : ' (все свежие)'}${errors.length ? ' · ' + errors.join('; ') : ''}`;
  } finally { collecting = false; }
}

export type SearchPosPlanItem = { key: string; ozonSku: string; query: string; region: VisRegion; comps: string[] };

/** Задание агенту на ночь: по товару — главный запрос, регион и SKU (наш + конкуренты). */
export async function searchPosPlan(): Promise<SearchPosPlanItem[]> {
  const d = db();
  const mq = new Map((d.prepare('SELECT key, query FROM oz_main_query').all() as { key: string; query: string }[]).map(r => [r.key, r.query]));
  const fbo = (await getFbo().catch(() => ({ data: null as any }))).data;
  return targets().filter(t => mq.has(t.key)).map(t => ({ ...t, query: mq.get(t.key)!, region: pickRegion(t.key, fbo).region, comps: t.comps.slice(0, 20) }));
}

export type SearchPosRow = { key: string; query: string; region: string; total: number | null; pos: Record<string, number | null> };

/** Приём от агента: места по SKU (null — карточки нет в выдаче по запросу). Повтор за день заменяет прошлый. */
export function saveSearchPos(rows: unknown, at: number, date: string): number {
  if (!Array.isArray(rows)) return 0;
  const st = db().prepare(`INSERT INTO oz_search_pos (key, date, at, json) VALUES (?, ?, ?, ?)
    ON CONFLICT(key, date) DO UPDATE SET at = excluded.at, json = excluded.json`);
  let n = 0;
  for (const r of rows as SearchPosRow[]) {
    if (!r?.key || !r.query || !r.pos || typeof r.pos !== 'object') continue;
    st.run(up(r.key), date, at, JSON.stringify({ key: up(r.key), query: String(r.query), region: String(r.region ?? ''), total: r.total ?? null, pos: r.pos }));
    n++;
  }
  return n;
}

/** Последние снятые места всех товаров: артикул → запрос, когда, места по SKU. */
export function latestSearchPos(): Map<string, { query: string; region: string; at: number; pos: Record<string, number | null> }> {
  const out = new Map<string, { query: string; region: string; at: number; pos: Record<string, number | null> }>();
  try {
    const rows = db().prepare(`SELECT p.key, p.at, p.json FROM oz_search_pos p
      JOIN (SELECT key, MAX(date) date FROM oz_search_pos GROUP BY key) m ON m.key = p.key AND m.date = p.date`).all() as { key: string; at: number; json: string }[];
    for (const r of rows) { const j = JSON.parse(r.json); out.set(r.key, { query: j.query, region: String(j.region ?? ''), at: Number(r.at), pos: j.pos ?? {} }); }
  } catch (e) { console.warn('[oz-search-pos] не прочитаны:', (e as Error).message); }
  return out;
}
