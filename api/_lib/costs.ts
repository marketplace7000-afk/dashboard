/**
 * СПРАВОЧНИК СЕБЕСТОИМОСТИ — первый шаг ухода от Google-таблицы.
 *
 * Себестоимости нет ни в одном API маркетплейса: это данные бизнеса — сколько
 * продавец заплатил поставщику. Сейчас она живёт в чужой Google-таблице (лист
 * «Склад», колонка H), которая к тому же периодически недоступна: 11.08 в
 * консоли клиента «Лист не найден: Склад», то есть ROI считался без неё.
 *
 * Здесь она хранится у нас: файл на диске сервера, переживает перезапуск и
 * деплой. Таблица остаётся запасным источником, пока клиент не перенесёт всё.
 *
 * Почему файл, а не БД: платформа пока однопользовательская, а вводить Postgres
 * ради одной таблицы — лишний шаг. Формат хранения намеренно простой, чтобы при
 * переезде на мультиарендность перелить его в БД одним скриптом.
 */
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type CostEntry = {
  /** Себестоимость единицы, ₽. */
  cost: number;
  /** Откуда взялось: руками, импортом файла или из таблицы «Склад» клиента. */
  source: 'manual' | 'import' | 'sheet';
  /** Когда обновляли (ISO). */
  updatedAt: string;
  /** Свободная пометка: партия, поставщик, курс — что угодно. */
  note?: string;
};

export type CostsFile = {
  items: Record<string, CostEntry>;
  /** Когда менялась хотя бы одна цифра. */
  updatedAt: string;
  /** Когда последний раз УСПЕШНО сверялись с таблицей «Склад» (даже если ничего не поменялось). */
  syncedAt?: string;
};

// ВАЖНО: отдельно от кэша. Кэш можно чистить и терять без последствий, а это
// введённые руками данные — их потеря означает переносить себестоимость заново.
// Каталог av-data исключён из деплоя (rsync), чтобы выкатка не затирала серверные
// цифры локальными.
const FILE = process.env.COSTS_FILE || join(process.cwd(), 'av-data', 'costs.json');

/** Артикулы сравниваем без учёта регистра и пробелов по краям. */
export const normSku = (s: unknown): string => String(s ?? '').trim().toUpperCase();

let memory: CostsFile | null = null;

function load(): CostsFile {
  if (memory) return memory;
  try {
    if (existsSync(FILE)) {
      const raw = JSON.parse(readFileSync(FILE, 'utf8'));
      if (raw && typeof raw === 'object' && raw.items) {
        memory = { items: raw.items, updatedAt: raw.updatedAt ?? '', syncedAt: raw.syncedAt };
        return memory;
      }
    }
  } catch (e) {
    console.warn('[costs] не прочитал файл:', (e as Error).message);
  }
  memory = { items: {}, updatedAt: '' };
  return memory;
}

