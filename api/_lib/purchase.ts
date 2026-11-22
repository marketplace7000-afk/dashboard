/**
 * «Закупки» (19.11.2026) — что, сколько и когда заказать в Китае. Только владелец (permissions.ts).
 * Расчёт — shared/purchase.ts; здесь только сбор данных из уже готовых источников (новых запросов к WB/Ozon нет):
 *   продажи по дням и остатки FBO   — база РНП (rnp.ts);
 *   свои склады/ФФ и «В пути»       — таблица «Склад» (stockSheet.ts), вес/закуп/«в коробке» — столбцы H, J, O листов;
 *   цена фабрики по последней партии — «Склад → В доставке»;
 *   партии в пути и сроки доставки  — трекер закупщика Supply_Tracker, лист «Tracker»;
 *   статус товара и план месяца     — «План» (plan.ts).
 * Хранится только своё: настройки (дни запаса, курсы, сезонность) и отметки «больше не закупаем» —
 * .av-cache/purchase.sqlite.
 *
 *   GET  /api/purchase            → строки расчёта, итоги, настройки, сбои источников
 *   POST /api/purchase/settings   → { coverDays, safetyDays, leadDays, usd, cny, usdPerKg, season, … }
 *   POST /api/purchase/skip       → { key, skip: true|false }
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { mskDate } from './mskDate';
import { planArticleFacts, rnpFactRows, rnpItems } from './rnp';
import { getStockSheet } from './stockSheet';
import { planForPurchase } from './plan';
import { fetchWithRetry } from './fetchRetry';
import { cacheGet, cacheSet, isFresh } from './cache';
import {
  DEFAULT_SETTINGS, calcRow, matchCalendarPurchase, median, moneyCheck, parseTracker, planSaysSkip, purchaseKey, resolveSkip, serialToDate, totals,
  type MoneyCheck,
  type PurchaseInput, type PurchaseRow, type PurchaseSettings, type PurchaseTotals, type TransitLot,
} from '../../shared/purchase';
import { dailyCash } from '../../shared/finance';

let DatabaseSync: any = null;
try { DatabaseSync = require('node:sqlite').DatabaseSync; } catch { DatabaseSync = null; }

const TRACKER_ID = '1cdIpSwyMtSoaLJlCFRijG-XK8iEQ9x-HBQg-uF6XSvg';
/** Листы таблицы «Склад», где есть вес (H), закуп (J) и «в коробке» (O) — строки товаров одинаковые. */
const INFO_SHEETS = ['ФФ Подольск', 'Склад Уфа'];

// Товары «Вывод» уходят в архив сами по «Плану»; вручную — только то, у чего в «Плане» другой статус.
const SEED_SKIP = ['BOARD-30*40-JS-03'];

let db: any = null;
function pdb(): any {
  if (db) return db;
  if (!DatabaseSync) throw new Error('База закупок недоступна на сервере (нужен Node 22.5+)');
  const dir = process.env.CACHE_DIR || join(process.cwd(), '.av-cache');
  mkdirSync(dir, { recursive: true });
  db = new DatabaseSync(join(dir, 'purchase.sqlite'));
  db.exec(`
    PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS pur_setting (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS pur_skip (key TEXT PRIMARY KEY, who TEXT NOT NULL, at TEXT NOT NULL, skip INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS pur_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, who TEXT NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS pur_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
  `);
  // Первая ручная отметка (ответ владельца 19.11: неоновая доска, в «Плане» она «Рабочий»). Ставится один раз.
  if (!db.prepare("SELECT 1 FROM pur_meta WHERE k = 'seed-skip-1'").get()) {
    const ins = db.prepare('INSERT OR IGNORE INTO pur_skip (key, who, at) VALUES (?, ?, ?)');
    for (const k of SEED_SKIP) ins.run(k, 'владелец (ответ 19.11)', new Date().toISOString());
    db.prepare("INSERT INTO pur_meta (k, v) VALUES ('seed-skip-1', ?)").run(new Date().toISOString());
  }
  return db;
}
const log = (who: string, action: string, detail: unknown) =>
  pdb().prepare('INSERT INTO pur_log (ts, who, action, detail) VALUES (?, ?, ?, ?)').run(new Date().toISOString(), who, action, JSON.stringify(detail));

