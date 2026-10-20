/**
 * Сценарий competitor_watch — Агент 3 «Реклама»: конкуренты и позиции из аналитики
 * кабинетов (14.10.2026). Запросы и форматы — docs/ads-system/КАБИНЕТЫ_ДАННЫЕ_2026-10-14.md.
 *
 * Как ozon_reviews: открываем страницу раздела аналитики в профиле агента и делаем
 * ТЕ ЖЕ запросы чтения, что делает сама страница. Никаких кликов и записей.
 *
 *   WB   «Поисковые запросы: ваши товары» — средняя позиция, показы, CTR, заказы по
 *        каждой нашей карточке (7 дней против прошлых 7) и факторы ранжирования;
 *        «Сравнение карточек» — список наборов «наш товар + конкуренты», лимит и
 *        отчёты (30 дней) по наборам, которые открываются бесплатно (status.available).
 *        Платное открытие (wb_comparisons_month_limit, 130/мес) — когда будет снят
 *        запрос создания сравнения; истёкшие наборы кабинет без списания не отдаёт.
 *        Аналитика WB требует заголовков сессии (authorizev3, seller-lk): берём их
 *        из собственного запроса страницы, держим только в памяти, никуда не пишем.
 *   Ozon «Товары на Ozon» по нашим категориям (топ-50 по выручке за неделю) и
 *        «Конкурентная позиция» (наше место среди продавцов, ближайший конкурент);
 *        тот же отчёт по каждому привязанному конкуренту и нашему товару — фильтр по SKU
 *        без категорий, за 7 и за 28 дней (bySku).
 *   Обе  карточки конкурентов, привязанных к нашим товарам (params.watch — сервер
 *        заполняет при выдаче), и наших товаров (params.ours) на витрине покупателя.
 *
 * Этапы (shared/agents SCENARIO_STAGES.competitor_watch): open_cabinet → collect → ingest
 */
import type { Page } from 'playwright-core';
import { SCENARIO_STAGES, type AgentSettings, type AgentTask } from '../../../shared/agents';
import * as api from '../api';
import { newPage, sleep, randBetween, looksLikeChallenge } from '../chrome';

const STAGES = SCENARIO_STAGES.competitor_watch;
const WB_PAGE = 'https://seller.wildberries.ru/search-analytics/my-search-queries';
const OZ_PAGE = 'https://seller.ozon.ru/app/analytics/what-to-sell/ozon-bestsellers';

function stage(i: number, message: string, extra: Partial<{ items_done: number; items_total: number }> = {}) {
  return { stage: STAGES[i].stage, stage_index: i + 1, stages_total: STAGES.length, message, ...extra };
}

/** Открыть страницу кабинета; false — капча или нет входа (задание уже завершено с паузой площадки). */
async function openCabinet(task: AgentTask, page: Page, url: string, allow: RegExp, mp: 'wb' | 'ozon', settings: AgentSettings): Promise<boolean> {
  await sleep(randBetween(settings.page_pause_ms));
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await sleep(7000);
  const cur = page.url();
  const body = await page.evaluate('document.body ? document.body.innerText.slice(0, 4000) : ""').catch(() => '') as string;
  if (looksLikeChallenge(cur, body)) {
    await api.fail(task.id, { error: `${mp === 'wb' ? 'WB' : 'Ozon'} показал проверку «не робот» — стоп`, retryable: false, pause: { marketplace: mp, reason: 'captcha' } });
    return false;
  }
  if (!allow.test(cur)) {
    await api.fail(task.id, {
      error: `Нет входа в кабинет ${mp === 'wb' ? 'seller.wildberries.ru' : 'seller.ozon.ru'} в профиле агента (открылось ${cur.slice(0, 80)}). Войдите один раз в окне Chrome агента.`,
      retryable: false, pause: { marketplace: mp, reason: 'login_required' },
    });
    return false;
  }
  return true;
}

