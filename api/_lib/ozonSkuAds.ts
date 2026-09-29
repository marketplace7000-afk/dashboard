/**
 * Расход рекламы Ozon В РАЗРЕЗЕ SKU — чтобы считать ДРР по каждому товару из API,
 * а не из ручной колонки в Google-таблице (просьба клиента 29.07).
 *
 * Почему не /statistics/daily/json: он отдаёт расход ПО КАМПАНИЯМ, а нам нужен
 * расход по товару. Разбивку по SKU Ozon отдаёт только асинхронным отчётом:
 *   POST /api/client/statistics            → UUID
 *   GET  /api/client/statistics/{UUID}     → состояние
 *   GET  /api/client/statistics/report?UUID=... → CSV с колонками по SKU
 *
 * Итог кладём в кэш на 6ч. При любом сбое отдаём последний удачный результат,
 * а фронт откатывается на колонку из таблицы — то есть хуже, чем было, не станет.
 */
import { getOzonPerfToken, PERF_HOST } from './ozonPerfAuth';
import { cacheGet, cacheSet, isFresh } from './cache';
import { mskDate } from './mskDate';
import { unzipAll, isZip } from './zip';

// v2: в SkuAdRow добавились показы/клики/корзины. Старые записи их не содержат,
// поэтому меняем ключ — иначе в расчёт попадут undefined вместо чисел.
const CACHE_KEY = 'ozon-sku-ads:v2';
const TTL_MS = 6 * 60 * 60_000;
// Отчёт по десятку кампаний Ozon готовит небыстро, а 2 минут ему не хватало:
// мы бросали недоделанный отчёт, он оставался АКТИВНЫМ на стороне Ozon, и все
// следующие пачки получали 429 «максимум 1». Одна брошенная пачка обнуляла
// рекламу Ozon на весь проход (лог 26.08: девять 429 подряд, ноль отчётов).
// Бюджеты вынесены в env: на проде их иногда надо подкрутить под поведение Ozon,
// а проверкам нужны короткие, иначе прогон длится десять минут.
const envMs = (name: string, def: number) => Number(process.env[name]) || def;
const POLL_BUDGET_MS = envMs('OZON_REPORT_POLL_BUDGET_MS', 8 * 60_000);
const POLL_DELAY_MS = envMs('OZON_REPORT_POLL_DELAY_MS', 5_000);
// Ждать освобождения слота имеет смысл долго: занять его мог и клиент из
// интерфейса Ozon. Терять из-за этого всю пачку кампаний точно не стоит.
const SLOT_BUDGET_MS = envMs('OZON_REPORT_SLOT_BUDGET_MS', 10 * 60_000);
const RETRY_429_MS = envMs('OZON_REPORT_RETRY_MS', 30_000);   // пауза между проверками слота
/** Сколько держим UUID незабранного отчёта, чтобы подобрать его следующим проходом. */
const PENDING_TTL_MS = 2 * 60 * 60_000;
// Потолок на одно окно целиком. Крон ходит раз в 2 часа, и прогрев обязан в него
// укладываться: недобранные пачки подберутся следующим проходом, а вот
// перекрывшиеся проходы душат сервер.
const WINDOW_BUDGET_MS = envMs('OZON_REPORT_WINDOW_BUDGET_MS', 20 * 60_000);
const CAMPAIGNS_PER_REPORT = 10;    // жёсткий лимит Ozon на один отчёт
const MAX_CAMPAIGNS = 100;          // защита от зацикливания; отбор теперь по факту расхода, не по потолку

