/**
 * Сборщик контекста для AI-копилота.
 *
 * Главный принцип: НЕ дёргаем апстрим WB/Ozon из чата (это сделает их 429 ещё
 * чаще). Берём то, что cron уже прогрел в KV-кэше — продажи, остатки, цены,
 * рекламные кампании, отзывы. Получаем компактный JSON, который пакуем в
 * system-промпт Claude через prompt caching.
 *
 * Контекст обновляется максимум раз в 30 минут (server-side кэш контекста).
 */
import { cacheGet, cacheSet, makeCacheKey, makeUpstreamCacheKey, makeUpstreamCachePrefix, cacheGetNearestWindow, windowKeyFor } from './cache';
import { getLatestSnapshot } from './history';
import { mskDate } from './mskDate';

export type SnapshotContext = {
  generatedAt: number;
  period: { begin: string; end: string };
  ozon: {
    revenue: number;
    orders: number;
    avgCheck: number;
    daily: number[];
    productsCount: number;
  } | null;
  wb: {
    productsCount: number;
    revenueWeek: number;
    ordersWeek: number;
    avgCheckWeek: number;
  } | null;
  topProducts: Array<{ sku: string; name: string; revenue?: number; orders?: number; mp: 'wb' | 'ozon' }>;
  reviews: {
    unanswered: number;
    archive: number;
    recent: Array<{ rating: number; text: string; product?: string; date: string }>;
  } | null;
  questions: { unanswered: number } | null;
  ads: {
    wbActive: number;
    wbTotal: number;
    ozonActive: number;
  } | null;
  // Пометки «данные из истории» (если живой кэш пуст, взяли последнюю строку БД).
  ozonStaleFrom?: string;
  wbStaleFrom?: string;
};

const CONTEXT_TTL_MS = 30 * 60_000;
const CONTEXT_KEY = makeCacheKey('ai-context', 'snapshot');

// Даты — по Москве, как у сборщика (route.ts). Иначе ключи кэша не совпадают
// и снимок для бота/копилота приходит пустым на ночной границе суток.
const iso = (back: number) => mskDate(back);

/** Тихо достаёт JSON из кэша прокси, не падая на отсутствии.
 *  Сначала точный ключ (то же окно дат), затем — ближайшее окно ТОЙ ЖЕ ДЛИНЫ.
 *  Длину менять нельзя: раньше fallback брал свежайший снимок по префиксу, и
 *  копилот мог назвать месячную выручку недельной — все окна одного эндпоинта
 *  лежат под общим префиксом. Клиент как раз жаловался, что цифры у агента
 *  расходятся с разделами. */
async function readProxyCache<T>(ns: string, method: 'GET' | 'POST', path: string, qs = '', body?: any): Promise<T | null> {
  const bodyStr = body ? JSON.stringify(body) : undefined;
  const key = makeUpstreamCacheKey(ns, method, path, qs, bodyStr);
  let cached = await cacheGet<{ status: number; ct: string; text: string }>(key);
  if (!cached || cached.data.status >= 400) {
    const prefix = makeUpstreamCachePrefix(ns, method, path, qs, bodyStr);
    const near = cacheGetNearestWindow<{ status: number; ct: string; text: string }>(prefix, windowKeyFor(qs, bodyStr));
    if (near && near.entry.data.status < 400) cached = near.entry;
  }
  if (!cached || cached.data.status >= 400) return null;
  try { return JSON.parse(cached.data.text) as T; } catch { return null; }
}

