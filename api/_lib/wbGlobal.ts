/**
 * WB Global — второй кабинет Wildberries (китайская компания, те же товары,
 * что в таблице «Склад»). Лист «WB Global» в «Ценах» (03.11.2026).
 *
 * Чем этот кабинет отличается от основного (проверено по кабинету, базе знаний
 * для Китая и оферте №29 от 01.10.2026):
 *   - цена товара задаётся в ЮАНЯХ (п. 5.1.1), покупателю показывается в рублях
 *     по «курсу Вайлдберриз» — он не выше курса ЦБ более чем на 10 %;
 *   - все расчёты с WB идут в юанях (п. 5.12), вывод денег через Payful;
 *   - работа только по FBS, хранения нет;
 *   - логистика со склада в России (п. 13.1.11, 1): 8 ¥ за первый литр +
 *     2 ¥ за каждый следующий (без округления — так в детализации WB); обратная
 *     доставка и хранение на складе WB уже входят в тариф. Отгрузка из Китая
 *     считается иначе (по весу), но наши склады — ФФ в Подольске, Радумле,
 *     Ярославле и Шушарах, поэтому берём российскую формулу.
 *
 * Токен — отдельный: WB_GLOBAL_TOKEN в .env (категории «Цены и скидки»,
 * «Контент», «Маркетплейс», «Тарифы»; только чтение). Без него раздел честно
 * говорит «токен не задан», а не показывает цифры основного кабинета.
 */
import { fetchWithRetry } from './fetchRetry';
import { cacheGet, cacheSet, isFresh } from './cache';
import { fetchAllWbCards } from './wbCards';
import { resolveCost } from './costs';

const CACHE_KEY = 'wb-global:v1';
const TTL_MS = 10 * 60_000;
const RATE_KEY = 'cbr-cny:v1';
const RATE_TTL_MS = 6 * 60 * 60_000;

export function wbGlobalToken(): string {
  return (process.env.WB_GLOBAL_TOKEN || '').trim();
}

export type WbGlobalRow = {
  nmId: number;
  vendorCode: string;
  title: string;
  subject: string;
  photo: string;
  /** Цена продавца до скидки, ¥. */
  priceCny: number;
  /** Скидка продавца, %. */
  discount: number;
  /** Цена со скидкой (то, что продавец реально ставит), ¥. */
  discountedCny: number;
  /** Цена со скидкой WB Клуба, ¥ (0 — клубной скидки нет). */
  clubCny: number;
  /** Валюта, которую вернул WB (ожидаем CNY). */
  currency: string;
  /** Комиссия FBS по предмету, % (null — WB не дал ставку). */
  commission: number | null;
  /** Габариты упаковки из карточки, см, и вес брутто, кг. */
  dims: { length: number; width: number; height: number; weightKg: number } | null;
  volumeL: number;
  /** Остаток на складах продавца (FBS), шт; null — остатки не получены. */
  stock: number | null;
  /** Себестоимость из таблицы «Склад», ₽. */
  cost: number | null;
  costKey: string | null;
};

export type WbGlobal = {
  rows: WbGlobalRow[];
  configured: boolean;
  /** Курс ЦБ ¥ → ₽ на дату. */
  cnyRate: { value: number; date: string } | null;
  errors: string[];
  fetchedAt: number;
};

const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Курс юаня ЦБ РФ (за 1 ¥). Публичный зеркальный JSON ЦБ, кэш 6 ч. */
export async function getCnyRate(): Promise<{ value: number; date: string } | null> {
  const cached = await cacheGet<{ value: number; date: string }>(RATE_KEY);
  if (isFresh(cached)) return cached.data;
  try {
    const res = await fetchWithRetry('https://www.cbr-xml-daily.ru/daily_json.js', { method: 'GET' }, { maxRetries: 2, timeoutMs: 15_000 });
    if (!res.ok) throw new Error(`cbr → ${res.status}`);
    const j: any = await res.json();
    const v = j?.Valute?.CNY;
    const value = num(v?.Value) / (num(v?.Nominal) || 1);
    if (!(value > 0)) throw new Error('cbr: нет курса CNY');
    const data = { value: Math.round(value * 10000) / 10000, date: String(j?.Date ?? '').slice(0, 10) };
    await cacheSet(RATE_KEY, data, RATE_TTL_MS);
    return data;
  } catch (e) {
    console.warn('[wb-global] курс ЦБ не получен:', (e as Error).message);
    return (cached as { data: { value: number; date: string } } | null)?.data ?? null;
  }
}

