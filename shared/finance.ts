/**
 * Раздел «Финансы» (19.11.2026) — платёжный календарь, инвесторы и кредиты вместо
 * Google-таблицы «Платежный календарь 2026–2027». Типы и чистые расчёты, общие для
 * сервера, экрана и проверок (scripts/check-finance.ts).
 *
 * Главное правило остатка (с 18.11.2026, как в таблице):
 *   остаток на день = остаток на счетах (из финучёта, на «дату остатка»)
 *                    + все НЕ исполненные приходы − НЕ исполненные расходы до этого дня.
 * «Исполнено» в прогноз не входит: эти деньги уже в остатке финучёта.
 * Не исполненное с прошедшей датой считается «на дату остатка» (как будто случится сегодня).
 * «Отменено» и «Перенесено» не считаются нигде.
 */

export type OpType = 'in' | 'out';
export const OP_STATUSES = ['План', 'Прогноз', 'Подтверждено', 'Исполнено', 'Перенесено', 'Отменено'] as const;
export type OpStatus = typeof OP_STATUSES[number];

export type FinOp = {
  id: number;
  /** YYYY-MM-DD */
  date: string;
  type: OpType;
  cat: string;
  descr: string;
  plan: number;
  fact: number | null;
  status: OpStatus;
  account: string;
  /** Кто внёс: «Агент: кредиты», «Старый календарь», имя сотрудника. */
  source: string;
  resp: string;
  comment: string;
  /** Ключ агента: K-1#7, INV-020#body, OZ#2026-12-16… null — строка внесена вручную. */
  key: string | null;
  updatedAt?: string;
  updatedBy?: string;
  /** Товары закупки (21.11): артикул и штуки. Сумма от них не считается — её пишут руками. */
  items?: OpItem[];
};
/** Товар в строке закупки: артикул «Склада», название для показа, штук. */
export type OpItem = { article: string; name: string; qty: number };
/** Строка — закупка товара (по статье): у неё в окне появляется блок «Товары». */
export const isPurchaseOp = (o: { type: string; cat: string }) => o.type === 'out' && /закупк/i.test(o.cat);
/** «S2000 PRO × 60 · Ultra2 Круглый × 400» — подпись под описанием в календаре. */
export const itemsLabel = (items: OpItem[] | undefined) => (items ?? []).map(i => `${i.name || i.article} × ${i.qty}`).join(' · ');

export type FinSettings = { balance: number; balanceDate: string; minBalance: number };

export type DealMode = 'Ежемесячно' | 'В конце срока';
export type DealStatus = 'Действует' | 'Возвращён' | 'Пролонгирован';
export type InvestorDeal = {
  id: string; person: string; name: string; start: string; amount: number;
  /** % годовых, например 18 */
  rate: number; term: number; mode: DealMode; status: DealStatus; fromId: string | null; comment: string;
};
export type MoveKind = 'Вклад получен' | 'Проценты' | 'Возврат тела';
export type InvestorMove = { id: number; date: string; dealId: string; kind: MoveKind; amount: number; comment: string; source: string };

export type Loan = {
  id: string; lender: string; contract: string; purpose: string; issued: string; amount: number; received: number;
  price: string; term: string; how: string; payment: number; debt: number; lastDate: string; status: 'Действует' | 'Погашен'; comment: string;
};

// ─── даты ──────────────────────────────────────────────────────────────────
const DAY = 86_400_000;
export const dayNum = (d: string) => Math.round(Date.parse(d + 'T00:00:00Z') / DAY);
export const dayStr = (n: number) => new Date(n * DAY).toISOString().slice(0, 10);
export const mskToday = () => new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10);
export const monthOf = (d: string) => d.slice(0, 7);
export const shiftMonth = (m: string, k: number) => { const y = Number(m.slice(0, 4)), mm = Number(m.slice(5, 7)) - 1 + k; const t = new Date(Date.UTC(y, mm, 1)); return t.toISOString().slice(0, 7); };
export const addMonths = (d: string, k: number) => {
  const y = Number(d.slice(0, 4)), m = Number(d.slice(5, 7)) - 1 + k, dd = Number(d.slice(8, 10));
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(dd, last))).toISOString().slice(0, 10);
};
export const monthDays = (m: string) => { const y = Number(m.slice(0, 4)), mm = Number(m.slice(5, 7)); const n = new Date(Date.UTC(y, mm, 0)).getUTCDate(); return Array.from({ length: n }, (_, i) => `${m}-${String(i + 1).padStart(2, '0')}`); };
export const isDate = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));