export type SkuAdRow = {
  spend: number;      // расход на рекламу, ₽
  revenue: number;    // выручка, которую принесла реклама, ₽
  orders: number;
  /** ДРР из отчёта Ozon («ДРР в продвижении, %»). Точнее нашего деления. */
  drr?: number;
  // Полная воронка — нужна сценариям из документа специалиста по рекламе:
  // показы → клики → корзина → заказ. Без неё нельзя отличить «не показывается»
  // от «показывается, но не кликают» и от «кликают, но не покупают».
  views: number;      // показы
  clicks: number;     // клики
  carts: number;      // добавления в корзину
  /**
   * «Заказано на сумму, ₽» из отчёта Ozon — выручка по ВСЕМ заказам SKU за
   * период, не только от рекламы. Это знаменатель ДРР по формуле клиента
   * (14.08), и Ozon его считает сам: колонка «ДРР (общий), %» в том же отчёте
   * — ровно та цифра, которую клиент видит в другом сервисе (31,3% на 28.08).
   * Значение ОДНО на SKU, не на кампанию, поэтому при склейке берём max, а не
   * сумму — иначе задвоится столько раз, в скольких кампаниях товар крутится.
   */
  orderedSum: number;
};

export type OzonSkuAds = {
  items: Record<string, SkuAdRow>;   // offer_id (артикул продавца) → расход
  days: number;
  count: number;
  fetchedAt: number;
};

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * Глобальная очередь отчётов Ozon.
 *
 * Площадка разрешает РОВНО ОДИН активный запрос отчёта: при втором отвечает
 * 429 «Превышен лимит активных запросов (максимум 1)». Мы запрашиваем два
 * периода (текущая неделя и предыдущая), и без очереди они забивали друг друга —
 * обе выборки падали целиком (лог 02.08). Поэтому любые обращения к отчётам
 * выстраиваем в цепочку, независимо от того, кто их инициировал.
 */
// Стор на `process`, а не на модуле: под tsx один и тот же модуль грузится
// дважды (ESM для server.ts и CJS для api/), и у каждого инстанса была бы своя
// очередь — то есть два «одновременных» отчёта и гарантированный 429. Тот же
// приём и по той же причине применён в cache.ts.
const __ozQueue = ((process as any).__AV_OZON_REPORT_QUEUE__ ??= { tail: Promise.resolve() }) as { tail: Promise<unknown> };
function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const next = __ozQueue.tail.then(fn, fn);
  // Хвост очереди не должен обрываться из-за ошибки одной задачи.
  __ozQueue.tail = next.catch(() => {});
  return next;
}

// Границы отчётов Performance API — по Москве (Ozon считает сутки по МСК).
function iso(daysBack: number): string {
  return mskDate(daysBack);
}