export function getSettings(): PurchaseSettings {
  const s: any = { ...DEFAULT_SETTINGS, season: [...DEFAULT_SETTINGS.season] };
  for (const r of pdb().prepare('SELECT k, v FROM pur_setting').all() as any[]) {
    try { s[r.k] = JSON.parse(r.v); } catch (e) { console.warn('[purchase] настройка не прочитана:', r.k, (e as Error).message); }
  }
  return s;
}

const NUM_KEYS = ['coverDays', 'safetyDays', 'leadDays', 'moscowFfDays', 'minOrderDays', 'usdPerKg', 'usd', 'cny', 'turnMin'] as const;
export function setSettings(b: any, who: string): PurchaseSettings {
  const cur = getSettings();
  const next: any = { ...cur };
  for (const k of NUM_KEYS) {
    if (b?.[k] === undefined) continue;
    const n = Number(String(b[k]).replace(',', '.'));
    if (!Number.isFinite(n) || n < 0 || n > (k === 'turnMin' ? 100_000_000 : 100_000)) throw new Error(`неверное значение «${k}»`);
    next[k] = n;
  }
  if (b?.usd !== undefined || b?.cny !== undefined) next.ratesAt = mskDate(0);
  if (Array.isArray(b?.season)) {
    if (b.season.length !== 12) throw new Error('сезонность — 12 месяцев');
    next.season = b.season.map((x: unknown) => { const n = Number(String(x).replace(',', '.')); if (!(n > 0 && n < 10)) throw new Error('коэффициент сезонности от 0 до 10'); return n; });
  }
  if (next.coverDays < 1 || next.coverDays > 365) throw new Error('запас партии — от 1 до 365 дней');
  const up = pdb().prepare('INSERT INTO pur_setting (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v');
  for (const k of Object.keys(next)) if (JSON.stringify(next[k]) !== JSON.stringify((cur as any)[k])) up.run(k, JSON.stringify(next[k]));
  log(who, 'settings', { before: cur, after: next });
  cache = null;
  return next;
}

/** Статус товара в «Плане» по всем площадкам и дублям: Новинка главнее Рабочего, Рабочий — Вывода, Вывод — архива. */
function planByPurchaseKey(month: string): Map<string, { status: string; qty: number; isNew: boolean }> {
  const out = new Map<string, { status: string; qty: number; isNew: boolean }>();
  const rank = (x: string) => x === 'Новинка' ? 2 : x === 'Вывод' ? 0 : x === 'Архив' ? -1 : 1;
  for (const [a, p] of planForPurchase(month)) {
    const k = purchaseKey(a);
    const cur = out.get(k);
    if (!cur) { out.set(k, { ...p }); continue; }
    cur.qty += p.qty; cur.isNew ||= p.isNew;
    if (rank(p.status) > rank(cur.status)) cur.status = p.status;
  }
  return out;
}

/** Галочка «В архив». Совпала с тем, что говорит «План», — ручная отметка не нужна, «План» снова главный. */
export function setSkip(key: string, skip: boolean, who: string): void {
  const k = purchaseKey(key);
  if (!k) throw new Error('нет артикула');
  const status = planByPurchaseKey(mskDate(0).slice(0, 7)).get(k)?.status ?? '';
  if (skip === planSaysSkip(status)) pdb().prepare('DELETE FROM pur_skip WHERE key = ?').run(k);
  else pdb().prepare('INSERT OR REPLACE INTO pur_skip (key, who, at, skip) VALUES (?, ?, ?, ?)').run(k, who, new Date().toISOString(), skip ? 1 : 0);
  log(who, skip ? 'skip' : 'unskip', { key: k, planStatus: status });
  cache = null;
}

