// Серверный кэш для прокси. На Vercel — Vercel KV (Upstash Redis) если переменные
// KV_REST_API_URL/KV_REST_API_TOKEN заданы. Локально/на self-host VM — in-memory Map
// + персистентный дамп на диск (переживает рестарт процесса; на read-only FS
// Vercel запись молча игнорируется — там работает только KV/in-memory).

import { readFileSync, mkdirSync } from 'node:fs';
import { writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { mskDayNumber, mskDayNumberOf } from './mskDate';
import { noteSwallowed } from './log';

// Записи крупнее этого НЕ пишем на диск (держим только в памяти). Финансовые
// отчёты WB с limit=100000 весят ~30 МБ каждый — синхронный дамп 100+ МБ вешал
// event loop и весь сайт «долго грузил». В памяти они остаются (быстрые чтения),
// а после рестарта их за секунды до-греет cron.
const MAX_DISK_ENTRY_BYTES = 4 * 1024 * 1024; // 4 МБ

type CachedEntry<T = any> = { data: T; fetchedAt: number; ttlMs: number };

// ОДИН общий кэш на процесс. Под tsx ESM(server.ts)+CJS(api/) route.ts и _proxy.ts
// получают ДВА инстанса этого модуля: один для route.ts (cron пишет сюда), другой
// для _proxy.ts (браузер читает отсюда). Тогда cron наполняет один memCache, а
// прокси читает из другого пустого → вечный 503 на WB (cron-only), хотя Ozon (SWR)
// работает. ДИАГНОСТИРОВАНО 09.07.2026: globalThis под tsx-песочницей НЕ шарится
// между инстансами (у каждого свой globalThis) — фикс не срабатывал. `process` же
// в Node гарантированно ЕДИНЫЙ объект для всех инстансов/контекстов модуля, поэтому
// вешаем общий стор на него — cron и прокси теперь делят один Map.
const __avCache = ((process as any).__AV_CACHE_STORE__ ??= {
  mem: new Map<string, CachedEntry>(),
  loaded: false,
}) as { mem: Map<string, CachedEntry>; loaded: boolean };
const memCache: Map<string, CachedEntry> = __avCache.mem;

// ─── Персистентность на диск (для self-host VM) ─────────────────────────────
// Кэш WB/Ozon наполняется только кроном (раз в сутки). Если процесс перезапустить,
// in-memory Map обнулится и пользователь увидит «прогрев» до следующего крона.
// Поэтому дампим кэш на диск и поднимаем при старте.
const CACHE_DIR = process.env.CACHE_DIR || join(process.cwd(), '.av-cache');
const CACHE_FILE = join(CACHE_DIR, 'upstream-cache.json');
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function loadFromDisk(): void {
  if (__avCache.loaded) return;
  try {
    const raw = readFileSync(CACHE_FILE, 'utf8');
    const obj = JSON.parse(raw) as Record<string, CachedEntry>;
    for (const [k, v] of Object.entries(obj)) memCache.set(k, v);
    __avCache.loaded = true; // помечаем загруженным ТОЛЬКО при успехе
  } catch (e) {
    // Нет файла / битый — НЕ помечаем loaded: при пустом memCache попробуем снова
    // (см. cacheGet). Так процесс, стартовавший на битом файле, само-восстановится,
    // как только появится валидный, без ручного рестарта.
    // Отсутствие файла при первом старте штатно и в журнал не идёт; всё остальное
    // (нет прав, битый JSON) значит, что кэш не переживёт рестарт, и это надо видеть.
    if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      noteSwallowed('cache', 'дамп с диска не прочитан, старт холодный', e);
    }
  }
}


let diskSaveInFlight = false;
let lastDiskSaveErrorAt = 0;
function scheduleDiskSave(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void persistToDisk();
  }, 5_000);
}

