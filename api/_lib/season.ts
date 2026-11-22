/**
 * «Закупки» → «Сезонность» (21.11.2026): история поисковых запросов наших товаров и сезонность по категориям.
 *
 * Что копим (база season.sqlite в CACHE_DIR, только добавляем, ничего не стираем):
 *   • WB — частота запросов наших карточек по месяцам (search-report/product/search-texts, подписка «Джем»).
 *     WB отдаёт только последние 12 месяцев и только месяцы, когда карточка продавалась: первая выгрузка —
 *     12 месяцев, дальше по одному. Все товары — запросами по 50 карточек.
 *   • Ozon и Вордстат — агент на ПК (кабинет Ozon «Поисковые запросы» за 12 месяцев, Вордстат за 2 года),
 *     см. раздел «Агент на ПК» ниже. collectOzon (API, только последний месяц) оставлен для ручной проверки,
 *     по расписанию не запускается: кабинет даёт год, API — месяц.
 * Расписание (диспетчер API 21.11): WB — 1-го и 16-го в 00:40 МСК; не удалось — повтор в ту же минуту следующей ночью. Минуты Baloo (:x3:04–:x4:04, :x8:04–:x9:04) пропускаем.
 * 402 от WB — закончился «Джем»: не повторяем, пишем в журнал один раз.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { mskDate } from './mskDate';
import { fetchWithRetry } from './fetchRetry';
import { wbUpstream } from '../_proxy';
import { rnpCategories, rnpItems } from './rnp';
import { SLOTS, everyAligned } from './cronSchedule';
import { purchaseKey } from '../../shared/purchase';
import { SKIP_MONTHS, addMonths, calcSeason, mainQueries, seasonIndex, winterDrop, type QuerySeries, type SeasonCategory, type SeasonResponse, type SeasonSource } from '../../shared/season';
// sq_wordstat_query и sq_month_done — служебные; ряды всех источников — в sq_freq (Ozon и Вордстат: key = 'cat:<категория>').

let DatabaseSync: any = null;
try { DatabaseSync = require('node:sqlite').DatabaseSync; } catch { DatabaseSync = null; }

let db: any = null;
export function seasonDb(): any {
  if (db) return db;
  if (!DatabaseSync) throw new Error('база сезонности недоступна (нужен Node 22.5+)');
  const dir = process.env.CACHE_DIR || join(process.cwd(), '.av-cache');
  mkdirSync(dir, { recursive: true });
  db = new DatabaseSync(join(dir, 'season.sqlite'));
  db.exec(`
    PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS sq_freq (
      source TEXT NOT NULL, key TEXT NOT NULL, query TEXT NOT NULL, month TEXT NOT NULL, freq REAL NOT NULL, at TEXT NOT NULL,
      PRIMARY KEY (source, key, query, month));
    CREATE TABLE IF NOT EXISTS sq_run (id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, at TEXT NOT NULL, ok INTEGER NOT NULL, detail TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sq_wordstat_query (query TEXT PRIMARY KEY, category TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sq_month_done (source TEXT NOT NULL, month TEXT NOT NULL, at TEXT NOT NULL, rows INTEGER NOT NULL, PRIMARY KEY (source, month));
  `);
  return db;
}

const nowIso = () => new Date().toISOString();
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
function logRun(source: string, ok: boolean, detail: string) {
  seasonDb().prepare('INSERT INTO sq_run (source, at, ok, detail) VALUES (?, ?, ?, ?)').run(source, nowIso(), ok ? 1 : 0, detail);
  (ok ? console.log : console.warn)(`[season] ${source}: ${detail}`);
}
/** Минуты запуска Baloo (каждые 5 минут в :x3:04 и :x8:04, идёт до минуты) — ждём, пока они пройдут. */
async function avoidBaloo() {
  for (;;) {
    const d = new Date(), m = d.getUTCMinutes() % 5, s = d.getUTCSeconds();
    const inWindow = (m === 3 && s >= 4) || (m === 4 && s < 4);
    if (!inWindow) return;
    await sleep(15_000);
  }
}
function upsert(source: SeasonSource, key: string, query: string, month: string, freq: number) {
  seasonDb().prepare(`INSERT INTO sq_freq (source, key, query, month, freq, at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(source, key, query, month) DO UPDATE SET freq = excluded.freq, at = excluded.at`).run(source, key, query.toLowerCase().trim(), month, freq, nowIso());
}