/** Число из русского формата ("1 234,56" → 1234.56). */
function numRu(v: any): number {
  const s = String(v ?? '').replace(/\s| /g, '').replace(',', '.');
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

async function perfFetch(path: string, init?: RequestInit): Promise<Response> {
  const token = await getOzonPerfToken();
  return fetch(`${PERF_HOST}/${path.replace(/^\//, '')}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
    signal: AbortSignal.timeout(60_000),
  });
}

/**
 * Кампании для отчёта. Сначала работающие — они дают основной расход; затем
 * остальные (недавно остановленные тоже могли потратить за период).
 * Ozon разрешает максимум 10 кампаний на один отчёт, поэтому список режем на
 * пачки в compute(). Общее число ограничиваем, чтобы прогрев не длился вечно.
 */
/**
 * Кампании, по которым есть что считать: у которых за окно БЫЛ расход.
 *
 * Раньше брали список кампаний и резали его вслепую: без архивных (а в архиве
 * за окно лежало 119 487 ₽, 17,7% расхода — аудит 04.09) и с потолком в 60
 * штук. Теперь спрашиваем Ozon синхронным сводом по всем кампаниям сразу
 * (`statistics/campaign/product/json` — без слота отчётов) и берём только те,
 * где moneySpent > 0. Архивные с расходом остаются, пустые не занимают слот.
 *
 * Тип ALL_SKU_PROMO («Оплата за заказ — все товары») исключаем всегда: на
 * товарный отчёт по ней Ozon отвечает 400 «generation of this type of report
 * is forbidden» и роняет ВСЮ пачку, куда она попала. Аналогично любые не-SKU.
 */
async function listCampaignIds(fromDays: number, toDays: number): Promise<string[]> {
  const num = (v: unknown) => { const n = parseFloat(String(v ?? '').replace(/\s/g, '').replace(',', '.')); return Number.isFinite(n) ? n : 0; };
  try {
    const r = await perfFetch(`api/client/statistics/campaign/product/json?dateFrom=${iso(fromDays)}&dateTo=${iso(toDays)}`);
    if (!r.ok) throw new Error(`campaign/product → ${r.status}`);
    const j = await r.json() as { rows?: Array<{ id: string; objectType?: string; status?: string; moneySpent?: string }> };
    const rows = j.rows ?? [];
    const withSpend = rows
      .filter(c => c?.id && String(c.objectType ?? '').toUpperCase() === 'SKU' && num(c.moneySpent) > 0)
      .sort((a, b) => num(b.moneySpent) - num(a.moneySpent));
    const total = withSpend.reduce((s, c) => s + num(c.moneySpent), 0);
    console.log(`[ozon-sku-ads] кампаний в своде=${rows.length}, с расходом за окно=${withSpend.length}` +
      ` (архивных ${withSpend.filter(c => c.status === 'CAMPAIGN_STATE_ARCHIVED').length}), расход по своду=${Math.round(total)}`);
    return withSpend.map(c => String(c.id)).slice(0, MAX_CAMPAIGNS);
  } catch (e) {
    // Свод недоступен — берём список кампаний по-старому, но уже без ALL_SKU_PROMO.
    console.warn('[ozon-sku-ads] свод по кампаниям не получен, берём список:', (e as Error).message);
    const r = await perfFetch('api/client/campaign');
    if (!r.ok) throw new Error(`campaign → ${r.status}`);
    const j = await r.json() as { list?: Array<{ id: string; state?: string; advObjectType?: string }> };
    const sku = (j.list ?? []).filter(c => c?.id && String(c.advObjectType ?? '').toUpperCase() === 'SKU');
    const running = sku.filter(c => c.state === 'CAMPAIGN_STATE_RUNNING').map(c => String(c.id));
    const rest = sku.filter(c => c.state !== 'CAMPAIGN_STATE_RUNNING').map(c => String(c.id));
    return [...running, ...rest].slice(0, MAX_CAMPAIGNS);
  }
}

// ─── Незабранные отчёты ─────────────────────────────────────────────────────
// Отчёт, который мы заказали и не дождались, остаётся АКТИВНЫМ у Ozon и держит
// единственный слот. Раньше мы про него забывали и заказывали новый — тот падал
// с 429, и так по кругу, пока не кончится проход. Поэтому UUID запоминаем: на
// следующем заходе не заказываем заново, а забираем начатое. Это же само собой
// освобождает слот.
type PendingMap = Record<string, { uuid: string; at: number }>;
const PENDING_KEY = 'ozon-sku-ads:pending:v1';

/** Ключ запроса: окно + состав пачки. Другая пачка — другой отчёт. */
function reqKey(chunk: string[], fromDays: number, toDays: number): string {
  return `${fromDays}:${toDays}:${chunk.join(',')}`;
}

async function readPending(): Promise<PendingMap> {
  const v = await cacheGet<PendingMap>(PENDING_KEY);
  const map = v?.data ?? {};
  const now = Date.now();
  // Протухшие выкидываем: Ozon давно закрыл такой отчёт сам, и тянуть его незачем.
  for (const k of Object.keys(map)) if (now - map[k].at > PENDING_TTL_MS) delete map[k];
  return map;
}

async function setPending(key: string, uuid: string | null): Promise<void> {
  const map = await readPending();
  if (uuid) map[key] = { uuid, at: Date.now() };
  else delete map[key];
  await cacheSet(PENDING_KEY, map, PENDING_TTL_MS);
}

/**
 * Заказ отчёта. Если слот занят (429), ждём его освобождения в пределах бюджета,
 * а не бросаем пачку после трёх попыток.
 *
 * Занять слот может и клиент из интерфейса Ozon — тогда ждать правильнее, чем
 * терять выборку: расход по этим кампаниям иначе просто не появится в кабинете.
 */
async function createReport(chunk: string[], fromDays: number, toDays: number): Promise<Response> {
  const body = JSON.stringify({
    campaigns: chunk,
    from: `${iso(fromDays)}T00:00:00.000Z`,
    to: `${iso(toDays)}T23:59:59.000Z`,
    groupBy: 'NO_GROUP_BY',
  });
  const until = Date.now() + SLOT_BUDGET_MS;
  let waited = 0;
  for (;;) {
    const r = await perfFetch('api/client/statistics', { method: 'POST', body });
    if (r.status !== 429) return r;
    if (Date.now() + RETRY_429_MS > until) {
      console.warn(`[ozon-sku-ads] слот отчётов занят дольше ${Math.round(SLOT_BUDGET_MS / 60_000)} мин — пропускаем пачку`);
      return r;
    }
    waited += RETRY_429_MS;
    console.warn(`[ozon-sku-ads] отчёт уже строится, ждём слот (${Math.round(waited / 1000)} c)`);
    await sleep(RETRY_429_MS);
  }
}

/** Дождаться готовности отчёта. Возвращает false, если бюджет вышел. */
async function waitReady(uuid: string): Promise<boolean> {
  const until = Date.now() + POLL_BUDGET_MS;
  while (Date.now() < until) {
    await sleep(POLL_DELAY_MS);
    const st = await perfFetch(`api/client/statistics/${uuid}`);
    if (!st.ok) continue;
    const state = String(((await st.json()) as { state?: string })?.state ?? '').toUpperCase();
    if (state === 'OK' || state === 'SUCCESS') return true;
    if (state === 'ERROR' || state === 'FAILED') throw new Error(`statistics state=${state}`);
  }
  return false;
}

/** Один отчёт по пачке кампаний: заказать → дождаться → скачать → разобрать. */
async function reportForChunk(chunk: string[], fromDays: number, toDays: number): Promise<Record<string, SkuAdRow>> {
  const key = reqKey(chunk, fromDays, toDays);
  const pending = (await readPending())[key];

  let uuid: string;
  if (pending) {
    // Забираем отчёт, начатый прошлым проходом: он и держал слот.
    uuid = pending.uuid;
    console.log(`[ozon-sku-ads] подбираем незабранный отчёт ${uuid.slice(0, 8)}…`);
  } else {
    const createRes = await createReport(chunk, fromDays, toDays);
    if (!createRes.ok) {
      const t = await createRes.text().catch(() => '');
      throw new Error(`statistics create → ${createRes.status} ${t.slice(0, 200)}`);
    }
    // Ozon отдаёт идентификатор то как UUID, то как uuid — принимаем оба варианта.
    const created = await createRes.json() as { UUID?: string; uuid?: string };
    const got = created.UUID ?? created.uuid;
    if (!got) throw new Error('statistics: не получили UUID');
    uuid = got;
    // Запоминаем СРАЗУ: если процесс убьют на ожидании, отчёт всё равно найдётся.
    await setPending(key, uuid);
  }

  let ready: boolean;
  try {
    ready = await waitReady(uuid);
  } catch (e) {
    await setPending(key, null);   // Ozon сказал ERROR — подбирать нечего
    throw e;
  }
  if (!ready) {
    // Не готов — UUID НЕ забываем: следующий проход дождётся его, а не закажет
    // новый поверх занятого слота.
    throw new Error(`отчёт не готов за ${Math.round(POLL_BUDGET_MS / 60_000)} мин, подберём следующим проходом`);
  }

  const rep = await perfFetch(`api/client/statistics/report?UUID=${encodeURIComponent(uuid)}`);
  if (!rep.ok) throw new Error(`statistics report → ${rep.status}`);

  // Ozon отдаёт отчёт то голым CSV, то ZIP-архивом с одним файлом внутри.
  // Определяем по сигнатуре PK\x03\x04, а не по content-type: он бывает общим
  // (application/octet-stream) для обоих вариантов.
  const raw = Buffer.from(await rep.arrayBuffer());
  let csv: string;
  let files = 1;
  const zipped = isZip(raw);
  if (zipped) {
    // На пачку из N кампаний Ozon отдаёт ZIP с N файлами — по одному на
    // кампанию. Прежний unzipSingle читал только ПЕРВЫЙ: из десяти кампаний
    // данные доставались по одной, обычно без расхода → «SKU=0» при полных
    // отчётах, 3,3% реальной рекламы в кабинете (аудит 04.09). Склеиваем все:
    // parseReportCsv на каждом заголовке «sku;…» пересчитывает колонки.
    try {
      const entries = unzipAll(raw);
      files = entries.length;
      csv = entries.map(e => e.data.toString('utf-8')).join('\n');
    } catch (e) {
      console.warn('[ozon-sku-ads] не смог распаковать ZIP отчёта:', (e as Error).message);
      return {};
    }
  } else {
    csv = raw.toString('utf-8');
  }

  await setPending(key, null);   // забрали — слот свободен

  const parsed = parseReportCsv(csv);
  // Диагностика всегда: без реальных заголовков разбор не починить, а они у Ozon
  // отличаются между типами отчётов.
  const head = csv.split(/\r?\n/).slice(0, 2).join(' | ').slice(0, 350);
  console.log(`[ozon-sku-ads] отчёт: ${zipped ? `zip×${files}` : 'csv'}, ${raw.length}б, SKU=${Object.keys(parsed).length}. Начало: ${head}`);
  return parsed;
}

/**
 * Разбирает CSV отчёта. Колонки ищем ПО ЗАГОЛОВКУ, а не по индексу: Ozon меняет
 * порядок и состав столбцов между типами кампаний, жёсткие индексы ломались бы.
 */
function parseReportCsv(csv: string): Record<string, SkuAdRow> {
  const out: Record<string, SkuAdRow> = {};
  const lines = csv.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return out;

  // ВАЖНО: в отчёте НЕСКОЛЬКО секций — по одной на каждую кампанию из пачки.
  // Каждая начинается строкой «;Кампания по продвижению товаров № …» и своим
  // заголовком «sku;Название товара;…». Раньше разбиралась только ПЕРВАЯ секция,
  // из-за чего в итог попадала горстка товаров, а у остальных ДРР оставался «из
  // таблицы» (жалоба 31.07). Теперь идём по всем строкам и на каждом заголовке
  // пересчитываем номера колонок.
  const sep = lines.find(l => l.includes(';')) ? ';' : ',';
  const findCol = (head: string[], ...pats: RegExp[]) => head.findIndex(h => pats.some(p => p.test(h)));

  // Реальные заголовки Ozon (проверено 29.07):
  // sku;Название товара;Цена товара, ₽;Показы;Клики;CTR, %;Добавления в корзину;
  // Средняя стоимость клика, ₽;Расход, ₽, с НДС;Продано товаров;
  // Продажи в продвижении, ₽;…;ДРР в продвижении, %;Заказано на сумму, ₽;…
  let cSku = -1, cSpend = -1, cRevenue = -1, cOrders = -1, cDrr = -1;
  let cViews = -1, cClicks = -1, cCarts = -1, cOrdered = -1;
  let sections = 0;

  for (const line of lines) {
    const cells = line.split(sep).map(c => c.trim().replace(/^"|"$/g, ''));
    const lower = cells.map(c => c.toLowerCase());

    // Строка-заголовок секции: первая ячейка «sku» или «артикул».
    if (/^(sku|артикул)/.test(lower[0] ?? '')) {
      cSku = findCol(lower, /артикул/, /^sku$/, /offer/);
      cSpend = findCol(lower, /расход/, /затрат/, /spent/, /spend/);
      cRevenue = findCol(lower, /продажи в продвижении/, /выручк/, /revenue/);
      // «Заказано на сумму» — ВСЕ заказы SKU, знаменатель ДРР по формуле клиента.
      cOrdered = findCol(lower, /заказано на сумму/);
      cOrders = findCol(lower, /продано товаров/, /^заказ/, /^orders$/);
      cDrr = findCol(lower, /дрр в продвижении/, /^дрр/);
      cViews = findCol(lower, /^показы/, /^views$/);
      cClicks = findCol(lower, /^клики/, /^clicks$/);
      cCarts = findCol(lower, /добавления в корзину/, /корзин/);
      sections++;
      continue;
    }
    // Строка-название кампании начинается с разделителя — пропускаем.
    if (cSku < 0 || cSpend < 0) continue;

    const sku = (cells[cSku] ?? '').trim().toUpperCase();
    // Данные только у строк, где артикул похож на настоящий (число или код).
    if (!sku || /^(итого|всего|total)/i.test(sku)) continue;

    const spend = numRu(cells[cSpend]);
    const revenue = cRevenue >= 0 ? numRu(cells[cRevenue]) : 0;
    const orders = cOrders >= 0 ? numRu(cells[cOrders]) : 0;
    if (!out[sku]) out[sku] = { spend: 0, revenue: 0, orders: 0, views: 0, clicks: 0, carts: 0, orderedSum: 0 };
    // Одно значение на SKU за период, в каждой кампании повторяется — не суммируем.
    if (cOrdered >= 0) out[sku].orderedSum = Math.max(out[sku].orderedSum, numRu(cells[cOrdered]));
    out[sku].spend += spend;
    out[sku].revenue += revenue;
    out[sku].orders += orders;
    out[sku].views += cViews >= 0 ? numRu(cells[cViews]) : 0;
    out[sku].clicks += cClicks >= 0 ? numRu(cells[cClicks]) : 0;
    out[sku].carts += cCarts >= 0 ? numRu(cells[cCarts]) : 0;
    // ДРР берём из отчёта, но только если выручки нет — иначе посчитаем сами,
    // потому что при склейке нескольких кампаний проценты складывать нельзя.
    const drr = cDrr >= 0 ? numRu(cells[cDrr]) : 0;
    if (drr > 0 && !out[sku].revenue) out[sku].drr = drr;
  }
  if (sections > 1) console.log(`[ozon-sku-ads] в отчёте секций (кампаний): ${sections}`);
  return out;
}

/**
 * Числовой sku Ozon → артикул продавца (offer_id).
 *
 * Отчёт Performance отдаёт товары числовым sku, а весь наш интерфейс (цены,
 * закупки, себестоимость) работает по артикулу. Без этой сшивки расход просто
 * не находится ни для одного товара.
 */
async function buildSkuToOffer(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const headers = {
    'Client-Id': process.env.OZON_CLIENT_ID ?? '',
    'Api-Key': process.env.OZON_API_KEY ?? '',
    'Content-Type': 'application/json',
  };
  const post = async (path: string, body: unknown) => {
    const r = await fetch(`https://api-seller.ozon.ru/${path}`, {
      method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(40_000),
    });
    if (!r.ok) throw new Error(`${path} → ${r.status}`);
    return r.json() as any;
  };
  try {
    const list = await post('v3/product/list', { filter: { visibility: 'ALL' }, limit: 1000 });
    const ids: number[] = (list?.result?.items ?? []).map((i: any) => i.product_id).filter(Boolean);
    if (!ids.length) return map;
    // Инфо запрашиваем пачками: Ozon ограничивает размер списка.
    for (let i = 0; i < ids.length; i += 500) {
      const info = await post('v3/product/info/list', { product_id: ids.slice(i, i + 500) });
      for (const it of (info?.items ?? info?.result?.items ?? [])) {
        const offer = String(it?.offer_id ?? '').trim().toUpperCase();
        if (!offer) continue;
        for (const s of (it?.sources ?? [])) {
          if (s?.sku) map.set(String(s.sku), offer);
        }
        if (it?.sku) map.set(String(it.sku), offer);   // на случай плоского поля
      }
    }
  } catch (e) {
    console.warn('[ozon-sku-ads] не удалось сшить sku→артикул:', (e as Error).message);
  }
  return map;
}

