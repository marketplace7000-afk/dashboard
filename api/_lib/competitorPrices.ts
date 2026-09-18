/**
 * Сбор цен конкурентов WB и расчёт положения на рынке (этап 1, план от 11.08).
 *
 * Почему отдельный модуль, а не внутри competitors.ts: тот отвечает на разовый
 * вопрос «покажи выдачу по запросу», а здесь фоновая задача — раз в сутки снять
 * цену по КАЖДОМУ закреплённому конкуренту и положить в историю.
 *
 * Цены берём пачкой: card.wb.ru принимает несколько артикулов за раз, поэтому на
 * сотню отслеживаемых товаров уходит один-два запроса, а не сотня. Это принципиально:
 * WB лимитирует по IP, и поштучный обход — прямой путь к бану.
 *
 * ⚠ ОГРАНИЧЕНИЕ, о котором нужно помнить. card.wb.ru отвечает только с российских
 * адресов и блокирует машины разработчиков (проверено 14.08.2026: с рабочего Mac
 * стабильный 403). Поэтому модуль отлаживается на сервере в Москве, а локально
 * всегда будет отдавать пустой результат с понятной причиной, а не падать.
 */
import { fetchWithRetry } from './fetchRetry';
import { activeNmIds, getLinks, recordPrices, getLatestPrices, type CompetitorLink } from './competitorWatch';

const CARD_HOST = 'https://card.wb.ru';
// dest — регион для цены. -1257786 = Москва: цены по стране отличаются, и сравнивать
// нужно в одном регионе, иначе «конкурент дешевле» окажется артефактом географии.
const DEST = '-1257786';
const CHUNK = 100;          // сколько артикулов за один запрос
const PAUSE_MS = 1_500;     // пауза между пачками — бережём лимит по IP

export type CompetitorPrice = {
  nmId: number;
  price: number;            // цена на витрине (после всех скидок WB), ₽
  /** Зачёркнутая цена на витрине (basic), ₽ — чтобы видеть глубину скидки. */
  oldPrice?: number;
  title?: string;
  brand?: string;
  rating?: number;
  feedbacks?: number;
};

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/**
 * Единицы измерения ответа card.wb.ru.
 *
 * v2 отдавал копейки (×100). Аудит 04.09 на трёх карточках: у v4 поле
 * `sizes[0].price.product` совпадает с ценой на витрине wildberries.ru РУБЛЬ В
 * РУБЛЬ (13 052, 76 276, 3 991), `basic` — зачёркнутая. Значит v4 — рубли.
 *
 * Полагаться на это вслепую всё же нельзя, поэтому для СВОИХ товаров есть
 * якорь — серая цена из Seller API (рубли): витрина не бывает выше серой цены
 * больше чем на копейки, а в копейках она будет выше в ~100 раз. При первом
 * прогреве образец печатается в журнал ([wb-showcase] образец) — по нему видно,
 * что единицы угаданы верно.
 */
function toRub(raw: unknown, anchorRub?: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (anchorRub && anchorRub > 0) {
    // Копейки: значение в ~100 раз больше якоря, а делённое на 100 — не выше него.
    if (n > anchorRub * 20 && n / 100 <= anchorRub * 1.05) return Math.round(n / 100);
    return Math.round(n);
  }
  // Без якоря (конкуренты): v4 — рубли. Копейки распознаём только по явному
  // признаку — значению, невозможному в рублях для наших категорий.
  return n >= 5_000_000 ? Math.round(n / 100) : Math.round(n);
}

/** Витринная цена из карточки. product — после всех скидок WB, это и есть цена на витрине. */
function priceOf(p: any, anchorRub?: number): { price: number; oldPrice?: number } {
  const s = p?.sizes?.[0]?.price ?? {};
  const price = toRub(s.product ?? s.total ?? p?.salePriceU ?? 0, anchorRub);
  const old = toRub(s.basic ?? p?.priceU ?? 0, anchorRub);
  return { price, oldPrice: old > price ? old : undefined };
}

/** Снять цены по списку артикулов. Не бросает: возвращает что удалось + причину. */
/**
 * @param anchors nmId → серая цена из Seller API, ₽. Для своих товаров: якорь
 *   единиц измерения (см. toRub). Для конкурентов якоря нет.
 */