/** Курсы ЦБ (доллар и юань) — запасной вариант, пока владелец не вписал свой курс. */
async function cbrRates(): Promise<{ usd: number; cny: number; date: string } | null> {
  const KEY = 'cbr-usd-cny:v1';
  const c = await cacheGet<{ usd: number; cny: number; date: string }>(KEY);
  if (isFresh(c)) return c.data;
  try {
    const res = await fetchWithRetry('https://www.cbr-xml-daily.ru/daily_json.js', { method: 'GET' }, { maxRetries: 2, timeoutMs: 15_000 });
    if (!res.ok) throw new Error(`cbr → ${res.status}`);
    const j: any = await res.json();
    const v = (code: string) => Number(j?.Valute?.[code]?.Value) / (Number(j?.Valute?.[code]?.Nominal) || 1);
    const data = { usd: Math.round(v('USD') * 100) / 100, cny: Math.round(v('CNY') * 100) / 100, date: String(j?.Date ?? '').slice(0, 10) };
    if (!(data.usd > 0)) throw new Error('нет курса USD');
    await cacheSet(KEY, data, 6 * 3600_000);
    return data;
  } catch (e) {
    console.warn('[purchase] курс ЦБ не получен:', (e as Error).message);
    return (c as { data: { usd: number; cny: number; date: string } } | null)?.data ?? null;
  }
}

const num = (v: unknown) => { const n = Number(String(v ?? '').replace(/\s/g, '').replace(',', '.')); return Number.isFinite(n) ? n : 0; };

/** Продажи по закупочному товару: штук за 7/30 дней и дней в наличии, по площадкам. */
function salesByKey(today: string, failed: string[]) {
  const from = addD(today, -30), to = addD(today, -1), from7 = addD(today, -7);
  type Acc = { s7: number; s30: number; inStock: Set<string>; inStock7: Set<string> };
  const out = new Map<string, Record<'wb' | 'ozon', Acc>>();
  const names = new Map<string, string>();
  for (const mp of ['wb', 'ozon'] as const) {
    try {
      const { byArticle, items } = planArticleFacts(mp, from, to);
      for (const [a, it] of items) if (it.name && !names.has(purchaseKey(a))) names.set(purchaseKey(a), it.name);
      const get = (k: string) => {
        let x = out.get(k);
        if (!x) { x = { wb: { s7: 0, s30: 0, inStock: new Set(), inStock7: new Set() }, ozon: { s7: 0, s30: 0, inStock: new Set(), inStock7: new Set() } }; out.set(k, x); }
        return x[mp];
      };
      for (const [a, v] of byArticle) {
        const acc = get(purchaseKey(a));
        for (const [date, d] of v.days) {
          if (d.cnt <= 0) continue;
          acc.s30 += d.cnt; acc.inStock.add(date);
          if (date >= from7) { acc.s7 += d.cnt; acc.inStock7.add(date); }
        }
      }
      // Дни в наличии: остаток площадки > 0 (по всем карточкам артикула).
      const artOf = new Map(rnpItems(mp).map(i => [i.sku, purchaseKey(i.article || i.sku)]));
      for (const r of rnpFactRows(mp, ['stocks'], from, to)) {
        if (!(r.value > 0)) continue;
        const acc = get(artOf.get(String(r.sku)) ?? purchaseKey(r.sku));
        acc.inStock.add(r.date);
        if (r.date >= from7) acc.inStock7.add(r.date);
      }
    } catch (e) {
      failed.push(`продажи ${mp === 'wb' ? 'WB' : 'Ozon'} не прочитаны (${(e as Error).message})`);
    }
  }
  return { out, names };
}

/** FBO площадок по закупочному товару: последний обход остатков РНП. */
function fboByKey(today: string, failed: string[]): Map<string, { wb: number; ozon: number }> {
  const res = new Map<string, { wb: number; ozon: number }>();
  for (const mp of ['wb', 'ozon'] as const) {
    try {
      const rows = rnpFactRows(mp, ['stocks_fbo'], addD(today, -3), today);
      const last = rows.reduce((m, r) => r.date > m ? r.date : m, '');
      const artOf = new Map(rnpItems(mp).map(i => [i.sku, purchaseKey(i.article || i.sku)]));
      for (const r of rows) if (r.date === last && r.value > 0) {
        const k = artOf.get(String(r.sku)) ?? purchaseKey(r.sku);
        const x = res.get(k) ?? { wb: 0, ozon: 0 };
        x[mp] += r.value;
        res.set(k, x);
      }
    } catch (e) { failed.push(`остатки FBO ${mp === 'wb' ? 'WB' : 'Ozon'} не прочитаны (${(e as Error).message})`); }
  }
  return res;
}