// Код для page.evaluate — строками: tsx оборачивает вложенные функции в __name(), которой нет в странице.
const WB_COLLECT = (auth: Record<string, string>) => `(async (A) => {
  const H = 'https://seller-content.wildberries.ru/ns/analytics-api/content-analytics/api';
  const j = async (u, body) => {
    const r = await fetch(H + u, { method: body ? 'POST' : 'GET', credentials: 'include', headers: Object.assign({}, A, { 'Content-Type': 'application/json' }), body: body ? JSON.stringify(body) : undefined });
    const t = await r.text();
    let json = null; try { json = JSON.parse(t); } catch (e) {}
    return { status: r.status, json: json, error: r.ok ? null : (u + ' ' + r.status + ' ' + t.slice(0, 120)) };
  };
  const d = n => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
  const errors = [];
  const rep = await j('/v3/search-report/report', { currentPeriod: { start: d(7), end: d(1) }, pastPeriod: { start: d(14), end: d(8) },
    nmIds: [], subjectIds: [], brandNames: [], tagIds: [], orderBy: { field: 'openCard', mode: 'desc' }, positionCluster: 'all',
    includeSubstitutedSKUs: true, includeSearchTexts: true });
  if (rep.error) errors.push(rep.error);
  const data = rep.json && rep.json.data || null;
  const nmIds = [];
  for (const g of (data && data.groups) || []) for (const it of g.items || []) if (it.nmId) nmIds.push(it.nmId);
  let reco = null;
  if (nmIds.length) {
    const r = await j('/v2/search-report/table/recommendations', { currentPeriod: { start: d(7), end: d(1) }, nmIDs: nmIds.slice(0, 200) });
    if (r.error) errors.push(r.error); else reco = r.json && r.json.data && r.json.data.recommendations || null;
  }
  const lim = await j('/v1/competitor-comparison/limits');
  if (lim.error) errors.push(lim.error);
  // История наборов — постранично (по 50): при 50+ товарах наборов больше одной страницы.
  const hist = { json: { data: [] }, error: null };
  for (let off = 0; off < 500; off += 50) {
    const h = await j('/v1/competitor-comparison/history', { orderBy: { field: 'date', mode: 'desc' }, limit: 50, offset: off });
    if (h.error) { errors.push(h.error); break; }
    const page = (h.json && h.json.data) || [];
    hist.json.data.push(...page);
    if (page.length < 50) break;
    await new Promise(r => setTimeout(r, 800 + Math.random() * 700));
  }
  // Отчёты сравнений: только наборы со status.available — их открытие лимит не тратит
  // (проверено 14.10: счётчик comparisonsThisMonth не меняется). Истёкший набор кабинет
  // не отдаёт без списания (RequiresLimitCharge) — такие не трогаем.
  const compDetails = [];
  // Открытый набор живёт 3–4 дня — читаем все открытые за ночь (до 80, ≈2–3 с на набор).
  const sets = ((hist.json && hist.json.data) || []).filter(h => h && h.status && h.status.available).slice(0, 80);
  for (const h of sets) {
    const scope = (h.nms || []).map(n => n.nmID);
    const r = await j('/v4/competitor-comparison/nms/detail', { period: { start: d(29), end: d(0) }, id: h.ID,
      searchQueriesRequest: { limit: 5, offset: 0, orderBy: { field: 'frequency', mode: 'desc', nmID: scope[0] }, scopeNmIDs: scope }, sizeDetails: true });
    const det = r.json && !r.json.error && r.json.data;
    if (!det) { errors.push(r.error || ('сравнение ' + h.date + ': ' + JSON.stringify(r.json && r.json.additionalErrors || '').slice(0, 120))); continue; }
    const c = x => x && typeof x === 'object' ? x.current : x;
    const dy = x => x && typeof x === 'object' ? x.dynamics : null;
    compDetails.push({ id: h.ID, date: h.date,
      nms: (det.commonParams || []).map(p => ({ nmId: p.nmId, name: p.nmName, brand: p.brandName, photo: p.mainPhoto,
        minPrice: p.minPrice, medianPrice: p.medianPrice, rating: p.feedbacksRating, feedbacks: c(p.feedbacksCount),
        avgPos: c(p.avgPosition), avgPosDyn: dy(p.avgPosition), openCard: c(p.openCard), orders: c(p.orders), ordersDyn: dy(p.orders),
        ctr: c(p.CTR), views: c(p.viewCount), buyoutPercent: c(p.buyoutPercent), inAds: !!p.inAdvertising, inPromo: !!(p.promo && p.promo.inPromo) })),
      queries: (det.searchQueries || []).map(q => ({ text: q.text, freq: c(q.frequency) })) });
    await new Promise(r => setTimeout(r, 1500 + Math.random() * 1500));
  }
  // Позиция и воронка каждой нашей карточки за вчера и позавчера — отчёт за один день
  // (для советника по продажам: «позиция упала 6 → 14», 15.10.2026).
  const daily = [];
  for (const n of [1, 2]) {
    const r = await j('/v3/search-report/report', { currentPeriod: { start: d(n), end: d(n) }, pastPeriod: { start: d(n + 1), end: d(n + 1) },
      nmIds: [], subjectIds: [], brandNames: [], tagIds: [], orderBy: { field: 'openCard', mode: 'desc' }, positionCluster: 'all',
      includeSubstitutedSKUs: true, includeSearchTexts: false });
    if (r.error) errors.push(r.error); else daily.push({ date: d(n), report: r.json && r.json.data || null });
    await new Promise(r => setTimeout(r, 1200 + Math.random() * 1000));
  }
  return { period: { start: d(7), end: d(1) }, report: data, recommendations: reco, daily: daily,
    comparisons: { limits: lim.json && lim.json.data || null, history: hist.json && hist.json.data || null }, compDetails: compDetails, errors: errors };
})(${JSON.stringify(auth)})`;

