// Цена ПОКУПАТЕЛЯ Ozon (со скидкой площадки / соинвестом) + ПАМЯТЬ последнего СПП.
//
// ИСТОЧНИК (как у Культуры Аналитики): отчёт о реализации
// POST /v2/finance/realization {month, year} → по каждой продаже:
//   seller_price_per_instance            — цена продавца/шт
//   delivery_commission.price_per_instance — цена, которую заплатил ПОКУПАТЕЛЬ/шт
//     (= цена продавца − бонус-соинвест; рядом bank_coinvestment/pick_up_point_coinvestment).
// СПП = (цена продавца − цена покупателя) / цена продавца. Усредняем по SKU за
// последние доступные месяцы (взвешенно по количеству).
//
// Почему НЕ API акций: там action_price = цена ПРОДАВЦА (соинвест не вычтен) → 79%
// от служебного потолка были мусором. Реальную цену покупателя отдаёт только отчёт
// о реализации / customer_price в отправлениях (проверено на живом кабинете 21.07).
//
// Память: последний достоверный СПП по SKU (переживает рестарты, ~180 дней) — когда
// продаж в отчёте нет, фронт восстанавливает вторую цену от текущей ЛК по нему.

import { fetchWithRetry } from './fetchRetry';
import { cacheGet, cacheSet, isFresh } from './cache';
import { noteSwallowed } from './log';

const BASE = 'https://api-seller.ozon.ru';
const RESULT_KEY = 'ozon-buyer-prices:v2';
// 1 ч: основной источник — отправления, они приезжают в течение суток, держать
// 6-часовой кэш (как под месячный отчёт) значит искусственно добавлять отставание.
const TTL_MS = 60 * 60_000;
const HISTORY_KEY = 'ozon-spp-history:v3';
const HISTORY_TTL_MS = 180 * 24 * 60 * 60_000;

export type OzonBuyerPrice = {
  price: number;      // средняя цена продавца/шт
  buyer: number;      // средняя цена ПОКУПАТЕЛЯ/шт (со соинвестом)
  spp: number;        // % соинвеста = (price − buyer) / price
  units: number;      // сколько продаж учтено
  /** Откуда цифра: отправления (свежая, до суток) или месячный отчёт реализации. */
  source?: 'postings' | 'realization';
  /** Дата последней учтённой продажи (YYYY-MM-DD) — видно, насколько цена свежая. */
  date?: string;
};

export type OzonSppHistory = Record<string, { spp: number; date: string }>;

export type OzonBuyerPrices = {
  items: Record<string, OzonBuyerPrice>; // offer_id (UPPER) → цена покупателя (только настоящий соинвест)
  sppHistory?: OzonSppHistory;
  count: number;
  monthsUsed: string[];
  /** Сколько артикулов закрыто свежими отправлениями (остальные — из реализации). */
  fromPostings?: number;
  fetchedAt: number;
};

function ozHeaders(): Record<string, string> {
  return {
    'Client-Id': process.env.OZON_CLIENT_ID ?? '',
    'Api-Key': process.env.OZON_API_KEY ?? '',
    'Content-Type': 'application/json',
  };
}

async function ozReq(path: string, body?: unknown): Promise<any> {
  const res = await fetchWithRetry(
    `${BASE}/${path}`,
    { method: 'POST', headers: ozHeaders(), body: body !== undefined ? JSON.stringify(body) : undefined },
    { maxRetries: 2, timeoutMs: 40_000 },
  );
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`ozon ${path} → ${res.status} ${txt.slice(0, 200)}`);
  }
  return res.json();
}

async function getSppHistory(): Promise<OzonSppHistory> {
  const c = await cacheGet<OzonSppHistory>(HISTORY_KEY);
  return c?.data ?? {};
}

