/**
 * Раздел «Чаты с покупателями» (WB и Ozon): черновик ответа под весь диалог и отправка.
 * База та же, что у «Отзывов и вопросов»: профиль стиля, карточка товара и материалы Диска,
 * наши прошлые ответы, переписка из Telegram и чатов. Отправка — только кнопкой
 * (тумблер «авто» отдельно для WB и для Ozon, по умолчанию выключены; эскалация не отправляется никогда).
 * Конституция 1.3.0, принцип X: разрешённая запись — текстовый ответ покупателю в чате WB/Ozon.
 */
import { getDb, getSettings, rlog } from './db';
import { askClaude, BudgetExceeded, budgetState } from './claude';
import { productKnowledge, similarTgPairs, similarPastAnswers } from './kb';
import { getStyleProfile, syncWbChats, syncOzonChats, WB_CHAT_BASE, wbChatHeaders } from './sources';
import { ozonUpstream } from '../../_proxy';
import { codeEscalation, extractJson, FORBIDDEN } from './drafts';
import {
  chatDb, chatMessages, getThread, patchThread, rowToThread, replySignOf, addMessages, type ChatThread,
} from './chatStore';

export const CHAT_PROMPT = `Ты — сотрудник поддержки интернет-магазина автотоваров и электроники «avto-vibe». Ведёшь переписку с покупателем в чате продавца на маркетплейсе (Wildberries или Ozon — указано в диалоге). Чаще всего это вопросы об адаптерах CarPlay / Android Auto, Android-приставках и другой автоэлектронике: совместимость с машиной и магнитолой, подключение и настройка, прошивка, неисправности, возврат.

ГЛАВНОЕ: ответь на последние сообщения покупателя с учётом всего диалога. Это живой разговор, а не публичный отзыв: можно задать уточняющий вопрос (марка и год авто, модель магнитолы, телефон, что именно не работает), дать пошаговую инструкцию, предложить следующий шаг.

КАК ОТВЕЧАТЬ:
- Пиши так, как отвечает наш магазин (профиль стиля, прошлые ответы и переписка ниже), но не копируй дословно.
- Сначала суть: конкретный ответ или шаги по порядку. Без воды и канцелярита, на «вы».
- Решение проблем — по шагам, опираясь на материалы товара и на то, как магазин решал такие же случаи раньше.
- Если покупатель недоволен — без спора и оправданий: признай неудобство, предложи понятный путь (проверить настройку, обновить прошивку, оформить возврат или обмен через личный кабинет площадки — если так делал магазин).
- Если для ответа не хватает данных о машине/магнитоле/телефоне — спроси их, а не угадывай.
- Длина — сколько нужно для сути: обычно 1–5 предложений, инструкция — коротким списком.

ЖЁСТКИЕ ПРАВИЛА:
- Факты о товаре (совместимость, характеристики, комплектация) — только из выданных материалов и прошлых ответов магазина. Нет данных — не выдумывай: confidence "low", спроси уточнение или скажи, что уточнишь.
- Никаких ссылок, телефонов, мессенджеров (Telegram, WhatsApp, Макс, Viber), taplink, названий других площадок — маркетплейсы это запрещают, даже если раньше магазин так писал.
- Не обещай денег, компенсаций, подарков, которых магазин не предлагал.
- Не груби и не иронизируй.

ВЕРНИ СТРОГО JSON без пояснений вокруг:
{"answer": "текст сообщения покупателю", "confidence": "high"|"medium"|"low", "category": "question"|"setup"|"problem"|"return"|"complaint"|"other", "needs_escalation": true|false, "escalation_reason": "до 12 слов или null", "sources_used": ["style", "card:<артикул>", "product:<артикул>", "history:<id>", "chat:<id>"]}

needs_escalation = true, если: confidence = "low", ИЛИ брак/возврат/замена/деньги, ИЛИ грубость/угрозы/суд/Роспотребнадзор/жалоба. Иначе — false.`;

// ─── Список и карточка диалога ─────────────────────────────────────────────
export type ChatView = 'waiting' | 'drafts' | 'all';
const WAIT_DAYS = 14;

export type ChatCounts = { waiting: number; drafts: number; wb: { waiting: number; drafts: number }; ozon: { waiting: number; drafts: number } };

