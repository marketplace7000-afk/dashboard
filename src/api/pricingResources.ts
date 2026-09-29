import { createSideResource } from './sideResource';

/**
 * Серверные ресурсы страницы «Цены», общие для WB и Ozon.
 * Вынесены сюда, чтобы кнопка «Обновить» могла форс-обновить их все разом
 * (см. sideResource.ts — заголовок x-av-no-cache).
 */

export type OzonBuyerPrice = { price: number; buyer: number; spp: number; units?: number };
export type OzonSppHistory = Record<string, { spp: number; date: string }>;

export const ozonBuyerPricesRes = createSideResource<{
  items: Record<string, OzonBuyerPrice>;
  sppHistory?: OzonSppHistory;
  fetchedAt?: number;
}>('/api/ozon-buyer-prices');

export type SkuAdRow = { spend: number; revenue: number; drr?: number; views?: number; clicks?: number; carts?: number };

export const ozonSkuAdsRes = createSideResource<{
  items: Record<string, SkuAdRow>;
  days?: number;
}>('/api/ozon-sku-ads?days=30');

export type WbBuyerPrice = { price: number; spp: number; beforeSpp: number; date: string; fromMemory?: boolean };

export const wbBuyerPricesRes = createSideResource<{
  items: Record<string, WbBuyerPrice>;
  fetchedAt?: number;
}>('/api/wb-buyer-prices');

/**
 * Живая витринная цена WB по своим nmId — с публичной карточки, там есть СПП.
 * Первая ступень «цены покупателя»: остальные источники — уже не сегодняшние.
 */
export type WbShowcaseRow = { price: number; oldPrice?: number; greyPrice?: number; at: number };
export const wbShowcaseRes = createSideResource<{
  items: Record<string, WbShowcaseRow>;
  count: number; requested: number; fetchedAt: number | null; error?: string;
}>('/api/wb-showcase');

export type OzonShowcaseRow = { price: number; oldPrice?: number; greyPrice?: number; at: number };
export const ozonShowcaseRes = createSideResource<{
  items: Record<string, OzonShowcaseRow>;
  count: number; requested: number; fetchedAt: number | null; error?: string;
}>('/api/ozon-showcase');

export const wbCardEconRes = createSideResource<{
  items: Record<string, { commission: number | null; commissionSource?: string; volumeL: number; subject: string }>;
  fulfilment?: 'fbs' | 'fbo';
}>('/api/wb-card-econ');

export type WbStock = { byNm: Record<string, number>; fboByNm?: Record<string, number>; fbsByNm?: Record<string, number>; fbsError?: string; fetchedAt: number };
export const wbStockRes = createSideResource<WbStock>('/api/wb-stock');

export const wbBoxTariffsRes = createSideResource<{
  deliveryBase: number; deliveryLiter: number; deliveryCoef: number;
  storageBase: number; storageLiter: number;
}>('/api/wb-box-tariffs');

/**
 * Реклама по артикулам с обеих площадок — для калькулятора цен.
 * У WB в `sku` лежит НАЗВАНИЕ карточки, поэтому сопоставляем по `id` (nmId).
 */
export type AdsSkuRowLite = {
  platform: 'wb' | 'ozon';
  sku: string;
  id?: string;
  spend: number;
  revenue: number;
  /** ДРР по формуле клиента: расход ÷ выручка по всем заказам. */
  drr: number | null;
  totalRevenue?: number;
  drrBase?: 'all-orders' | 'ads-only' | 'none';
};

export const adsBySkuRes = createSideResource<{
  items: AdsSkuRowLite[];
  days?: number;
  diagnostics?: string;
}>('/api/ads-advisor/by-sku?days=30');

/**
 * Экономика товара по артикулу — себестоимость, ДРР, комиссия и логистика по
 * выбранной схеме работы. ГЛАВНЫЙ источник входных данных для расчёта прибыли.
 *
 * Почему отдельный ресурс, хотя часть этих данных приходит и в других: он
 * собирает их ПО АРТИКУЛУ и независимо от того, попал ли товар в чью-то
 * таблицу. До него новый товар оставался без себестоимости и комиссии просто
 * потому, что его ещё не вписали в лист «Ozon_wb» (жалобы клиента 29.08).
 * Подробности — в шапке api/_lib/productEcon.ts.
 */
export const productEconRes = createSideResource<{
  fulfilment: { wb: 'fbs' | 'fbo'; ozon: 'fbs' | 'fbo' };
  wb: Record<string, ProductEconRow>;
  ozon: Record<string, ProductEconRow>;
  diagnostics?: string[];
  storeDrr?: { wb: { d7: number | null; d30: number | null }; ozon: { d7: number | null; d30: number | null } };
}>('/api/product-econ?days=7');

export type EconVal = {
  value: number | null;
  origin: 'reference' | 'marketplace' | 'tariffs' | 'client-table' | 'ads-report' | 'no-ads' | 'fact-report' | 'store-avg' | 'none';
  note?: string;
};
export type ProductEconRow = {
  sku: string;
  nmId?: number;
  cost: EconVal;
  drr: EconVal;
  commissionPct: EconVal;
  logisticRub: EconVal;
  storageRub: EconVal;
  /** 16.09.2026: ДРР за 7/30 дн и что взято в расчёт; факт логистики/выкупа из финотчётов за 30 дн. */
  drr7?: number | null;
  drr30?: number | null;
  orders7?: number;
  drrPick?: '7d' | '30d' | 'store' | 'none';
  logisticFact?: EconVal;
  returnFact?: EconVal;
  buyoutFact?: EconVal;
};
