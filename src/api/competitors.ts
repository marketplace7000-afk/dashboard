// Клиент единого парсера конкурентов /api/competitors/* (WB + Ozon).
// Данные приходят из серверного кэша (прогрев фоном + по требованию с троттлом),
// поэтому фронт просто читает результат и не банится площадками.

export type Platform = 'wb' | 'ozon';

export type CompetitorItem = {
  platform: Platform;
  id: string;
  name: string;
  brand: string | null;
  seller: string | null;
  price: number;
  oldPrice: number | null;
  rating: number | null;
  reviews: number | null;
  image: string | null;
  url: string;
};

export type CompetitorSearch = {
  platform: Platform;
  query: string;
  fetchedAt: number;
  items: CompetitorItem[];
  partial?: boolean;
  error?: string;
};

export type CompetitorCard = {
  platform: Platform;
  id: string;
  name: string;
  brand: string | null;
  description: string;
  characteristics: Array<{ name: string; value: string }>;
  photoCount: number;
  images: string[];
  link: string;
};

export async function competitorsSearch(mp: Platform, query: string, limit = 16): Promise<CompetitorSearch> {
  const r = await fetch(`/api/competitors/search?mp=${mp}&q=${encodeURIComponent(query)}&limit=${limit}`, { credentials: 'include' });
  const j = await r.json().catch(() => null);
  if (!j) throw new Error('Не удалось получить ответ парсера');
  return j as CompetitorSearch;
}

export async function competitorsCard(mp: Platform, id: string): Promise<CompetitorCard> {
  const r = await fetch(`/api/competitors/card?mp=${mp}&id=${encodeURIComponent(id)}`, { credentials: 'include' });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j || j.error) throw new Error(j?.detail || j?.error || 'Ошибка карточки');
  return j as CompetitorCard;
}

export type WbPosition = { query: string; nmId: number; position: number | null; page: number | null; scanned: number; fetchedAt: number };

/** Позиция своего товара (nmId) в поисковой выдаче WB по ключевому запросу. */
export async function wbPosition(query: string, nmId: number): Promise<WbPosition> {
  const r = await fetch(`/api/positions?q=${encodeURIComponent(query)}&nm=${nmId}`, { credentials: 'include' });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j || j.error) throw new Error(j?.detail || j?.error || 'Ошибка позиций');
  return j as WbPosition;
}