/**
 * ЦЕНА ПОКУПАТЕЛЯ ИЗ ОТПРАВЛЕНИЙ — основной источник (клиент 05.08: «цены
 * катастрофически отстают, чуть ли не в неделю»).
 *
 * Причина отставания была в источнике: месячный отчёт о реализации по своей
 * природе догоняет факт на дни. У отправлений в `financial_data.products[]`
 * есть `customer_price` — сколько покупатель реально заплатил за штуку, — и он
 * доступен в течение суток после заказа.
 *
 * ВАЖНО, проверено на живом кабинете 10.08 (иначе легко сделать неправильно):
 *   • FBS: `v3/posting/fbs/list` → `result.postings`, offset-пагинация,
 *     customer_price приходит СРАЗУ в списке (было 224 из 224 позиций).
 *   • FBO: `v3/posting/fbo/list` → `postings` + `cursor` на ВЕРХНЕМ уровне,
 *     и customer_price в списке НЕ приходит вовсе (0 из 100) — ни в v3, ни в v2.
 *     Его отдаёт только детальный `v2/posting/fbo/get` по одному отправлению
 *     (там же он и обнаружился: POLFAR продавец 1547 → покупатель 853).
 *   Поэтому для FBO добираем детали точечно: идём по отправлениям от свежих к
 *   старым и запрашиваем деталь только для тех артикулов, цены которых ещё нет.
 *   Это ≤1 запрос на артикул за прогон (кэш 1 ч), а не запрос на отправление.
 *
 * По каждому артикулу берём САМЫЙ СВЕЖИЙ день с продажами и усредняем внутри
 * него (а не по всему окну): при смене цены среднее по окну тянуло бы старую.
 */
/** Артикул → дата → суммы (цена продавца, цена покупателя, штук). */
type ByDate = Map<string, { ss: number; bs: number; q: number }>;

/**
 * Порог правдоподобия соинвеста. Проверено 10.08: у одного артикула в отдельном
 * отправлении customer_price приходил 66 ₽ при цене продавца 3086 (СПП 98%),
 * тогда как все остальные его продажи дают устойчивые 40-56%. Такие выбросы
 * (компенсации, служебные позиции) нельзя показывать как цену — день с таким
 * значением отбрасываем и берём предыдущий.
 */
const MAX_PLAUSIBLE_SPP = 0.85;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Сколько FBO-отправлений разворачиваем в детали за один прогон. */
const MAX_FBO_DETAILS = 80;

/** FBS: список сразу с ценой покупателя, offset-пагинация. */
async function fetchFbs(sinceIso: string, toIso: string): Promise<any[]> {
  const out: any[] = [];
  const LIMIT = 1000;
  for (let offset = 0; offset < 10_000; offset += LIMIT) {
    let r: any;
    try {
      r = await ozReq('v3/posting/fbs/list', {
        dir: 'DESC', filter: { since: sinceIso, to: toIso },
        limit: LIMIT, offset, translit: true, with: { financial_data: true },
      });
    } catch { break; }  // окно недоступно — работаем с тем, что успели
    const batch: any[] = r?.result?.postings ?? (Array.isArray(r?.result) ? r.result : []);
    out.push(...batch);
    if (batch.length < LIMIT) break;
  }
  return out;
}

/**
 * FBO: список (без цены покупателя) — курсорная пагинация.
 *
 * Две ловушки, проверено 10.08:
 *  • limit жёстко ≤100 (на 1000 приходит 400 «value must be inside range (0, 100]»);
 *  • `dir: 'DESC'` НЕ РАБОТАЕТ — список всегда идёт от старых к новым. Из-за
 *    этого обход «первых N страниц» за 30 дней упирался в середину июля, и цены
 *    получались трёхнедельной давности при наличии августовских продаж.
 *    Поэтому окно режем на блоки и идём блоками от свежих к старым (см. ниже).
 */
async function fetchFboList(sinceIso: string, toIso: string): Promise<any[]> {
  const out: any[] = [];
  const LIMIT = 100;
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    let r: any;
    try {
      r = await ozReq('v3/posting/fbo/list', {
        dir: 'DESC', filter: { since: sinceIso, to: toIso },
        limit: LIMIT, translit: true, with: { financial_data: true },
        ...(cursor ? { cursor } : { offset: 0 }),
      });
    } catch { break; }
    const batch: any[] = r?.postings ?? r?.result?.postings ?? (Array.isArray(r?.result) ? r.result : []);
    out.push(...batch);
    cursor = r?.cursor;
    if (!r?.has_next || !cursor || !batch.length) break;
  }
  return out;
}

