/**
 * Фоновый сборщик данных (`/api/cron/refresh`).
 *
 * Раньше жил внутри api/route.ts и занимал там треть файла: диспетчер запросов и
 * сборщик — разные вещи с разным темпом изменений, и держать их вместе мешало
 * читать оба. Здесь только прогрев кэша, наружу торчит один handleCron.
 *
 * Что делает: ходит в WB и Ozon по списку целей, складывает ответы в кэш под теми
 * же ключами, которые строит браузер, и отдельно догревает тяжёлые вещи —
 * каталог карточек и цены WB (постранично), статистику рекламы WB, воронку,
 * BI, удержания, рекламу Ozon по SKU и цены конкурентов.
 *
 * Главные правила, выведенные из аварий, расписаны по месту в комментариях ниже:
 * ключ кэша обязан совпадать с браузерным байт-в-байт; лимит WB считается на весь
 * кабинет, поэтому поймав 429 не долбим остальные окна того же хоста; цепочка
 * дополнительных прогревов идёт ОДНА и после основной отдачи.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { wbUpstream, ozonUpstream } from '../_proxy';
import { fetchWithRetry } from './fetchRetry';
import { cacheGet, cacheSet, makeCacheKey, makeUpstreamCacheKey, needsRefresh } from './cache';
import { getWbTransit } from './wbTransit';
import { getWbSupplies } from './wbSuppliesLog';
import { getWbBuyerPrices } from './wbBuyerPrices';
import { getOzonBuyerPrices } from './ozonBuyerPrices';
import { getWbCommissions } from './wbCommissions';
import { getOzonFactProfit } from './ozonFactProfit';
import { getWbBoxTariffs } from './wbBoxTariffs';

import { getWbStock } from './wbStock';
import { getWbCardEcon } from './wbCardEcon';
import { warmWbFunnelViaReport } from './wbFunnelReport';
import { refreshUsdRate } from './aiUsage';
import { buildSnapshot } from './aiContext';
import { recordDailySnapshot } from './history';
import { competitorSearch } from './competitors';
import { mskDate, mskIso } from './mskDate';
import { REFRESH_LIVE_MS } from './cronSchedule';
import { wbFunnelBody, ozAnalyticsBody } from './period';
import { noteSwallowed } from './log';

// Cooldown сборщика: после неудачи (429/ошибка) не повторяем тот же запрос
// раньше времени — чтобы ежечасный cron не выжигал суточный лимит WB ретраями.
const cronCooldownUntil = new Map<string, number>();

// ────────────────────────────────────────────────────────────────────────────
// Cron (inlined из api/cron/refresh.ts)
// ────────────────────────────────────────────────────────────────────────────
// Идёт ли сейчас цепочка дополнительных прогревов (BI / удержания / реклама по SKU).
// Крон вызывается каждые 2 часа, а цепочка может идти дольше — без флага они
// накладываются друг на друга и душат сервер.
let extrasWarming = false;

export async function handleCron(req: VercelRequest, res: VercelResponse) {
  // path парсим из query.p, action = второй сегмент
  const pStr = Array.isArray(req.query.p) ? req.query.p.join('/') : String(req.query.p ?? '');
  const action = pStr.split('/').filter(Boolean)[1];
  if (action !== 'refresh') return res.status(404).json({ error: 'cron_action_not_found' });

  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.authorization;
    const ok = auth === `Bearer ${secret}` || req.query.secret === secret;
    if (!ok) return res.status(401).json({ error: 'unauthorized' });
  }

  // Даты окон — ПО МОСКВЕ (mskDate). Раньше здесь был UTC: с 00:00 до 03:00 МСК
  // iso(0) давал вчерашнюю дату, сборщик грел окно «по вчера», а клиент в кабинете
  // видел сегодняшний день — отсюда «у вас 122 тысячи, а на ВБ 158» (телемост 11.08).
  const iso = (back: number) => mskDate(back);
  const isoT = (back: number) => mskIso(back);
  // TTL подобраны под лимиты WB: чем реже можно дёргать — тем дольше держим
  // кэш (тогда ежечасный cron пропускает свежее и не жжёт квоту).
  const TTL_DAY   = 24 * 60 * 60_000;  // seller-info: 1/24ч
  const TTL_12H   = 12 * 60 * 60_000;  // reportDetailByPeriod: 2/24ч
  const TTL_3H    = 3 * 60 * 60_000;   // аналитика/цены/отзывы/реклама
  const TTL_OZON  = 90 * 60_000;       // Ozon мягче

  // Порог обновления «живых» датасетов — из _lib/cronSchedule (там же интервал
  // прохода). Отдельно от TTL: TTL говорит, сколько данные ещё можно показывать,
  // а этот порог — когда идти за новыми.

  // Тело sales-funnel — байт-в-байт как у фронта (marketplaces.ts wbNmReport),
  // чтобы ключ кэша совпал. `back` — ДЛИНА окна в сутках, включая сегодня, поэтому
  // start = iso(back − 1). Раньше здесь было iso(back): ключ описывал окно на сутки
  // длиннее, чем сборщик реально запрашивал у WB (warmWbFunnelViaReport берёт
  // startBack = back − 1). Расхождение было безобидным, пока браузер только читал
  // кэш, но ручное обновление шлёт это тело в WB напрямую.
  // Тела запросов, из которых строятся ключи кэша, — в _lib/period, рядом с
  // самими окнами: их строит не только сборщик, но и читатели прогретого.
  const funnel = wbFunnelBody;
  const ozAnalytics = ozAnalyticsBody;

  type T = { upstream: any; path: string; method?: 'GET' | 'POST'; body?: any; ns: string; ttl: number; cool: number };
  const C_WB = 6 * 60 * 60_000;  // cooldown после неудачи для тяжёлых WB-хостов
  const C_LT = 60 * 60_000;      // cooldown для лёгких
  const targets: T[] = [
    // ── WB (cron-only: единственный источник для браузера) ──
    { upstream: wbUpstream('common'),     path: 'api/v1/seller-info',                              ns: 'wb:common',     ttl: TTL_DAY, cool: C_WB },
    // content/v2/get/cards/list греется ОТДЕЛЬНО (см. ниже): каталог надо листать
    // курсором, а здешний цикл делает ровно один запрос на цель.
    // ?limit=1000 греется ОТДЕЛЬНО (см. ниже): список листается offset-ом, а
    // здешний цикл делает ровно один запрос на цель.
    { upstream: wbUpstream('discounts'),  path: 'api/v2/list/goods/filter?limit=100',              ns: 'wb:discounts',  ttl: TTL_3H,  cool: C_LT }, // фолбэк-ключ, если limit=1000 не примется
    { upstream: wbUpstream('promotion'),  path: 'adv/v1/balance',                                  ns: 'wb:promotion',  ttl: TTL_3H,  cool: C_LT },
    { upstream: wbUpstream('promotion'),  path: 'adv/v1/promotion/count',                          ns: 'wb:promotion',  ttl: TTL_3H,  cool: C_LT },
    { upstream: wbUpstream('feedbacks'),  path: 'api/v1/feedbacks?isAnswered=false&take=50&skip=0',ns: 'wb:feedbacks',  ttl: TTL_3H,  cool: C_LT },
    { upstream: wbUpstream('feedbacks'),  path: 'api/v1/feedbacks?isAnswered=true&take=50&skip=0', ns: 'wb:feedbacks',  ttl: TTL_3H,  cool: C_LT },
    { upstream: wbUpstream('feedbacks'),  path: 'api/v1/feedbacks/count',                          ns: 'wb:feedbacks',  ttl: TTL_3H,  cool: C_LT },
    // Вопросы о товаре WB (тот же feedbacks-хост).
    { upstream: wbUpstream('feedbacks'),  path: 'api/v1/questions?isAnswered=false&take=50&skip=0', ns: 'wb:feedbacks',  ttl: TTL_3H,  cool: C_LT },
    { upstream: wbUpstream('feedbacks'),  path: 'api/v1/questions/count',                           ns: 'wb:feedbacks',  ttl: TTL_3H,  cool: C_LT },
    // WB Sales Funnel — ПРОГРЕВАЕТСЯ АСИНХРОННЫМ ОТЧЁТОМ (warmWbFunnelViaReport
    // ниже), а не синхронным методом: у синхронного корзина 1 запрос/~2 мин на
    // ВЕСЬ кабинет (делится с 10x), отчёт же — 2-3 запроса на все окна сразу.
    // Поставки на склад WB (incomes/supplies на statistics-api) — УДАЛЕНЫ из WB API
    // в июне 2026 (в актуальной спецификации 12-reports.yaml путей нет). Target
    // убран: он жёг квоту statistics-хоста запросом в мёртвый эндпоинт. Актуальные
    // поставки FBW идут через supplies-api (см. api/_lib/wbTransit.ts).
    // Fallback statistics (выкупы/заказы) — основной рабочий источник WB.
    // Окно 30 дней — фронт фильтрует по периоду (день/неделя/месяц) на клиенте,
    // поэтому достаточно одного широкого датасета (не плодим окна, бережём лимит).
    { upstream: wbUpstream('statistics'), path: `api/v1/supplier/sales?dateFrom=${iso(30)}`,       ns: 'wb:statistics', ttl: TTL_12H, cool: C_LT },
    { upstream: wbUpstream('statistics'), path: `api/v1/supplier/orders?dateFrom=${iso(30)}`,      ns: 'wb:statistics', ttl: TTL_12H, cool: C_LT },
    // WB Финансовый отчёт — рубль-в-рубль. Только за месяц (отчёт недельный).
    // Фронт (useFinanceSummary) тоже просит месячное окно → ключи совпадают.
    // 07.2026: мигрировано на finance-api (старый v5 reportDetailByPeriod
    // удаляется 15.07.2026). Лимит нового метода: 1/мин, burst 1.
    { upstream: wbUpstream('finance'), path: 'api/finance/v1/sales-reports/detailed', method: 'POST',
      body: { dateFrom: iso(30), dateTo: iso(0), limit: 100000, rrdId: 0, period: 'weekly' },
                                                                                                   ns: 'wb:finance', ttl: TTL_12H, cool: C_WB },

    // ── Ozon Seller (SWR: cron лишь прогревает, браузер сам дотянет при промахе) ──
    { upstream: ozonUpstream(), path: 'v3/product/list', method: 'POST', body: { filter: { visibility: 'ALL' }, last_id: '', limit: 1 }, ns: 'ozon-seller', ttl: TTL_OZON, cool: C_LT },
    { upstream: ozonUpstream(), path: 'v1/analytics/data', method: 'POST', body: ozAnalytics(1,  ['ordered_units','revenue'], ['day'], 1000), ns: 'ozon-seller', ttl: TTL_OZON, cool: C_LT },
    { upstream: ozonUpstream(), path: 'v1/analytics/data', method: 'POST', body: ozAnalytics(7,  ['ordered_units','revenue'], ['day'], 1000), ns: 'ozon-seller', ttl: TTL_OZON, cool: C_LT },
    { upstream: ozonUpstream(), path: 'v1/analytics/data', method: 'POST', body: ozAnalytics(30, ['ordered_units','revenue'], ['day'], 1000), ns: 'ozon-seller', ttl: TTL_OZON, cool: C_LT },
    { upstream: ozonUpstream(), path: 'v1/analytics/data', method: 'POST', body: ozAnalytics(7,  ['ordered_units','revenue'], ['sku'], 200), ns: 'ozon-seller', ttl: TTL_OZON, cool: C_LT },
    { upstream: ozonUpstream(), path: 'v1/analytics/data', method: 'POST', body: ozAnalytics(30, ['ordered_units','revenue'], ['sku'], 300), ns: 'ozon-seller', ttl: TTL_OZON, cool: C_LT },
    { upstream: ozonUpstream(), path: 'v3/finance/transaction/totals', method: 'POST', body: { date: { from: isoT(7),  to: isoT(0) }, posting_number: '', transaction_type: 'all' }, ns: 'ozon-seller', ttl: TTL_OZON, cool: C_LT },
    { upstream: ozonUpstream(), path: 'v3/finance/transaction/totals', method: 'POST', body: { date: { from: isoT(30), to: isoT(0) }, posting_number: '', transaction_type: 'all' }, ns: 'ozon-seller', ttl: TTL_OZON, cool: C_LT },
    { upstream: ozonUpstream(), path: 'v3/finance/transaction/list', method: 'POST', body: { filter: { date: { from: isoT(7), to: isoT(0) }, operation_type: [], posting_number: '', transaction_type: 'all' }, page: 1, page_size: 1000 }, ns: 'ozon-seller', ttl: TTL_OZON, cool: C_LT },
    // v5/product/info/prices греется ОТДЕЛЬНО (см. ниже): список листается
    // курсором, а здешний цикл делает ровно один запрос на цель.
    { upstream: ozonUpstream(), path: 'v4/product/info/stocks', method: 'POST', body: { filter: { visibility: 'ALL' }, limit: 100 }, ns: 'ozon-seller', ttl: TTL_OZON, cool: C_LT },
  ];

  // Cron-warmer: троттл per-host. У WB seller-analytics-api и statistics-api
  // независимые anti-burst auth-gateway'и ~1 req/min на токен. Прогрев идёт
  // раз в сутки, чтобы не жечь лимит лишними пингами.
  // Очередь идёт параллельно по хостам, но последовательно внутри одного хоста.
  const HOST_DELAYS_MS: Record<string, number> = {
    'seller-analytics-api.wildberries.ru': 65_000,
    'statistics-api.wildberries.ru':        65_000,
    // остальные хосты — без отдельного троттла
  };
  const DEFAULT_HOST_DELAY_MS = 500;
  const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
  const hostOf = (url: string) => { try { return new URL(url).host; } catch { return url; } };

  // Группируем targets по хосту и запускаем параллельные очереди (по очереди внутри каждой)
  const byHost = new Map<string, typeof targets>();
  for (const t of targets) {
    const h = hostOf(t.upstream.base);
    const arr = byHost.get(h) ?? [];
    arr.push(t);
    byHost.set(h, arr);
  }

  const force = req.query.force === '1';
  const results: { ns: string; path: string; status: number; ms: number; ok: boolean; skipped?: string }[] = [];
  const runHostQueue = async (host: string, hostTargets: typeof targets) => {
    const hostDelay = HOST_DELAYS_MS[host] ?? DEFAULT_HOST_DELAY_MS;
    let fetchedOnHost = false; // выдерживаем паузу только между РЕАЛЬНЫМИ запросами
    for (const t of hostTargets) {
      const method = t.method ?? 'GET';
      const headers: Record<string, string> = { ...t.upstream.headers };
      let body: string | undefined;
      if (t.body) { body = JSON.stringify(t.body); headers['Content-Type'] = 'application/json'; }
      const pathOnly = t.path.split('?')[0];
      const qs = t.path.includes('?') ? '?' + t.path.split('?')[1] : '';
      const key = makeUpstreamCacheKey(t.ns, method, pathOnly, qs, body);

      // 1) обновлять пока рано → не дёргаем апстрим (бережём лимит)
      // Порог зависит от природы TTL. У «живых» датасетов (≤3ч: цены, отзывы,
      // реклама, аналитика) TTL — это лишь окно показа, и обновлять их надо в такт
      // крону, иначе обновление проскакивает через раз и данные стареют вдвое
      // дольше. У тяжёлых (12ч, сутки) TTL — это бюджет квоты WB, его не трогаем.
      const refreshAfter = t.ttl <= TTL_3H ? Math.min(t.ttl, REFRESH_LIVE_MS) : t.ttl;
      if (!force) {
        const cached = await cacheGet<{ status: number }>(key);
        if (!needsRefresh(cached, refreshAfter)) { results.push({ ns: t.ns, path: t.path, status: cached!.data.status, ms: 0, ok: true, skipped: 'fresh' }); continue; }
        // 2) в cooldown после недавней неудачи → пропускаем
        const until = cronCooldownUntil.get(key) ?? 0;
        if (Date.now() < until) { results.push({ ns: t.ns, path: t.path, status: 0, ms: 0, ok: false, skipped: 'cooldown' }); continue; }
      }

      if (fetchedOnHost) await sleep(hostDelay);
      fetchedOnHost = true;
      const t0 = Date.now();
      try {
        // maxRetries:2 — fetchWithRetry уважает X-Ratelimit-Retry WB (напр. 37с
        // у аналитики, корзина=1). Двух попыток хватает переждать окно и забрать
        // данные тем же проходом, не откладывая на следующий cron.
        const r = await fetchWithRetry(`${t.upstream.base}/${t.path}`, { method, headers, body }, { maxRetries: 2 });
        const text = await r.text();
        if (r.ok) {
          await cacheSet(key, { status: r.status, ct: r.headers.get('content-type') ?? 'application/json', text }, t.ttl);
          cronCooldownUntil.delete(key);
        } else {
          // 429/4xx/5xx — ставим cooldown, чтобы не долбить лимит каждый час
          cronCooldownUntil.set(key, Date.now() + t.cool);
        }
        results.push({ ns: t.ns, path: t.path, status: r.status, ms: Date.now() - t0, ok: r.ok });
        // 429 на тяжёлых WB-методах считается на ВЕСЬ кабинет (per seller) и при
        // повторных тычках растёт (37с → 11–22 мин). Поэтому, поймав 429, не долбим
        // остальные окна этого же хоста — иначе сами раздуваем штраф. Остальные
        // цели хоста помечаем cooldown и берём следующим проходом.
        if (r.status === 429) {
          for (const rest of hostTargets) {
            if (rest === t) continue;
            const rk = makeUpstreamCacheKey(rest.ns, rest.method ?? 'GET',
              rest.path.split('?')[0], rest.path.includes('?') ? '?' + rest.path.split('?')[1] : '',
              rest.body ? JSON.stringify(rest.body) : undefined);
            cronCooldownUntil.set(rk, Date.now() + rest.cool);
          }
          break;
        }
      } catch {
        cronCooldownUntil.set(key, Date.now() + t.cool);
        results.push({ ns: t.ns, path: t.path, status: 0, ms: Date.now() - t0, ok: false });
      }
    }
  };

  // Глобальный лимитер кабинета WB («global limiter, per seller») вышибается ЗАЛПОМ,
  // если бить во все WB-хосты разом. Поэтому тяжёлые критичные методы (аналитика,
  // статистика) тянем ПЕРВЫМИ и поодиночке — до общего параллельного залпа лёгких
  // хостов и Ozon. Так аналитике достаётся чистое окно лимитера.
  const PRIORITY_HOSTS = ['seller-analytics-api.wildberries.ru', 'statistics-api.wildberries.ru'];
  const hostEntries = Array.from(byHost.entries());

  // ── Воронка WB через асинхронный отчёт (вместо синхронного sales-funnel) ──
  // Один отчёт (~62 дня, create→poll→download) → 3 кэш-записи (окна 1/7/30)
  // под теми же ключами, что читает фронт. Свежесть проверяем по ключу funnel(7).
  {
    const funnelKey = makeUpstreamCacheKey('wb:analytics', 'POST', 'api/analytics/v3/sales-funnel/products', '', JSON.stringify(funnel(7)));
    // Гейт по ВОЗРАСТУ, а не по TTL: с TTL 3ч при кроне раз в 2ч запись на втором
    // часу считалась свежей, обновление проскакивало, и воронка реально
    // обновлялась раз в 4 часа. Выручка за день только растёт — поэтому мы
    // стабильно показывали меньше кабинета («122 против 158», телемост 11.08).
    const funnelEntry = await cacheGet(funnelKey);
    const freshAlready = !force && !needsRefresh(funnelEntry, REFRESH_LIVE_MS);
    const coolUntil = cronCooldownUntil.get('wb-funnel-report') ?? 0;
    if (freshAlready) {
      results.push({ ns: 'wb:analytics', path: 'nm-report/downloads', status: 200, ms: 0, ok: true, skipped: 'fresh' });
    } else if (!force && Date.now() < coolUntil) {
      results.push({ ns: 'wb:analytics', path: 'nm-report/downloads', status: 0, ms: 0, ok: false, skipped: 'cooldown' });
    } else {
      const t0 = Date.now();
      try {
        const r = await warmWbFunnelViaReport(funnel, TTL_3H);
        results.push({ ns: 'wb:analytics', path: 'nm-report/downloads', status: r.ok ? 200 : 0, ms: Date.now() - t0, ok: r.ok });
        if (!r.ok) cronCooldownUntil.set('wb-funnel-report', Date.now() + C_LT);
      } catch (e) {
        cronCooldownUntil.set('wb-funnel-report', Date.now() + C_LT);
        results.push({ ns: 'wb:analytics', path: 'nm-report/downloads', status: 0, ms: Date.now() - t0, ok: false });
        console.warn('[cron] wb funnel report failed:', (e as Error)?.message);
      }
    }
  }

  // ── Каталог карточек WB: листаем курсором и склеиваем ────────────────────
  // WB отдаёт карточки пачками по 100 (больший limit он отклоняет), а цены —
  // пачкой до 1000. Пока грелась только первая страница, у хвоста каталога не
  // было ни фото, ни названий: в «Ценах» это выглядело как строки с одним
  // артикулом, хотя данные у WB есть.
  //
  // Склеенный список кладём под ТЕМ ЖЕ ключом, который строит браузер для
  // первой страницы (тот же приём, что и с fullstats): фронту не нужно уметь
  // листать, он одним запросом получает весь каталог.
  {
    const up = wbUpstream('content');
    const browserBody = JSON.stringify({ settings: { cursor: { limit: 100 }, filter: { withPhoto: -1 } } });
    const key = makeUpstreamCacheKey('wb:content', 'POST', 'content/v2/get/cards/list', '', browserBody);
    const cached = await cacheGet<{ status: number }>(key);
    const cool = cronCooldownUntil.get(key) ?? 0;
    if (!force && !needsRefresh(cached, TTL_12H)) {
      results.push({ ns: 'wb:content', path: 'content/v2/get/cards/list', status: 200, ms: 0, ok: true, skipped: 'fresh' });
    } else if (!force && Date.now() < cool) {
      results.push({ ns: 'wb:content', path: 'content/v2/get/cards/list', status: 0, ms: 0, ok: false, skipped: 'cooldown' });
    } else {
      const t0 = Date.now();
      try {
        const { fetchAllWbCards } = await import('./wbCards');
        const page = await fetchAllWbCards(up);
        // cursor.total ставим по факту собранного: у WB это «сколько всего
        // подходит под фильтр», и после склейки всех страниц это ровно оно.
        // На нём же держится счётчик карточек на дашборде.
        const body = JSON.stringify({ cards: page.cards, cursor: { total: page.cards.length } });
        await cacheSet(key, { status: 200, ct: 'application/json', text: body }, TTL_12H);
        cronCooldownUntil.delete(key);
        results.push({ ns: 'wb:content', path: 'content/v2/get/cards/list', status: 200, ms: Date.now() - t0, ok: true });
        console.warn(`[wb-cards] каталог: карточек ${page.cards.length}, страниц ${page.pages}` +
          `${page.partial ? ' (неполно: часть страниц не пришла)' : ''}` +
          `${page.truncated ? ' (упёрлись в потолок страниц)' : ''}`);
      } catch (e) {
        cronCooldownUntil.set(key, Date.now() + C_LT);
        results.push({ ns: 'wb:content', path: 'content/v2/get/cards/list', status: 0, ms: Date.now() - t0, ok: false });
        console.warn('[wb-cards] каталог не выгружен:', (e as Error)?.message);
      }
    }
  }

  // ── Цены WB: листаем offset-ом и склеиваем ───────────────────────────────
  // `list/goods/filter` отдаёт максимум 1000 позиций за запрос. Пока брали ровно
  // одну пачку, каталог больше тысячи молча обрезался: в «Ценах» не хватало
  // товаров, и понять это по экрану было нельзя. Сейчас у клиента запас
  // семикратный, так что это закрытие потолка на будущее, а не лечение симптома.
  //
  // Склеенное кладём под ключом браузера (?limit=1000), как и каталог карточек.
  {
    const up = wbUpstream('discounts');
    const qs = '?limit=1000';
    const key = makeUpstreamCacheKey('wb:discounts', 'GET', 'api/v2/list/goods/filter', qs, undefined);
    const cached = await cacheGet<{ status: number }>(key);
    const cool = cronCooldownUntil.get(key) ?? 0;
    if (!force && !needsRefresh(cached, Math.min(TTL_3H, REFRESH_LIVE_MS))) {
      results.push({ ns: 'wb:discounts', path: 'api/v2/list/goods/filter?limit=1000', status: 200, ms: 0, ok: true, skipped: 'fresh' });
    } else if (!force && Date.now() < cool) {
      results.push({ ns: 'wb:discounts', path: 'api/v2/list/goods/filter?limit=1000', status: 0, ms: 0, ok: false, skipped: 'cooldown' });
    } else {
      const t0 = Date.now();
      const PAGE = 1000;
      const MAX_PAGES = 20;            // 20 000 позиций — потолок от зацикливания
      const goods: any[] = [];
      let status = 0, partial = false;
      try {
        for (let page = 0; page < MAX_PAGES; page++) {
          const r = await fetchWithRetry(
            `${up.base}/api/v2/list/goods/filter?limit=${PAGE}&offset=${page * PAGE}`,
            { method: 'GET', headers: up.headers }, { maxRetries: 2 },
          );
          status = r.status;
          if (!r.ok) { partial = goods.length > 0; break; }
          const j = JSON.parse(await r.text()) as { data?: { listGoods?: any[] } };
          const batch = j?.data?.listGoods ?? [];
          goods.push(...batch);
          if (batch.length < PAGE) break;   // последняя пачка
          await sleep(500);                 // не частим по лимиту WB
        }
        if (goods.length || status === 200) {
          await cacheSet(key, {
            status: 200, ct: 'application/json',
            text: JSON.stringify({ data: { listGoods: goods } }),
          }, TTL_3H);
          cronCooldownUntil.delete(key);
          results.push({ ns: 'wb:discounts', path: 'api/v2/list/goods/filter?limit=1000', status: 200, ms: Date.now() - t0, ok: true });
          console.warn(`[wb-prices] позиций ${goods.length}${partial ? ` (неполно, последний ответ ${status})` : ''}`);
        } else {
          cronCooldownUntil.set(key, Date.now() + C_LT);
          results.push({ ns: 'wb:discounts', path: 'api/v2/list/goods/filter?limit=1000', status, ms: Date.now() - t0, ok: false });
          console.warn(`[wb-prices] цены не выгружены: ответ ${status}`);
        }
      } catch (e) {
        cronCooldownUntil.set(key, Date.now() + C_LT);
        results.push({ ns: 'wb:discounts', path: 'api/v2/list/goods/filter?limit=1000', status: 0, ms: Date.now() - t0, ok: false });
        console.warn('[wb-prices] цены не выгружены:', (e as Error)?.message);
      }
    }
  }

  // ── Цены и комиссии Ozon: листаем курсором и склеиваем ───────────────────
  // Ozon отдаёт до 1000 позиций за запрос и `cursor` для следующей страницы.
  // Грелась одна страница на 100 позиций — у каталога больше сотни хвост
  // оставался без цены и комиссии, а значит и без расчёта прибыли. По экрану
  // это неотличимо от «столько товаров и есть» (жалоба клиента 29.08).
  //
  // Склеенное кладём под ключом первой страницы, как и каталог карточек WB:
  // читателям (productEcon) не нужно уметь листать.
  {
    const up = ozonUpstream();
    const canonicalBody = JSON.stringify({ filter: { visibility: 'ALL' }, limit: 100 });
    const key = makeUpstreamCacheKey('ozon-seller', 'POST', 'v5/product/info/prices', '', canonicalBody);
    const cached = await cacheGet<{ status: number }>(key);
    const cool = cronCooldownUntil.get(key) ?? 0;
    if (!force && !needsRefresh(cached, TTL_OZON)) {
      results.push({ ns: 'ozon-seller', path: 'v5/product/info/prices', status: 200, ms: 0, ok: true, skipped: 'fresh' });
    } else if (!force && Date.now() < cool) {
      results.push({ ns: 'ozon-seller', path: 'v5/product/info/prices', status: 0, ms: 0, ok: false, skipped: 'cooldown' });
    } else {
      const t0 = Date.now();
      const items: any[] = [];
      const seen = new Set<string>();
      let cursor = '';
      let status = 0;
      try {
        for (let page = 0; page < 20; page++) {   // потолок от зацикливания
          const r = await fetchWithRetry(`${up.base}/v5/product/info/prices`, {
            method: 'POST',
            headers: { ...up.headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({ filter: { visibility: 'ALL' }, cursor, limit: 1000 }),
          }, { maxRetries: 2 });
          status = r.status;
          if (!r.ok) break;
          const j = JSON.parse(await r.text()) as { items?: any[]; cursor?: string };
          const batch = j?.items ?? [];
          // Страницы у Ozon плывут (сортировка нестабильна): один товар может
          // прийти дважды, а курсор — повториться. Дубли режем по offer_id, а
          // страница без новых товаров или тот же курсор — признак конца.
          let fresh = 0;
          for (const it of batch) {
            const k = String(it?.offer_id ?? it?.product_id ?? '');
            if (!k || seen.has(k)) continue;
            seen.add(k); items.push(it); fresh++;
          }
          const next = j?.cursor ?? '';
          if (!next || !batch.length || !fresh || next === cursor) break;
          cursor = next;
          await sleep(500);
        }
        if (items.length) {
          await cacheSet(key, { status: 200, ct: 'application/json', text: JSON.stringify({ items, cursor: '' }) }, TTL_OZON);
          cronCooldownUntil.delete(key);
          results.push({ ns: 'ozon-seller', path: 'v5/product/info/prices', status: 200, ms: Date.now() - t0, ok: true });
          console.warn(`[ozon-prices] позиций ${items.length}`);
        } else {
          cronCooldownUntil.set(key, Date.now() + C_LT);
          results.push({ ns: 'ozon-seller', path: 'v5/product/info/prices', status, ms: Date.now() - t0, ok: false });
          console.warn(`[ozon-prices] цены не выгружены: ответ ${status}`);
        }
      } catch (e) {
        cronCooldownUntil.set(key, Date.now() + C_LT);
        results.push({ ns: 'ozon-seller', path: 'v5/product/info/prices', status: 0, ms: Date.now() - t0, ok: false });
        console.warn('[ozon-prices] цены не выгружены:', (e as Error)?.message);
      }
    }
  }

  for (const [host, hostTargets] of hostEntries.filter(([h]) => PRIORITY_HOSTS.includes(h))) {
    await runHostQueue(host, hostTargets);
  }
  await Promise.all(
    hostEntries
      .filter(([h]) => !PRIORITY_HOSTS.includes(h))
      .map(([host, hostTargets]) => runHostQueue(host, hostTargets)),
  );

  // Записываем «маркеры свежести» — один маркер на каждый namespace, в котором был
  // хотя бы один успешный запрос. Они потом отдаются через /api/meta/status.
  const okByNs = new Map<string, number>();
  for (const r of results) if (r.ok) okByNs.set(r.ns, (okByNs.get(r.ns) || 0) + 1);
  await Promise.all(Array.from(okByNs.entries()).map(([ns, count]) =>
    cacheSet(makeCacheKey('meta', 'freshness', ns), { at: Date.now(), count }, 7 * 24 * 60 * 60_000)
  ));

  // Отвечаем СРАЗУ после прогрева кабинета — иначе авто-прогрев в server.ts ждёт
  // и падает по таймауту.
  res.status(200).json({ ok: true, at: new Date().toISOString(), results });

  // История: пишем снимок за сегодня в SQLite. buildSnapshot() читает свежий
  // (только что прогретый) кэш; recordDailySnapshot сохраняет цифры по площадкам.
  // COALESCE внутри не затирает уже сохранённое пустыми значениями — поэтому даже
  // частичный прогрев (например Ozon есть, WB словил 429) дополняет строку дня.
  void (async () => {
    try {
      // force=true — пересобрать снимок минуя 30-мин кэш контекста, иначе в БД
      // ляжет устаревший (до этого прогрева) снимок с пустыми продажами.
      const snap = await buildSnapshot(true);
      recordDailySnapshot(mskDate(0), {
        ozonRevenue: snap.ozon?.revenue ?? null,
        ozonOrders: snap.ozon?.orders ?? null,
        ozonProducts: snap.ozon?.productsCount ?? null,
        wbRevenue: snap.wb?.revenueWeek ?? null,
        wbOrders: snap.wb?.ordersWeek ?? null,
        wbProducts: snap.wb?.productsCount ?? null,
        reviewsUnanswered: snap.reviews?.unanswered ?? null,
        reviewsArchive: snap.reviews?.archive ?? null,
        adsTotal: snap.ads?.wbTotal ?? null,
        adsActive: snap.ads?.wbActive ?? null,
      });
    } catch (e) { console.warn('[history] снимок дня не записан:', (e as Error).message); }
  })();

  // Транзит и журнал поставок WB — принудительно освежаем (force=true) каждый
  // проход cron. Кэш у них 3ч > 2ч между проходами, поэтому браузер на
  // «Распределении» ВСЕГДА читает свежий кэш и сам НЕ ходит в supplies-api.
  void getWbTransit(true).catch(() => null);
  void getWbSupplies(true).catch(() => null);
  // Цена покупателя с СПП — пересчёт из прогретых продаж (в WB не ходит).
  void getWbBuyerPrices(true).catch(() => null);
  // Цена покупателя Ozon (action_price из акций) — освежаем каждый проход.
  void getOzonBuyerPrices(true).catch(() => null);
  // Комиссия WB по предметам (tariffs/commission) — для калькулятора прибыли.
  void getWbCommissions().catch(() => null);
  // Тарифы логистики/хранения WB (tariffs/box) — для калькулятора прибыли.
  void getWbBoxTariffs().catch(() => null);
  void getWbStock().catch(() => null); // тёплый кэш остатков WB для фильтра «В продаже»
  // Экономика карточек WB по nmId (комиссия + объём) — полный обход карточек.
  void getWbCardEcon().catch(() => null);
  // Факт-прибыль Ozon из финансовых операций (реальная выплата/шт).
  void getOzonFactProfit().catch(() => null);

  // Прогрев конкурентов — ПОСЛЕ ответа, fire-and-forget (search.wb.ru/ozon бывают
  // медленными/банят, не должны задерживать прогрев кабинета).
  void (async () => {
    const COMP_QUERIES = ['CarPlay адаптер', 'Android магнитола', 'видеорегистратор', 'держатель MagSafe', 'FM трансмиттер', 'антирадар'];
    for (const q of COMP_QUERIES) {
      await competitorSearch('wb', q, 16).catch(() => null);
      await competitorSearch('ozon', q, 16).catch(() => null);
    }
  })();

  // WB реклама: прогрев fullstats (расход по кампаниям) + payments. Рекламный API
  // WB лимитирует ~1 req/min, поэтому отдельно, с паузами, после ответа.
  // WB 07.2026 сменил формат fullstats: ids=1,2,3 через ЗАПЯТУЮ и МАКС 50 кампаний
  // за запрос. Поэтому греем чанками по 50 и СКЛЕИВАЕМ под ключом, который строит
  // фронт (все ids через запятую) — браузер потом читает готовый склеенный ответ.
  // Список ids строим ТОЧНО как фронт: пропускаем группы status=-1, первые 100.
  // Промис держим: цепочка warm-extras ниже собирает таблицу «Реклама по артикулам»
  // из этих же данных и обязана дождаться прогрева, а не гадать по таймауту.
  const wbAdsWarm = (async () => {
    try {
      const adv = wbUpstream('promotion');
      { // freshness-гейт: cron ходит каждые 2ч, а тут ещё и паузы — не долбим лишний раз.
        // force=1 пробивает гейт (для ручного перегрева fullstats при отладке ДРР WB).
        // Порог — по возрасту, а не по TTL: с TTL 3ч расход рекламы обновлялся раз
        // в 4 часа, и ДРР на экране отставал (жалоба клиента по ДРР, телемост 11.08).
        // Лимиту WB это не вредит: между запросами тут и так пауза 65с.
        const probe = await cacheGet(makeCacheKey('meta', 'freshness', 'wb:promotion-fullstats'));
        if (!force && !needsRefresh(probe, REFRESH_LIVE_MS)) return;
      }
      // promotion/count — GET (как у фронта). Берём из прогретого кэша, иначе GET-запрос.
      let cnt: any = null;
      const cntCached = await cacheGet<{ text: string }>(makeUpstreamCacheKey('wb:promotion', 'GET', 'adv/v1/promotion/count', '', undefined));
      if (cntCached?.data?.text) { try { cnt = JSON.parse(cntCached.data.text); } catch (e) { noteSwallowed('wb-fullstats', 'битый кэш promotion/count, перезапрашиваем', e); } }
      if (!cnt) {
        const cntR = await fetchWithRetry(`${adv.base}/adv/v1/promotion/count`, { method: 'GET', headers: adv.headers }, { maxRetries: 1 });
        if (!cntR.ok) return;
        cnt = JSON.parse(await cntR.text());
      }
      const ids: number[] = [];
      for (const g of (cnt.adverts || [])) {
        if (g.status === -1) continue;                       // как фронт: без удалённых
        for (const a of (g.advert_list || [])) if (typeof a.advertId === 'number') ids.push(a.advertId);
      }
      // Сортируем — ключ кэша должен совпадать с фронтом (он тоже сортирует),
      // иначе при разном порядке от WB ключи не совпадают и браузер видит 503.
      // Берём 100 САМЫХ СВЕЖИХ кампаний (высокий advertId), а не первые попавшиеся:
      // тратящие кампании — обычно недавние, а «первые 100» их обрезали → расход 0
      // при непустом кабинете (жалоба 28.07). Затем сорт ASC для ключа кэша.
      const ids100 = ids.slice().sort((a, b) => b - a).slice(0, 100).sort((a, b) => a - b);
      if (!ids100.length) { console.warn('[wb-fullstats] нет advertId (promotion/count пуст)'); return; }
      console.warn(`[wb-fullstats] старт: ids=${ids100.length}`);
      const chunks: number[][] = [];
      for (let i = 0; i < ids100.length; i += 50) chunks.push(ids100.slice(i, i + 50)); // WB max 50/запрос

      let warmedOk = 0;
      let anyPartial = false;
      for (const back of [7, 30]) {
        const merged: any[] = [];
        let chunkFail = false;
        for (const ch of chunks) {
          await sleep(65_000); // рекламный API ~1 req/min
          const q = `?ids=${ch.join(',')}&beginDate=${iso(back)}&endDate=${iso(0)}`;
          const r = await fetchWithRetry(`${adv.base}/adv/v3/fullstats${q}`, { method: 'GET', headers: adv.headers }, { maxRetries: 1 });
          if (r.ok && r.status !== 204) {
            try { const arr = JSON.parse(await r.text()); if (Array.isArray(arr)) merged.push(...arr); } catch (e) { noteSwallowed('wb-fullstats', 'чанк fullstats не разобран', e); }
          } else if (!r.ok) { chunkFail = true; console.warn(`[wb-fullstats] back=${back} chunk → ${r.status}`); }
        }
        // console.warn (не log): под systemd обычный вывод буферизуется и не виден
        // в journalctl, а предупреждения идут в stderr сразу (03.08 гоняли логи впустую).
        console.warn(`[wb-fullstats] back=${back} merged=${merged.length} chunkFail=${chunkFail}`);
        // Кэшируем даже при частичном сбое: раньше один упавший по лимиту WB чанк
        // отбрасывал ВСЮ выгрузку окна, и WB-реклама почти никогда не прогревалась
        // (03.08: Ozon грелся, WB — нет). Неполные данные лучше пустоты — не хватит
        // нескольких кампаний, а не всех. Полноту дожмёт следующий цикл (см. ниже).
        if (merged.length > 0) {
          const browserQs = `?ids=${ids100.join(',')}&beginDate=${iso(back)}&endDate=${iso(0)}`;
          const key = makeUpstreamCacheKey('wb:promotion', 'GET', 'adv/v3/fullstats', browserQs, undefined);
          await cacheSet(key, { status: 200, ct: 'application/json', text: JSON.stringify(merged) }, TTL_3H);
          warmedOk++;
          if (chunkFail) anyPartial = true;
          const spend = merged.reduce((s: number, it: any) => s + (Number(it?.sum) || 0), 0);
          console.warn(`[wb-fullstats] warmed back=${back} spend=${Math.round(spend)}${chunkFail ? ' (частично)' : ''}`);
        } else if (chunkFail) {
          anyPartial = true;
        }
      }
      // Отметку «свежо» ставим ТОЛЬКО при полном прогреве: если данные частичны,
      // не блокируем следующий цикл крона — пусть дожмёт недостающие кампании.
      if (warmedOk > 0 && !anyPartial) {
        await cacheSet(makeCacheKey('meta', 'freshness', 'wb:promotion-fullstats'), { at: Date.now() }, TTL_3H);
      }

      // payments (история пополнений) — фронт читает /adv/v1/payments?from=iso(30)&to=iso(0).
      // Часто 204 (пусто) — кэшируем как «[]», чтобы браузер не падал и не висел на 503.
      await sleep(65_000);
      const payQs = `?from=${iso(30)}&to=${iso(0)}`;
      const payR = await fetchWithRetry(`${adv.base}/adv/v1/payments${payQs}`, { method: 'GET', headers: adv.headers }, { maxRetries: 1 });
      if (payR.ok) {
        const t = payR.status === 204 ? '[]' : (await payR.text()) || '[]';
        const payKey = makeUpstreamCacheKey('wb:promotion', 'GET', 'adv/v1/payments', payQs, undefined);
        await cacheSet(payKey, { status: 200, ct: 'application/json', text: t }, TTL_3H);
      }
    } catch (e) { console.warn('[wb-fullstats] failed:', (e as Error)?.message); }
  })();

  // ── Дополнительные прогревы: BI, удержания, реклама Ozon по SKU ───────────
  // Их читают вкладка «BI и финансы», таблица «Реклама по артикулам» и воронка.
  // Три правила, выведенные из аварии 10.08:
  //  1) ОДНОЙ цепочкой, а не тремя параллельными — иначе после рестарта они
  //     сходятся с основным прогревом и сервер перестаёт отвечать браузеру;
  //  2) с задержкой от старта — сначала пусть поднимется отдача интерфейса;
  //  3) без повторного входа, если предыдущая цепочка ещё идёт.
  if (!extrasWarming) {
    extrasWarming = true;
    void (async () => {
      try {
        await sleep(60_000);
        // Курс ЦБ — раз за проход. Рублёвая цифра расхода на ИИ считается по нему,
        // и без обновления она тихо разъезжается со счётом Anthropic.
        await refreshUsdRate();
        // Себестоимость из таблицы клиента: она источник истины, мы её кэшируем.
        const { syncFromSklad } = await import('./costs');
        const sync = await syncFromSklad().catch(() => null);
        console.warn(`[warm-extras] себестоимость из таблицы: ${sync?.error ? `не вышло — ${sync.error}` : `обновлено ${sync?.updated ?? 0}, всего ${sync?.total ?? 0}`}`);

        const [{ getBiSummary }, { getPenalties }] = await Promise.all([
          import('./bi'), import('./penalties'),
        ]);
        for (const days of [30, 7]) {
          await getBiSummary(days, true).catch(() => null);
          await getPenalties(days, true).catch(() => null);
        }
        console.warn('[warm-extras] BI и удержания готовы');

        const { getOzonSkuAdsRange } = await import('./ozonSkuAds');
        // 16.09.2026: добавлены окна 14 и 30 дней (и их предыдущие периоды): таблица «Реклама по артикулам» и фолбэк ДРР 30д
      // читают именно эти диапазоны (29-0, 59-30), а грелись только 6-0 и 13-7 — 30-дневный ДРР Ozon был от 26.08.
      for (const [from, to] of [[6, 0], [13, 7], [13, 0], [27, 14], [29, 0], [59, 30]] as [number, number][]) {
          const r = await getOzonSkuAdsRange(from, to).catch(() => null);
          console.warn(`[warm-extras] реклама Ozon ${from}…${to}: ${r ? `товаров ${r.count}` : 'не удалось'}`);
        }
        // Таблица «Реклама по артикулам» — считаем последней, когда отчёты уже
        // в кэше, и кладём результат целиком: страница откроется мгновенно.
        //
        // Перед этим ДОЖИДАЕМСЯ прогрева статистики кампаний WB. Раньше эта цепочка
        // стартовала через 60 секунд и обгоняла fullstats, у которого между чанками
        // пауза 65 секунд: таблица собиралась на пустой статистике WB и уезжала в
        // кэш с нулём строк по WB при живом расходе. Лечится порядком, а не более
        // длинным сном — время прогрева зависит от числа кампаний и лимитов WB и
        // заранее неизвестно.
        //
        // Ограничение сверху — страховка от зависшего запроса к WB, а не способ
        // синхронизации: если оно сработало, это видно в журнале.
        const WB_ADS_WAIT_MS = 15 * 60_000;
        const wbAdsReady = await new Promise<boolean>(resolve => {
          // Таймер обязательно снимаем: иначе висящий 15-минутный setTimeout держит
          // event loop и после того, как прогрев давно закончился.
          const t = setTimeout(() => resolve(false), WB_ADS_WAIT_MS);
          void wbAdsWarm.then(() => { clearTimeout(t); resolve(true); });
        });
        if (!wbAdsReady) {
          console.warn(`[warm-extras] прогрев рекламы WB не уложился в ${WB_ADS_WAIT_MS / 60_000} мин` +
            ' — таблица соберётся без WB, следующий проход дожмёт');
        }

        // Факт логистики (16.09.2026) — до таблицы рекламы, чтобы product-econ сразу видел факт.
      // Кэш 12 ч: отчёты площадок обновляются раз в сутки, чаще дёргать нечего.
      const { getLogisticsFact } = await import('./logisticsFact');
      const lf = await getLogisticsFact().catch(() => null);
      console.warn(`[warm-extras] факт логистики: ${lf ? `WB товаров ${Object.keys(lf.wb).length}, Ozon ${Object.keys(lf.ozon).length}` : 'не удалось'}${lf?.diagnostics?.length ? ' · ' + lf.diagnostics.join('; ') : ''}`);
      const { collectAdsBySku } = await import('./agents/adsAdvisor');
        for (const d of [7, 14, 30]) {
          const r = await collectAdsBySku(d).catch(() => null);
          // Печатаем и диагностику: «строк 4» не говорит, WB это или Ozon, и
          // молча скрывает, что одна из площадок вообще не дала данных.
          console.warn(`[warm-extras] реклама по артикулам ${d}д: ${
            r ? `строк ${r.items.length} (WB ${r.items.filter(i => i.platform === 'wb').length}, Ozon ${r.items.filter(i => i.platform === 'ozon').length}) · ${r.diagnostics}` : 'не удалось'
          }`);
        }
        // Цены закреплённых конкурентов — раз в проход. Идёт последним: WB
        // лимитирует по IP, и эта задача не должна мешать прогреву кабинета.
        // Витрина WB по своим товарам — тем же батчем, что и конкуренты.
        // 18.09.2026: серверный автосъём витрины WB выключен — витрина снимается ТОЛЬКО принудительно
        // (кнопка + пароль); между проверками цена покупателя = цена ЛК x (1 - СПП крайнего снимка).
        if (process.env.WB_SHOWCASE_SERVER_FETCH === '1') {
          const { collectWbShowcase } = await import('./wbShowcase');
          const sc = await collectWbShowcase().catch(() => null);
          console.warn(`[warm-extras] витрина WB: ${sc ? `снято ${sc.count} из ${sc.requested}${sc.error ? ` · ${sc.error}` : ''}` : 'не удалось'}`);
        }

        const { collectCompetitorPrices } = await import('./competitorPrices');
        const cp = await collectCompetitorPrices().catch(() => null);
        console.warn(`[warm-extras] цены конкурентов: ${
          cp ? `отслеживаем ${cp.tracked}, записано ${cp.saved}${cp.error ? ` · ${cp.error}` : ''}` : 'не удалось'
        }`);

        try {
        // Claude-анализ рекламы раз в сутки после 06:00 МСК (17.09.2026) — когда реклама и остатки уже прогреты.
        const { runAdsInsightIfDue } = await import('./ads/insight');
        console.warn('[warm-extras] анализ рекламы Claude:', await runAdsInsightIfDue());
      } catch (e) { console.warn('[warm-extras] анализ рекламы не удался:', (e as Error)?.message); }
      console.warn('[warm-extras] цепочка завершена');
      } catch (e) {
        console.warn('[warm-extras] failed:', (e as Error)?.message);
      } finally {
        extrasWarming = false;
      }
    })();
  }
}