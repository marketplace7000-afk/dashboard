/**
 * Сценарий ozon_reviews — отзывы Ozon «ждут ответа» из кабинета продавца. Без LLM.
 *
 * Почему через ПК: Seller API отзывов Ozon закрыт на подписке владельца
 * (PermissionDenied, проверено 04.10.2026). Кабинет seller.ozon.ru сам берёт
 * список запросом POST /api/v4/review/list (фильтр awaiting_reply) — этот же
 * запрос выполняем ВНУТРИ открытой страницы кабинета, в профиле агента, с его
 * сессией. Только чтение (конституция, принцип II): одна страница
 * seller.ozon.ru/app/reviews, один читающий запрос кабинета, постранично.
 * С 11.11.2026: у отзывов с фото/видео тем же способом читается карточка отзыва
 * (POST /api/v2/review/detail — кабинет зовёт его при открытии отзыва): оттуда
 * ссылки на фото покупателя, чтобы агент 2 видел их при ответе.
 * Ответы на отзывы этот сценарий НЕ публикует.
 *
 * Этапы (shared/agents SCENARIO_STAGES.ozon_reviews):
 *   1 open_cabinet → 2 reviews_list → 3 ingest
 */
import { SCENARIO_STAGES, type AgentSettings, type AgentTask } from '../../../shared/agents';
import * as api from '../api';
import { newPage, sleep, randBetween, looksLikeChallenge } from '../chrome';

const STAGES = SCENARIO_STAGES.ozon_reviews;
const REVIEWS_URL = 'https://seller.ozon.ru/app/reviews';
/** Allow-list навигации сценария (принцип II). */
const ALLOWED = /^https:\/\/seller\.ozon\.ru\/app\/reviews/;

export type OzonReviewRow = {
  uuid: string; sku: string | null; offer_id: string | null; title: string | null; url: string | null;
  text: string; rating: number | null; published_at: string | null; is_empty: boolean;
  photos_count?: number; videos_count?: number;
  photos?: string[]; video_previews?: string[]; videos?: number; pros?: string | null; cons?: string | null;
};

/** Карточки отзывов, уже прочитанные в этом запуске программы агента (фото у отзыва не меняются). */
const detailCache = new Map<string, Pick<OzonReviewRow, 'photos' | 'video_previews' | 'videos' | 'pros' | 'cons'>>();
/** Не больше стольких карточек за один проход — остальные дочитаются в следующий. */
const DETAILS_PER_RUN = 25;

function stage(i: number, message: string, extra: Partial<{ items_done: number; items_total: number }> = {}) {
  return { stage: STAGES[i].stage, stage_index: i + 1, stages_total: STAGES.length, message, ...extra };
}

