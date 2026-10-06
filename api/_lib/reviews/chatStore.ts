/**
 * Чаты с покупателями — хранилище (та же база reviews.sqlite).
 *   chat_threads  — диалог: площадка, id чата, подпись для ответа (WB replySign), покупатель, товар,
 *                   последнее сообщение, черновик ответа и его статус;
 *   chat_messages — все сообщения диалога (покупатель / магазин).
 * Пары «вопрос → ответ» для базы знаний собираются из chat_messages (см. sources.ts).
 */
import { getDb, kvGet, safeJson } from './db';

export type ChatMsgRow = { id: string; at: number; fromBuyer: boolean; text: string };

let ready = false;
export function chatDb(): any {
  const d = getDb();
  if (ready) return d;
  d.exec(`
    CREATE TABLE IF NOT EXISTS chat_threads (
      marketplace TEXT NOT NULL, chat_id TEXT NOT NULL,
      reply_sign TEXT, client_name TEXT, sku TEXT, offer_id TEXT, product_name TEXT,
      last_at INTEGER, last_from_buyer INTEGER, last_text TEXT,
      status TEXT NOT NULL DEFAULT 'idle',
      draft_answer TEXT, draft_model TEXT, draft_cost REAL, draft_for TEXT,
      confidence TEXT, escalation_reason TEXT, sources_used TEXT NOT NULL DEFAULT '[]',
      draft_attempts INTEGER NOT NULL DEFAULT 0,
      sent_at INTEGER, sent_by TEXT, send_error TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (marketplace, chat_id)
    );
    CREATE INDEX IF NOT EXISTS chat_threads_last ON chat_threads(last_from_buyer, last_at);
    CREATE TABLE IF NOT EXISTS chat_messages (
      marketplace TEXT NOT NULL, chat_id TEXT NOT NULL, msg_id TEXT NOT NULL,
      at INTEGER NOT NULL, from_buyer INTEGER NOT NULL, text TEXT NOT NULL,
      PRIMARY KEY (marketplace, msg_id)
    );
    CREATE INDEX IF NOT EXISTS chat_messages_chat ON chat_messages(marketplace, chat_id, at);
  `);
  ready = true;
  migrateKvBuffers(d);
  return d;
}

/** До 06.10 сообщения WB лежали в kv («wbchat:<id>», последние 200) — переносим один раз. */
function migrateKvBuffers(d: any): void {
  const has = d.prepare("SELECT 1 FROM chat_messages WHERE marketplace = 'wb' LIMIT 1").get();
  if (has) return;
  const rows = d.prepare("SELECT key, value FROM kv WHERE key LIKE 'wbchat:%'").all() as any[];
  const ins = d.prepare('INSERT OR IGNORE INTO chat_messages (marketplace, chat_id, msg_id, at, from_buyer, text) VALUES (?, ?, ?, ?, ?, ?)');
  for (const r of rows) {
    const chatId = r.key.slice('wbchat:'.length);
    for (const m of safeJson(r.value, []) as ChatMsgRow[]) ins.run('wb', chatId, m.id, m.at, m.fromBuyer ? 1 : 0, m.text);
    touchThread('wb', chatId);
  }
}

export function addMessages(mp: 'wb' | 'ozon', chatId: string, msgs: ChatMsgRow[]): number {
  const d = chatDb();
  const ins = d.prepare('INSERT OR IGNORE INTO chat_messages (marketplace, chat_id, msg_id, at, from_buyer, text) VALUES (?, ?, ?, ?, ?, ?)');
  // Наше сообщение, отправленное из дашборда, лежит с временным id «local:…» — заменяем настоящим событием.
  const dropLocal = d.prepare("DELETE FROM chat_messages WHERE marketplace = ? AND chat_id = ? AND msg_id LIKE 'local:%' AND text = ?");
  let n = 0;
  for (const m of msgs) {
    if (!m.text.trim()) continue;
    if (!m.fromBuyer && !m.id.startsWith('local:')) dropLocal.run(mp, chatId, m.text.slice(0, 4000));
    const r = ins.run(mp, chatId, m.id, m.at, m.fromBuyer ? 1 : 0, m.text.slice(0, 4000));
    if (r.changes) n++;
  }
  if (n) touchThread(mp, chatId);
  return n;
}

export function chatMessages(mp: string, chatId: string, limit = 500): ChatMsgRow[] {
  return (chatDb().prepare(`SELECT msg_id, at, from_buyer, text FROM chat_messages WHERE marketplace = ? AND chat_id = ?
    ORDER BY at DESC LIMIT ?`).all(mp, chatId, limit) as any[])
    .reverse().map(r => ({ id: r.msg_id, at: r.at, fromBuyer: !!r.from_buyer, text: r.text }));
}

