/**
 * Дополнение к агентам 6 и 7 — ТЕКСТОВЫЕ новости площадок.
 *
 * Тарифные агенты (marketplaceChanges.ts) ловят изменения цифр — комиссий и
 * тарифов. Но часть важного приходит только текстом: «с 1 сентября новые правила
 * упаковки», «склад временно не принимает поставки». Этот агент закрывает их.
 *
 * ИСТОЧНИК: публичное веб-превью официальных Telegram-каналов для продавцов
 * (https://t.me/s/<канал>). Почему так, а не парсинг кабинетов: проверено 29.07 —
 * seller.wildberries.ru отдаёт пустой SPA-каркас, docs.ozon.ru редиректит в
 * никуда, dev.wildberries.ru блокирует запросы (498). А t.me/s отдаёт готовый
 * HTML без авторизации и не ломается при редизайне кабинета.
 *
 * ⚠️ Это единственная неофициальная часть системы. Если Telegram сменит вёрстку
 * превью — агент перестанет находить посты (тихо, без падений), тарифные агенты
 * продолжат работать. Признак поломки: агент молчит неделями при активных каналах.
 */
import { cacheGet, cacheSet } from '../cache';
import { callAnthropic, extractJson } from '../anthropic';
import { addTheses, Marketplace, Thesis, ThesisCategory } from './knowledgeBase';
import { Agent, AgentMessage } from './types';

const SEEN_TTL = 400 * 24 * 60 * 60_000;
// Каналы проверены на живость 29.07.2026. Переопределяются через env, если
// площадка сменит основной канал.
const WB_CHANNEL = (process.env.AGENT_NEWS_WB_CHANNEL || 'wbsellerofficial').trim();
const OZ_CHANNEL = (process.env.AGENT_NEWS_OZON_CHANNEL || 'ozonmarketplace').trim();
const MAX_NEW = 5;              // больше 5 новостей за раз в одно сообщение не тащим

type Post = { id: number; date: string; text: string; url: string };

function decodeEntities(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Разбирает публичное превью канала. Пустой массив, если вёрстка не совпала. */
async function fetchChannel(channel: string): Promise<Post[]> {
  let html = '';
  try {
    const r = await fetch(`https://t.me/s/${encodeURIComponent(channel)}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AutoVibeBot/1.0)' },
      signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) return [];
    html = await r.text();
  } catch {
    return [];
  }

  const posts: Post[] = [];
  // Каждый пост начинается с data-post="channel/<id>" — режем по этому маркеру.
  const blocks = html.split('data-post="').slice(1);
  for (const b of blocks) {
    const idMatch = b.match(/^[^/"]+\/(\d+)/);
    if (!idMatch) continue;
    const id = Number(idMatch[1]);
    const textMatch = b.match(/tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>/);
    if (!textMatch) continue;
    const text = decodeEntities(textMatch[1]);
    if (!text) continue;
    const dateMatch = b.match(/datetime="([^"]+)"/);
    posts.push({
      id,
      date: dateMatch ? dateMatch[1].slice(0, 10) : '',
      text,
      url: `https://t.me/${channel}/${id}`,
    });
  }
  return posts;
}

/**
 * Просим Claude отфильтровать шум и вернуть ТЕЗИСЫ для базы знаний.
 * Реклама, вебинары и конкурсы отсекаются на этом шаге — в базу попадает
 * только то, что влияет на работу.
 */