export type SeasonProduct = { key: string; name: string; articles: string[]; skip: boolean };
/**
 * Закупочные товары: ключ → артикулы карточек (из «Закупок»). given — список от самого расчёта «Закупок»:
 * 22.11 без него расчёт ждал сам себя (getPurchase → сезонность → getPurchase) и раздел не открывался.
 */
async function purchaseProducts(given?: SeasonProduct[]): Promise<SeasonProduct[]> {
  if (given) return given;
  const { getPurchase } = await import('./purchase');
  const p = await getPurchase();
  return p.rows.map(r => ({ key: r.key, name: r.name, articles: r.articles, skip: r.skip }));
}

const monthEnd = (m: string) => { const [y, mm] = m.split('-').map(Number); return new Date(Date.UTC(y, mm, 0)).toISOString().slice(0, 10); };
const shiftMonth = (m: string, n: number) => { const [y, mm] = m.split('-').map(Number); const d = new Date(Date.UTC(y, mm - 1 + n, 1)); return d.toISOString().slice(0, 7); };

// ─── WB ─────────────────────────────────────────────────────────────────────
let wbRunning = false;
/** Собрать частоты WB за месяцы `months` ('YYYY-MM', только полные). Возвращает строку для журнала. */
export async function collectWb(months: string[]): Promise<string> {
  if (wbRunning) return 'уже идёт';
  wbRunning = true;
  try {
    const products = await purchaseProducts();
    const keyByNm = new Map<number, string>();
    for (const it of rnpItems('wb')) {
      const k = purchaseKey(it.article || '');
      if (k && products.some(p => p.key === k) && Number(it.sku) > 0) keyByNm.set(Number(it.sku), k);
    }
    const nms = [...keyByNm.keys()];
    if (!nms.length) throw new Error('нет карточек WB закупочных товаров');
    const up = wbUpstream('analytics');
    const yesterday = mskDate(1);
    let rows = 0, reqs = 0;
    for (const month of months) {
      let monthRows = 0;
      // WB отдаёт не дальше 365 дней назад: самый старый месяц берём с допустимого дня и пересчитываем на весь месяц.
      const oldest = mskDate(364);
      const start = `${month}-01` < oldest ? oldest : `${month}-01`, end = monthEnd(month) < yesterday ? monthEnd(month) : yesterday;
      const scale = (Number(monthEnd(month).slice(8, 10))) / (Math.round((Date.parse(end) - Date.parse(start)) / 86_400_000) + 1);
      // Меньше недели месяца — для сезона не годится; отмечаем месяц собранным, чтобы не просить его каждую ночь.
      if (start > end || scale > 4.5) {
        seasonDb().prepare('INSERT OR IGNORE INTO sq_month_done (source, month, at, rows) VALUES (?, ?, ?, 0)').run('wb', month, nowIso());
        continue;
      }
      for (let i = 0; i < nms.length; i += 50) {
        await avoidBaloo();
        const r = await fetchWithRetry(`${up.base}/api/v2/search-report/product/search-texts`, {
          method: 'POST', headers: { ...up.headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ currentPeriod: { start, end }, nmIds: nms.slice(i, i + 50), topOrderBy: 'openCard', includeSubstitutedSKUs: true, includeSearchTexts: true, orderBy: { field: 'openCard', mode: 'desc' }, limit: 100 }),   // 100 — максимум «Джема» Продвинутый: с 30 главные запросы выпадали из отдельных месяцев
        }, { maxRetries: 3, priority: 2, timeoutMs: 60_000 });
        reqs++;
        if (r.status === 402) throw Object.assign(new Error('WB ответил 402 — закончилась подписка «Джем», сбор остановлен'), { fatal: true });
        if (!r.ok) throw new Error(`WB ${r.status} за ${month}: ${(await r.text()).slice(0, 150)}`);
        const items = ((await r.json()) as any)?.data?.items ?? [];
        // Частота запроса — по всему WB, у разных карточек одного товара она одна и та же: берём максимум.
        const best = new Map<string, number>();
        for (const q of items) {
          const k = keyByNm.get(Number(q.nmId)); const f = Number(q.frequency?.current ?? q.frequency ?? 0);
          if (!k || !q.text || !(f > 0)) continue;
          const id = `${k}\u0001${String(q.text).toLowerCase().trim()}`;
          best.set(id, Math.max(best.get(id) ?? 0, Math.round(f * scale)));
        }
        for (const [id, f] of best) { const [k, q] = id.split('\u0001'); upsert('wb', k, q, month, f); rows++; monthRows++; }
      }
      // Месяц собран целиком (даже пустой — карточки тогда ещё не продавались): больше не просим.
      if (month < mskDate(0).slice(0, 7)) seasonDb().prepare('INSERT INTO sq_month_done (source, month, at, rows) VALUES (?, ?, ?, ?) ON CONFLICT(source, month) DO UPDATE SET at = excluded.at, rows = excluded.rows').run('wb', month, nowIso(), monthRows);
    }
    const msg = `WB: месяцев ${months.length}, запросов к WB ${reqs}, строк ${rows}`;
    logRun('wb', true, msg);
    return msg;
  } catch (e) {
    logRun('wb', false, (e as Error).message);
    throw e;
  } finally { wbRunning = false; }
}