/** Все цены кабинета (list/goods/filter отдаёт до 1000 за раз). */
async function fetchPrices(H: Record<string, string>): Promise<any[]> {
  const out: any[] = [];
  for (let offset = 0; offset < 20_000; offset += 1000) {
    const res = await fetchWithRetry(
      `https://discounts-prices-api.wildberries.ru/api/v2/list/goods/filter?limit=1000&offset=${offset}`,
      { method: 'GET', headers: H }, { maxRetries: 2, timeoutMs: 30_000 });
    if (!res.ok) throw new Error(`цены → ${res.status} ${(await res.text().catch(() => '')).slice(0, 160)}`);
    const j: any = await res.json();
    const list: any[] = j?.data?.listGoods ?? [];
    out.push(...list);
    if (list.length < 1000) break;
  }
  return out;
}

/** Комиссии по предметам кабинета: у китайского кабинета поле kgvpChina. */
async function fetchCommissions(H: Record<string, string>): Promise<Map<string, number>> {
  const res = await fetchWithRetry('https://common-api.wildberries.ru/api/v1/tariffs/commission?locale=ru',
    { method: 'GET', headers: H }, { maxRetries: 2, timeoutMs: 30_000 });
  if (!res.ok) throw new Error(`комиссии → ${res.status} ${(await res.text().catch(() => '')).slice(0, 160)}`);
  const j: any = await res.json();
  const m = new Map<string, number>();
  for (const r of j?.report ?? []) {
    // У китайского кабинета ставка приходит в kgvpChina (проверено 03.11 токеном Global).
    const v = num(r?.kgvpChina ?? r?.kgvpMarketplace);
    if (r?.subjectID != null && v > 0) m.set(String(r.subjectID), v);
  }
  return m;
}

/** Остатки FBS: склады продавца → остатки по баркодам. Берём максимум по складам, как в основном кабинете. */
async function fetchStocks(H: Record<string, string>, cards: any[]): Promise<Record<string, number>> {
  const whRes = await fetch('https://marketplace-api.wildberries.ru/api/v3/warehouses', { headers: H });
  if (!whRes.ok) throw new Error(`склады → ${whRes.status}`);
  const whs: any[] = await whRes.json();
  const skuToNm = new Map<string, string>();
  for (const c of cards) for (const sz of c?.sizes ?? []) for (const sku of sz?.skus ?? []) skuToNm.set(String(sku), String(c.nmID));
  const skus = [...skuToNm.keys()];
  const out: Record<string, number> = {};
  for (const w of Array.isArray(whs) ? whs : []) {
    for (let i = 0; i < skus.length; i += 1000) {
      let res: Response | null = null;
      for (let attempt = 0; attempt < 4; attempt++) {
        res = await fetch(`https://marketplace-api.wildberries.ru/api/v3/stocks/${w.id}`,
          { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify({ skus: skus.slice(i, i + 1000) }) });
        if (res.status !== 429) break;
        await sleep(3000);
      }
      if (!res || !res.ok) continue;
      const j: any = await res.json().catch(() => null);
      for (const st of j?.stocks ?? []) {
        const nm = skuToNm.get(String(st?.sku)); if (!nm) continue;
        const a = num(st?.amount);
        if (a > (out[nm] ?? 0)) out[nm] = a;
      }
      await sleep(400);
    }
  }
  return out;
}

/**
 * Себестоимость по артикулу из «Склада». В кабинете Global часть артикулов
 * с хвостом «-DUBL» (дубль карточки) — себестоимость у них та же, что у основного.
 */
