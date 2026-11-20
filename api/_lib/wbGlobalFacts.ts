/**
 * Факты кабинета WB Global за 30 дней для калькулятора листа «WB Global»
 * (20.11.2026, просьба владельца: «чтобы подтягивались реальные данные по
 * логистике, эквайрингу, рекламе — как в нашем простом Wildberries»).
 *
 * Источники (токен WB_GLOBAL_TOKEN, всё в юанях):
 *   - finance-api sales-reports/detailed, period=daily — финотчёт. Операции
 *     подписаны по-китайски: 销售 продажа, 退货 возврат, 配送 доставка
 *     (bonusTypeName 销售时给客户 — к покупателю при продаже, 取消时给客户 —
 *     при отмене/невыкупе), 扣款 удержание (пополнение рекламы).
 *       логистика ¥ на проданную шт = все доставки товара ¥ / (продажи − возвраты);
 *       выкуп %  = продажи / (продажи + отмены);
 *       эквайринг % = acquiringFee / цена продажи (у Global проверено 20.11: 0).
 *   - advert-api /adv/v1/promotion/count + v4/fullstats — расход на рекламу
 *     по товару, ¥ (у кампаний Global currency CNY).
 *       ДРР % = расход на рекламу ¥ / выкупленные продажи до СПП ¥ за те же дни.
 *     База — выкупы, а не заказы: калькулятор считает «на одну выкупленную
 *     продажу» и вычитает рекламу как % от цены до СПП. Так реклама на единицу
 *     = расход / проданные штуки, ровно как у финменеджера (УСН-строка PNL).
 *
 * Как у основного WB (productEcon): нет данных — null, а не выдуманный
 * процент; «рекламы не было» — честный 0. Мало продаж у товара (< 3) — берём
 * среднее по кабинету и пишем это в подсказке (для выкупа; ДРР и логистика —
 * по товару, если выкуплена хотя бы одна штука).
 *
 * Запросы (сверено с диспетчером API 20.11, см. «Диспетчер API — реестр запросов»):
 * финотчёт — не чаще раза в 12 ч, реклама — тогда же; строго по очереди, между
 * методами пауза 2 с, перед каждым запросом ждём «тихую» минуту по Москве (не на
 * старте Baloo :x3/:x8, не на его сверке :16 чётного часа, не на минутах Мэй
 * :26/:56, 06:00, 19:00). Статистика рекламы — /api/advert/v4/fullstats, при
 * отказе — старый /adv/v3/fullstats.
 * Отдельного таймера нет: сбор запускается в фоне, когда лист открыт и факты
 * старше 12 ч (флаг «уже идёт»). Сбой одного источника не затирает прошлые
 * хорошие данные этого источника.
 */
import { fetchWithRetry } from './fetchRetry';
import { cacheGet, cacheSet } from './cache';
import { mskDate } from './mskDate';

const KEY = 'wb-global-facts:v1';
const REFRESH_MS = 12 * 60 * 60_000;
const RETRY_AFTER_FAIL_MS = 30 * 60_000;
const KEEP_MS = 30 * 24 * 60 * 60_000;
const DAYS = 30;
const MIN_SALES = 3;

export type WbgFactVal = { value: number | null; note: string };

export type WbgNmFact = {
  sales: number; returns: number; cancels: number;
  revenueCny: number;          // выкупы до СПП минус возвраты, ¥
  deliveryCny: number;         // все доставки товара, ¥
  adSpendCny: number;          // расход на рекламу, ¥
};

export type WbgFacts = {
  /** Даты окна финотчёта (первая и последняя строка). */
  from: string | null; to: string | null;
  byNm: Record<string, WbgNmFact>;
  /** Сколько строк финотчёта и кампаний разобрано. */
  finRows: number; campaigns: number;
  finAt: number | null; adsAt: number | null;
  acquiringCny: number;
  errors: string[];
};

/** Что подставляется в калькулятор по одному товару. */
export type WbgRowFacts = {
  drr: WbgFactVal;
  buyout: WbgFactVal;
  /** Логистика на одну проданную штуку, ¥ (уже с отменами и возвратами — на выкуп не делить). */
  logisticsCny: WbgFactVal;
  acquiring: WbgFactVal;
  sales: number;
};