/** Полные месяцы за последний год, которых ещё нет в базе (первая выгрузка — все 12). */
export function wbMissingMonths(): string[] {
  const cur = mskDate(0).slice(0, 7);
  const have = new Set((seasonDb().prepare("SELECT month FROM sq_month_done WHERE source = 'wb'").all() as any[]).map(r => String(r.month)));
  const out: string[] = [];
  for (let i = 12; i >= 1; i--) { const m = shiftMonth(cur, -i); if (!have.has(m)) out.push(m); }
  return out;
}

// ─── Ozon ───────────────────────────────────────────────────────────────────
let ozRunning = false;
/** Запросы наших карточек Ozon за последний доступный месяц (окно −31…−4 дня). Месяц записи — по концу окна. */
export async function collectOzon(): Promise<string> {
  if (ozRunning) return 'уже идёт';
  ozRunning = true;
  try {
    const products = await purchaseProducts();
    const keyBySku = new Map<string, string>();
    for (const it of rnpItems('ozon')) {
      const k = purchaseKey(it.article || it.sku);
      if (k && it.extId && products.some(p => p.key === k)) keyBySku.set(String(it.extId), k);
    }
    const skus = [...keyBySku.keys()];
    if (!skus.length) throw new Error('нет SKU Ozon закупочных товаров');
    const from = mskDate(31), to = mskDate(4), month = to.slice(0, 7);
    let rows = 0, reqs = 0;
    for (let i = 0; i < skus.length; i += 5) {
      if (reqs > 0) await sleep(30_000);
      await avoidBaloo();
      const r = await fetchWithRetry('https://api-seller.ozon.ru/v1/analytics/product-queries/details', {
        method: 'POST',
        headers: { 'Client-Id': process.env.OZON_CLIENT_ID ?? '', 'Api-Key': process.env.OZON_API_KEY ?? '', 'Content-Type': 'application/json' },
        body: JSON.stringify({ date_from: `${from}T00:00:00Z`, date_to: `${to}T23:59:59Z`, limit_by_sku: 15, page: 0, page_size: 75, skus: skus.slice(i, i + 5), sort_by: 'BY_SEARCHES', sort_dir: 'DESCENDING' }),
      }, { maxRetries: 3, priority: 2, timeoutMs: 60_000 });
      reqs++;
      if (!r.ok) throw new Error(`Ozon ${r.status}: ${(await r.text()).slice(0, 150)}`);
      const list = ((await r.json()) as any)?.queries ?? [];
      const best = new Map<string, number>();
      for (const q of list) {
        const k = keyBySku.get(String(q.sku)); const f = Number(q.unique_search_users ?? 0);
        if (!k || !q.query || !(f > 0)) continue;
        const id = `${k}\u0001${String(q.query).toLowerCase().trim()}`;
        best.set(id, Math.max(best.get(id) ?? 0, f));
      }
      for (const [id, f] of best) { const [k, q] = id.split('\u0001'); upsert('ozon', k, q, month, f); rows++; }
    }
    const msg = `Ozon: окно ${from}…${to}, запросов к Ozon ${reqs}, строк ${rows}`;
    logRun('ozon', true, msg);
    return msg;
  } catch (e) {
    logRun('ozon', false, (e as Error).message);
    throw e;
  } finally { ozRunning = false; }
}

