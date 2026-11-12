/**
 * Раздел «План» (02.11.2026): план заказов по артикулам и площадкам, по месяцам.
 * Заменяет таблицу «AV План 2026»: её история один раз переносится сюда.
 *
 * Откуда какие цифры:
 *   план, штуки     — вводят руководитель продаж и менеджеры, утверждает владелец;
 *   план, рубли     — штуки × средний чек за 7 или 30 дней. При утверждении цена фиксируется;
 *                     у новинки цена плановая, её задают вручную;
 *   заказы, реклама — база РНП, сбор раз в 2 часа. Месяцы до октября 2026 — из отчёта финансиста
 *                     (заказы в РНП есть только с 12.09);
 *   маржа           — таблица финансиста: «Маржа» в рублях ÷ «Выручка», как считает сам финансист
 *                     (итог раздела — по всему кабинету за месяц, у товара — по его строкам).
 *                     Точную маржу по свежим заказам посчитать нельзя: выкупы и удержания становятся известны позже.
 * Хранение — .av-cache/plan.sqlite: при выкладке сайта папка не затирается.
 */
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { mskDate } from './mskDate';
import { planArticleFacts, rnpLatestStocks, rnpLinks, sellerPrices } from './rnp';
import { getCosts, resolveCost } from './costs';
import {
  addDays, avgCheck, calcPace, monthEnd, monthStart, pctOf, pickPrice, sharedStockShort, shiftMonth,
  type PlanBasis, type PlanDay, type PlanArchived, type PlanMp, type PlanResponse, type PlanRnp, type PlanRow, type PlanStatRow, type PlanStats, type PlanStatus, type PlanTotals, type PlanView,
} from '../../shared/plan';

let DatabaseSync: any = null;
try { DatabaseSync = require('node:sqlite').DatabaseSync; } catch { DatabaseSync = null; }

const DB_DIR = process.env.CACHE_DIR || join(process.cwd(), '.av-cache');
/** Единственная внешняя таблица раздела: маржа, реклама и заказы прошлых месяцев — из отчёта финансового менеджера. */
const FIN_SHEET_ID = '1mqlLnACs5Bdk1gn3O0vyHIW6Qgg6NfVMjV-TQXsdA74';
/** Год таблицы финансиста: в ней есть только номер месяца. */
const FIN_YEAR = 2026;
/** С этого месяца заказы и реклама берутся из базы РНП. Сентябрь в РНП неполный: данные с 12.09. */
const API_FROM_MONTH = '2026-10';
const FIN_EVERY_MS = 60 * 60_000;

/** Столбцы листов финансиста, считая с нуля (сверено с заголовками 02.11.2026). */
const FIN_LAYOUT: Record<PlanMp, { sheet: string; range: string; month: number; article: number; orders: number; rub: number; revenue: number; ads: number; marginRub: number }> = {
  wb: { sheet: 'АБС_WB_артикулы', range: 'A7:BK8000', month: 1, article: 5, orders: 7, rub: 8, revenue: 15, ads: 22, marginRub: 56 },
  ozon: { sheet: 'ABC_Ozon', range: 'A8:BK8000', month: 1, article: 4, orders: 6, rub: 7, revenue: 15, ads: 23, marginRub: 54 },
};

let db: any = null;
function getDb(): any {
  if (db) return db;
  if (!DatabaseSync) throw new Error('База плана недоступна на сервере (нужен Node 22.5+)');
  mkdirSync(DB_DIR, { recursive: true });
  db = new DatabaseSync(join(DB_DIR, 'plan.sqlite'));
  db.exec(`
    CREATE TABLE IF NOT EXISTS plan_month (
      month TEXT NOT NULL, mp TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'draft', basis TEXT NOT NULL DEFAULT '7d',
      approved_by TEXT, approved_at INTEGER, PRIMARY KEY (month, mp));
    CREATE TABLE IF NOT EXISTS plan_line (
      month TEXT NOT NULL, mp TEXT NOT NULL, article TEXT NOT NULL,
      qty INTEGER NOT NULL DEFAULT 0, price_manual REAL NOT NULL DEFAULT 0, price_frozen REAL NOT NULL DEFAULT 0,
      is_new INTEGER NOT NULL DEFAULT 0, name TEXT NOT NULL DEFAULT '', start_date TEXT, comment TEXT NOT NULL DEFAULT '',
      updated_by TEXT, updated_at INTEGER, PRIMARY KEY (month, mp, article));
    CREATE TABLE IF NOT EXISTS plan_article (mp TEXT NOT NULL, article TEXT NOT NULL, status TEXT NOT NULL, PRIMARY KEY (mp, article));
    CREATE TABLE IF NOT EXISTS plan_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, user TEXT, month TEXT, mp TEXT, article TEXT, field TEXT, before TEXT, after TEXT);
    CREATE TABLE IF NOT EXISTS plan_fin (
      mp TEXT NOT NULL, month TEXT NOT NULL, article TEXT NOT NULL, orders REAL, rub REAL, ads REAL, margin_rub REAL, margin_pct REAL,
      PRIMARY KEY (mp, month, article));
    CREATE TABLE IF NOT EXISTS plan_snapshot (
      mp TEXT NOT NULL, month TEXT NOT NULL, article TEXT NOT NULL, fact REAL, fact_rub REAL, ads REAL,
      PRIMARY KEY (mp, month, article));
    CREATE TABLE IF NOT EXISTS plan_meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS plan_version (
      id INTEGER PRIMARY KEY AUTOINCREMENT, month TEXT NOT NULL, mp TEXT NOT NULL, at INTEGER NOT NULL, user TEXT, reason TEXT NOT NULL,
      state TEXT NOT NULL, basis TEXT NOT NULL, qty INTEGER NOT NULL, rub REAL NOT NULL, lines TEXT NOT NULL);
  `);
  // Архив (02.11.2026): товар скрыт начиная с этого месяца, прошлые месяцы не меняются.
  try { db.exec('ALTER TABLE plan_article ADD COLUMN archived_from TEXT'); } catch { /* столбец уже есть */ }
  // Выручка финансиста (11.11.2026): маржа = маржа ₽ ÷ выручка. Новый столбец — перечитать отчёт сразу.
  try { db.exec('ALTER TABLE plan_fin ADD COLUMN revenue REAL'); db.exec("DELETE FROM plan_meta WHERE key = 'fin:at'"); } catch { /* столбец уже есть */ }
  return db;
}
const metaGet = (k: string): string | null => (getDb().prepare('SELECT value FROM plan_meta WHERE key = ?').get(k) as any)?.value ?? null;
const metaSet = (k: string, v: string) => getDb().prepare('INSERT OR REPLACE INTO plan_meta (key, value) VALUES (?, ?)').run(k, v);

const up = (v: unknown) => String(v ?? '').trim().toUpperCase();
const num = (v: unknown) => { const n = Number(String(v ?? '').replace(/\s/g, '').replace(',', '.')); return Number.isFinite(n) ? n : 0; };
const isMonth = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
const isDate = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const currentMonth = () => mskDate(0).slice(0, 7);