export async function fetchWbPrices(nmIds: number[], anchors?: Map<number, number>): Promise<{ items: CompetitorPrice[]; error?: string }> {
  const ids = [...new Set(nmIds.filter(n => Number.isFinite(n) && n > 0))];
  if (!ids.length) return { items: [] };

  const out: CompetitorPrice[] = [];
  let error: string | undefined;

  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    if (i > 0) await sleep(PAUSE_MS);
    // v4: v2 и v1 отвечают 404 (аудит 04.09), сбор конкурентов из-за этого молча
    // давал ноль позиций. У v4 `products` лежит на ВЕРХНЕМ уровне, а без dest
    // ответ пустой. Параметр spp ни на что не влияет — убран.
    const url = `${CARD_HOST}/cards/v4/detail?appType=1&curr=rub&dest=${DEST}&nm=${chunk.join(';')}`;
    try {
      const r = await fetchWithRetry(url, {
        method: 'GET',
        headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
      }, { maxRetries: 1, timeoutMs: 20_000 });
      const text = await r.text();
      // WB на блокировку отвечает HTML-заглушкой, а не JSON.
      if (!r.ok || text.trim().startsWith('<')) {
        error = r.status === 403
          ? 'WB не отдаёт цены с этого адреса (403). Сбор работает только с российского сервера.'
          : `card.wb.ru ответил ${r.status}`;
        break;
      }
      const j = JSON.parse(text);
      const products: any[] = j?.products ?? j?.data?.products ?? [];
      for (const p of products) {
        const { price, oldPrice } = priceOf(p, anchors?.get(Number(p?.id)));
        if (!p?.id || !price) continue;
        out.push({
          nmId: Number(p.id),
          price,
          oldPrice,
          title: p.name ?? undefined,
          brand: p.brand ?? undefined,
          rating: Number(p.reviewRating) || undefined,
          feedbacks: Number(p.feedbacks) || undefined,
        });
      }
    } catch (e) {
      error = `card.wb.ru недоступен: ${(e as Error).message}`;
      break;
    }
  }
  return { items: out, error };
}

/**
 * Фоновый проход: снять цены по всем активным конкурентам и записать в историю.
 * Вызывается сборщиком раз в сутки — чаще не нужно, нам важен тренд.
 */
export async function collectCompetitorPrices(): Promise<{ tracked: number; saved: number; error?: string }> {
  const ids = activeNmIds();
  if (!ids.length) return { tracked: 0, saved: 0 };
  const { items, error } = await fetchWbPrices(ids);
  const saved = recordPrices(items.map(i => ({ nmId: i.nmId, price: i.price, title: i.title, brand: i.brand })));
  if (error) console.warn(`[competitors] цены сняты частично: ${error}`);
  return { tracked: ids.length, saved, error };
}

// ─── Положение на рынке ─────────────────────────────────────────────────────
export type MarketPosition = {
  sku: string;
  ourPrice: number | null;
  min: number | null;
  avg: number | null;
  max: number | null;
  /** Наше место среди конкурентов по цене: 1 = самые дешёвые. null — не с чем сравнивать. */
  rank: number | null;
  total: number;
  /** На сколько процентов мы дороже минимума. Отрицательное — мы дешевле всех. */
  vsMinPct: number | null;
  competitors: Array<CompetitorLink & { price: number | null; priceDate?: string }>;
  /** Почему пусто — чтобы интерфейс не показывал молчаливый прочерк. */
  reason?: string;
};

/**
 * Рынок по одному нашему товару. Считаем ТОЛЬКО по активным привязкам:
 * предложенные системой в расчёт не идут, пока их не одобрили.
 */
export function getMarketPosition(sku: string, ourPrice: number | null): MarketPosition {
  const links = getLinks(sku);
  const active = links.filter(l => l.status === 'active');
  const prices = getLatestPrices(active.map(l => l.nmId));

  const competitors = active.map(l => ({
    ...l,
    price: prices[l.nmId]?.price ?? null,
    priceDate: prices[l.nmId]?.date,
  }));

  const values = competitors.map(c => c.price).filter((v): v is number => !!v && v > 0);
  const base: MarketPosition = {
    sku, ourPrice, min: null, avg: null, max: null, rank: null,
    total: values.length, vsMinPct: null, competitors,
  };

  if (!active.length) return { ...base, reason: 'Конкуренты не закреплены за товаром' };
  if (!values.length) return { ...base, reason: 'Цены конкурентов ещё не собраны' };

  const min = Math.min(...values);
  const max = Math.max(...values);
  const avg = Math.round(values.reduce((s, v) => s + v, 0) / values.length);
  // Место считаем среди всех цен вместе с нашей: сколько цен строго ниже нашей, +1.
  const rank = ourPrice && ourPrice > 0 ? values.filter(v => v < ourPrice).length + 1 : null;
  const vsMinPct = ourPrice && ourPrice > 0 && min > 0
    ? Math.round(((ourPrice - min) / min) * 1000) / 10
    : null;

  return { ...base, min, avg, max, rank, vsMinPct };
}