/** Позиции отправления с ценой покупателя: [{offer, seller, buyer, qty}]. */
function readFinRows(p: any): { offer: string; seller: number; buyer: number; qty: number }[] {
  const offerBySku = new Map<string, string>();
  for (const it of (p?.products ?? [])) {
    const offer = String(it?.offer_id ?? '').trim().toUpperCase();
    if (offer && it?.sku != null) offerBySku.set(String(it.sku), offer);
  }
  const rows: { offer: string; seller: number; buyer: number; qty: number }[] = [];
  for (const fin of (p?.financial_data?.products ?? [])) {
    const offer = offerBySku.get(String(fin?.product_id ?? ''));
    if (!offer) continue;
    const seller = Number(fin?.price) || 0;
    const buyer = Number(String(fin?.customer_price ?? '').replace(',', '.')) || 0;
    if (seller <= 0 || buyer <= 0) continue;   // цены нет — закроет реализация/память
    rows.push({ offer, seller, buyer, qty: Number(fin?.quantity) || 1 });
  }
  return rows;
}

// 30 дней: на 14-дневном окне 27 из 63 артикулов оставались без свежей цены —
// у низкооборотных товаров продажи реже. Детали FBO всё равно ограничены сверху.
async function computeFromPostings(days = 30): Promise<Record<string, OzonBuyerPrice>> {
  const to = new Date();
  const since = new Date(to.getTime() - days * 86_400_000);
  const sinceIso = since.toISOString(), toIso = to.toISOString();
  const fbs = await fetchFbs(sinceIso, toIso);

  // Копим ПО ДНЯМ, а не только за самый свежий день: если свежий день окажется
  // выбросом, надо иметь куда откатиться.
  const acc = new Map<string, ByDate>();
  const put = (offer: string, date: string, seller: number, buyer: number, q: number) => {
    // Выброс отбрасываем СРАЗУ, а не на выходе: иначе он «занимает» артикул,
    // мы считаем его закрытым и не идём за нормальными продажами постарше.
    if (buyer < seller * (1 - MAX_PLAUSIBLE_SPP)) return;
    let byDate = acc.get(offer);
    if (!byDate) { byDate = new Map(); acc.set(offer, byDate); }
    const cur = byDate.get(date) ?? { ss: 0, bs: 0, q: 0 };
    cur.ss += seller * q; cur.bs += buyer * q; cur.q += q;
    byDate.set(date, cur);
  };
  /** Есть ли по артикулу цена за этот день или свежее. */
  const covered = (offer: string, date: string): boolean => {
    const byDate = acc.get(offer);
    if (!byDate) return false;
    for (const d of byDate.keys()) if (d >= date) return true;
    return false;
  };
  const dateOf = (p: any) => String(p?.in_process_at ?? p?.created_at ?? '').slice(0, 10);

  for (const p of fbs) {
    const date = dateOf(p);
    if (!date) continue;
    for (const r of readFinRows(p)) put(r.offer, date, r.seller, r.buyer, r.qty);
  }

  // FBO: идём БЛОКАМИ от свежих дней к старым — список площадки отдаёт записи
  // от старых к новым и `dir` игнорирует, а нам нужны именно последние продажи.
  // Внутри блока дни близкие, поэтому порядок внутри уже не важен.
  const BLOCK_DAYS = 5;
  let details = 0;
  for (let start = 0; start < days && details < MAX_FBO_DETAILS; start += BLOCK_DAYS) {
    const blockTo = new Date(to.getTime() - start * 86_400_000);
    const blockSince = new Date(to.getTime() - Math.min(days, start + BLOCK_DAYS) * 86_400_000);
    const block = await fetchFboList(blockSince.toISOString(), blockTo.toISOString());

    for (const p of block) {
      if (details >= MAX_FBO_DETAILS) break;
      const date = dateOf(p);
      if (!date) continue;
      const offers = (p?.products ?? [])
        .map((it: any) => String(it?.offer_id ?? '').trim().toUpperCase())
        .filter(Boolean);
      // Если по всем артикулам отправления цена уже есть и она не старее — пропускаем.
      if (!offers.some((o: string) => !covered(o, date))) continue;
      let full: any;
      try {
        full = await ozReq('v2/posting/fbo/get', {
          posting_number: p?.posting_number, translit: true, with: { financial_data: true },
        });
      } catch { continue; }
      details++;
      await sleep(120);                                   // щадящий темп для Seller API
      for (const r of readFinRows(full?.result ?? full)) put(r.offer, date, r.seller, r.buyer, r.qty);
    }
  }

  const out: Record<string, OzonBuyerPrice> = {};
  for (const [offer, byDate] of acc) {
    // От свежего дня к старому — берём первый правдоподобный.
    for (const date of Array.from(byDate.keys()).sort((a, b) => b.localeCompare(a))) {
      const a = byDate.get(date)!;
      if (!a.q) continue;
      const seller = a.ss / a.q;
      const buyer = a.bs / a.q;
      if (seller <= 0 || buyer <= 0) continue;
      // buyer может быть равен seller — соинвеста просто нет, это валидная цена
      // (в отчёте реализации такие строки мы отбрасывали и теряли товар).
      if (buyer < seller * (1 - MAX_PLAUSIBLE_SPP)) continue;   // выброс — пробуем предыдущий день
      out[offer] = {
        price: Math.round(seller),
        buyer: Math.round(buyer),
        spp: Math.max(0, Math.round((seller - buyer) / seller * 100)),
        units: a.q,
        source: 'postings',
        date,
      };
      break;
    }
  }
  return out;
}

