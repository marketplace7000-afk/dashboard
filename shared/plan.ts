/**
 * Раздел «План» — типы и чистые расчёты, общие для сервера и проверок (02.11.2026).
 *
 * Нужно в день = (план − заказы по вчера) ÷ дней до конца месяца, включая сегодня.
 * Сегодняшние заказы в расчёт минимума не входят: день ещё не закончился.
 * У новинки отсчёт идёт от даты старта продаж, а не от начала месяца.
 */
export type PlanMp = 'wb' | 'ozon';
export type PlanView = PlanMp | 'all';
export type PlanBasis = '7d' | '30d';
export type PlanStatus = 'Рабочий' | 'Вывод' | 'Новинка';
export type PriceSource = 'manual' | 'frozen' | 'avg7' | 'avg30' | 'avg90' | 'none';

export type PlanDay = { date: string; cnt: number };

export type PlanArchived = { mp: PlanView; article: string; name: string; photo: string; qty: number; fact: number; factRub: number; stock: number | null };

export type PlanRow = {
  /** Товар в архиве, но остаётся в утверждённом плане этого месяца. */
  archived: boolean;
  mp: PlanView;
  article: string;
  name: string;
  photo: string;
  link: string;
  status: PlanStatus;
  isNew: boolean;
  inSale: boolean;
  startDate: string | null;
  comment: string;
  qty: number;
  hasLine: boolean;
  price: number;
  priceSource: PriceSource;
  planRub: number;
  fact: number;
  factRub: number;
  /** % выполнения по штукам; null — плана нет. */
  pct: number | null;
  pctRub: number | null;
  /** Сколько должно быть заказано к концу вчерашнего дня при равномерном плане. */
  expected: number | null;
  forecast: number | null;
  needPerDay: number | null;
  pace7: number | null;
  behind: boolean;
  ads: number;
  drr: number | null;
  marginPct: number | null;
  marginRub: number | null;
  marginMonth: string | null;
  stock: number | null;
  transit: number | null;
  /** Хватит ли остатка и едущего товара на оставшийся план; null — неизвестно. */
  stockShort: boolean;
  prevFact: number | null;
  orders30: number;
  daily: PlanDay[];
  wb?: { qty: number; fact: number };
  ozon?: { qty: number; fact: number };
};

export type PlanTotals = {
  qty: number; planRub: number; fact: number; factRub: number; factOutOfPlan: number;
  pct: number | null; pctRub: number | null; expected: number | null; forecast: number | null; forecastRub: number | null;
  needPerDay: number | null; needRubPerDay: number | null; pace7: number | null;
  ads: number; drr: number | null; marginPct: number | null;
  /** Сумма минимумов по артикулам: излишек одного товара не закрывает недобор другого. */
  needSumByArticle: number | null;
};

export type PlanResponse = {
  ok: true; month: string; view: PlanView; today: string;
  state: 'draft' | 'approved' | 'mixed'; basis: PlanBasis;
  approvedBy: string | null; approvedAt: number | null;
  period: 'past' | 'current' | 'future';
  daysInMonth: number; daysLeft: number; canEdit: boolean; canApprove: boolean;
  factSource: 'api' | 'finance';
  finance: { month: string | null; approxTo: string | null; checkedAt: number | null; error: string | null };
  rows: PlanRow[]; totals: PlanTotals;
  catalog: { article: string; name: string }[];
  months: string[];
  archived: PlanArchived[];
};

export type PlanStatRow = {
  month: string; state: 'draft' | 'approved' | 'mixed' | 'none';
  qty: number; planRub: number; fact: number; factRub: number;
  pct: number | null; pctRub: number | null; ads: number; drr: number | null; marginPct: number | null; factSource: 'api' | 'finance';
};
export type PlanStats = { ok: true; view: PlanView; article: string | null; rows: PlanStatRow[] };

export type PlanRnp = {
  ok: true; month: string; state: 'draft' | 'approved' | 'mixed' | 'none'; daysLeft: number; totals: PlanTotals | null;
  byArticle: Record<string, { qty: number; fact: number; pct: number | null; needPerDay: number | null; pace7: number | null; behind: boolean }>;
};

const DAY_MS = 86_400_000;
export const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
export const monthStart = (m: string) => `${m}-01`;
export function monthEnd(m: string): string {
  const [y, mm] = m.split('-').map(Number);
  return new Date(Date.UTC(y, mm, 0)).toISOString().slice(0, 10);
}
export const shiftMonth = (m: string, n: number): string => {
  const [y, mm] = m.split('-').map(Number);
  return new Date(Date.UTC(y, mm - 1 + n, 1)).toISOString().slice(0, 7);
};
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);

/** Средний чек: сумма заказов ÷ штуки за окно; null — заказов не было. */
export function avgCheck(cnt: number, rub: number): number | null {
  return cnt > 0 && rub > 0 ? rub / cnt : null;
}

/** Какая цена идёт в рублёвый план. Ручная важнее всего, затем зафиксированная при утверждении, затем средний чек. */
export function pickPrice(a: {
  manual: number; frozen: number; basis: PlanBasis; avg7: number | null; avg30: number | null; avg90: number | null;
}): { price: number; source: PriceSource } {
  if (a.manual > 0) return { price: a.manual, source: 'manual' };
  if (a.frozen > 0) return { price: a.frozen, source: 'frozen' };
  const first = a.basis === '7d' ? ['avg7', 'avg30'] as const : ['avg30', 'avg7'] as const;
  for (const k of [...first, 'avg90'] as const) {
    const v = a[k];
    if (v) return { price: Math.round(v), source: k };
  }
  return { price: 0, source: 'none' };
}

export type Pace = { expected: number | null; needPerDay: number | null; forecast: number | null; daysLeft: number; behind: boolean };

/**
 * Темп одного товара или площадки.
 * factToYesterday — заказы по вчера; pace7 — заказов в день за последние 7 полных дней.
 */
export function calcPace(a: {
  qty: number; month: string; today: string; startDate?: string | null; factToYesterday: number; factTotal: number; pace7: number | null;
}): Pace {
  const from = monthStart(a.month), to = monthEnd(a.month);
  const start = a.startDate && a.startDate > from ? (a.startDate > to ? to : a.startDate) : from;
  if (a.today > to) return { expected: a.qty || null, needPerDay: null, forecast: a.factTotal, daysLeft: 0, behind: false };
  const activeDays = daysBetween(start, to) + 1;
  const firstLeft = a.today > start ? a.today : start;
  const daysLeft = daysBetween(firstLeft, to) + 1;
  const elapsed = Math.max(0, activeDays - daysLeft);
  const expected = a.qty > 0 ? (a.qty * elapsed) / activeDays : null;
  const needPerDay = a.qty > 0 ? Math.max(0, a.qty - a.factToYesterday) / daysLeft : null;
  const forecast = a.today < from && !a.factTotal ? null : a.factToYesterday + (a.pace7 ?? 0) * daysLeft;
  const behind = needPerDay !== null && needPerDay > 0 && a.today >= start && elapsed > 0 && (a.pace7 ?? 0) < needPerDay;
  return { expected, needPerDay, forecast, daysLeft, behind };
}

export const pctOf = (fact: number, plan: number): number | null => (plan > 0 ? (fact / plan) * 100 : null);