// Карточки WB на витрине пачкой — повтор собственного запроса страницы товара
// (/__internal/card/cards/v4/detail) с нашими номерами. Цены там в копейках.
const WB_CARDS = (url: string, headers: Record<string, string>, ids: number[]) => `(async (U, H, IDS) => {
  const out = [], errors = [], asked = [];
  for (let i = 0; i < IDS.length; i += 40) {
    const u = U.replace(/([?&])nm=[^&]*/, '$1nm=' + IDS.slice(i, i + 40).join(';'));
    try {
      const r = await fetch(u, { credentials: 'include', headers: H });
      if (!r.ok) { errors.push('витрина WB ' + r.status); continue; }
      const j = await r.json();
      asked.push(...IDS.slice(i, i + 40));
      for (const p of (j.products || (j.data && j.data.products) || [])) {
        const sz = (p.sizes || []).find(s => s.price) || {};
        out.push({ id: p.id, name: p.name, brand: p.brand, supplier: p.supplier, rating: p.reviewRating, feedbacks: p.feedbacks,
          price: sz.price ? Math.round(sz.price.product / 100) : null, basic: sz.price ? Math.round(sz.price.basic / 100) : null, qty: p.totalQuantity });
      }
    } catch (e) { errors.push('витрина WB: ' + e.message); }
    await new Promise(r => setTimeout(r, 1500 + Math.random() * 1000));
  }
  // Номера из ответивших пачек, которых витрина не вернула, — карточка покупателю не показывается
  // (скрыта, заблокирована или недоступна для адреса доставки браузера агента).
  const got = new Set(out.map(c => Number(c.id)));
  return { cards: out, errors: errors, notShown: asked.filter(id => !got.has(Number(id))) };
})(${JSON.stringify(url)}, ${JSON.stringify(headers)}, ${JSON.stringify(ids)})`;