export async function buildSnapshot(force = false): Promise<SnapshotContext> {
  if (!force) {
    const cached = await cacheGet<SnapshotContext>(CONTEXT_KEY);
    if (cached && Date.now() - cached.fetchedAt < CONTEXT_TTL_MS) return cached.data;
  }

  const today = 0;
  const week = 7;
  const period = { begin: iso(week), end: iso(today) };

  // ── Ozon analytics за неделю ──
  let ozon: SnapshotContext['ozon'] = null;
  // Тот же НАБОР метрик/dimension, что прогревает cron (ozAnalytics: day,
  // ordered_units+revenue) — иначе префикс кэша не совпадёт и снимок будет пустым.
  // Порядок метрик в ключе нормализуется (sort), но набор должен совпадать.
  const ozonBody = { date_from: iso(week), date_to: iso(today), metrics: ['ordered_units', 'revenue'], dimension: ['day'], limit: 1000 };
  const ozonRaw = await readProxyCache<any>('ozon-seller', 'POST', 'v1/analytics/data', '', ozonBody);
  if (ozonRaw?.result?.data) {
    const rows = ozonRaw.result.data as { metrics: number[] }[];
    const orders = rows.reduce((s, x) => s + (x.metrics[0] ?? 0), 0);
    const revenue = rows.reduce((s, x) => s + (x.metrics[1] ?? 0), 0);
    ozon = {
      revenue, orders,
      avgCheck: orders > 0 ? Math.round(revenue / orders) : 0,
      daily: rows.map(x => x.metrics[1] ?? 0),
      productsCount: 0,
    };
  }
  // Количество товаров Ozon отдельно
  const ozonProducts = await readProxyCache<any>('ozon-seller', 'POST', 'v3/product/info/list', '', { product_id: [], offer_id: [], sku: [] });
  if (ozonProducts?.items && ozon) ozon.productsCount = ozonProducts.items.length;

  // ── WB Sales Funnel v3 за неделю ──
  let wb: SnapshotContext['wb'] = null;
  const wbBody = {
    period: { start: iso(week), end: iso(today) },
    timezone: 'Europe/Moscow', limit: 200, offset: 0,
    brandNames: [], subjectIDs: [], tagIDs: [], nmIDs: [],
    orderBy: { field: 'ordersSumRub', mode: 'desc' },
  };
  const wbRaw = await readProxyCache<any>('wb:analytics', 'POST', 'api/analytics/v3/sales-funnel/products', '', wbBody);
  const wbCards = wbRaw?.data?.cards as any[] | undefined;
  if (wbCards) {
    let revenue = 0, orders = 0;
    for (const c of wbCards) {
      const p = c.statistics?.selectedPeriod;
      if (p) { revenue += p.ordersSumRub ?? 0; orders += p.ordersCount ?? 0; }
    }
    wb = {
      productsCount: wbCards.length,
      revenueWeek: revenue,
      ordersWeek: orders,
      avgCheckWeek: orders > 0 ? Math.round(revenue / orders) : 0,
    };
  }

  // ── Топ-10 товаров (WB по выручке) ──
  const topProducts: SnapshotContext['topProducts'] = [];
  if (wbCards) {
    const sorted = [...wbCards].sort((a, b) =>
      (b.statistics?.selectedPeriod?.ordersSumRub ?? 0) - (a.statistics?.selectedPeriod?.ordersSumRub ?? 0)
    );
    for (const c of sorted.slice(0, 10)) {
      const p = c.statistics?.selectedPeriod;
      topProducts.push({
        sku: String(c.nmID),
        name: `${c.brandName ?? ''} ${c.object?.name ?? c.vendorCode ?? ''}`.trim() || c.vendorCode,
        revenue: p?.ordersSumRub,
        orders: p?.ordersCount,
        mp: 'wb',
      });
    }
  }

  // ── Отзывы WB ──
  let reviews: SnapshotContext['reviews'] = null;
  const fbRaw = await readProxyCache<any>('wb:feedbacks', 'GET', 'api/v1/feedbacks', '?isAnswered=false&take=50&skip=0');
  if (fbRaw?.data) {
    reviews = {
      unanswered: fbRaw.data.countUnanswered ?? 0,
      archive: fbRaw.data.countArchive ?? 0,
      recent: ((fbRaw.data.feedbacks ?? []) as any[]).slice(0, 10).map(f => ({
        rating: f.productValuation ?? 0,
        text: String(f.text ?? '').slice(0, 200),
        product: f.productDetails?.productName,
        date: f.createdDate,
      })),
    };
  }

  // ── Вопросы о товаре WB ──
  let questions: SnapshotContext['questions'] = null;
  const qRaw = await readProxyCache<any>('wb:feedbacks', 'GET', 'api/v1/questions', '?isAnswered=false&take=50&skip=0');
  if (qRaw?.data) {
    questions = { unanswered: qRaw.data.countUnanswered ?? (qRaw.data.questions?.length ?? 0) };
  }

  // ── Реклама ──
  let ads: SnapshotContext['ads'] = null;
  const wbAdv = await readProxyCache<any>('wb:promotion', 'GET', 'adv/v1/promotion/count');
  if (Array.isArray(wbAdv?.adverts)) {
    let total = 0, active = 0;
    for (const group of wbAdv.adverts) {
      total += group.count ?? 0;
      if (group.status === 9) active += group.count ?? 0; // 9 = идёт
    }
    ads = { wbTotal: total, wbActive: active, ozonActive: 0 };
  }

  // ── Fallback на историю (БД): если живой кэш по площадке пуст, берём последнюю
  // сохранённую строку, чтобы сайт/бот показали цифру «на дату X», а не «прогрев». ──
  let ozonStaleFrom: string | undefined;
  let wbStaleFrom: string | undefined;
  if (!ozon || !wb || !reviews || !ads) {
    const last = getLatestSnapshot();
    if (last) {
      if (!ozon && last.ozonRevenue != null) {
        ozon = {
          revenue: last.ozonRevenue, orders: last.ozonOrders ?? 0,
          avgCheck: last.ozonOrders ? Math.round(last.ozonRevenue / last.ozonOrders) : 0,
          daily: [], productsCount: last.ozonProducts ?? 0,
        };
        ozonStaleFrom = last.date;
      }
      if (!wb && last.wbRevenue != null) {
        wb = {
          productsCount: last.wbProducts ?? 0,
          revenueWeek: last.wbRevenue, ordersWeek: last.wbOrders ?? 0,
          avgCheckWeek: last.wbOrders ? Math.round(last.wbRevenue / last.wbOrders) : 0,
        };
        wbStaleFrom = last.date;
      }
      if (!reviews && last.reviewsUnanswered != null) {
        reviews = { unanswered: last.reviewsUnanswered, archive: last.reviewsArchive ?? 0, recent: [] };
      }
      if (!ads && last.adsTotal != null) {
        ads = { wbTotal: last.adsTotal, wbActive: last.adsActive ?? 0, ozonActive: 0 };
      }
    }
  }

  const snap: SnapshotContext = {
    generatedAt: Date.now(),
    period,
    ozon, wb, topProducts, reviews, ads, questions,
    ozonStaleFrom, wbStaleFrom,
  };
  await cacheSet(CONTEXT_KEY, snap, CONTEXT_TTL_MS);
  return snap;
}