// ─── Агент на ПК: кабинет Ozon «Поисковые запросы» и Вордстат ───────────────────
/**
 * 21.11.2026, задача владельца: сезонность по главным запросам наших товаров в наших категориях —
 * одни и те же запросы на WB, Ozon и в Вордстате, чтобы источники можно было сравнивать.
 *
 *   • Ozon: кабинет → Аналитика → «Поисковые запросы», период — календарный месяц (кабинет хранит 12 месяцев),
 *     фильтр по запросу, «Популярность запроса». Только чтение. Месяц закончился — цифра больше не меняется,
 *     поэтому собираем лишь те месяцы, которых ещё нет.
 *   • Вордстат: wordstat.yandex.ru, «Динамика» по месяцам за 2 года, берём ДОЛЮ от всех запросов Яндекса
 *     (число запросов летом 2026 выросло у всех запросов разом — это рост Яндекса, а не спрос; доля это гасит).
 *     Каждый цикл — заново (одна страница на запрос).
 * Цикл — 1-го и 16-го числа в 09:25 МСК (ячейка диспетчера API). Агент работает кусками до ~35 минут, чтобы
 * между ними шли его обычные задания (отзывы Ozon в :20 каждого часа); сервер сам ставит следующий кусок,
 * пока план цикла не выполнен.
 */
export type SeasonPlanItem = { category: string; query: string };
export type SeasonAgentParams = {
  marketplace: 'ozon';
  cycle: string;
  /** Ozon: месяц ('YYYY-MM') → запросы, которых за этот месяц ещё нет. */
  ozon: { month: string; items: SeasonPlanItem[] }[];
  /** Вордстат: запросы, не собранные в этом цикле. */
  wordstat: SeasonPlanItem[];
  budget_min: number;
};

const catKey = (c: string) => `cat:${c}`;
/** Начало текущего цикла: последнее 1-е или 16-е число (МСК). */
export function cycleStart(today = mskDate(0)): string {
  const d = Number(today.slice(8, 10));
  return `${today.slice(0, 8)}${d >= 16 ? '16' : '01'}`;
}
/** Месяцы, которые хранит кабинет Ozon: 12 полных месяцев до текущего. */
export function ozonMonths(today = mskDate(0)): string[] {
  const cur = today.slice(0, 7);
  return Array.from({ length: 12 }, (_, i) => shiftMonth(cur, -12 + i));
}

