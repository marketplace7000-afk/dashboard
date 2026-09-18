/**
 * Единый корневой catch-all для всех API-запросов.
 *
 * Vercel в текущей версии (для non-Next проектов) корректно ловит multi-segment
 * только корневым catch-all. Поэтому внутри сами диспатчим по префиксу path:
 *   /api/auth/*       → auth handlers (login/logout/check)
 *   /api/wb/<scope>/* → WB proxy
 *   /api/ozon/*       → Ozon Seller proxy
 *   /api/ozon-perf/*  → Ozon Performance proxy
 *   /api/cron/refresh → cron
 *
 * Здесь остался только диспетчер и короткие обработчики. Крупные куски живут
 * отдельно, потому что менялись в своём темпе и мешали читать маршрутизацию:
 *   _lib/cron.ts            — фоновый сборщик (был третью файла)
 *   _lib/aiHandlers.ts      — всё, что ходит в Claude
 *   _lib/publicHandlers.ts  — выдача конкурентов, публичные данные WB, Ozon Performance
 *   _proxy.ts               — проксирование в WB и Ozon
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { handleProxy, wbUpstream, ozonUpstream } from './_proxy';
import { requireAuth, checkPassword, signSession, setSessionCookie, clearSessionCookie } from './_lib/auth';
import { validateInitData, isAllowedTgId } from './_lib/telegramAuth';
import { fetchWithRetry } from './_lib/fetchRetry';
import { cacheGet, makeCacheKey, makeUpstreamCacheKey, cacheGetNewestByPrefix } from './_lib/cache';
import { getOzonTransit } from './_lib/ozonTransit';
import { getWbTransit } from './_lib/wbTransit';
import { getWbSupplies } from './_lib/wbSuppliesLog';
import { getWbBuyerPrices } from './_lib/wbBuyerPrices';
import { getOzonBuyerPrices } from './_lib/ozonBuyerPrices';
import { getWbCommissions } from './_lib/wbCommissions';
import { getOzonFactProfit } from './_lib/ozonFactProfit';
import { getWbBoxTariffs } from './_lib/wbBoxTariffs';
import { getWbStock } from './_lib/wbStock';
import { getWbCardEcon } from './_lib/wbCardEcon';
import { WB_DAILY_KEY } from './_lib/wbFunnelReport';
import { pingAnthropic } from './_lib/anthropic';
import { readRecentAgg, getDailyLimitRub, getUsdRate } from './_lib/aiUsage';
import { getLatestSnapshot, getSnapshotSeries } from './_lib/history';
import { CRON_WARM_INTERVAL_MS } from './_lib/cronSchedule';
import { handleCron } from './_lib/cron';
import { handleAi } from './_lib/aiHandlers';
import { handleCompetitors, handleWbPublic, handleOzonPerf } from './_lib/publicHandlers';
import { wbSearchRank } from './_lib/competitors';


export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Vercel rewrites направляют /api/* → /api/route?p=<full-path>
  const p = req.query.p;
  const pathStr = Array.isArray(p) ? p.join('/') : (p ? String(p) : '');
  const parts = pathStr.split('/').filter(Boolean);

  if (!parts.length) {
    return res.status(404).json({ error: 'not_found' });
  }

  const [section, ...rest] = parts;

  // ─── /api/auth/* ─────────────────────────────────────────────────────────
  if (section === 'auth') {
    const action = rest[0];

    if (action === 'login') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
      if (!process.env.AUTH_PASSWORD) return res.status(503).json({ error: 'auth_not_configured' });
      const body = (typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body) as { password?: string };
      const password = String(body?.password ?? '');
      if (!checkPassword(password)) {
        await new Promise(r => setTimeout(r, 800));
        return res.status(401).json({ error: 'wrong_password' });
      }
      const secret = process.env.AUTH_SECRET || process.env.AUTH_PASSWORD;
      setSessionCookie(res, signSession(secret));
      return res.status(200).json({ ok: true });
    }

    // Вход из Telegram Mini App по проверенному Telegram-ID (вместо пароля).
    // Фронт шлёт window.Telegram.WebApp.initData; проверяем подпись токеном бота
    // и сверяем user.id с TELEGRAM_ALLOWED_IDS. При успехе — та же сессия-cookie.
    if (action === 'tg') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
      const botToken = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
      if (!botToken) return res.status(503).json({ error: 'tg_auth_not_configured' });
      const secret = process.env.AUTH_SECRET || process.env.AUTH_PASSWORD;
      if (!secret) return res.status(503).json({ error: 'auth_not_configured' });

      const body = (typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body) as { initData?: string };
      const v = validateInitData(String(body?.initData ?? ''), botToken);
      if (!v.ok) {
        const reason = v.reason;
        await new Promise(r => setTimeout(r, 500));
        return res.status(401).json({ error: 'tg_invalid', reason });
      }
      if (!isAllowedTgId(v.user.id)) {
        console.warn(`[tg-auth] доступ запрещён для tg_id=${v.user.id} (@${v.user.username ?? '—'}): нет в TELEGRAM_ALLOWED_IDS`);
        return res.status(403).json({ error: 'tg_not_allowed', tgId: v.user.id });
      }
      setSessionCookie(res, signSession(secret));
      return res.status(200).json({ ok: true, user: { id: v.user.id, username: v.user.username } });
    }

    if (action === 'logout') {
      clearSessionCookie(res);
      return res.status(200).json({ ok: true });
    }

    if (action === 'check') {
      if (!process.env.AUTH_PASSWORD) {
        return res.status(200).json({ ok: true, authEnabled: false });
      }
      if (!requireAuth(req, res)) return;
      return res.status(200).json({ ok: true, authEnabled: true });
    }

    return res.status(404).json({ error: 'auth_action_not_found' });
  }

  // ─── /api/cron/refresh ───────────────────────────────────────────────────
  if (section === 'cron') {
    // Cron имеет свою защиту через CRON_SECRET, не требует auth-cookie
    return handleCron(req, res);
  }

  // ─── /api/anthropic-relay ──────────────────────────────────────────────────
  // Релей для обхода гео-блока Anthropic на РФ-IP. Деплоится на не-РФ хост
  // (наш Vercel). Московский сервер шлёт сюда payload + x-relay-secret, мы
  // подставляем ключ и форвардим в api.anthropic.com. См. api/_lib/anthropic.ts.
  // ДОЛЖЕН быть ДО requireAuth: у релея своя авторизация по секрету, сессии нет.
  if (section === 'anthropic-relay') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
    const expected = (process.env.RELAY_SECRET || '').trim();
    const got = String(req.headers['x-relay-secret'] || '').trim();
    if (!expected || got !== expected) return res.status(401).json({ error: 'relay_unauthorized' });
    const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim();
    if (!apiKey) return res.status(503).json({ error: 'anthropic_key_missing' });

    const payload = typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {});
    try {
      const up = await fetchWithRetry('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: payload,
      });
      const text = await up.text();
      res.status(up.status);
      res.setHeader('content-type', up.headers.get('content-type') ?? 'application/json');
      return res.send(text);
    } catch (e: any) {
      return res.status(502).json({ error: 'relay_upstream_unreachable', detail: String(e?.message ?? e) });
    }
  }

  // ─── /api/tg-relay/<bot…/method> ───────────────────────────────────────────
  // Релей для обхода блокировки api.telegram.org на РФ-IP (Timeweb режет Telegram).
  // Деплоится на не-РФ хост (Vercel). Московский сервер (telegramBot.ts) шлёт сюда
  // запрос + x-relay-secret, мы прозрачно форвардим в api.telegram.org.
  // Путь сохраняется: /api/tg-relay/bot<token>/getUpdates → api.telegram.org/bot<token>/getUpdates
  // ДОЛЖЕН быть ДО requireAuth: своя авторизация по секрету, сессии нет.
  // ─── /api/tg-webhook ── Telegram присылает сообщения СЮДА ──────────────────
  // Заменяет постоянный опрос через релей: тот держал ~2 вызова функции Vercel в
  // минуту круглосуточно. Теперь вызов происходит только когда реально написали.
  // Защита: секрет в заголовке, который Telegram шлёт по договорённости
  // (setWebhook secret_token). ДОЛЖЕН быть до requireAuth — у Telegram нет сессии.
  if (section === 'tg-webhook') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
    const expected = (process.env.TELEGRAM_WEBHOOK_SECRET || process.env.RELAY_SECRET || '').trim();
    const got = String(req.headers['x-telegram-bot-api-secret-token'] || '').trim();
    if (!expected || got !== expected) return res.status(401).json({ error: 'webhook_unauthorized' });
    // Отвечаем Telegram сразу: он ждёт быстрый ответ, иначе повторит доставку.
    res.status(200).json({ ok: true });
    void (async () => {
      try {
        const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body ?? {});
        const { handleTelegramUpdate } = await import('./_lib/telegramBot');
        await handleTelegramUpdate(body);
      } catch (e) {
        console.warn('[tg-webhook] ошибка обработки:', (e as Error).message);
      }
    })();
    return;
  }

  if (section === 'tg-relay') {
    const expected = (process.env.RELAY_SECRET || '').trim();
    const got = String(req.headers['x-relay-secret'] || '').trim();
    if (!expected || got !== expected) return res.status(401).json({ error: 'relay_unauthorized' });

    const tgPath = rest.join('/');                                // bot<token>/<method>
    const origQs = req.url?.includes('?') ? '?' + req.url.split('?').slice(1).join('?') : '';
    const url = `https://api.telegram.org/${tgPath}${origQs}`;
    const method = (req.method ?? 'GET').toUpperCase();
    let body: string | undefined;
    if (method !== 'GET' && method !== 'HEAD') {
      body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {});
    }
    try {
      // getUpdates держит long-poll до 30с — таймаут с запасом, без ретраев (poll сам повторит).
      const up = await fetchWithRetry(
        url,
        { method, headers: body ? { 'content-type': 'application/json' } : {}, body },
        { maxRetries: 0, timeoutMs: 50_000 },
      );
      const text = await up.text();
      res.status(up.status);
      res.setHeader('content-type', up.headers.get('content-type') ?? 'application/json');
      return res.send(text);
    } catch (e: any) {
      return res.status(502).json({ error: 'tg_relay_unreachable', detail: String(e?.message ?? e) });
    }
  }

  // ─── Все остальные секции требуют auth ───────────────────────────────────
  if (!requireAuth(req, res)) return;

  // ─── /api/wb/<scope>/* ───────────────────────────────────────────────────
  if (section === 'wb') {
    const [scope, ...wbRest] = rest;
    if (!scope) return res.status(400).json({ error: 'missing_scope' });
    const clientToken = req.headers['x-wb-token'];
    const override = Array.isArray(clientToken) ? clientToken[0] : clientToken;
    return handleProxy(req, res, wbUpstream(scope, override), wbRest.join('/'), `wb:${scope}`);
  }

  // ─── /api/ads-advisor ── находки по рекламе и нормы ДРР ────────────────────
  // Реализует документы специалистов по рекламе: раздел показывает, что требует
  // внимания, а нормы ДРР задают люди, потому что они зависят от категории.
  if (section === 'ads-advisor') {
    const what = rest[0] ?? 'findings';
    try {
      if (what === 'norms') {
        const { getDrrNorms, saveDrrNorms } = await import('./_lib/ads/norms');
        if (req.method === 'POST') {
          const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body ?? {});
          return res.status(200).json({ ok: true, norms: await saveDrrNorms(body?.norms ?? {}) });
        }
        // Отдаём и заданные нормы, и ФАКТИЧЕСКИЙ ДРР по категориям — витрина
        // стратегий показывает их рядом, чтобы клиент сверил норму с реальностью.
        const { getCategoryDrr } = await import('./_lib/ads/categoryDrr');
        return res.status(200).json({
          ok: true,
          norms: await getDrrNorms(),
          actual: await getCategoryDrr().catch(() => []),
        });
      }
      if (what === 'by-sku') {
        // Реклама в разрезе артикулов — таблица раздела «Реклама».
        const { collectAdsBySku } = await import('./_lib/agents/adsAdvisor');
        const days = Math.min(Math.max(Number(req.query.days) || 7, 1), 60);
        return res.status(200).json({ ok: true, ...(await collectAdsBySku(days)) });
      }
      const { collectAdsFindings } = await import('./_lib/agents/adsAdvisor');
      return res.status(200).json({ ok: true, ...(await collectAdsFindings()) });
    } catch (e) {
      return res.status(502).json({ ok: false, error: String((e as Error)?.message ?? e).slice(0, 200) });
    }
  }

  // ─── /api/costs ── справочник себестоимости (свой, вместо листа «Склад») ───
  // GET  → { items, updatedAt }
  // POST { items: {SKU: цена}, source? }  → сохранить пачкой (0/пусто = удалить)
  // POST { csv: "SKU;цена;пометка" }      → импорт файлом
  if (section === 'costs') {
    try {
      const { getCosts, setCosts, parseCostsCsv, syncFromSklad } = await import('./_lib/costs');
      if (req.method === 'POST') {
        const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body ?? {});
        // Подтянуть из основной таблицы клиента (лист «Склад», колонка I).
        if (body?.sync === 'sklad') {
          const r = await syncFromSklad();
          return res.status(200).json({ ok: !r.error, ...r });
        }
        if (typeof body?.csv === 'string') {
          const { items, notes, skipped } = parseCostsCsv(body.csv);
          const r = setCosts(items, 'import', notes);
          return res.status(200).json({ ok: true, ...r, skipped });
        }
        const r = setCosts(body?.items ?? {}, 'manual');
        return res.status(200).json({ ok: true, ...r });
      }
      return res.status(200).json({ ok: true, ...getCosts() });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String((e as Error)?.message ?? e).slice(0, 200) });
    }
  }

  // ─── /api/competitor-watch ── конкуренты, закреплённые за нашим товаром ────
  // GET  ?sku=ARTICLE      → привязки одного товара
  // GET                    → всё сразу (для страницы со списком)
  // POST { sku, link }     → добавить вручную (ссылка WB или номер артикула)
  // POST { sku, nmId, status } → одобрить авто-находку / убрать из расчёта
  // POST { sku, nmId, remove: true } → удалить привязку
  if (section === 'competitor-watch') {
    try {
      const w = await import('./_lib/competitorWatch');
      if (req.method === 'POST') {
        const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body ?? {});
        // Ручной запуск сбора цен — чтобы не ждать ночного прохода при настройке.
        if (body?.collect) {
          const { collectCompetitorPrices } = await import('./_lib/competitorPrices');
          return res.status(200).json({ ok: true, ...(await collectCompetitorPrices()) });
        }
        const sku = String(body?.sku ?? '').trim();
        if (!sku) return res.status(400).json({ ok: false, error: 'sku_required' });

        if (body?.remove && body?.nmId) {
          return res.status(200).json({ ok: true, links: w.removeLink(sku, Number(body.nmId)) });
        }
        if (body?.status && body?.nmId) {
          return res.status(200).json({ ok: true, links: w.setLinkStatus(sku, Number(body.nmId), body.status) });
        }
        // Ссылку принимаем в любом виде: клиент шлёт и полный URL, и «nm123», и число.
        const nmId = body?.nmId ? Number(body.nmId) : w.parseNmId(String(body?.link ?? ''));
        if (!nmId) return res.status(400).json({ ok: false, error: 'bad_link', detail: 'Не удалось разобрать артикул WB из ссылки' });
        const links = w.addLink(sku, nmId, { source: 'manual', note: body?.note, title: body?.title, brand: body?.brand });
        return res.status(200).json({ ok: true, links });
      }

      const sku = String(req.query.sku ?? '').trim();
      if (sku) {
        // Наша цена приходит с фронта: она уже посчитана в калькуляторе цен
        // (с СПП и всеми приоритетами источников), дублировать расчёт незачем.
        const { getMarketPosition } = await import('./_lib/competitorPrices');
        const ourPrice = Number(req.query.ourPrice) || null;
        return res.status(200).json({ ok: true, ...getMarketPosition(sku, ourPrice) });
      }
      return res.status(200).json({ ok: true, ...w.getWatchList() });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String((e as Error)?.message ?? e).slice(0, 200) });
    }
  }

  // ─── /api/product-econ ── экономика товара по артикулу ─────────────────────
  // Одна точка сборки входных данных для расчёта прибыли: себестоимость, ДРР,
  // комиссия и логистика по выбранной схеме работы. Каждое поле несёт признак
  // происхождения, а неизвестное значение приходит как null, а не как дефолт.
  // Подробнее, зачем это отдельным модулем, — в шапке _lib/productEcon.ts.
  if (section === 'ads-insight') {
    try {
      const ins = await import('./_lib/ads/insight');
      const mp = String(req.query.mp ?? 'wb') === 'ozon' ? 'ozon' : 'wb';
      if (String(req.query.journal ?? '') === '1') return res.status(200).json({ ok: true, entries: ins.getInsightJournal(mp) });
      return res.status(200).json({ ok: true, ...(await ins.getAdsInsight(mp, String(req.query.refresh ?? '') === '1')) });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String((e as Error)?.message ?? e).slice(0, 200) });
    }
  }
  if (section === 'ads-manage') {
    try {
      const { getAdsManage } = await import('./_lib/ads/manage');
      return res.status(200).json({ ok: true, ...(await getAdsManage(String(req.query.refresh ?? '') === '1')) });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String((e as Error)?.message ?? e).slice(0, 200) });
    }
  }
  if (section === 'product-econ') {
    try {
      const days = Math.min(Math.max(Number(req.query.days) || 7, 1), 90);
      const { buildProductEcon } = await import('./_lib/productEcon');
      return res.status(200).json({ ok: true, ...(await buildProductEcon(days)) });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String((e as Error)?.message ?? e).slice(0, 200) });
    }
  }

  // ─── /api/price-debug?sku=ARTICLE ── сырые поля цены по артикулу ───────────
  // Клиент регулярно показывает расхождение цены в кабинете с витриной, и
  // спорить об этом на скриншотах бесполезно: у обеих площадок несколько полей
  // цены, и какое из них соответствует витрине, зависит от акций. Этот эндпоинт
  // отдаёт ВСЕ поля как есть, из уже прогретого кэша — без нагрузки на площадки.
  // Нужен, чтобы такие вопросы закрывались фактом за один запрос.
  if (section === 'price-debug') {
    try {
      const sku = String(req.query.sku ?? '').trim().toUpperCase();
      if (!sku) return res.status(400).json({ ok: false, error: 'sku_required' });

      const wbKey = makeUpstreamCacheKey('wb:discounts', 'GET', 'api/v2/list/goods/filter', '?limit=1000', undefined);
      const ozKey = makeUpstreamCacheKey('ozon-seller', 'POST', 'v5/product/info/prices', '',
        JSON.stringify({ filter: { visibility: 'ALL' }, limit: 100 }));
      const [wbC, ozC] = await Promise.all([
        cacheGet<{ text: string }>(wbKey),
        cacheGet<{ text: string }>(ozKey),
      ]);

      const parse = <T,>(t: string | undefined, pick: (j: any) => T): T | null => {
        if (!t) return null;
        try { return pick(JSON.parse(t)); } catch { return null; }
      };
      const wbRow = parse(wbC?.data?.text, (j) =>
        (j?.data?.listGoods ?? []).find((g: any) => String(g?.vendorCode ?? '').trim().toUpperCase() === sku) ?? null);
      const ozRow = parse(ozC?.data?.text, (j) =>
        (j?.items ?? []).find((i: any) => String(i?.offer_id ?? '').trim().toUpperCase() === sku) ?? null);

      return res.status(200).json({
        ok: true,
        sku,
        wb: wbRow ? { raw: wbRow, warmedAt: wbC?.fetchedAt ?? null } : { raw: null, note: 'артикула нет в прогретых ценах WB' },
        ozon: ozRow ? { raw: ozRow, warmedAt: ozC?.fetchedAt ?? null } : { raw: null, note: 'артикула нет в прогретых ценах Ozon' },
      });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String((e as Error)?.message ?? e).slice(0, 200) });
    }
  }

  // ─── /api/settings ── правила расчёта (схема работы FBO/FBS) ───────────────
  if (section === 'settings') {
    try {
      const st = await import('./_lib/settings');
      if (req.method === 'POST') {
        const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body ?? {});
        return res.status(200).json({ ok: true, settings: st.setSettings(body?.settings ?? {}) });
      }
      return res.status(200).json({ ok: true, settings: st.getSettings() });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String((e as Error)?.message ?? e).slice(0, 200) });
    }
  }

  // ─── /api/repricer ── пороги и предложения по цене (этап 2) ────────────────
  // GET                    → настройки + предложения по всем товарам
  // POST { settings: {…} } → сохранить пороги
  //
  // Цены отсюда НИКОГДА не уходят в WB: модуль только считает и объясняет.
  // Автопростановка появится не раньше, чем клиент согласует пороги и отдельно
  // скажет, что готов доверить цены агенту (см. комментарий в _lib/repricer.ts).
  if (section === 'repricer') {
    try {
      const r = await import('./_lib/repricer');
      if (req.method === 'POST') {
        const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body ?? {});
        return res.status(200).json({ ok: true, settings: r.setSettings(body?.settings ?? {}) });
      }
      return res.status(200).json({ ok: true, ...(await r.buildSuggestions()) });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String((e as Error)?.message ?? e).slice(0, 200) });
    }
  }

  // ─── /api/bi ── ОПиУ, разложение рубля, ДДС, воронка ───────────────────────
  if (section === 'bi') {
    const days = Math.min(Math.max(Number(req.query.days) || 30, 7), 180);
    const noCache = req.headers['x-av-no-cache'] === '1';
    try {
      const { getBiSummary, getBiSummaryCached } = await import('./_lib/bi');
      // Ручное обновление ждёт расчёт, обычный заход — только кэш (иначе на
      // холодную страница висит на полном проходе по транзакциям).
      if (noCache) return res.status(200).json({ ok: true, ...(await getBiSummary(days, true)) });
      const cached = await getBiSummaryCached(days);
      return res.status(200).json(cached ? { ok: true, ...cached } : { ok: true, building: true });
    } catch (e) {
      return res.status(502).json({ ok: false, error: String((e as Error)?.message ?? e).slice(0, 200) });
    }
  }

  // ─── /api/penalties ── штрафы и удержания WB + Ozon ────────────────────────
  if (section === 'penalties') {
    const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 90);
    const noCache = req.headers['x-av-no-cache'] === '1';
    try {
      const { getPenalties, getPenaltiesCached } = await import('./_lib/penalties');
      if (noCache) return res.status(200).json({ ok: true, ...(await getPenalties(days, true)) });
      const cached = await getPenaltiesCached(days);
      return res.status(200).json(cached ? { ok: true, ...cached } : { ok: true, building: true });
    } catch (e) {
      return res.status(502).json({ ok: false, error: String((e as Error)?.message ?? e).slice(0, 200) });
    }
  }

  // ─── /api/ozon-sku-ads ── расход рекламы Ozon по каждому SKU (для ДРР) ──────
  if (section === 'ozon-sku-ads') {
    const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 90);
    const noCache = req.query.force === '1';
    try {
      const { getOzonSkuAds } = await import('./_lib/ozonSkuAds');
      return res.status(200).json({ ok: true, ...(await getOzonSkuAds(days, noCache)) });
    } catch (e) {
      return res.status(502).json({ ok: false, error: String((e as Error)?.message ?? e).slice(0, 200) });
    }
  }

  // ─── /api/wb-answer ── публикация ответа покупателю в WB ───────────────────
  // POST { id, text, kind?: 'question' | 'feedback' }.
  //   вопрос — PATCH /api/v1/questions { id, answer:{text}, state:'wbRu' }
  //   отзыв  — POST  /api/v1/feedbacks/answer { id, text }
  // Отзывы добавлены 09.09: у них не было кнопки отправки вообще — только
  // сгенерировать и скопировать руками (замечание клиента 06.09).
  if (section === 'wb-answer') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
    const body = typeof req.body === 'string' ? (() => { try { return JSON.parse(req.body); } catch { return {}; } })() : (req.body || {});
    const id = String(body.id || '').trim();
    const text = String(body.text || '').trim();
    const kind = body.kind === 'feedback' ? 'feedback' : 'question';
    if (!id || !text) return res.status(400).json({ ok: false, error: 'id_and_text_required' });
    try {
      const up = wbUpstream('feedbacks');
      const r = kind === 'feedback'
        ? await fetchWithRetry(`${up.base}/api/v1/feedbacks/answer`, {
            method: 'POST',
            headers: { ...up.headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({ id, text }),
          }, { maxRetries: 1, timeoutMs: 20_000 })
        : await fetchWithRetry(`${up.base}/api/v1/questions`, {
            method: 'PATCH',
            headers: { ...up.headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({ id, answer: { text }, state: 'wbRu' }),
          }, { maxRetries: 1, timeoutMs: 20_000 });
      const t = await r.text().catch(() => '');
      if (!r.ok) return res.status(r.status).json({ ok: false, error: t.slice(0, 300) || `WB ${r.status}` });
      return res.status(200).json({ ok: true });
    } catch (e) {
      return res.status(502).json({ ok: false, error: String((e as Error)?.message ?? e).slice(0, 200) });
    }
  }

  // ─── /api/ozon/* ─────────────────────────────────────────────────────────
  if (section === 'ozon') {
    return handleProxy(req, res, ozonUpstream(), rest.join('/'), 'ozon-seller');
  }

  // ─── /api/ozon-perf/* ────────────────────────────────────────────────────
  if (section === 'ozon-perf') {
    return handleOzonPerf(req, res, rest.join('/'));
  }

  // ─── /api/ozon-transit — транзит на склады Ozon FBO (в пути + на приёмке) ──
  // Серверная агрегация 3 методов supply-order (list→get→bundle) с часовым кэшем:
  // тяжёлую пагинацию не тащим в браузер, отдаём готовую карту offer_id→кол-во.
  if (section === 'ozon-transit') {
    try {
      const noCache = req.headers['x-av-no-cache'] === '1';
      const data = await getOzonTransit(noCache);
      res.setHeader('x-av-cache-age', String(Math.round((Date.now() - data.fetchedAt) / 1000)));
      return res.status(200).json(data);
    } catch (e: any) {
      return res.status(502).json({ error: 'ozon_transit_unreachable', detail: String(e?.message ?? e) });
    }
  }

  // ─── /api/ozon-buyer-prices — цена покупателя Ozon с СПП (из акций) ────────
  // Ozon убрал marketing_price из API; берём action_price из /v1/actions/products
  // (цена со скидкой площадки/соинвеста). Фронт использует вместо таблицы.
  if (section === 'ozon-buyer-prices') {
    try {
      const noCache = req.headers['x-av-no-cache'] === '1';
      const data = await getOzonBuyerPrices(noCache);
      res.setHeader('x-av-cache-age', String(Math.round((Date.now() - data.fetchedAt) / 1000)));
      return res.status(200).json(data);
    } catch (e: any) {
      return res.status(502).json({ error: 'ozon_buyer_prices_failed', detail: String(e?.message ?? e) });
    }
  }

  // ─── /api/wb-transit — транзит на склады WB FBW (в пути + на приёмке) ──────
  if (section === 'wb-transit') {
    try {
      const noCache = req.headers['x-av-no-cache'] === '1';
      const data = await getWbTransit(noCache);
      res.setHeader('x-av-cache-age', String(Math.round((Date.now() - data.fetchedAt) / 1000)));
      return res.status(200).json(data);
    } catch (e: any) {
      return res.status(502).json({ error: 'wb_transit_unreachable', detail: String(e?.message ?? e) });
    }
  }

  // ─── /api/ozon-prices — цены и комиссии Ozon, склеенные сборщиком ──────────
  // Браузер раньше листал v5/product/info/prices сам, и страницы у Ozon плывут:
  // товар попадал в выдачу по 9 раз (жалоба клиента 07.09), а часть пропадала.
  // Единый источник — склейка сборщика под каноническим ключом, без дублей.
  if (section === 'ozon-prices') {
    const key = makeUpstreamCacheKey('ozon-seller', 'POST', 'v5/product/info/prices', '',
      JSON.stringify({ filter: { visibility: 'ALL' }, limit: 100 }));
    const c = await cacheGet<{ text: string; status: number }>(key);
    if (!c?.data?.text) return res.status(503).json({ ok: false, error: 'цены Ozon ещё не прогреты' });
    res.setHeader('x-av-cache-age', String(Math.round((Date.now() - c.fetchedAt) / 1000)));
    res.setHeader('content-type', 'application/json');
    return res.status(200).send(c.data.text);
  }

  // ─── /api/wb-showcase — живая витринная цена WB по своим nmId ─────────────
  // Снимается с публичной карточки card.wb.ru (там СПП есть, в Seller API — нет).
  // Первая ступень «цены покупателя» на экране цен; см. _lib/wbShowcase.ts.
  if (section === 'wb-showcase') {
    try {
      const { getWbShowcase, collectWbShowcase } = await import('./_lib/wbShowcase');
      const force = req.headers['x-av-no-cache'] === '1';
      const data = force ? await collectWbShowcase() : (await getWbShowcase());
      if (!data) return res.status(200).json({ ok: true, items: {}, count: 0, requested: 0, fetchedAt: null, error: 'витрина ещё не снята — ждём прогрев' });
      res.setHeader('x-av-cache-age', String(Math.round((Date.now() - data.fetchedAt) / 1000)));
      return res.status(200).json({ ok: true, ...data });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String((e as Error)?.message ?? e).slice(0, 200) });
    }
  }

  // ---- /api/wb-showcase-ingest — принять цены с витрины WB, собранные вручную браузером ————
  // ---- /api/ozon-showcase — витрина Ozon (см. wb-showcase — тот же принцип) ----
  if (section === 'ozon-showcase') {
    try {
      const { getOzonShowcase } = await import('./_lib/ozonShowcase');
      const data = await getOzonShowcase();
      if (!data) return res.status(200).json({ ok: true, items: {}, count: 0, requested: 0, fetchedAt: null, error: 'витрина Ozon ещё не снята' });
      res.setHeader('x-av-cache-age', String(Math.round((Date.now() - data.fetchedAt) / 1000)));
      return res.status(200).json({ ok: true, ...data });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String((e as Error)?.message ?? e).slice(0, 200) });
    }
  }

  // ---- /api/ozon-showcase-ingest — принять цены с витрины Ozon, собранные вручную браузером ----
  if (section === 'ozon-showcase-ingest') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
    try {
      const { ingestOzonShowcase } = await import('./_lib/ozonShowcase');
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body ?? {});
      const items = (body?.items ?? {}) as Record<string, { price: number; oldPrice?: number }>;
      const data = await ingestOzonShowcase(items);
      try { (await import('./_lib/showcaseRequest')).clearShowcaseRequest('ozon'); } catch { /* флаг не критичен */ }
      return res.status(200).json({ ok: true, received: Object.keys(items).length, ...data });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String((e as Error)?.message ?? e).slice(0, 200) });
    }
  }

  if (section === 'wb-showcase-ingest') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
    try {
      const { ingestWbShowcase } = await import('./_lib/wbShowcase');
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body ?? {});
      const items = (body?.items ?? {}) as Record<string, { price: number; oldPrice?: number }>;
      const data = await ingestWbShowcase(items);
      try { (await import('./_lib/showcaseRequest')).clearShowcaseRequest('wb'); } catch { /* флаг не критичен */ }
      return res.status(200).json({ ok: true, received: Object.keys(items).length, ...data });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String((e as Error)?.message ?? e).slice(0, 200) });
    }
  }

  // ─── /api/wb-buyer-prices — цена покупателя с СПП по nmId (из продаж) ──────
  // Считается из прогретого кэша продаж (finishedPrice), в WB не ходит. Фронт
  // берёт отсюда «цену покупателя с СПП» вместо отстающей таблицы.
  if (section === 'wb-buyer-prices') {
    try {
      const noCache = req.headers['x-av-no-cache'] === '1';
      const data = await getWbBuyerPrices(noCache);
      res.setHeader('x-av-cache-age', String(Math.round((Date.now() - data.fetchedAt) / 1000)));
      return res.status(200).json(data);
    } catch (e: any) {
      return res.status(502).json({ error: 'wb_buyer_prices_failed', detail: String(e?.message ?? e) });
    }
  }

  // ─── /api/ozon-fact — факт-прибыль Ozon из финансовых операций (как у КАН) ──
  if (section === 'ozon-fact') {
    try {
      const noCache = req.headers['x-av-no-cache'] === '1';
      const data = await getOzonFactProfit(noCache);
      res.setHeader('x-av-cache-age', String(Math.round((Date.now() - data.fetchedAt) / 1000)));
      return res.status(200).json(data);
    } catch (e: any) {
      return res.status(502).json({ error: 'ozon_fact_failed', detail: String(e?.message ?? e) });
    }
  }

  // ─── /api/wb-card-econ — комиссия + объём по nmId (полный обход карточек) ───
  if (section === 'wb-card-econ') {
    try {
      const noCache = req.headers['x-av-no-cache'] === '1';
      const data = await getWbCardEcon(noCache);
      res.setHeader('x-av-cache-age', String(Math.round((Date.now() - data.fetchedAt) / 1000)));
      return res.status(200).json(data);
    } catch (e: any) {
      return res.status(502).json({ error: 'wb_card_econ_failed', detail: String(e?.message ?? e) });
    }
  }

  // ─── /api/wb-box-tariffs — тарифы логистики/хранения WB (tariffs/box) ──────
  if (section === 'wb-box-tariffs') {
    try {
      const noCache = req.headers['x-av-no-cache'] === '1';
      const data = await getWbBoxTariffs(noCache);
      res.setHeader('x-av-cache-age', String(Math.round((Date.now() - data.fetchedAt) / 1000)));
      return res.status(200).json(data);
    } catch (e: any) {
      return res.status(502).json({ error: 'wb_box_tariffs_failed', detail: String(e?.message ?? e) });
    }
  }

  // ─── /api/showcase-check — кнопка «Проверить цены на витрине» (флаг для Routine) ───
  if (section === 'showcase-check') {
    try {
      const sr = await import('./_lib/showcaseRequest');
      if (req.method === 'POST') {
        const body = (typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body ?? {})) as { mp?: unknown; pin?: unknown };
        // Пароль кнопки (SHOWCASE_PIN в .env): чтобы сотрудники не дёргали проверку просто так.
        const needPin = (process.env.SHOWCASE_PIN || '').trim();
        if (needPin && String(body.pin ?? '').trim() !== needPin) return res.status(403).json({ ok: false, error: 'bad_pin' });
        const mp = body.mp === 'wb' || body.mp === 'ozon' ? body.mp : 'all';
        sr.requestShowcaseCheck(mp);
      }
      const [{ getWbShowcase }, { getOzonShowcase }] = await Promise.all([import('./_lib/wbShowcase'), import('./_lib/ozonShowcase')]);
      const [wbS, ozS] = await Promise.all([getWbShowcase().catch(() => null), getOzonShowcase().catch(() => null)]);
      const pending = sr.getShowcaseRequest();
      // fetchedAt перезаписывает и неудачная серверная попытка (0 товаров, 403), поэтому берём максимум `at` по товарам.
      const lastAt = (sc: any): number | null => { let m = 0; for (const it of Object.values(sc?.items ?? {}) as any[]) if (Number(it?.at) > m) m = Number(it.at); return m || (sc?.fetchedAt ?? null); };
      const lastCheck = { wb: lastAt(wbS), ozon: lastAt(ozS) };
      // run: ТОЛЬКО принудительный запрос кнопкой (18.09.2026) — автосверку по давности снимка убрали.
      const run = { wb: !!pending.wb, ozon: !!pending.ozon };
      res.setHeader('cache-control', 'no-store');
      return res.status(200).json({ ok: true, pending, lastCheck, run });
    } catch (e: any) {
      return res.status(500).json({ ok: false, error: 'showcase_check_failed', detail: String(e?.message ?? e).slice(0, 200) });
    }
  }

  // ─── /api/ui-state — общая память интерфейса для всех пользователей (архив, глобальные параметры, сценарии) ───
  if (section === 'ui-state') {
    try {
      const ui = await import('./_lib/uiState');
      if (req.method === 'POST') {
        const body = (typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body ?? {})) as { key?: unknown; value?: unknown };
        if (!ui.validUiKey(body.key) || !ui.validUiValue(body.value)) return res.status(400).json({ ok: false, error: 'bad_key_or_value' });
        const st = ui.setUiState(body.key, body.value);
        return res.status(200).json({ ok: true, rev: st.rev, state: st.state });
      }
      const st = ui.getUiState();
      res.setHeader('cache-control', 'no-store');
      return res.status(200).json({ ok: true, rev: st.rev, state: st.state });
    } catch (e: any) {
      return res.status(500).json({ ok: false, error: 'ui_state_failed', detail: String(e?.message ?? e).slice(0, 200) });
    }
  }

  // ─── /api/logistics-fact — факт прямой/обратной логистики по артикулам (16.09.2026) ───
  // WB: finance-api sales-reports/detailed; Ozon: v1/finance/accrual/postings. force=1 — пересобрать.
  if (section === 'logistics-fact') {
    try {
      const { getLogisticsFact } = await import('./_lib/logisticsFact');
      const data = await getLogisticsFact(req.query.force === '1');
      res.setHeader('x-av-cache-age', String(Math.round((Date.now() - data.fetchedAt) / 1000)));
      return res.status(200).json({ ok: true, ...data });
    } catch (e: any) {
      return res.status(502).json({ ok: false, error: 'logistics_fact_failed', detail: String(e?.message ?? e).slice(0, 200) });
    }
  }

  // ─── /api/wb-stock — фактические остатки WB по складам (statistics-api) ───
