/**
 * «Финансы» (19.11.2026) — платёжный календарь, инвесторы и кредиты на сайте вместо
 * Google-таблицы «Платежный календарь 2026–2027». Только владелец (permissions.ts).
 *
 * Хранилище — своя база .av-cache/finance.sqlite (node:sqlite, как activity.ts).
 * Каждое изменение пишется в журнал fin_log: кто, когда, что было и что стало.
 * Расчёты (остаток по дням, итоги месяца, инвесторы, кредиты) — в shared/finance.ts.
 *
 *   GET  /api/finance/summary                → сводка
 *   GET  /api/finance/month?m=YYYY-MM        → месяц календаря по дням
 *   GET  /api/finance/meta                   → статьи, счета, настройки
 *   POST /api/finance/op                     → создать/изменить строку { op }
 *   POST /api/finance/op/delete              → удалить строку { id }
 *   POST /api/finance/settings               → остаток, дата остатка, порог
 *   GET  /api/finance/investors              → вклады с расчётом и движениями
 *   POST /api/finance/investors/deal         → новый вклад / правка { deal }
 *   POST /api/finance/investors/move         → выплата %, возврат тела, получение вклада { move }
 *   POST /api/finance/investors/prolong      → пролонгация { id, start, amount, rate, term, mode, name }
 *   GET  /api/finance/loans                  → кредиты с графиками
 *   POST /api/finance/loans                  → новый кредит / правка { loan, schedule? }
 *   POST /api/finance/import                 → перенос из выгрузки Google-таблицы (один раз; только в пустую базу)
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  OP_STATUSES, dealCalc, investorSchedule, isDate, loanCalc, loanSchedule, monthView, mskToday, summary,
  addMonths, dayNum, dayStr,
  type DealCalc, type FinOp, type FinSettings, type InvestorDeal, type InvestorMove, type Loan, type MoveKind, type NewOp, type OpItem, type OpStatus,
} from '../../shared/finance';

let DatabaseSync: any = null;
try { DatabaseSync = require('node:sqlite').DatabaseSync; } catch { DatabaseSync = null; }

let db: any = null;
export function finDb(): any {
  if (db) return db;
  if (!DatabaseSync) throw new Error('База финансов недоступна на сервере (нужен Node 22.5+)');
  const dir = process.env.CACHE_DIR || join(process.cwd(), '.av-cache');
  mkdirSync(dir, { recursive: true });
  db = new DatabaseSync(join(dir, 'finance.sqlite'));
  db.exec(`
    PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS fin_op (
      id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, type TEXT NOT NULL, cat TEXT NOT NULL DEFAULT '', descr TEXT NOT NULL DEFAULT '',
      plan REAL NOT NULL DEFAULT 0, fact REAL, status TEXT NOT NULL DEFAULT 'План', account TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT '',
      resp TEXT NOT NULL DEFAULT '', comment TEXT NOT NULL DEFAULT '', key TEXT UNIQUE, updated_at TEXT NOT NULL DEFAULT '', updated_by TEXT NOT NULL DEFAULT '');
    CREATE INDEX IF NOT EXISTS fin_op_date ON fin_op(date);
    CREATE TABLE IF NOT EXISTS fin_setting (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS fin_list (kind TEXT NOT NULL, name TEXT NOT NULL, extra TEXT NOT NULL DEFAULT '', PRIMARY KEY (kind, name));
    CREATE TABLE IF NOT EXISTS fin_deal (
      id TEXT PRIMARY KEY, person TEXT NOT NULL, name TEXT NOT NULL, start TEXT NOT NULL, amount REAL NOT NULL, rate REAL NOT NULL, term INTEGER NOT NULL,
      mode TEXT NOT NULL, status TEXT NOT NULL, from_id TEXT, comment TEXT NOT NULL DEFAULT '');
    CREATE TABLE IF NOT EXISTS fin_move (
      id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, deal_id TEXT NOT NULL, kind TEXT NOT NULL, amount REAL NOT NULL,
      comment TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT '');
    CREATE INDEX IF NOT EXISTS fin_move_deal ON fin_move(deal_id);
    CREATE TABLE IF NOT EXISTS fin_loan (
      id TEXT PRIMARY KEY, lender TEXT NOT NULL, contract TEXT NOT NULL DEFAULT '', purpose TEXT NOT NULL DEFAULT '', issued TEXT NOT NULL DEFAULT '',
      amount REAL NOT NULL DEFAULT 0, received REAL NOT NULL DEFAULT 0, price TEXT NOT NULL DEFAULT '', term TEXT NOT NULL DEFAULT '', how TEXT NOT NULL DEFAULT '',
      payment REAL NOT NULL DEFAULT 0, debt REAL NOT NULL DEFAULT 0, last_date TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'Действует', comment TEXT NOT NULL DEFAULT '');
    CREATE TABLE IF NOT EXISTS fin_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, who TEXT NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL);
    -- товары строки закупки (21.11): артикул и штуки; столбцов календаря не добавляем
    CREATE TABLE IF NOT EXISTS fin_op_item (op_id INTEGER NOT NULL, pos INTEGER NOT NULL, article TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', qty INTEGER NOT NULL,
      PRIMARY KEY (op_id, pos));
  `);
  return db;
}
/** Только для проверок. */
export function closeFinDb(): void { if (db) { try { db.close(); } catch (e) { console.warn('[finance] база не закрылась:', (e as Error).message); } db = null; } }