async function analyze(mpName: string, mp: Marketplace, posts: Post[]): Promise<Thesis[]> {
  const body = posts
    .map(p => `[${p.date}] ${p.text.slice(0, 900)}`)
    .join('\n\n---\n\n');
  const { text } = await callAnthropic({
    system: [
      'Ты — аналитик маркетплейсов для ИП (автотовары, CarPlay-адаптеры, WB и Ozon).',
      'Тебе дают свежие новости площадки для продавцов.',
      'ОТБРОСЬ рекламу, вебинары, конкурсы, истории успеха и всё, что не влияет на работу продавца.',
      'По оставшемуся верни СТРОГО JSON без текста вокруг:',
      '{"theses":[{"date":"YYYY-MM-DD","category":"правила|склады|тарифы|комиссии|реклама|прочее",' +
      '"text":"что меняется и с какой даты, 1-2 предложения","impact":"что это значит для нас",' +
      '"action":"что сделать, коротко или null"}]}',
      'Если важного нет — верни {"theses":[]}. Не выдумывай дат и условий, которых нет в тексте.',
    ].join('\n'),
    messages: [{ role: 'user', content: `Площадка: ${mpName}\n\nНовости:\n\n${body}` }],
    max_tokens: 1200,
    agent: 'mp-news',
  });
  const parsed = extractJson<{ theses?: any[] }>(text);
  const allowed: ThesisCategory[] = ['тарифы', 'комиссии', 'правила', 'склады', 'реклама', 'прочее'];
  return (parsed?.theses ?? [])
    .filter(t => t?.text)
    .map(t => ({
      mp,
      date: /^\d{4}-\d{2}-\d{2}$/.test(String(t.date)) ? String(t.date) : (posts[posts.length - 1]?.date || ''),
      category: (allowed.includes(t.category) ? t.category : 'прочее') as ThesisCategory,
      text: String(t.text).slice(0, 600),
      impact: t.impact ? String(t.impact).slice(0, 400) : null,
      action: t.action && t.action !== 'null' ? String(t.action).slice(0, 400) : null,
    }));
}

// mpName — как площадка называется для человека («Wildberries»), mp — код для базы
// знаний («wb»). Раньше был один параметр `mp: string` на две роли: в базу уходил
// «Wildberries» вместо «wb», а обращение к несуществующей `mpName` роняло агента
// с ReferenceError на каждом прогоне, где есть свежие посты. Общий catch в index.ts
// это писал в журнал, но наружу агент просто молчал — со стороны «новостей нет».
async function runChannel(mpName: string, mp: Marketplace, channel: string, keyPrefix: string): Promise<AgentMessage[]> {
  const posts = await fetchChannel(channel);
  if (!posts.length) return [];

  const seenKey = `agent:mp-news:${channel}:v1`;
  const lastId = (await cacheGet<{ lastId: number }>(seenKey))?.data?.lastId ?? 0;
  const maxId = Math.max(...posts.map(p => p.id));
  await cacheSet(seenKey, { lastId: maxId }, SEEN_TTL);

  // Первый запуск: только запоминаем позицию, не заваливаем историей.
  if (!lastId) return [];

  const fresh = posts.filter(p => p.id > lastId).sort((a, b) => a.id - b.id).slice(-MAX_NEW);
  if (!fresh.length) return [];

  const theses = await analyze(mpName, mp, fresh).catch(() => [] as Thesis[]);
  if (!theses.length) return [];                     // только шум — молчим

  const links = fresh.map(p => p.url);
  // Проставляем ссылку на источник и копим в базе знаний.
  addTheses(theses.map((t, i) => ({ ...t, source: links[Math.min(i, links.length - 1)] ?? null })));

  const body = theses
    .map(t => `• <b>${t.date}</b> ${t.text}${t.action ? `\n  Что делать: ${t.action}` : ''}`)
    .join('\n\n');
  return [{
    key: `${keyPrefix}:${maxId}`,          // ключ по id поста — не повторимся
    text: `<b>${mpName}: важное из новостей</b>\n\n${body}\n\n<i>Тезисы сохранены в разделе «База знаний».</i>`,
  }];
}

export const wbNewsAgent: Agent = {
  id: 'wb-news',
  name: 'Агент 7+ · Новости Wildberries',
  role: 'Читает официальные новости WB, отсеивает шум и объясняет последствия',
  schedule: 'daily',
  run: () => runChannel('Wildberries', 'wb', WB_CHANNEL, 'agent7:news'),
};

export const ozonNewsAgent: Agent = {
  id: 'ozon-news',
  name: 'Агент 6+ · Новости Ozon',
  role: 'Читает официальные новости Ozon, отсеивает шум и объясняет последствия',
  schedule: 'daily',
  run: () => runChannel('Ozon', 'ozon', OZ_CHANNEL, 'agent6:news'),
};

/** Для ручной диагностики: сколько постов видим в канале прямо сейчас. */
export async function probeChannels(): Promise<string> {
  const [wb, oz] = await Promise.all([fetchChannel(WB_CHANNEL), fetchChannel(OZ_CHANNEL)]);
  const fmt = (name: string, p: Post[]) =>
    p.length ? `@${name}: ${p.length} постов, последний ${p[p.length - 1]?.date || '—'}` : `@${name}: постов не видно (вёрстка изменилась?)`;
  return `${fmt(WB_CHANNEL, wb)}\n${fmt(OZ_CHANNEL, oz)}`;
}
