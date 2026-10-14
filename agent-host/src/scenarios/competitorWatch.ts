/**
 * Сценарий competitor_watch — Агент 3 «Реклама»: конкуренты и позиции из аналитики
 * кабинетов (14.10.2026). Запросы и форматы — docs/ads-system/КАБИНЕТЫ_ДАННЫЕ_2026-10-14.md.
 *
 * Как ozon_reviews: открываем страницу раздела аналитики в профиле агента и делаем
 * ТЕ ЖЕ запросы чтения, что делает сама страница. Никаких кликов и записей.
 *
 *   WB   «Поисковые запросы: ваши товары» — средняя позиция, показы, CTR, заказы по
 *        каждой нашей карточке (7 дней против прошлых 7) и факторы ранжирования;
 *        «Сравнение карточек» — список наборов «наш товар + конкуренты» и лимит.
 *        Отчёты сравнений пока не открываем: платное открытие — по лимиту владельца
 *        (wb_comparisons_month_limit), формат запроса ещё не снят.
 *        Аналитика WB требует заголовков сессии (authorizev3, seller-lk): берём их
 *        из собственного запроса страницы, держим только в памяти, никуда не пишем.
 *   Ozon «Товары на Ozon» по нашим категориям (топ-50 по выручке за неделю) и
 *        «Конкурентная позиция» (наше место среди продавцов, ближайший конкурент).
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
  const hist = await j('/v1/competitor-comparison/history', { orderBy: { field: 'date', mode: 'desc' }, limit: 50, offset: 0 });
  if (hist.error) errors.push(hist.error);
  return { period: { start: d(7), end: d(1) }, report: data, recommendations: reco,
    comparisons: { limits: lim.json && lim.json.data || null, history: hist.json && hist.json.data || null }, errors: errors };
})(${JSON.stringify(auth)})`;

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

export async function runCompetitorWatch(task: AgentTask, settings: AgentSettings): Promise<void> {
  const mp = task.params.marketplace === 'ozon' ? 'ozon' : 'wb';
  const page = await newPage();
  try {
    await api.progress(task.id, stage(0, `Открываю аналитику кабинета ${mp === 'wb' ? 'WB' : 'Ozon'}`), true);
    let data: any;
    if (mp === 'wb') {
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
      if (!await openCabinet(task, page, OZ_PAGE, /^https:\/\/seller\.ozon\.ru\/app\//, 'ozon', settings)) return;
      const cid = String(task.params.company_id || '');
      if (!cid) { await api.fail(task.id, { error: 'сервер не передал company_id Ozon', retryable: false }); return; }
      await api.progress(task.id, stage(1, 'Товары на Ozon по нашим категориям и конкурентная позиция'), true);
      const cats = Array.isArray(task.params.categories) ? task.params.categories.map(String) : [];
      data = await page.evaluate(OZ_COLLECT(cid, cats));
      const items = (data?.markets ?? []).reduce((s: number, m: any) => s + (m.items?.length ?? 0), 0);
      await api.progress(task.id, stage(1, `Категорий ${data?.markets?.length ?? 0}, товаров рынка ${items}`, { items_done: items, items_total: items }), true);
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