const now = () => new Date().toISOString();
function log(who: string, action: string, detail: unknown) {
  finDb().prepare('INSERT INTO fin_log (ts, who, action, detail) VALUES (?, ?, ?, ?)').run(now(), who, action, JSON.stringify(detail).slice(0, 4000));
}
let depth = 0;
/** Транзакция; вложенный вызов работает внутри внешней. */
const tx = <T>(fn: () => T): T => {
  if (depth > 0) { depth++; try { return fn(); } finally { depth--; } }
  const d = finDb(); d.exec('BEGIN'); depth = 1;
  try { const r = fn(); d.exec('COMMIT'); return r; } catch (e) { d.exec('ROLLBACK'); throw e; } finally { depth = 0; }
};
const loanParams = (l: Loan) => ({ id: l.id, lender: l.lender, contract: l.contract, purpose: l.purpose, issued: l.issued, amount: l.amount, received: l.received, price: l.price,
  term: l.term, how: l.how, payment: l.payment, debt: l.debt, last_date: l.lastDate, status: l.status, comment: l.comment });

// ─── чтение ────────────────────────────────────────────────────────────────
const rowOp = (r: any): FinOp => ({ id: r.id, date: r.date, type: r.type, cat: r.cat, descr: r.descr, plan: r.plan, fact: r.fact, status: r.status, account: r.account,
  source: r.source, resp: r.resp, comment: r.comment, key: r.key, updatedAt: r.updated_at, updatedBy: r.updated_by });
function itemsByOp(opId?: number): Map<number, OpItem[]> {
  const rows = (opId === undefined ? finDb().prepare('SELECT * FROM fin_op_item ORDER BY op_id, pos').all()
    : finDb().prepare('SELECT * FROM fin_op_item WHERE op_id = ? ORDER BY pos').all(opId)) as Array<{ op_id: number; article: string; name: string; qty: number }>;
  const m = new Map<number, OpItem[]>();
  for (const r of rows) { const l = m.get(r.op_id) ?? []; l.push({ article: r.article, name: r.name, qty: r.qty }); m.set(r.op_id, l); }
  return m;
}
const withItems = (o: FinOp, m: Map<number, OpItem[]>): FinOp => { const it = m.get(o.id); return it ? { ...o, items: it } : o; };
export const allOps = (): FinOp[] => { const m = itemsByOp(); return finDb().prepare('SELECT * FROM fin_op ORDER BY date, id').all().map(rowOp).map((o: FinOp) => withItems(o, m)); };
const oneOp = (id: number | bigint): FinOp => { const o = rowOp(finDb().prepare('SELECT * FROM fin_op WHERE id = ?').get(id)); return withItems(o, itemsByOp(o.id)); };

export function getSettings(): FinSettings {
  const m = new Map<string, string>(finDb().prepare('SELECT k, v FROM fin_setting').all().map((r: any) => [r.k, r.v]));
  return { balance: Number(m.get('balance') ?? 0), balanceDate: m.get('balanceDate') ?? mskToday(), minBalance: Number(m.get('minBalance') ?? 1_000_000) };
}
export function setSettings(p: Partial<FinSettings>, who: string): FinSettings {
  const cur = getSettings(); const next = { ...cur };
  if (p.balance !== undefined) { if (!Number.isFinite(Number(p.balance))) throw new Error('остаток — не число'); next.balance = Number(p.balance); }
  if (p.balanceDate !== undefined) { if (!isDate(p.balanceDate)) throw new Error('дата остатка — не дата'); next.balanceDate = p.balanceDate; }
  if (p.minBalance !== undefined) { if (!Number.isFinite(Number(p.minBalance))) throw new Error('порог — не число'); next.minBalance = Number(p.minBalance); }
  const st = finDb().prepare('INSERT INTO fin_setting (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v');
  tx(() => {
    st.run('balance', String(next.balance)); st.run('balanceDate', next.balanceDate); st.run('minBalance', String(next.minBalance));
    if (p.balance !== undefined) st.run('balanceAt', now());   // когда остаток последний раз сверяли (агент, кнопка, раз в час)
  });
  log(who, 'settings', { from: cur, to: next });
  return next;
}

/**
 * Остаток на счетах из финучёта (21.11): лист «ДДС», строка «Остаток на конец периода в рублях» (та же, что берёт агент).
 * Кнопка «Обновить» у остатка и раз в час по сетке (SLOTS.finBalance в server.ts). Таблица — только чтение.
 */
const FIN_LEDGER_ID = process.env.FIN_LEDGER_SHEET_ID || '1yedJFus6SQKp1J3AkXUxM6pTskHtmLo18yyQjIGADjk';
let balanceBusy: Promise<unknown> | null = null;
export function balanceAt(): string | null {
  const r = finDb().prepare(`SELECT v FROM fin_setting WHERE k = 'balanceAt'`).get() as { v: string } | undefined;
  return r?.v ?? null;
}
export async function refreshBalance(who: string): Promise<{ settings: FinSettings; at: string; changed: boolean }> {
  if (balanceBusy) await balanceBusy.catch(() => undefined);
  const job = (async () => {
    const { readSheetRange } = await import('./googleSheetsApi');
    const rows = await readSheetRange(FIN_LEDGER_ID, 'ДДС!A1:B10');
    const row = rows.find(r => /Остаток на конец периода в рублях/i.test(String(r?.[0] ?? '')));
    const raw = row?.[1];
    const bal = typeof raw === 'number' ? raw : Number(String(raw ?? '').replace(/[\s ₽]/g, '').replace(',', '.'));
    if (!row || !Number.isFinite(bal) || bal === 0) throw new Error('в финучёте не нашёл остаток (лист «ДДС», «Остаток на конец периода в рублях»)');
    const cur = getSettings(); const today = mskToday(); const value = Math.round(bal);
    const changed = cur.balance !== value || cur.balanceDate !== today;
    const settings = changed ? setSettings({ balance: value, balanceDate: today }, who) : cur;
    const at = now();
    finDb().prepare(`INSERT INTO fin_setting (k, v) VALUES ('balanceAt', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`).run(at);
    return { settings, at, changed };
  })();
  balanceBusy = job;
  try { return await job; } finally { if (balanceBusy === job) balanceBusy = null; }
}

