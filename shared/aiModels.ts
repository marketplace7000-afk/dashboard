/**
 * Какая модель Claude работает в каком разделе (21.10.2026, просьба владельца:
 * выбирать самому в «Настройках», без программиста).
 *
 * Общий файл для сервера (api/_lib/aiModels.ts — подбор модели на каждый вызов)
 * и интерфейса (карточка «Модели ИИ» в «Настройках»). Новая модель или раздел
 * добавляются только здесь.
 */

export type AiArea =
  | 'reviews' | 'chats' | 'knowledge'
  | 'dashboard' | 'prices' | 'assistant'
  | 'ads' | 'competitors' | 'other';

export type AiAreaInfo = {
  key: AiArea;
  label: string;
  /** Что именно делает ИИ в разделе — человеческим языком. */
  hint: string;
  /** ИИ в разделе сейчас не вызывается (считается правилами) — выбор на будущее. */
  idle?: boolean;
};

export const AI_AREAS: AiAreaInfo[] = [
  { key: 'reviews', label: 'Отзывы и вопросы', hint: 'Черновики ответов покупателям, банк ответов на отзывы без текста, профиль стиля магазина' },
  { key: 'chats', label: 'Чаты с покупателями', hint: 'Черновики ответов в чатах WB и Ozon и их сокращение под лимит площадки' },
  { key: 'knowledge', label: 'База знаний отзывов', hint: 'Чтение инструкций, PDF и фото с Яндекс.Диска, чтобы ответы опирались на факты о товаре' },
  { key: 'dashboard', label: 'Дашборд', hint: 'Инсайты дня: что изменилось и на что обратить внимание' },
  { key: 'prices', label: 'Цены', hint: 'Кнопка «Совет ИИ» на страницах цен WB и Ozon' },
  { key: 'assistant', label: 'ИИ-помощник', hint: 'Чат в правом нижнем углу кабинета' },
  { key: 'ads', label: 'Реклама', hint: 'Сейчас автопилот и советы по рекламе считаются правилами без ИИ — модель понадобится для будущих ИИ-функций', idle: true },
  { key: 'competitors', label: 'Конкуренты', hint: 'Сейчас советник по конкурентам работает на правилах без ИИ — модель понадобится для будущих ИИ-функций', idle: true },
  { key: 'other', label: 'Всё остальное', hint: 'Редкие служебные вызовы, не попавшие в разделы выше' },
];

export type AiModelChoice = {
  id: string;
  label: string;
  /** $ за 1 млн токенов: вход / выход (platform.claude.com, 10.2026). */
  priceIn: number;
  priceOut: number;
  note: string;
};

export const AI_MODEL_CHOICES: AiModelChoice[] = [
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5', priceIn: 0.1, priceOut: 0.5, note: 'самая дешёвая и быстрая — для потока простых ответов' },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', priceIn: 2, priceOut: 10, note: 'баланс цены и качества' },
  { id: 'claude-opus-5-5', label: 'Opus 5.5', priceIn: 4, priceOut: 20, note: 'глубокие выводы и сложный анализ' },
  { id: 'claude-fable-5-1', label: 'Fable 5.1', priceIn: 10, priceOut: 50, note: 'самая сильная и самая дорогая — только для самого важного' },
];

/** Выбор по умолчанию — решение владельца 21.10.2026. */
export const DEFAULT_AI_MODELS: Record<AiArea, string> = {
  reviews: 'claude-haiku-5-5',
  chats: 'claude-haiku-5-5',
  knowledge: 'claude-haiku-5-5',
  dashboard: 'claude-opus-5-5',
  prices: 'claude-opus-5-5',
  assistant: 'claude-opus-5-5',
  ads: 'claude-opus-5-5',
  competitors: 'claude-opus-5-5',
  other: 'claude-opus-5-5',
};

/** Оставить только известные разделы и модели — мусор из запроса в настройки не попадёт. */
export function cleanAiModels(raw: unknown): Partial<Record<AiArea, string>> {
  const out: Partial<Record<AiArea, string>> = {};
  if (!raw || typeof raw !== 'object') return out;
  const ids = new Set(AI_MODEL_CHOICES.map(c => c.id));
  for (const a of AI_AREAS) {
    const v = (raw as Record<string, unknown>)[a.key];
    if (typeof v === 'string' && ids.has(v)) out[a.key] = v;
  }
  return out;
}
