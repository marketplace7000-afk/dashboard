/**
 * Сезонность по категориям для «Закупок» (21.11.2026).
 *
 * Источники копятся на сервере помесячно: частота главных поисковых запросов наших товаров на WB (API,
 * «Джем»), запросы наших карточек на Ozon (API, только последний месяц — история копится с 21.11),
 * Яндекс Вордстат (сайт, 2 года). Сезонность — форма года, а не объём: каждый запрос делится на своё
 * среднее, поэтому частый запрос не «перекрикивает» редкий, а рост бизнеса за год гасится.
 */

export type SeasonSource = 'wb' | 'ozon' | 'wordstat';
export const SEASON_SOURCES: { key: SeasonSource; label: string }[] = [
  { key: 'wb', label: 'WB — покупатели WB' },
  { key: 'ozon', label: 'Ozon — покупатели Ozon' },
  { key: 'wordstat', label: 'Вордстат — весь Яндекс' },
];
export const MONTHS_RU = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

/** Ряд одного запроса: месяц 'YYYY-MM' → частота. */
export type QuerySeries = { query: string; months: Record<string, number> };

export type SeasonIndex = {
  /** Коэффициент календарного месяца (0 = январь): 1 — обычный месяц, 1,5 — на 50 % выше. null — нет данных. */
  k: (number | null)[];
  /** Сколько запросов дали данные. */
  queries: number;
  /** Самый ранний и поздний месяц данных. */
  from: string; to: string;
  /** Сколько месяцев в среднем на запрос (меньше 12 — сезонность неполная). */
  depth: number;
};

const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

/**
 * Месяцы, которые не берём в сезонность. Пусто: в июле–сентябре 2026 Вордстат показал рост ЧИСЛА всех запросов
 * в 1,5–2 раза — это рост всего Яндекса; с 21.11 берём ДОЛЮ запроса от всех запросов, она этот рост гасит.
 */
export const SKIP_MONTHS: Partial<Record<SeasonSource, string[]>> = {};

/**
 * Индекс сезонности по набору запросов. Для каждого запроса: значение месяца ÷ среднее его месяцев
 * (нужно ≥ 3 месяцев с частотой > 0). Коэффициент календарного месяца — среднее по запросам и годам,
 * затем весь ряд снова приводится к среднему 1 по известным месяцам.
 */
export function seasonIndex(series: QuerySeries[], skip: string[] = []): SeasonIndex {
  const buckets: number[][] = Array.from({ length: 12 }, () => []);
  let used = 0, depthSum = 0, from = '', to = '';
  for (const s of series) {
    const ms = Object.entries(s.months).filter(([m, v]) => v > 0 && !skip.includes(m));
    if (ms.length < 3) continue;
    const mean = avg(ms.map(([, v]) => v));
    if (!(mean > 0)) continue;
    used++; depthSum += ms.length;
    for (const [m, v] of ms) {
      buckets[Number(m.slice(5, 7)) - 1].push(v / mean);
      if (!from || m < from) from = m;
      if (!to || m > to) to = m;
    }
  }
  const raw = buckets.map(b => (b.length ? avg(b) : null));
  const known = raw.filter((x): x is number => x !== null);
  const norm = known.length ? avg(known) : 1;
  return { k: raw.map(x => (x === null ? null : x / norm)), queries: used, from, to, depth: used ? depthSum / used : 0 };
}

/** Январь–февраль к ноябрю–декабрю: 0,5 — спрос после Нового года вдвое ниже. null — не хватает месяцев. */
export function winterDrop(k: (number | null)[]): number | null {
  const [jan, feb, nov, dec] = [k[0], k[1], k[10], k[11]];
  if (jan == null || feb == null || nov == null || dec == null || nov + dec <= 0) return null;
  return (jan + feb) / (nov + dec);
}

/**
 * Главные запросы товара: самые частые за последний месяц, без брендов и номеров карточек
 * (поиск своего бренда — не спрос категории). brandWords — куски артикула и бренды (ALLPOWERS, CARLINKIT…).
 */
export function mainQueries(rows: { query: string; freq: number }[], brandWords: string[], n = 3): string[] {
  const bad = brandWords.map(w => w.toLowerCase()).filter(w => w.length >= 3);
  const seen = new Set<string>();
  return rows
    .filter(r => r.freq > 0 && /\p{L}/u.test(r.query) && !bad.some(w => r.query.toLowerCase().includes(w)))
    .sort((a, b) => b.freq - a.freq)
    .filter(r => { const q = r.query.toLowerCase().trim(); if (seen.has(q)) return false; seen.add(q); return true; })
    .slice(0, n).map(r => r.query.toLowerCase().trim());
}