const rowDeal = (r: any): InvestorDeal => ({ id: r.id, person: r.person, name: r.name, start: r.start, amount: r.amount, rate: r.rate, term: r.term, mode: r.mode, status: r.status, fromId: r.from_id, comment: r.comment });
const rowMove = (r: any): InvestorMove => ({ id: r.id, date: r.date, dealId: r.deal_id, kind: r.kind, amount: r.amount, comment: r.comment, source: r.source });
export function dealsCalc(): DealCalc[] {
  const moves = finDb().prepare('SELECT * FROM fin_move ORDER BY date, id').all().map(rowMove);
  return finDb().prepare('SELECT * FROM fin_deal ORDER BY id').all().map(rowDeal).map((d: InvestorDeal) => dealCalc(d, moves));
}
const rowLoan = (r: any): Loan => ({ id: r.id, lender: r.lender, contract: r.contract, purpose: r.purpose, issued: r.issued, amount: r.amount, received: r.received, price: r.price,
  term: r.term, how: r.how, payment: r.payment, debt: r.debt, lastDate: r.last_date, status: r.status, comment: r.comment });

export function meta() {
  const lists = finDb().prepare('SELECT kind, name, extra FROM fin_list ORDER BY kind, rowid').all() as Array<{ kind: string; name: string; extra: string }>;
  return {
    settings: getSettings(), balanceAt: balanceAt(), today: mskToday(), statuses: OP_STATUSES,
    categories: lists.filter(l => l.kind === 'cat').map(l => ({ name: l.name, type: l.extra === 'in' ? 'in' : 'out' })),
    accounts: lists.filter(l => l.kind === 'account').map(l => l.name),
    people: lists.filter(l => l.kind === 'person').map(l => l.name),
    parties: lists.filter(l => l.kind === 'party').map(l => l.name),
    lastMonth: lastMonth(),
  };
}
function lastMonth(): string {
  const r = finDb().prepare('SELECT MAX(date) AS d FROM fin_op').get() as { d: string | null };
  const m = (r?.d ?? mskToday()).slice(0, 7); return m < '2027-12' ? '2027-12' : m;
}

// ─── строки календаря ──────────────────────────────────────────────────────
function cleanOp(o: any): Omit<FinOp, 'id'> {
  if (!isDate(o?.date)) throw new Error('укажите дату');
  if (o.type !== 'in' && o.type !== 'out') throw new Error('приход или расход?');
  const plan = Number(o.plan); if (!Number.isFinite(plan) || plan < 0) throw new Error('сумма — не число');
  const fact = o.fact === null || o.fact === undefined || o.fact === '' ? null : Number(o.fact);
  if (fact !== null && !Number.isFinite(fact)) throw new Error('факт — не число');
  if (!(OP_STATUSES as readonly string[]).includes(o.status)) throw new Error('неизвестный статус');
  if (!String(o.cat ?? '').trim() && !String(o.descr ?? '').trim()) throw new Error('укажите статью или описание');
  const s = (v: unknown, n = 500) => String(v ?? '').trim().slice(0, n);
  return { date: o.date, type: o.type, cat: s(o.cat, 120), descr: s(o.descr), plan: Math.round(plan * 100) / 100, fact: fact === null ? null : Math.round(fact * 100) / 100,
    status: o.status as OpStatus, account: s(o.account, 120), source: s(o.source, 120), resp: s(o.resp, 120), comment: s(o.comment, 1000), key: o.key ? s(o.key, 120) : null };
}
const INS = `INSERT INTO fin_op (date, type, cat, descr, plan, fact, status, account, source, resp, comment, key, updated_at, updated_by)
             VALUES (@date, @type, @cat, @descr, @plan, @fact, @status, @account, @source, @resp, @comment, @key, @updated_at, @updated_by)`;
const params = (o: Omit<FinOp, 'id'>, who: string) => ({ date: o.date, type: o.type, cat: o.cat, descr: o.descr, plan: o.plan, fact: o.fact, status: o.status, account: o.account,
  source: o.source, resp: o.resp, comment: o.comment, key: o.key, updated_at: now(), updated_by: who });

/** Товары строки: массив {article, name?, qty}. null — не трогать (агент и старые клиенты шлют строку без товаров). */
function cleanItems(v: unknown): OpItem[] | null {
  if (!Array.isArray(v)) return null;
  const out: OpItem[] = [];
  for (const x of v.slice(0, 50)) {
    const article = String((x as any)?.article ?? '').trim().slice(0, 120); if (!article) continue;
    const qty = Math.round(Number((x as any)?.qty));
    if (!(qty > 0 && qty < 10_000_000)) throw new Error(`штук у «${article}» — целое число больше нуля`);
    out.push({ article, name: String((x as any)?.name ?? '').trim().slice(0, 200), qty });
  }
  return out;
}
function writeItems(opId: number, items: OpItem[]) {
  finDb().prepare('DELETE FROM fin_op_item WHERE op_id = ?').run(opId);
  const st = finDb().prepare('INSERT INTO fin_op_item (op_id, pos, article, name, qty) VALUES (?, ?, ?, ?, ?)');
  items.forEach((it, i) => st.run(opId, i, it.article, it.name, it.qty));
}

