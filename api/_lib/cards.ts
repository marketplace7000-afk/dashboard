/**
 * «Ведение карточек» (31.10.2026): закреплённые за агентом карточки WB и Ozon и их рамки.
 * Раздел только для владельца: сервер закрывает /api/cards всем остальным (permissions.ts).
 *
 * Первая версия ничего не меняет на площадках: хранит закрепления и рамки и показывает
 * цифры из РНП. Сбор запросов и план действий добавятся следующими этапами.
 * Разбор — Заметки\Агенты и боты\Агент ведения карточек — анализ и варианты.md.
 */
import { adsDb } from './ads/store';
import { mskDate } from './mskDate';
import { rnpItems, rnpSkuTotals } from './rnp';
import { fetchWithRetry } from './fetchRetry';
import { wbUpstream } from '../_proxy';
import type { RnpMp } from '../../shared/rnp';

export type CardGoal = 'growth' | 'hold' | 'sell_out';
const GOALS: CardGoal[] = ['growth', 'hold', 'sell_out'];

export type CardSettings = {
  goal: CardGoal;
  /** Минимальная маржа, %. null — не задана. */
  minMarginPct: number | null;
  /** Предельный ДРР, %. null — не задан. */
  maxDrrPct: number | null;
  /** Минимальный запас товара, дней. null — не задан. */
  minStockDays: number | null;
};

export type CardPeriod = { orders: number; amount: number; ads: number; drrPct: number | null };

export type CardPin = CardSettings & {
  mp: RnpMp; sku: string; article: string; name: string; photo: string; pinnedAt: number;
  cur: CardPeriod | null; prev: CardPeriod | null; stock: number | null; price: number | null;
  /** Последний день, за который в РНП есть данные по карточке. */
  dataDate: string | null;
};

let ready = false;
function db(): any {
  const d = adsDb();
  if (!d) throw new Error('хранилище недоступно');
  if (!ready) {
    d.exec(`CREATE TABLE IF NOT EXISTS card_pin (
      mp TEXT NOT NULL, sku TEXT NOT NULL, goal TEXT NOT NULL, min_margin REAL, max_drr REAL, min_stock_days REAL,
      pinned_at INTEGER NOT NULL, PRIMARY KEY (mp, sku));`);
    ready = true;
  }
  return d;
}

const isMp = (v: unknown): v is RnpMp => v === 'wb' || v === 'ozon';

/** Необязательное число в пределах; пусто — null, иначе ошибка с понятным текстом. */
function limit(v: unknown, name: string, max: number): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > max) throw new Error(`${name}: нужно число от 0 до ${max}`);
  return n;
}

const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

function period(t: { orders: number; amount: number; ads: number } | null): CardPeriod | null {
  if (!t) return null;
  return { ...t, drrPct: t.amount > 0 ? Math.round((t.ads / t.amount) * 1000) / 10 : null };
}

export function listPins(): CardPin[] {
  const rows = db().prepare('SELECT * FROM card_pin ORDER BY pinned_at DESC').all() as any[];
  // Сравниваем закрытые дни: неполное «сегодня» занизило бы последнюю неделю.
  const to = mskDate(1), from = addDays(to, -6), prevTo = addDays(from, -1), prevFrom = addDays(prevTo, -6);
  const items = new Map<string, ReturnType<typeof rnpItems>[number]>();
  for (const mp of ['wb', 'ozon'] as RnpMp[]) for (const it of rnpItems(mp)) items.set(`${mp}:${it.sku}`, it);
  return rows.map(r => {
    const mp = r.mp as RnpMp, sku = String(r.sku);
    const it = items.get(`${mp}:${sku}`);
    const cur = rnpSkuTotals(mp, sku, from, to), prev = rnpSkuTotals(mp, sku, prevFrom, prevTo);
    return {
      mp, sku, article: it?.article ?? '', name: it?.name ?? '', photo: it?.photo ?? '', pinnedAt: Number(r.pinned_at),
      goal: r.goal as CardGoal, minMarginPct: r.min_margin ?? null, maxDrrPct: r.max_drr ?? null, minStockDays: r.min_stock_days ?? null,
      cur: period(cur), prev: period(prev), stock: cur?.stock ?? null, price: cur?.price ?? null, dataDate: cur?.lastDate ?? null,
    };
  });
}

/** Товары площадки, которые ещё можно закрепить. */
export function catalog(mp: unknown) {
  if (!isMp(mp)) throw new Error('площадка: wb или ozon');
  const pinned = new Set((db().prepare('SELECT sku FROM card_pin WHERE mp = ?').all(mp) as any[]).map(r => String(r.sku)));
  return rnpItems(mp).filter(i => !pinned.has(i.sku)).map(i => ({ sku: i.sku, article: i.article, name: i.name, photo: i.photo }));
}