async function persistToDisk(): Promise<void> {
  if (diskSaveInFlight) { scheduleDiskSave(); return; } // не наслаиваем записи
  diskSaveInFlight = true;
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    const obj: Record<string, CachedEntry> = {};
    for (const [k, v] of memCache.entries()) {
      // Пропускаем гигантские записи (финотчёты) — иначе дамп раздувается до 100+ МБ
      // и блокирует сервер. Прикидываем размер по длине data-поля дёшево.
      const approx = typeof v.data === 'string' ? v.data.length
        : (v.data && typeof v.data === 'object' && typeof (v.data as any).text === 'string' ? (v.data as any).text.length : 0);
      if (approx > MAX_DISK_ENTRY_BYTES) continue;
      obj[k] = v;
    }
    // Атомарно и АСИНХРОННО (fs/promises): не блокируем event loop. rename атомарен —
    // если процесс убьют на середине, основной файл не побьётся.
    const tmp = `${CACHE_FILE}.tmp`;
    await writeFile(tmp, JSON.stringify(obj), 'utf8');
    await rename(tmp, CACHE_FILE);
  } catch (e) {
    // РАНЬШЕ здесь было молчаливое проглатывание «read-only FS (Vercel)».
    // Из-за него дамп кэша перестал писаться 31.07 и никто не заметил: после
    // каждого перезапуска платформа стартовала холодной и часами показывала
    // пустоту, пока крон не догреет. Ошибку теперь видно, но редко — раз в час,
    // чтобы не залить журнал.
    const now = Date.now();
    if (now - lastDiskSaveErrorAt > 60 * 60_000) {
      lastDiskSaveErrorAt = now;
      console.warn('[cache] дамп на диск не удался:', (e as Error)?.message);
    }
  }
  finally { diskSaveInFlight = false; }
}

loadFromDisk();

function hasKv(): boolean {
  return !!(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
}

async function kvGet<T>(key: string): Promise<CachedEntry<T> | null> {
  const url = `${process.env.KV_REST_API_URL}/get/${encodeURIComponent(key)}`;
  try {
    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}` },
    });
    if (!r.ok) return null;
    const j = await r.json() as { result: string | null };
    if (!j.result) return null;
    return JSON.parse(j.result) as CachedEntry<T>;
  } catch { return null; }
}

async function kvSet<T>(key: string, entry: CachedEntry<T>): Promise<void> {
  const url = `${process.env.KV_REST_API_URL}/set/${encodeURIComponent(key)}`;
  const expireSec = Math.ceil(entry.ttlMs / 1000) + 60; // KV-TTL чуть больше, чтобы logic'и решали
  try {
    await fetch(`${url}?EX=${expireSec}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(entry),
    });
  } catch (e) {
    // KV не обязателен: запись останется в памяти и на диске. Но если он отвалился,
    // на Vercel это единственное хранилище, и молчать тут нельзя.
    noteSwallowed('cache', 'запись в KV не удалась', e);
  }
}

export async function cacheGet<T = any>(key: string): Promise<CachedEntry<T> | null> {
  if (memCache.size === 0) loadFromDisk(); // само-восстановление: пустая память → перечитать диск
  if (hasKv()) {
    const v = await kvGet<T>(key);
    if (v) return v;
  }
  return (memCache.get(key) as CachedEntry<T> | undefined) ?? null;
}

export async function cacheSet<T = any>(key: string, data: T, ttlMs: number): Promise<void> {
  const entry: CachedEntry<T> = { data, fetchedAt: Date.now(), ttlMs };
  memCache.set(key, entry);
  scheduleDiskSave();
  if (hasKv()) await kvSet(key, entry);
}

export function isFresh<T>(entry: CachedEntry<T> | null): entry is CachedEntry<T> {
  return !!entry && Date.now() - entry.fetchedAt < entry.ttlMs;
}

/** Возраст записи в мс. Бесконечность, если записи нет. */
export function ageMs<T>(entry: CachedEntry<T> | null): number {
  return entry ? Date.now() - entry.fetchedAt : Infinity;
}

/**
 * Пора ли сборщику обновить запись.
 *
 * Отдельно от isFresh намеренно. TTL отвечает на вопрос «сколько эти данные ещё
 * можно показывать», а сборщику нужен другой — «когда идти за новыми». Пока их
 * путали, воронка WB с TTL 3ч при кроне раз в 2ч обновлялась раз в ЧЕТЫРЕ часа:
 * на втором часу запись ещё свежая → пропуск, на четвёртом → обновление. Выручка
 * за день только растёт, поэтому мы всегда выглядели ниже кабинета.
 */
export function needsRefresh<T>(entry: CachedEntry<T> | null, refreshAfterMs: number): boolean {
  return ageMs(entry) >= refreshAfterMs;
}

export function makeCacheKey(...parts: (string | undefined)[]): string {
  return parts.filter(Boolean).join(':');
}