export function saveOp(body: any, who: string): FinOp {
  const id = Number(body?.id) || 0;
  const o = cleanOp(body);
  const items = cleanItems(body?.items);
  rememberNames(o);
  if (!id) {
    if (!o.source) o.source = who;
    const saved = tx(() => { const r = finDb().prepare(INS).run(params(o, who)); if (items?.length) writeItems(Number(r.lastInsertRowid), items); return oneOp(r.lastInsertRowid); });
    log(who, 'op.add', saved); return saved;
  }
  const old = finDb().prepare('SELECT * FROM fin_op WHERE id = ?').get(id); if (!old) throw new Error('строка уже удалена — обновите страницу');
  const oldOp = oneOp(id);
  o.key = old.key; o.source = old.source || o.source;   // ключ агента и «кто внёс» не меняются из интерфейса
  const saved = tx(() => {
    finDb().prepare(`UPDATE fin_op SET date=@date, type=@type, cat=@cat, descr=@descr, plan=@plan, fact=@fact, status=@status, account=@account, source=@source,
      resp=@resp, comment=@comment, key=@key, updated_at=@updated_at, updated_by=@updated_by WHERE id=@id`).run({ ...params(o, who), id });
    if (items) writeItems(id, items);
    return oneOp(id);
  });
  log(who, 'op.edit', { from: oldOp, to: saved }); return saved;
}
export function deleteOp(id: number, who: string): void {
  const old = finDb().prepare('SELECT * FROM fin_op WHERE id = ?').get(id); if (!old) return;
  const was = oneOp(id);
  tx(() => { finDb().prepare('DELETE FROM fin_op_item WHERE op_id = ?').run(id); finDb().prepare('DELETE FROM fin_op WHERE id = ?').run(id); });
  log(who, 'op.delete', was);
}

/**
 * Копировать / переместить выбранные строки (21.11, как в Google-таблице).
 * Куда: точная дата `to` или сдвиг от даты каждой строки `shift` = 'week' | 'month' (то же число).
 * Копия — статус «План», без факта и без ключа агента, товары закупки копируются.
 * Перенос меняет только дату (статус и ключ остаются).
 */
export function copyOps(body: any, who: string): { ops: FinOp[]; dates: string[] } {
  const ids = (Array.isArray(body?.ids) ? body.ids : []).map(Number).filter((n: number) => n > 0);
  if (!ids.length) throw new Error('не выбрано ни одной строки');
  if (ids.length > 300) throw new Error('за раз — не больше 300 строк');
  const shift = body?.shift === 'week' || body?.shift === 'month' ? body.shift : null;
  if (!shift && !isDate(body?.to)) throw new Error('укажите дату');
  const move = body?.mode === 'move';
  const target = (d: string) => (shift === 'week' ? dayStr(dayNum(d) + 7) : shift === 'month' ? addMonths(d, 1) : String(body.to));
  const out: FinOp[] = [];
  tx(() => {
    for (const id of ids) {
      const src = finDb().prepare('SELECT * FROM fin_op WHERE id = ?').get(id); if (!src) throw new Error('строка уже удалена — обновите страницу');
      const s = oneOp(id); const date = target(s.date);
      if (move) {
        finDb().prepare('UPDATE fin_op SET date = ?, updated_at = ?, updated_by = ? WHERE id = ?').run(date, now(), who, id);
        out.push(oneOp(id));
      } else {
        const r = finDb().prepare(INS).run(params({ ...s, date, status: 'План', fact: null, key: null, source: who }, who));
        if (s.items?.length) writeItems(Number(r.lastInsertRowid), s.items);
        out.push(oneOp(r.lastInsertRowid));
      }
    }
  });
  log(who, move ? 'op.move' : 'op.copy', { ids, to: body?.to ?? null, shift, result: out.map(o => ({ id: o.id, date: o.date })) });
  return { ops: out, dates: [...new Set(out.map(o => o.date))].sort() };
}

/**
 * Для раздела «Закупки» (21.11): строки закупки с товарами.
 *  • open — не оплаченные (не «Исполнено» / «Отменено» / «Перенесено»): партия придёт через срок доставки после даты оплаты;
 *  • paid — «Исполнено» за последние `days` дней (по дате строки): товар уже заказан, пока не появится в «В доставке» или в трекере.
 * Строки без товаров сюда не попадают — «Закупки» понимают их по тексту (shared/purchase.ts).
 */
export type PurchaseOpItems = { opId: number; date: string; status: OpStatus; paid: boolean; plan: number; fact: number | null; cat: string; descr: string; comment: string; items: OpItem[] };
export function purchaseItems(today = mskToday(), days = 60): PurchaseOpItems[] {
  const from = dayStr(dayNum(today) - days);
  return allOps()
    .filter(o => o.items?.length && o.status !== 'Отменено' && o.status !== 'Перенесено' && (o.status !== 'Исполнено' || o.date >= from))
    .map(o => ({ opId: o.id, date: o.date, status: o.status, paid: o.status === 'Исполнено', plan: o.plan, fact: o.fact, cat: o.cat, descr: o.descr, comment: o.comment, items: o.items! }));
}

