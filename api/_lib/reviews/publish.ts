/**
 * Публикация ответа покупателю — ЕДИНСТВЕННАЯ изменяющая операция агента 2
 * (конституция, принцип X, поправка 1.1.0). Только текст ответа на существующий
 * отзыв/вопрос, только через официальный Seller API. Каждая публикация — в журнал.
 */
import { wbUpstream, ozonUpstream } from '../../_proxy';
import { fetchWithRetry } from '../fetchRetry';
import { getItem, patchItem, rlog } from './db';
import type { ReviewItem } from '../../../shared/reviews';

const MAX_LEN = 1000;

export async function publishAnswer(id: number, text: string, by: 'owner' | 'auto'): Promise<{ ok: boolean; error?: string; item?: ReviewItem | null }> {
  const item = getItem(id);
  if (!item) return { ok: false, error: 'not_found' };
  const answer = String(text || '').trim();
  if (!answer) return { ok: false, error: 'Пустой ответ' };
  if (answer.length > MAX_LEN) return { ok: false, error: `Ответ длиннее ${MAX_LEN} символов` };
  if (item.status === 'published') return { ok: false, error: 'Уже опубликовано' };
  if (item.answeredOnMarketplace) return { ok: false, error: 'На площадке уже есть ответ (возможно, дан вручную в кабинете)' };
  if (by === 'auto' && item.status === 'escalated') return { ok: false, error: 'Эскалированный ответ не публикуется автоматически' };

  try {
    if (item.marketplace === 'wb') await publishWb(item, answer);
    else if (item.kind === 'question') await publishOzonQuestion(item, answer);
    else return { ok: false, error: 'Ответы на отзывы Ozon — через агента на ПК (этап в разработке)' };
  } catch (e) {
    const msg = String((e as Error)?.message ?? e).slice(0, 300);
    patchItem(id, { publish_error: msg });
    rlog('error', `Публикация не удалась: ${item.marketplace}/${item.kind} ${item.externalId}`, { error: msg, by });
    return { ok: false, error: msg, item: getItem(id) };
  }

  patchItem(id, {
    status: 'published', answered_on_mp: 1, mp_answer: answer, published_at: Date.now(),
    published_by: by, publish_error: null,
  });
  rlog('info', `Опубликован ответ: ${item.marketplace}/${item.kind} ${item.externalId}`, { by, offerId: item.offerId, text: answer });
  return { ok: true, item: getItem(id) };
}

async function publishWb(item: ReviewItem, text: string): Promise<void> {
  const up = wbUpstream('feedbacks');
  const headers = { ...(up.headers as any), 'Content-Type': 'application/json' };
  const r = item.kind === 'review'
    ? await fetchWithRetry(`${up.base}/api/v1/feedbacks/answer`, {
        method: 'POST', headers, body: JSON.stringify({ id: item.externalId, text }),
      }, { maxRetries: 1, timeoutMs: 20_000 })
    : await fetchWithRetry(`${up.base}/api/v1/questions`, {
        method: 'PATCH', headers, body: JSON.stringify({ id: item.externalId, answer: { text }, state: 'wbRu' }),
      }, { maxRetries: 1, timeoutMs: 20_000 });
  if (!r.ok) throw new Error(`WB ${r.status}: ${(await r.text().catch(() => '')).slice(0, 200)}`);
}

async function publishOzonQuestion(item: ReviewItem, text: string): Promise<void> {
  if (!item.sku) throw new Error('У вопроса нет SKU');
  const up = ozonUpstream();
  const r = await fetchWithRetry(`${up.base}/v1/question/answer/create`, {
    method: 'POST',
    headers: { ...(up.headers as any), 'Content-Type': 'application/json' },
    body: JSON.stringify({ question_id: item.externalId, sku: Number(item.sku), text }),
  }, { maxRetries: 1, timeoutMs: 20_000 });
  if (!r.ok) throw new Error(`Ozon ${r.status}: ${(await r.text().catch(() => '')).slice(0, 200)}`);
}
