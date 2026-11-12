/**
 * «РНП действия» (12.11.2026) — календарь изменений по каждой карточке WB и Ozon.
 * Не метрики, а действия: что и когда поменяли в карточке, цене, рекламе, акциях.
 * Общие типы сервера (api/_lib/rnpActions.ts) и экрана (src/pages/RnpActions.tsx).
 */
import type { RnpMp } from './rnp';

/** Строки календаря. Порядок здесь = порядок строк на экране. */
export const ACT_KINDS = [
  { key: 'photo_main',  label: 'Главное фото',   color: '#d6336c', hint: 'Сменили первое фото карточки' },
  { key: 'photos',      label: 'Фото и видео',   color: '#ae3ec9', hint: 'Добавили, убрали или переставили остальные фото, видео' },
  { key: 'title',       label: 'Название',       color: '#1c7ed6', hint: 'Изменили название карточки' },
  { key: 'description', label: 'Описание',       color: '#1098ad', hint: 'Изменили описание' },
  { key: 'attrs',       label: 'Характеристики', color: '#5c7cfa', hint: 'Изменили характеристики' },
  { key: 'price',       label: 'Цена',           color: '#f08c00', hint: 'Цена в кабинете (до скидки площадки) изменилась на 1 % и больше' },
  { key: 'ads',         label: 'Реклама',        color: '#2f9e44', hint: 'Рекламу включили или выключили, меняли ставку. Бледная заливка — в этот день реклама шла' },
  { key: 'promo',       label: 'Акции',          color: '#e8590c', hint: 'Товар вошёл в акцию площадки или вышел из неё' },
  { key: 'stock',       label: 'Остатки',        color: '#868e96', hint: 'Товар закончился или снова появился' },
] as const;

export type ActKind = typeof ACT_KINDS[number]['key'];

export type ActEvent = {
  date: string;            // YYYY-MM-DD (Москва)
  kind: ActKind;
  text: string;            // коротко: «Цена 5 990 → 5 490 ₽ (−8 %)»
  /** Что было и что стало: текст (название, описание) или JSON-массив ссылок на фото. */
  before?: string;
  after?: string;
  /** Вид содержимого before/after. */
  view?: 'text' | 'images';
};

export type ActNote = { id: number; date: string; text: string; author: string; at: number };

export type ActItem = {
  sku: string;
  article: string;
  name: string;
  photo: string;
  link: string;
  inStock: boolean;
  /** Заказы, шт по дням периода (null — данных за день нет). */
  orders: (number | null)[];
  /** 1 — в этот день шла реклама (был расход). */
  adsOn: number[];
  events: ActEvent[];
  notes: ActNote[];
};

export type ActResponse = {
  ok: true;
  mp: RnpMp;
  from: string;
  to: string;
  dates: string[];
  items: ActItem[];
  /** С какого дня следим за фото и текстами карточек (раньше — только цена, реклама, остатки). */
  contentSince: string | null;
  /** Когда последний раз сверяли карточки с площадкой (мс). */
  checkedAt: number | null;
  notes: string[];
};