function costFor(vendorCode: string): { cost: number; key: string } | null {
  const r = resolveCost(vendorCode);
  if (r) return { cost: r.cost, key: r.key };
  const base = vendorCode.trim().replace(/-+DUBL\d*$/i, '');
  if (base !== vendorCode.trim()) {
    const b = resolveCost(base);
    if (b) return { cost: b.cost, key: b.key };
  }
  return null;
}

async function compute(): Promise<WbGlobal> {
  const token = wbGlobalToken();
  const cnyRate = await getCnyRate();
  if (!token) return { rows: [], configured: false, cnyRate, errors: [], fetchedAt: Date.now() };
  const H = { Authorization: token };
  const errors: string[] = [];

  const prices = await fetchPrices(H); // без цен листа нет — ошибка уходит наверх
  const [cardsRes, comm] = await Promise.all([
    fetchAllWbCards({ base: 'https://content-api.wildberries.ru', headers: H })
      .catch(e => { errors.push(`карточки: ${(e as Error).message}`); return { cards: [] as any[] }; }),
    fetchCommissions(H).catch(e => { errors.push(`комиссии: ${(e as Error).message}`); return new Map<string, number>(); }),
  ]);
  const cards = cardsRes.cards;
  let stocks: Record<string, number> | null = null;
  try { stocks = await fetchStocks(H, cards); } catch (e) { errors.push(`остатки: ${(e as Error).message}`); }

  const cardByNm = new Map<number, any>();
  for (const c of cards) if (c?.nmID != null) cardByNm.set(Number(c.nmID), c);

  const rows: WbGlobalRow[] = [];
  for (const p of prices) {
    const nmId = Number(p?.nmID);
    if (!nmId) continue;
    const c = cardByNm.get(nmId);
    const size = (p?.sizes ?? [])[0] ?? {};
    const d = c?.dimensions ?? {};
    const L = num(d.length), W = num(d.width), Hh = num(d.height);
    const dims = L > 0 && W > 0 && Hh > 0 ? { length: L, width: W, height: Hh, weightKg: num(d.weightBrutto) } : null;
    const vendorCode = String(p?.vendorCode ?? c?.vendorCode ?? '');
    const cost = costFor(vendorCode);
    const photo = c?.photos?.[0]?.c246x328 || c?.photos?.[0]?.big || '';
    rows.push({
      nmId,
      vendorCode,
      title: String(c?.title ?? ''),
      subject: String(c?.subjectName ?? ''),
      photo: String(photo),
      priceCny: num(size.price),
      discount: num(p?.discount),
      discountedCny: num(size.discountedPrice),
      clubCny: num(size.clubDiscountedPrice),
      currency: String(p?.currencyIsoCode4217 ?? ''),
      commission: c?.subjectID != null ? (comm.get(String(c.subjectID)) ?? null) : null,
      dims,
      volumeL: dims ? +(L * W * Hh / 1000).toFixed(3) : 0,
      stock: stocks ? (stocks[String(nmId)] ?? 0) : null,
      cost: cost?.cost ?? null,
      costKey: cost?.key ?? null,
    });
  }
  const cur = [...new Set(rows.map(r => r.currency).filter(Boolean))];
  console.warn(`[wb-global] товаров ${rows.length}, карточек ${cards.length}, валюта ${cur.join('/') || '—'}` +
    `, с себестоимостью ${rows.filter(r => r.cost).length}` + (errors.length ? `, ошибки: ${errors.join('; ')}` : ''));
  return { rows, configured: true, cnyRate, errors, fetchedAt: Date.now() };
}

export async function getWbGlobal(noCache = false): Promise<WbGlobal> {
  const cached = await cacheGet<WbGlobal>(CACHE_KEY);
  // Токен добавили/убрали — старый набор не годится.
  const tokenChanged = !!cached?.data && cached.data.configured !== !!wbGlobalToken();
  if (!noCache && !tokenChanged && isFresh(cached)) return cached.data;
  try {
    const fresh = await compute();
    await cacheSet(CACHE_KEY, fresh, TTL_MS);
    return fresh;
  } catch (e) {
    if (cached?.data && !tokenChanged) return { ...cached.data, errors: [...cached.data.errors, `обновление: ${(e as Error).message}`] };
    throw e;
  }
}
