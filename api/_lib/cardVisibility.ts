/**
 * «Ведение карточек»: Ozon «Видимость в поиске» → «Что влияет на место в поиске» (01.11.2026).
 * Снимок выдачи по важным запросам закреплённых карточек. Снимает агент на ПК в полном ночном проходе,
 * только чтение. Регион — Москва; если на складах Москвы нет остатка, регион, где товар лежит больше всего.
 * По базе знаний Ozon значения разных параметров не складываем и разные дни не сравниваем:
 * выводы только «мы против выдачи в том же снимке».
 */
import { adsDb } from './ads/store';
import { rnpItems } from './rnp';
import { getFbo } from './fboStocks';

export type VisRegion = { title: string; uuid: string; latitude: number; longitude: number; areaId: string; fullAddress: boolean };
export type VisRow = {
  sku: string; relevance: number | null; popularity: number | null; rating: number | null; reviews: number | null;
  price: number | null; delivery: string; promo: string; cpc: number | null; pos: number | null; name: string; seller: string; ours: boolean;
};
export type VisQuery = {
  query: string; date: string; at: number; region: string; regionWhy: string; total: number | null;
  ours: VisRow | null; top: VisRow[]; topRelevance: number | null; topPopularity: number | null; topPrice: number | null; diag: string;
  /** false: у города нет проверенного адреса Ozon, снимку нельзя верить. */
  exact: boolean;
};

const region = (title: string, latitude: number, longitude: number, uuid = ''): VisRegion => ({ title, uuid, latitude, longitude, areaId: '0', fullAddress: false });
const MOSCOW = region('Москва', 55.728138, 37.425808, '0c5b2444-70a0-4932-980c-b4dc0d3f02b5');
// Кластер Ozon → город. Адреса взяты из выбора региона в кабинете (01.11.2026). Без uuid Ozon давал доставку
// 36–182 дня всей выдаче и пустые ответы, поэтому снимки без адреса (старые «Казань» и т. п.) выводов не дают.
const CITIES: [RegExp, VisRegion][] = [
  [/москв/i, MOSCOW],
  [/петербург|спб|северо-запад|сзо/i, region('Санкт-Петербург', 59.939095, 30.315868, 'c2deb16a-0330-4f05-821f-1d09c93331e6')],
  [/екатеринбург|урал/i, region('Екатеринбург, Свердловская Область', 56.838011, 60.597465, '2763c110-cb8b-416a-9dac-ad28a55b4402')],
  [/казан|татарстан/i, region('Казань, Татарстан республика', 55.796288, 49.108795, '93b3df57-4c89-44df-ac42-96f05e9cd3b9')],
  [/краснодар|юг/i, region('Краснодар, Краснодарский Край', 45.03547, 38.975313, '7dfa745e-aa19-4688-b121-b655c11e482f')],
  [/ростов/i, region('Ростов-на-Дону, Ростовская Область', 47.222078, 39.720349, 'c1cfe4b9-f7c2-423c-abfa-6ed1c05a15c5')],
  [/самар|поволж/i, region('Самара, Самарская Область', 53.195538, 50.101783, 'bb035cc3-1dc2-4627-9d25-a1bf2d4b936b')],
  [/уф[аы]|башк/i, region('Уфа, Башкортостан Республика', 54.735147, 55.958727, '7339e834-2cb4-4734-a4c7-1fca2c66e562')],
  [/воронеж/i, region('Воронеж, Воронежская Область', 51.660781, 39.200269, '5bf5ddff-6353-4a3d-80c4-6fb27f00c6c1')],
  [/новосиб|сибир/i, region('Новосибирск, Новосибирская Область', 55.030199, 82.92043, '8dea00e3-9aab-4d8e-887c-ef2aaa546456')],
];
const MAX_QUERIES = 10;

function db(): any {
  const d = adsDb();
  if (!d) throw new Error('хранилище недоступно');
  d.exec(`CREATE TABLE IF NOT EXISTS card_visibility (
    sku TEXT NOT NULL, query TEXT NOT NULL, date TEXT NOT NULL, at INTEGER NOT NULL, json TEXT NOT NULL,
    PRIMARY KEY (sku, query, date));`);
  return d;
}

