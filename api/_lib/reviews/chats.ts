/**
 * Раздел «Чаты с покупателями» (WB и Ozon): черновик ответа под весь диалог и отправка.
 * База та же, что у «Отзывов и вопросов»: профиль стиля, карточка товара и материалы Диска,
 * наши прошлые ответы, переписка из Telegram и чатов. Отправка — только кнопкой
 * (тумблер «авто» отдельно для WB и для Ozon, по умолчанию выключены; эскалация не отправляется никогда).
 * Конституция 1.3.0, принцип X: разрешённая запись — текстовый ответ покупателю в чате WB/Ozon.
 */
import { getDb, getSettings, rlog, kvGet, kvSet } from './db';
import { askClaude, BudgetExceeded, budgetState } from './claude';
import { productKnowledge, similarTgPairs, similarPastAnswers } from './kb';
import { getStyleProfile, syncWbChats, syncOzonChats, fillChatProducts, WB_CHAT_BASE, wbChatHeaders } from './sources';
import { ozonUpstream } from '../../_proxy';
import { codeEscalation, extractJson, FORBIDDEN } from './drafts';
import {
  chatDb, chatMessages, getThread, patchThread, rowToThread, replySignOf, addMessages, type ChatThread,
} from './chatStore';

/** Лимит площадки на одно сообщение чата (WB — по документации buyer-chat-api; у Ozon держим так же). */
export const CHAT_MAX = 1000;
/** Целевая длина черновика — с запасом до лимита. */
const CHAT_TARGET = 900;