/** Категории закупочных товаров (без архива): категория → товары. */
async function categoryMap(given?: SeasonProduct[]): Promise<Map<string, { key: string; name: string }[]>> {
  const products = (await purchaseProducts(given)).filter(p => !p.skip);
  const cats = { wb: rnpCategories('wb'), ozon: rnpCategories('ozon') };
  const out = new Map<string, { key: string; name: string }[]>();
  for (const p of products) {
    let c = '';
    for (const a of [p.key, ...p.articles]) { c = cats.wb.get(a.toUpperCase()) || cats.ozon.get(a.toUpperCase()) || ''; if (c) break; }
    c = c || CATEGORY_FIX[p.key] || 'Без категории';
    out.set(c, [...(out.get(c) ?? []), { key: p.key, name: p.name }]);
  }
  return out;
}
/** Товары, у которых в справочнике карточек нет предмета (ответ проверен по названию). */
const CATEGORY_FIX: Record<string, string> = { CARBITLINK: 'FM-трансмиттеры', 'CARBITLINK-AUTOABC': 'FM-трансмиттеры' };

const BRAND = ['allpowers', 'aferiy', 'ecoflow', 'carlinkit', 'ottocast', 'carbitlink', 'dudu', 'duduauto', 'jsk', 'dji', 'avto vibe', 'автовайб', 'ugreen', 'экофлоу', 'карлинкит', 'оттокаст'];
/** Слишком общие запросы — в них смешаны чужие товары («аккумулятор» у станций). */
const TOO_GENERIC = new Set(['аккумулятор', 'аксессуары для машины', 'аксессуары для авто', 'подарок', 'подарок мужчине', 'для авто', 'товары для дома']);
const normQ = (q: string) => q.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
const sameWords = (q: string) => normQ(q).split(' ').sort().join(' ');

/**
 * Главные запросы категорий, подобранные вручную 21.11.2026 по частотам WB за год (у молодых товаров —
 * станции, доски — своих месяцев на WB мало, а автоподбор тянул общие «бокс», «переходник», «для машины»).
 * Запросы — как ищет покупатель, без брендов: одни и те же для WB, Ozon и Вордстата.
 * Категории без записи здесь подбираются автоматически (ниже).
 */
const CURATED: Record<string, string[]> = {
  'Портативные электростанции': ['портативная электростанция', 'электростанция для дома', 'зарядная станция', 'солнечная панель'],
  'Магнитолы автомобильные': ['андроид приставка для авто', 'android box для автомобиля', 'магнитола андроид', 'автомагнитола андроид'],
  'FM-трансмиттеры': ['carplay', 'carplay беспроводной для авто', 'карплей для авто', 'блютуз адаптер для авто'],
  'Световые планшеты для рисования': ['светящаяся доска для рисования', 'световой планшет для рисования', 'планшет для рисования детский', 'доска для рисования'],
  'Косметические аппараты': ['ультразвуковая чистка лица', 'аппарат для чистки лица', 'led маска для лица', 'микротоки'],
  'Аппараты для маникюра и педикюра': ['аппарат для маникюра', 'аппарат для маникюра и педикюра', 'машинка для маникюра', 'фрезер для маникюра'],
  'Передатчики видеосигнала': ['беспроводной hdmi', 'hdmi беспроводной', 'беспроводной hdmi передатчик', 'hdmi удлинитель беспроводной'],
};

/**
 * Главные запросы категории (до 4): по частоте на WB за год у наших карточек категории, без брендов, без
 * слишком общих слов, без перестановок слов одного запроса; запрос должен быть хотя бы в 3 месяцах.
 */