// ─── суммы ─────────────────────────────────────────────────────────────────
const DEAD = (s: OpStatus) => s === 'Отменено' || s === 'Перенесено';
/** Сумма строки для итогов месяца: исполненная — по факту (если указан), иначе — план. */
export function opAmount(o: Pick<FinOp, 'plan' | 'fact' | 'status'>): number {
  if (DEAD(o.status)) return 0;
  return o.status === 'Исполнено' && o.fact !== null ? o.fact : o.plan;
}
/** День, в который строка войдёт в прогноз остатка, или null — не входит. */
export function cashDay(o: Pick<FinOp, 'date' | 'plan' | 'status'>, balanceDate: string): string | null {
  if (DEAD(o.status) || o.status === 'Исполнено' || !o.plan) return null;
  return o.date < balanceDate ? balanceDate : o.date;
}

export type DayCash = { date: string; in: number; out: number; end: number };
/** Остаток на конец каждого дня от даты остатка до `until` включительно. */
export function dailyCash(ops: FinOp[], s: FinSettings, until: string): DayCash[] {
  const inn = new Map<string, number>(), out = new Map<string, number>();
  for (const o of ops) {
    const d = cashDay(o, s.balanceDate); if (!d || d > until) continue;
    const m = o.type === 'in' ? inn : out; m.set(d, (m.get(d) ?? 0) + o.plan);
  }
  const res: DayCash[] = []; let bal = s.balance;
  for (let n = dayNum(s.balanceDate); n <= dayNum(until); n++) {
    const d = dayStr(n), i = inn.get(d) ?? 0, x = out.get(d) ?? 0; bal += i - x;
    res.push({ date: d, in: i, out: x, end: Math.round(bal * 100) / 100 });
  }
  return res;
}

export type Signal = 'gap' | 'low' | 'ok';
export const signalOf = (bal: number, min: number): Signal => (bal < 0 ? 'gap' : bal < min ? 'low' : 'ok');

// ─── месяц ─────────────────────────────────────────────────────────────────
export type MonthDay = { date: string; ops: FinOp[]; in: number; out: number; end: number | null; signal: Signal | null };
export type MonthTotals = { month: string; in: number; out: number; net: number; end: number | null; min: number | null; minDate: string | null; signal: Signal | null };
export type MonthView = { month: string; days: MonthDay[]; totals: MonthTotals; settings: FinSettings; today: string };

export function monthTotals(month: string, ops: FinOp[], cash: Map<string, DayCash>, s: FinSettings): MonthTotals {
  let inn = 0, out = 0;
  for (const o of ops) if (monthOf(o.date) === month) { const a = opAmount(o); if (o.type === 'in') inn += a; else out += a; }
  const days = monthDays(month); const last = cash.get(days[days.length - 1]) ?? null;
  let min: number | null = null, minDate: string | null = null;
  for (const d of days) { const c = cash.get(d); if (c && (min === null || c.end < min)) { min = c.end; minDate = d; } }
  return { month, in: inn, out, net: inn - out, end: last ? last.end : null, min, minDate, signal: min === null ? null : signalOf(min, s.minBalance) };
}