/**
 * Заказы WB по месяцам с августа 2025 — таблица «Культуры Аналитики» (ссылку дал владелец 19.11),
 * лист plan_actual: A nm_id, B месяц (дата-число), C заказы ₽. Таблица тяжёлая — читаем кусками
 * с повтором и держим сутки. Только для сезонности: сбой не мешает остальному расчёту.
 */
const KA_WB_SHEET = '1DJifBgSzjlOMbiuSy8d-UPLkLCOGKz2_8IjS7qJi8DI';
async function wbHistory(failed: string[]): Promise<Map<string, Record<string, number>>> {
  const KEY = 'purchase-wb-history:v1';
  const c = await cacheGet<Array<[string, string, number]>>(KEY);
  let rows = c?.data ?? null;
  if (!isFresh(c)) {
    try {
      const { readSheetRange } = await import('./googleSheetsApi');
      const all: Array<[string, string, number]> = [];
      for (let a = 3; a < 100_000; a += 4000) {
        let part: any[][] = [], err: Error | null = null;
        for (let t = 0; t < 3; t++) {
          try { part = await readSheetRange(KA_WB_SHEET, `'plan_actual'!A${a}:C${a + 3999}`); err = null; break; } catch (e) { err = e as Error; }
        }
        if (err) throw err;
        for (const r of part) {
          const m = serialToDate(r?.[1]).slice(0, 7), v = num(r?.[2]);
          if (m && v > 0) all.push([String(r?.[0] ?? '').trim(), m, v]);
        }
        if (part.length < 4000) break;
      }
      if (all.length) { rows = all; await cacheSet(KEY, all, 24 * 3600_000); }
    } catch (e) {
      console.warn('[purchase] история WB (Культура Аналитики) не прочитана:', (e as Error).message);
      if (!rows) failed.push(`продажи WB прошлого года не прочитаны — сезонность только из настроек (${(e as Error).message})`);
    }
  }
  const out = new Map<string, Record<string, number>>();
  if (!rows) return out;
  const artOf = new Map(rnpItems('wb').map(i => [i.sku, purchaseKey(i.article || i.sku)]));
  for (const [nm, m, v] of rows) {
    const k = artOf.get(nm);
    if (!k) continue;
    const h = out.get(k) ?? {};
    h[m] = (h[m] ?? 0) + v;
    out.set(k, h);
  }
  return out;
}

const addD = (d: string, n: number) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86_400_000).toISOString().slice(0, 10);

export type PurchaseResponse = {
  ok: true; today: string; builtAt: string;
  settings: PurchaseSettings; rates: { usd: number; cny: number; source: 'owner' | 'cbr' | 'none'; date: string };
  leadDefault: number; leadSamples: number;
  rows: PurchaseRow[]; totals: PurchaseTotals; money: MoneyCheck | null; minBalance: number;
  lots: TransitLot[];
  failed: string[];
  notes: string[];
  /** Сезонность категорий, которая идёт в расчёт (показ в настройках). */
  seasonUsed: { category: string; wb: number[]; ozon: number[]; trendFrom: string; products: number }[];
};

let cache: { at: number; data: PurchaseResponse } | null = null;
let building: Promise<PurchaseResponse> | null = null;

export function getPurchase(force = false): Promise<PurchaseResponse> {
  if (!force && cache && Date.now() - cache.at < 10 * 60_000) return Promise.resolve(cache.data);
  if (building) return building;
  building = build().then(d => { if (!d.failed.length) cache = { at: Date.now(), data: d }; return d; }).finally(() => { building = null; });
  return building;
}

