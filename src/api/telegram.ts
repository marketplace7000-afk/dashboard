// Telegram Bot API клиент. Бьётся напрямую с api.telegram.org (CORS разрешён там).
// Токен берётся из VITE_TELEGRAM_BOT_TOKEN — клиент заполняет в .env когда выдаст.

const TOKEN = import.meta.env.VITE_TELEGRAM_BOT_TOKEN as string;
const DEFAULT_CHAT = import.meta.env.VITE_TELEGRAM_CHAT_ID as string;
const BASE = TOKEN ? `https://api.telegram.org/bot${TOKEN}` : '';

export const tgConfigured = (): boolean => !!TOKEN;

async function tg<T>(method: string, body?: any): Promise<T> {
  if (!TOKEN) throw new Error('VITE_TELEGRAM_BOT_TOKEN не задан в .env');
  const r = await fetch(`${BASE}/${method}`, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json();
  if (!data.ok) throw new Error(data.description ?? `HTTP ${r.status}`);
  return data.result as T;
}

export type TgBotInfo = {
  id: number;
  is_bot: boolean;
  first_name: string;
  username: string;
  can_join_groups: boolean;
  can_read_all_group_messages: boolean;
  supports_inline_queries: boolean;
};

export async function tgGetMe(): Promise<TgBotInfo> {
  return tg<TgBotInfo>('getMe');
}

export async function tgSendMessage(text: string, opts: { chat_id?: string | number; parse_mode?: 'MarkdownV2' | 'HTML'; reply_markup?: any } = {}) {
  return tg('sendMessage', {
    chat_id: opts.chat_id ?? DEFAULT_CHAT,
    text,
    parse_mode: opts.parse_mode,
    reply_markup: opts.reply_markup,
  });
}

// Заготовки шаблонов сообщений — те же, что описаны в Telegram-mocup'е страницы
export const tgTemplates = {
  dailyReport: (revenue: number, orders: number, avgCheck: number, topSku: string) =>
    `📊 *Дневной отчёт*\n\n` +
    `Выручка: ${revenue.toLocaleString('ru-RU')} ₽\n` +
    `Заказов: ${orders}\n` +
    `Средний чек: ${avgCheck.toLocaleString('ru-RU')} ₽\n\n` +
    `Топ\\-1: ${topSku}`,

  negativeReview: (article: string, rating: number, text: string, draft: string) =>
    `⚠️ *Негативный отзыв · ${rating} звезды*\n\n` +
    `SKU: \`${article}\`\n` +
    `«${text}»\n\n` +
    `_Черновик ответа:_\n${draft}`,

  priceRecommendation: (article: string, name: string, oldPrice: number, newPrice: number, reason: string) =>
    `💰 *Рекомендация по цене*\n\n` +
    `\`${article}\` · ${name}\n` +
    `Текущая: ${oldPrice.toLocaleString('ru-RU')} ₽ → Предлагаем: *${newPrice.toLocaleString('ru-RU')} ₽*\n` +
    `Причина: ${reason}`,
};

export const tgKeyboards = {
  approveDraft: (draftId: string) => ({
    inline_keyboard: [[
      { text: '✓ Опубликовать', callback_data: `approve:${draftId}` },
      { text: '✎ Изменить', callback_data: `edit:${draftId}` },
      { text: '✕ Отклонить', callback_data: `reject:${draftId}` },
    ]],
  }),
  applyPrice: (skuId: string) => ({
    inline_keyboard: [[
      { text: '✓ Применить', callback_data: `price_apply:${skuId}` },
      { text: '✕ Пропустить', callback_data: `price_skip:${skuId}` },
    ]],
  }),
};