/** Закрепить карточку или изменить её рамки. */
export function savePin(input: any): void {
  if (!isMp(input?.mp)) throw new Error('площадка: wb или ozon');
  const sku = String(input?.sku ?? '').trim();
  if (!sku || !rnpItems(input.mp).some(i => i.sku === sku)) throw new Error('такого товара нет в РНП');
  const goal: CardGoal = input?.goal === undefined ? 'growth' : input.goal;
  if (!GOALS.includes(goal)) throw new Error('неизвестная цель');
  const minMargin = limit(input?.minMarginPct, 'Минимальная маржа', 100);
  const maxDrr = limit(input?.maxDrrPct, 'Предельный ДРР', 100);
  const minStock = limit(input?.minStockDays, 'Минимальный запас', 365);
  db().prepare(`INSERT INTO card_pin (mp, sku, goal, min_margin, max_drr, min_stock_days, pinned_at) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(mp, sku) DO UPDATE SET goal = excluded.goal, min_margin = excluded.min_margin,
      max_drr = excluded.max_drr, min_stock_days = excluded.min_stock_days`)
    .run(input.mp, sku, goal, minMargin, maxDrr, minStock, Date.now());
  // Новая карточка: запросы сразу, не дожидаясь планового обновления. Уже собранные пропускаются по возрасту.
  void collectCardQueries().catch(e => console.warn('[cards] запросы не собраны:', (e as Error)?.message));
}

export function removePin(input: any): void {
  if (!isMp(input?.mp)) throw new Error('площадка: wb или ozon');
  db().prepare('DELETE FROM card_pin WHERE mp = ? AND sku = ?').run(input.mp, String(input?.sku ?? ''));
}

// ─── Поисковые запросы закреплённых карточек ───────────────────────────────
// WB — через API, до 100 на карточку; показов и CTR по запросу WB не отдаёт.
// Ozon — через API, не больше 15 на SKU и без последних 3 дней.

export type CardQuery = {
  text: string; freq: number | null; freqDyn: number | null; pos: number | null; posDyn: number | null;
  /** WB — переходы в карточку; Ozon — сколько покупателей увидело. */
  reach: number | null; cart: number | null; orders: number | null; ordersDyn: number | null; gmv: number | null;
  /** Ozon: конверсия из показа в карточку, %. */
  viewConv: number | null; visibility: number | null;
};

export type CompQueries = {
  setDate: string;
  cards: { nmId: number; name: string; brand: string }[];
  queries: { text: string; freq: number | null; nms?: { nmId: number; shown: boolean | null; pos: number | null; open: number | null; cart: number | null; orders: number | null }[] }[];
};

const COLLECT_EVERY_MS = 20 * 3_600_000;

function qdb(): any {
  const d = db();
  d.exec(`CREATE TABLE IF NOT EXISTS card_query (
      mp TEXT NOT NULL, sku TEXT NOT NULL, date TEXT NOT NULL, rank INTEGER NOT NULL, at INTEGER NOT NULL, json TEXT NOT NULL,
      PRIMARY KEY (mp, sku, date, rank));
    CREATE TABLE IF NOT EXISTS card_comp_query (
      nm TEXT PRIMARY KEY, set_date TEXT NOT NULL, at INTEGER NOT NULL, json TEXT NOT NULL);`);
  return d;
}

const cur = (x: any): number | null => (x && typeof x === 'object' ? x.current ?? null : x ?? null);
const dyn = (x: any): number | null => (x && typeof x === 'object' ? x.dynamics ?? null : null);

async function fetchWb(nm: string): Promise<CardQuery[]> {
  const up = wbUpstream('analytics');
  const r = await fetchWithRetry(`${up.base}/api/v2/search-report/product/search-texts`, {
    method: 'POST',
    headers: { ...up.headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      currentPeriod: { start: mskDate(7), end: mskDate(1) }, pastPeriod: { start: mskDate(14), end: mskDate(8) }, nmIds: [Number(nm)],
      topOrderBy: 'openCard', includeSubstitutedSKUs: true, includeSearchTexts: true, orderBy: { field: 'openCard', mode: 'desc' }, limit: 100,
    }),
  }, { maxRetries: 1, priority: 2, timeoutMs: 30_000 });
  if (!r.ok) throw new Error(`WB ${r.status}`);
  const items = ((await r.json()) as any)?.data?.items ?? [];
  return items.map((q: any): CardQuery => ({
    text: String(q.text ?? ''), freq: cur(q.frequency), freqDyn: dyn(q.frequency), pos: cur(q.avgPosition), posDyn: dyn(q.avgPosition),
    reach: cur(q.openCard), cart: cur(q.addToCart), orders: cur(q.orders), ordersDyn: dyn(q.orders), gmv: null, viewConv: null, visibility: cur(q.visibility),
  }));
}

