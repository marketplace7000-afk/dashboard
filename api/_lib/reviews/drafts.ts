/**
 * Черновики ответов агента 2 «Отзывы и вопросы» и автопубликация.
 * Ответ всегда собирается под конкретный отзыв/вопрос и товар — шаблонов нет.
 * Опора: профиль стиля (выжимка из наших реальных ответов), карточка товара с площадок,
 * материалы с Яндекс.Диска, похожие прошлые ответы и переписка с покупателями.
 * Эскалация решается моделью И перепроверяется кодом.
 */
import { getDb, getItem, patchItem, getSettings, rlog, rowToItem } from './db';
import { askClaude, BudgetExceeded, budgetState } from './claude';
import { productKnowledge, similarPastAnswers, similarTgPairs, recentAnswers } from './kb';
import { getStyleProfile } from './sources';
import { publishAnswer } from './publish';
import { directionOf, type ReviewItem } from '../../../shared/reviews';

export const SYSTEM_PROMPT = `Ты — сотрудник поддержки интернет-магазина автотоваров и электроники «avto-vibe» (Wildberries и Ozon). Пишешь ответ магазина на отзыв или вопрос покупателя на карточке товара. Ответ публичный: его читает не только автор, но и все, кто выбирает этот товар.

ГЛАВНОЕ: каждый ответ — личный. Он про ЭТОГО покупателя, ЭТОТ товар и ЭТУ ситуацию. Никаких шаблонных фраз, которые подошли бы к любому отзыву. Опирайся на то, что написал покупатель (его слова, его сценарий, его машину/устройство), и на факты о товаре.

КАК ОТВЕЧАТЬ:
- Пиши так, как отвечает наш магазин (профиль стиля и прошлые ответы ниже) — но не копируй их дословно.
- Благодарность (4–5★): поблагодари по-человечески, зацепись за конкретную деталь из отзыва, можно добавить одну полезную подсказку по использованию товара. Без навязчивых «покупайте ещё».
- Отзыв без текста: короткая живая благодарность с упоминанием товара; не повторяй формулировки из списка «уже написано».
- Вопрос: сразу по существу — факты, цифры, совместимость, порядок настройки. Без воды в начале.
- Негатив и жалобы: без оправданий, без спора и без перекладывания вины на покупателя. Признай неудобство, покажи, что разобрались в его ситуации, дай конкретный следующий шаг (проверить настройку X, сделать Y, оформить возврат/обмен через личный кабинет площадки, написать нам в чат продавца на площадке — если так делал магазин). Цель — снять напряжение и вывести разговор в решение, чтобы и автор, и читатели увидели заботу.
- Если покупатель ошибся в использовании — мягко подскажи, как правильно, не упрекая.
- Обращение на «вы», по-русски, 1–5 предложений (больше — только если без этого не ответить на вопрос).

ЖЁСТКИЕ ПРАВИЛА:
- Факты о товаре — только из выданных материалов (карточка, материалы Диска, прошлые ответы). Если точного ответа нет — НЕ ДОГАДЫВАЙСЯ: confidence "low", ответ без выдуманных цифр.
- Не обещай денег, компенсаций, замены или подарков, которых магазин не предлагал в прошлых ответах.
- Не пиши ссылок, телефонов, мессенджеров (Telegram, WhatsApp, Макс и т.п.), названий других площадок — это запрещено правилами WB и Ozon, даже если так было в старой переписке.
- Не раскрывай поставщиков, закупочные цены, внутренние дела магазина.
- Не груби и не иронизируй, даже если покупатель резок.

ВЕРНИ СТРОГО JSON без пояснений вокруг:
{"answer": "текст ответа покупателю", "confidence": "high"|"medium"|"low", "category": "positive"|"neutral"|"negative"|"complaint"|"question", "needs_escalation": true|false, "escalation_reason": "до 12 слов или null", "sources_used": ["style", "card:<артикул>", "product:<артикул>", "history:<id>", "chat:<id>"]}

needs_escalation = true, если: confidence = "low", ИЛИ брак/подделка/повреждение/возврат/замена, ИЛИ грубость/угрозы/суд/Роспотребнадзор/жалоба, ИЛИ оценка 1–2. Иначе — false.`;

/** Перепроверка кодом — модель не единственная защита (раздел 10 ТЗ). */
const RISK = /брак|сломал|слома|не работа|неисправ|поддел|фейк|копия|подделк|поврежд|разбит|трещин|вернуть|возврат|верните|замен|деньги наз|суд|роспотреб|прокурат|жалоб|мошен|обман|кидал|развод|отказ.*гарант/i;
const RUDE = /(^|[^а-яё])(х[уy][йяеи]|п[иi]зд|еба|ёба|бля|сук[аи]|муда|говн|дерьм)/i;