// ─── Ключ для апстрим-кэша WB/Ozon (нормализованный по датам) ───────────────
// Платформа работает в режиме «cron-only»: данные тянет только фоновый сборщик
// (раз в сутки), браузер читает готовый кэш. Сборщик прогревает фиксированное
// окно (например, месяц), а фронт может попросить день/неделю/месяц с другими
// датами. Чтобы ключи совпадали и фронт всегда попадал в прогретый датасет,
// мы ВЫРЕЗАЕМ конкретные даты из query-string и тела перед построением ключа.
// Любые два запроса к одному эндпоинту, отличающиеся только датами периода,
// дают ОДИН ключ → один датасет (последний, что положил cron).
//
// Поля вроде isAnswered, dimension, metrics, limit (не даты) в ключе остаются,
// поэтому «неотвеченные vs архив» или «по дням vs по SKU» не склеиваются.
function stripDates(s: string | undefined): string {
  if (!s) return '';
  // YYYY-MM-DD и ISO-датавремя (2026-06-05T23:59:59.999Z)
  return s.replace(/\d{4}-\d{2}-\d{2}(?:[t ][\d:.]+z?)?/gi, '~');
}

// Относительное окно периода: смещение от «сегодня» (в днях) + длина окна.
// Не зависит от конкретных календарных дат, поэтому ключ переживает смену суток
// и совпадает между cron (греет «сегодня−N») и браузером (просит «сегодня−N»).
// При этом РАЗЛИЧАЕТ cur/prev (разное смещение) и неделя/месяц (разная длина),
// и топ-7/топ-30, которые показываются одновременно.
//
// «Сегодня» — по МОСКВЕ (см. mskDate.ts). Раньше здесь был UTC-день, а даты окон
// строятся московские: с 00:00 до 03:00 МСК смещение уезжало на единицу, ключ
// сборщика переставал совпадать с ключом браузера и запрос падал в STALE-NEAR.
function windowKey(s: string): string {
  const m = s.match(/\d{4}-\d{2}-\d{2}/g);
  if (!m || !m.length) return '';
  const today = mskDayNumber();
  const days = m.map(mskDayNumberOf).filter(n => Number.isFinite(n)).sort((a, b) => a - b);
  if (!days.length) return '';
  const from = days[0];
  const to = days[days.length - 1];
  return `o${today - to}s${to - from}`;
}

// Для Ozon v1/analytics/data один и тот же эндпоинт отдаёт разные датасеты в
// зависимости от dimension (day/sku) и набора metrics — добавляем их в ключ,
// иначе «по дням» и «топ по SKU» перетрут друг друга в кэше.
function analyticsDisc(rest: string, body?: string): string {
  if (!rest.includes('analytics/data') || !body) return '';
  try {
    const b = JSON.parse(body) as { dimension?: string[]; metrics?: string[] };
    // metrics сортируем — порядок в запросе не должен плодить разные ключи
    // (фронт шлёт ['ordered_units','revenue'], бот ['revenue','ordered_units'] и т.п.).
    const dim = (b.dimension || []).join('.');
    const met = [...(b.metrics || [])].sort().join('.');
    return `${dim}|${met}`;
  } catch { return ''; }
}

// Ключ апстрим-кэша WB/Ozon. Тело запроса в ключ НЕ входит (кроме дат окна и
// dimension/metrics аналитики) — поэтому динамические тела (списки product_id,
// разные limit/offset) не плодят промахов: cron греет один датасет, браузер
// читает его и фильтрует локально.
// Префикс ключа БЕЗ окна периода — идентифицирует «датасет» (эндпоинт + фильтры +
// dimension/metrics), но не конкретное окно дат. По нему отдаём ближайший прогретый
// результат, если точное окно не совпало (браузер просит «день», cron прогрел «неделю»).
export function makeUpstreamCachePrefix(
  namespace: string | undefined,
  method: string,
  rest: string,
  qs?: string,
  body?: string,
): string {
  return makeCacheKey(namespace, method, rest, stripDates(qs), analyticsDisc(rest, body));
}

export function makeUpstreamCacheKey(
  namespace: string | undefined,
  method: string,
  rest: string,
  qs?: string,
  body?: string,
): string {
  const win = windowKey(`${qs || ''}|${body || ''}`);
  // окно — ПОСЛЕДНИМ компонентом, чтобы префикс (без окна) был префиксом полного ключа
  return makeCacheKey(makeUpstreamCachePrefix(namespace, method, rest, qs, body), win);
}