export const CHAT_PROMPT = `Ты — сотрудник поддержки интернет-магазина автотоваров и электроники «avto-vibe». Ведёшь переписку с покупателем в чате продавца на маркетплейсе (Wildberries или Ozon — указано в диалоге). Магазин продаёт разную электронику: адаптеры CarPlay / Android Auto и автоприставки, HDMI-передатчики, лампы, зарядки, плёнки и многое другое — поэтому вопросы бывают о совместимости, подключении и настройке, прошивке, неисправностях, возврате.

ТОВАР — САМОЕ ВАЖНОЕ: отвечай только про тот товар, который указан в диалоге («товар: …») или ясно назван самим покупателем. Не подставляй другой товар и не додумывай тип товара по профилю стиля или прошлым ответам магазина — там примеры про другие товары. Если товар неизвестен и из переписки непонятно, что это, — не давай инструкций к конкретному устройству: уточни у покупателя, о каком товаре речь (название или артикул), confidence "low".

ГЛАВНОЕ: ответь на последние сообщения покупателя с учётом всего диалога. Это живой разговор, а не публичный отзыв: можно задать уточняющий вопрос (марка и год авто, модель магнитолы, телефон, что именно не работает), дать пошаговую инструкцию, предложить следующий шаг.

КАК ОТВЕЧАТЬ:
- Пиши так, как отвечает наш магазин (профиль стиля, прошлые ответы и переписка ниже), но не копируй дословно.
- Сначала суть: конкретный ответ или шаги по порядку. Без воды и канцелярита, на «вы».
- Решение проблем — по шагам, опираясь на материалы товара и на то, как магазин решал такие же случаи раньше.
- Если покупатель недоволен — без спора и оправданий: признай неудобство, предложи понятный путь (проверить настройку, обновить прошивку, оформить возврат или обмен через личный кабинет площадки — если так делал магазин).
- Если для ответа не хватает данных о машине/магнитоле/телефоне — спроси их, а не угадывай.
- Длина — сколько нужно для сути: обычно 1–5 предложений, инструкция — коротким списком.

ДЛИНА СООБЩЕНИЯ: площадка принимает не больше 1000 символов в одном сообщении. Пиши ответ не длиннее ${CHAT_TARGET} символов вместе с пробелами — это твой лимит, а не повод сокращать суть. Никогда не обрывай мысль. Если полная инструкция не помещается — дай в этом сообщении первые, самые вероятные шаги и закончи просьбой написать результат; следующие шаги дашь отдельным сообщением после ответа покупателя (по переписке видно, что уже было предложено, — не повторяй это).

ЕСЛИ НИЧЕГО НЕ ПОМОГЛО: не настаивай, что товар исправен, и не уходи в бесконечные проверки. Если по переписке покупатель уже выполнил наши рекомендации (основные способы решения из материалов товара испробованы), а проблема осталась — деликатно признай, что, похоже, дело в конкретном экземпляре, извинись за неудобство и предложи оформить возврат (или обмен) через личный кабинет площадки, коротко подскажи, как это сделать. Без обвинений покупателя и без намёков, что он что-то сделал не так.

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
  // Товар не определён — сначала ищем его в сообщениях (номер заказа, артикул), иначе модель гадает.
  if (!th.offerId) {
    await fillChatProducts(1, { mp, chatId }).catch(() => 0);
    const again = getThread(mp, chatId);
    if (again) Object.assign(th, again);
  }

  const pseudo: any = { id: -1, kind: 'question', text: ask, pros: null, cons: null, rating: null, offerId: th.offerId };
  const know = productKnowledge(th.offerId, `${ask} ${th.productName || ''}`, 7000);
  const past = th.offerId ? similarPastAnswers(pseudo, 6) : [];
  const chats = similarTgPairs(pseudo, 8).filter(p => !p.id.startsWith(`${mp === 'wb' ? 'wb' : 'oz'}:${chatId}:`));
  const style = getStyleProfile();
  const fmt = (t: number) => new Date(t + 3 * 3600_000).toISOString().slice(0, 16).replace('T', ' ');
  const chatName = (src: string) => src === 'wb_chat' ? 'чат WB' : src === 'ozon_chat' ? 'чат Ozon' : 'Telegram';
  const shorten = (t: string, n: number) => t.length > n ? `${t.slice(0, n).trimEnd()}…` : t;

  const dynamic = [
    `# Диалог в чате ${mp === 'wb' ? 'Wildberries' : 'Ozon'}`,
    th.offerId || th.productName
      ? `Покупатель: ${th.clientName || '—'}; товар: ${th.productName || '—'}; артикул: ${th.offerId || '—'}${th.sku ? `; ${mp === 'wb' ? 'nmID' : 'SKU'} ${th.sku}` : ''}`
      : `Покупатель: ${th.clientName || '—'}; товар: НЕ ОПРЕДЕЛЁН (площадка его не передала) — не угадывай, см. правило о товаре`,
    `\n# Переписка (старые сверху, время МСК)`,
    // Последние 15 сообщений — целиком, более ранние — коротко: нить разговора остаётся, а запрос легче.
    ...msgs.map((m, i) => `[${fmt(m.at)}] ${m.fromBuyer ? 'Покупатель' : 'Магазин'}: ${i >= msgs.length - 15 ? m.text.slice(0, 1200) : shorten(m.text, 200)}`),
    `\n# Что известно о товаре\n${know.text || '(ни карточки, ни материалов — опирайся только на прошлые ответы, факты не придумывай)'}`,
    past.length ? `\n# Наши ответы на похожие вопросы по этому товару\n${past.map(p => `[history:${p.id}] «${p.text || '(без текста)'}» → «${p.answer}»`).join('\n')}` : '',
    chats.length ? `\n# Как магазин отвечал в похожих переписках (часто про ДРУГИЕ товары: бери тон и подход, а не факты и инструкции)\n${chats.map(p => `[chat:${p.id}] (${chatName(p.source)}) «${p.question}» → «${p.answer}»`).join('\n')}` : '',
  ].filter(Boolean).join('\n');

  const styleBlock = `# Профиль стиля магазина (выжимка из наших реальных ответов)\n${style?.text || '(профиль ещё не составлен)'}`;
  let res;
  try {
    res = await askClaude('chat-draft', {
      // В чате бывают разборы неисправностей по шагам — размышления средние, а не минимальные.
      model: s.draftModel, max_tokens: 2500, temperature: 0.5, effort: 'medium',
      system: [
        { type: 'text', text: CHAT_PROMPT },
        { type: 'text', text: styleBlock, cache_control: { type: 'ephemeral', ttl: '1h' } },
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
  let answer = String(j.answer || '').trim();
  let cost = res.cost;
  // Длиннее лимита площадки — не обрезаем, а просим ужать (короткий дешёвый запрос только по тексту ответа).
  if (answer.length > CHAT_MAX) {
    try {
      const fix = await askClaude('chat-shorten', {
        model: s.indexModel, max_tokens: 1500, temperature: 0.2,
        messages: [{ role: 'user', content: `Это сообщение покупателю в чат маркетплейса, оно длиннее лимита в ${CHAT_MAX} символов (сейчас ${answer.length}). Перепиши его не длиннее ${CHAT_TARGET} символов: сохрани тон, факты и порядок шагов, убери повторы и лишние слова. Если все шаги не помещаются — оставь первые, самые важные, и закончи просьбой написать результат, остальное мы отправим следующим сообщением. Мысль не обрывай. Верни только новый текст сообщения, без пояснений.\n\n${answer}` }],
      });
      cost += fix.cost;
      const short = fix.text.trim().replace(/^["«]|["»]$/g, '');
      if (short && short.length <= CHAT_MAX) answer = short;
    } catch (e) { if (e instanceof BudgetExceeded) throw e; }
  }
  const reasons = [
    answer.length > CHAT_MAX ? `Ответ длиннее ${CHAT_MAX} символов — уйдёт несколькими сообщениями, проверьте` : null,
    codeEscalation({ text: ask, pros: null, cons: null, rating: null, kind: 'question' }, 0),
    FORBIDDEN.test(answer) ? 'В ответе ссылка или контакт' : null,
    j.needs_escalation ? (j.escalation_reason || 'Модель просит проверку') : null,
    j.confidence === 'low' ? 'Низкая уверенность' : null,
    !answer ? 'Пустой ответ' : null,
  ].filter(Boolean) as string[];
  const reason = reasons.length ? [...new Set(reasons)].join('; ') : null;
  patchThread(mp, chatId, {
    draft_answer: answer, draft_model: s.draftModel, draft_cost: cost, draft_for: lastBuyer?.id || null,
    confidence: ['high', 'medium', 'low'].includes(j.confidence) ? j.confidence : 'low',
    escalation_reason: reason, status: reason ? 'escalated' : 'drafted', draft_attempts: 0,
    sources_used: JSON.stringify(Array.isArray(j.sources_used) ? j.sources_used.slice(0, 12) : []),
  });
  return getThread(mp, chatId);
}

// ─── Отправка ──────────────────────────────────────────────────────────────
export async function sendThread(mp: string, chatId: string, text: string, by: 'owner' | 'auto'): Promise<{ ok: boolean; error?: string; thread?: ChatThread | null }> {
  if (mp !== 'wb' && mp !== 'ozon') return { ok: false, error: 'Неизвестная площадка' };
  const full = String(text || '').trim();
  if (!full) return { ok: false, error: 'Пустое сообщение' };
  if (full.length > CHAT_MAX * 4) return { ok: false, error: `Сообщение длиннее ${CHAT_MAX * 4} символов — сократите` };
  if (by === 'auto' && full.length > CHAT_MAX) return { ok: false, error: `Длиннее ${CHAT_MAX} символов — автоматически не отправляем` };
  if (by === 'auto' && FORBIDDEN.test(full)) return { ok: false, error: 'В ответе ссылка или контакт' };
  // Лимит площадки — 1000 символов на сообщение: длинный ответ уходит несколькими сообщениями по границам абзацев/предложений.
  const parts = splitChatMessage(full, CHAT_MAX);
  for (let i = 0; i < parts.length; i++) {
    const r = await sendOne(mp, chatId, parts[i], by);
    if (!r.ok) return i ? { ...r, error: `Отправлено ${i} из ${parts.length} сообщений, дальше ошибка: ${r.error}` } : r;
    if (i < parts.length - 1) await new Promise(res => setTimeout(res, 1500));
  }
  patchThread(mp, chatId, { status: 'sent', sent_at: Date.now(), sent_by: by, send_error: null, draft_answer: null });
  return { ok: true, thread: getThread(mp, chatId) };
}

/** Разбить текст на сообщения не длиннее max: по абзацам, затем по предложениям, в крайнем случае — по словам. */
export function splitChatMessage(text: string, max: number): string[] {
  const t = text.trim();
  if (t.length <= max) return [t];
  const out: string[] = [];
  let rest = t;
  while (rest.length > max) {
    const head = rest.slice(0, max + 1);
    let cut = Math.max(head.lastIndexOf('\n\n'), head.lastIndexOf('\n'));
    if (cut < max * 0.4) { const m = [...head.matchAll(/[.!?…](?=\s)/g)].pop(); cut = m ? m.index! + 1 : -1; }
    if (cut < max * 0.4) cut = head.lastIndexOf(' ');
    if (cut <= 0) cut = max;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

async function sendOne(mp: string, chatId: string, msg: string, by: 'owner' | 'auto'): Promise<{ ok: boolean; error?: string; thread?: ChatThread | null }> {
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
  rlog('info', `Чат ${mpName}: ответ отправлен`, { chat: chatId, by, text: msg.slice(0, 300) });
  return { ok: true };
}

// ─── Фон: синхронизация каждые 5 минут, черновики к новым сообщениям ─────────
let busy: Promise<any> | null = null;
const CHAT_PAUSE_MS = 3 * 60_000;
export function chatTick(): Promise<any> {
  if (busy) return busy;
  busy = (async () => {
    const out: any = {};
    try { out.wb = await syncWbChats(10); } catch (e) { out.wb = { error: String((e as Error).message).slice(0, 200) }; }
    try { out.ozon = await syncOzonChats(80); } catch (e) { out.ozon = { error: String((e as Error).message).slice(0, 200) }; }
    try { out.products = await fillChatProducts(); } catch (e) { out.products = { error: String((e as Error).message).slice(0, 200) }; }
    const s = getSettings();
    if (!s.chatAutoDraft) return out;
    const d = chatDb();
    // Разово (13.10): черновики, написанные до того, как нашёлся товар чата, — переписать с карточкой товара.
    if (!kvGet<boolean>('chat_redraft_noproduct_v1', false)) {
      const r = d.prepare(`UPDATE chat_threads SET status = 'new', draft_attempts = 0 WHERE offer_id IS NOT NULL
        AND status IN ('drafted','escalated') AND last_from_buyer = 1 AND last_at >= ?
        AND sources_used NOT LIKE '%card:%' AND sources_used NOT LIKE '%product:%'`).run(Date.now() - 48 * 3600_000);
      kvSet('chat_redraft_noproduct_v1', true);
      out.redraft = r.changes;
    }
    // Пауза 3 минуты после последнего сообщения покупателя: часто пишут несколькими сообщениями
    // подряд, и без паузы черновик переписывался заново на каждое.
    const rows = d.prepare(`SELECT marketplace, chat_id FROM chat_threads WHERE status = 'new' AND last_from_buyer = 1
      AND last_at >= ? AND last_at <= ? AND draft_attempts < 3 ORDER BY last_at DESC LIMIT 15`)
      .all(Date.now() - 48 * 3600_000, Date.now() - CHAT_PAUSE_MS) as any[];
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