export async function seasonPlan(given?: SeasonProduct[]): Promise<{ category: string; products: { key: string; name: string }[]; queries: string[] }[]> {
  const d = seasonDb();
  const out = [];
  for (const [category, products] of await categoryMap(given)) {
    if (CURATED[category]) { out.push({ category, products, queries: CURATED[category] }); continue; }
    const score = new Map<string, { f: number; months: Set<string> }>();
    for (const p of products) {
      for (const r of d.prepare("SELECT query, month, freq FROM sq_freq WHERE source = 'wb' AND key = ?").all(p.key) as any[]) {
        const s = score.get(r.query) ?? { f: 0, months: new Set<string>() };
        s.months.add(r.month); s.f = Math.max(s.f, Number(r.freq)); score.set(r.query, s);
      }
    }
    const brand = [...BRAND, ...products.flatMap(p => p.key.toLowerCase().split(/[^a-zа-я0-9]+/).filter(w => w.length >= 4))];
    const rows = [...score].filter(([q, s]) => s.months.size >= 3 && !TOO_GENERIC.has(normQ(q))).map(([query, s]) => ({ query, freq: s.f }));
    const seen = new Set<string>();
    const queries = mainQueries(rows, brand, 12).filter(q => { const k = sameWords(q); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 4);
    out.push({ category, products, queries });
  }
  return out;
}

/** Что агенту осталось собрать в текущем цикле. null — всё собрано. */
export async function seasonAgentParams(): Promise<SeasonAgentParams | null> {
  const d = seasonDb();
  const cycle = cycleStart();
  const plan = await seasonPlan();
  const have = d.prepare("SELECT 1 FROM sq_freq WHERE source = ? AND key = ? AND query = ? AND month = ?");
  const ozon: SeasonAgentParams['ozon'] = [];
  for (const month of ozonMonths()) {
    const items: SeasonPlanItem[] = [];
    for (const c of plan) for (const q of c.queries) if (!have.get('ozon', catKey(c.category), q, month)) items.push({ category: c.category, query: q });
    if (items.length) ozon.push({ month, items });
  }
  const fresh = d.prepare("SELECT 1 FROM sq_freq WHERE source = 'wordstat' AND key = ? AND query = ? AND at >= ? LIMIT 1");
  const wordstat: SeasonPlanItem[] = [];
  for (const c of plan) for (const q of c.queries) if (!fresh.get(catKey(c.category), q, `${cycle}T00:00:00`)) wordstat.push({ category: c.category, query: q });
  if (!ozon.length && !wordstat.length) return null;
  return { marketplace: 'ozon', cycle, ozon, wordstat, budget_min: 35 };
}

/** Приём строк от агента. Ozon: value — «Популярность запроса» за месяц (0 — запроса в месяце нет). Вордстат: доля, %. */
export function saveAgentRows(rows: { source: string; category: string; query: string; month: string; value: number }[]): { saved: number; skipped: number } {
  let saved = 0, skipped = 0;
  for (const r of rows ?? []) {
    const src = r?.source === 'ozon' ? 'ozon' : r?.source === 'wordstat' ? 'wordstat' : null;
    const v = Number(r?.value);
    if (!src || !r.category || !r.query || !/^\d{4}-\d{2}$/.test(String(r.month)) || !Number.isFinite(v) || v < 0) { skipped++; continue; }
    upsert(src, catKey(String(r.category)), normQ(String(r.query)), String(r.month), v);
    saved++;
  }
  return { saved, skipped };
}

/** Агент закончил кусок: записать итог и, если план цикла не выполнен, поставить следующий кусок. */
export async function agentChunkDone(summary: string, ok: boolean): Promise<void> {
  logRun('agent', ok, summary.slice(0, 300));
  if (!ok) return;   // сбой — следующий кусок поставит дневная проверка, без долбёжки
  const left = await seasonAgentParams();
  if (left) await queueAgent('продолжение цикла', 2 * 60_000);
}

/** Поставить задание агенту, если такого ещё нет в очереди или в работе. */
export async function queueAgent(why: string, delayMs = 0): Promise<string> {
  const q = await import('./agentQueue');
  const busy = q.listTasks({ limit: 50 }).some((t: any) => t.type === 'season_collect' && ['queued', 'claimed', 'running'].includes(t.status));
  if (busy) return 'задание уже стоит в очереди';
  const left = await seasonAgentParams();
  if (!left) return 'всё собрано в этом цикле';
  // План — сразу в задание: при выдаче агенту сервер его уже не пересчитывает (агент ждёт ответа не дольше 45 с).
  q.createTask('season_collect', left, 'schedule', { scheduledFor: Date.now() + delayMs, priority: 0 });
  const n = left.ozon.reduce((a, m) => a + m.items.length, 0);
  logRun('agent', true, `поставлено задание (${why}): Ozon ${n} пар «месяц × запрос», Вордстат ${left.wordstat.length} запросов`);
  return 'задание поставлено';
}

// ─── Расписание ───────────────────────────────────────────────────────────────
/** WB пора: 1-е или 16-е число по Москве, либо последний сбор не удался / был больше 16 дней назад. */
function due(source: string): boolean {
  const day = Number(mskDate(0).slice(8, 10));
  const last = seasonDb().prepare('SELECT at, ok, detail FROM sq_run WHERE source = ? ORDER BY id DESC LIMIT 1').get(source) as any;
  if (!last) return true;
  if (/подписка «Джем»/.test(String(last.detail ?? ''))) return day === 1 || day === 16;
  if (!last.ok) return true;
  const age = Date.now() - Date.parse(last.at);
  return day === 1 || day === 16 ? age > 20 * 3_600_000 : age > 16 * 86_400_000;
}

/**
 * WB — ночью 00:40 МСК (API). Агент на ПК (Ozon-кабинет + Вордстат) — 09:25 МСК: 1-го и 16-го — новый цикл;
 * в остальные дни — только если прошлый цикл не доделан (сбой, ПК был выключен).
 */
export function scheduleSeason(): void {
  everyAligned(SLOTS.seasonWb, () => {
    try {
      if (!due('wb') && !wbMissingMonths().length) return;
      const prev = shiftMonth(mskDate(0).slice(0, 7), -1);
      const months = [...new Set([...wbMissingMonths(), prev])].sort();
      void collectWb(months).catch(e => console.warn('[season] WB:', (e as Error).message));
    } catch (e) { console.warn('[season] WB: проверка расписания упала:', (e as Error).message); }
  });
  everyAligned(SLOTS.seasonAgent, () => {
    const day = Number(mskDate(0).slice(8, 10));
    void queueAgent(day === 1 || day === 16 ? `цикл ${mskDate(0)}` : 'доделать прошлый цикл')
      .catch(e => console.warn('[season] задание агенту не поставлено:', (e as Error).message));
  });
  console.warn('[season] сезонность «Закупок»: WB 00:40 МСК; агент (Ozon-кабинет, Вордстат) 09:25 МСК, 1-го и 16-го и доделка');
}

// ─── Лист «Сезонность» ───────────────────────────────────────────────────────
export async function getSeason(given?: SeasonProduct[]): Promise<SeasonResponse> {
  const d = seasonDb();
  const plan = await seasonPlan(given);
  const series = (source: SeasonSource, keys: string[], query: string): QuerySeries => {
    const months: Record<string, number> = {};
    for (const k of keys) {
      for (const r of d.prepare('SELECT month, freq FROM sq_freq WHERE source = ? AND key = ? AND query = ?').all(source, k, query) as any[]) {
        months[r.month] = Math.max(months[r.month] ?? 0, Number(r.freq));
      }
    }
    return { query, months };
  };
  const keysOf = (source: SeasonSource, c: typeof plan[number]) => (source === 'wb' ? c.products.map(p => p.key) : [catKey(c.category)]);
  const categories: SeasonCategory[] = plan.map(c => {
    const sources: SeasonCategory['sources'] = {};
    const perQuery: SeasonCategory['queries'] = c.queries.map(q => ({ query: q }));
    for (const source of ['wb', 'ozon', 'wordstat'] as SeasonSource[]) {
      let ss = c.queries.map(q => series(source, keysOf(source, c), q));
      const skip = SKIP_MONTHS[source] ?? [];
      let idx = seasonIndex(ss, skip);
      // WB: у наших карточек нет главных запросов категории в отчёте — берём их самые частые запросы за год.
      if (source === 'wb' && !idx.queries) {
        const keys = keysOf('wb', c);
        const rows = d.prepare(`SELECT query, count(DISTINCT month) m, max(freq) f FROM sq_freq WHERE source = 'wb' AND key IN (${keys.map(() => '?').join(',')}) GROUP BY query HAVING m >= 3`).all(...keys) as any[];
        const brand = [...BRAND, ...keys.flatMap(k => k.toLowerCase().split(/[^a-zа-я0-9]+/).filter(w => w.length >= 4))];
        const top = mainQueries(rows.filter(r => !TOO_GENERIC.has(normQ(r.query))).map(r => ({ query: String(r.query), freq: Number(r.f) })), brand, 3);
        ss = top.map(q => series('wb', keys, q));
        idx = seasonIndex(ss, skip);
      }
      if (idx.queries) sources[source] = { ...idx, drop: winterDrop(idx.k), top: ss.filter(s => Object.values(s.months).some(v => v > 0)).map(s => s.query) };
      ss.forEach((s, i) => { const one = seasonIndex([s], skip); if (one.queries) perQuery[i][source] = one.k; });
    }
    return { category: c.category, products: c.products, sources, queries: perQuery };
  }).sort((a, b) => b.products.length - a.products.length || a.category.localeCompare(b.category));
  const runs = (d.prepare('SELECT source, at, ok, detail FROM sq_run ORDER BY id DESC LIMIT 12').all() as any[]).map(r => ({ source: String(r.source), at: String(r.at), ok: !!r.ok, detail: String(r.detail) }));
  const coverage = {} as SeasonResponse['coverage'];
  for (const s of ['wb', 'ozon', 'wordstat'] as SeasonSource[]) {
    const r = d.prepare(`SELECT count(DISTINCT month) n, min(month) a, max(month) b FROM sq_freq WHERE source = ? AND freq > 0 ${s === 'wb' ? '' : "AND key LIKE 'cat:%'"}`).get(s) as any;
    coverage[s] = { months: Number(r?.n ?? 0), from: String(r?.a ?? ''), to: String(r?.b ?? '') };
  }
  const left = given ? null : await seasonAgentParams().catch(() => null);
  const pending = left ? { ozon: left.ozon.reduce((a, m) => a + m.items.length, 0), wordstat: left.wordstat.length } : { ozon: 0, wordstat: 0 };
  return { ok: true, builtAt: nowIso(), categories, runs, notes: [], coverage, pending };
}

/** Сезонность категории для расчёта закупки. */
export type PurchaseSeasonCat = { category: string; wb: number[]; ozon: number[]; trendFrom: string; confirmed: number; products: string[] };

/**
 * Сезонность для «Что заказать» (22.11): по каждой категории — коэффициенты месяцев для WB и для Ozon,
 * только подтверждённые двумя годами Вордстата (shared/season.ts → calcSeason). Категория без Вордстата за
 * два года в список не попадает — её товары считаются запасным способом.
 */
export async function purchaseSeason(today: string, products: SeasonProduct[]): Promise<PurchaseSeasonCat[]> {
  const d = seasonDb();
  const sea = await getSeason(products);
  const lastMonth = addMonths(today.slice(0, 7), -1);
  const out: PurchaseSeasonCat[] = [];
  for (const c of sea.categories) {
    const ws = c.queries.map(q => {
      const months: Record<string, number> = {};
      for (const r of d.prepare("SELECT month, freq FROM sq_freq WHERE source = 'wordstat' AND key = ? AND query = ?").all(catKey(c.category), q.query) as any[]) months[r.month] = Number(r.freq);
      return { query: q.query, months };
    });
    const wb = calcSeason(ws, c.sources.wb?.k ?? null, lastMonth);
    if (!wb) continue;
    const oz = calcSeason(ws, c.sources.ozon?.k ?? null, lastMonth) ?? wb;
    out.push({ category: c.category, wb: wb.k, ozon: oz.k, trendFrom: wb.trendFrom, confirmed: Math.max(wb.confirmed, oz.confirmed), products: c.products.map(p => p.key) });
  }
  return out;
}