// Самый свежий закэшированный результат с данным префиксом (ЛЮБОЕ окно периода).
// Сканируем in-memory (на self-host VM это основной стор).
//
// ⚠ Осторожно: «любое окно» означает, что запрос за день может получить датасет
// за месяц. Для отдачи в браузер это НЕДОПУСТИМО — там используйте
// cacheGetNearestWindow. Эта функция остаётся для потребителей, которые сами
// режут данные по датам внутри (ads/wbSource, wbBuyerPrices, aiContext).
export function cacheGetNewestByPrefix<T = any>(prefix: string): CachedEntry<T> | null {
  if (memCache.size === 0) loadFromDisk(); // само-восстановление перед поиском по префиксу
  let best: CachedEntry<T> | null = null;
  for (const [k, v] of memCache.entries()) {
    if (k === prefix || k.startsWith(prefix + ':')) {
      if (!best || v.fetchedAt > best.fetchedAt) best = v as CachedEntry<T>;
    }
  }
  return best;
}

/** Разбор суффикса окна `oNNsMM` → смещение и длина. */
function parseWindow(suffix: string): { offset: number; span: number } | null {
  const m = /^o(-?\d+)s(\d+)$/.exec(suffix);
  return m ? { offset: Number(m[1]), span: Number(m[2]) } : null;
}

/** Окно (`oNNsMM`) для пары query-string + тело запроса. */
export function windowKeyFor(qs?: string, body?: string): string {
  return windowKey(`${qs || ''}|${body || ''}`);
}

/**
 * Ближайший прогретый результат ТОЙ ЖЕ ДЛИНЫ окна.
 *
 * Зачем отдельно от cacheGetNewestByPrefix: префикс ключа не содержит окна, и все
 * периоды одного эндпоинта лежат под ним вперемешку. Проверено симуляцией на
 * ключах воронки WB — день/неделя/месяц дают ОДИН префикс:
 *   wb:analytics:POST:api/analytics/v3/sales-funnel/products : o0s1 | o0s7 | o0s30
 * Поэтому «ближайший» по одному префиксу мог отдать месячную выручку под подписью
 * «сегодня» — это и есть жалоба клиента «цифры не сходятся между разделами»
 * (телемост 11.08). Длину окна (`sMM`) требуем совпадающей, а расходиться
 * разрешаем только смещению (`oNN`) — это законный случай «сборщик грел вчера
 * вечером, браузер спрашивает сегодня утром».
 *
 * Возвращает и само окно, чтобы вызывающий мог честно сказать, за какой период
 * данные, вместо молчаливой подмены.
 */
export function cacheGetNearestWindow<T = any>(
  prefix: string,
  wantWindow: string,
): { entry: CachedEntry<T>; window: string; exact: boolean } | null {
  if (memCache.size === 0) loadFromDisk();
  const want = parseWindow(wantWindow);
  let best: { entry: CachedEntry<T>; window: string; dist: number } | null = null;
  for (const [k, v] of memCache.entries()) {
    if (!k.startsWith(prefix + ':')) continue;
    const suffix = k.slice(prefix.length + 1);
    const got = parseWindow(suffix);
    if (!got) continue;
    // Длина окна обязана совпасть. Без окна в запросе (want === null) отдавать
    // произвольный период тоже нельзя — молча выйдет чужой набор данных.
    if (!want || got.span !== want.span) continue;
    const dist = Math.abs(got.offset - want.offset);
    if (!best || dist < best.dist || (dist === best.dist && v.fetchedAt > best.entry.fetchedAt)) {
      best = { entry: v as CachedEntry<T>, window: suffix, dist };
    }
  }
  if (!best) return null;
  return { entry: best.entry, window: best.window, exact: best.dist === 0 };
}

/** Какие окна этого датасета вообще прогреты — для диагностики в ответе 503. */
export function cacheWarmedWindows(prefix: string): string[] {
  if (memCache.size === 0) loadFromDisk();
  const out: string[] = [];
  for (const k of memCache.keys()) {
    if (!k.startsWith(prefix + ':')) continue;
    const suffix = k.slice(prefix.length + 1);
    if (parseWindow(suffix)) out.push(suffix);
  }
  return out.sort();
}