/** Каталог для поиска товара в окне закупки: артикулы таблицы «Склад» + уже встречавшиеся в закупках. */
async function catalog(): Promise<{ items: Array<{ article: string; name: string }>; error?: string }> {
  const seen = new Map<string, string>();
  for (const r of finDb().prepare('SELECT article, name FROM fin_op_item ORDER BY rowid DESC').all() as Array<{ article: string; name: string }>) if (!seen.has(r.article)) seen.set(r.article, r.name);
  let error: string | undefined;
  try {
    const { getStockSheet } = await import('./stockSheet');
    const sh = await getStockSheet();
    if (sh.error) error = sh.error;
    for (const a of Object.keys(sh.items)) if (!seen.has(a)) seen.set(a, '');
  } catch (e) { error = (e as Error).message; console.warn('[finance] каталог «Склада» не прочитан:', error); }
  return { items: [...seen.entries()].map(([article, name]) => ({ article, name })).sort((a, b) => a.article.localeCompare(b.article)), error };
}
function insertOps(list: NewOp[], who: string) { const st = finDb().prepare(INS); for (const o of list) st.run(params(o, who)); }

// ─── инвесторы ─────────────────────────────────────────────────────────────
/** Пересобрать будущие строки вклада: неисполненные строки с ключом `${id}#` заменяются новым графиком. */
function rebuildDealOps(id: string, who: string) {
  finDb().prepare(`DELETE FROM fin_op WHERE key LIKE ? AND status NOT IN ('Исполнено')`).run(`${id}#%`);
  const c = dealsCalc().find(d => d.id === id); if (!c) return;
  const have = new Set(finDb().prepare('SELECT key FROM fin_op WHERE key LIKE ?').all(`${id}#%`).map((r: any) => r.key));
  insertOps(investorSchedule(c, mskToday()).filter(o => !have.has(o.key)), who);
}
function nextDealId(): string {
  const r = finDb().prepare(`SELECT id FROM fin_deal`).all() as Array<{ id: string }>;
  const n = r.reduce((m, x) => Math.max(m, Number(x.id.replace(/\D/g, '')) || 0), 0) + 1; return 'INV-' + String(n).padStart(3, '0');
}
function cleanDeal(d: any, id: string): InvestorDeal {
  const s = (v: unknown, n = 200) => String(v ?? '').trim().slice(0, n);
  if (!s(d?.person)) throw new Error('укажите инвестора');
  if (!isDate(d?.start)) throw new Error('укажите дату получения');
  const amount = Number(d.amount), rate = Number(d.rate), term = Math.round(Number(d.term));
  if (!(amount > 0)) throw new Error('сумма вклада — больше нуля'); if (!(rate >= 0 && rate < 200)) throw new Error('ставка — % годовых, например 18');
  if (!(term > 0 && term <= 120)) throw new Error('срок — месяцев, от 1 до 120');
  const mode = d.mode === 'Ежемесячно' ? 'Ежемесячно' : 'В конце срока';
  const status = ['Действует', 'Возвращён', 'Пролонгирован'].includes(d.status) ? d.status : 'Действует';
  return { id, person: s(d.person), name: s(d.name) || `${s(d.person)} ${d.start.slice(8, 10)}.${d.start.slice(5, 7)}.${d.start.slice(0, 4)}`, start: d.start, amount, rate, term, mode, status, fromId: d.fromId ? s(d.fromId, 20) : null, comment: s(d.comment, 1000) };
}
const UPSERT_DEAL = `INSERT INTO fin_deal (id, person, name, start, amount, rate, term, mode, status, from_id, comment) VALUES (@id, @person, @name, @start, @amount, @rate, @term, @mode, @status, @from_id, @comment)
  ON CONFLICT(id) DO UPDATE SET person=excluded.person, name=excluded.name, start=excluded.start, amount=excluded.amount, rate=excluded.rate, term=excluded.term, mode=excluded.mode, status=excluded.status, from_id=excluded.from_id, comment=excluded.comment`;
const dealParams = (d: InvestorDeal) => ({ id: d.id, person: d.person, name: d.name, start: d.start, amount: d.amount, rate: d.rate, term: d.term, mode: d.mode, status: d.status, from_id: d.fromId, comment: d.comment });

export function saveDeal(body: any, who: string, opts: { received?: boolean } = {}): DealCalc {
  const isNew = !body?.id;
  const id = isNew ? nextDealId() : String(body.id);
  const old = isNew ? null : finDb().prepare('SELECT * FROM fin_deal WHERE id = ?').get(id);
  if (!isNew && !old) throw new Error('вклад не найден');
  const d = cleanDeal(body, id);
  tx(() => {
    finDb().prepare(UPSERT_DEAL).run(dealParams(d));
    if (isNew && opts.received !== false) finDb().prepare('INSERT INTO fin_move (date, deal_id, kind, amount, comment, source) VALUES (?, ?, ?, ?, ?, ?)').run(d.start, id, 'Вклад получен', d.amount, d.fromId ? `пролонгация ${d.fromId}` : '', who);
    finDb().prepare('INSERT OR IGNORE INTO fin_list (kind, name) VALUES (?, ?)').run('person', d.person);
    rebuildDealOps(id, who);
  });
  log(who, isNew ? 'deal.add' : 'deal.edit', { from: old ? rowDeal(old) : null, to: d });
  return dealsCalc().find(x => x.id === id)!;
}

