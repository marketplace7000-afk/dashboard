/**
 * Обработчики `/api/ai/*` — всё, что ходит в Claude.
 *
 * Вынесено из api/route.ts: диспетчер запросов не обязан знать, как устроен
 * аудит карточки или диалоговый чат. Здесь только сборка промптов, разбор
 * ответов и кэширование; сам вызов Anthropic — в _lib/anthropic.ts, учёт трат —
 * в _lib/aiUsage.ts, а контекст платформы для копилота — в _lib/aiContext.ts.
 *
 * Единственное, о чём стоит помнить снаружи: диалоговый чат НИКОГДА не
 * кэшируется, остальные действия кэшируются на 6 часов (см. AI_CACHE_TTL_MS).
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { cacheGet, cacheSet, isFresh, makeCacheKey } from './cache';
import { callAnthropic, fetchImageAsBase64, extractJson, AnthropicError } from './anthropic';
import { buildSnapshot, formatContextForPrompt } from './aiContext';
import { aiAdvise } from './aiAdvise';

const AI_CACHE_TTL_MS = 6 * 60 * 60_000;       // 6 часов на ответы LLM

// ────────────────────────────────────────────────────────────────────────────
// AI — Claude через Anthropic API
// ────────────────────────────────────────────────────────────────────────────
export async function handleAi(req: VercelRequest, res: VercelResponse, action: string | undefined) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'ai_not_configured', detail: 'ANTHROPIC_API_KEY missing' });
  }

  const body = (typeof req.body === 'string' ? safeJson(req.body) : req.body) || {};
  // Диалоговый чат НИКОГДА не кэшируем: каждое новое сообщение должно давать
  // свежий ответ. Иначе на разные вопросы приходил один и тот же закэшированный
  // ответ (жалоба клиента 03.07 — «на любой вопрос отправляет шаблон»).
  const noCache = req.headers['x-av-no-cache'] === '1' || action === 'chat';
  const cacheKey = noCache ? null : makeCacheKey('ai', action || '', '', '', JSON.stringify(body).slice(0, 800));

  if (cacheKey) {
    const cached = await cacheGet<{ status: number; payload: any }>(cacheKey);
    if (isFresh(cached)) {
      res.setHeader('x-av-cache', 'HIT');
      return res.status(cached.data.status).json(cached.data.payload);
    }
  }

  try {
    let result: any;
    switch (action) {
      case 'card-audit':      result = await aiCardAudit(body); break;
      case 'insights':        result = await aiInsights(body); break;
      case 'review-reply':    result = await aiReviewReply(body); break;
      case 'price-reason':    result = await aiPriceReason(body); break;
      case 'competitors-summary': result = await aiCompetitorsSummary(body); break;
      case 'advise':          result = await aiAdvise(body); break;
      case 'chat':            result = await aiChat(body); break;
      default: return res.status(404).json({ error: 'ai_action_not_found', action });
    }
    if (cacheKey) {
      await cacheSet(cacheKey, { status: 200, payload: result }, AI_CACHE_TTL_MS);
      res.setHeader('x-av-cache', 'MISS');
    }
    return res.status(200).json(result);
  } catch (e: any) {
    if (e instanceof AnthropicError) {
      return res.status(e.status >= 400 && e.status < 600 ? e.status : 502)
        .json({ error: 'ai_upstream', status: e.status, detail: e.body.slice(0, 500) });
    }
    return res.status(500).json({ error: 'ai_internal', detail: String(e?.message ?? e) });
  }
}

function safeJson(s: string) { try { return JSON.parse(s); } catch { return null; } }

// ─── AI actions ─────────────────────────────────────────────────────────────
async function aiCardAudit(body: any) {
  const { name, description, images, characteristics, reviews, price, brand } = body || {};
  const photoUrls: string[] = Array.isArray(images) ? images.slice(0, 6) : [];

  // Скачиваем фото для vision
  const pics = (await Promise.all(photoUrls.map(fetchImageAsBase64))).filter(Boolean) as Array<{ data: string; media_type: string }>;

  const userContent: any[] = [];
  pics.forEach(p => userContent.push({
    type: 'image',
    source: { type: 'base64', media_type: p.media_type, data: p.data },
  }));

  const meta = [
    name ? `Название: ${String(name).slice(0, 300)}` : '',
    brand ? `Бренд: ${brand}` : '',
    price ? `Цена: ${price} ₽` : '',
    description ? `Описание: ${String(description).slice(0, 1200)}` : '',
    characteristics ? `Характеристики: ${typeof characteristics === 'string' ? characteristics.slice(0, 1200) : JSON.stringify(characteristics).slice(0, 1200)}` : '',
    Array.isArray(reviews) && reviews.length
      ? `Последние отзывы (фрагменты):\n${reviews.slice(0, 8).map((r: any, i: number) => `${i + 1}. [${r.rating ?? '?'}★] ${String(r.text || '').slice(0, 220)}`).join('\n')}`
      : '',
  ].filter(Boolean).join('\n\n');

  userContent.push({
    type: 'text',
    text: `Проанализируй карточку товара на маркетплейсе (Wildberries/Ozon).\nНиша: автотовары и аксессуары для CarPlay.\n\n${meta}\n\nОцени фото-сет (если приложены) и контент. Верни СТРОГО валидный JSON следующей формы:\n{\n  "score": число от 0 до 100,\n  "strengths": [3-5 строк],\n  "weaknesses": [3-6 строк],\n  "photoIssues": [строки про конкретные проблемы фото: качество, ракурсы, отсутствие инфографики и т.п.],\n  "missingContent": [чего не хватает в описании/характеристиках],\n  "reviewProblems": [частые проблемы из отзывов, если есть],\n  "actions": [4-6 коротких конкретных рекомендаций]\n}\nБез комментариев вне JSON.`,
  });

  const sys = 'Ты опытный маркетплейс-аналитик и UX-эксперт. Отвечаешь только по делу, конкретно, на русском.';
  const { text } = await callAnthropic({
    system: sys,
    messages: [{ role: 'user', content: userContent }],
    max_tokens: 1400,
    temperature: 0.3,
    agent: 'card-audit',
  });
  const parsed = extractJson<any>(text);
  return { ok: true, audit: parsed ?? { raw: text }, photosAnalyzed: pics.length };
}

async function aiInsights(body: any) {
  const { period, marketplaces, topProducts, kpis, notes, errors } = body || {};

  // Если по маркетплейсу есть техническая ошибка — НЕ интерпретируем 0₽ как
  // «продаж нет». Перечисляем явно какие источники недоступны.
  const errorEntries = errors ? Object.entries(errors).filter(([, v]) => !!v) : [];
  const errorsBlock = errorEntries.length
    ? `\n\n⚠ ВАЖНО: следующие маркетплейсы СЕЙЧАС не отвечают (API rate-limit или временная ошибка), их нулевые показатели — это техническая проблема, а НЕ реальное отсутствие продаж:\n${errorEntries.map(([k, v]) => `- ${k}: ${v}`).join('\n')}\n\nВ инсайтах:\n- Не пиши что эти маркетплейсы «мёртвые» / «не используются»\n- Прямо упомяни что данные временно недоступны и рекомендация — повторить запрос позже\n- Анализируй только те маркетплейсы, по которым данные пришли`
    : '';

  const prompt = `Сформируй краткую сводку и инсайты по продажам ИП Алешко (автотовары, CarPlay-аксессуары) на маркетплейсах.\nПериод: ${period || 'не указан'}.\n\nKPI: ${JSON.stringify(kpis ?? {}, null, 2)}\nМаркетплейсы: ${JSON.stringify(marketplaces ?? {}, null, 2)}\nТоп товары: ${JSON.stringify((topProducts ?? []).slice(0, 10), null, 2)}\n${notes ? `\nДополнительный контекст: ${notes}` : ''}${errorsBlock}\n\nВерни СТРОГО JSON:\n{\n  "summary": "1 абзац (3-5 строк) с главным выводом за период",\n  "insights": [4-6 коротких инсайтов с цифрами],\n  "actions": [3-5 конкретных шагов на ближайшую неделю]\n}\nБез текста вне JSON.`;

  const { text } = await callAnthropic({
    system: 'Ты аналитик маркетплейсов. Отвечаешь конкретно, с цифрами, на русском.',
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 1200,
    temperature: 0.4,
    agent: 'insights',
  });
  const parsed = extractJson<any>(text);
  return { ok: true, insights: parsed ?? { raw: text } };
}

async function aiReviewReply(body: any) {
  const { text: reviewText, rating, productName, tone } = body || {};
  const prompt = `Сгенерируй вежливый ответ продавца на отзыв покупателя WB.\nТовар: ${productName || 'не указан'}\nОценка: ${rating ?? '?'}★\nОтзыв: ${String(reviewText || '').slice(0, 800)}\nТон: ${tone || 'дружелюбный, профессиональный'}.\n\nПравила: без воды, без штампов «нам очень жаль, что вы столкнулись», конкретика, 2-4 предложения, на русском. Если оценка низкая — предложи решение (замена/возврат/инструкция). Не упоминай скидки и компенсации без необходимости. Верни только текст ответа, без кавычек и пояснений.`;

  const { text } = await callAnthropic({
    system: 'Ты пишешь от лица продавца ИП Алешко (автотовары, CarPlay). Тон уверенный, дружелюбный, без воды.',
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 400,
    temperature: 0.7,
    agent: 'review-reply',
  });
  return { ok: true, reply: text };
}

async function aiPriceReason(body: any) {
  const { sku, myPrice, marketPrice, competitors } = body || {};
  const prompt = `Объясни рекомендацию по цене для SKU ${sku || '?'} (автотовары, CarPlay).\nНаша цена: ${myPrice} ₽\nРыночная медиана: ${marketPrice} ₽\nКонкуренты (если есть): ${JSON.stringify((competitors ?? []).slice(0, 5))}\n\nОдин абзац 2-3 предложения. Если мы дороже >5% — рекомендуй коррекцию вниз. Если дешевле >5% — поднять. На русском, конкретно, с цифрами.`;
  const { text } = await callAnthropic({
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 250,
    temperature: 0.3,
    agent: 'price-reason',
  });
  return { ok: true, reason: text };
}

async function aiCompetitorsSummary(body: any) {
  const { query, our, competitors } = body || {};
  const prompt = `Сравни нашу карточку с топ-конкурентами по запросу "${query}" на Wildberries.\n\nНаш товар: ${JSON.stringify(our ?? {}, null, 2)}\n\nКонкуренты (топ выдачи):\n${JSON.stringify((competitors ?? []).slice(0, 10), null, 2)}\n\nВерни СТРОГО JSON:\n{\n  "position": "где мы относительно конкурентов по цене и рейтингу",\n  "priceGap": "что с ценой (выше/ниже/в рынке, на сколько %)",\n  "ratingGap": "что с рейтингом и отзывами",\n  "advantages": [что у нас сильнее],\n  "gaps": [где конкуренты обходят],\n  "actions": [3-5 конкретных шагов]\n}\nБез текста вне JSON.`;
  const { text } = await callAnthropic({
    system: 'Ты аналитик конкурентной разведки на маркетплейсах. Отвечаешь конкретно, по-русски.',
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 1100,
    temperature: 0.3,
    agent: 'competitors-summary',
  });
  const parsed = extractJson<any>(text);
  return { ok: true, summary: parsed ?? { raw: text } };
}

// ────────────────────────────────────────────────────────────────────────────
// AI copilot chat — плавающая кнопка-кружок на всех страницах
// ────────────────────────────────────────────────────────────────────────────
type ChatMessage = { role: 'user' | 'assistant'; content: string };

async function aiChat(body: any) {
  const messages: ChatMessage[] = Array.isArray(body?.messages) ? body.messages : [];
  const currentPage: string | undefined = body?.currentPage;
  const localContext: any = body?.localContext;
  if (!messages.length) return { ok: false, error: 'no_messages' };

  // Только последние 12 сообщений — экономим токены. История у клиента в localStorage.
  const trimmed = messages.slice(-12);

  // Контекст приходит ДВУМЯ путями:
  // 1) localContext — фронт читает свои localStorage-кэши useLiveOzon/Wb/Bundle
  //    и шлёт прямо в запросе. Это самый надёжный источник: данные уже на экране
  //    у пользователя, значит он их «видит» и Claude должен видеть то же.
  // 2) buildSnapshot() — fallback на серверный KV-кэш (cron). Работает только
  //    если у проекта подключён Vercel KV / Upstash; на in-memory не пересекает
  //    serverless-инстансы между cron'ом и live-запросом.
  const snapshot = await buildSnapshot();
  const serverContextText = formatContextForPrompt(snapshot);

  // Собираем итоговый человекочитаемый блок контекста для промпта
  const ctxLines: string[] = [];
  ctxLines.push(`# Контекст бизнеса (актуальный, с экрана пользователя)`);
  if (localContext?.ozon) {
    const o = localContext.ozon;
    ctxLines.push(`## Ozon (${o.period === 'day' ? 'сегодня' : o.period === 'week' ? 'за 7 дней' : 'за 30 дней'})`);
    ctxLines.push(`- Выручка: ${Number(o.revenue).toLocaleString('ru-RU')} ₽`);
    ctxLines.push(`- Заказов: ${o.orders}`);
    ctxLines.push(`- Средний чек: ${Number(o.avgCheck).toLocaleString('ru-RU')} ₽`);
    ctxLines.push(`- Товаров в кабинете: ${o.products}`);
  }
  if (localContext?.wb) {
    const w = localContext.wb;
    ctxLines.push(`## Wildberries`);
    ctxLines.push(`- Выручка: ${Number(w.revenue).toLocaleString('ru-RU')} ₽`);
    ctxLines.push(`- Заказов: ${w.orders}`);
    ctxLines.push(`- Средний чек: ${Number(w.avgCheck).toLocaleString('ru-RU')} ₽`);
    ctxLines.push(`- Товаров (карточек): ${w.products}`);
  }
  if (localContext?.ads) {
    const a = localContext.ads;
    ctxLines.push(`## Реклама Ozon (${a.period})`);
    ctxLines.push(`- Расход: ${Number(a.расход).toLocaleString('ru-RU')} ₽ · Выручка с рекламы: ${Number(a.выручка).toLocaleString('ru-RU')} ₽`);
    ctxLines.push(`- ROAS: ${a.roas ?? '—'} · ДРР: ${a.ДРР_процент != null ? a.ДРР_процент + '%' : '—'} · Кампаний: ${a.кампаний} (активных ${a.активных})`);
    if (Array.isArray(a.топ_по_расходу) && a.топ_по_расходу.length) {
      ctxLines.push(`Кампании по расходу (название · расход · заказов · выручка · ДРР · статус):`);
      for (const c of a.топ_по_расходу) {
        ctxLines.push(`- ${c.название}: ${Number(c.расход).toLocaleString('ru-RU')} ₽ · ${c.заказов} зак · ${Number(c.выручка).toLocaleString('ru-RU')} ₽ · ДРР ${c.ДРР_процент != null ? c.ДРР_процент + '%' : '—'}${c.статус ? ' · ' + c.статус : ''}`);
      }
    }
  }
  if (Array.isArray(localContext?.topProducts) && localContext.topProducts.length) {
    ctxLines.push(`## Топ-10 товаров по выручке (Ozon, последняя неделя)`);
    for (const p of localContext.topProducts.slice(0, 10)) {
      const parts: string[] = [];
      parts.push(`${p.name} (sku ${p.sku})`);
      if (p.revenue) parts.push(`выручка ${Number(p.revenue).toLocaleString('ru-RU')} ₽`);
      if (p.orders) parts.push(`${p.orders} заказов`);
      if (p.price) parts.push(`цена ${Number(p.price).toLocaleString('ru-RU')} ₽`);
      ctxLines.push(`- ${parts.join(', ')}`);
    }
  }
  if (localContext?.margins?.items?.length) {
    const m = localContext.margins;
    ctxLines.push(`## Маржа, ROI и себестоимость (лист «Маржа» — источник истины по рентабельности; всего SKU с данными: ${m.count})`);
    ctxLines.push(`ROI и маржа — в %, прибыль и себестоимость — в ₽. Формат: SKU · название · ROI Ozon/WB · маржа Ozon/WB · себестоимость · прибыль за неделю Ozon/WB · продажи за 7 дн Ozon/WB.`);
    const fmtP = (v: number | null | undefined) => (v == null ? '—' : `${Number(v).toLocaleString('ru-RU')} ₽`);
    const fmtPct = (v: number | null | undefined) => (v == null ? '—' : `${v}%`);
    for (const it of m.items) {
      ctxLines.push(`- ${it.sku} · ${it.name}: ROI ${fmtPct(it.roiOzon)}/${fmtPct(it.roiWb)} · маржа ${fmtPct(it.marginOzon)}/${fmtPct(it.marginWb)} · себест. ${fmtP(it.cost)} · приб/нед ${fmtP(it.profitWeekOzon)}/${fmtP(it.profitWeekWb)} · прод.7д ${it.sales7Ozon ?? 0}/${it.sales7Wb ?? 0} шт`);
    }
  }

  const localContextText = ctxLines.length > 1 ? ctxLines.join('\n') : '';

  // Сначала server-side (если есть), потом фронтовый поверх — он считается основным.
  const fullContext = [serverContextText, localContextText].filter(Boolean).join('\n\n');

  // System: статичный кусок (правила) + контекст бизнеса. Оба маркируем
  // cache_control: ephemeral — Anthropic кэширует на 5 мин, повторные вопросы
  // в течение сессии оплачиваются почти бесплатно (cache_read $0.30/1M).
  const systemBlocks = [
    {
      type: 'text' as const,
      text: `Ты — AI-копилот платформы Avto Vibe для селлера ИП Алешко. Помогаешь принимать решения по маркетплейсам WB и Ozon.

ВАЖНО ПО ФОРМАТУ:
- НИКОГДА не используй markdown: ни **жирного**, ни ## заголовков, ни --- разделителей. Чат рендерится как обычный текст, markdown будет виден как мусор.
- Списки — обычным дефисом «- » в начале строки, без вложенности.
- Числа — пиши как есть, с пробелами для разрядов: 582 988 ₽, 7 024 ₽.

Правила ответов:
- На русском, по делу, с конкретными цифрами из контекста ниже.
- Используй ИМЕННО ТЕ ЦИФРЫ что приведены в блоке «Контекст бизнеса». Они актуальны на текущий момент — не говори «не вижу в выгрузке», если цифры там есть.
- Когда даёшь рекомендацию — указывай источник: «по данным Ozon за 7 дней...», «в твоём топ-10...».
- Короткие ответы (2-4 абзаца). Длинные — только если попросят разбор.
- Не выдумывай числа. Не используй знания о товарах из тренировочных данных — только из контекста.
- Не призывай к авто-действиям без явной просьбы (менять цены, ставить рекламу на паузу).`,
      cache_control: { type: 'ephemeral' as const },
    },
  ];
  if (fullContext) {
    systemBlocks.push({
      type: 'text' as const,
      text: fullContext,
      cache_control: { type: 'ephemeral' as const },
    } as any);
  }
  if (currentPage) {
    systemBlocks.push({
      type: 'text' as const,
      text: `\nСейчас пользователь на странице: «${currentPage}». Если вопрос про эту страницу — отвечай в первую очередь по её данным.`,
      // НЕ кэшируем — этот блок может меняться при навигации
    } as any);
  }

  const { text, raw } = await callAnthropic({
    system: systemBlocks as any,
    messages: trimmed.map(m => ({ role: m.role, content: m.content })),
    max_tokens: 1000,
    temperature: 0.5,
    agent: 'chat',
  });
  return {
    ok: true,
    reply: text,
    contextAt: snapshot.generatedAt,
    usage: raw?.usage,
  };
}