/** Пересчитать «последнее сообщение» диалога; новое сообщение покупателя сбрасывает отправленный статус. */
export function touchThread(mp: string, chatId: string): void {
  const d = chatDb();
  const last = d.prepare(`SELECT msg_id, at, from_buyer, text FROM chat_messages WHERE marketplace = ? AND chat_id = ?
    ORDER BY at DESC LIMIT 1`).get(mp, chatId) as any;
  if (!last) return;
  const cur = d.prepare('SELECT status, draft_for FROM chat_threads WHERE marketplace = ? AND chat_id = ?').get(mp, chatId) as any;
  let status = cur?.status || 'idle';
  if (last.from_buyer) {
    // Покупатель написал после нашего ответа или черновика — нужен новый ответ.
    if (!cur || status === 'idle' || status === 'sent' || status === 'skipped' || (cur.draft_for && cur.draft_for !== last.msg_id)) status = 'new';
  } else {
    status = 'idle'; // последним ответил магазин (в т.ч. вручную в кабинете)
  }
  d.prepare(`INSERT INTO chat_threads (marketplace, chat_id, last_at, last_from_buyer, last_text, status, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(marketplace, chat_id) DO UPDATE SET last_at = excluded.last_at, last_from_buyer = excluded.last_from_buyer,
      last_text = excluded.last_text, status = excluded.status, updated_at = excluded.updated_at`)
    .run(mp, chatId, last.at, last.from_buyer, String(last.text).slice(0, 300), status, Date.now());
}

export function setThreadMeta(mp: string, chatId: string, meta: { replySign?: string | null; clientName?: string | null; sku?: string | null; offerId?: string | null; productName?: string | null }): void {
  chatDb().prepare(`INSERT INTO chat_threads (marketplace, chat_id, reply_sign, client_name, sku, offer_id, product_name, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(marketplace, chat_id) DO UPDATE SET reply_sign = COALESCE(excluded.reply_sign, reply_sign),
      client_name = COALESCE(excluded.client_name, client_name), sku = COALESCE(excluded.sku, sku),
      offer_id = COALESCE(excluded.offer_id, offer_id), product_name = COALESCE(excluded.product_name, product_name)`)
    .run(mp, chatId, meta.replySign ?? null, meta.clientName ?? null, meta.sku ?? null, meta.offerId ?? null, meta.productName ?? null, Date.now());
}

export function patchThread(mp: string, chatId: string, fields: Record<string, unknown>): void {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  chatDb().prepare(`UPDATE chat_threads SET ${keys.map(k => `${k} = ?`).join(', ')}, updated_at = ? WHERE marketplace = ? AND chat_id = ?`)
    .run(...keys.map(k => fields[k] as any), Date.now(), mp, chatId);
}

export type ChatThread = {
  marketplace: 'wb' | 'ozon'; chatId: string; clientName: string | null; sku: string | null; offerId: string | null;
  productName: string | null; lastAt: number | null; lastFromBuyer: boolean; lastText: string | null;
  status: 'idle' | 'new' | 'drafted' | 'escalated' | 'sent' | 'skipped';
  draftAnswer: string | null; draftModel: string | null; draftCostUsd: number | null; draftFor: string | null;
  confidence: string | null; escalationReason: string | null; sourcesUsed: string[];
  sentAt: number | null; sentBy: string | null; sendError: string | null; canReply: boolean;
};

export function rowToThread(r: any): ChatThread {
  return {
    marketplace: r.marketplace, chatId: r.chat_id, clientName: r.client_name, sku: r.sku, offerId: r.offer_id,
    productName: r.product_name, lastAt: r.last_at, lastFromBuyer: !!r.last_from_buyer, lastText: r.last_text,
    status: r.status, draftAnswer: r.draft_answer, draftModel: r.draft_model, draftCostUsd: r.draft_cost, draftFor: r.draft_for,
    confidence: r.confidence, escalationReason: r.escalation_reason, sourcesUsed: safeJson(r.sources_used, []),
    sentAt: r.sent_at, sentBy: r.sent_by, sendError: r.send_error, canReply: !!r.reply_sign,
  };
}

export function getThread(mp: string, chatId: string): ChatThread | null {
  const r = chatDb().prepare('SELECT * FROM chat_threads WHERE marketplace = ? AND chat_id = ?').get(mp, chatId);
  return r ? rowToThread(r) : null;
}

export function replySignOf(mp: string, chatId: string): string | null {
  const r = chatDb().prepare('SELECT reply_sign FROM chat_threads WHERE marketplace = ? AND chat_id = ?').get(mp, chatId) as any;
  return r?.reply_sign || null;
}

/** Артикул WB по nmID: из карточек (kv «wbnm:») или из собранных отзывов. */
export function wbOfferByNm(nm: number | string | null | undefined): string | null {
  if (!nm) return null;
  const v = kvGet<string | null>(`wbnm:${nm}`, null);
  if (v) return v;
  const r = getDb().prepare("SELECT offer_id FROM items WHERE marketplace = 'wb' AND sku = ? AND offer_id IS NOT NULL LIMIT 1").get(String(nm)) as any;
  return r?.offer_id || null;
}