export function listThreads(q: { view?: string; q?: string; mp?: string; limit?: number; offset?: number }): { total: number; threads: ChatThread[]; counts: ChatCounts } {
  const d = chatDb();
  const since = Date.now() - WAIT_DAYS * 86400_000;
  const where: string[] = ['last_at IS NOT NULL'];
  const args: any[] = [];
  if (q.mp === 'wb' || q.mp === 'ozon') { where.push('marketplace = ?'); args.push(q.mp); }
  const view = (q.view || 'waiting') as ChatView;
  if (view === 'waiting') { where.push("last_from_buyer = 1 AND status NOT IN ('skipped','sent') AND last_at >= ?"); args.push(since); }
  else if (view === 'drafts') where.push("status IN ('drafted','escalated')");
  if (q.q) {
    const like = `%${String(q.q).slice(0, 80)}%`;
    where.push('(offer_id LIKE ? OR product_name LIKE ? OR client_name LIKE ? OR last_text LIKE ? OR sku = ?)');
    args.push(like, like, like, like, String(q.q));
  }
  const w = `WHERE ${where.join(' AND ')}`;
  const total = (d.prepare(`SELECT COUNT(*) AS n FROM chat_threads ${w}`).get(...args) as any).n;
  const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 200);
  const offset = Math.max(Number(q.offset) || 0, 0);
  const rows = d.prepare(`SELECT * FROM chat_threads ${w} ORDER BY last_at DESC LIMIT ? OFFSET ?`).all(...args, limit, offset) as any[];
  return { total, threads: rows.map(rowToThread), counts: chatCounts() };
}

export function chatCounts(): ChatCounts {
  const d = chatDb();
  const since = Date.now() - WAIT_DAYS * 86400_000;
  const one = (mp: string) => ({
    waiting: (d.prepare(`SELECT COUNT(*) AS n FROM chat_threads WHERE marketplace = ? AND last_from_buyer = 1
      AND status NOT IN ('skipped','sent') AND last_at >= ?`).get(mp, since) as any).n,
    drafts: (d.prepare("SELECT COUNT(*) AS n FROM chat_threads WHERE marketplace = ? AND status IN ('drafted','escalated')").get(mp) as any).n,
  });
  const wb = one('wb'); const ozon = one('ozon');
  return { waiting: wb.waiting + ozon.waiting, drafts: wb.drafts + ozon.drafts, wb, ozon };
}

export function threadWithMessages(mp: string, chatId: string) {
  const th = getThread(mp, chatId);
  if (!th) return null;
  return { thread: th, messages: chatMessages(mp, chatId, 300) };
}