/** Выплата процентов / возврат тела: движение + отметка строки календаря + пересборка графика. */
export function addMove(body: any, who: string): DealCalc {
  const dealId = String(body?.dealId ?? ''); const deal = finDb().prepare('SELECT * FROM fin_deal WHERE id = ?').get(dealId); if (!deal) throw new Error('вклад не найден');
  const kind = body?.kind as MoveKind; if (!['Проценты', 'Возврат тела', 'Вклад получен'].includes(kind)) throw new Error('что это за движение?');
  if (!isDate(body?.date)) throw new Error('укажите дату'); const amount = Number(body.amount); if (!(amount > 0)) throw new Error('сумма — больше нуля');
  tx(() => {
    finDb().prepare('INSERT INTO fin_move (date, deal_id, kind, amount, comment, source) VALUES (?, ?, ?, ?, ?, ?)').run(body.date, dealId, kind, amount, String(body.comment ?? '').slice(0, 500), who);
    // ближайшая неисполненная строка этого вида → «Исполнено» с фактом
    const pfx = kind === 'Проценты' ? `${dealId}#%` : `${dealId}#body`;
    const row = finDb().prepare(`SELECT * FROM fin_op WHERE key LIKE ? AND status NOT IN ('Исполнено','Отменено') ORDER BY date LIMIT 1`).get(kind === 'Проценты' ? pfx + '%' : pfx);
    if (kind !== 'Вклад получен' && row) finDb().prepare(`UPDATE fin_op SET status='Исполнено', fact=?, date=?, comment=?, updated_at=?, updated_by=? WHERE id=?`)
      .run(amount, body.date, [row.comment, `выплачено ${body.date.slice(8, 10)}.${body.date.slice(5, 7)} (лист «Инвесторы»)`].filter(Boolean).join('; '), now(), who, row.id);
    const c = dealsCalc().find(x => x.id === dealId)!;
    if (kind === 'Возврат тела' && c.amount - c.returned <= 0.5) finDb().prepare(`UPDATE fin_deal SET status='Возвращён' WHERE id=?`).run(dealId);
    rebuildDealOps(dealId, who);
  });
  log(who, 'deal.move', body);
  return dealsCalc().find(x => x.id === dealId)!;
}

export function prolong(body: any, who: string): DealCalc {
  const old = finDb().prepare('SELECT * FROM fin_deal WHERE id = ?').get(String(body?.id ?? '')); if (!old) throw new Error('вклад не найден');
  if (old.status !== 'Действует') throw new Error('продлить можно только действующий вклад');
  let created: DealCalc | null = null;
  tx(() => {
    finDb().prepare(`UPDATE fin_deal SET status='Пролонгирован' WHERE id=?`).run(old.id);
    finDb().prepare(`DELETE FROM fin_op WHERE key LIKE ? AND status NOT IN ('Исполнено')`).run(`${old.id}#%`);
    created = saveDeal({ person: old.person, name: body.name, start: body.start, amount: body.amount, rate: body.rate, term: body.term, mode: body.mode, fromId: old.id, comment: body.comment ?? '' }, who);
  });
  log(who, 'deal.prolong', { from: old.id, to: created!.id });
  return created!;
}

// ─── кредиты ───────────────────────────────────────────────────────────────
export function loansCalc() {
  const ops = allOps();
  return finDb().prepare('SELECT * FROM fin_loan ORDER BY id').all().map(rowLoan).map((l: Loan) => loanCalc(l, ops));
}
export function saveLoan(body: any, who: string) {
  const l = body?.loan ?? {}; const s = (v: unknown, n = 300) => String(v ?? '').trim().slice(0, n);
  if (!s(l.lender)) throw new Error('укажите кредитора');
  let id = s(l.id, 20);
  if (!id) { const r = finDb().prepare('SELECT id FROM fin_loan').all() as Array<{ id: string }>; id = 'K-' + (r.reduce((m, x) => Math.max(m, Number(x.id.replace(/\D/g, '')) || 0), 0) + 1); }
  const loan: Loan = { id, lender: s(l.lender), contract: s(l.contract), purpose: s(l.purpose), issued: isDate(l.issued) ? l.issued : '', amount: Number(l.amount) || 0, received: Number(l.received) || 0,
    price: s(l.price), term: s(l.term), how: s(l.how), payment: Number(l.payment) || 0, debt: Number(l.debt) || 0, lastDate: isDate(l.lastDate) ? l.lastDate : '', status: l.status === 'Погашен' ? 'Погашен' : 'Действует', comment: s(l.comment, 1000) };
  tx(() => {
    finDb().prepare(`INSERT INTO fin_loan (id, lender, contract, purpose, issued, amount, received, price, term, how, payment, debt, last_date, status, comment)
      VALUES (@id, @lender, @contract, @purpose, @issued, @amount, @received, @price, @term, @how, @payment, @debt, @last_date, @status, @comment)
      ON CONFLICT(id) DO UPDATE SET lender=excluded.lender, contract=excluded.contract, purpose=excluded.purpose, issued=excluded.issued, amount=excluded.amount, received=excluded.received,
      price=excluded.price, term=excluded.term, how=excluded.how, payment=excluded.payment, debt=excluded.debt, last_date=excluded.last_date, status=excluded.status, comment=excluded.comment`)
      .run(loanParams(loan));
    const g = body?.schedule;
    if (g) {
      const count = Math.round(Number(g.count)), pay = Number(g.payment);
      if (!isDate(g.first) || !(count > 0 && count <= 260) || !(pay > 0)) throw new Error('график: первая дата, число платежей (до 260) и сумма платежа');
      const have = finDb().prepare('SELECT COUNT(*) AS n FROM fin_op WHERE key LIKE ?').get(`${id}#%`) as { n: number };
      if (have.n) throw new Error('у этого кредита уже есть платежи в календаре — правьте их в календаре');
      insertOps(loanSchedule(id, `${loan.lender}${loan.contract ? ' · ' + loan.contract : ''}`, g.first, count, pay, g.every === 'month' ? 'month' : 'week', s(g.account)), who);
    }
  });
  log(who, 'loan.save', body);
  return loansCalc().find((x: any) => x.id === id);
}