export function monthView(month: string, ops: FinOp[], s: FinSettings, today: string): MonthView {
  const days = monthDays(month);
  const cash = new Map(dailyCash(ops, s, days[days.length - 1] < s.balanceDate ? s.balanceDate : days[days.length - 1]).map(c => [c.date, c]));
  const byDay = new Map<string, FinOp[]>();
  for (const o of ops) if (monthOf(o.date) === month) { if (!byDay.has(o.date)) byDay.set(o.date, []); byDay.get(o.date)!.push(o); }
  const list: MonthDay[] = days.map(d => {
    const dayOps = (byDay.get(d) ?? []).sort((a, b) => (a.type === b.type ? a.id - b.id : a.type === 'in' ? -1 : 1));
    let inn = 0, out = 0; for (const o of dayOps) { const a = opAmount(o); if (o.type === 'in') inn += a; else out += a; }
    const c = cash.get(d);
    return { date: d, ops: dayOps, in: inn, out, end: c ? c.end : null, signal: c ? signalOf(c.end, s.minBalance) : null };
  });
  return { month, days: list, totals: monthTotals(month, ops, cash, s), settings: s, today };
}

// ─── инвесторы ─────────────────────────────────────────────────────────────
export type DealCalc = InvestorDeal & {
  end: string; paidInt: number; returned: number; remBody: number; totalInt: number; remInt: number; owed: number; monthly: number;
  moves: InvestorMove[];
};
export function dealCalc(d: InvestorDeal, moves: InvestorMove[]): DealCalc {
  const my = moves.filter(m => m.dealId === d.id).sort((a, b) => (a.date < b.date ? -1 : 1));
  const paidInt = my.filter(m => m.kind === 'Проценты').reduce((s, m) => s + m.amount, 0);
  const returned = my.filter(m => m.kind === 'Возврат тела').reduce((s, m) => s + m.amount, 0);
  const closed = d.status !== 'Действует';
  const totalInt = Math.round(d.amount * d.rate / 100 * d.term / 12);
  const remBody = closed ? 0 : Math.max(0, d.amount - returned);
  const remInt = closed ? 0 : Math.max(0, totalInt - paidInt);
  return { ...d, end: addMonths(d.start, d.term), paidInt, returned, remBody, totalInt, remInt, owed: remBody + remInt,
    monthly: d.mode === 'Ежемесячно' ? Math.round(d.amount * d.rate / 100 / 12) : 0, moves: my };
}

export type NewOp = Omit<FinOp, 'id'>;
/** Будущие выплаты по вкладу для календаря (ключи `${id}#…`). */
export function investorSchedule(c: DealCalc, today: string): NewOp[] {
  if (c.status !== 'Действует') return [];
  const base = `${c.person} · ${c.name} (${c.id})`;
  const due = c.end < today ? today : c.end;
  const overdue = c.end < today ? 'срок вклада прошёл — вернуть или продлить; ' : '';
  const mk = (date: string, cat: string, descr: string, plan: number, comment: string, key: string): NewOp =>
    ({ date, type: 'out', cat, descr, plan, fact: null, status: 'План', account: '', source: 'Агент: инвесторы', resp: 'Александр', comment, key });
  const out: NewOp[] = [];
  if (c.mode === 'Ежемесячно') {
    let left = c.remInt;
    const from = c.start > today ? c.start : today;
    for (let d = shiftMonth(monthOf(from), 1) + '-01'; d < c.end && left > 0.5; d = addMonths(d, 1)) {
      const s = Math.min(c.monthly, left); left -= s; out.push(mk(d, 'Инвестор — проценты', base + ' · проценты за месяц', s, 'ежемесячно, обычно 1–5 числа', `${c.id}#%${monthOf(d)}`));
    }
    if (left > 0.5) out.push(mk(due, 'Инвестор — проценты', base + ' · остаток процентов', Math.round(left), overdue + 'вместе с возвратом тела', `${c.id}#%end`));
  } else if (c.remInt > 0) out.push(mk(due, 'Инвестор — проценты', base + ' · проценты за весь срок', Math.round(c.remInt), overdue + `${c.rate}% годовых, ${c.term} мес.`, `${c.id}#%end`));
  if (c.remBody > 0) out.push(mk(due, 'Инвестор — возврат тела', base + ' · возврат вклада', c.remBody, overdue + 'можно продлить: «Инвесторы» → «Пролонгировать»', `${c.id}#body`));
  return out;
}