// ─── Черновик ──────────────────────────────────────────────────────────────
export async function draftThread(mp: string, chatId: string): Promise<ChatThread | null> {
  const th = getThread(mp, chatId);
  if (!th) return null;
  const msgs = chatMessages(mp, chatId, 40);
  if (!msgs.length) return th;
  const lastBuyer = [...msgs].reverse().find(m => m.fromBuyer);
  // Последние сообщения покупателя после нашего последнего ответа — то, на что отвечаем.
  const tail: string[] = [];
  for (let i = msgs.length - 1; i >= 0 && msgs[i].fromBuyer; i--) tail.unshift(msgs[i].text);
  const ask = (tail.length ? tail : [lastBuyer?.text || '']).join('\n');
  const s = getSettings();

  const pseudo: any = { id: -1, kind: 'question', text: ask, pros: null, cons: null, rating: null, offerId: th.offerId };
  const know = productKnowledge(th.offerId, `${ask} ${th.productName || ''}`, 7000);
  const past = th.offerId ? similarPastAnswers(pseudo, 6) : [];
  const chats = similarTgPairs(pseudo, 8).filter(p => !p.id.startsWith(`${mp === 'wb' ? 'wb' : 'oz'}:${chatId}:`));
  const style = getStyleProfile();
  const fmt = (t: number) => new Date(t + 3 * 3600_000).toISOString().slice(0, 16).replace('T', ' ');
  const chatName = (src: string) => src === 'wb_chat' ? 'чат WB' : src === 'ozon_chat' ? 'чат Ozon' : 'Telegram';

  const dynamic = [
    `# Диалог в чате ${mp === 'wb' ? 'Wildberries' : 'Ozon'}`,
    `Покупатель: ${th.clientName || '—'}; товар: ${th.productName || '—'}; артикул: ${th.offerId || '—'}${th.sku ? `; ${mp === 'wb' ? 'nmID' : 'SKU'} ${th.sku}` : ''}`,
    `\n# Переписка (старые сверху, время МСК)`,
    ...msgs.map(m => `[${fmt(m.at)}] ${m.fromBuyer ? 'Покупатель' : 'Магазин'}: ${m.text.slice(0, 1200)}`),
    `\n# Что известно о товаре\n${know.text || '(ни карточки, ни материалов — опирайся только на прошлые ответы, факты не придумывай)'}`,
    past.length ? `\n# Наши ответы на похожие вопросы по этому товару\n${past.map(p => `[history:${p.id}] «${p.text || '(без текста)'}» → «${p.answer}»`).join('\n')}` : '',
    chats.length ? `\n# Как магазин отвечал в похожих переписках\n${chats.map(p => `[chat:${p.id}] (${chatName(p.source)}) «${p.question}» → «${p.answer}»`).join('\n')}` : '',
  ].filter(Boolean).join('\n');

  const styleBlock = `# Профиль стиля магазина (выжимка из наших реальных ответов)\n${style?.text || '(профиль ещё не составлен)'}`;
  let res;
  try {
    res = await askClaude('chat-draft', {
      model: s.draftModel, max_tokens: 4000, temperature: 0.5,
      system: [
        { type: 'text', text: CHAT_PROMPT },
        { type: 'text', text: styleBlock, cache_control: { type: 'ephemeral' } },
      ],
      messages: [{ role: 'user', content: dynamic }],
    });
  } catch (e) {
    if (e instanceof BudgetExceeded) throw e;
    patchThread(mp, chatId, { draft_attempts: ((chatDb().prepare('SELECT draft_attempts FROM chat_threads WHERE marketplace = ? AND chat_id = ?').get(mp, chatId) as any)?.draft_attempts || 0) + 1 });
    rlog('warn', 'Чат: черновик не получен', { chat: chatId, error: String((e as Error)?.message ?? e).slice(0, 300) });
    throw e;
  }
  let j: any;
  try { j = extractJson(res.text); } catch {
    j = { answer: res.text.trim(), confidence: 'low', needs_escalation: true, escalation_reason: 'Модель вернула не JSON', sources_used: [] };
  }
  const answer = String(j.answer || '').trim().slice(0, 1000);
  const reasons = [
    codeEscalation({ text: ask, pros: null, cons: null, rating: null, kind: 'question' }, 0),
    FORBIDDEN.test(answer) ? 'В ответе ссылка или контакт' : null,
    j.needs_escalation ? (j.escalation_reason || 'Модель просит проверку') : null,
    j.confidence === 'low' ? 'Низкая уверенность' : null,
    !answer ? 'Пустой ответ' : null,
  ].filter(Boolean) as string[];
  const reason = reasons.length ? [...new Set(reasons)].join('; ') : null;
  patchThread(mp, chatId, {
    draft_answer: answer, draft_model: s.draftModel, draft_cost: res.cost, draft_for: lastBuyer?.id || null,
    confidence: ['high', 'medium', 'low'].includes(j.confidence) ? j.confidence : 'low',
    escalation_reason: reason, status: reason ? 'escalated' : 'drafted', draft_attempts: 0,
    sources_used: JSON.stringify(Array.isArray(j.sources_used) ? j.sources_used.slice(0, 12) : []),
  });
  return getThread(mp, chatId);
}

