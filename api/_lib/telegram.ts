/**
 * Telegram-бот рабочего чата (26.10.2026): напоминания и итоги «Сравнения карточек» WB.
 *
 * Только отправка сообщений в один чат — без вебхука и без приёма команд (прежний бот
 * подрядчиков удалён 20.10, см. docs/handover/09). Токен — TELEGRAM_BOT_TOKEN в .env
 * (записывает «Задать токен Telegram-бота.cmd»), чат — TELEGRAM_CHAT_ID в .env или,
 * если его нет, первый групповой чат из getUpdates (бота добавили в чат и упомянули) —
 * запоминается в .av-cache/telegram.json.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const API = 'https://api.telegram.org';
const STATE = join(process.env.CACHE_DIR || join(process.cwd(), '.av-cache'), 'telegram.json');

const token = () => String(process.env.TELEGRAM_BOT_TOKEN || '').trim();

function readState(): { chatId?: number; chatTitle?: string } {
  try { return existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {}; } catch { return {}; }
}

async function call(method: string, body?: Record<string, unknown>): Promise<any> {
  const t = token();
  if (!t) throw new Error('нет TELEGRAM_BOT_TOKEN');
  const r = await fetch(`${API}/bot${t}/${method}`, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const j: any = await r.json().catch(() => null);
  if (!j?.ok) throw new Error(`Telegram ${method}: ${j?.description ?? r.status}`);
  return j.result;
}

/** Чат для сообщений: из .env, из запомненного, иначе найти групповой чат в последних обновлениях бота. */
export async function chatId(): Promise<number | null> {
  const env = Number(process.env.TELEGRAM_CHAT_ID);
  if (Number.isFinite(env) && env !== 0) return env;
  const st = readState();
  if (st.chatId) return st.chatId;
  if (!token()) return null;
  try {
    const ups: any[] = await call('getUpdates', { allowed_updates: ['message', 'my_chat_member'], limit: 100 });
    for (const u of [...ups].reverse()) {
      const c = (u.message ?? u.my_chat_member)?.chat;
      if (c && (c.type === 'group' || c.type === 'supergroup')) {
        writeFileSync(STATE, JSON.stringify({ chatId: c.id, chatTitle: c.title ?? '' }));
        console.log(`[telegram] чат найден: ${c.title ?? ''} (${c.id})`);
        return c.id;
      }
    }
  } catch (e) { console.warn('[telegram] чат не найден:', (e as Error).message); }
  return null;
}

export function tgConfigured(): boolean { return !!token(); }

const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export { esc as tgEscape };

/** Отправить сообщение в рабочий чат (HTML). false — не настроен или не дошло (в журнал). */
export async function tgSend(html: string): Promise<boolean> {
  if (!tgConfigured()) { console.warn('[telegram] токен не задан — сообщение не отправлено'); return false; }
  const chat = await chatId();
  if (!chat) { console.warn('[telegram] чат не известен — добавьте бота в чат и напишите ему'); return false; }
  try {
    await call('sendMessage', { chat_id: chat, text: html.slice(0, 4000), parse_mode: 'HTML', disable_web_page_preview: true });
    return true;
  } catch (e) {
    console.warn('[telegram] не отправлено:', (e as Error).message);
    return false;
  }
}