if (section === 'wb-stock') {
  try {
    const noCache = req.headers['x-av-no-cache'] === '1';
    const data = await getWbStock(noCache);
    res.setHeader('x-av-cache-age', String(Math.round((Date.now() - data.fetchedAt) / 1000)));
    return res.status(200).json(data);
  } catch (e: any) {
    return res.status(502).json({ error: 'wb_stock_failed', detail: String(e?.message ?? e) });
  }
}

// ─── /api/wb-commissions — комиссия WB по предметам (tariffs/commission) ────
  // Компактная карта { subjectID: комиссия% }. Фронт матчит по card.subjectID и
  // подставляет реальную комиссию в калькулятор прибыли вместо ручного ввода.
  if (section === 'wb-commissions') {
    try {
      const noCache = req.headers['x-av-no-cache'] === '1';
      const data = await getWbCommissions(noCache);
      res.setHeader('x-av-cache-age', String(Math.round((Date.now() - data.fetchedAt) / 1000)));
      return res.status(200).json(data);
    } catch (e: any) {
      return res.status(502).json({ error: 'wb_commissions_failed', detail: String(e?.message ?? e) });
    }
  }

  // ─── /api/wb-supplies — журнал поставок на склад WB (даты, статус приёмки) ──
  // Источник — supplies-api (старый statistics /api/v1/supplies удалён WB 06.2026).
  if (section === 'wb-supplies') {
    try {
      const noCache = req.headers['x-av-no-cache'] === '1';
      const data = await getWbSupplies(noCache);
      res.setHeader('x-av-cache-age', String(Math.round((Date.now() - data.fetchedAt) / 1000)));
      return res.status(200).json(data);
    } catch (e: any) {
      return res.status(502).json({ error: 'wb_supplies_unreachable', detail: String(e?.message ?? e) });
    }
  }

  // ─── /api/ai/* ───────────────────────────────────────────────────────────
  if (section === 'ai') {
    // /api/ai/health — статус ключа Anthropic.
    // Раньше отвечал по наличию переменной окружения, то есть «ключ прописан».
    // Клиенту это ничего не говорило: когда кончились кредиты, health показывал
    // «всё хорошо», а каждый ИИ-блок отдавал 400. Теперь делаем дешёвый живой
    // запрос (ответ на один токен) и кэшируем результат на 10 минут.
    if (rest[0] === 'health') {
      const st = await pingAnthropic(req.query.force === '1');
      return res.status(200).json({
        ok: st.state === 'ok',
        configured: st.state !== 'not_configured',
        state: st.state,
        detail: st.detail,
        model: st.model,
        checkedAt: st.checkedAt,
        // Ссылка на консоль — единственное место, где виден остаток кредитов:
        // по API Anthropic его не отдаёт (см. комментарий в _lib/anthropic.ts).
        consoleUrl: 'https://console.anthropic.com/settings/billing',
      });
    }
    // /api/ai/usage — статистика реальных трат.
    if (rest[0] === 'usage') {
      const days = Math.min(Math.max(Number(req.query.days) || 7, 1), 90);
      const recent = await readRecentAgg(days);
      const today = recent[recent.length - 1] || null;
      const limitRub = getDailyLimitRub();
      const fx = getUsdRate();
      return res.status(200).json({
        ok: true,
        limitRub,
        today,
        days: recent,
        totalRub: recent.reduce((s, d) => s + d.totalCostRub, 0),
        // Счёт Anthropic выставляется в долларах: эта цифра не зависит от курса
        // и не меняется задним числом, поэтому показываем обе.
        totalUsd: recent.reduce((s, d) => s + (d.totalCostUsd ?? 0), 0),
        totalRequests: recent.reduce((s, d) => s + d.totalRequests, 0),
        // Каким курсом посчитаны рубли и откуда он взят — чтобы подпись под
        // суммой отличала курс ЦБ на сегодня от последнего известного.
        fx: { rub: fx.rub, source: fx.source, at: fx.at },
      });
    }
    return handleAi(req, res, rest[0]);
  }

  // ─── /api/wb-public/* ────────────────────────────────────────────────────
  if (section === 'wb-public') {
    return handleWbPublic(req, res, rest);
  }

  // ─── /api/competitors/* — единый парсер конкурентов WB + Ozon ─────────────
  if (section === 'competitors') {
    return handleCompetitors(req, res, rest);
  }

  // ─── /api/positions?q=<запрос>&nm=<nmId> — позиция своего товара в выдаче WB ─
  if (section === 'positions') {
    const q = String(req.query.q || '').trim();
    const nm = Number(req.query.nm);
    if (!q || !Number.isFinite(nm)) return res.status(400).json({ error: 'q_and_nm_required' });
    try {
      const rank = await wbSearchRank(q, nm, 5);
      return res.status(200).json({ ok: true, ...rank });
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      const limited = msg.includes('rate_limited');
      return res.status(limited ? 503 : 502).json({
        error: limited ? 'wb_search_rate_limited' : 'positions_failed',
        detail: limited ? 'WB временно ограничил поиск — повторите через минуту.' : msg,
      });
    }
  }

  // ─── /api/meta/* ─────────────────────────────────────────────────────────
  if (section === 'meta') {
    return handleMeta(req, res, rest[0]);
  }

  // ─── /api/history/* ──────────────────────────────────────────────────────
  // Последний снимок дня из SQLite + ряд по дням (для трендов). Фронт читает
  // отсюда, когда живой кэш WB пуст (лимит 429) — чтобы цифры не «пропадали».
  if (section === 'history') {
    if (rest[0] === 'latest') {
      const latest = getLatestSnapshot();
      return res.status(200).json({ ok: true, latest });
    }
    if (rest[0] === 'series') {
      const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 180);
      return res.status(200).json({ ok: true, series: getSnapshotSeries(days) });
    }
    // База знаний по площадкам: тезисы, которые копят агенты 6/7 и новостной.
    if (rest[0] === 'knowledge') {
      const { getTheses } = await import('./_lib/agents/knowledgeBase');
      const mpRaw = String(req.query.mp ?? '');
      const mp = mpRaw === 'wb' || mpRaw === 'ozon' ? mpRaw : undefined;
      const days = Number(req.query.days) || undefined;
      return res.status(200).json({ ok: true, items: getTheses({ mp, days, limit: 200 }) });
    }
    // Дневной ряд выручки WB для графика «Заказано по дням».
    //
    // Ряд наполнялся из АСИНХРОННОГО отчёта WB, а тот стабильно возвращает
    // FAILED (проверено 23.07 на разных диапазонах — сломан движок отчётов на
    // стороне WB, не наш запрос). Мы перешли на синхронную воронку, а у неё
    // разбивки по дням нет, поэтому ряда сейчас нет вообще.
    //
    // Отвечаем об этом ЯВНО, а не пустым массивом с ok:true: пустой график без
    // объяснения читается как «продаж не было», и это ровно тот случай, где
    // подставленная пустота дороже честной надписи.
    if (rest[0] === 'wb-daily') {
      const c = await cacheGet<{ series: { date: string; revenue: number; orders: number }[]; maxDt: string }>(WB_DAILY_KEY);
      const series = c?.data?.series ?? [];
      return res.status(200).json({
        ok: true,
        series,
        maxDt: c?.data?.maxDt ?? null,
        reason: series.length ? undefined
          : 'Разбивки по дням у WB сейчас нет: асинхронный отчёт со стороны WB не собирается, а синхронная воронка отдаёт только итог за период.',
      });
    }
    return res.status(404).json({ error: 'history_action_not_found' });
  }

  return res.status(404).json({ error: 'unknown_api_section', section });
}