/** WB: открыть страницу первого товара на витрине, взять заголовки её запроса карточки и снять все номера. */
async function wbShowcaseCards(page: Page, ids: number[]): Promise<{ cards: any[]; errors: string[]; notShown?: number[] }> {
  if (!ids.length) return { cards: [], errors: [] };
  let req: { url: string; headers: Record<string, string> } | null = null;
  page.on('request', rq => {
    if (req || !/__internal\/card\/cards\/v4\/detail/.test(rq.url())) return;
    void rq.allHeaders().then(h => {
      if (req) return;
      const keep: Record<string, string> = {};
      for (const [k, v] of Object.entries(h)) if (!/^(:|host|cookie|content-length|accept-encoding|connection|sec-|user-agent|referer)/i.test(k)) keep[k] = v;
      req = { url: rq.url(), headers: keep };
    }).catch(() => {});
  });
  await page.goto(`https://www.wildberries.ru/catalog/${ids[0]}/detail.aspx`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  for (let i = 0; i < 15 && !req; i++) await sleep(1000);
  if (!req) return { cards: [], errors: ['витрина WB не сделала запрос карточки — карточки конкурентов не сняты'] };
  const r = req as { url: string; headers: Record<string, string> };
  return await page.evaluate(WB_CARDS(r.url, r.headers, ids)) as { cards: any[]; errors: string[]; notShown: number[] };
}

/** Ozon: карточки по SKU через страничный API витрины (как у покупателя). Цены — строки «1 528 ₽». */
async function ozonShowcaseCards(page: Page, ids: number[], settings: AgentSettings): Promise<{ cards: any[]; errors: string[]; notShown: number[] }> {
  const cards: any[] = [], errors: string[] = [], notShown: number[] = [];
  const rub = (s: unknown) => { const n = Number(String(s ?? '').replace(/[^\d,.]/g, '').replace(',', '.')); return Number.isFinite(n) && n > 0 ? Math.round(n) : null; };
  const pick = (ws: Record<string, string>, re: RegExp): any => {
    const k = Object.keys(ws).find(x => re.test(x));
    if (!k) return null;
    try { return JSON.parse(ws[k]); } catch { return null; }
  };
  for (const sku of ids) {
    try {
      const r = await page.context().request.get(`https://www.ozon.ru/api/entrypoint-api.bx/page/json/v2?url=${encodeURIComponent(`/product/${sku}/`)}`, { timeout: 30_000 });
      // 404 — товара нет на витрине (скрыт, снят с продажи или не продаётся в регионе браузера агента)
      if (r.status() === 404) { notShown.push(sku); continue; }
      if (!r.ok()) { errors.push(`витрина Ozon ${sku}: ${r.status()}`); if (r.status() === 403 || r.status() === 429) break; continue; }
      const j: any = await r.json();
      const ws: Record<string, string> = j?.widgetStates ?? {};
      const price = pick(ws, /^webPrice-/), head = pick(ws, /^webProductHeading-/), score = pick(ws, /^webReviewProductScore-/),
        sticky = pick(ws, /^webStickyProducts-/), sale = pick(ws, /^webSale-/);
      // Страница ответила, но без заголовка и цены товара — вместо карточки «товар не найден» или подборка.
      if (!head && !price && !sticky) { notShown.push(sku); continue; }
      cards.push({
        id: sku, name: head?.title ?? sticky?.name ?? '', seller: sticky?.seller?.name ?? '', photo: sticky?.coverImageUrl ?? '',
        price: rub(price?.cardPrice) ?? rub(price?.price), priceNoCard: rub(price?.price), originalPrice: rub(price?.originalPrice),
        rating: score?.totalScore ?? null, reviews: score?.reviewsCount ?? null, available: price?.isAvailable ?? sale?.offer?.isAvailable ?? null,
      });
    } catch (e) { errors.push(`витрина Ozon ${sku}: ${(e as Error).message.slice(0, 80)}`); }
    await sleep(randBetween(settings.page_pause_ms));
  }
  return { cards, errors, notShown };
}

const OZ_COLLECT = (companyId: string, ourCats: string[]) => `(async (CID, OUR) => {
  const HD = { 'Content-Type': 'application/json', 'x-o3-app-name': 'seller-ui', 'x-o3-company-id': CID, 'x-o3-language': 'ru' };
  const j = async (u, body) => {
    const r = await fetch(u, { method: 'POST', credentials: 'include', headers: HD, body: JSON.stringify(body) });
    const t = await r.text();
    let json = null; try { json = JSON.parse(t); } catch (e) {}
    return { status: r.status, json: json, error: r.ok ? null : (u.replace(/^https:\\/\\/[^/]+/, '') + ' ' + r.status + ' ' + t.slice(0, 120)) };
  };
  const errors = [];
  // Категории — типы наших товаров по выручке (даёт сервер). get_categories кабинета
  // возвращает сохранённый фильтр страницы, а не ассортимент, — только запасной вариант.
  let cats = OUR.slice(0, 8);
  if (!cats.length) {
    const c = await j('/api/site/seller-analytics/what_to_sell/get_categories', { seller_id: CID });
    if (c.error) errors.push(c.error);
    cats = (c.json && c.json.categoryIds || []).slice(0, 8);
  }
  const markets = [];
  for (const cat of cats) {
    const w = await j('https://api.seller.ozon.ru/api/site/seller-analytics/what_to_sell/data/v3',
      { limit: '50', offset: '0', filter: { stock: 'any_stock', period: 'weekly', categories: [cat] }, sort: { key: 'sum_gmv_desc' } });
    if (w.error) { errors.push(w.error); continue; }
    markets.push({ category3Id: cat, items: w.json && w.json.items || [], benchmark: w.json && w.json.benchmark || null, updateDate: w.json && w.json.updateDate || null });
    await new Promise(r => setTimeout(r, 1500 + Math.random() * 1500));
  }
  const c2 = [];
  for (const m of markets) for (const it of m.items) if (it.category2Id && c2.indexOf(it.category2Id) < 0) { c2.push(it.category2Id); break; }
  const d = n => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10) + 'T00:00:00Z';
  const positions = [];
  for (const id of c2.slice(0, 6)) {
    const body = { date_from: d(28), date_to: d(1), filter: { category: { level: '2', id: id } }, group_by: 'day', metric: 'revenue' };
    const p = await j('/api/site/analytics-competitive-pos/analytics/competitive_position', body);
    const ch = await j('/api/site/analytics-competitive-pos/analytics/competitive_position/chart_revenue', body);
    if (p.error) errors.push(p.error);
    if (ch.error) errors.push(ch.error);
    positions.push({ category2Id: id, days: p.json && p.json.data || [], chart: ch.json && ch.json.data || null });
    await new Promise(r => setTimeout(r, 1000 + Math.random() * 1000));
  }
  return { categories: cats, markets: markets, positions: positions, errors: errors };
})(${JSON.stringify(companyId)}, ${JSON.stringify(ourCats)})`;

// «Товары на Ozon» по конкретным SKU — как поле «Название или SKU» на странице (20.10.2026).
// Несколько SKU через пробел страница шлёт как текст поиска (filter.name) — так и делаем,
// пачками по 10: проверено, 92 конкурента → 84 найдено за 10 запросов. Поиск по тексту иногда
// теряет карточку, поэтому ненайденные добираем по одной (filter.sku — одно число; список
// через запятую или пробел в sku кабинет обрезает до первого, 100+ SKU в name → 404).
const OZ_BY_SKU = (companyId: string, skus: number[]) => `(async (CID, SKUS) => {
  const HD = { 'Content-Type': 'application/json', 'x-o3-app-name': 'seller-ui', 'x-o3-company-id': CID, 'x-o3-language': 'ru' };
  const out = { weekly: [], monthly: [] }, errors = [];
  let stop = false;
  const ask = async (filter) => {
    const r = await fetch('https://api.seller.ozon.ru/api/site/seller-analytics/what_to_sell/data/v3', { method: 'POST', credentials: 'include', headers: HD,
      body: JSON.stringify({ limit: '50', offset: '0', filter: filter, sort: { key: 'sum_gmv_desc' } }) });
    await new Promise(r => setTimeout(r, 1000 + Math.random() * 800));
    if (r.status === 404) return [];
    if (!r.ok) {
      errors.push('товары Ozon по SKU: ' + r.status);
      if (r.status === 429 || r.status === 403) stop = true;
      return [];
    }
    let j = null; try { j = await r.json(); } catch (e) {}
    return (j && j.items) || [];
  };
  for (const period of ['weekly', 'monthly']) {
    const got = new Map();
    for (let i = 0; i < SKUS.length && !stop; i += 10) {
      const part = SKUS.slice(i, i + 10).map(String);
      for (const x of await ask({ stock: 'any_stock', period: period, name: part.join(' ') })) if (part.indexOf(String(x.sku)) >= 0) got.set(String(x.sku), x);
    }
    for (const s of SKUS.map(String)) {
      if (stop) break;
      if (got.has(s)) continue;
      const x = (await ask({ stock: 'any_stock', period: period, sku: s })).find(x => String(x.sku) === s);
      if (x) got.set(s, x);
    }
    out[period] = [...got.values()];
  }
  return { bySku: out, errors: errors };
})(${JSON.stringify(companyId)}, ${JSON.stringify(skus)})`;

export async function runCompetitorWatch(task: AgentTask, settings: AgentSettings): Promise<void> {
  const mp = task.params.marketplace === 'ozon' ? 'ozon' : 'wb';
  const page = await newPage();
  try {
    const light = !!task.params.light;
    let data: any;
    if (light) {
      // Быстрый проход днём / по кнопке: аналитику кабинета не открываем, только витрина.
      await api.progress(task.id, stage(0, 'Быстрое обновление: только карточки на витрине'), true);
      data = { light: true, errors: [] };
    } else if (mp === 'wb') {
      await api.progress(task.id, stage(0, 'Открываю аналитику кабинета WB'), true);
      // Заголовки сессии аналитики — из собственного запроса страницы.
      let auth: Record<string, string> | null = null;
      page.on('request', rq => {
        if (auth || !/analytics-api/.test(rq.url())) return;
        void rq.allHeaders().then(h => {
          if (!auth && h.authorizev3) auth = { authorizev3: h.authorizev3, 'seller-lk': h['seller-lk'] ?? '', 'root-version': h['root-version'] ?? '' };
        }).catch(() => {});
      });
      if (!await openCabinet(task, page, WB_PAGE, /^https:\/\/seller\.wildberries\.ru\//, 'wb', settings)) return;
      for (let i = 0; i < 10 && !auth; i++) await sleep(1000);
      if (!auth) { await api.fail(task.id, { error: 'страница аналитики WB не сделала запрос — нет заголовков сессии', retryable: true }); return; }
      await api.progress(task.id, stage(1, 'Позиции по запросам и сравнения карточек'), true);
      data = await page.evaluate(WB_COLLECT(auth));
      const items = (data?.report?.groups ?? []).reduce((s: number, g: any) => s + (g.items?.length ?? 0), 0);
      await api.progress(task.id, stage(1, `Карточек с позициями: ${items}, наборов сравнения: ${data?.comparisons?.history?.length ?? 0}`, { items_done: items, items_total: items }), true);
    } else {
      await api.progress(task.id, stage(0, 'Открываю аналитику кабинета Ozon'), true);
      if (!await openCabinet(task, page, OZ_PAGE, /^https:\/\/seller\.ozon\.ru\/app\//, 'ozon', settings)) return;
      const cid = String(task.params.company_id || '');
      if (!cid) { await api.fail(task.id, { error: 'сервер не передал company_id Ozon', retryable: false }); return; }
      await api.progress(task.id, stage(1, 'Товары на Ozon по нашим категориям и конкурентная позиция'), true);
      const cats = Array.isArray(task.params.categories) ? task.params.categories.map(String) : [];
      data = await page.evaluate(OZ_COLLECT(cid, cats));
      const items = (data?.markets ?? []).reduce((s: number, m: any) => s + (m.items?.length ?? 0), 0);
      await api.progress(task.id, stage(1, `Категорий ${data?.markets?.length ?? 0}, товаров рынка ${items}`, { items_done: items, items_total: items }), true);
      // Продажи, выручка, корзина, ДРР, акции по каждому привязанному конкуренту и нашему товару.
      const skus = [...new Set([...(task.params.watch as number[] ?? []), ...(task.params.ours as number[] ?? [])].map(Number).filter(n => n > 0))].slice(0, 700);
      if (skus.length) {
        await api.progress(task.id, stage(1, `Продажи по артикулам: ${skus.length} шт., за 7 и 28 дней`), true);
        const r: any = await page.evaluate(OZ_BY_SKU(cid, skus));
        data.bySku = r?.bySku ?? null;
        data.errors = [...(data.errors ?? []), ...((r?.errors ?? []) as string[]).slice(0, 5)];
        await api.progress(task.id, stage(1, `Продажи по артикулам: найдено ${data.bySku?.weekly?.length ?? 0} из ${skus.length}`, { items_done: data.bySku?.weekly?.length ?? 0, items_total: skus.length }), true);
      }
    }
    // Карточки привязанных конкурентов и наших товаров на витрине (цена, рейтинг, отзывы, остаток).
    const ids = [...new Set([...(task.params.ours as number[] ?? []), ...(task.params.watch as number[] ?? [])].map(Number).filter(n => n > 0))]
      .slice(0, 700);
    if (light && !ids.length) { await api.complete(task.id, 'Быстрое обновление: привязанных конкурентов нет'); return; }
    if (data && ids.length) {
      await api.progress(task.id, stage(1, `Карточки конкурентов на витрине: ${ids.length}`), true);
      const sc = mp === 'wb' ? await wbShowcaseCards(page, ids) : await ozonShowcaseCards(page, ids, settings);
      data.cards = sc.cards;
      data.notShown = sc.notShown ?? [];
      data.errors = [...(data.errors ?? []), ...sc.errors.slice(0, 5)];
      await api.progress(task.id, stage(1, `Карточек снято: ${sc.cards.length} из ${ids.length}${sc.notShown?.length ? `, не видны на витрине: ${sc.notShown.length}` : ''}`, { items_done: sc.cards.length, items_total: ids.length }), true);
    }
    for (const e of (data?.errors ?? []).slice(0, 5)) await api.log(task.id, 'warn', `кабинет ответил ошибкой: ${String(e).slice(0, 200)}`);

    await api.progress(task.id, stage(2, 'Отправляю в дашборд'), true);
    const r = await api.competitorsIngest(mp, data);
    if (!r) { await api.fail(task.id, { error: 'дашборд не принял данные конкурентов', retryable: true }); return; }
    const errs = data?.errors?.length ?? 0;
    await api.complete(task.id, `${r}${errs ? ` · ошибок кабинета: ${errs}` : ''}`);
  } finally {
    await page.close().catch(() => {});
  }
}
