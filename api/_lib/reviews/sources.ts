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
  let lastId = '';
  for (let page = 0; page < 10; page++) {
    const pl = await ozonPost('/v3/product/list', { filter: { visibility: 'ALL' }, last_id: lastId, limit: 1000 });
    const arr: any[] = pl?.result?.items ?? [];
    for (const it of arr) if (it.product_id && it.offer_id) items.push({ product_id: it.product_id, offer_id: String(it.offer_id) });
    lastId = pl?.result?.last_id ?? '';
    if (!lastId || arr.length < 1000) break;
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

/** Сырые сообщения WB копим по чатам (лента событий приходит вперемешку), пары пересобираем. */
function wbChatBuffer(chatId: string): ChatMsg[] { return kvGet<ChatMsg[]>(`wbchat:${chatId}`, []); }

async function syncWbChats(maxPages = 30): Promise<{ events: number; pairs: number }> {
  const up = wbUpstream('feedbacks');
  const base = 'https://buyer-chat-api.wildberries.ru';
  const get = async (path: string) => {
    const r = await fetchWithRetry(`${base}${path}`, { headers: up.headers as any }, { maxRetries: 2, timeoutMs: 60_000 });
    const t = await r.text();
    if (!r.ok) throw new Error(`WB чаты ${r.status}: ${t.slice(0, 200)}`);
    return JSON.parse(t);
  };
  // Чат → товар (nmID → артикул).
  const chatGood = kvGet<Record<string, number>>('wbchat_goods', {});
  try {
    const list = await get('/api/v1/seller/chats');
    for (const c of list?.result || []) if (c?.chatID && c?.goodCard?.nmID) chatGood[c.chatID] = c.goodCard.nmID;
    kvSet('wbchat_goods', chatGood);
  } catch (e) { rlog('warn', 'WB: список чатов не получен', { error: errText(e) }); }

  let next = kvGet<number | null>('wbchat_next', null);
  let events = 0;
  const touched = new Set<string>();
  for (let page = 0; page < maxPages; page++) {
    const j = await get(`/api/v1/seller/events${next ? `?next=${next}` : ''}`);
    const evs: any[] = j?.result?.events || [];
    const bufs = new Map<string, ChatMsg[]>();
    for (const e of evs) {
      if (e.eventType !== 'message' || !e.chatID) continue;
      const text = String(e.message?.text || '').trim();
      if (!text) continue;
      const buf = bufs.get(e.chatID) || wbChatBuffer(e.chatID);
      bufs.set(e.chatID, buf);
      if (buf.some(m => m.id === String(e.eventID))) continue;
      buf.push({ id: String(e.eventID), at: Number(e.addTimestamp) || Date.parse(e.addTime) || 0, fromBuyer: e.sender === 'client', text: text.slice(0, 2000) });
      touched.add(e.chatID);
      events++;
    }
    for (const [id, buf] of bufs) kvSet(`wbchat:${id}`, buf.slice(-200));
    const nx = Number(j?.result?.next) || null;
    if (!evs.length || !nx || nx === next) break;
    next = nx;
    kvSet('wbchat_next', next);
    await sleep(1200);
  }
  let pairs = 0;
  for (const id of touched) {
    const nm = chatGood[id];
    const offer = nm ? kvGet<string | null>(`wbnm:${nm}`, null) : null;
    pairs += savePairs('wb_chat', id, offer, wbChatBuffer(id));
  }
  return { events, pairs };
}

async function syncOzonChats(maxChats = 60): Promise<{ chats: number; pairs: number }> {
  let skuMap: Record<string, string> = {};
  try { skuMap = await (await import('../ozonShowcase')).getSkuMap(); } catch { /* без артикулов */ }
  const seen = kvGet<Record<string, string>>('ozchat_seen', {});
  const todo: string[] = [];
  let cursor = '';
  for (let page = 0; page < 30 && todo.length < maxChats; page++) {
    const r = await ozonPost('/v3/chat/list', { filter: { chat_status: 'All' }, limit: 100, ...(cursor ? { cursor } : {}) });
    for (const c of r?.chats || []) {
      const id = c?.chat?.chat_id;
      const type = String(c?.chat?.chat_type || '');
      if (!id || /support/i.test(type)) continue;  // переписка с поддержкой Ozon — не покупатели
      if (seen[id] === String(c.last_message_id)) continue;
      todo.push(id);
      seen[`${id}#last`] = String(c.last_message_id);
      if (todo.length >= maxChats) break;
    }
    if (!r?.has_next || !r?.cursor) break;
    cursor = r.cursor;
  }
  let pairs = 0;
  for (const id of todo) {
    try {
      const h = await ozonPost('/v3/chat/history', { chat_id: id, direction: 'Backward', limit: 100 });
      const msgs: ChatMsg[] = [];
      let sku: string | null = null;
      for (const m of h?.messages || []) {
        const type = String(m?.user?.type || '');
        const text = (Array.isArray(m?.data) ? m.data.join('\n') : String(m?.data || '')).trim();
        if (m?.context?.sku && !sku) sku = String(m.context.sku);
        if (!text || !/customer|seller/i.test(type)) continue;
        msgs.push({ id: String(m.message_id), at: Date.parse(m.created_at) || 0, fromBuyer: /customer/i.test(type), text: text.slice(0, 2000) });
      }
      pairs += savePairs('ozon_chat', id, sku ? (skuMap[sku] || null) : null, msgs);
      seen[id] = seen[`${id}#last`];
    } catch (e) {
      rlog('warn', 'Ozon: история чата не получена', { error: errText(e) });
      break;
    }
    delete seen[`${id}#last`];
    await sleep(400);
  }
  for (const k of Object.keys(seen)) if (k.endsWith('#last')) delete seen[k];
  kvSet('ozchat_seen', seen);
  return { chats: todo.length, pairs };
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
export type StyleProfile = { text: string; at: number; basedOn: number };

const STYLE_PROMPT = `Ниже — реальные ответы интернет-магазина автотоваров и электроники (Wildberries и Ozon) покупателям: на отзывы с разной оценкой, на вопросы о товарах и в чатах.
Составь по ним «профиль стиля» — инструкцию для нового сотрудника поддержки, как отвечает ЭТОТ магазин. Опиши кратко, по пунктам:
1. Приветствие, обращение, подпись, длина ответа, эмодзи — как принято.
2. Как отвечаем на благодарность (5★) так, чтобы ответы не повторялись.
3. Как работаем с негативом и жалобами: какие шаги предлагаем (возврат через личный кабинет площадки, проверка настроек, обращение в чат продавца и т.п.), как снимаем напряжение и переводим разговор в решение, чего никогда не пишем.
4. Как отвечаем на вопросы о совместимости, характеристиках, настройке, гарантии — какие факты обычно приводим.
5. Типичные проблемы покупателей по нашим товарам и наши проверенные решения (по товарам, если видно).
6. Сильные приёмы, которые стоит повторять, и слабые места прошлых ответов, которые не надо копировать.
Не используй имена, телефоны, ссылки и номера заказов. До 600 слов, без вступления.`;

export function getStyleProfile(): StyleProfile | null {
  return kvGet<StyleProfile | null>('style_profile', null);
}

function answeredCount(): number {
  const a = (getDb().prepare("SELECT COUNT(*) AS n FROM items WHERE mp_answer IS NOT NULL AND mp_answer <> ''").get() as any).n;
  const b = (getDb().prepare("SELECT COUNT(*) AS n FROM kb_tg").get() as any).n;
  return a + b;
}

export async function buildStyleProfile(): Promise<StyleProfile> {
  const d = getDb();
  const pick = (sql: string, n: number) => d.prepare(sql).all(n) as any[];
  const base = "FROM items WHERE mp_answer IS NOT NULL AND LENGTH(mp_answer) > 15";
  const samples = [
    ...pick(`SELECT kind, rating, text, pros, cons, mp_answer ${base} AND kind = 'review' AND rating <= 3 ORDER BY RANDOM() LIMIT ?`, 45),
    ...pick(`SELECT kind, rating, text, pros, cons, mp_answer ${base} AND kind = 'review' AND rating = 4 ORDER BY RANDOM() LIMIT ?`, 15),
    ...pick(`SELECT kind, rating, text, pros, cons, mp_answer ${base} AND kind = 'review' AND rating = 5 AND LENGTH(text) > 0 ORDER BY RANDOM() LIMIT ?`, 20),
    ...pick(`SELECT kind, rating, text, pros, cons, mp_answer ${base} AND kind = 'review' AND rating = 5 AND LENGTH(text) = 0 ORDER BY RANDOM() LIMIT ?`, 10),
    ...pick(`SELECT kind, rating, text, pros, cons, mp_answer ${base} AND kind = 'question' ORDER BY RANDOM() LIMIT ?`, 50),
  ];
  const chats = d.prepare('SELECT source, question, answer FROM kb_tg ORDER BY RANDOM() LIMIT 40').all() as any[];
  const cut = (s: string, n: number) => String(s || '').replace(/\s+/g, ' ').slice(0, n);
  const lines = [
    ...samples.map(r => `[${r.kind === 'review' ? `отзыв ${r.rating ?? '?'}★` : 'вопрос'}] «${cut([r.text, r.pros && `+ ${r.pros}`, r.cons && `− ${r.cons}`].filter(Boolean).join(' '), 300) || '(без текста)'}» → «${cut(r.mp_answer, 400)}»`),
    ...chats.map(r => `[чат ${r.source === 'tg' ? 'Telegram' : r.source === 'wb_chat' ? 'WB' : 'Ozon'}] «${cut(stripPii(r.question), 250)}» → «${cut(stripPii(r.answer), 350)}»`),
  ];
  if (lines.length < 15) throw new Error('Мало наших прошлых ответов для профиля стиля — дождитесь догрузки истории');
  const s = getSettings();
  const { text } = await askClaude('style', {
    model: s.draftModel, max_tokens: 2000,
    messages: [{ role: 'user', content: `${STYLE_PROMPT}\n\n${lines.join('\n')}` }],
  });
  const prof: StyleProfile = { text: text.trim(), at: Date.now(), basedOn: answeredCount() };
  kvSet('style_profile', prof);
  rlog('info', 'Профиль стиля обновлён', { samples: lines.length });
  return prof;
}

/** Раз в неделю, или раньше (не чаще раза в сутки), если с прошлого раза наших ответов стало вдвое больше. */
export function styleProfileDue(): boolean {
  const p = getStyleProfile();
  const n = answeredCount();
  if (!p) return n >= 30;
  const age = Date.now() - p.at;
  return age > 7 * 86400_000 || (age > 86400_000 && n > 2 * Math.max(p.basedOn, 1));
}