/** Ссылки и контакты в ответе площадки запрещают — такой черновик только вручную. */
export const FORBIDDEN = /https?:\/\/|www\.|taplink|t\.me|telegram|телеграм|whats ?app|ватсап|вотсап|viber|вайбер|\bмакс\b|@[a-z0-9_]{4,}|\+7[\s(-]*\d{3}|8[\s(-]*\d{3}[\s)-]*\d{3}[\s-]*\d{2}/i;

export function codeEscalation(item: Pick<ReviewItem, 'text' | 'pros' | 'cons' | 'rating' | 'kind'>, ratingMax: number): string | null {
  const t = `${item.text || ''} ${item.pros || ''} ${item.cons || ''}`;
  if (item.kind === 'review' && item.rating != null && item.rating <= ratingMax) return `Оценка ${item.rating}★`;
  if (RUDE.test(t)) return 'Грубая лексика';
  const m = t.match(RISK);
  if (m) return `Риск: «${m[0]}»`;
  return null;
}

export function extractJson(text: string): any {
  const a = text.indexOf('{');
  const b = text.lastIndexOf('}');
  if (a >= 0 && b > a) {
    try { return JSON.parse(text.slice(a, b + 1)); } catch { /* ниже — разбор обрезанного */ }
  }
  // Ответ обрезан лимитом токенов: достаём хотя бы поля по отдельности.
  const field = (k: string) => {
    const m = text.match(new RegExp(`"${k}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`));
    return m ? JSON.parse(`"${m[1]}"`) : null;
  };
  const answer = field('answer');
  if (!answer) throw new Error('Ответ модели без JSON');
  return {
    answer, confidence: field('confidence') || 'low', category: field('category'),
    needs_escalation: !/"needs_escalation"\s*:\s*false/.test(text),
    escalation_reason: field('escalation_reason') || 'Ответ модели обрезан', sources_used: [],
  };
}

export async function draftOne(id: number, opts: { force?: boolean } = {}): Promise<ReviewItem | null> {
  const item = getItem(id);
  if (!item) return null;
  if (item.answeredOnMarketplace || item.status === 'published' || item.status === 'skipped') return item;
  if (!opts.force && item.draftAnswer) return item;
  const s = getSettings();
  const isEmptyReview = item.kind === 'review' && !`${item.text}${item.pros || ''}${item.cons || ''}`.trim();
  const codeReason = codeEscalation(item, s.escalateRatingMax);

  const query = `${item.text} ${item.pros || ''} ${item.cons || ''} ${item.productName || ''}`;
  const know = productKnowledge(item.offerId, query, isEmptyReview ? 1500 : 7000);
  const past = similarPastAnswers(item, isEmptyReview ? 3 : 8);
  const chats = isEmptyReview ? [] : similarTgPairs(item, 5);
  const already = isEmptyReview ? recentAnswers('review', item.rating, 8) : [];
  const style = getStyleProfile();
  const chatName = (src: string) => src === 'wb_chat' ? 'чат WB' : src === 'ozon_chat' ? 'чат Ozon' : 'Telegram';

  const dynamic = [
    `# ${item.kind === 'review' ? 'Отзыв' : 'Вопрос'} покупателя (${item.marketplace === 'wb' ? 'Wildberries' : 'Ozon'})`,
    `Товар: ${item.productName || '—'}; артикул: ${item.offerId || '—'}`,
    item.rating != null ? `Оценка: ${item.rating} из 5` : '',
    item.author ? `Имя покупателя (можно обратиться по имени, если уместно): ${item.author}` : '',
    item.pros ? `Достоинства: ${item.pros}` : '',
    item.cons ? `Недостатки: ${item.cons}` : '',
    `Текст: ${item.text || '(без текста)'}`,
    `\n# Что известно о товаре\n${know.text || '(ни карточки, ни материалов — опирайся только на прошлые ответы, факты не придумывай)'}`,
    `\n# Наши прошлые ответы на похожие ${item.kind === 'review' ? 'отзывы' : 'вопросы'} (сначала — по этому товару)\n${past.length ? past.map(p => `[history:${p.id}] ${p.rating ? p.rating + '★ ' : ''}«${p.text || '(без текста)'}» → «${p.answer}»`).join('\n') : '(нет)'}`,
    chats.length ? `\n# Похожая переписка с покупателями\n${chats.map(p => `[chat:${p.id}] (${chatName(p.source)}) «${p.question}» → «${p.answer}»`).join('\n')}` : '',
    already.length ? `\n# Уже написано недавно (не повторяй эти формулировки)\n${already.map(t => `— ${t}`).join('\n')}` : '',
  ].filter(Boolean).join('\n');

  const styleBlock = `# Профиль стиля магазина (выжимка из наших реальных ответов)\n${style?.text || '(профиль ещё не составлен — ориентируйся на прошлые ответы ниже)'}`;
  // Отзыв без текста — короткий ответ, хватает модели подешевле.
  const model = isEmptyReview ? s.indexModel : s.draftModel;

  let res;
  try {
    res = await askClaude(isEmptyReview ? 'draft-short' : 'draft', {
      model, max_tokens: isEmptyReview ? 1200 : 4000, temperature: 0.6,
      system: [
        { type: 'text', text: SYSTEM_PROMPT },
        { type: 'text', text: styleBlock, cache_control: { type: 'ephemeral' } },
      ],
      messages: [{ role: 'user', content: dynamic }],
    });
  } catch (e) {
    if (e instanceof BudgetExceeded) throw e;
    patchItem(id, { draft_attempts: (getDb().prepare('SELECT draft_attempts FROM items WHERE id = ?').get(id) as any).draft_attempts + 1 });
    rlog('warn', `Черновик не получен (#${id})`, { error: String((e as Error)?.message ?? e).slice(0, 300) });
    throw e;
  }

  let j: any;
  try { j = extractJson(res.text); } catch {
    j = { answer: res.text.trim(), confidence: 'low', category: null, needs_escalation: true, escalation_reason: 'Модель вернула не JSON', sources_used: [] };
  }
  const answer = String(j.answer || '').trim().slice(0, 1000);
  const reasons = [
    codeReason,
    FORBIDDEN.test(answer) ? 'В ответе ссылка или контакт' : null,
    j.needs_escalation ? (j.escalation_reason || 'Модель просит проверку') : null,
    j.confidence === 'low' ? 'Низкая уверенность' : null,
    !answer ? 'Пустой ответ' : null,
  ].filter(Boolean) as string[];
  const reason = reasons.length ? [...new Set(reasons)].join('; ') : null;

  patchItem(id, {
    draft_answer: answer, draft_model: model, draft_cost: res.cost,
    confidence: ['high', 'medium', 'low'].includes(j.confidence) ? j.confidence : 'low',
    category: j.category || null, escalation_reason: reason,
    status: reason ? 'escalated' : 'drafted',
    sources_used: JSON.stringify(Array.isArray(j.sources_used) ? j.sources_used.slice(0, 12) : []),
    draft_attempts: 0,
  });
  return getItem(id);
}

let drafting: Promise<any> | null = null;

/** Черновики для всех новых неотвеченных + автопубликация по тумблерам. */
export function draftPending(limit = 40): Promise<{ drafted: number; published: number; stopped?: string }> {
  if (drafting) return drafting;
  drafting = (async () => {
    const s = getSettings();
    let drafted = 0; let published = 0; let stopped: string | undefined;
    if (s.autoDraft) {
      const rows = getDb().prepare(`SELECT id, kind, text, rating FROM items WHERE answered_on_mp = 0 AND status = 'new'
        AND draft_attempts < 3 ORDER BY created_at DESC LIMIT ?`).all(limit) as any[];
      const economy = budgetState().ratio >= 0.8;
      for (const r of rows) {
        // Экономный режим на 80%: только вопросы и отзывы с текстом длиннее 50 символов.
        if (economy && r.kind === 'review' && String(r.text || '').length <= 50) continue;
        try { await draftOne(r.id); drafted++; }
        catch (e) {
          if (e instanceof BudgetExceeded) { stopped = 'budget'; break; }
        }
      }
    }
    // Автопубликация: только drafted (не escalated), только включённые направления.
    const ready = (getDb().prepare(`SELECT * FROM items WHERE answered_on_mp = 0 AND status = 'drafted' AND draft_answer IS NOT NULL`).all() as any[]).map(rowToItem);
    for (const it of ready) {
      if (!s.autoPublish[directionOf(it.marketplace, it.kind)]) continue;
      if (it.marketplace === 'ozon' && it.kind === 'review') continue;
      const again = codeEscalation(it, s.escalateRatingMax) || (FORBIDDEN.test(it.draftAnswer || '') ? 'В ответе ссылка или контакт' : null);
      if (again) { patchItem(it.id, { status: 'escalated', escalation_reason: again }); continue; }
      const r = await publishAnswer(it.id, it.draftAnswer!, 'auto');
      if (r.ok) published++;
      await new Promise(res => setTimeout(res, 1500));
    }
    return { drafted, published, stopped };
  })().finally(() => { drafting = null; });
  return drafting;
}
