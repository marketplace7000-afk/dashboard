/**
 * Агент 2 «Отзывы и вопросы» — что ИИ берёт из кабинетов, кроме самих отзывов:
 *  1) карточки товаров (название, характеристики, описание) — WB Content API и
 *     Ozon /v1/product/info/description; раз в сутки. Нужны для товаров, по которым
 *     нет папки на Яндекс.Диске (таких большинство среди старых артикулов);
 *  2) переписка с покупателями в чатах WB (buyer-chat-api, events) и Ozon
 *     (v3/chat/list + v3/chat/history) — только чтение; пары «вопрос покупателя →
 *     ответ магазина» без имён, телефоны и почта вырезаются;
 *  3) профиль стиля: Claude один раз в неделю читает выборку наших реальных ответов
 *     и описывает, как магазин отвечает (приёмы, решения, тон). Это заменяет
 *     ручные «правила тона», «FAQ» и «шаблоны».
 */
import { wbUpstream, ozonUpstream } from '../../_proxy';
import { fetchWithRetry } from '../fetchRetry';
import { getDb, kvGet, kvSet, kvUpdatedAt, rlog, getSettings } from './db';
import { stripPii } from './kb';
import { askClaude } from './claude';
import { chatDb, addMessages, chatMessages, setThreadMeta, getThread, wbOfferByNm } from './chatStore';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const errText = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 200);

function htmlToText(s: string): string {
  return String(s || '')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|li|div|h\d)>/gi, '\n').replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

// ─── 1. Карточки товаров ────────────────────────────────────────────────────
function saveCard(mp: 'wb' | 'ozon', offerId: string, name: string, text: string): void {
  getDb().prepare(`INSERT INTO kb_cards (marketplace, offer_id, name, text, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(marketplace, offer_id) DO UPDATE SET name = excluded.name, text = excluded.text, updated_at = excluded.updated_at`)
    .run(mp, offerId, name.slice(0, 300), text.slice(0, 8000), Date.now());
}

export function wbCardText(c: any): string {
  const lines: string[] = [];
  if (c.title) lines.push(`Название: ${c.title}`);
  if (c.brand) lines.push(`Бренд: ${c.brand}`);
  for (const ch of c.characteristics || []) {
    const v = Array.isArray(ch.value) ? ch.value.join(', ') : ch.value;
    if (ch.name && v !== undefined && v !== '') lines.push(`${ch.name}: ${v}`);
  }
  const d = c.dimensions;
  if (d && (d.length || d.width || d.height)) lines.push(`Габариты упаковки, см: ${d.length}×${d.width}×${d.height}${d.weightBrutto ? `, вес ${d.weightBrutto} кг` : ''}`);
  if (c.description) lines.push(`Описание: ${htmlToText(c.description)}`);
  return lines.join('\n');
}