// ─── Отправка ──────────────────────────────────────────────────────────────
export async function sendThread(mp: string, chatId: string, text: string, by: 'owner' | 'auto'): Promise<{ ok: boolean; error?: string; thread?: ChatThread | null }> {
  if (mp !== 'wb' && mp !== 'ozon') return { ok: false, error: 'Неизвестная площадка' };
  const msg = String(text || '').trim();
  if (!msg) return { ok: false, error: 'Пустое сообщение' };
  if (msg.length > 1000) return { ok: false, error: 'Сообщение длиннее 1000 символов' };
  if (by === 'auto' && FORBIDDEN.test(msg)) return { ok: false, error: 'В ответе ссылка или контакт' };
  let errText = '';
  try {
    if (mp === 'wb') {
      const sign = replySignOf(mp, chatId);
      if (!sign) return { ok: false, error: 'Нет подписи чата (replySign) — дождитесь синхронизации' };
      const form = new FormData();
      form.append('replySign', sign);
      form.append('message', msg);
      const r = await fetch(`${WB_CHAT_BASE}/api/v1/seller/message`, { method: 'POST', headers: wbChatHeaders(), body: form, signal: AbortSignal.timeout(30_000) });
      const t = await r.text();
      let j: any = null; try { j = JSON.parse(t); } catch { /* не JSON */ }
      if (!r.ok || (Array.isArray(j?.errors) && j.errors.length)) errText = `WB ${r.status}: ${String(j?.detail || j?.error || (Array.isArray(j?.errors) ? j.errors.join('; ') : '') || t).slice(0, 200)}`;
    } else {
      const up = ozonUpstream();
      const r = await fetch(`${up.base}/v1/chat/send/message`, {
        method: 'POST', headers: { ...(up.headers as any), 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: msg }), signal: AbortSignal.timeout(30_000),
      });
      const t = await r.text();
      let j: any = null; try { j = JSON.parse(t); } catch { /* не JSON */ }
      if (!r.ok || (j && j.result && j.result !== 'success')) errText = `Ozon ${r.status}: ${String(j?.message || j?.result || t).slice(0, 200)}`;
    }
  } catch (e) { errText = String((e as Error)?.message ?? e).slice(0, 200); }
  const mpName = mp === 'wb' ? 'WB' : 'Ozon';
  if (errText) {
    patchThread(mp, chatId, { send_error: errText });
    rlog('error', `Чат ${mpName}: сообщение не отправлено`, { chat: chatId, by, error: errText });
    return { ok: false, error: errText, thread: getThread(mp, chatId) };
  }
  // Своё сообщение сразу в ленту; событие площадки с настоящим id придёт при синхронизации.
  addMessages(mp as 'wb' | 'ozon', chatId, [{ id: `local:${Date.now()}`, at: Date.now(), fromBuyer: false, text: msg }]);
  patchThread(mp, chatId, { status: 'sent', sent_at: Date.now(), sent_by: by, send_error: null, draft_answer: null });
  rlog('info', `Чат ${mpName}: ответ отправлен`, { chat: chatId, by, text: msg.slice(0, 300) });
  return { ok: true, thread: getThread(mp, chatId) };
}

// ─── Фон: синхронизация каждые 5 минут, черновики к новым сообщениям ─────────
let busy: Promise<any> | null = null;
export function chatTick(): Promise<any> {
  if (busy) return busy;
  busy = (async () => {
    const out: any = {};
    try { out.wb = await syncWbChats(10); } catch (e) { out.wb = { error: String((e as Error).message).slice(0, 200) }; }
    try { out.ozon = await syncOzonChats(80); } catch (e) { out.ozon = { error: String((e as Error).message).slice(0, 200) }; }
    const s = getSettings();
    if (!s.chatAutoDraft) return out;
    const d = chatDb();
    const rows = d.prepare(`SELECT marketplace, chat_id FROM chat_threads WHERE status = 'new' AND last_from_buyer = 1
      AND last_at >= ? AND draft_attempts < 3 ORDER BY last_at DESC LIMIT 15`).all(Date.now() - 48 * 3600_000) as any[];
    let drafted = 0; let sent = 0;
    for (const r of rows) {
      if (budgetState().ratio >= 0.9) { out.stopped = 'budget'; break; }
      try {
        const th = await draftThread(r.marketplace, r.chat_id); drafted++;
        const auto = r.marketplace === 'wb' ? s.chatAutoSendWb : s.chatAutoSendOzon;
        if (auto && th?.status === 'drafted' && th.draftAnswer) {
          const res = await sendThread(r.marketplace, r.chat_id, th.draftAnswer, 'auto');
          if (res.ok) sent++;
        }
      } catch (e) { if (e instanceof BudgetExceeded) { out.stopped = 'budget'; break; } }
    }
    out.drafted = drafted; out.sent = sent;
    return out;
  })().finally(() => { busy = null; });
  return busy;
}

export function scheduleChats(): void {
  chatDb();
  const t = () => chatTick().catch(e => console.warn('[chats]', (e as Error).message));
  setTimeout(t, 90_000);
  setInterval(t, 5 * 60_000).unref();
}

/** Для проверок: число диалогов и сообщений. */
export function chatTotals(): { threads: number; messages: number; wb: number; ozon: number } {
  const d = chatDb();
  const th = (mp: string) => (d.prepare('SELECT COUNT(*) AS n FROM chat_threads WHERE marketplace = ? AND last_at IS NOT NULL').get(mp) as any).n;
  const wb = th('wb'); const ozon = th('ozon');
  return { threads: wb + ozon, wb, ozon, messages: (d.prepare('SELECT COUNT(*) AS n FROM chat_messages').get() as any).n };
}
void getDb;