const num = (v: unknown): number => { const n = Number(String(v ?? 0).replace(',', '.')); return Number.isFinite(n) ? n : 0; };
const r1 = (v: number) => Math.round(v * 10) / 10;
const r2 = (v: number) => Math.round(v * 100) / 100;
const empty = (): WbgNmFact => ({ sales: 0, returns: 0, cancels: 0, revenueCny: 0, deliveryCny: 0, adSpendCny: 0 });

/** Минута по Москве, когда в кабинет ходят соседи (Baloo, Мэй), — сколько ждать её конца. */
export function busyMinuteWaitMs(now = Date.now()): number {
  const d = new Date(now + 3 * 60 * 60_000);
  const h = d.getUTCHours(), m = d.getUTCMinutes(), sec = d.getUTCSeconds();
  const toNextMin = (60 - sec) * 1000;
  const m5 = m % 5;
  if (m5 === 3 && sec >= 4) return toNextMin + 5_000;     // старт Baloo :x3:04 / :x8:04 + 60 с
  if (m5 === 4 && sec < 5) return (5 - sec) * 1000;
  if (h % 2 === 0 && (m === 16 || m === 17)) return toNextMin + (m === 16 ? 60_000 : 0); // сверка Baloo
  if (m === 26 || m === 56) return toNextMin + 60_000;     // Мэй
  if (m === 27 || m === 57) return toNextMin;
  if ((h === 6 || h === 19) && m <= 1) return toNextMin + (m === 0 ? 60_000 : 0);
  return 0;
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function quiet(): Promise<void> {
  for (let i = 0; i < 5; i++) { const w = busyMinuteWaitMs(); if (!w) return; await sleep(w); }
}

async function fetchFinance(H: Record<string, string>) {
  await quiet();
  const res = await fetchWithRetry('https://finance-api.wildberries.ru/api/finance/v1/sales-reports/detailed', {
    method: 'POST', headers: { ...H, 'Content-Type': 'application/json' },
    body: JSON.stringify({ dateFrom: mskDate(DAYS), dateTo: mskDate(0), limit: 100000, rrdId: 0, period: 'daily' }),
  }, { maxRetries: 2, timeoutMs: 60_000, priority: 2 });
  if (!res.ok) throw new Error(`финотчёт → ${res.status} ${(await res.text().catch(() => '')).slice(0, 120)}`);
  const rows: any[] = await res.json();
  if (!Array.isArray(rows)) throw new Error('финотчёт: не список');
  const byNm: Record<string, WbgNmFact> = {};
  let from: string | null = null, to: string | null = null, acquiringCny = 0;
  for (const x of rows) {
    const day = String(x?.rrDate ?? '').slice(0, 10);
    if (day) { if (!from || day < from) from = day; if (!to || day > to) to = day; }
    const nm = String(x?.nmId ?? '');
    if (!nm || nm === '0') continue;
    const it = byNm[nm] ?? (byNm[nm] = empty());
    const op = String(x?.sellerOperName ?? '');
    const qty = Math.max(1, num(x?.quantity));
    if (op === '销售') { it.sales += qty; it.revenueCny += num(x?.retailPrice) * qty; acquiringCny += num(x?.acquiringFee); }
    else if (op === '退货') { it.returns += qty; it.revenueCny -= num(x?.retailPrice) * qty; acquiringCny -= num(x?.acquiringFee); }
    else if (op === '配送') {
      it.deliveryCny += num(x?.deliveryService);
      if (String(x?.bonusTypeName ?? '') === '取消时给客户') it.cancels += num(x?.deliveryAmount) || 1;
    }
  }
  return { byNm, from, to, acquiringCny, finRows: rows.length };
}

async function fetchAdSpend(H: Record<string, string>, from: string, to: string): Promise<{ spend: Record<string, number>; campaigns: number }> {
  await sleep(2_000); await quiet();
  const cRes = await fetchWithRetry('https://advert-api.wildberries.ru/adv/v1/promotion/count', { method: 'GET', headers: H },
    { maxRetries: 2, timeoutMs: 30_000, priority: 2 });
  if (!cRes.ok) throw new Error(`кампании → ${cRes.status}`);
  const cj: any = await cRes.json();
  const since = Date.parse(from + 'T00:00:00+03:00');
  const ids: number[] = [];
  for (const g of cj?.adverts ?? []) for (const a of g?.advert_list ?? []) {
    // Завершённые раньше окна в статистику не попадут — не спрашиваем.
    const st = Number(g?.status);
    if (st === 7 && (Date.parse(a?.changeTime ?? '') || 0) < since) continue;
    if (a?.advertId) ids.push(Number(a.advertId));
  }
  const spend: Record<string, number> = {};
  for (let i = 0; i < ids.length; i += 50) {
    const part = ids.slice(i, i + 50).join(',');
    // Рекламный API: 3 запроса в минуту — между пачками пауза, как в cron.ts.
    await sleep(i === 0 ? 2_000 : 65_000); await quiet();
    const res = await fetchWithRetry(`https://advert-api.wildberries.ru/api/advert/v4/fullstats?advertIds=${part}&beginDate=${from}&endDate=${to}`,
      { method: 'GET', headers: H }, { maxRetries: 3, timeoutMs: 60_000, priority: 2 });
    if (res.ok) {
      // v4: плоские строки «кампания × товар × день × зона показа × тип конверсии».
      const j: any = res.status === 204 ? null : await res.json().catch(() => null);
      for (const r of Array.isArray(j?.rows) ? j.rows : []) {
        const nm = String(r?.nmId ?? '');
        if (nm && nm !== '0') spend[nm] = (spend[nm] ?? 0) + num(r?.sum);
      }
      continue;
    }
    const v4err = `v4 → ${res.status} ${(await res.text().catch(() => '')).slice(0, 120)}`;
    // Запасной путь — старый v3, пока WB его не выключил.
    await sleep(65_000); await quiet();
    const r3 = await fetchWithRetry(`https://advert-api.wildberries.ru/adv/v3/fullstats?ids=${part}&beginDate=${from}&endDate=${to}`,
      { method: 'GET', headers: H }, { maxRetries: 2, timeoutMs: 60_000, priority: 2 });
    if (!r3.ok) throw new Error(`статистика рекламы: ${v4err}; v3 → ${r3.status}`);
    console.warn(`[wb-global-facts] fullstats ${v4err} — взял v3`);
    const arr: any[] = await r3.json().catch(() => []);
    for (const c of Array.isArray(arr) ? arr : []) for (const d of c?.days ?? []) for (const ap of d?.apps ?? []) for (const n of ap?.nms ?? []) {
      const nm = String(n?.nmId ?? '');
      if (nm) spend[nm] = (spend[nm] ?? 0) + num(n?.sum);
    }
  }
  return { spend, campaigns: ids.length };
}

let running: Promise<void> | null = null;
let lastFailAt = 0;

async function refresh(token: string): Promise<void> {
  const H = { Authorization: token };
  const prev = (await cacheGet<WbgFacts>(KEY))?.data ?? null;
  const errors: string[] = [];
  let fin: Awaited<ReturnType<typeof fetchFinance>> | null = null;
  try { fin = await fetchFinance(H); } catch (e) { errors.push(`финотчёт: ${(e as Error).message}`); }
  const from = fin?.from ?? prev?.from ?? mskDate(DAYS), to = fin?.to ?? prev?.to ?? mskDate(1);
  let ads: Awaited<ReturnType<typeof fetchAdSpend>> | null = null;
  try { ads = await fetchAdSpend(H, from, to); } catch (e) { errors.push(`реклама: ${(e as Error).message}`); }
  if (!fin && !ads) {
    lastFailAt = Date.now();
    console.warn('[wb-global-facts] не собрал факты:', errors.join('; '));
    if (prev) await cacheSet(KEY, { ...prev, errors }, KEEP_MS);
    return;
  }
  // Сбой одного источника — его прошлые данные остаются.
  const byNm: Record<string, WbgNmFact> = {};
  const finBy = fin?.byNm ?? prev?.byNm ?? {};
  for (const [nm, f] of Object.entries(finBy)) byNm[nm] = { ...f, adSpendCny: 0 };
  if (ads) for (const [nm, s] of Object.entries(ads.spend)) (byNm[nm] ?? (byNm[nm] = empty())).adSpendCny = s;
  else if (prev) for (const [nm, f] of Object.entries(prev.byNm)) if (f.adSpendCny) (byNm[nm] ?? (byNm[nm] = empty())).adSpendCny = f.adSpendCny;
  const out: WbgFacts = {
    from, to, byNm,
    finRows: fin?.finRows ?? prev?.finRows ?? 0, campaigns: ads?.campaigns ?? prev?.campaigns ?? 0,
    finAt: fin ? Date.now() : prev?.finAt ?? null, adsAt: ads ? Date.now() : prev?.adsAt ?? null,
    acquiringCny: fin?.acquiringCny ?? prev?.acquiringCny ?? 0,
    errors,
  };
  if (errors.length) lastFailAt = Date.now();
  await cacheSet(KEY, out, KEEP_MS);
  console.warn(`[wb-global-facts] ${from}…${to}: строк финотчёта ${out.finRows}, кампаний ${out.campaigns}, товаров ${Object.keys(byNm).length}` +
    (errors.length ? `, ошибки: ${errors.join('; ')}` : ''));
}

/**
 * Последние собранные факты (сразу, без ожидания). Если они старше 12 ч —
 * в фоне запускается новый сбор; после сбоя повтор не раньше чем через час.
 */
export async function getWbGlobalFacts(token: string): Promise<{ facts: WbgFacts | null; refreshing: boolean }> {
  const e = await cacheGet<WbgFacts>(KEY);
  const newest = Math.min(e?.data?.finAt ?? 0, e?.data?.adsAt ?? 0);
  const stale = !e?.data || Date.now() - newest >= REFRESH_MS;
  if (stale && token && !running && Date.now() - lastFailAt >= RETRY_AFTER_FAIL_MS) {
    running = refresh(token)
      .catch(err => { lastFailAt = Date.now(); console.warn('[wb-global-facts] сбор упал:', (err as Error).message); })
      .finally(() => { running = null; });
  }
  return { facts: e?.data ?? null, refreshing: !!running };
}

/** Факты по товару с откатом на среднее по кабинету — то, что пойдёт в калькулятор. */
export function rowFacts(facts: WbgFacts, nmId: number): WbgRowFacts {
  const all = Object.values(facts.byNm);
  const sum = (f: (x: WbgNmFact) => number) => all.reduce((a, x) => a + f(x), 0);
  const S = { sales: sum(x => x.sales), returns: sum(x => x.returns), cancels: sum(x => x.cancels),
    rev: sum(x => x.revenueCny), ad: sum(x => x.adSpendCny) };
  const storeBuyout = S.sales + S.cancels > 0 ? r1(S.sales / (S.sales + S.cancels) * 100) : null;
  const storeDrr = S.rev > 0 ? r1(S.ad / S.rev * 100) : null;
  const f = facts.byNm[String(nmId)] ?? empty();
  const net = f.sales - f.returns;
  // ДРР и логистика — деньги на проданную штуку: хватает и одной выкупленной.
  // Выкуп — доля, по 1–2 продажам он случаен: там нужно ≥ 3.
  const enough = net > 0 && f.revenueCny > 0;
  const per = `${facts.from ?? '?'}…${facts.to ?? '?'}`;

  let drr: WbgFactVal;
  if (enough) drr = { value: r1(f.adSpendCny / f.revenueCny * 100),
    note: f.adSpendCny > 0 ? `факт ${per}: реклама ${r2(f.adSpendCny)} ¥ / выкупы ${r2(f.revenueCny)} ¥ (${net} шт)` : `факт ${per}: рекламы не было` };
  else if (f.adSpendCny === 0) drr = { value: 0, note: `за ${per} рекламы по товару не было` };
  else drr = { value: storeDrr, note: storeDrr != null
    ? `⚠ реклама ${r2(f.adSpendCny)} ¥ за ${per}, а выкупов нет — взят средний ДРР кабинета`
    : 'нет выкупов в финотчёте — ДРР не посчитать' };

  const buyout: WbgFactVal = f.sales >= MIN_SALES
    ? { value: r1(f.sales / (f.sales + f.cancels) * 100), note: `факт ${per}: ${f.sales} выкупов, ${f.cancels} отмен/невыкупов` }
    : { value: storeBuyout, note: storeBuyout != null ? `по товару мало продаж (${f.sales}) — средний выкуп кабинета ${per}` : 'нет данных' };

  const logisticsCny: WbgFactVal = enough
    ? { value: r2(f.deliveryCny / net), note: `факт ${per}: доставки ${r2(f.deliveryCny)} ¥ / ${net} проданных шт (с отменами и возвратами)` }
    : { value: null, note: 'по товару нет выкупов — логистика по тарифу ÷ выкуп' };

  const acquiring: WbgFactVal = S.rev > 0
    ? { value: r2(facts.acquiringCny / S.rev * 100), note: `факт кабинета ${per}: эквайринг ${r2(facts.acquiringCny)} ¥` }
    : { value: null, note: 'нет продаж в финотчёте' };

  return { drr, buyout, logisticsCny, acquiring, sales: f.sales };
}