// ─── перенос из Google-таблицы ─────────────────────────────────────────────
export type ImportPayload = { settings: FinSettings; ops: Array<Omit<FinOp, 'id'>>; deals: InvestorDeal[]; moves: Array<Omit<InvestorMove, 'id'>>; loans: Loan[];
  categories: Array<{ name: string; type: 'in' | 'out' }>; accounts: string[] };
export function importAll(p: ImportPayload, who: string, force = false) {
  const n = (finDb().prepare('SELECT COUNT(*) AS n FROM fin_op').get() as { n: number }).n;
  if (n && !force) throw new Error(`в базе уже ${n} строк — перенос делается только в пустую базу`);
  tx(() => {
    for (const t of ['fin_op_item', 'fin_op', 'fin_deal', 'fin_move', 'fin_loan', 'fin_list', 'fin_setting']) finDb().exec(`DELETE FROM ${t}`);
    const st = finDb().prepare(INS); for (const o of p.ops) st.run(params(cleanOp(o), o.source || who));
    const sd = finDb().prepare(UPSERT_DEAL); for (const d of p.deals) sd.run(dealParams(d));
    const sm = finDb().prepare('INSERT INTO fin_move (date, deal_id, kind, amount, comment, source) VALUES (?, ?, ?, ?, ?, ?)'); for (const m of p.moves) sm.run(m.date, m.dealId, m.kind, m.amount, m.comment, m.source);
    for (const l of p.loans) finDb().prepare(`INSERT INTO fin_loan (id, lender, contract, purpose, issued, amount, received, price, term, how, payment, debt, last_date, status, comment)
      VALUES (@id, @lender, @contract, @purpose, @issued, @amount, @received, @price, @term, @how, @payment, @debt, @last_date, @status, @comment)`).run(loanParams(l));
    const sl = finDb().prepare('INSERT OR IGNORE INTO fin_list (kind, name, extra) VALUES (?, ?, ?)');
    for (const c of p.categories) sl.run('cat', c.name, c.type); for (const a of p.accounts) sl.run('account', a, '');
    for (const d of p.deals) sl.run('person', d.person, '');
  });
  setSettings(p.settings, who);
  log(who, 'import', { ops: p.ops.length, deals: p.deals.length, moves: p.moves.length, loans: p.loans.length });
  return { ops: p.ops.length, deals: p.deals.length, moves: p.moves.length, loans: p.loans.length };
}

// ─── справочники: статьи, счета, контрагенты (19.11) ──────────────────────
// Новая статья или счёт, вписанные в строку календаря, сами попадают в справочник.
// Удаление из справочника строки календаря не трогает — пропадает только подсказка в форме.
// Переименование меняет название и во всех строках календаря.
export type ListKind = 'cat' | 'account' | 'party';
const LIST_COL: Record<ListKind, 'cat' | 'account' | 'descr'> = { cat: 'cat', account: 'account', party: 'descr' };
function rememberNames(o: { cat: string; account: string; type: string }) {
  const ins = finDb().prepare('INSERT OR IGNORE INTO fin_list (kind, name, extra) VALUES (?, ?, ?)');
  if (o.cat) ins.run('cat', o.cat, o.type);
  if (o.account) ins.run('account', o.account, '');
}
export type ListItem = { name: string; type?: 'in' | 'out'; used: number };
export function lists(): Record<ListKind, ListItem[]> {
  const out: Record<ListKind, ListItem[]> = { cat: [], account: [], party: [] };
  for (const k of Object.keys(LIST_COL) as ListKind[]) {
    const col = LIST_COL[k];
    const used = new Map((finDb().prepare(`SELECT ${col} AS v, COUNT(*) AS n FROM fin_op GROUP BY ${col}`).all() as Array<{ v: string; n: number }>).map(r => [r.v, r.n]));
    out[k] = (finDb().prepare('SELECT name, extra FROM fin_list WHERE kind = ? ORDER BY name COLLATE NOCASE').all(k) as Array<{ name: string; extra: string }>)
      .map(r => (k === 'cat' ? { name: r.name, type: r.extra === 'in' ? 'in' as const : 'out' as const, used: used.get(r.name) ?? 0 } : { name: r.name, used: used.get(r.name) ?? 0 }));
  }
  return out;
}
export function editList(b: any, who: string): Record<ListKind, ListItem[]> {
  const kind = b?.kind as ListKind; if (!Object.prototype.hasOwnProperty.call(LIST_COL, kind)) throw new Error('неизвестный справочник');
  const name = String(b?.name ?? '').trim().slice(0, 200); if (!name) throw new Error('впишите название');
  const act = String(b?.action ?? 'add');
  const type = b?.type === 'in' ? 'in' : 'out';
  const exists = (n: string) => !!finDb().prepare('SELECT 1 FROM fin_list WHERE kind = ? AND name = ?').get(kind, n);
  tx(() => {
    if (act === 'add') {
      if (exists(name)) throw new Error('такое название уже есть');
      finDb().prepare('INSERT INTO fin_list (kind, name, extra) VALUES (?, ?, ?)').run(kind, name, kind === 'cat' ? type : '');
    } else if (act === 'delete') {
      finDb().prepare('DELETE FROM fin_list WHERE kind = ? AND name = ?').run(kind, name);
    } else if (act === 'rename') {
      const to = String(b?.to ?? '').trim().slice(0, 200); if (!to) throw new Error('впишите новое название');
      if (to !== name && exists(to)) throw new Error('такое название уже есть');
      finDb().prepare('UPDATE fin_list SET name = ?, extra = ? WHERE kind = ? AND name = ?').run(to, kind === 'cat' ? type : '', kind, name);
      const col = LIST_COL[kind];
      if (to !== name) finDb().prepare(`UPDATE fin_op SET ${col} = ?, updated_at = ?, updated_by = ? WHERE ${col} = ?`).run(to, now(), who, name);
    } else throw new Error('неизвестное действие');
    log(who, 'list.' + act, { kind, name, to: b?.to, type: b?.type });
  });
  return lists();
}