// ────────────────────────────────────────────────────────────────────────────
// Meta — статус кэша и last-updated
// ────────────────────────────────────────────────────────────────────────────
const META_NAMESPACES = [
  'wb:common', 'wb:content', 'wb:statistics', 'wb:feedbacks',
  'wb:discounts', 'wb:promotion', 'wb:analytics', 'wb:supplies', 'wb:finance',
  'ozon-seller', 'ozon-perf',
];

async function handleMeta(_req: VercelRequest, res: VercelResponse, action: string | undefined) {
  if (action !== 'status') return res.status(404).json({ error: 'meta_action_not_found' });

  const entries = await Promise.all(META_NAMESPACES.map(async ns => {
    const marker = await cacheGet<{ at: number; count: number }>(makeCacheKey('meta', 'freshness', ns));
    // ВОЗРАСТ САМИХ ДАННЫХ, а не отметки прогрева. Клиент 11.08 сравнил наши
    // цифры с кабинетом: у нас 122 тыс против 158 у WB и 487 против 515 у Ozon,
    // при плашке «обновлено 3 минуты назад». Плашка показывала момент, когда
    // сборщик В ЦЕЛОМ отработал по namespace, а конкретный датасет мог быть
    // снят часами раньше — выручка за день только растёт, поэтому мы всегда
    // выглядели «ниже кабинета» без объяснения.
    const newest = cacheGetNewestByPrefix<unknown>(ns);
    return [ns, marker || newest
      ? {
          lastRefreshAt: marker?.data.at ?? 0,
          freshness: marker?.data.count ?? 0,
          dataAt: newest?.fetchedAt ?? null,
        }
      : null] as const;
  }));

  const status: Record<string, { lastRefreshAt: number; freshness: number; dataAt?: number | null } | null> = {};
  for (const [ns, v] of entries) status[ns] = v;

  return res.status(200).json({
    ok: true,
    now: Date.now(),
    // Расписание было зашито как 'daily' и «раз в сутки» — при том, что сборщик
    // ходит каждые 2 часа (server.ts scheduleCacheWarm). Клиент читает именно эту
    // плашку, поэтому она не должна расходиться с реальностью.
    cronSchedule: 'every-2h',
    cronIntervalMs: CRON_WARM_INTERVAL_MS,
    cronSource: 'Свой сервер (Москва): фоновый сборщик каждые 2 часа, идемпотентно — свежее не перезапрашивает',
    namespaces: status,
  });
}