async function compute(fromDays: number, toDays: number): Promise<OzonSkuAds> {
  const campaigns = await listCampaignIds(fromDays, toDays);
  if (!campaigns.length) {
    console.warn('[ozon-sku-ads] активных кампаний нет');
    // `days` тут не существовало: обращение к ней роняло функцию с ReferenceError
    // ровно в тот момент, когда активных кампаний нет. Наружу это выглядело как
    // сбой рекламы Ozon, хотя ответ должен быть «кампаний нет, расход нулевой».
    return { items: {}, days: fromDays - toDays + 1, count: 0, fetchedAt: Date.now() };
  }

  // Ozon: «Превышен лимит по количеству кампаний (максимум 10)» — режем на пачки
  // по 10 и склеиваем расход по SKU. Пачки идут последовательно: каждый отчёт
  // готовится до двух минут, параллелить смысла нет (упрёмся в лимиты).
  const chunks: string[][] = [];
  for (let i = 0; i < campaigns.length; i += CAMPAIGNS_PER_REPORT) {
    chunks.push(campaigns.slice(i, i + CAMPAIGNS_PER_REPORT));
  }

  const items: Record<string, SkuAdRow> = {};
  let okChunks = 0;
  // Общий потолок на окно. Бюджеты на отдельный отчёт нарочно щедрые (Ozon
  // готовит десяток кампаний минутами), но без общего потолка одно застрявшее
  // окно заняло бы очередь на часы и задушило прогрев остальных.
  const deadline = Date.now() + WINDOW_BUDGET_MS;
  for (const [i, chunk] of chunks.entries()) {
    if (Date.now() > deadline) {
      console.warn(`[ozon-sku-ads] бюджет окна исчерпан на пачке ${i + 1}/${chunks.length} — остальное доберём следующим проходом`);
      break;
    }
    try {
      const part = await enqueue(() => reportForChunk(chunk, fromDays, toDays));
      for (const [sku, row] of Object.entries(part)) {
        if (!items[sku]) items[sku] = { spend: 0, revenue: 0, orders: 0, views: 0, clicks: 0, carts: 0, orderedSum: 0 };
        items[sku].orderedSum = Math.max(items[sku].orderedSum, row.orderedSum ?? 0);
        items[sku].spend += row.spend;
        items[sku].revenue += row.revenue;
        items[sku].orders += row.orders;
        // Воронку тоже складываем: без неё нельзя отличить «не показывается» от
        // «показывается, но не кликают». Раньше эти три поля терялись при склейке
        // пачек, и в таблице были нули при живых показах.
        items[sku].views += row.views ?? 0;
        items[sku].clicks += row.clicks ?? 0;
        items[sku].carts += row.carts ?? 0;
      }
      okChunks++;
    } catch (e) {
      // Одна упавшая пачка не должна обнулять остальные — считаем по тому, что есть.
      console.warn(`[ozon-sku-ads] пачка ${i + 1}/${chunks.length} не удалась:`, (e as Error).message);
    }
  }

  if (!okChunks) throw new Error('ни одна пачка кампаний не отдала отчёт');

  // Переводим числовые sku в артикулы — по ним ищет модуль «Цены».
  const skuToOffer = await buildSkuToOffer();
  const byOffer: Record<string, SkuAdRow> = {};
  let unmapped = 0;
  for (const [sku, row] of Object.entries(items)) {
    const offer = skuToOffer.get(sku) ?? (/^\d+$/.test(sku) ? null : sku); // не число — уже артикул
    if (!offer) { unmapped++; continue; }
    if (!byOffer[offer]) byOffer[offer] = { spend: 0, revenue: 0, orders: 0, views: 0, clicks: 0, carts: 0, orderedSum: 0 };
    byOffer[offer].orderedSum = Math.max(byOffer[offer].orderedSum, row.orderedSum ?? 0);
    byOffer[offer].spend += row.spend;
    byOffer[offer].revenue += row.revenue;
    byOffer[offer].orders += row.orders;
    byOffer[offer].views += row.views;
    byOffer[offer].clicks += row.clicks;
    byOffer[offer].carts += row.carts;
    if (row.drr && !byOffer[offer].revenue) byOffer[offer].drr = row.drr;
  }

  const count = Object.keys(byOffer).length;
  const totalSpend = Object.values(byOffer).reduce((s, r) => s + r.spend, 0);
  console.log(`[ozon-sku-ads] пачек ${okChunks}/${chunks.length}, товаров=${count}, расход=${Math.round(totalSpend)} за период ${iso(fromDays)}…${iso(toDays)}` +
    (unmapped ? `, без артикула=${unmapped}` : ''));
  if (okChunks && !count) console.warn('[ozon-sku-ads] отчёты получены, но товары не сопоставились с артикулами');

  return { items: byOffer, days: fromDays - toDays + 1, count, fetchedAt: Date.now() };
}