export async function runOzonReviews(task: AgentTask, settings: AgentSettings): Promise<void> {
  const page = await newPage();
  try {
    // 1. Кабинет
    await api.progress(task.id, stage(0, 'Открываю отзывы в кабинете Ozon'), true);
    await sleep(randBetween(settings.page_pause_ms));
    await page.goto(REVIEWS_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await sleep(4000);
    const url = page.url();
    const body = await page.evaluate(() => document.body?.innerText ?? '');
    if (looksLikeChallenge(url, body)) {
      await api.fail(task.id, { error: 'Ozon показал проверку «не робот» — стоп', retryable: false, pause: { marketplace: 'ozon', reason: 'captcha' } });
      return;
    }
    if (!ALLOWED.test(url)) {
      // Кабинет перекинул на вход — сессия профиля агента закончилась.
      await api.fail(task.id, {
        error: `Нет входа в кабинет Ozon в профиле агента (открылось ${url.slice(0, 80)}). Войдите один раз на seller.ozon.ru в окне Chrome агента.`,
        retryable: false, pause: { marketplace: 'ozon', reason: 'login_required' },
      });
      return;
    }

    // 2. Список «ждут ответа» — запросом самого кабинета, постранично.
    await api.progress(task.id, stage(1, 'Читаю отзывы без ответа'), true);
    const companyId = String(task.params.company_id || '');
    const res = await page.evaluate(async (cid: string) => {
      const out: any[] = [];
      let last: any = null;
      let complete = false;
      let error: string | null = null;
      for (let p = 0; p < 60; p++) {
        const b: any = {
          company_id: cid, company_type: 'seller',
          filter: { published_at: {}, interaction_status: ['ALL'], awaiting_reply: true, by_content_2: [], publish_info: [] },
          with_promotion_info: false,
        };
        if (last) b.last_review = last;
        const r = await fetch('/api/v4/review/list', {
          method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b),
        });
        if (!r.ok) { error = `review/list ${r.status}`; break; }
        const j: any = await r.json();
        for (const x of j?.result || []) {
          out.push({
            uuid: String(x.uuid), sku: x.product?.sku ? String(x.product.sku) : null,
            offer_id: x.product?.offer_id ? String(x.product.offer_id) : null,
            title: x.product?.title || null, url: x.product?.url || null,
            text: String(x.text || ''), rating: Number(x.rating) || null,
            published_at: x.published_at || null, is_empty: !!x.is_empty,
            photos_count: Number(x.photos_count) || 0, videos_count: Number(x.videos_count) || 0,
          });
        }
        if (!j?.hasNext || !j?.last_review) { complete = true; break; }
        last = j.last_review;
        await new Promise(res => setTimeout(res, 1500 + Math.random() * 1500));
      }
      return { reviews: out, complete, error };
    }, companyId);
    if (res.error) await api.log(task.id, 'warn', `кабинет ответил ошибкой: ${res.error}`);
    await api.progress(task.id, stage(1, `Найдено отзывов без ответа: ${res.reviews.length}`, { items_done: res.reviews.length, items_total: res.reviews.length }), true);

    // 2б. Фото покупателей: карточка отзыва — только у отзывов с фото/видео.
    const rows = res.reviews as OzonReviewRow[];
    const need = rows.filter(r => (r.photos_count || r.videos_count) && !detailCache.has(r.uuid)).slice(0, DETAILS_PER_RUN);
    if (need.length) {
      await api.progress(task.id, stage(1, `Читаю фото покупателей: ${need.length}`), true);
      const got = await page.evaluate(async ({ cid, uuids }: { cid: string; uuids: string[] }) => {
        const out: Record<string, any> = {};
        for (const uuid of uuids) {
          try {
            const r = await fetch('/api/v2/review/detail', {
              method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ company_id: cid, company_type: 'seller', review_uuid: uuid }),
            });
            if (!r.ok) { out[uuid] = { error: r.status }; if (r.status === 403 || r.status === 429) break; continue; }
            const j: any = await r.json();
            const img = /^https:\/\/[^\s"]+\.(jpe?g|png|webp)(\?[^\s"]*)?$/i;
            const previews: string[] = [];
            for (const v of j?.videos || []) {
              const hit = Object.values(v || {}).find(s => typeof s === 'string' && img.test(s));
              if (hit) previews.push(String(hit));
            }
            out[uuid] = {
              photos: (j?.photos || []).map((p: any) => p?.url).filter((u: any) => typeof u === 'string').slice(0, 10),
              video_previews: previews.slice(0, 3), videos: (j?.videos || []).length,
              pros: j?.text?.positive || null, cons: j?.text?.negative || null,
            };
          } catch (e) { out[uuid] = { error: String(e).slice(0, 80) }; }
          await new Promise(res => setTimeout(res, 1500 + Math.random() * 2000));
        }
        return out;
      }, { cid: companyId, uuids: need.map(r => r.uuid) });
      let failed = 0;
      for (const [uuid, d] of Object.entries(got)) { if (d?.error) failed++; else detailCache.set(uuid, d); }
      if (failed) await api.log(task.id, 'warn', `карточек отзывов не прочитано: ${failed} (фото дочитаются в следующий проход)`);
    }
    for (const r of rows) {
      const d = detailCache.get(r.uuid);
      if (!d) continue;
      Object.assign(r, { photos: d.photos, video_previews: d.video_previews, videos: d.videos });
      // Достоинства/недостатки в списке не приходят — берём из карточки, если их нет в тексте.
      if (d.pros && !r.text.includes(d.pros)) r.pros = d.pros;
      if (d.cons && !r.text.includes(d.cons)) r.cons = d.cons;
    }
    if (detailCache.size > 3000) detailCache.clear();

    // 3. В дашборд
    await api.progress(task.id, stage(2, 'Отправляю в дашборд'), true);
    const ok = await api.reviewsIngest(res.reviews as OzonReviewRow[], res.complete && !res.error);
    if (!ok) {
      await api.fail(task.id, { error: 'дашборд не принял отзывы', retryable: true });
      return;
    }
    await api.complete(task.id, `Отзывов Ozon без ответа: ${res.reviews.length}${res.complete ? '' : ' (список неполный)'}`, { reviews: res.reviews.length });
  } finally {
    await page.close().catch(() => {});
  }
}