async function computeFromRealization(): Promise<OzonBuyerPrices> {
  // Идём от свежего месяца к старому и берём по каждому SKU ТОЛЬКО самый свежий
  // месяц (не смешиваем!). Раньше блендили июнь+май → в мае была более глубокая
  // скидка, среднее соинвеста уезжало вверх (напр. HDMI: июнь 43% → бленд 61%).
  const now = new Date();
  const out: Record<string, OzonBuyerPrice> = {};
  const hist = await getSppHistory();
  const today = new Date().toISOString().slice(0, 10);
  const monthsUsed: string[] = [];
  let histChanged = false;
  for (let i = 0; i < 4; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const month = d.getUTCMonth() + 1;
    const year = d.getUTCFullYear();
    let r: any;
    try { r = await ozReq('v2/finance/realization', { month, year }); }
    catch { continue; } // отчёт за месяц ещё не готов / недоступен
    const rows: any[] = r?.result?.rows ?? [];
    if (!rows.length) continue;
    monthsUsed.push(`${year}-${String(month).padStart(2, '0')}`);
    // Агрегируем ТОЛЬКО в рамках этого месяца.
    const acc: Record<string, { ss: number; sq: number; bs: number; bq: number }> = {};
    for (const row of rows) {
      const offer = String(row?.item?.offer_id ?? '').trim().toUpperCase();
      if (!offer || out[offer]) continue; // уже есть из более свежего месяца — пропускаем
      const seller = Number(row?.seller_price_per_instance) || 0;
      const dc = row?.delivery_commission ?? {};
      const buyer = Number(dc?.price_per_instance) || 0;
      const q = Number(dc?.quantity) || 1;
      if (seller <= 0 || buyer <= 0) continue;
      const a = (acc[offer] ??= { ss: 0, sq: 0, bs: 0, bq: 0 });
      a.ss += seller * q; a.sq += q; a.bs += buyer * q; a.bq += q;
    }
    for (const [offer, a] of Object.entries(acc)) {
      if (!a.sq || !a.bq) continue;
      const seller = a.ss / a.sq;
      const buyer = a.bs / a.bq;
      if (buyer >= seller) continue; // соинвеста нет — пропускаем
      const spp = Math.round((seller - buyer) / seller * 100);
      if (spp <= 0) continue;
      out[offer] = { price: Math.round(seller), buyer: Math.round(buyer), spp, units: a.bq, source: 'realization' };
      hist[offer] = { spp, date: today }; // запоминаем последний настоящий соинвест
      histChanged = true;
    }
  }
  if (histChanged) await cacheSet(HISTORY_KEY, hist, HISTORY_TTL_MS);

  return { items: out, sppHistory: hist, count: Object.keys(out).length, monthsUsed, fetchedAt: Date.now() };
}