// Чтобы два одновременных запроса не заказывали одни и те же отчёты дважды.
const inFlight = new Map<string, Promise<OzonSkuAds>>();

const rangeKey = (fromDays: number, toDays: number) => `${CACHE_KEY}:${fromDays}-${toDays}`;

async function refresh(fromDays: number, toDays: number): Promise<OzonSkuAds> {
  const key = rangeKey(fromDays, toDays);
  try {
    const fresh = await compute(fromDays, toDays);
    await cacheSet(key, fresh, TTL_MS);
    return fresh;
  } catch (e) {
    console.warn('[ozon-sku-ads] сбой:', (e as Error).message);
    const cached = await cacheGet<OzonSkuAds>(key);
    return cached?.data ?? { items: {}, days: fromDays - toDays + 1, count: 0, fetchedAt: Date.now() };
  } finally {
    inFlight.delete(key);
  }
}

/**
 * Расход по SKU за произвольное окно, заданное в «днях назад».
 * Например (7, 0) — последние 7 дней, (14, 8) — предыдущие 7 дней.
 * Второе окно нужно сценариям про динамику: «CTR снизился», «CPC вырос».
 *
 * Сборка отчётов долгая (пачки по 10 кампаний, каждая до 2 минут), поэтому
 * НЕ заставляем браузер ждать: отдаём что есть в кэше и обновляем в фоне.
 */