/** Москва, если там есть остаток; иначе кластер с наибольшим остатком; нет данных — Москва с пометкой. */
export function pickRegion(article: string, fbo: Awaited<ReturnType<typeof getFbo>>['data']): { region: VisRegion; why: string } {
  if (!fbo) return { region: MOSCOW, why: 'остатки по складам недоступны' };
  const art = article.toUpperCase();
  const qty = new Map<string, number>();
  for (const s of fbo.ozStock) if (String(s.item_code).toUpperCase() === art) qty.set(s.warehouse_name, (qty.get(s.warehouse_name) ?? 0) + (s.free_to_sell_amount || 0));
  const byCluster = fbo.ozClusters.map(c => ({ name: c.name, q: c.wh.reduce((n, w) => n + (qty.get(w) ?? 0), 0) }));
  const moscow = byCluster.filter(c => /москв/i.test(c.name)).reduce((n, c) => n + c.q, 0);
  if (moscow > 0) return { region: MOSCOW, why: `на складах Москвы ${moscow} шт.` };
  const best = byCluster.filter(c => c.q > 0 && CITIES.some(([re]) => re.test(c.name))).sort((a, b) => b.q - a.q)[0];
  if (!best) return { region: MOSCOW, why: 'остатка FBO на складах нет' };
  return { region: CITIES.find(([re]) => re.test(best.name))![1], why: `в Москве нет остатка, в кластере «${best.name}» ${best.q} шт.` };
}

/** Задание агенту: что снять этой ночью. Сначала целевые запросы владельца, затем самые частые не исключённые. */
export async function visibilityPlan(): Promise<{ sku: string; ozonSku: string; region: VisRegion; why: string; queries: string[] }[]> {
  const d = db();
  const pins = d.prepare("SELECT sku FROM card_pin WHERE mp = 'ozon'").all() as { sku: string }[];
  if (!pins.length) return [];
  const fbo = (await getFbo().catch(() => ({ data: null as any }))).data;
  const items = rnpItems('ozon');
  const out = [];
  for (const { sku } of pins) {
    const ozonSku = items.find(i => i.sku === String(sku))?.extId;
    if (!ozonSku) continue;
    const marks = d.prepare("SELECT text, mark FROM card_seo_mark WHERE mp = 'ozon' AND sku = ?").all(sku) as { text: string; mark: string }[];
    const excluded = new Set(marks.filter(m => m.mark === 'exclude').map(m => m.text));
    const last = d.prepare("SELECT MAX(date) date FROM card_query WHERE mp = 'ozon' AND sku = ?").get(sku) as { date: string | null };
    const known = (last?.date ? d.prepare("SELECT json FROM card_query WHERE mp = 'ozon' AND sku = ? AND date = ? ORDER BY rank").all(sku, last.date) as { json: string }[] : [])
      .map(r => JSON.parse(r.json) as { text: string; freq: number | null })
      .sort((a, b) => (b.freq ?? 0) - (a.freq ?? 0)).map(q => q.text.toLowerCase().replace(/ё/g, 'е').trim());
    const queries = [...new Set([...marks.filter(m => m.mark === 'target').map(m => m.text), ...known])].filter(q => !excluded.has(q)).slice(0, MAX_QUERIES);
    if (queries.length) out.push({ sku: String(sku), ozonSku: String(ozonSku), ...(() => { const p = pickRegion(String(sku), fbo); return { region: p.region, why: p.why }; })(), queries });
  }
  return out;
}

const median = (v: (number | null)[]): number | null => {
  const a = v.filter((x): x is number => x != null).sort((x, y) => x - y);
  return a.length ? a[Math.floor(a.length / 2)] : null;
};

const isExact = (title: string): boolean => CITIES.some(([, r]) => r.title === title && !!r.uuid);
/** Верхняя граница срока доставки в днях: «2-3 дня» → 3, «0-1 день» → 1. */
const deliveryDays = (s: string | undefined): number | null => {
  if (!s || !/дн|день/.test(s)) return null;
  const n = Number(s.match(/\d+/g)?.pop());
  return Number.isFinite(n) ? n : null;
};