/**
 * Итоговая цена покупателя: отправления главнее отчёта реализации.
 * Реализация остаётся в роли подстраховки — закрывает артикулы, которых не было
 * в окне отправлений, и служит сверкой (цифры должны сходиться на горизонте месяца).
 */
async function compute(): Promise<OzonBuyerPrices> {
  const base = await computeFromRealization().catch((): OzonBuyerPrices => ({
    items: {}, count: 0, monthsUsed: [], fetchedAt: Date.now(),
  }));

  let fresh: Record<string, OzonBuyerPrice> = {};
  try { fresh = await computeFromPostings(); }
  catch (e) {
    // Остаёмся на реализации, как было раньше. Но отставание цены с суток до недели
    // клиент замечает сразу, а причину без журнала не найти.
    noteSwallowed('ozon-prices', 'отправления недоступны, цена берётся из реализации', e);
  }

  const items = { ...base.items, ...fresh };

  // Свежий соинвест из отправлений тоже кладём в память СПП: она восстанавливает
  // вторую цену для товаров, которые сейчас не продаются.
  if (Object.keys(fresh).length) {
    const hist = await getSppHistory();
    for (const [offer, p] of Object.entries(fresh)) {
      if (p.spp > 0 && p.date) hist[offer] = { spp: p.spp, date: p.date };
    }
    await cacheSet(HISTORY_KEY, hist, HISTORY_TTL_MS);
    base.sppHistory = hist;
  }

  return {
    ...base,
    items,
    count: Object.keys(items).length,
    fromPostings: Object.keys(fresh).length,
    fetchedAt: Date.now(),
  };
}

/**
 * Пересчёт с защитой от наложения: параллельные запросы получают ОДИН пересчёт,
 * а не каждый свой. Иначе три открытые вкладки — три полных обхода отправлений
 * Ozon разом.
 */
let recomputing: Promise<OzonBuyerPrices> | null = null;
function recompute(): Promise<OzonBuyerPrices> {
  recomputing ??= (async () => {
    try {
      const fresh = await compute();
      await cacheSet(RESULT_KEY, fresh, TTL_MS);
      return fresh;
    } finally {
      recomputing = null;
    }
  })();
  return recomputing;
}

export async function getOzonBuyerPrices(noCache = false): Promise<OzonBuyerPrices> {
  const cached = await cacheGet<OzonBuyerPrices>(RESULT_KEY);
  let base: OzonBuyerPrices;

  if (!noCache && isFresh(cached)) {
    base = cached.data;
  } else if (!noCache && cached?.data) {
    // Данные устарели, но есть. Отдаём их СРАЗУ, а пересчёт идёт фоном.
    // Раньше здесь ждали полного обхода отправлений Ozon — на проде это 17
    // секунд, в течение которых страница «Цены» просто висела. Возраст ответа
    // уходит заголовком x-av-cache-age, так что «свежесть» не подменяется:
    // клиент видит, на какой момент цифры.
    void recompute().catch(e => noteSwallowed('ozon-prices', 'фоновый пересчёт цен покупателя не удался', e));
    base = cached.data;
  } else {
    // Кэша нет вовсе (или запросили принудительно) — приходится подождать.
    try {
      base = await recompute();
    } catch (e) {
      if (cached?.data) base = cached.data;
      else throw e;
    }
  }

  const sppHistory = await getSppHistory();
  return { ...base, sppHistory };
}