// ─── обработчик /api/finance/* ─────────────────────────────────────────────
export async function handleFinance(parts: string[], method: string, query: any, body: any, who: string): Promise<{ status: number; json: unknown }> {
  const b = typeof body === 'string' ? JSON.parse(body || '{}') : (body ?? {});
  const [, a, c] = parts; const today = mskToday();
  try {
    if (method === 'GET') {
      if (a === 'lists') return { status: 200, json: { ok: true, lists: lists() } };
      if (a === 'ops') return { status: 200, json: { ok: true, ops: allOps(), settings: getSettings(), today } };
      if (a === 'meta') return { status: 200, json: { ok: true, ...meta() } };
      if (a === 'month') {
        const m = /^\d{4}-\d{2}$/.test(String(query?.m ?? '')) ? String(query.m) : today.slice(0, 7);
        return { status: 200, json: { ok: true, view: monthView(m, allOps(), getSettings(), today) } };
      }
      if (a === 'summary') return { status: 200, json: { ok: true, summary: summary(allOps(), getSettings(), dealsCalc(), today, lastMonth()) } };
      if (a === 'investors') return { status: 200, json: { ok: true, deals: dealsCalc(), today } };
      if (a === 'loans') return { status: 200, json: { ok: true, loans: loansCalc(), today } };
      if (a === 'catalog') return { status: 200, json: { ok: true, ...(await catalog()) } };
      if (a === 'purchases') return { status: 200, json: { ok: true, today, purchases: purchaseItems(today, Number(query?.days) > 0 ? Math.min(365, Number(query.days)) : 60) } };
      if (a === 'yougile') { const m = await import('./financeYougile'); return { status: 200, json: { ok: true, enabled: !!process.env.YOUGILE_KEY, state: m.ygState() } }; }
      if (a === 'log') return { status: 200, json: { ok: true, log: finDb().prepare('SELECT * FROM fin_log ORDER BY id DESC LIMIT 200').all() } };
    }
    if (method === 'POST') {
      if (a === 'op' && c === 'delete') {
        // 21.11: несколько строк сразу (галочки в календаре) — { ids: [...] }; одна — { id }
        const ids = (Array.isArray(b.ids) ? b.ids : [b.id]).map(Number).filter((n: number) => n > 0);
        if (!ids.length) throw new Error('не выбрано ни одной строки');
        if (ids.length > 300) throw new Error('за раз — не больше 300 строк');
        tx(() => { for (const id of ids) deleteOp(id, who); });
        return { status: 200, json: { ok: true, deleted: ids.length } };
      }
      // агенту (ключ FIN_AGENT_KEY, route.ts пропускает ему POST op/*) копировать и переносить строки нельзя
      if (a === 'op' && c === 'copy' && who === 'Агент финансов') return { status: 403, json: { error: 'forbidden', reason: 'агент строки не копирует и не переносит' } };
      if (a === 'op' && c === 'copy') return { status: 200, json: { ok: true, ...copyOps(b, who) } };
      if (a === 'op') return { status: 200, json: { ok: true, op: saveOp(b.op ?? b, who) } };
      if (a === 'lists') return { status: 200, json: { ok: true, lists: editList(b, who) } };
      if (a === 'settings') return { status: 200, json: { ok: true, settings: setSettings(b, who) } };
      if (a === 'balance' && c === 'refresh') return { status: 200, json: { ok: true, ...(await refreshBalance(who)) } };
      if (a === 'investors' && c === 'deal') return { status: 200, json: { ok: true, deal: saveDeal(b.deal ?? b, who) } };
      if (a === 'investors' && c === 'move') return { status: 200, json: { ok: true, deal: addMove(b.move ?? b, who) } };
      if (a === 'investors' && c === 'prolong') return { status: 200, json: { ok: true, deal: prolong(b, who) } };
      if (a === 'loans') return { status: 200, json: { ok: true, loan: saveLoan(b, who) } };
      if (a === 'import') return { status: 200, json: { ok: true, imported: importAll(b, who, query?.force === '1') } };
    }
    return { status: 404, json: { error: 'not_found' } };
  } catch (e) {
    const msg = (e as Error).message;
    console.warn('[finance] не выполнено:', parts.join('/'), msg);
    return { status: 400, json: { error: 'bad_request', reason: msg } };
  }
}
