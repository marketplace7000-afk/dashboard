/**
 * Постраничная выгрузка каталога карточек WB.
 *
 * `content/v2/get/cards/list` отдаёт максимум 100 карточек за запрос — больший
 * limit WB отклоняет с 400. Дальше листается курсором: в ответе приходит
 * `cursor.updatedAt` и `cursor.nmID` последней карточки, их надо положить в
 * следующий запрос.
 *
 * Почему это важно: цены (`list/goods/filter`) отдаются пачкой до 1000, а
 * карточки — по 100. Пока брали только первую страницу, у всего хвоста каталога
 * не было ни фото, ни названия: в «Ценах» это выглядело как пустые строки с
 * одним артикулом. Данные при этом были, просто не запрошены.
 */
import { fetchWithRetry } from './fetchRetry';

/** Хватит на 5000 карточек. Ограничение от зацикливания, а не от объёма. */
const MAX_PAGES = 50;
const PAGE_SIZE = 100;

export type WbCardsPage = {
  cards: any[];
  /** Сколько страниц реально прочитали — для диагностики в журнале. */
  pages: number;
  /** true, если упёрлись в MAX_PAGES: каталог больше, чем мы забрали. */
  truncated: boolean;
  /** true, если часть страниц не пришла и список неполный. */
  partial: boolean;
};

/**
 * Забрать весь каталог карточек, листая курсором.
 *
 * Ошибка на первой странице пробрасывается наверх: пустой каталог и сбой — разные
 * ситуации, и вызывающий должен их различать. Ошибка на последующих страницах
 * прекращает обход, но уже собранное отдаётся с `partial: true` — неполный список
 * лучше пустого, если про неполноту честно сказано.
 */
export async function fetchAllWbCards(
  upstream: { base: string; headers: Record<string, string> },
): Promise<WbCardsPage> {
  const cards: any[] = [];
  let cursor: { limit: number; updatedAt?: string; nmID?: number } = { limit: PAGE_SIZE };
  let pages = 0;
  let partial = false;

  for (; pages < MAX_PAGES; pages++) {
    const res = await fetchWithRetry(
      `${upstream.base}/content/v2/get/cards/list`,
      {
        method: 'POST',
        headers: { ...upstream.headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: { cursor, filter: { withPhoto: -1 } } }),
      },
      { maxRetries: 2, timeoutMs: 30_000 },
    );
    if (!res.ok) {
      if (!cards.length) {
        const txt = await res.text().catch(() => '');
        throw new Error(`wb cards/list → ${res.status} ${txt.slice(0, 200)}`);
      }
      partial = true;
      break;
    }
    const data = await res.json().catch(() => null) as { cards?: any[]; cursor?: any } | null;
    const page: any[] = data?.cards ?? [];
    cards.push(...page);
    const c = data?.cursor ?? {};
    // Последняя страница: пришло меньше лимита либо WB не дал, чем продолжать.
    if (page.length < PAGE_SIZE || c.nmID == null) { pages++; break; }
    cursor = { limit: PAGE_SIZE, updatedAt: c.updatedAt, nmID: c.nmID };
  }

  return { cards, pages, truncated: pages >= MAX_PAGES, partial };
}
