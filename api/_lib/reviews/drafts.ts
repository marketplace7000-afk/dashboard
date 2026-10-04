/**
 * Черновики ответов (разделы 8, 10, 15 ТЗ) и автопубликация (раздел 7).
 * Модель — из настроек (по умолчанию claude-sonnet-5-5); неизменная часть
 * промпта кэшируется. Эскалация решается моделью И перепроверяется кодом.
 */
import { getDb, getItem, patchItem, getSettings, rlog, rowToItem } from './db';
import { askClaude, BudgetExceeded, budgetState } from './claude';
import { getKbTexts, productKnowledge, similarPastAnswers, similarTgPairs } from './kb';
import { publishAnswer } from './publish';
import { directionOf, type ReviewItem } from '../../../shared/reviews';

export const SYSTEM_PROMPT = `Ты — специалист поддержки покупателей интернет-магазина автотоваров и электроники «avto-vibe» (продажи на Wildberries и Ozon). Отвечаешь от имени магазина на отзывы и вопросы покупателей на карточках товаров.

ТВОЙ ТОН:
- Дружелюбно, по-деловому, без канцелярита и без заискивания.
- Коротко: 1–4 предложения, если не требуется больше для сути ответа.
- Всегда на русском, обращение на «вы».
- На позитивный отзыв — благодарность и 1 короткая деталь по товару, без навязчивых призывов что-то купить ещё.
- На вопрос — сразу конкретный ответ (цифры, характеристики, факты), без воды в начале.
- На негатив/жалобу — без оправданий и без споров: признать ситуацию, извиниться по существу, предложить конкретное решение или следующий шаг.
- Никогда не груби и не защищайся, даже если покупатель резок.
- Пиши так, как отвечает магазин в примерах прошлых ответов.

ТЕБЕ ДАНЫ (используй только это, не придумывай факты о товаре или политике магазина):
1. Текст отзыва/вопроса, оценка (если есть), название и артикул товара.
2. Правила тона и FAQ магазина.
3. Карточка знаний товара (текст из инструкций, описаний, фото).
4. Похожие прошлые ответы магазина на площадках — не противоречь им.
5. Скрипты для конфликтных ситуаций.
6. Похожие вопросы покупателей и ответы магазина из Telegram.

ЖЁСТКИЕ ПРАВИЛА:
- Если в материалах нет точного ответа (характеристика, срок, комплектация, причина неисправности и т.п.) — НЕ ДОГАДЫВАЙСЯ. Верни confidence "low" и нейтральный ответ без цифр, которых не знаешь.
- Не обещай возврат денег, замену или компенсацию, если этого нет в выданных скриптах.
- Не давай гарантий сверх указанных в материалах, без юридических и медицинских формулировок.
- Не упоминай Telegram, другие площадки, телефоны и внешние ссылки, если этого нет в правилах магазина (площадки это запрещают).
- Отвечай на русском.

ВЕРНИ СТРОГО JSON без пояснений вокруг:
{"answer": "текст ответа покупателю", "confidence": "high"|"medium"|"low", "category": "positive"|"neutral"|"negative"|"complaint"|"question", "needs_escalation": true|false, "escalation_reason": "строка или null", "sources_used": ["faq", "product:<артикул>", "history:<id>", "telegram:<id>", "script"]}

needs_escalation = true, если: confidence = "low", ИЛИ брак/подделка/повреждение/возврат/замена, ИЛИ грубость/угрозы/суд/Роспотребнадзор/жалоба, ИЛИ оценка 1–2. Иначе — false.`;

/** Перепроверка кодом — модель не единственная защита (раздел 10 ТЗ). */
const RISK = /брак|сломал|слома|не работа|неисправ|поддел|фейк|копия|подделк|поврежд|разбит|трещин|вернуть|возврат|верните|замен|деньги наз|суд|роспотреб|прокурат|жалоб|мошен|обман|кидал|развод|отказ.*гарант/i;
const RUDE = /(^|[^а-яё])(х[уy][йяеи]|п[иi]зд|еба|ёба|бля|сук[аи]|муда|говн|дерьм)/i;

export function codeEscalation(item: Pick<ReviewItem, 'text' | 'pros' | 'cons' | 'rating' | 'kind'>, ratingMax: number): string | null {
  const t = `${item.text || ''} ${item.pros || ''} ${item.cons || ''}`;
  if (item.kind === 'review' && item.rating != null && item.rating <= ratingMax) return `Оценка ${item.rating}★`;
  if (RUDE.test(t)) return 'Грубая лексика';
  const m = t.match(RISK);
  if (m) return `Риск: «${m[0]}»`;
  return null;
}