function save(data: CostsFile): void {
  memory = data;
  try {
    mkdirSync(dirname(FILE), { recursive: true });
    // Пишем через временный файл: обрыв записи не должен оставить битый JSON,
    // иначе себестоимость всего каталога теряется разом.
    const tmp = `${FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    renameSync(tmp, FILE);
  } catch (e) {
    console.warn('[costs] не записал файл:', (e as Error).message);
  }
}

export function getCosts(): CostsFile {
  return load();
}

/**
 * СОПОСТАВЛЕНИЕ АРТИКУЛА КАРТОЧКИ С АРТИКУЛОМ ТАБЛИЦЫ «Склад» (01.10.2026).
 *
 * Жалоба клиента: на листе цен у многих товаров пусто в «Себестоимости», хотя в
 * таблице цифра есть. Причина — артикулы карточек и таблицы пишутся по-разному:
 *   • одежда в таблице ведётся по размерам (W-ПАЛАЦБЛЕСК-ЧЕРН-S/-M/-L), а карточка
 *     WB/Ozon — родительская (W-ПАЛАЦБЛЕСК-ЧЕРН);
 *   • в таблице к артикулу дописан номер партии (POL-3M-1Л-СИН-ФИНИШ-5996);
 *   • FBS-дубли карточек Ozon: «CP-CARLINKIT-MINI - FBS», «DJI-MINI-4-PRO- FBS»,
 *     «CARBITLINK-FBS3» — это тот же товар, что и без хвоста.
 * Порядок: точное совпадение → то же без пробелов и FBS-хвоста → единственный
 * «вариант» (артикул таблицы = наш + размер или номер партии через дефис). Если вариантов
 * несколько и цены у них расходятся больше чем на 15% — не угадываем, честно
 * оставляем пусто (лучше «нет себестоимости», чем чужая цифра в марже).
 */
export type ResolvedCost = { cost: number; entry: CostEntry; key: string; via: 'exact' | 'normalized' | 'variant' };

const squash = (s: string) => s.replace(/\s+/g, '');
/** Хвост-вариант: буквенный размер (S…5XL), числовой размер (48 или «42-44») или номер партии. */
const VARIANT_TAIL = /^(?:X{0,3}S|M|X{0,3}L|\d?XL|\d{2,6}|\d{2}-\d{2})$/;
const stripFbs = (s: string) => s.replace(/-?FBS\d*$/, '').replace(/-+$/, '');

export function resolveCost(sku: string, data: CostsFile = load()): ResolvedCost | null {
  const items = data.items;
  const k = normSku(sku);
  if (!k) return null;
  const hit = (key: string, via: ResolvedCost['via']): ResolvedCost | null => {
    const e = items[key];
    return e && e.cost > 0 ? { cost: e.cost, entry: e, key, via } : null;
  };
  const exact = hit(k, 'exact');
  if (exact) return exact;

  // Индекс «артикул без пробелов» → ключ справочника (в таблице тоже бывают пробелы).
  const squashed = new Map<string, string>();
  for (const key of Object.keys(items)) squashed.set(squash(key), key);
  const base = stripFbs(squash(k));
  for (const cand of [squash(k), base]) {
    const key = squashed.get(cand);
    if (key) { const r = hit(key, 'normalized'); if (r) return r; }
  }

  // Варианты: ключ таблицы = base + «-» + один сегмент (размер, номер партии).
  const prefix = base + '-';
  const variants: { key: string; e: CostEntry }[] = [];
  for (const [sq, key] of squashed) {
    if (!sq.startsWith(prefix)) continue;
    const tail = sq.slice(prefix.length);
    // Только размер или номер партии: «-PRO», «-DUBL», цвет — это ДРУГОЙ товар.
    if (!VARIANT_TAIL.test(tail)) continue;
    const e = items[key];
    if (e && e.cost > 0) variants.push({ key, e });
  }
  if (!variants.length) return null;
  const costs = variants.map(v => v.e.cost);
  const min = Math.min(...costs), max = Math.max(...costs);
  if (max > min * 1.15) return null;
  // Берём наибольшую: маржа скорее занижена, чем завышена.
  const top = variants.find(v => v.e.cost === max)!;
  return { cost: max, entry: top.e, key: top.key, via: 'variant' };
}

/** Себестоимость одного артикула или null, если её не задавали. */
export function getCost(sku: string): number | null {
  return resolveCost(sku)?.cost ?? null;
}

/**
 * Записать/обновить себестоимости пачкой.
 * Значение ≤ 0 или пустое УДАЛЯЕТ запись — так можно снять ошибочную цифру,
 * а не оставлять ноль, который потом посчитается как настоящая себестоимость.
 */
export function setCosts(
  input: Record<string, number | string | null | undefined>,
  source: CostEntry['source'] = 'manual',
  notes?: Record<string, string>,
): { saved: number; removed: number; total: number } {
  const data = load();
  const now = new Date().toISOString();
  let saved = 0, removed = 0;

  for (const [rawSku, rawVal] of Object.entries(input)) {
    const sku = normSku(rawSku);
    if (!sku) continue;
    const num = typeof rawVal === 'number'
      ? rawVal
      : parseFloat(String(rawVal ?? '').replace(/\s/g, '').replace(',', '.'));
    if (!Number.isFinite(num) || num <= 0) {
      if (data.items[sku]) { delete data.items[sku]; removed++; }
      continue;
    }
    data.items[sku] = {
      cost: Math.round(num * 100) / 100,
      source,
      updatedAt: now,
      ...(notes?.[sku] ? { note: notes[sku] } : {}),
    };
    saved++;
  }

  data.updatedAt = now;
  save(data);
  return { saved, removed, total: Object.keys(data.items).length };
}

/**
 * Разбор CSV: «артикул;себестоимость[;пометка]».
 * Принимаем и запятую, и точку с запятой, и таб — люди выгружают из чего угодно.
 * Первая строка пропускается, если во второй колонке не число (это заголовок).
 */
export function parseCostsCsv(text: string): { items: Record<string, number>; notes: Record<string, string>; skipped: string[] } {
  const items: Record<string, number> = {};
  const notes: Record<string, string> = {};
  const skipped: string[] = [];

  const lines = String(text ?? '').split(/\r?\n/).filter(l => l.trim());
  lines.forEach((line, i) => {
    const cells = line.split(/[;\t,](?=(?:[^"]*"[^"]*")*[^"]*$)/).map(c => c.trim().replace(/^"|"$/g, ''));
    const sku = normSku(cells[0]);
    const num = parseFloat(String(cells[1] ?? '').replace(/\s/g, '').replace(',', '.'));
    if (!sku || !Number.isFinite(num) || num <= 0) {
      // Первая строка без числа — это заголовок, о нём не сообщаем.
      if (i > 0) skipped.push(line.slice(0, 60));
      return;
    }
    items[sku] = num;
    if (cells[2]) notes[sku] = cells[2].slice(0, 200);
  });

  return { items, notes, skipped };
}

/**
 * Покрытие: по скольким из переданных артикулов себестоимость известна.
 * Нужно, чтобы честно показать «у N товаров себестоимости нет, ROI по ним не
 * считается» вместо молчаливой подстановки оценки.
 */
/**
 * Синхронизация с основной таблицей клиента (лист «Склад», колонка I).
 *
 * Клиент 11.08: «себестоимость в любом случае придётся брать с нашей таблицы,
 * она работает как система учёта». Поэтому таблица — источник истины, а наше
 * хранилище становится её КЭШЕМ: цифры переживают недоступность листа (а он уже
 * пропадал — «Лист не найден: Склад») и не обнуляют ROI на ровном месте.
 *
 * Ручные записи не затираем: они остаются для артикулов, которых в таблице нет.
 * Если артикул есть в таблице — она главнее, иначе учёт разъедется.
 */
export async function syncFromSklad(): Promise<{
  updated: number; kept: number; total: number; error?: string; syncedAt?: string;
}> {
  const { fetchSkladCosts } = await import('./sheets');
  const { items, error } = await fetchSkladCosts();
  if (error || !items.length) {
    // Ноль строк при прочитанном листе — это НЕ «нечего обновлять», а поломка
    // разбора: так 04.09 месяц жили на старой себестоимости после сдвига
    // колонок. Говорим об этом явно и наверх, и в журнал.
    const why = error ?? 'лист «Склад» прочитан, но ни одной строки с артикулом и закупом не найдено — проверьте заголовки колонок';
    console.warn('[costs] синхронизация из «Склада» не дала данных:', why);
    const data = load();
    return { updated: 0, kept: Object.keys(data.items).length, total: Object.keys(data.items).length, error: why };
  }

  const data = load();
  const now = new Date().toISOString();
  let updated = 0;
  for (const { sku, cost } of items) {
    const key = normSku(sku);
    const prev = data.items[key];
    const rounded = Math.round(cost * 100) / 100;
    // Цифра не изменилась — запись не трогаем (дата обновления остаётся честной).
    if (prev && prev.cost === rounded) {
      if (prev.source !== 'sheet') { data.items[key] = { ...prev, source: 'sheet' }; }
      continue;
    }
    data.items[key] = { cost: rounded, source: 'sheet', updatedAt: now };
    updated++;
  }
  if (updated) data.updatedAt = now;
  data.syncedAt = now;
  save(data);

  // Артикулы справочника, которых в этот раз в таблице НЕ оказалось, остаются со
  // старым значением. Это законно (товар мог уйти из таблицы), но если таких
  // много — почти наверняка снова сдвинулись колонки или переименовали лист.
  // Раньше такое проходило без единой строки в журнале (04.09).
  const seen = new Set(items.map(i => normSku(i.sku)));
  const missing = Object.entries(data.items).filter(([k, v]) => v.source === 'sheet' && !seen.has(k)).length;
  if (missing) {
    console.warn(`[costs] в таблице «Склад» не найдено ${missing} артикулов из справочника — они остались на прежней себестоимости`);
  }

  const total = Object.keys(data.items).length;
  return { updated, kept: total - updated, total, syncedAt: now };
}

export function coverage(skus: string[]): { known: string[]; missing: string[] } {
  const data = load();
  const known: string[] = [], missing: string[] = [];
  for (const s of skus) {
    const k = normSku(s);
    if (!k) continue;
    (resolveCost(k, data) ? known : missing).push(k);
  }
  return { known, missing };
}

/**
 * Фоновая сверка с таблицей «Склад» — отдельным таймером, не в общей цепочке
 * прогрева (01.10.2026). Раньше сверка стояла первой в цепочке warm-extras, а та
 * могла не завершаться (ждёт рекламу WB, конкурентов и т.д.) — и себестоимость
 * жила на значениях от 25.09: за неделю в таблице поменялось 57 цифр.
 * Чтение — два лёгких запроса к Sheets API, раз в 5 минут это копейки.
 */
let syncInFlight: Promise<unknown> | null = null;
export function syncFromSkladThrottled(maxAgeMs = 0): Promise<unknown> {
  const last = Date.parse(load().syncedAt ?? '') || 0;
  if (maxAgeMs > 0 && Date.now() - last < maxAgeMs) return Promise.resolve(null);
  if (!syncInFlight) {
    syncInFlight = syncFromSklad()
      .then(r => { if (r.error || r.updated) console.warn(`[costs] сверка с «Складом»: ${r.error ? `ошибка — ${r.error}` : `изменилось ${r.updated}, всего ${r.total}`}`); return r; })
      .catch(e => console.warn('[costs] сверка с «Складом» упала:', (e as Error).message))
      .finally(() => { syncInFlight = null; });
  }
  return syncInFlight;
}

export function scheduleCostsSync(intervalMs = 5 * 60_000): void {
  setTimeout(() => { void syncFromSkladThrottled(); }, 30_000).unref?.();
  setInterval(() => { void syncFromSkladThrottled(); }, intervalMs).unref?.();
}