export async function getOzonSkuAdsRange(fromDays: number, toDays: number, noCache = false): Promise<OzonSkuAds> {
  const key = rangeKey(fromDays, toDays);
  const cached = await cacheGet<OzonSkuAds>(key);
  if (!noCache && isFresh(cached)) return cached.data;

  const running = inFlight.get(key) ?? (() => {
    const p = refresh(fromDays, toDays);
    inFlight.set(key, p);
    return p;
  })();

  // Есть прошлый результат — отдаём его сразу, обновление идёт фоном.
  if (cached?.data && !noCache) {
    void running.catch(() => {});
    return cached.data;
  }
  // Кэша нет вовсе (первый запуск) — приходится подождать сборку.
  return running;
}

/**
 * Только кэш, без сборки. Если данных нет — возвращает null и запускает прогрев
 * в фоне. Нужно там, где ждать нельзя: сборка отчётов Ozon занимает минуты, и
 * команда в боте молча висела бы всё это время.
 */
export async function getOzonSkuAdsCached(fromDays: number, toDays: number): Promise<OzonSkuAds | null> {
  const cached = await cacheGet<OzonSkuAds>(rangeKey(fromDays, toDays));
  if (cached?.data) return cached.data;
  void getOzonSkuAdsRange(fromDays, toDays).catch(() => {});   // прогреем к следующему разу
  return null;
}

/** Совместимость: последние N дней. Используется модулем «Цены». */
export async function getOzonSkuAds(days = 30, noCache = false): Promise<OzonSkuAds> {
  return getOzonSkuAdsRange(days, 0, noCache);
}