function pickTemplate(rating: number | null, texts: Record<string, string>): string | null {
  const key = rating == null ? null : rating >= 5 ? 'templates_5' : rating === 4 ? 'templates_4' : 'templates_low';
  if (!key) return null;
  const lines = String(texts[key] || '').split('\n').map(s => s.trim()).filter(Boolean);
  if (!lines.length) return null;
  return lines[Math.floor(Math.random() * lines.length)];
}

function extractJson(text: string): any {
  const a = text.indexOf('{');
  const b = text.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('Ответ модели без JSON');
  return JSON.parse(text.slice(a, b + 1));
}

export async function draftOne(id: number, opts: { force?: boolean } = {}): Promise<ReviewItem | null> {
  const item = getItem(id);
  if (!item) return null;
  if (item.answeredOnMarketplace || item.status === 'published' || item.status === 'skipped') return item;
  if (!opts.force && item.draftAnswer) return item;
  const s = getSettings();
  const texts = getKbTexts();
  const isEmptyReview = item.kind === 'review' && !`${item.text}${item.pros || ''}${item.cons || ''}`.trim();
  const codeReason = codeEscalation(item, s.escalateRatingMax);

  // Отзыв без текста — шаблон, без Claude (раздел 15).
  if (isEmptyReview) {
    const tpl = pickTemplate(item.rating, texts);
    if (tpl) {
      patchItem(id, {
        draft_answer: tpl, draft_model: 'template', draft_cost: 0, confidence: 'high', category: 'positive',
        escalation_reason: codeReason, status: codeReason ? 'escalated' : 'drafted', sources_used: JSON.stringify(['template']),
        draft_attempts: 0,
      });
      return getItem(id);
    }
  }

  const know = productKnowledge(item.offerId);
  const past = similarPastAnswers(item, 5);
  const tg = similarTgPairs(item, 5);

  const staticBlock = [
    `# Правила тона\n${texts.tone || '(не заданы — используй общий тон из инструкции)'}`,
    `# FAQ магазина\n${texts.faq || '(не заполнен)'}`,
    `# Скрипты конфликтных ситуаций\n${texts.scripts || '(не заполнены — по конфликтам ничего не обещай, ставь эскалацию)'}`,
  ].join('\n\n');

  const dynamic = [
    `# ${item.kind === 'review' ? 'Отзыв' : 'Вопрос'} покупателя (${item.marketplace === 'wb' ? 'Wildberries' : 'Ozon'})`,
    `Товар: ${item.productName || '—'}; артикул: ${item.offerId || '—'}`,
    item.rating != null ? `Оценка: ${item.rating} из 5` : '',
    item.pros ? `Достоинства: ${item.pros}` : '',
    item.cons ? `Недостатки: ${item.cons}` : '',
    `Текст: ${item.text || '(без текста)'}`,
    `\n# Карточка знаний товара\n${know.text || '(материалов по этому товару нет)'}`,
    `\n# Похожие прошлые ответы магазина\n${past.length ? past.map(p => `[history:${p.id}] ${p.rating ? p.rating + '★ ' : ''}«${p.text}» → «${p.answer}»`).join('\n') : '(нет)'}`,
    `\n# Похожие обращения в Telegram\n${tg.length ? tg.map(p => `[telegram:${p.id}] «${p.question}» → «${p.answer}»`).join('\n') : '(нет)'}`,
  ].filter(Boolean).join('\n');

  let res;
  try {
    res = await askClaude('draft', {
      model: s.draftModel, max_tokens: 500, temperature: 0.4,
      system: [
        { type: 'text', text: SYSTEM_PROMPT },
        { type: 'text', text: staticBlock, cache_control: { type: 'ephemeral' } },
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
    j.needs_escalation ? (j.escalation_reason || 'Модель просит проверку') : null,
    j.confidence === 'low' ? 'Низкая уверенность' : null,
    !answer ? 'Пустой ответ' : null,
  ].filter(Boolean) as string[];
  const reason = reasons.length ? [...new Set(reasons)].join('; ') : null;

  patchItem(id, {
    draft_answer: answer, draft_model: s.draftModel, draft_cost: res.cost,
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
      const again = codeEscalation(it, s.escalateRatingMax);
      if (again) { patchItem(it.id, { status: 'escalated', escalation_reason: again }); continue; }
      const r = await publishAnswer(it.id, it.draftAnswer!, 'auto');
      if (r.ok) published++;
      await new Promise(res => setTimeout(res, 1500));
    }
    return { drafted, published, stopped };
  })().finally(() => { drafting = null; });
  return drafting;
}