/** Сериализовать контекст в компактный markdown-блок для системного промпта. */
export function formatContextForPrompt(snap: SnapshotContext): string {
  const lines: string[] = [];
  lines.push(`# Контекст бизнеса ИП Алешко на ${new Date(snap.generatedAt).toLocaleString('ru-RU')}`);
  lines.push(`Ниша: автотовары и аксессуары для CarPlay (адаптеры, Android-магнитолы, видеорегистраторы, держатели, FM-трансмиттеры, антирадары).`);
  lines.push(`Период данных: ${snap.period.begin} → ${snap.period.end} (последние 7 дней).`);
  lines.push('');

  if (snap.ozon) {
    lines.push(`## Ozon за неделю`);
    lines.push(`- Выручка: ${snap.ozon.revenue.toLocaleString('ru-RU')} ₽`);
    lines.push(`- Заказы: ${snap.ozon.orders}`);
    lines.push(`- Средний чек: ${snap.ozon.avgCheck.toLocaleString('ru-RU')} ₽`);
    lines.push(`- Товаров в кабинете: ${snap.ozon.productsCount}`);
    lines.push(`- По дням: ${snap.ozon.daily.map(v => Math.round(v).toLocaleString('ru-RU')).join(', ')}`);
    lines.push('');
  }
  if (snap.wb) {
    lines.push(`## Wildberries за неделю`);
    lines.push(`- Выручка: ${snap.wb.revenueWeek.toLocaleString('ru-RU')} ₽`);
    lines.push(`- Заказы: ${snap.wb.ordersWeek}`);
    lines.push(`- Средний чек: ${snap.wb.avgCheckWeek.toLocaleString('ru-RU')} ₽`);
    lines.push(`- Карточек с продажами: ${snap.wb.productsCount}`);
    lines.push('');
  }
  if (snap.topProducts.length) {
    lines.push(`## Топ товары по выручке (за неделю)`);
    for (const p of snap.topProducts) {
      lines.push(`- [${p.mp.toUpperCase()}] ${p.name} (sku ${p.sku}): ${(p.revenue ?? 0).toLocaleString('ru-RU')} ₽, ${p.orders ?? 0} заказов`);
    }
    lines.push('');
  }
  if (snap.reviews) {
    lines.push(`## Отзывы WB`);
    lines.push(`- Неотвеченных: ${snap.reviews.unanswered}, в архиве: ${snap.reviews.archive}`);
    if (snap.reviews.recent.length) {
      lines.push(`- Последние неотвеченные:`);
      for (const r of snap.reviews.recent.slice(0, 6)) {
        lines.push(`  · ${r.rating}★ «${r.text.slice(0, 120)}»${r.product ? ` (${r.product})` : ''}`);
      }
    }
    lines.push('');
  }
  if (snap.ads) {
    lines.push(`## Реклама WB`);
    lines.push(`- Кампаний всего: ${snap.ads.wbTotal}, активных: ${snap.ads.wbActive}`);
    lines.push('');
  }

  return lines.join('\n');
}