async function refreshWbCards(): Promise<number> {
  const { fetchAllWbCards } = await import('../wbCards');
  const up = wbUpstream('content');
  const { cards } = await fetchAllWbCards({ base: up.base, headers: up.headers as any });
  let n = 0;
  for (const c of cards) {
    if (!c?.vendorCode) continue;
    saveCard('wb', String(c.vendorCode).trim(), String(c.title || ''), wbCardText(c));
    // nmID → артикул: пригодится, чтобы привязать чаты WB к товару.
    getDb().prepare(`INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
      .run(`wbnm:${c.nmID}`, JSON.stringify(String(c.vendorCode).trim()), Date.now());
    n++;
  }
  return n;
}

async function ozonPost(path: string, body: unknown): Promise<any> {
  const up = ozonUpstream();
  const r = await fetchWithRetry(`${up.base}${path}`, {
    method: 'POST',
    headers: { ...(up.headers as any), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, { maxRetries: 2, timeoutMs: 40_000 });
  const t = await r.text();
  if (!r.ok) throw new Error(`Ozon ${path} ${r.status}: ${t.slice(0, 200)}`);
  return JSON.parse(t);
}

async function refreshOzonCards(): Promise<number> {
  const items: { product_id: number; offer_id: string }[] = [];
  // Архивные тоже: по ним приходят вопросы, а карточка остаётся на площадке.
  for (const visibility of ['ALL', 'ARCHIVED']) {
    let lastId = '';
    for (let page = 0; page < 10; page++) {
      const pl = await ozonPost('/v3/product/list', { filter: { visibility }, last_id: lastId, limit: 1000 });
      const arr: any[] = pl?.result?.items ?? [];
      for (const it of arr) if (it.product_id && it.offer_id) items.push({ product_id: it.product_id, offer_id: String(it.offer_id) });
      lastId = pl?.result?.last_id ?? '';
      if (!lastId || arr.length < 1000) break;
    }
  }
  let n = 0;
  for (const it of items) {
    try {
      const r = await ozonPost('/v1/product/info/description', { product_id: it.product_id });
      const name = String(r?.result?.name || '');
      const desc = htmlToText(r?.result?.description || '');
      if (name || desc) { saveCard('ozon', it.offer_id.trim(), name, [`Название: ${name}`, desc ? `Описание: ${desc}` : ''].filter(Boolean).join('\n')); n++; }
    } catch (e) {
      rlog('warn', 'Ozon: описание товара не получено', { offer: it.offer_id, error: errText(e) });
    }
    await sleep(250);
  }
  return n;
}

export async function refreshCards(): Promise<{ wb: number; ozon: number }> {
  const out = { wb: 0, ozon: 0 };
  try { out.wb = await refreshWbCards(); } catch (e) { rlog('warn', 'WB: карточки не получены', { error: errText(e) }); }
  try { out.ozon = await refreshOzonCards(); } catch (e) { rlog('warn', 'Ozon: карточки не получены', { error: errText(e) }); }
  kvSet('cards_refresh', { at: Date.now(), ...out });
  rlog('info', 'Карточки товаров обновлены', out);
  return out;
}

export function cardStats(): { wb: number; ozon: number; at: number | null } {
  const rows = getDb().prepare('SELECT marketplace, COUNT(*) AS n FROM kb_cards GROUP BY marketplace').all() as any[];
  const by = Object.fromEntries(rows.map(r => [r.marketplace, r.n]));
  return { wb: by.wb || 0, ozon: by.ozon || 0, at: kvUpdatedAt('cards_refresh') };
}

/** Все наши артикулы из карточек — для подбора папок Диска без лишних запросов к WB. */
export function cardOfferIds(): string[] {
  return (getDb().prepare('SELECT DISTINCT offer_id FROM kb_cards').all() as any[]).map(r => String(r.offer_id));
}

// ─── 2. Чаты покупателей ────────────────────────────────────────────────────
type ChatMsg = { id: string; at: number; fromBuyer: boolean; text: string };

/**
 * Пары из ленты одного чата: подряд идущие сообщения покупателя → ближайший ответ магазина.
 * Автосообщения магазина без вопроса покупателя (напр. «вы оставили отзыв с низкой оценкой») пропускаются.
 */
export function pairsFromChat(msgs: ChatMsg[]): { id: string; at: number; question: string; answer: string }[] {
  const out: { id: string; at: number; question: string; answer: string }[] = [];
  const sorted = [...msgs].sort((a, b) => a.at - b.at);
  let q: string[] = []; let a: string[] = []; let aId = ''; let aAt = 0;
  const flush = () => {
    if (q.length && a.length) out.push({ id: aId, at: aAt, question: q.join('\n'), answer: a.join('\n') });
    q = []; a = []; aId = ''; aAt = 0;
  };
  for (const m of sorted) {
    const t = m.text.trim();
    if (!t) continue;
    if (m.fromBuyer) { if (a.length) flush(); q.push(t); }
    else if (q.length) { if (!a.length) { aId = m.id; aAt = m.at; } a.push(t); }
  }
  flush();
  return out;
}

function savePairs(source: 'wb_chat' | 'ozon_chat', chatId: string, offerId: string | null, msgs: ChatMsg[]): number {
  const ins = getDb().prepare(`INSERT OR REPLACE INTO kb_tg (dialog_id, message_id, question, answer, date, source, offer_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  let n = 0;
  for (const p of pairsFromChat(msgs)) {
    const q = stripPii(p.question).slice(0, 2000);
    const a = stripPii(p.answer).slice(0, 2000);
    if (q.length < 3 || a.length < 2) continue;
    ins.run(`${source === 'wb_chat' ? 'wb' : 'oz'}:${chatId}`, p.id, q, a, new Date(p.at).toISOString(), source, offerId);
    n++;
  }
  return n;
}

export const WB_CHAT_BASE = 'https://buyer-chat-api.wildberries.ru';
/** Токен для чатов WB: отдельный WB_TOKEN_CHAT, если задан, иначе токен «Вопросы и отзывы». */
export function wbChatHeaders(): Record<string, string> {
  const own = (process.env.WB_TOKEN_CHAT || '').trim();
  return own ? { Authorization: own } : (wbUpstream('feedbacks').headers as any);
}

/** Текст события WB: текст сообщения или пометка о вложении. */
function wbEventText(e: any): string {
  const t = String(e.message?.text || '').trim();
  if (t) return t;
  const att = e.message?.attachments || {};
  if (att.images?.length) return `[фото: ${att.images.length}]`;
  if (att.files?.length) return `[файл: ${att.files.map((f: any) => f.name).filter(Boolean).join(', ') || att.files.length}]`;
  if (att.goodCard) return '[карточка товара]';
  return '';
}

let wbSyncing: Promise<{ events: number; pairs: number }> | null = null;
/** Синхронизация чатов WB (один проход за раз: её зовут и 5-минутный таймер чатов, и общий 30-минутный). */
export function syncWbChats(maxPages = 30): Promise<{ events: number; pairs: number }> {
  if (wbSyncing) return wbSyncing;
  wbSyncing = syncWbChatsOnce(maxPages).finally(() => { wbSyncing = null; });
  return wbSyncing;
}

async function syncWbChatsOnce(maxPages: number): Promise<{ events: number; pairs: number }> {
  const get = async (path: string) => {
    const r = await fetchWithRetry(`${WB_CHAT_BASE}${path}`, { headers: wbChatHeaders() }, { maxRetries: 2, timeoutMs: 60_000 });
    const t = await r.text();
    if (!r.ok) throw new Error(`WB чаты ${r.status}: ${t.slice(0, 200)}`);
    return JSON.parse(t);
  };
  chatDb();
  // Список чатов: подпись для ответа (replySign), имя покупателя, товар.
  try {
    const list = await get('/api/v1/seller/chats');
    for (const c of list?.result || []) {
      if (!c?.chatID) continue;
      const nm = c?.goodCard?.nmID ? String(c.goodCard.nmID) : null;
      setThreadMeta('wb', c.chatID, {
        replySign: c.replySign || null, clientName: c.clientName || null, sku: nm,
        offerId: wbOfferByNm(nm), productName: c?.goodCard?.name || null,
      });
    }
  } catch (e) { rlog('warn', 'WB: список чатов не получен', { error: errText(e) }); }

  let next = kvGet<number | null>('wbchat_next', null);
  let events = 0;
  const touched = new Set<string>();
  for (let page = 0; page < maxPages; page++) {
    const j = await get(`/api/v1/seller/events${next ? `?next=${next}` : ''}`);
    const evs: any[] = j?.result?.events || [];
    const byChat = new Map<string, ChatMsg[]>();
    for (const e of evs) {
      if (e.eventType !== 'message' || !e.chatID) continue;
      const text = wbEventText(e);
      if (!text) continue;
      const arr = byChat.get(e.chatID) || [];
      arr.push({ id: String(e.eventID), at: Number(e.addTimestamp) || Date.parse(e.addTime) || 0, fromBuyer: e.sender === 'client', text: text.slice(0, 2000) });
      byChat.set(e.chatID, arr);
    }
    for (const [id, arr] of byChat) {
      const n = addMessages('wb', id, arr);
      if (n) { events += n; touched.add(id); }
    }
    const nx = Number(j?.result?.next) || null;
    if (!evs.length || !nx || nx === next) break;
    next = nx;
    kvSet('wbchat_next', next);
    await sleep(1200);
  }
  let pairs = 0;
  for (const id of touched) {
    const th = getThread('wb', id);
    // Пометки о вложениях в базу знаний не берём.
    pairs += savePairs('wb_chat', id, th?.offerId || null, chatMessages('wb', id).filter(m => !/^\[(фото|файл|карточка)/.test(m.text)));
  }
  return { events, pairs };
}

/** Название и артикул Ozon по sku: карта активных товаров + карточки (в т.ч. архивные). */
function ozonOfferName(sku: string | null, skuMap: Record<string, string>): { offerId: string | null; name: string | null } {
  if (!sku) return { offerId: null, name: null };
  let offerId = skuMap[sku] || null;
  if (!offerId) {
    const r = getDb().prepare("SELECT offer_id FROM items WHERE marketplace = 'ozon' AND sku = ? AND offer_id IS NOT NULL LIMIT 1").get(sku) as any;
    offerId = r?.offer_id || null;
  }
  let name: string | null = null;
  if (offerId) {
    const c = getDb().prepare("SELECT name FROM kb_cards WHERE marketplace = 'ozon' AND UPPER(offer_id) = UPPER(?)").get(offerId) as any;
    name = c?.name || null;
  }
  return { offerId, name };
}

/**
 * Товар чата, когда площадка его не указала: ищем в сообщениях покупателя номер товара
 * (nmID / SKU), артикул продавца или номер отправления Ozon. Запросы к площадке — только
 * по номеру отправления, не больше budget.left за проход.
 */
async function guessChatProduct(mp: 'wb' | 'ozon', texts: string[], skuMap: Record<string, string>, budget: { left: number }): Promise<{ sku: string | null; offerId: string | null; name: string | null } | null> {
  const all = texts.join('\n');
  const d = getDb();
  for (const n of new Set(all.match(/(?<![\d-])\d{6,12}(?![\d-])/g) || [])) {
    if (mp === 'wb') {
      const offerId = kvGet<string | null>(`wbnm:${n}`, null);
      if (offerId) return { sku: n, offerId, name: null };
    } else {
      const { offerId, name } = ozonOfferName(n, skuMap);
      if (offerId) return { sku: n, offerId, name };
    }
  }
  const words = new Set((all.toUpperCase().match(/[A-ZА-ЯЁ0-9][A-ZА-ЯЁ0-9_.\/-]{3,40}/g) || []).filter(w => /\d/.test(w) && /[A-ZА-ЯЁ]/.test(w)));
  if (words.size) {
    const ids = d.prepare('SELECT offer_id, name FROM kb_cards WHERE marketplace = ?').all(mp) as any[];
    const hit = ids.find(r => words.has(String(r.offer_id).toUpperCase()));
    if (hit) return { sku: null, offerId: String(hit.offer_id), name: hit.name || null };
  }
  if (mp === 'ozon') {
    for (const pn of new Set(all.match(/(?<!\d)\d{8,10}-\d{4}(?:-\d{1,2})?(?!\d)/g) || [])) {
      if (budget.left <= 0) break;
      budget.left--;
      const posting = pn.split('-').length === 3 ? pn : `${pn}-1`;
      for (const path of ['/v3/posting/fbs/get', '/v2/posting/fbo/get']) {
        try {
          const j = await ozonPost(path, { posting_number: posting });
          const p = (j?.result ?? j)?.products?.[0];
          if (p?.offer_id) return { sku: p.sku ? String(p.sku) : null, offerId: String(p.offer_id), name: p.name || null };
        } catch { /* не это отправление или не та схема — пробуем дальше */ }
      }
    }
  }
  return null;
}

/** Догоняем товар у недавних чатов без товара (по сообщениям покупателя; повторно — только при новых сообщениях). */
export async function fillChatProducts(maxChats = 40): Promise<number> {
  const d = chatDb();
  const rows = d.prepare(`SELECT marketplace, chat_id, last_at FROM chat_threads WHERE offer_id IS NULL
    AND last_at >= ? ORDER BY last_at DESC LIMIT 300`).all(Date.now() - 60 * 86400_000) as any[];
  let skuMap: Record<string, string> = {};
  if (rows.some(r => r.marketplace === 'ozon')) {
    try { skuMap = await (await import('../ozonShowcase')).getSkuMap(); } catch { /* без карты */ }
  }
  const old = kvGet<Record<string, number>>('chatprod_tried', {});
  const tried: Record<string, number> = {};  // только текущие чаты без товара — список не растёт
  for (const r of rows) { const k = `${r.marketplace}:${r.chat_id}`; if (old[k]) tried[k] = old[k]; }
  const budget = { left: 15 };
  let found = 0; let n = 0;
  for (const r of rows) {
    const key = `${r.marketplace}:${r.chat_id}`;
    if (tried[key] === r.last_at) continue;
    if (++n > maxChats) break;
    tried[key] = r.last_at;
    const texts = chatMessages(r.marketplace, r.chat_id, 100).filter(m => m.fromBuyer).map(m => m.text);
    const g = await guessChatProduct(r.marketplace, texts, skuMap, budget);
    if (!g) continue;
    setThreadMeta(r.marketplace, r.chat_id, { sku: g.sku, offerId: g.offerId, productName: g.name });
    found++;
  }
  kvSet('chatprod_tried', tried);
  if (found) rlog('info', 'Чаты: товар найден по сообщениям', { found });
  return found;
}

let ozSyncing: Promise<{ chats: number; pairs: number; messages: number }> | null = null;
/** Синхронизация чатов Ozon (только изменившиеся с прошлого раза; один проход за раз). */
export function syncOzonChats(maxChats = 60): Promise<{ chats: number; pairs: number; messages: number }> {
  if (ozSyncing) return ozSyncing;
  ozSyncing = syncOzonChatsOnce(maxChats).finally(() => { ozSyncing = null; });
  return ozSyncing;
}

async function syncOzonChatsOnce(maxChats: number): Promise<{ chats: number; pairs: number; messages: number }> {
  let skuMap: Record<string, string> = {};
  try { skuMap = await (await import('../ozonShowcase')).getSkuMap(); } catch { /* без артикулов */ }
  chatDb();
  // v2: с 06.10 сообщения Ozon хранятся в chat_messages (раньше — только пары), поэтому новый список «увиденных».
  const seen = kvGet<Record<string, string>>('ozchat_seen2', {});
  const todo: { id: string; last: string }[] = [];
  let cursor = '';
  for (let page = 0; page < 50 && todo.length < maxChats; page++) {
    const r = await ozonPost('/v3/chat/list', { filter: { chat_status: 'All' }, limit: 100, ...(cursor ? { cursor } : {}) });
    for (const c of r?.chats || []) {
      const id = c?.chat?.chat_id;
      const type = String(c?.chat?.chat_type || '');
      if (!id || /support/i.test(type)) continue;  // переписка с поддержкой Ozon — не покупатели
      const last = String(c.last_message_id ?? '');
      if (seen[id] === last) continue;
      todo.push({ id, last });
      if (todo.length >= maxChats) break;
    }
    if (!r?.has_next || !r?.cursor) break;
    cursor = r.cursor;
  }
  let pairs = 0; let messages = 0;
  for (const { id, last } of todo) {
    try {
      const h = await ozonPost('/v3/chat/history', { chat_id: id, direction: 'Backward', limit: 100 });
      const msgs: ChatMsg[] = [];
      let sku: string | null = null;
      for (const m of h?.messages || []) {
        const type = String(m?.user?.type || '');
        if (m?.context?.sku && !sku) sku = String(m.context.sku);
        if (!/customer|seller/i.test(type)) continue;  // уведомления, бот, поддержка — не переписка
        let text = (Array.isArray(m?.data) ? m.data.join('\n') : String(m?.data || '')).trim();
        if (!text && (m?.images?.length || m?.files?.length)) text = '[фото/файл]';
        if (!text) continue;
        msgs.push({ id: String(m.message_id), at: Date.parse(m.created_at) || 0, fromBuyer: /customer/i.test(type), text: text.slice(0, 2000) });
      }
      // Пометка о товаре обычно в начале чата: в длинной переписке она старше последних 100 сообщений.
      // Один раз на чат, чтобы не листать историю при каждом новом сообщении.
      if (!sku && !getThread('ozon', id)?.sku && (h?.messages?.length ?? 0) >= 100 && !kvGet<boolean>(`ozdeep:${id}`, false)) {
        kvSet(`ozdeep:${id}`, true);
        let from = h.messages.reduce((a: any, m: any) => (!a || Date.parse(m.created_at) < Date.parse(a.created_at) ? m : a), null)?.message_id;
        for (let page = 0; page < 3 && from && !sku; page++) {
          await sleep(350);
          const older = await ozonPost('/v3/chat/history', { chat_id: id, direction: 'Backward', from_message_id: String(from), limit: 100 }).catch(() => null);
          const arr: any[] = older?.messages || [];
          for (const m of arr) if (m?.context?.sku) { sku = String(m.context.sku); break; }
          if (arr.length < 100) break;
          from = arr.reduce((a: any, m: any) => (!a || Date.parse(m.created_at) < Date.parse(a.created_at) ? m : a), null)?.message_id;
        }
      }
      const { offerId, name } = ozonOfferName(sku, skuMap);
      setThreadMeta('ozon', id, { replySign: id, sku, offerId, productName: name });
      messages += addMessages('ozon', id, msgs);
      pairs += savePairs('ozon_chat', id, offerId, msgs.filter(m => !/^\[(фото|файл)/.test(m.text)));
      seen[id] = last;
    } catch (e) {
      rlog('warn', 'Ozon: история чата не получена', { error: errText(e) });
      break;
    }
    await sleep(350);
  }
  kvSet('ozchat_seen2', seen);
  return { chats: todo.length, pairs, messages };
}

let syncing: Promise<any> | null = null;
export function syncChats(): Promise<any> {
  if (syncing) return syncing;
  syncing = (async () => {
    const out: any = {};
    try { out.wb = await syncWbChats(); } catch (e) { out.wb = { error: errText(e) }; rlog('warn', 'WB: чаты не синхронизированы', out.wb); }
    try { out.ozon = await syncOzonChats(); } catch (e) { out.ozon = { error: errText(e) }; rlog('warn', 'Ozon: чаты не синхронизированы', out.ozon); }
    if ((out.wb?.pairs || 0) + (out.ozon?.pairs || 0) > 0) rlog('info', 'Чаты покупателей: пары обновлены', out);
    kvSet('chats_sync', { at: Date.now(), ...out });
    return out;
  })().finally(() => { syncing = null; });
  return syncing;
}

export function chatStats(): { wb: number; ozon: number; at: number | null } {
  const rows = getDb().prepare("SELECT source, COUNT(*) AS n FROM kb_tg WHERE source <> 'tg' GROUP BY source").all() as any[];
  const by = Object.fromEntries(rows.map(r => [r.source, r.n]));
  return { wb: by.wb_chat || 0, ozon: by.ozon_chat || 0, at: kvUpdatedAt('chats_sync') };
}

// ─── 3. Профиль стиля ───────────────────────────────────────────────────────
export type StyleProfile = { text: string; at: number; basedOn: number; fresh?: number; version?: number };

const STYLE_PROMPT = `Ниже — реальные ответы интернет-магазина автотоваров и электроники (Wildberries и Ozon) покупателям: на отзывы с разной оценкой, на вопросы о товарах и в чатах.
Составь по ним «профиль стиля» — инструкцию для нового сотрудника поддержки, как отвечает ЭТОТ магазин. Опиши кратко, по пунктам:
1. Приветствие, обращение, подпись, длина ответа, эмодзи — как принято.
2. Как отвечаем на благодарность (5★) так, чтобы ответы не повторялись.
3. Как работаем с негативом и жалобами: какие шаги предлагаем (возврат через личный кабинет площадки, проверка настроек, обращение в чат продавца и т.п.), как снимаем напряжение и переводим разговор в решение, чего никогда не пишем.
4. Как отвечаем на вопросы о совместимости, характеристиках, настройке, гарантии — какие факты обычно приводим.
5. Типичные проблемы покупателей по нашим товарам и наши проверенные решения (по товарам, если видно).
6. Сильные приёмы, которые стоит повторять, и слабые места прошлых ответов, которые не надо копировать.
Не используй имена, телефоны, ссылки и номера заказов. До 600 слов, без вступления.`;

/** Повторный разбор: профиль не пишется с нуля, а дорабатывается по свежим ответам. */
const STYLE_UPDATE = `Ниже — текущий профиль стиля (составлен раньше) и ответы магазина. Ответы с пометкой «новый» появились после прошлого разбора — по ним видно, как магазин отвечает СЕЙЧАС.
Улучши профиль: сохрани то, что подтверждается; поправь то, что в новых ответах делается иначе (новый вариант важнее старого); добавь новые приёмы, типичные проблемы и решения; убери устаревшее и повторы. Формат и пункты те же.`;

export function getStyleProfile(): StyleProfile | null {
  return kvGet<StyleProfile | null>('style_profile', null);
}

// Учимся только на ответах людей: данных в кабинете вручную и опубликованных менеджером с сайта.
// Автопубликации агента не берём — иначе он учился бы сам на себе.
const HUMAN = "mp_answer IS NOT NULL AND LENGTH(mp_answer) > 15 AND (published_by IS NULL OR published_by <> 'auto')";
const answeredAt = 'COALESCE(published_at, created_at)';

function answeredCount(): number {
  const a = (getDb().prepare(`SELECT COUNT(*) AS n FROM items WHERE ${HUMAN}`).get() as any).n;
  const b = (getDb().prepare("SELECT COUNT(*) AS n FROM kb_tg").get() as any).n;
  return a + b;
}

/** Ответы людей, появившиеся после момента since. */
function freshCount(since: number): number {
  const a = (getDb().prepare(`SELECT COUNT(*) AS n FROM items WHERE ${HUMAN} AND ${answeredAt} > ?`).get(since) as any).n;
  const b = (getDb().prepare('SELECT COUNT(*) AS n FROM kb_tg WHERE date > ?').get(new Date(since).toISOString()) as any).n;
  return a + b;
}

export async function buildStyleProfile(): Promise<StyleProfile> {
  const d = getDb();
  const prev = getStyleProfile();
  const since = prev?.at ?? 0;
  const sinceIso = new Date(since).toISOString();
  // В каждой группе сначала свежие ответы (после прошлого разбора), остаток — случайные старые.
  const pick = (where: string, n: number) => d.prepare(`SELECT kind, rating, text, pros, cons, mp_answer, ${answeredAt} > ? AS fresh
    FROM items WHERE ${HUMAN} AND ${where} ORDER BY fresh DESC, RANDOM() LIMIT ?`).all(since, n) as any[];
  const samples = [
    ...pick("kind = 'review' AND rating <= 3", 45),
    ...pick("kind = 'review' AND rating = 4", 15),
    ...pick("kind = 'review' AND rating = 5 AND LENGTH(text) > 0", 20),
    ...pick("kind = 'review' AND rating = 5 AND LENGTH(text) = 0", 10),
    ...pick("kind = 'question'", 50),
  ];
  const chats = d.prepare('SELECT source, question, answer, date > ? AS fresh FROM kb_tg ORDER BY fresh DESC, RANDOM() LIMIT 40').all(sinceIso) as any[];
  const cut = (s: string, n: number) => String(s || '').replace(/\s+/g, ' ').slice(0, n);
  const mark = (r: any) => prev && r.fresh ? ', новый' : '';
  const lines = [
    ...samples.map(r => `[${r.kind === 'review' ? `отзыв ${r.rating ?? '?'}★` : 'вопрос'}${mark(r)}] «${cut([r.text, r.pros && `+ ${r.pros}`, r.cons && `− ${r.cons}`].filter(Boolean).join(' '), 300) || '(без текста)'}» → «${cut(r.mp_answer, 400)}»`),
    ...chats.map(r => `[чат ${r.source === 'tg' ? 'Telegram' : r.source === 'wb_chat' ? 'WB' : 'Ozon'}${mark(r)}] «${cut(stripPii(r.question), 250)}» → «${cut(stripPii(r.answer), 350)}»`),
  ];
  if (lines.length < 15) throw new Error('Мало наших прошлых ответов для профиля стиля — дождитесь догрузки истории');
  const fresh = [...samples, ...chats].filter(r => r.fresh).length;
  const s = getSettings();
  const content = prev
    ? `${STYLE_PROMPT}\n\n${STYLE_UPDATE}\n\n# Текущий профиль\n${prev.text}\n\n# Ответы магазина\n${lines.join('\n')}`
    : `${STYLE_PROMPT}\n\n${lines.join('\n')}`;
  const { text, usage, stop } = await askClaude('style', {
    // Разбор раз в неделю: средних размышлений хватает, высокие оплачивались бы как лишний ответ.
    model: s.draftModel, max_tokens: 8000, effort: 'medium',
    messages: [{ role: 'user', content }],
  });
  const prof: StyleProfile = { text: text.trim(), at: Date.now(), basedOn: answeredCount(), fresh, version: (prev?.version ?? 1) + (prev ? 1 : 0) };
  rlog('info', 'Профиль стиля обновлён', { version: prof.version, samples: lines.length, fresh, chars: prof.text.length, out: usage?.output_tokens, in: usage?.input_tokens, stop });
  if (prof.text.length < 1200) throw new Error(`Профиль получился слишком коротким (${prof.text.length} симв., stop=${stop}) — повторите позже`);
  if (prev) kvSet('style_profile_prev', prev);  // прошлая версия — на случай отката
  kvSet('style_profile', prof);
  return prof;
}

/**
 * Раз в неделю, если с прошлого разбора есть хотя бы 10 новых ответов людей (иначе учиться не на чем —
 * токены не тратим), или раньше (не чаще раза в сутки), если ответов стало вдвое больше.
 */
export function styleProfileDue(): boolean {
  const p = getStyleProfile();
  const n = answeredCount();
  if (!p) return n >= 30;
  const age = Date.now() - p.at;
  if (age <= 86400_000) return false;
  return (age > 7 * 86400_000 && freshCount(p.at) >= 10) || n > 2 * Math.max(p.basedOn, 1);
}