async function build(): Promise<PurchaseResponse> {
  const today = mskDate(0);
  const failed: string[] = [];
  const notes: string[] = [];
  const settings = getSettings();
  const { readSheetRange } = await import('./googleSheetsApi');
  const skladId = (process.env.SKLAD_SHEET_ID || '').trim();

  // Свои склады и «В пути» (таблица «Склад»).
  const sheet = await getStockSheet();
  if (sheet.error) failed.push(`таблица «Склад»: ${sheet.error}`);
  const stock = new Map<string, { ff: number; transit: number; articles: Set<string> }>();
  for (const it of Object.values(sheet.items)) {
    const k = purchaseKey(it.article);
    const x = stock.get(k) ?? { ff: 0, transit: 0, articles: new Set<string>() };
    x.ff += it.total.stock; x.transit += it.total.transit; x.articles.add(it.article);
    stock.set(k, x);
  }

  // Вес, закуп, «в коробке», название — строки листов «Склада».
  const info = new Map<string, { name: string; weightG: number; landed: number; box: number }>();
  for (const sh of INFO_SHEETS) {
    try {
      for (const r of await readSheetRange(skladId, `'${sh}'!A4:O3000`) as any[][]) {
        const a = String(r?.[2] ?? '').trim();
        if (!a) continue;
        const k = purchaseKey(a);
        const cur = info.get(k) ?? { name: '', weightG: 0, landed: 0, box: 0 };
        // Основной артикул главнее дубля: у дубля цена бывает выше (ШК, доставка в Китай).
        const isBase = a.toUpperCase() === k;
        if (!cur.name || isBase) cur.name = String(r?.[3] ?? '').trim() || cur.name;
        if (!cur.weightG || isBase) cur.weightG = num(r?.[7]) || cur.weightG;
        if (!cur.landed || isBase) cur.landed = num(r?.[9]) || cur.landed;
        if (!cur.box || isBase) cur.box = num(r?.[14]) || cur.box;
        info.set(k, cur);
      }
    } catch (e) { failed.push(`лист «${sh}» не прочитан (${(e as Error).message})`); }
  }

  // WB Global в расчёт не берём (владелец 21.11.2026: с января 2027 уходим с площадки, остаются WB и Ozon).

  // «В доставке» — товар, заказанный в Китае и ещё не принятый на склад (владелец 19.11: столбец «В пути»
  // листов склада — это перемещения между складами, а заказы из Китая — здесь).
  // A заказ, D название, E артикул, F кол-во, G цена без упаковки, I место приёмки.
  const factory = new Map<string, number>();
  const china: { order: string; key: string; qty: number; place: string }[] = [];
  try {
    for (const r of await readSheetRange(skladId, `'В доставке'!A2:I2000`) as any[][]) {
      const k = purchaseKey(String(r?.[4] ?? ''));
      if (!k) continue;
      const p = num(r?.[6]);
      if (p > 0) factory.set(k, p);   // строки идут по порядку заказов: последняя — свежая
      const q = num(r?.[5]);
      if (q > 0) china.push({ order: String(r?.[0] ?? '').trim(), key: k, qty: q, place: String(r?.[8] ?? '').trim() });
    }
  } catch (e) { failed.push(`«В доставке» не прочитан (${(e as Error).message})`); }

  // Трекер закупщика.
  let tracker: ReturnType<typeof parseTracker> = { lots: [], leads: new Map(), allLeads: [] };
  try {
    tracker = parseTracker(await readSheetRange(TRACKER_ID, `'Tracker'!A2:AC2000`) as unknown[][], today, settings.moscowFfDays);
  } catch (e) { failed.push(`трекер закупщика не прочитан (${(e as Error).message})`); }
  // Партии из Китая: количество — «В доставке», этап и дата прихода — трекер (по номеру заказа и артикулу).
  const lots: TransitLot[] = china.map(c => {
    const t = tracker.lots.find(l => l.order === c.order && l.article === c.key);
    return t ? { ...t, qty: c.qty } : { order: c.order, article: c.key, qty: c.qty, stage: 'нет в трекере', eta: '', issues: ['заказа нет в трекере закупщика'] };
  });
  for (const t of tracker.lots) {
    if (!china.some(c => c.order === t.order && c.key === t.article)) t.issues.push('в трекере едет, а в «В доставке» строки нет');
  }
  const trackerMedian = Math.round(median(tracker.allLeads));
  const leadDefault = settings.leadDays > 0 ? settings.leadDays : trackerMedian || 41;

  // Закупки, которые уже стоят в календаре «Финансов» и ещё не оплачены (21.11.2026): считаем их партией,
  // которая придёт через срок доставки после оплаты, — рекомендация их не дублирует. Деньги за них уже
  // в прогнозе «Финансов», поэтому в проверке денег второй раз не появляются.
  // Товары строки закупки (окно операции «Финансов», 21.11.2026) главнее текста. Оплаченная закупка считается
  // заказанной, пока её товара нет в «В доставке»: так между оплатой и строкой склада нет провала.
  const calendarNotes: string[] = [];
  try {
    const fin: any = await import('./finance');
    const keys = [...stock.keys()];
    const ddmm = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}`;
    const withItems = new Set<number>();
    if (typeof fin.purchaseItems === 'function') {
      for (const p of fin.purchaseItems(today, 60) as Array<{ opId: number; date: string; paid: boolean; items: Array<{ article: string; qty: number }> }>) {
        withItems.add(p.opId);
        for (const it of p.items) {
          const k = purchaseKey(it.article);
          if (!k || !(it.qty > 0)) continue;
          if (!stock.has(k)) { calendarNotes.push(`артикул ${it.article} (${ddmm(p.date)}) не найден в «Складе»`); continue; }
          if (p.paid && china.some(c => c.key === k)) continue;   // уже в «В доставке» — считается там
          const pay = p.date > today ? p.date : today;
          lots.push({ order: `календарь ${ddmm(p.date)}`, article: k, qty: it.qty, stage: p.paid ? 'Оплачено по календарю «Финансов», в «В доставке» ещё нет' : 'Стоит в календаре «Финансов», ещё не оплачено', eta: addD(p.paid ? p.date : pay, leadDefault), issues: [] });
        }
      }
    }
    for (const o of fin.allOps() as Array<{ id: number; type: string; cat: string; status: string; date: string; descr: string }>) {
      if (withItems.has(o.id) || o.type !== 'out' || !/^Закупка товара/.test(o.cat) || ['Исполнено', 'Отменено', 'Перенесено'].includes(o.status) || o.date < addD(today, -30)) continue;
      const m = matchCalendarPurchase(o.descr, keys);
      if (!m) { calendarNotes.push(`«${o.descr || o.cat}» на ${o.date.slice(8, 10)}.${o.date.slice(5, 7)}`); continue; }
      const pay = o.date > today ? o.date : today;
      lots.push({ order: `календарь ${o.date.slice(8, 10)}.${o.date.slice(5, 7)}`, article: m.key, qty: m.qty, stage: 'Стоит в календаре «Финансов», ещё не оплачено', eta: addD(pay, leadDefault), issues: [] });
    }
    if (calendarNotes.length) notes.push(`В календаре «Финансов» есть закупки без понятного товара или количества — в расчёте не учтены: ${calendarNotes.join('; ')}. В окне закупки выберите товар и количество (или напишите в строке артикул и «N шт»).`);
  } catch (e) { failed.push(`закупки из календаря «Финансов» не прочитаны (${(e as Error).message})`); }

  let planByKey = new Map<string, { status: string; qty: number; isNew: boolean }>();
  try { planByKey = planByPurchaseKey(today.slice(0, 7)); } catch (e) { failed.push(`«План» не прочитан (${(e as Error).message})`); }

  const { out: sales, names } = salesByKey(today, failed);
  const fbo = fboByKey(today, failed);
  const history = await wbHistory(failed);
  // Сезонность категорий по площадкам (лист «Сезонность»): только то, что повторилось два года.
  let seasonCats: import('./season').PurchaseSeasonCat[] = [];
  try { seasonCats = await (await import('./season')).purchaseSeason(today); } catch (e) { failed.push(`сезонность категорий не прочитана — взята запасная (${(e as Error).message})`); }
  const seasonByKey = new Map(seasonCats.flatMap(c => c.products.map(k => [k, c] as const)));
  const overrides = new Map((pdb().prepare('SELECT key, skip FROM pur_skip').all() as any[]).map(r => [String(r.key), Number(r.skip) === 1] as const));

  const rawRates = settings.usd > 0 && settings.cny > 0 ? null : await cbrRates();
  const rates = {
    usd: settings.usd > 0 ? settings.usd : rawRates?.usd ?? 0,
    cny: settings.cny > 0 ? settings.cny : rawRates?.cny ?? 0,
    source: (settings.usd > 0 ? 'owner' : rawRates ? 'cbr' : 'none') as 'owner' | 'cbr' | 'none',
    date: settings.usd > 0 ? settings.ratesAt : rawRates?.date ?? '',
  };
  const calcSettings = { ...settings, usd: rates.usd, cny: rates.cny };

  // Закупочные товары: всё, что есть в «Складе» (там только наш товар с себестоимостью).
  const rows: PurchaseRow[] = [];
  for (const [key, st] of stock) {
    const s = sales.get(key);
    const rateOf = (a: { s7: number; s30: number; inStock: Set<string>; inStock7: Set<string> } | undefined) => {
      if (!a || a.s30 <= 0) return 0;
      const r30 = a.s30 / Math.max(7, a.inStock.size);
      const r7 = a.s7 / Math.max(3, a.inStock7.size);
      return (r30 + r7) / 2;
    };
    const sold30 = (s?.wb.s30 ?? 0) + (s?.ozon.s30 ?? 0);
    const p = planByKey.get(key);
    const fb = fbo.get(key) ?? { wb: 0, ozon: 0 };
    const fboQ = fb.wb + fb.ozon;
    const myLots = lots.filter(l => l.article === key);
    const chinaQty = myLots.reduce((a, l) => a + l.qty, 0);
    const calQty = myLots.filter(l => l.order.startsWith('календарь')).reduce((a, l) => a + l.qty, 0);
    // «В пути» листов склада = перемещения между нашими складами (+ товар из Китая, когда ему назначен склад приёмки):
    // перемещения — это тот же FBS, который скоро будет на месте. Закупки из календаря в «Складе» ещё не видны.
    const moving = Math.max(0, st.transit - (chinaQty - calQty));
    if (sold30 <= 0 && st.ff + fboQ + moving <= 0 && chinaQty <= 0 && !(p?.qty)) continue;   // не в продаже
    const inStockDays = new Set([...(s?.wb.inStock ?? []), ...(s?.ozon.inStock ?? [])]).size;
    const inf = info.get(key);
    const leads = tracker.leads.get(key) ?? [];
    const x: PurchaseInput = {
      key, name: inf?.name || names.get(key) || key, articles: [...st.articles].sort(),
      rate: { wb: rateOf(s?.wb), wbg: 0, ozon: rateOf(s?.ozon) },
      sold7: (s?.wb.s7 ?? 0) + (s?.ozon.s7 ?? 0), sold30, inStockDays,
      stockFf: st.ff + moving, stockFbo: fboQ, fbo: fb, transit: chinaQty,
      lots: myLots,
      boxQty: inf?.box ?? 0, weightG: inf?.weightG ?? 0,
      factoryPrice: factory.get(key) ?? 0, landedCost: inf?.landed ?? 0,
      leadOwn: median(leads), leadSamples: leads.length,
      ...resolveSkip(p?.status ?? '', overrides.get(key)), planStatus: p?.status ?? '', planQty: p?.qty ?? 0,
      history: history.get(key),
      seasonCat: (() => { const c = seasonByKey.get(key); return c ? { category: c.category, wb: c.wb, ozon: c.ozon, trendFrom: c.trendFrom } : undefined; })(),
    };
    // Нет партии в «В доставке» — цена фабрики ≈ себестоимость минус оценка логистики ($/кг).
    if (!x.factoryPrice && x.landedCost > 0) {
      const logi = (x.weightG / 1000) * settings.usdPerKg * rates.usd;
      x.factoryPrice = Math.max(Math.round(x.landedCost - logi), Math.round(x.landedCost * 0.6));
    }
    const row = calcRow(x, calcSettings, today, leadDefault);
    if (!factory.has(key) && x.landedCost > 0) row.notes.push('цена фабрики оценена по себестоимости минус логистика');
    delete row.history;   // экрану история не нужна — только итоговые коэффициенты
    delete row.seasonCat;
    if (calQty > 0) row.notes.push(`уже стоит в календаре «Финансов»: ${calQty} шт. — рекомендация сверх этого`);
    if (moving > 0) row.notes.push(`перемещается между нашими складами: ${moving} шт. (учтено в FBS)`);
    rows.push(row);
  }
  // Деньги: прогноз остатка «Финансов» минус рекомендованные закупки (раздел «Финансы» ничего не пишет и не меняет).
  let money: MoneyCheck | null = null, minBalance = 500_000;
  try {
    const fin = await import('./finance');
    const fs = fin.getSettings();
    minBalance = fs.minBalance || 500_000;
    const cash = dailyCash(fin.allOps(), fs, addD(today, 150));
    money = moneyCheck(rows.filter(r => !r.skip), cash, minBalance, today, settings.moscowFfDays);
  } catch (e) { failed.push(`прогноз «Финансов» не прочитан — проверки денег нет (${(e as Error).message})`); }

  const order: Record<string, number> = { late: 0, soon: 1, ok: 2, none: 3, skip: 4 };
  rows.sort((a, b) => order[a.signal] - order[b.signal] || (a.daysToOrder ?? 9e9) - (b.daysToOrder ?? 9e9) || b.sold30 - a.sold30);
  return {
    ok: true, today, builtAt: new Date().toISOString(), settings, rates, leadDefault, leadSamples: tracker.allLeads.length,
    rows, totals: totals(rows), money, minBalance,
    seasonUsed: seasonCats.map(c => ({ category: c.category, wb: c.wb, ozon: c.ozon, trendFrom: c.trendFrom, products: c.products.length })),
    lots: [...lots, ...tracker.lots.filter(t => t.issues.includes('в трекере едет, а в «В доставке» строки нет'))],
    failed, notes,
  };
}

export async function handlePurchase(parts: string[], method: string, query: any, body: any, who: string): Promise<{ status: number; json: unknown }> {
  const b = typeof body === 'string' ? JSON.parse(body || '{}') : (body ?? {});
  const a = parts[1] ?? '';
  try {
    if (method === 'GET' && !a) return { status: 200, json: await getPurchase(query?.fresh === '1') };
    if (method === 'POST' && a === 'settings') return { status: 200, json: { ok: true, settings: setSettings(b, who) } };
    if (a === 'season') {
      const S = await import('./season');
      if (method === 'GET') return { status: 200, json: await S.getSeason() };
      // Запустить агента на ПК сейчас (кнопка владельца): доделает то, чего нет в текущем цикле.
      if (method === 'POST' && parts[2] === 'agent') return { status: 200, json: { ok: true, result: await S.queueAgent(`кнопка: ${who}`) } };
      // Ручной запуск сбора (кнопка владельца): WB — недостающие месяцы за год, Ozon — последний месяц.
      if (method === 'POST' && parts[2] === 'collect') {
        const src = String(b.source ?? '');
        if (src === 'wb') { const m = S.wbMissingMonths(); void S.collectWb(m).catch(e => console.warn('[season] WB:', (e as Error).message)); return { status: 200, json: { ok: true, started: 'wb', months: m } }; }
        if (src === 'ozon') { void S.collectOzon().catch(e => console.warn('[season] Ozon:', (e as Error).message)); return { status: 200, json: { ok: true, started: 'ozon' } }; }
        return { status: 400, json: { error: 'bad_request', reason: 'source: wb | ozon' } };
      }
    }
    if (method === 'POST' && a === 'skip') { setSkip(String(b.key ?? ''), !!b.skip, who); return { status: 200, json: { ok: true } }; }
    return { status: 404, json: { error: 'not_found' } };
  } catch (e) {
    const msg = (e as Error).message;
    console.warn('[purchase] не выполнено:', parts.join('/'), msg);
    return { status: 400, json: { error: 'bad_request', reason: msg } };
  }
}