export type InvestorTotals = { active: number; body: number; remInt: number; owed: number; monthly: number; due60: number };
export function investorTotals(list: DealCalc[], today: string): InvestorTotals {
  const act = list.filter(d => d.status === 'Действует'); const lim = dayStr(dayNum(today) + 60);
  return { active: act.length, body: act.reduce((s, d) => s + d.remBody, 0), remInt: act.reduce((s, d) => s + d.remInt, 0),
    owed: act.reduce((s, d) => s + d.owed, 0), monthly: act.reduce((s, d) => s + d.monthly, 0), due60: act.filter(d => d.end <= lim).reduce((s, d) => s + d.owed, 0) };
}

// ─── кредиты ───────────────────────────────────────────────────────────────
export type LoanCalc = Loan & { paidCount: number; paidSum: number; leftCount: number; leftSum: number; next: FinOp | null; schedule: FinOp[] };
export function loanCalc(l: Loan, ops: FinOp[]): LoanCalc {
  const sch = ops.filter(o => o.key?.startsWith(l.id + '#') && o.status !== 'Отменено').sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id));
  const paid = sch.filter(o => o.status === 'Исполнено'), left = sch.filter(o => o.status !== 'Исполнено' && o.status !== 'Перенесено');
  return { ...l, paidCount: paid.length, paidSum: paid.reduce((s, o) => s + opAmount(o), 0), leftCount: left.length, leftSum: left.reduce((s, o) => s + o.plan, 0), next: left[0] ?? null, schedule: sch };
}
/** Равные платежи по графику: раз в неделю или раз в месяц. */
export function loanSchedule(loanId: string, title: string, first: string, count: number, payment: number, every: 'week' | 'month', account: string): NewOp[] {
  return Array.from({ length: count }, (_, i) => ({
    date: every === 'week' ? dayStr(dayNum(first) + 7 * i) : addMonths(first, i), type: 'out' as const, cat: 'Кредит — платёж', descr: `${title} · платёж ${i + 1} из ${count}`,
    plan: payment, fact: null, status: 'План' as const, account, source: 'Агент: кредиты', resp: '', comment: '', key: `${loanId}#${i + 1}`,
  }));
}

// ─── сводка ────────────────────────────────────────────────────────────────
export type FinSummary = {
  settings: FinSettings; today: string; months: MonthTotals[]; series: DayCash[];
  gaps: DayCash[]; firstGap: string | null; minNext30: DayCash | null;
  investors: InvestorTotals; loansLeft: number; loansNext30: number;
};
export function summary(ops: FinOp[], s: FinSettings, deals: DealCalc[], today: string, lastMonth: string): FinSummary {
  const firstMonth = ops.reduce((m, o) => (o.date < m ? o.date : m), s.balanceDate).slice(0, 7);
  const until = monthDays(lastMonth).slice(-1)[0];
  const cash = dailyCash(ops, s, until); const map = new Map(cash.map(c => [c.date, c]));
  const months: MonthTotals[] = []; for (let m = firstMonth; m <= lastMonth; m = shiftMonth(m, 1)) months.push(monthTotals(m, ops, map, s));
  const in30 = cash.filter(c => c.date >= today && c.date <= dayStr(dayNum(today) + 30));
  const loanOps = ops.filter(o => o.key && /^K-\d+#/.test(o.key) && cashDay(o, s.balanceDate));
  return {
    settings: s, today, months, series: cash.filter(c => c.date <= dayStr(dayNum(today) + 75)),
    gaps: cash.filter(c => c.end < 0 && c.date >= today).slice(0, 15), firstGap: cash.find(c => c.end < 0 && c.date >= today)?.date ?? null,
    minNext30: in30.reduce<DayCash | null>((a, c) => (!a || c.end < a.end ? c : a), null),
    investors: investorTotals(deals, today),
    loansLeft: loanOps.reduce((x, o) => x + o.plan, 0),
    loansNext30: loanOps.filter(o => (cashDay(o, s.balanceDate) ?? '') <= dayStr(dayNum(today) + 30)).reduce((x, o) => x + o.plan, 0),
  };
}

export const FIN_CATEGORIES_IN = ['Выплата Ozon', 'Выплата Wildberries', 'Выплата WB Global', 'Офлайн продажи', 'Инвестор — вклад получен', 'Кредит получен', 'Прочий приход'];