export type SeasonCategory = {
  category: string;
  products: { key: string; name: string }[];
  sources: Partial<Record<SeasonSource, SeasonIndex & { drop: number | null; top: string[] }>>;
  /** Главные запросы категории (одни и те же для всех источников) и сезонность каждого по источникам. */
  queries: ({ query: string } & Partial<Record<SeasonSource, (number | null)[]>>)[];
};

export type SeasonResponse = {
  ok: true; builtAt: string;
  categories: SeasonCategory[];
  runs: { source: string; at: string; ok: boolean; detail: string }[];
  /** Сколько месяцев истории уже лежит на сервере по каждому источнику и за какой период. */
  coverage: Record<SeasonSource, { months: number; from: string; to: string }>;
  /** Сколько агенту на ПК осталось собрать в текущем цикле. */
  pending: { ozon: number; wordstat: number };
  notes: string[];
};

/** 'YYYY-MM' + n месяцев. */
export function addMonths(m: string, n: number): string {
  const t = Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7)) - 1 + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
}
const onlyMonths = (ss: QuerySeries[], from: string, to: string): QuerySeries[] =>
  ss.map(s => ({ query: s.query, months: Object.fromEntries(Object.entries(s.months).filter(([m]) => m >= from && m <= to)) }));
const median = (xs: number[]) => { const a = [...xs].sort((x, y) => x - y); return a.length ? (a.length % 2 ? a[a.length >> 1] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2) : 0; };

/** Сезонность для расчёта закупки: коэффициент месяца (0 = январь), 1 — месяц не трогаем. */
export type CalcSeason = {
  k: number[];
  /** С какого месяца начался новый тренд ('' — тренда нет): последний год вырос в разы к прошлому — в сезонность не берём. */
  trendFrom: string;
  /** Сколько месяцев подтверждено двумя годами (не равны 1). */
  confirmed: number;
};

/**
 * Решение владельца 22.11: в расчёт идёт только сезонность, которая повторилась два года подряд по Вордстату
 * (год A — 24–13 месяцев назад, год B — последние 12 полных месяцев). Месяц поднят, только если он выше
 * обычного в ОБА года, опущен — если ниже в оба года; берём более осторожное из двух значений.
 * Площадка (WB или Ozon, их 12 месяцев совпадают с годом B) может только смягчить коэффициент, не усилить.
 * Новый тренд — последние 4 месяца года B выше тех же месяцев года A в 1,6+ раза (у станций лето 2026 — в 2–3 раза):
 * тогда год B и площадку не берём вовсе, остаётся форма года A. Коэффициент — от 0,6 до 1,6.
 * Вордстата за два года нет — null (расчёт возьмёт запасной способ).
 */
export function calcSeason(ws: QuerySeries[], mp: (number | null)[] | null, lastMonth: string): CalcSeason | null {
  const bFrom = addMonths(lastMonth, -11), aTo = addMonths(lastMonth, -12), aFrom = addMonths(lastMonth, -23);
  const A = seasonIndex(onlyMonths(ws, aFrom, aTo)), B = seasonIndex(onlyMonths(ws, bFrom, lastMonth));
  if (!A.queries || !B.queries) return null;
  // Тренд: рост уровня (сырые доли, не формы) месяца к тому же месяцу год назад.
  const growth = (m: string) => median(ws.map(s => { const a = s.months[addMonths(m, -12)], b = s.months[m]; return a > 0 && b > 0 ? b / a : NaN; }).filter(Number.isFinite));
  const last4 = [0, 1, 2, 3].map(i => addMonths(lastMonth, -i));
  const g4 = median(ws.map(s => {
    let a = 0, b = 0;
    for (const m of last4) { a += s.months[addMonths(m, -12)] ?? 0; b += s.months[m] ?? 0; }
    return a > 0 && b > 0 ? b / a : NaN;
  }).filter(Number.isFinite));
  let trendFrom = '';
  if (g4 >= 1.6) {
    for (let i = 11; i >= 0; i--) { const m = addMonths(lastMonth, -i); if (growth(m) >= 1.6) { trendFrom = m; break; } }
    trendFrom = trendFrom || last4[3];
  }
  const clamp = (x: number) => Math.min(1.6, Math.max(0.6, x));
  const k = Array.from({ length: 12 }, (_, m) => {
    const a = A.k[m], b = B.k[m];
    if (a == null) return 1;
    if (trendFrom) return Math.abs(a - 1) >= 0.1 ? clamp(a) : 1;
    if (b == null) return 1;
    let c = a >= 1.1 && b >= 1.1 ? Math.min(a, b) : a <= 0.9 && b <= 0.9 ? Math.max(a, b) : 1;
    const x = mp?.[m];
    if (c !== 1 && x != null) c = c > 1 ? Math.min(c, Math.max(1, x)) : Math.max(c, Math.min(1, x));
    return clamp(c);
  });
  return { k, trendFrom, confirmed: k.filter(x => x !== 1).length };
}