async function fetchOzon(ozonSku: string): Promise<CardQuery[]> {
  const r = await fetchWithRetry('https://api-seller.ozon.ru/v1/analytics/product-queries/details', {
    method: 'POST',
    headers: { 'Client-Id': process.env.OZON_CLIENT_ID ?? '', 'Api-Key': process.env.OZON_API_KEY ?? '', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      date_from: `${mskDate(31)}T00:00:00Z`, date_to: `${mskDate(4)}T23:59:59Z`, limit_by_sku: 15, page: 0, page_size: 15,
      skus: [ozonSku], sort_by: 'BY_SEARCHES', sort_dir: 'DESCENDING',
    }),
  }, { maxRetries: 1, priority: 2, timeoutMs: 30_000 });
  if (!r.ok) throw new Error(`Ozon ${r.status}`);
  const list = ((await r.json()) as any)?.queries ?? [];
  return list.map((q: any): CardQuery => ({
    text: String(q.query ?? ''), freq: q.unique_search_users ?? null, freqDyn: null, pos: q.position ?? null, posDyn: null,
    reach: q.unique_view_users ?? null, cart: null, orders: q.order_count ?? null, ordersDyn: null, gmv: q.gmv ?? null, viewConv: q.view_conversion ?? null, visibility: null,
  }));
}

let collecting = false;

/** Собрать запросы закреплённых карточек. force — не смотреть на возраст прошлого сбора. */
export async function collectCardQueries(force = false): Promise<string> {
  if (collecting) return 'уже идёт';
  collecting = true;
  try {
    const d = qdb();
    const date = mskDate(0);
    const done: string[] = [], errors: string[] = [];
    const pins = d.prepare('SELECT mp, sku FROM card_pin').all() as { mp: RnpMp; sku: string }[];
    for (const p of pins) {
      const last = d.prepare('SELECT MAX(at) at FROM card_query WHERE mp = ? AND sku = ?').get(p.mp, p.sku) as { at: number | null };
      if (!force && last?.at && Date.now() - last.at < COLLECT_EVERY_MS) continue;
      try {
        let rows: CardQuery[];
        if (p.mp === 'wb') rows = await fetchWb(String(p.sku));
        else {
          const ext = rnpItems('ozon').find(i => i.sku === String(p.sku))?.extId;
          if (!ext) throw new Error('нет SKU Ozon');
          rows = await fetchOzon(ext);
        }
        // Пустой ответ не затирает прошлый сбор этого дня.
        if (rows.length) {
          const at = Date.now();
          d.prepare('DELETE FROM card_query WHERE mp = ? AND sku = ? AND date = ?').run(p.mp, p.sku, date);
          const ins = d.prepare('INSERT INTO card_query (mp, sku, date, rank, at, json) VALUES (?, ?, ?, ?, ?, ?)');
          rows.forEach((q, i) => ins.run(p.mp, p.sku, date, i, at, JSON.stringify(q)));
        }
        done.push(`${p.mp}:${p.sku}=${rows.length}`);
      } catch (e) { errors.push(`${p.mp}:${p.sku}: ${(e as Error).message.slice(0, 80)}`); }
    }
    return [`запросы: ${done.join(', ') || 'свежие'}`, ...errors].join(' · ');
  } finally { collecting = false; }
}

/** Запросы набора «Сравнение карточек» WB: первая карточка набора — наша. Новый набор вытесняет старый. */
export function saveCompQueries(sets: any, at: number): void {
  if (!Array.isArray(sets)) return;
  const st = qdb().prepare(`INSERT INTO card_comp_query (nm, set_date, at, json) VALUES (?, ?, ?, ?)
    ON CONFLICT(nm) DO UPDATE SET set_date = excluded.set_date, at = excluded.at, json = excluded.json
    WHERE excluded.set_date >= card_comp_query.set_date`);
  for (const s of sets) {
    const own = s?.nms?.[0]?.nmId;
    if (!own || !Array.isArray(s.queries) || !s.queries.length) continue;
    const v: CompQueries = {
      setDate: String(s.date ?? ''),
      cards: s.nms.map((n: any) => ({ nmId: n.nmId, name: String(n.name ?? ''), brand: String(n.brand ?? '') })),
      queries: s.queries,
    };
    st.run(String(own), v.setDate, at, JSON.stringify(v));
  }
}

/** Запросы карточки и данные последнего сравнения для экрана. */
export function cardDetails(mp: unknown, sku: unknown) {
  if (!isMp(mp)) throw new Error('площадка: wb или ozon');
  const d = qdb(), id = String(sku ?? '');
  const lastDate = (d.prepare('SELECT MAX(date) date FROM card_query WHERE mp = ? AND sku = ?').get(mp, id) as { date: string | null })?.date ?? null;
  const rows = lastDate ? d.prepare('SELECT json, at FROM card_query WHERE mp = ? AND sku = ? AND date = ? ORDER BY rank').all(mp, id, lastDate) as { json: string; at: number }[] : [];
  let comp: CompQueries | null = null;
  if (mp === 'wb') {
    const c = d.prepare('SELECT json FROM card_comp_query WHERE nm = ?').get(id) as { json: string } | undefined;
    if (c) { try { comp = JSON.parse(c.json); } catch { comp = null; } }
  }
  return { queries: rows.map(r => JSON.parse(r.json) as CardQuery), collectedAt: rows[0]?.at ?? null, comp };
}