// ─── Отчёт финансиста ───────────────────────────────────────────────────────

let finLoading: Promise<void> | null = null;

async function refreshFinance(): Promise<void> {
  const { readSheetRange } = await import('./googleSheetsApi');
  const d = getDb();
  for (const mp of ['wb', 'ozon'] as const) {
    const L = FIN_LAYOUT[mp];
    const rows = await readSheetRange(FIN_SHEET_ID, `'${L.sheet}'!${L.range}`);
    const by = new Map<string, { orders: number; rub: number; revenue: number; ads: number; marginRub: number }>();
    for (const r of rows) {
      const m = Number(r?.[L.month]);
      const art = up(r?.[L.article]);
      if (!art || !Number.isInteger(m) || m < 1 || m > 12) continue;
      const key = `${FIN_YEAR}-${String(m).padStart(2, '0')}|${art}`;
      const x = by.get(key) ?? { orders: 0, rub: 0, revenue: 0, ads: 0, marginRub: 0 };
      // Артикул бывает в нескольких строках (несколько ИП): суммируем.
      x.orders += num(r[L.orders]); x.rub += num(r[L.rub]); x.revenue += num(r[L.revenue]); x.ads += num(r[L.ads]); x.marginRub += num(r[L.marginRub]);
      by.set(key, x);
    }
    if (!by.size) throw new Error(`лист «${L.sheet}» пуст или изменился`);
    const ins = d.prepare('INSERT INTO plan_fin (mp, month, article, orders, rub, ads, margin_rub, margin_pct, revenue) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    d.exec('BEGIN');
    try {
      d.prepare('DELETE FROM plan_fin WHERE mp = ?').run(mp);
      for (const [k, x] of by) {
        const [month, art] = k.split('|');
        // Как в таблице: «Маржа с налогом, %» = маржа ÷ выручка. Без выручки (ещё нет выкупов) процента нет.
        ins.run(mp, month, art, x.orders, x.rub, x.ads, x.marginRub, x.revenue > 0 ? (x.marginRub / x.revenue) * 100 : null, x.revenue);
      }
      d.exec('COMMIT');
    } catch (e) { d.exec('ROLLBACK'); throw e; }
  }
  metaSet('fin:at', String(Date.now()));
  metaSet('fin:error', '');
}

function ensureFinance(): void {
  const at = Number(metaGet('fin:at') || 0);
  if (finLoading || Date.now() - at < FIN_EVERY_MS) return;
  finLoading = refreshFinance()
    .catch(e => { metaSet('fin:at', String(Date.now() - FIN_EVERY_MS + 5 * 60_000)); metaSet('fin:error', String((e as Error).message).slice(0, 200)); })
    .finally(() => { finLoading = null; });
}

type FinRow = { month: string; orders: number; rub: number; ads: number; margin_rub: number; margin_pct: number | null };

function finByArticle(mp: PlanMp, month: string): Map<string, FinRow> {
  const rows = getDb().prepare('SELECT article, month, orders, rub, ads, margin_rub, margin_pct FROM plan_fin WHERE mp = ? AND month = ?').all(mp, month) as any[];
  return new Map(rows.map(r => [String(r.article), r]));
}

/** Последняя известная маржа каждого артикула не позже месяца `month`. */
function latestMargins(mp: PlanMp, month: string): Map<string, { pct: number; rub: number; rev: number; month: string }> {
  const rows = getDb().prepare(`SELECT article, month, margin_rub, margin_pct, revenue FROM plan_fin WHERE mp = ? AND month <= ? AND margin_pct IS NOT NULL AND revenue > 0 ORDER BY month DESC`).all(mp, month) as any[];
  const out = new Map<string, { pct: number; rub: number; rev: number; month: string }>();
  for (const r of rows) if (!out.has(String(r.article))) out.set(String(r.article), { pct: Number(r.margin_pct), rub: Number(r.margin_rub) || 0, rev: Number(r.revenue) || 0, month: String(r.month) });
  return out;
}

/** Маржа всего кабинета за месяц так, как её видит финансист: Σ маржи ÷ Σ выручки по всем строкам листа.
 *  Если за месяц выручки ещё нет — последний месяц, где она есть. */
function finCabinetMargin(mp: PlanMp, month: string): { rub: number; rev: number } | null {
  const r = getDb().prepare('SELECT SUM(margin_rub) rub, SUM(revenue) rev FROM plan_fin WHERE mp = ? AND month = (SELECT MAX(month) FROM plan_fin WHERE mp = ? AND month <= ? AND revenue > 0)').get(mp, mp, month) as any;
  return r && Number(r.rev) > 0 ? { rub: Number(r.rub) || 0, rev: Number(r.rev) } : null;
}

const STATUS = (s: unknown): PlanStatus => { const v = String(s ?? '').trim(); return v === 'Вывод' ? 'Вывод' : v === 'Новинка' ? 'Новинка' : 'Рабочий'; };

// ─── Сборка месяца ──────────────────────────────────────────────────────────

type Line = { article: string; qty: number; price_manual: number; price_frozen: number; is_new: number; name: string; start_date: string | null; comment: string };

/**
 * Остаток — те же числа, что в разделе «Остатки» (просьба владельца 02.11.2026): FBO этой площадки
 * (WB без остановленных складов) и FBS по всем своим складам из таблицы «Склад». Цифра FBS в API
 * площадок не годится: там то, что выгружено на площадку, а не то, что лежит на складах.
 */
type StockMaps = { fbo: Map<string, number>; fbs: Map<string, number> };
const stockMemo = new Map<PlanMp, { at: number; maps: StockMaps | null }>();
async function stockMaps(mp: PlanMp): Promise<StockMaps | null> {
  const hit = stockMemo.get(mp);
  if (hit && Date.now() - hit.at < 60_000) return hit.maps;
  let maps: StockMaps | null = null;
  try {
    const { getFbo } = await import('./fboStocks');
    const { buildOzon, buildWb } = await import('../../src/utils/fboModel');
    const { data } = await getFbo();
    if (data) {
      const add = (m: Map<string, number>, art: string, q: number) => { const a = up(art); m.set(a, (m.get(a) ?? 0) + q); };
      maps = { fbo: new Map(), fbs: new Map() };
      for (const s of (mp === 'wb' ? buildWb(data) : buildOzon(data)).stock) add(maps.fbo, s.art, s.q);
      for (const s of data.fbs.stock) add(maps.fbs, s.art, s.q);
    }
  } catch (e) { console.warn('[plan] остатки не прочитаны:', (e as Error)?.message); }
  stockMemo.set(mp, { at: Date.now(), maps });
  return maps;
}

async function buildMp(mp: PlanMp, month: string): Promise<{ rows: PlanRow[]; archived: PlanArchived[]; head: { state: string; basis: PlanBasis; approved_by: string | null; approved_at: number | null }; factSource: 'api' | 'finance'; catalog: { article: string; name: string }[]; approxTo: string | null; finMonth: string | null }> {
  const d = getDb();
  const today = mskDate(0);
  const yesterday = addDays(today, -1);
  const from = monthStart(month), to = monthEnd(month);
  const isPast = to < today, isFuture = from > today;
  const head = (d.prepare('SELECT state, basis, approved_by, approved_at FROM plan_month WHERE month = ? AND mp = ?').get(month, mp) as any)
    ?? { state: 'draft', basis: '7d', approved_by: null, approved_at: null };
  const lines = d.prepare('SELECT article, qty, price_manual, price_frozen, is_new, name, start_date, comment FROM plan_line WHERE month = ? AND mp = ?').all(month, mp) as Line[];
  const lineBy = new Map(lines.map(l => [l.article, l]));
  const articleRows = d.prepare('SELECT article, status, archived_from FROM plan_article WHERE mp = ?').all(mp) as any[];
  const statuses = new Map(articleRows.map(r => [String(r.article), STATUS(r.status)]));
  const archivedSet = new Set(articleRows.filter(r => r.archived_from && month >= String(r.archived_from)).map(r => String(r.article)));

  // База средних чеков: для текущего и будущего месяца — вчера, для прошлого черновика — канун месяца.
  const anchor = isPast ? addDays(from, -1) : yesterday;
  const qFrom = [addDays(anchor, -89), from, monthStart(shiftMonth(month, -1)), addDays(today, -30)].sort()[0];
  const qTo = to < today ? to : today;
  const facts = planArticleFacts(mp, qFrom, qTo);

  const factSource: 'api' | 'finance' = month >= API_FROM_MONTH ? 'api' : 'finance';
  const fin = finByArticle(mp, month);
  const margins = latestMargins(mp, month);
  const stocks = rnpLatestStocks(mp);
  // Себестоимость к цене в кабинете (12.11.2026): цена продавца без СПП из кэша ценовых API
  // (cron обновляет его не реже раза в 3 часа), себестоимость — из «Склада», сверка раз в 5 минут.
  const seller = await sellerPrices(mp).catch(() => ({} as Record<string, number>));
  const costs = getCosts();
  const stockNow = await stockMaps(mp);
  let sheet: Record<string, any> = {};
  try { const { getStockSheet } = await import('./stockSheet'); sheet = (await getStockSheet(false)).items; } catch { /* остаток в пути просто не покажем */ }
  const snapshots = new Map((d.prepare('SELECT article, fact, fact_rub, ads FROM plan_snapshot WHERE mp = ? AND month = ?').all(mp, month) as any[]).map(r => [String(r.article), r]));

  const prevMonth = shiftMonth(month, -1);
  const prevFin = finByArticle(mp, prevMonth);
  const sum = (art: string, a: string, b: string) => {
    let cnt = 0, rub = 0, ads = 0;
    for (const [date, v] of facts.byArticle.get(art)?.days ?? []) if (date >= a && date <= b) { cnt += v.cnt; rub += v.rub; ads += v.ads; }
    return { cnt, rub, ads };
  };

  // Какие артикулы показывать: с планом, с заказами в месяце, а у текущего и будущего месяца ещё и действующие товары.
  const universe = new Set<string>(lines.map(l => l.article));
  if (factSource === 'finance') {
    for (const [a, f] of fin) if (f.orders > 0 && facts.real(a)) universe.add(a);
  } else {
    for (const [a] of facts.byArticle) if (facts.real(a) && sum(a, from, qTo).cnt > 0) universe.add(a);
    for (const [a] of snapshots) if (facts.real(a)) universe.add(a);
    if (!isPast) {
      for (const [a] of facts.byArticle) if (facts.real(a) && sum(a, addDays(today, -30), today).cnt > 0) universe.add(a);
      for (const [a, st] of stocks) if (st > 0 && facts.real(a)) universe.add(a);
    }
  }

  for (const a of archivedSet) universe.add(a);

  const snapIns = d.prepare('INSERT OR REPLACE INTO plan_snapshot (mp, month, article, fact, fact_rub, ads) VALUES (?, ?, ?, ?, ?, ?)');
  const links = rnpLinks(mp);
  const rows: PlanRow[] = [];
  const archived: PlanArchived[] = [];
  for (const article of universe) {
    const l = lineBy.get(article);
    const item = facts.items.get(article);
    const isNew = !!l?.is_new;
    const qty = l?.qty ?? 0;
    const startDate = l?.start_date ?? null;

    let fact = 0, factRub = 0, ads = 0, factToYesterday = 0;
    const daily: PlanDay[] = [];
    if (factSource === 'finance') {
      const f = fin.get(article);
      fact = Math.round(f?.orders ?? 0); factRub = f?.rub ?? 0; ads = f?.ads ?? 0; factToYesterday = fact;
    } else {
      const s = sum(article, from, qTo);
      const hasLive = !!facts.byArticle.get(article)?.days.size && (s.cnt > 0 || s.ads > 0);
      const snap = snapshots.get(article);
      fact = s.cnt; factRub = s.rub; ads = s.ads;
      // История закрытых месяцев не зависит от того, сколько хранит РНП: итог сохраняем отдельно.
      if (isPast) {
        if (hasLive) snapIns.run(mp, month, article, fact, factRub, ads);
        else if (snap) { fact = Number(snap.fact) || 0; factRub = Number(snap.fact_rub) || 0; ads = Number(snap.ads) || 0; }
      }
      factToYesterday = sum(article, from, yesterday).cnt;
      if (isPast && !hasLive) factToYesterday = fact;
      for (let x = from; x <= qTo; x = addDays(x, 1)) daily.push({ date: x, cnt: facts.byArticle.get(article)?.days.get(x)?.cnt ?? 0 });
    }

    const w = (days: number) => { const s = sum(article, addDays(anchor, -(days - 1)), anchor); return avgCheck(s.cnt, s.rub); };
    const { price, source } = pickPrice({ manual: l?.price_manual ?? 0, frozen: l?.price_frozen ?? 0, basis: head.basis, avg7: w(7), avg30: w(30), avg90: w(90) });
    const paceSum = sum(article, addDays(yesterday, -6), yesterday).cnt;
    const inSale = !!item || (stocks.get(article) ?? 0) > 0;
    const pace7 = isPast || isFuture || factSource === 'finance' ? null : paceSum / 7;
    const pace = calcPace({ qty, month, today, startDate, factToYesterday, factTotal: fact, pace7 });
    const planRub = qty * price;
    const m = margins.get(article);
    const priceNow = seller[article] ?? null;
    const unitCost = resolveCost(article, costs)?.cost ?? null;
    const stockFbo = stockNow ? stockNow.fbo.get(article) ?? 0 : null;
    const stockFbs = stockNow ? stockNow.fbs.get(article) ?? 0 : null;
    const stock = stockNow ? stockFbo! + stockFbs! : null;
    const sh = sheet[article]?.[mp];
    const transit = sh ? num(sh.transit) : null;
    const remain = Math.max(0, qty - fact);
    const pf = factSource === 'finance' || prevMonth < API_FROM_MONTH ? (prevFin.get(article)?.orders ?? null) : sum(article, monthStart(prevMonth), monthEnd(prevMonth)).cnt;

    // В утверждённом месяце товар с планом остаётся до конца месяца: утверждённое архив не меняет.
    const isArchived = archivedSet.has(article);
    if (isArchived && !(head.state === 'approved' && qty > 0)) {
      archived.push({ mp, article, name: l?.name || item?.name || '', photo: item?.photo || '', qty, fact, factRub, stock });
      continue;
    }
    rows.push({
      archived: isArchived, mp, article, name: l?.name || item?.name || '', photo: item?.photo || '', link: links.get(article) || '',
      status: isNew ? 'Новинка' : statuses.get(article) ?? 'Рабочий', isNew, inSale, startDate, comment: l?.comment ?? '',
      qty, hasLine: !!l, price, priceSource: source, planRub,
      fact, factRub, pct: pctOf(fact, qty), pctRub: pctOf(factRub, planRub),
      expected: pace.expected, forecast: pace.forecast, needPerDay: pace.needPerDay, pace7, behind: pace.behind,
      ads, drr: factRub > 0 ? (ads / factRub) * 100 : null,
      marginPct: m ? m.pct : null, marginRub: m ? m.rub : null, marginRev: m ? m.rev : null, marginMonth: m ? m.month : null,
      stock, stockFbo, stockFbs, transit, stockShort: !isPast && stock !== null && remain > stock + (transit ?? 0), stockShortShared: false,
      priceNow, unitCost, costPct: priceNow && unitCost && priceNow > 0 && unitCost > 0 ? (unitCost / priceNow) * 100 : null,
      prevFact: pf === null ? null : Math.round(pf), orders30: sum(article, addDays(today, -30), yesterday).cnt, daily,
    });
  }
  rows.sort((a, b) => b.planRub - a.planRub || b.fact - a.fact || a.article.localeCompare(b.article));

  const shown = new Set(rows.map(r => r.article));
  const catalog = [...facts.items.entries()].filter(([a]) => facts.real(a) && !shown.has(a) && !archivedSet.has(a)).map(([article, i]) => ({ article, name: i.name })).sort((a, b) => a.article.localeCompare(b.article));

  // По какую дату заполнен отчёт финансиста: день, когда заказы РНП догоняют его итог.
  let approxTo: string | null = null;
  const finMonth = (d.prepare('SELECT MAX(month) m FROM plan_fin WHERE mp = ? AND orders > 0').get(mp) as any)?.m ?? null;
  if (finMonth && finMonth >= API_FROM_MONTH) {
    const finFacts = finMonth === month ? facts : planArticleFacts(mp, monthStart(finMonth), monthEnd(finMonth));
    const fm = finByArticle(mp, finMonth);
    let total = 0; for (const [a, f] of fm) if (finFacts.real(a)) total += f.orders;
    let cum = 0;
    if (total > 0) for (let x = monthStart(finMonth); x <= monthEnd(finMonth) && x <= today; x = addDays(x, 1)) {
      for (const [a, v] of finFacts.byArticle) if (finFacts.real(a)) cum += v.days.get(x)?.cnt ?? 0;
      approxTo = x;
      if (cum >= total) break;
    }
  }
  archived.sort((a, b) => b.fact - a.fact || a.article.localeCompare(b.article));
  return { rows, archived, head, factSource, catalog, approxTo, finMonth };
}

/** cabinet — маржа кабинетов из отчёта финансиста; без неё (выборка по артикулу) — по строкам товаров. */
function totalsOf(rows: PlanRow[], month: string, today: string, cabinet?: ({ rub: number; rev: number } | null)[]): PlanTotals {
  const planned = rows.filter(r => r.qty > 0);
  const qty = planned.reduce((s, r) => s + r.qty, 0);
  const planRub = planned.reduce((s, r) => s + r.planRub, 0);
  const fact = rows.reduce((s, r) => s + r.fact, 0);
  const factRub = rows.reduce((s, r) => s + r.factRub, 0);
  const ads = rows.reduce((s, r) => s + r.ads, 0);
  const paces = rows.filter(r => r.pace7 !== null);
  const pace7 = paces.length ? paces.reduce((s, r) => s + (r.pace7 ?? 0), 0) : null;
  const yesterday = addDays(today, -1);
  const factToYesterday = rows.reduce((s, r) => s + (r.daily.length ? r.daily.filter(x => x.date <= yesterday).reduce((a, x) => a + x.cnt, 0) : r.fact), 0);
  const pace = calcPace({ qty, month, today, factToYesterday, factTotal: fact, pace7 });
  const avg = fact > 0 ? factRub / fact : (qty > 0 ? planRub / qty : 0);
  const left = Math.max(0, qty - factToYesterday);
  const mBase = cabinet ? cabinet.filter((x): x is { rub: number; rev: number } => !!x) : rows.filter(r => r.marginRev !== null && r.marginRev > 0).map(r => ({ rub: r.marginRub ?? 0, rev: r.marginRev ?? 0 }));
  const mRub = mBase.reduce((s, x) => s + x.rub, 0), mRev = mBase.reduce((s, x) => s + x.rev, 0);
  const needSum = planned.reduce((s, r) => s + (r.needPerDay ?? 0), 0);
  const rubLeft = Math.max(0, planRub - rows.reduce((s, r) => s + (r.daily.length ? r.daily.filter(x => x.date <= yesterday).reduce((a, x) => a + x.cnt, 0) * (r.fact ? r.factRub / r.fact : 0) : r.factRub), 0));
  return {
    qty, planRub, fact, factRub, factOutOfPlan: rows.filter(r => r.qty <= 0).reduce((s, r) => s + r.fact, 0),
    pct: pctOf(fact, qty), pctRub: pctOf(factRub, planRub), expected: pace.expected, forecast: pace.forecast,
    forecastRub: pace.forecast === null ? null : pace.forecast * avg,
    needPerDay: pace.needPerDay, needRubPerDay: pace.daysLeft > 0 && left >= 0 && qty > 0 ? rubLeft / pace.daysLeft : null, pace7,
    ads, drr: factRub > 0 ? (ads / factRub) * 100 : null,
    marginPct: mRev > 0 ? (mRub / mRev) * 100 : null, marginRub: mRev > 0 ? mRub : null,
    costPct: costPctOf(rows),
    needSumByArticle: pace.needPerDay === null ? null : needSum,
  };
}

/** Себестоимость ÷ цена в кабинете по товарам с планом, с весом плана в штуках. */
function costPctOf(rows: PlanRow[]): number | null {
  const base = rows.filter(r => r.costPct !== null && r.priceNow && r.unitCost && r.qty > 0);
  const price = base.reduce((s, r) => s + (r.priceNow ?? 0) * r.qty, 0);
  return price > 0 ? (base.reduce((s, r) => s + (r.unitCost ?? 0) * r.qty, 0) / price) * 100 : null;
}

/** Добавляет предупреждение «не хватит», которое появляется только с учётом плана второй площадки. */
function applySharedStock(rows: PlanRow[], others: PlanRow[]): void {
  const other = new Map(others.map(r => [r.article, r]));
  const side = (r: PlanRow | undefined) => ({ remain: Math.max(0, (r?.qty ?? 0) - (r?.fact ?? 0)), fbo: r?.stockFbo ?? 0, transit: r?.transit ?? 0 });
  for (const r of rows) {
    if (r.stockShort || r.stockFbs === null) continue;
    if (sharedStockShort(side(r), side(other.get(r.article)), r.stockFbs)) { r.stockShort = true; r.stockShortShared = true; }
  }
}

/** Строка «Все площадки»: артикул один, значения WB и Ozon складываются. */
function mergeRows(wb: PlanRow[], oz: PlanRow[]): PlanRow[] {
  const by = new Map<string, PlanRow>();
  for (const r of [...wb, ...oz]) {
    const x = by.get(r.article);
    const part = { qty: r.qty, fact: r.fact };
    if (!x) { by.set(r.article, { ...r, mp: 'all', [r.mp as PlanMp]: part, daily: r.daily.map(d => ({ ...d })) }); continue; }
    // Цены на площадках разные: в «Все площадки» процент себестоимости показываем, только если товар на одной площадке.
    x.costPct = null; x.priceNow = null;
    if (r.marginRev !== null) {
      x.marginRub = (x.marginRub ?? 0) + (r.marginRub ?? 0); x.marginRev = (x.marginRev ?? 0) + r.marginRev;
      x.marginPct = x.marginRev > 0 ? (x.marginRub / x.marginRev) * 100 : null;
      if (!x.marginMonth || (r.marginMonth && r.marginMonth > x.marginMonth)) x.marginMonth = r.marginMonth;
    }
    x.qty += r.qty; x.planRub += r.planRub; x.fact += r.fact; x.factRub += r.factRub; x.ads += r.ads;
    x.needPerDay = x.needPerDay === null && r.needPerDay === null ? null : (x.needPerDay ?? 0) + (r.needPerDay ?? 0);
    x.pace7 = x.pace7 === null && r.pace7 === null ? null : (x.pace7 ?? 0) + (r.pace7 ?? 0);
    x.forecast = x.forecast === null && r.forecast === null ? null : (x.forecast ?? 0) + (r.forecast ?? 0);
    x.expected = x.expected === null && r.expected === null ? null : (x.expected ?? 0) + (r.expected ?? 0);
    x.prevFact = x.prevFact === null && r.prevFact === null ? null : (x.prevFact ?? 0) + (r.prevFact ?? 0);
    x.orders30 += r.orders30; x.behind = x.behind || r.behind; x.stockShort = x.stockShort || r.stockShort;
    x.stockShortShared = x.stockShortShared || r.stockShortShared;
    x.transit = x.transit === null && r.transit === null ? null : (x.transit ?? 0) + (r.transit ?? 0);
    x.price = x.qty > 0 ? x.planRub / x.qty : x.price;
    x.pct = pctOf(x.fact, x.qty); x.pctRub = pctOf(x.factRub, x.planRub); x.drr = x.factRub > 0 ? (x.ads / x.factRub) * 100 : null;
    // FBO складывается по площадкам, а свои склады общие: их считаем один раз.
    x.stockFbo = x.stockFbo === null && r.stockFbo === null ? null : (x.stockFbo ?? 0) + (r.stockFbo ?? 0);
    x.stockFbs = x.stockFbs ?? r.stockFbs;
    x.stock = x.stockFbo === null && x.stockFbs === null ? null : (x.stockFbo ?? 0) + (x.stockFbs ?? 0);
    x.photo = x.photo || r.photo; x.name = x.name || r.name; x.hasLine = x.hasLine || r.hasLine;
    x[r.mp as PlanMp] = part;
    const days = new Map(x.daily.map(d => [d.date, d]));
    for (const d of r.daily) { const e = days.get(d.date); if (e) e.cnt += d.cnt; else x.daily.push({ ...d }); }
  }
  return [...by.values()].sort((a, b) => b.planRub - a.planRub || b.fact - a.fact || a.article.localeCompare(b.article));
}

const knownMonths = (): string[] => {
  const cur = currentMonth();
  const set = new Set<string>([cur, shiftMonth(cur, 1)]);
  for (const r of getDb().prepare('SELECT DISTINCT month FROM plan_line').all() as any[]) set.add(String(r.month));
  return [...set].sort().reverse();
};

export type PlanUser = { name: string; role: string };

function canEditMonth(u: PlanUser, month: string, state: string): boolean {
  if (u.role === 'owner') return true;
  return state !== 'approved' && month >= currentMonth();
}

export async function getPlan(viewIn: unknown, monthIn: unknown, user: PlanUser): Promise<PlanResponse> {
  ensureFinance();
  if (finLoading && !metaGet('fin:at')) await finLoading;
  const month = isMonth(monthIn) ? monthIn : currentMonth();
  const view: PlanView = viewIn === 'ozon' ? 'ozon' : viewIn === 'all' ? 'all' : 'wb';
  const today = mskDate(0);
  const from = monthStart(month), to = monthEnd(month);
  const period = to < today ? 'past' : from > today ? 'future' : 'current';
  const parts = view === 'all' ? [await buildMp('wb', month), await buildMp('ozon', month)] : [await buildMp(view, month)];
  // Свои склады общие для WB и Ozon: хватит ли товара, зависит от плана обеих площадок.
  if (period !== 'past') {
    if (view === 'all') { applySharedStock(parts[0].rows, parts[1].rows); applySharedStock(parts[1].rows, parts[0].rows); }
    else {
      try { applySharedStock(parts[0].rows, (await buildMp(view === 'wb' ? 'ozon' : 'wb', month)).rows); }
      catch (e) { console.warn('[plan] план второй площадки не прочитан:', (e as Error)?.message); }
    }
  }
  const rows = view === 'all' ? mergeRows(parts[0].rows, parts[1].rows) : parts[0].rows;
  const totals = totalsOf(rows, month, today, (view === 'all' ? ['wb', 'ozon'] as const : [view]).map(mp => finCabinetMargin(mp, month)));
  // В «Все площадки» у товара процента нет (цены разные), итог — по строкам обеих площадок.
  if (view === 'all') totals.costPct = costPctOf(parts.flatMap(p => p.rows));
  const states = new Set(parts.map(p => p.head.state));
  const state = states.size > 1 ? 'mixed' : ([...states][0] as 'draft' | 'approved');
  const daysInMonth = Number(to.slice(8));
  const left = period === 'past' ? 0 : period === 'future' ? daysInMonth : daysInMonth - Number(today.slice(8)) + 1;
  const catalog = view === 'all' ? [] : parts[0].catalog;
  const err = metaGet('fin:error');
  return {
    ok: true, month, view, today, state, basis: parts[0].head.basis,
    approvedBy: parts[0].head.approved_by, approvedAt: parts[0].head.approved_at,
    period, daysInMonth, daysLeft: left,
    canEdit: view !== 'all' && canEditMonth(user, month, state),
    canApprove: view !== 'all' && user.role === 'owner',
    factSource: parts[0].factSource,
    finance: { month: parts[0].finMonth, approxTo: parts[0].approxTo, checkedAt: Number(metaGet('fin:at')) || null, error: err || null },
    rows, totals, catalog, months: knownMonths(), archived: parts.flatMap(x => x.archived),
  };
}

export async function getPlanStats(viewIn: unknown, articleIn: unknown): Promise<PlanStats> {
  ensureFinance();
  const view: PlanView = viewIn === 'ozon' ? 'ozon' : viewIn === 'all' ? 'all' : 'wb';
  const article = articleIn ? up(articleIn) : null;
  const today = mskDate(0);
  const cur = currentMonth();
  const out: PlanStatRow[] = [];
  const months = knownMonths().filter(m => m <= cur).sort();
  for (const month of months) {
    const parts = view === 'all' ? [await buildMp('wb', month), await buildMp('ozon', month)] : [await buildMp(view, month)];
    let rows = view === 'all' ? mergeRows(parts[0].rows, parts[1].rows) : parts[0].rows;
    if (article) rows = rows.filter(r => r.article === article);
    const t = totalsOf(rows, month, today, article ? undefined : (view === 'all' ? ['wb', 'ozon'] as const : [view]).map(mp => finCabinetMargin(mp, month)));
    const states = new Set(parts.map(p => (rowsHaveLine(p.rows) ? p.head.state : 'none')));
    const state = (states.size > 1 ? 'mixed' : [...states][0]) as PlanStatRow['state'];
    out.push({ month, state, qty: t.qty, planRub: t.planRub, fact: t.fact, factRub: t.factRub, pct: t.pct, pctRub: t.pctRub, ads: t.ads, drr: t.drr, marginPct: t.marginPct, factSource: parts[0].factSource });
  }
  return { ok: true, view, article, rows: out.reverse() };
}
const rowsHaveLine = (rows: PlanRow[]) => rows.some(r => r.hasLine);

/** Для РНП: план текущего месяца по площадке и по артикулам. */
export async function getPlanForRnp(mpIn: unknown): Promise<PlanRnp> {
  ensureFinance();
  const mp: PlanMp = mpIn === 'ozon' ? 'ozon' : 'wb';
  const month = currentMonth();
  const today = mskDate(0);
  const b = await buildMp(mp, month);
  const has = b.rows.some(r => r.qty > 0);
  const byArticle: PlanRnp['byArticle'] = {};
  for (const r of b.rows) if (r.qty > 0) byArticle[r.article] = { qty: r.qty, fact: r.fact, pct: r.pct, needPerDay: r.needPerDay, pace7: r.pace7, behind: r.behind, startDate: r.startDate ?? null, daily: r.daily };
  return {
    ok: true, month, state: has ? (b.head.state as 'draft' | 'approved') : 'none',
    daysLeft: Number(monthEnd(month).slice(8)) - Number(today.slice(8)) + 1,
    totals: has ? totalsOf(b.rows, month, today) : null, byArticle,
  };
}

// ─── Изменения ──────────────────────────────────────────────────────────────

export class PlanError extends Error {}

function logChange(user: PlanUser, month: string, mp: string, article: string, field: string, before: unknown, after: unknown): void {
  if (String(before ?? '') === String(after ?? '')) return;
  getDb().prepare('INSERT INTO plan_log (at, user, month, mp, article, field, before, after) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(Date.now(), user.name, month, mp, article, field, before === null || before === undefined ? '' : String(before), after === null || after === undefined ? '' : String(after));
}

function guard(user: PlanUser, b: any): { month: string; mp: PlanMp; state: string } {
  if (!isMonth(b?.month)) throw new PlanError('Неверный месяц');
  if (b?.mp !== 'wb' && b?.mp !== 'ozon') throw new PlanError('Выберите площадку: WB или Ozon');
  const row = getDb().prepare('INSERT INTO plan_month (month, mp) VALUES (?, ?) ON CONFLICT DO NOTHING RETURNING state').get(b.month, b.mp) as any;
  const state = row?.state ?? (getDb().prepare('SELECT state FROM plan_month WHERE month = ? AND mp = ?').get(b.month, b.mp) as any)?.state ?? 'draft';
  if (!canEditMonth(user, b.month, state)) {
    throw new PlanError(state === 'approved' ? 'План утверждён: изменить его может только владелец' : 'Прошедший месяц может изменить только владелец');
  }
  return { month: b.month, mp: b.mp, state };
}

export function saveLine(user: PlanUser, b: any): { qty: number; price: number } {
  const { month, mp, state } = guard(user, b);
  const article = up(b?.article);
  if (!article || article.length > 120) throw new PlanError('Укажите артикул');
  const d = getDb();
  const cur = d.prepare('SELECT * FROM plan_line WHERE month = ? AND mp = ? AND article = ?').get(month, mp, article) as any;
  const next = {
    qty: b.qty !== undefined ? Math.round(num(b.qty)) : cur?.qty ?? 0,
    price_manual: b.price !== undefined ? Math.max(0, num(b.price)) : cur?.price_manual ?? 0,
    is_new: b.isNew !== undefined ? (b.isNew ? 1 : 0) : cur?.is_new ?? 0,
    name: b.name !== undefined ? String(b.name).trim().slice(0, 200) : cur?.name ?? '',
    start_date: b.startDate !== undefined ? (isDate(b.startDate) ? b.startDate : null) : cur?.start_date ?? null,
    comment: b.comment !== undefined ? String(b.comment).slice(0, 500) : cur?.comment ?? '',
  };
  if (next.qty < 0) throw new PlanError('План не может быть отрицательным');
  // Утверждённый план не меняется случайным вводом, даже у владельца: сначала «Открыть для правок».
  if (state === 'approved' && (next.qty !== (cur?.qty ?? 0) || next.price_manual !== (cur?.price_manual ?? 0))) {
    throw new PlanError('План утверждён. Чтобы изменить числа, сначала откройте его для правок');
  }
  if (next.start_date && (next.start_date > monthEnd(month))) throw new PlanError('Дата старта позже конца месяца');
  d.prepare(`INSERT INTO plan_line (month, mp, article, qty, price_manual, price_frozen, is_new, name, start_date, comment, updated_by, updated_at)
    VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(month, mp, article) DO UPDATE SET qty = excluded.qty, price_manual = excluded.price_manual, is_new = excluded.is_new, name = excluded.name,
      start_date = excluded.start_date, comment = excluded.comment, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
    .run(month, mp, article, next.qty, next.price_manual, next.is_new, next.name, next.start_date, next.comment, user.name, Date.now());
  logChange(user, month, mp, article, 'план, шт', cur?.qty ?? 0, next.qty);
  logChange(user, month, mp, article, 'цена, ₽', cur?.price_manual ?? 0, next.price_manual);
  logChange(user, month, mp, article, 'дата старта', cur?.start_date, next.start_date);
  logChange(user, month, mp, article, 'новинка', cur?.is_new ?? 0, next.is_new);
  if (b.status !== undefined) setStatus(user, mp, article, b.status);
  // Ответ читаем из базы: экран пишет «сохранено», только сверив с тем, что реально записано.
  const saved = d.prepare('SELECT qty, price_manual FROM plan_line WHERE month = ? AND mp = ? AND article = ?').get(month, mp, article) as any;
  return { qty: Number(saved?.qty ?? -1), price: Number(saved?.price_manual ?? -1) };
}

/**
 * В архив и обратно. Права те же, что на правку месяца. В неутверждённых месяцах количество обнуляется
 * (цена, название и прочее остаются): иначе при утверждении товар вернулся бы в план сам.
 * В утверждённом месяце строка доживает до конца месяца.
 */
export function setArchived(user: PlanUser, b: any, on: boolean): void {
  const { month, mp } = guard(user, b);
  const article = up(b?.article);
  if (!article) throw new PlanError('Укажите артикул');
  const d = getDb();
  d.prepare('INSERT OR IGNORE INTO plan_article (mp, article, status) VALUES (?, ?, ?)').run(mp, article, 'Рабочий');
  d.prepare('UPDATE plan_article SET archived_from = ? WHERE mp = ? AND article = ?').run(on ? month : null, mp, article);
  if (on) {
    const lines = d.prepare(`SELECT month, qty FROM plan_line WHERE mp = ? AND article = ? AND month >= ? AND qty > 0
      AND month NOT IN (SELECT month FROM plan_month WHERE mp = ? AND state = 'approved')`).all(mp, article, month, mp) as any[];
    for (const l of lines) {
      d.prepare('UPDATE plan_line SET qty = 0 WHERE month = ? AND mp = ? AND article = ?').run(l.month, mp, article);
      logChange(user, String(l.month), mp, article, 'план, шт', String(l.qty), '0 (архив)');
    }
  }
  logChange(user, month, mp, article, 'архив', on ? '' : 'в архиве', on ? 'в архиве' : 'возвращён');
}


function setStatus(user: PlanUser, mp: PlanMp, article: string, status: unknown): void {
  const next = STATUS(status);
  const d = getDb();
  const cur = (d.prepare('SELECT status FROM plan_article WHERE mp = ? AND article = ?').get(mp, article) as any)?.status ?? 'Рабочий';
  d.prepare('INSERT INTO plan_article (mp, article, status) VALUES (?, ?, ?) ON CONFLICT(mp, article) DO UPDATE SET status = excluded.status').run(mp, article, next);
  logChange(user, currentMonth(), mp, article, 'статус', cur, next);
}

export function removeLine(user: PlanUser, b: any): void {
  const { month, mp, state } = guard(user, b);
  if (state === 'approved') throw new PlanError('План утверждён. Чтобы убрать строку, сначала откройте его для правок');
  const article = up(b?.article);
  const d = getDb();
  const cur = d.prepare('SELECT qty FROM plan_line WHERE month = ? AND mp = ? AND article = ?').get(month, mp, article) as any;
  if (!cur) return;
  d.prepare('DELETE FROM plan_line WHERE month = ? AND mp = ? AND article = ?').run(month, mp, article);
  logChange(user, month, mp, article, 'строка удалена', cur.qty, '');
}

/** Новинка получила настоящий артикул на площадке: заказы начнут считаться сами. */
export function renameLine(user: PlanUser, b: any): void {
  const { month, mp } = guard(user, b);
  const from = up(b?.article), to = up(b?.to);
  if (!from || !to) throw new PlanError('Укажите артикул');
  if (from === to) return;
  const d = getDb();
  if (d.prepare('SELECT 1 FROM plan_line WHERE month = ? AND mp = ? AND article = ?').get(month, mp, to)) throw new PlanError(`Артикул ${to} уже есть в плане этого месяца`);
  d.prepare('UPDATE plan_line SET article = ?, updated_by = ?, updated_at = ? WHERE month = ? AND mp = ? AND article = ?').run(to, user.name, Date.now(), month, mp, from);
  logChange(user, month, mp, from, 'артикул', from, to);
}

export function setBasis(user: PlanUser, b: any): void {
  const { month, mp, state } = guard(user, b);
  if (state === 'approved') throw new PlanError('План утверждён: средний чек уже зафиксирован');
  const basis: PlanBasis = b?.basis === '30d' ? '30d' : '7d';
  getDb().prepare('UPDATE plan_month SET basis = ? WHERE month = ? AND mp = ?').run(basis, month, mp);
  // Срок выбрали явно: чек считается заново. Просто открыть и утвердить план чек не меняет.
  getDb().prepare('UPDATE plan_line SET price_frozen = 0 WHERE month = ? AND mp = ?').run(month, mp);
  logChange(user, month, mp, '', 'средний чек за', '', basis === '7d' ? '7 дней' : '30 дней');
}

export function copyPrevious(user: PlanUser, b: any): number {
  const { month, mp } = guard(user, b);
  const prev = shiftMonth(month, -1);
  const d = getDb();
  const rows = d.prepare(`SELECT l.article, l.qty, l.is_new, l.name FROM plan_line l LEFT JOIN plan_article a ON a.mp = l.mp AND a.article = l.article
    WHERE l.month = ? AND l.mp = ? AND l.qty > 0 AND (a.archived_from IS NULL OR a.archived_from > ?)`).all(prev, mp, month) as any[];
  const ins = d.prepare(`INSERT OR IGNORE INTO plan_line (month, mp, article, qty, is_new, name, updated_by, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?)`);
  let n = 0;
  d.exec('BEGIN');
  try {
    for (const r of rows) { const x = ins.run(month, mp, r.article, r.qty, r.name, user.name, Date.now()); n += Number(x.changes) || 0; }
    d.exec('COMMIT');
  } catch (e) { d.exec('ROLLBACK'); throw e; }
  logChange(user, month, mp, '', 'копия прошлого месяца', '', `${n} строк`);
  return n;
}

/** Утверждение: цена каждой строки фиксируется, чтобы рублёвый план не плавал вместе со средним чеком. */
export async function approve(user: PlanUser, b: any, on: boolean): Promise<void> {
  if (user.role !== 'owner') throw new PlanError('Утверждает план только владелец');
  const { month, mp } = guard(user, b);
  const d = getDb();
  if (on) {
    const built = await buildMp(mp, month);
    const planned = built.rows.filter(r => r.qty > 0);
    if (!planned.length) throw new PlanError('В плане нет ни одной строки с количеством');
    const noPrice = planned.filter(r => r.price <= 0).map(r => r.article);
    if (noPrice.length) throw new PlanError(`Нет цены у ${noPrice.length} шт.: ${noPrice.slice(0, 5).join(', ')}. Задайте плановую цену`);
    const upd = d.prepare('UPDATE plan_line SET price_frozen = ? WHERE month = ? AND mp = ? AND article = ?');
    d.exec('BEGIN');
    try {
      for (const r of planned) upd.run(r.price, month, mp, r.article);
      d.prepare(`UPDATE plan_month SET state = 'approved', approved_by = ?, approved_at = ? WHERE month = ? AND mp = ?`).run(user.name, Date.now(), month, mp);
      d.exec('COMMIT');
    } catch (e) { d.exec('ROLLBACK'); throw e; }
    logChange(user, month, mp, '', 'статус плана', 'черновик', 'утверждён');
    await saveVersion(user, month, mp, 'утверждён');
  } else {
    // Копия на случай, если этот план утвердили ещё до появления версий. Чек остаётся зафиксированным.
    await saveVersion(user, month, mp, 'открыт для правок');
    d.prepare(`UPDATE plan_month SET state = 'draft', approved_by = NULL, approved_at = NULL WHERE month = ? AND mp = ?`).run(month, mp);
    logChange(user, month, mp, '', 'статус плана', 'утверждён', 'черновик');
  }
}

// ─── Версии плана: копия всех строк месяца, из которой план можно вернуть ───

const LINE_COLS = 'article, qty, price_manual, price_frozen, is_new, name, start_date, comment';

/** Сохраняет копию. Если строки не изменились с прошлой копии, новую не создаёт. */
async function saveVersion(user: PlanUser, month: string, mp: PlanMp, reason: string): Promise<void> {
  const d = getDb();
  const head = d.prepare('SELECT state, basis FROM plan_month WHERE month = ? AND mp = ?').get(month, mp) as any;
  const rows = d.prepare(`SELECT ${LINE_COLS} FROM plan_line WHERE month = ? AND mp = ? ORDER BY article`).all(month, mp) as any[];
  const lines = JSON.stringify(rows);
  const last = d.prepare('SELECT lines, state FROM plan_version WHERE month = ? AND mp = ? ORDER BY id DESC LIMIT 1').get(month, mp) as any;
  if (last?.lines === lines) return;
  const qty = rows.reduce((s, r) => s + Number(r.qty), 0);
  // Сумма как на экране: у строки без зафиксированного чека цена берётся из текущего среднего.
  let rubTotal = rows.reduce((s, r) => s + Number(r.qty) * (Number(r.price_manual) || Number(r.price_frozen)), 0);
  try { rubTotal = (await buildMp(mp, month)).rows.reduce((s, r) => s + r.planRub, 0); } catch { /* копия важнее точной суммы в подписи */ }
  d.prepare('INSERT INTO plan_version (month, mp, at, user, reason, state, basis, qty, rub, lines) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(month, mp, Date.now(), user.name, reason, head?.state ?? 'draft', head?.basis ?? '7d', qty, rubTotal, lines);
}

export function getVersions(monthIn: unknown, mpIn: unknown): { ok: true; rows: unknown[] } {
  const month = isMonth(monthIn) ? monthIn : currentMonth();
  const mp = mpIn === 'ozon' ? 'ozon' : 'wb';
  const rows = getDb().prepare('SELECT id, at, user, reason, state, qty, rub FROM plan_version WHERE month = ? AND mp = ? ORDER BY id DESC LIMIT 30').all(month, mp);
  return { ok: true, rows };
}

/** Возврат версии. Текущий план сначала сохраняется, поэтому и этот шаг можно отменить. */
export async function restoreVersion(user: PlanUser, b: any): Promise<void> {
  if (user.role !== 'owner') throw new PlanError('Вернуть версию плана может только владелец');
  const { month, mp } = guard(user, b);
  const d = getDb();
  const v = d.prepare('SELECT * FROM plan_version WHERE id = ? AND month = ? AND mp = ?').get(Number(b?.id), month, mp) as any;
  if (!v) throw new PlanError('Такой версии плана нет');
  await saveVersion(user, month, mp, 'перед возвратом версии');
  const before = new Map((d.prepare('SELECT article, qty FROM plan_line WHERE month = ? AND mp = ?').all(month, mp) as any[]).map(r => [String(r.article), Number(r.qty)]));
  const lines = JSON.parse(String(v.lines)) as any[];
  const ins = d.prepare(`INSERT INTO plan_line (month, mp, article, qty, price_manual, price_frozen, is_new, name, start_date, comment, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const at = Date.now();
  d.exec('BEGIN');
  try {
    d.prepare('DELETE FROM plan_line WHERE month = ? AND mp = ?').run(month, mp);
    for (const l of lines) ins.run(month, mp, l.article, l.qty, l.price_manual, l.price_frozen, l.is_new, l.name, l.start_date, l.comment, user.name, at);
    const approved = v.state === 'approved';
    d.prepare('UPDATE plan_month SET state = ?, basis = ?, approved_by = ?, approved_at = ? WHERE month = ? AND mp = ?')
      .run(v.state, v.basis, approved ? user.name : null, approved ? at : null, month, mp);
    d.exec('COMMIT');
  } catch (e) { d.exec('ROLLBACK'); throw e; }
  const after = new Map(lines.map(l => [String(l.article), Number(l.qty)]));
  for (const a of new Set([...before.keys(), ...after.keys()])) logChange(user, month, mp, a, 'план, шт (возврат версии)', before.get(a) ?? 0, after.get(a) ?? 0);
  logChange(user, month, mp, '', 'возврат версии плана', '', `${n0Ru(Number(v.qty))} шт`);
}
const n0Ru = (v: number) => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(v);

export function getLog(monthIn: unknown, mpIn: unknown): { ok: true; rows: unknown[] } {
  const month = isMonth(monthIn) ? monthIn : currentMonth();
  const mp = mpIn === 'ozon' ? 'ozon' : 'wb';
  const rows = getDb().prepare('SELECT at, user, article, field, before, after FROM plan_log WHERE month = ? AND mp = ? ORDER BY id DESC LIMIT 200').all(month, mp);
  return { ok: true, rows };
}

/** /api/plan/* */
export async function handlePlan(req: any, res: any, sub: string, user: PlanUser): Promise<any> {
  try {
    if (req.method === 'GET') {
      if (sub === 'stats') return res.status(200).json(await getPlanStats(req.query.view, req.query.article));
      if (sub === 'rnp') return res.status(200).json(await getPlanForRnp(req.query.mp));
      if (sub === 'log') return res.status(200).json(getLog(req.query.month, req.query.mp));
      if (sub === 'versions') return res.status(200).json(getVersions(req.query.month, req.query.mp));
      return res.status(200).json(await getPlan(req.query.view, req.query.month, user));
    }
    const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body ?? {});
    switch (sub) {
      case 'line': return res.status(200).json({ ok: true, saved: saveLine(user, b) });
      case 'archive': setArchived(user, b, true); break;
      case 'unarchive': setArchived(user, b, false); break;
      case 'remove': removeLine(user, b); break;
      case 'rename': renameLine(user, b); break;
      case 'basis': setBasis(user, b); break;
      case 'copy': return res.status(200).json({ ok: true, copied: copyPrevious(user, b) });
      case 'approve': await approve(user, b, true); break;
      case 'unapprove': await approve(user, b, false); break;
      case 'restore': await restoreVersion(user, b); break;
      default: return res.status(404).json({ error: 'not_found' });
    }
    return res.status(200).json({ ok: true });
  } catch (e) {
    if (e instanceof PlanError) return res.status(400).json({ ok: false, error: e.message });
    return res.status(500).json({ ok: false, error: String((e as Error)?.message ?? e).slice(0, 200) });
  }
}
