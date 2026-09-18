// Реальные вызовы к WB и Ozon через vite dev-proxy.
// Это работает в dev-режиме; на проде такая же логика переедет на backend,
// чтобы не светить ключи в браузере.

import { wbFetch } from './wbQueue';
import { mskDate } from '../utils/mskDate';
import { noteSwallowed } from '../utils/log';

async function json<T>(res: Response): Promise<T> {
  const text = await res.text();
  if (res.status === 503 && text.includes('warming_up')) {
    throw new Error('Данные ещё загружаются фоновым сборщиком — обновятся автоматически.');
  }
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 300)}`);
  }
  try { return JSON.parse(text) as T; } catch { return text as any; }
}

// ───────── WB (через очередь с кэшем) ─────────

export type WbSellerInfo = { name: string; sid: string; tradeMark: string };

export async function wbSellerInfo(): Promise<WbSellerInfo> {
  return wbFetch<WbSellerInfo>('/wb/common/api/v1/seller-info');
}

export type WbCard = {
  nmID: number;
  imtID: number;
  vendorCode: string;
  title: string;
  subjectID?: number;
  subjectName?: string;
  brand?: string;
  // Габариты упаковки (см) — из content API. Литраж = W×H×L/1000 для тарифа логистики.
  dimensions?: { width?: number; height?: number; length?: number; weightBrutto?: number };
  photos?: { big?: string; c246x328?: string }[];
  createdAt?: string;
  updatedAt?: string;
};

/**
 * Каталог карточек WB: фото, названия, габариты.
 *
 * Возвращает ВЕСЬ каталог, а не первые `limit` карточек. У WB `cards/list`
 * отдаёт максимум 100 за запрос и листается курсором, но листает за нас сборщик
 * на сервере: он склеивает все страницы и кладёт результат под ключом запроса с
 * `limit: 100`. Браузеру остаётся один запрос.
 *
 * Поэтому `limit` здесь — часть ключа кэша, а не размер выборки, и менять его
 * нельзя: с другим значением получится ключ, который никто не греет, а WB-прокси
 * работает в режиме cron-only и на промах отвечает 503 «прогрев».
 */
const WB_CARDS_CACHE_LIMIT = 100;

export async function wbCardsList(limit = WB_CARDS_CACHE_LIMIT, force = false): Promise<{ cards: WbCard[]; total: number }> {
  const body = {
    settings: {
      cursor: { limit },
      filter: { withPhoto: -1 },
    },
  };
  const data = await wbFetch<{ cards: WbCard[]; cursor?: { total: number } }>('/wb/content/content/v2/get/cards/list', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, force);
  return { cards: data.cards ?? [], total: data.cursor?.total ?? data.cards?.length ?? 0 };
}

/**
 * Подсчёт количества карточек в кабинете.
 * Сборщик склеивает все страницы каталога и проставляет `cursor.total` по факту
 * собранного, поэтому число точное и на каталогах больше 100 карточек. Раньше
 * тут был потолок в 100: WB возвращал `total` не всегда, и счётчик врал.
 */
export async function wbCardsCount(force = false): Promise<number> {
  // Возвращаем 0 при сбое, а не бросаем: счётчик карточек не должен ронять
  // расчёты, которым он лишь дополнение (выручка/KPI считаются из воронки).
  try {
    const { cards, total } = await wbCardsList(100, force);
    return total > 0 ? total : cards.length;
  } catch { return 0; }
}

export type WbPriceRow = {
  nmId: number;
  vendorCode: string;
  currencyIsoCode4217: string;
  sizes: { price: number; discountedPrice: number; clubDiscountedPrice?: number; techSizeName: string }[];
  discount: number;
  editableSizePrice: boolean;
};

// limit=1000 — максимум list/goods/filter за один запрос. Раньше стоял 100 и хвост
// каталога (POLFAR, одежда и т.п.) обрезался — товаров у клиента больше 100.
// БЕЗОПАСНОСТЬ: если большой лимит не прогрет/не принят (пусто/ошибка), откатываемся
// на limit=100 (заведомо рабочий) — чтобы вкладка WB не осталась пустой.
export async function wbPrices(limit = 1000): Promise<WbPriceRow[]> {
  const fetchAt = async (lim: number): Promise<WbPriceRow[]> => {
    const data = await wbFetch<{ data: { listGoods: any[] } }>(`/wb/discounts/api/v2/list/goods/filter?limit=${lim}`);
    // WB отдаёт поле nmID (заглавная ID) — нормализуем в nmId, иначе r.nmId=undefined.
    return (data?.data?.listGoods ?? []).map((g: any) => ({ ...g, nmId: g.nmId ?? g.nmID }));
  };
  try {
    const rows = await fetchAt(limit);
    if (rows.length > 0 || limit <= 100) return rows;
    return await fetchAt(100); // пусто на большом лимите → пробуем базовый
  } catch (e) {
    if (limit > 100) {
      // Повтор на базовом лимите — последняя попытка. Если и она упала, наверх
      // уйдёт исходная ошибка, а причину провала повтора фиксируем тут.
      try { return await fetchAt(100); }
      catch (e2) { noteSwallowed('wb-prices', 'повтор на лимите 100 не помог', e2); }
    }
    throw e;
  }
}

export type WbFeedback = {
  id: string;
  text: string;
  productValuation: number; // 1-5
  createdDate: string;
  userName?: string;
  productDetails?: { productName: string; nmId: number };
  answer?: { text: string; state: string };
};

// Кнопка «Обновить» обязана дойти до WB, а не перечитать кэш: WB-прокси работает
// в режиме cron-only, и без заголовка x-av-no-cache ответы на площадке
// появлялись в кабинете только со следующим проходом сборщика (до 2 часов).
// Клиент 06.09 опубликовал 3 ответа из 4, а кабинет показывал старое.
export async function wbFeedbacks(opts: { isAnswered?: boolean; take?: number; force?: boolean } = {}): Promise<{ feedbacks: WbFeedback[]; countUnanswered: number; countArchive: number }> {
  const take = opts.take ?? 30;
  const isAnswered = opts.isAnswered ?? false;
  const data = await wbFetch<{ data: { feedbacks: WbFeedback[]; countUnanswered: number; countArchive: number } }>(`/wb/feedbacks/api/v1/feedbacks?isAnswered=${isAnswered}&take=${take}&skip=0`, undefined, !!opts.force);
  return data.data ?? { feedbacks: [], countUnanswered: 0, countArchive: 0 };
}

// Поставки WB (журнал) переехали на серверный /api/wb-supplies (supplies-api).
// Старый statistics /api/v1/supplies (incomes) удалён WB в июне 2026 — функция
// wbSupplies убрана. См. api/_lib/wbSuppliesLog.ts и WbSuppliesCard.

// ── Вопросы о товаре WB (тот же feedbacks-хост) ──
export type WbQuestion = {
  id: string;
  text: string;
  createdDate: string;
  userName?: string;
  productDetails?: { productName: string; nmId: number; supplierArticle?: string };
  answer?: { text: string; state: string } | null;
};

export async function wbQuestions(opts: { isAnswered?: boolean; take?: number; force?: boolean } = {}): Promise<{ questions: WbQuestion[]; countUnanswered: number; countArchive: number }> {
  const take = opts.take ?? 30;
  const isAnswered = opts.isAnswered ?? false;
  const data = await wbFetch<{ data: { questions: WbQuestion[]; countUnanswered: number; countArchive: number } }>(`/wb/feedbacks/api/v1/questions?isAnswered=${isAnswered}&take=${take}&skip=0`, undefined, !!opts.force);
  return data.data ?? { questions: [], countUnanswered: 0, countArchive: 0 };
}

// Опубликовать ответ покупателю в WB (write через серверный /api/wb-answer).
async function wbAnswer(kind: 'question' | 'feedback', id: string, text: string): Promise<{ ok: boolean; error?: string }> {
  const r = await fetch('/api/wb-answer', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, text, kind }),
  });
  try { return await r.json(); } catch { return { ok: false, error: `HTTP ${r.status}` }; }
}
export const wbAnswerQuestion = (id: string, text: string) => wbAnswer('question', id, text);
export const wbAnswerFeedback = (id: string, text: string) => wbAnswer('feedback', id, text);

// ───────── Ozon ─────────

export type OzonProductListItem = {
  product_id: number;
  offer_id: string;
  archived: boolean;
  has_fbo_stocks: boolean;
  has_fbs_stocks: boolean;
};

export async function ozonProductList(limit = 50): Promise<{ items: OzonProductListItem[]; total: number }> {
  const r = await fetch('/ozon/v3/product/list', {
    method: 'POST',
    body: JSON.stringify({ filter: { visibility: 'ALL' }, last_id: '', limit }),
  });
  const data = await json<{ result: { items: OzonProductListItem[]; total: number } }>(r);
  return data.result;
}

export type OzonProductInfo = {
  id: number;
  name: string;
  offer_id: string;
  marketing_price: string;
  price: string;
  old_price: string;
  currency_code: string;
  images: string[];
  primary_image: string;
};

export async function ozonProductInfoList(productIds: number[]): Promise<OzonProductInfo[]> {
  if (!productIds.length) return [];
  const r = await fetch('/ozon/v3/product/info/list', {
    method: 'POST',
    body: JSON.stringify({ product_id: productIds.map(String), offer_id: [], sku: [] }),
  });
  const data = await json<{ items: OzonProductInfo[] }>(r);
  return data.items ?? [];
}

export type OzonPriceRow = {
  product_id: number;
  offer_id: string;
  price: {
    price: number | string;
    old_price: number | string;
    min_price: number | string;
    // Что видит покупатель ПОСЛЕ всех скидок Ozon (включая Ozon-Карту/Premium).
    // marketing_seller_price — цена со всеми акциями продавца + площадки.
    // marketing_price — иногда есть отдельно (цена со скидкой Ozon без карты).
    marketing_seller_price: number | string;
    marketing_price?: number | string;
    net_price: number | string;
    vat: number | string;
    currency_code: string;
    auto_action_enabled: boolean;
  };
  commissions: {
    sales_percent_fbo: number;
    sales_percent_fbs: number;
    fbo_deliv_to_customer_amount: number;
    fbs_deliv_to_customer_amount: number;
  };
  price_indexes: {
    color_index: string;
    ozon_index_data: { min_price: number; price_index_value: number };
    external_index_data: { min_price: number; price_index_value: number };
    self_marketplaces_index_data: { min_price: number; price_index_value: number };
  };
  acquiring: number;
};

/**
 * ВСЕ цены и комиссии Ozon — из склейки сборщика (/api/ozon-prices).
 *
 * Раньше браузер листал v5/product/info/prices сам. У Ozon страницы плывут:
 * сортировка нестабильна, один товар приходил дважды (в кабинете — по 9 раз,
 * жалоба клиента 07.09), а часть терялась. Сборщик листает с защитой от дублей
 * и повторного курсора и кладёт результат под одним ключом — его и читаем.
 * Пока не прогрето — пусто с причиной, а не половина каталога.
 */
export async function ozonProductPricesAll(): Promise<OzonPriceRow[]> {
  const r = await fetch('/api/ozon-prices', { credentials: 'include' });
  if (r.status === 503) return [];
  const data = await json<{ items: OzonPriceRow[] }>(r);
  // Второй заслон от дублей — на случай старой склейки в кэше.
  const seen = new Set<string>();
  return (data.items ?? []).filter(i => {
    const k = String(i.offer_id ?? i.product_id);
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });
}

export type OzonUpdatePriceItem = {
  offer_id?: string;
  product_id?: number;
  price: string;            // новая цена
  old_price?: string;       // зачёркнутая
  min_price?: string;       // минимальная
  currency_code?: 'RUB';
};

// НЕ дёргаем без явного клика — это меняет цены в проде клиента.
export async function ozonUpdatePrices(prices: OzonUpdatePriceItem[]): Promise<any> {
  const r = await fetch('/ozon/v1/product/import/prices', {
    method: 'POST',
    body: JSON.stringify({ prices }),
  });
  return json(r);
}

export type OzonStockRow = {
  product_id: number;
  offer_id: string;
  stocks: { sku: number; present: number; reserved: number; type: string; warehouse_ids?: number[] }[];
};

export async function ozonStocksList(limit = 100): Promise<OzonStockRow[]> {
  const r = await fetch('/ozon/v4/product/info/stocks', {
    method: 'POST',
    body: JSON.stringify({ filter: { visibility: 'ALL' }, cursor: '', limit }),
  });
  const data = await json<{ items: OzonStockRow[] }>(r);
  return data.items ?? [];
}

// Возвращает map sku (как у Ozon analytics) → product_id
export async function ozonSkuToProductMap(): Promise<Map<string, number>> {
  const items = await ozonStocksList(200);
  const map = new Map<string, number>();
  for (const it of items) {
    for (const s of it.stocks ?? []) {
      if (s.sku) map.set(String(s.sku), it.product_id);
    }
  }
  return map;
}

// Возвращает map числовой sku (из finance/transaction items) → offer_id (артикул
// продавца). Нужен для джойна себестоимости Ozon: COGS в таблице закупок лежит по
// артикулу (offer_id), а транзакции отдают только числовой sku.
export async function ozonSkuToOfferMap(): Promise<Map<string, string>> {
  const items = await ozonStocksList(200);
  const map = new Map<string, string>();
  for (const it of items) {
    for (const s of it.stocks ?? []) {
      if (s.sku && it.offer_id) map.set(String(s.sku), it.offer_id);
    }
  }
  return map;
}

export type OzonAnalyticsTotals = {
  ordered_units: number;
  revenue: number;
  returns: number;
  avg_check: number;
};

export type OzonTopSku = {
  sku: string;
  name: string;
  orders: number;
  revenue: number;
};

// Дата YYYY-MM-DD по МОСКВЕ. Раньше бралось локальное время браузера — для
// клиента в Москве совпадало, но привязывало расчёт к поясу зрителя. Сутки на
// WB и Ozon всегда московские, поэтому считаем их явно (см. utils/mskDate).
export function localDateStr(daysAgo = 0): string {
  return mskDate(daysAgo);
}

export async function ozonAnalyticsBySku(daysBack: number, limit = 10): Promise<OzonTopSku[]> {
  // Окно = N завершённых суток, ЗАКАНЧИВАЯ ВЧЕРА (сегодня неполный → исключаем,
  // иначе заказы завышались на ~1 против кабинета). Даты по МСК, без сдвига UTC.
  const body = {
    date_from: localDateStr(daysBack),
    date_to: localDateStr(1),
    metrics: ['ordered_units', 'revenue'],
    dimension: ['sku'],
    limit,
    offset: 0,
    sort: [{ key: 'revenue', order: 'DESC' }],
  };
  const r = await fetch('/ozon/v1/analytics/data', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  const data = await json<{ result: { data: { dimensions: { id: string; name: string }[]; metrics: number[] }[] } }>(r);
  const rows = data?.result?.data ?? [];
  return rows.map((row) => ({
    sku: row.dimensions[0]?.id ?? '',
    name: row.dimensions[0]?.name ?? '',
    orders: row.metrics[0] ?? 0,
    revenue: row.metrics[1] ?? 0,
  }));
}

export async function ozonAnalyticsTotals(daysBack = 1): Promise<OzonAnalyticsTotals> {
  const body = {
    date_from: localDateStr(daysBack),
    date_to: localDateStr(0),
    metrics: ['ordered_units', 'revenue', 'returns'],
    dimension: ['day'],
    limit: 1000,
    offset: 0,
  };
  const r = await fetch('/ozon/v1/analytics/data', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  const data = await json<{ result: { data: { metrics: number[] }[] } }>(r);
  const rows = data?.result?.data ?? [];
  const sum = (i: number) => rows.reduce((s, row) => s + (row.metrics[i] ?? 0), 0);
  const orders = sum(0);
  const revenue = sum(1);
  return {
    ordered_units: orders,
    revenue,
    returns: sum(2),
    avg_check: orders > 0 ? Math.round(revenue / orders) : 0,
  };
}

// ───────── WB · Analytics (NM Report) ─────────

export type WbReportPeriod = {
  ordersCount: number;
  ordersSumRub: number;
  buyoutsCount: number;
  buyoutsSumRub: number;
  cancelCount: number;
  cancelSumRub: number;
  avgPriceRub: number;
  openCardCount?: number;
  addToCartCount?: number;
};

export type WbNmReportCard = {
  nmID: number;
  vendorCode: string;
  brandName?: string;
  object?: { id: number; name: string };
  statistics: {
    selectedPeriod: WbReportPeriod;
    previousPeriod: WbReportPeriod;
  };
  stocks?: { stocksMp: number; stocksWb: number };
};

// WB Sales Funnel v3 — пришёл на замену v2 nm-report/detail (отключён 09.12.2025).
// Body shape: period.start/end (не begin/end!), limit/offset (не page!), timezone,
// фильтры brandNames/subjectIDs/tagIDs/nmIDs могут быть пустыми массивами.
// Ответ: data.cards[].statistics.{selectedPeriod,previousPeriod} — совпадает с v2.
export async function wbNmReport(begin: string, end: string, offset = 0, limit = 200, force = false): Promise<{ cards: WbNmReportCard[]; isNextPage: boolean }> {
  const data = await wbFetch<{ data: { cards: WbNmReportCard[]; isNextPage: boolean } }>('/wb/analytics/api/analytics/v3/sales-funnel/products', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      period: { start: begin, end },
      timezone: 'Europe/Moscow',
      limit, offset,
      brandNames: [], subjectIDs: [], tagIDs: [], nmIDs: [],
      orderBy: { field: 'ordersSumRub', mode: 'desc' },
    }),
  }, force);
  return { cards: data?.data?.cards ?? [], isNextPage: data?.data?.isNextPage ?? false };
}

/**
 * Получить отчёт. Режим cron-only: браузер читает только прогретый сборщиком кэш,
 * а сборщик греет ОДНУ страницу (offset=0, limit=200). Поэтому фронт тоже берёт
 * только первую страницу — вторая (offset=200) дала бы промах кэша (503).
 * Для ниши клиента (~сотня SKU) топ-200 покрывает весь каталог.
 */
export async function wbNmReportAll(begin: string, end: string, force = false): Promise<WbNmReportCard[]> {
  const { cards } = await wbNmReport(begin, end, 0, 200, force);
  return cards;
}

// ───────── WB · Statistics API: sales + orders ─────────
// Используются на дашборде вместо мёртвого nm-report.

export type WbSale = {
  date: string;
  lastChangeDate: string;
  warehouseName?: string;
  countryName?: string;
  oblastOkrugName?: string;
  regionName?: string;
  supplierArticle?: string;
  nmId: number;
  barcode?: string;
  category?: string;
  subject?: string;
  brand?: string;
  techSize?: string;
  incomeID?: number;
  isSupply?: boolean;
  isRealization?: boolean;
  totalPrice?: number;       // цена до скидок
  discountPercent?: number;
  spp?: number;
  paymentSaleAmount?: number;
  forPay?: number;            // сумма к перечислению продавцу
  finishedPrice?: number;     // цена покупателя после всех скидок
  priceWithDisc?: number;     // итоговая цена с учётом скидок
  saleID?: string;            // "S..." — продажа, "R..." — возврат
  orderType?: string;
  sticker?: string;
  gNumber?: string;
  srid?: string;
};

export async function wbSupplierSales(dateFrom: string, force = false): Promise<WbSale[]> {
  const data = await wbFetch<WbSale[]>(`/wb/statistics/api/v1/supplier/sales?dateFrom=${dateFrom}`, undefined, force);
  return Array.isArray(data) ? data : [];
}

export type WbOrder = {
  date: string;
  lastChangeDate: string;
  warehouseName?: string;
  nmId: number;
  supplierArticle?: string;
  totalPrice?: number;
  discountPercent?: number;
  finishedPrice?: number;
  priceWithDisc?: number;
  isCancel?: boolean;
  cancelDate?: string;
  orderType?: string;
  sticker?: string;
  gNumber?: string;
  srid?: string;
};

export async function wbSupplierOrders(dateFrom: string, force = false): Promise<WbOrder[]> {
  const data = await wbFetch<WbOrder[]>(`/wb/statistics/api/v1/supplier/orders?dateFrom=${dateFrom}`, undefined, force);
  return Array.isArray(data) ? data : [];
}

// ───────── WB · Prices v2 POST (с пагинацией) ─────────

export type WbPriceV2Row = {
  nmID: number;
  vendorCode: string;
  sizeID: number;
  techSizeName: string;
  price: number;
  currencyIsoCode4217: string;
  discount: number;
  clubDiscount?: number;
  clubDiscountedPrice?: number;
  status?: number;
  errorText?: string;
};

export async function wbPricesV2(limit = 100, offset = 0): Promise<WbPriceV2Row[]> {
  const data = await wbFetch<{ data: { listGoods?: WbPriceV2Row[]; bufferGoods?: WbPriceV2Row[] } }>('/wb/discounts/api/v2/list/goods/filter', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ limit, offset }),
  });
  return data?.data?.listGoods ?? data?.data?.bufferGoods ?? [];
}