/** Правило: что мешает месту. Сравнение только с первой десяткой этого же снимка. */
function diagnose(v: Pick<VisQuery, 'region' | 'ours' | 'top' | 'topRelevance' | 'topPopularity' | 'topPrice'>): string {
  const { ours, topRelevance, topPopularity, topPrice } = v;
  if (!isExact(v.region)) return 'Регион не уточнён: выводов нет';
  if (!v.top.length) return 'Ozon не отдал выдачу: данных нет';
  if (!ours || ours.pos == null) return 'Карточки нет в ответе Ozon: проверить вручную';
  if (ours.pos <= 10) return 'В первой десятке';
  if (topRelevance != null && (ours.relevance ?? 0) < topRelevance * 0.85) return 'Слабее по тексту: править SEO';
  // Доставка мешает, только если у лидеров она короче: одинаковый долгий срок у всех ничего не значит.
  const ourDays = deliveryDays(ours.delivery), topDays = median(v.top.filter(t => t.pos != null && t.pos <= 10).map(t => deliveryDays(t.delivery)));
  if (ourDays != null && ourDays > 3 && topDays != null && ourDays > topDays) return 'Долгая доставка: сначала склады';
  if (topPrice != null && ours.price != null && ours.price > topPrice * 1.15) return 'Цена выше выдачи';
  if (topPopularity != null && (ours.popularity ?? 0) < topPopularity * 0.7) return 'Текст в порядке, мало популярности: реклама';
  return 'Без явной причины';
}

/** Приём от агента. Повторный снимок за день заменяет прошлый. */
export function saveVisibility(rows: any, at: number, date: string): number {
  if (!Array.isArray(rows)) return 0;
  const st = db().prepare(`INSERT INTO card_visibility (sku, query, date, at, json) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(sku, query, date) DO UPDATE SET at = excluded.at, json = excluded.json`);
  let n = 0;
  for (const r of rows) {
    const top: VisRow[] = Array.isArray(r?.top) ? r.top : [];
    const ten = top.filter(t => t.pos != null && t.pos <= 10);
    const ours: VisRow | null = r?.ours ?? null;
    const topRelevance = median(ten.map(t => t.relevance)), topPopularity = median(ten.map(t => t.popularity)), topPrice = median(ten.map(t => t.price));
    const base = { query: String(r.query), date, at, region: String(r.region ?? ''), regionWhy: String(r.why ?? ''), total: r.total ?? null, ours, top: top.slice(0, 10), topRelevance, topPopularity, topPrice };
    const v: VisQuery = { ...base, diag: diagnose(base), exact: isExact(base.region) };
    st.run(String(r.sku), v.query, date, at, JSON.stringify(v));
    n++;
  }
  return n;
}

/** Последний снимок карточки. Вывод считаем при чтении, чтобы правка правил действовала и на уже снятое. */
export function cardVisibility(sku: unknown): VisQuery[] {
  const d = db(), id = String(sku ?? '');
  const last = d.prepare('SELECT MAX(date) date FROM card_visibility WHERE sku = ?').get(id) as { date: string | null };
  if (!last?.date) return [];
  return (d.prepare('SELECT json FROM card_visibility WHERE sku = ? AND date = ?').all(id, last.date) as { json: string }[]).map(r => {
    const v = JSON.parse(r.json) as VisQuery;
    return { ...v, diag: diagnose(v), exact: isExact(v.region) };
  });
}

/**
 * Позиция в поиске Ozon для «Конкурентов» (07.11.2026, вместо столбца «К нашей»): последний снимок
 * «Видимости в поиске» по самому частому запросу карточки — наше место и места конкурентов из первой десятки
 * той же выдачи. Снимок есть только у закреплённых в «Ведении карточек» товаров; у остальных — null.
 */
export function searchPositions(sku: unknown): { query: string; at: number; ours: number | null; bySku: Record<string, number> } | null {
  let list: VisQuery[] = [];
  try { list = cardVisibility(sku).filter(v => v.exact && v.top.length); } catch { return null; }
  if (!list.length) return null;
  const freq = new Map<string, number>();
  try {
    const d = db(), id = String(sku ?? '');
    const last = d.prepare("SELECT MAX(date) date FROM card_query WHERE mp = 'ozon' AND sku = ?").get(id) as { date: string | null } | undefined;
    if (last?.date) for (const r of d.prepare("SELECT json FROM card_query WHERE mp = 'ozon' AND sku = ? AND date = ?").all(id, last.date) as { json: string }[]) {
      const q = JSON.parse(r.json) as { text?: string; freq?: number | null };
      if (q.text) freq.set(q.text.toLowerCase().replace(/ё/g, 'е').trim(), Number(q.freq) || 0);
    }
  } catch { /* частот нет — берём первый запрос */ }
  const v = [...list].sort((a, b) => (freq.get(b.query) ?? 0) - (freq.get(a.query) ?? 0))[0];
  const bySku: Record<string, number> = {};
  for (const t of v.top) if (t.pos != null && !t.ours) bySku[String(t.sku)] = t.pos;
  return { query: v.query, at: v.at, ours: v.ours?.pos ?? null, bySku };
}
