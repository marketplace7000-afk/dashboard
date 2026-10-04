/**
 * Агент 4 «Отзывы и вопросы» — общие типы сервера и кабинета.
 * ТЗ: проект Claude «Агенты для маркетплейсов», claude/ТЗ-агент-отзывы.md (v0.5).
 */

export type ReviewMarketplace = 'wb' | 'ozon';
export type ReviewKind = 'review' | 'question';
/** Направление = площадка + тип. У каждого свой тумблер «ручной/авто». */
export type ReviewDirection = 'wb_reviews' | 'wb_questions' | 'ozon_reviews' | 'ozon_questions';

export const DIRECTIONS: { key: ReviewDirection; mp: ReviewMarketplace; kind: ReviewKind; title: string }[] = [
  { key: 'wb_reviews',     mp: 'wb',   kind: 'review',   title: 'WB · отзывы' },
  { key: 'wb_questions',   mp: 'wb',   kind: 'question', title: 'WB · вопросы' },
  { key: 'ozon_reviews',   mp: 'ozon', kind: 'review',   title: 'Ozon · отзывы' },
  { key: 'ozon_questions', mp: 'ozon', kind: 'question', title: 'Ozon · вопросы' },
];

export function directionOf(mp: ReviewMarketplace, kind: ReviewKind): ReviewDirection {
  return `${mp}_${kind === 'review' ? 'reviews' : 'questions'}` as ReviewDirection;
}

export type ReviewStatus =
  | 'new'        // собрано, черновика нет
  | 'drafted'    // черновик готов, ждёт решения
  | 'escalated'  // черновик есть, но автопубликация запрещена (раздел 8 ТЗ)
  | 'published'  // ответ опубликован из дашборда
  | 'skipped';   // владелец решил не отвечать

export type ReviewItem = {
  id: number;
  marketplace: ReviewMarketplace;
  kind: ReviewKind;
  externalId: string;
  sku: string | null;
  offerId: string | null;
  productName: string | null;
  productUrl: string | null;
  rating: number | null;
  text: string;
  pros: string | null;
  cons: string | null;
  author: string | null;
  createdAt: number;
  answeredOnMarketplace: boolean;
  /** Текст ответа, уже стоящего на площадке (для истории/отвеченных). */
  marketplaceAnswer: string | null;
  status: ReviewStatus;
  draftAnswer: string | null;
  draftModel: string | null;
  draftCostUsd: number | null;
  confidence: 'high' | 'medium' | 'low' | null;
  category: string | null;
  escalationReason: string | null;
  sourcesUsed: string[];
  publishedAt: number | null;
  publishedBy: 'auto' | 'owner' | null;
  publishError: string | null;
};

/** Пресеты списка над фильтрами (раздел 14 ТЗ). */
export type ReviewView = 'unanswered' | 'pending' | 'answered' | 'all';

export type ReviewSettings = {
  autoPublish: Record<ReviewDirection, boolean>;
  /** Отзывы с оценкой <= порога всегда идут на ручное решение. */
  escalateRatingMax: number;
  draftModel: string;
  indexModel: string;
  /** Подлимит раздела на Claude, $ в календарный месяц. */
  monthlyBudgetUsd: number;
  /** Общий лимит ключа (для подписи в шапке). */
  keyBudgetUsd: number;
  yandexDiskUrl: string;
  /** Генерировать черновики автоматически после сбора. */
  autoDraft: boolean;
};

export const DEFAULT_REVIEW_SETTINGS: ReviewSettings = {
  autoPublish: { wb_reviews: false, wb_questions: false, ozon_reviews: false, ozon_questions: false },
  escalateRatingMax: 2,
  draftModel: 'claude-sonnet-5-5',
  indexModel: 'claude-haiku-4-5',
  monthlyBudgetUsd: 8,
  keyBudgetUsd: 20,
  yandexDiskUrl: '',
  autoDraft: false,
};

export type ReviewCounters = Record<ReviewDirection, { unanswered: number; pending: number }>;

export type CollectState = {
  direction: ReviewDirection;
  at: number | null;
  ok: boolean;
  error: string | null;
  /** Почему направление не собирается (например, Ozon-отзывы — нет доступа по API). */
  note: string | null;
};

export type ReviewsOverview = {
  counters: ReviewCounters;
  collect: CollectState[];
  spendMonthUsd: number;
  settings: ReviewSettings;
};

/** Ключи текстов базы знаний. */
export type KbTextKey = 'tone' | 'faq' | 'scripts' | 'templates_5' | 'templates_4' | 'templates_low';
export const KB_TEXT_TITLES: Record<KbTextKey, string> = {
  tone: 'Правила тона',
  faq: 'FAQ: доставка, возврат, гарантия',
  scripts: 'Скрипты конфликтных ситуаций',
  templates_5: 'Шаблоны на отзыв 5★ без текста (по одному в строке)',
  templates_4: 'Шаблоны на отзыв 4★ без текста (по одному в строке)',
  templates_low: 'Шаблоны на отзыв 1–3★ без текста (по одному в строке)',
};

export type KbFolder = {
  path: string;
  offerIds: string[];
  suggested: string[];
  confirmed: boolean;
  files: { name: string; kind: string; status: 'done' | 'skipped' | 'pending' | 'error'; note?: string }[];
  textChars: number;
  updatedAt: number | null;
};

/** Пара «вопрос покупателя → ответ магазина» из архива Telegram (разбирается в браузере). */
export type TgPair = { dialogId: string; messageId: string; question: string; answer: string; date: string };
