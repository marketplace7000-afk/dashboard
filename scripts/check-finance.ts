/**
 * Проверка раздела «Финансы» (19.11.2026): остаток по дням, итоги месяца, инвесторы, кредиты,
 * запись в базу (временная папка). Запуск: npx tsx scripts/check-finance.ts
 * С переменной FIN_EXPORT=<путь к выгрузке Google-таблицы> дополнительно сверяет перенос
 * с цифрами таблицы (остаток 23.11, долг инвесторам).
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cashDay, dailyCash, dealCalc, investorSchedule, loanSchedule, monthView, opAmount, type FinOp, type FinSettings, type InvestorDeal } from '../shared/finance';

let fails = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fails++; console.error(`✗ ${name}: получили ${JSON.stringify(got)}, ждали ${JSON.stringify(want)}`); } else console.log(`✓ ${name}`);
};
const op = (id: number, date: string, type: 'in' | 'out', plan: number, status: FinOp['status'] = 'План', fact: number | null = null): FinOp =>
  ({ id, date, type, cat: '', descr: 't', plan, fact, status, account: '', source: '', resp: '', comment: '', key: null });
const S: FinSettings = { balance: 1000, balanceDate: '2026-11-18', minBalance: 500 };

// ─── остаток ───────────────────────────────────────────────────────────────
check('исполненное в прогноз не входит', cashDay(op(1, '2026-11-20', 'in', 100, 'Исполнено', 100), S.balanceDate), null);
check('отменённое не входит', cashDay(op(1, '2026-11-20', 'in', 100, 'Отменено'), S.balanceDate), null);
check('просроченное — на дату остатка', cashDay(op(1, '2026-11-10', 'out', 100), S.balanceDate), '2026-11-18');
check('итог месяца: исполненное по факту', opAmount(op(1, '2026-11-10', 'out', 100, 'Исполнено', 90)), 90);
check('итог месяца: исполненное без факта — по плану', opAmount(op(1, '2026-11-10', 'out', 100, 'Исполнено')), 100);
check('итог месяца: перенесённое не считается', opAmount(op(1, '2026-11-10', 'out', 100, 'Перенесено')), 0);
const ops = [op(1, '2026-11-10', 'out', 300), op(2, '2026-11-19', 'in', 200), op(3, '2026-11-20', 'out', 2000), op(4, '2026-11-21', 'in', 5000, 'Исполнено', 5000)];
const cash = dailyCash(ops, S, '2026-11-21');
check('остаток по дням', cash.map(c => c.end), [700, 900, -1100, -1100]);
const mv = monthView('2026-11', ops, S, '2026-11-18');
check('месяц: дни до даты остатка без остатка', mv.days[0].end, null);
check('месяц: разрыв', mv.days[19].signal, 'gap');
check('месяц: приход и расход', [mv.totals.in, mv.totals.out], [5200, 2300]);
check('месяц: минимум', [mv.totals.min, mv.totals.minDate], [-1100, '2026-11-20']);

// ─── инвесторы ─────────────────────────────────────────────────────────────
const deal: InvestorDeal = { id: 'INV-900', person: 'Тест', name: 'Тест', start: '2026-06-15', amount: 120000, rate: 20, term: 12, mode: 'Ежемесячно', status: 'Действует', fromId: null, comment: '' };
const c = dealCalc(deal, [{ id: 1, date: '2026-07-15', dealId: 'INV-900', kind: 'Проценты', amount: 2000, comment: '', source: '' }]);
check('вклад: проценты за срок и остаток', [c.totalInt, c.paidInt, c.remInt, c.remBody, c.monthly, c.end], [24000, 2000, 22000, 120000, 2000, '2027-06-15']);
const sch = investorSchedule(c, '2026-11-18');
check('вклад: ежемесячные с декабря + остаток в конце + тело', [sch.length, sch[0].date, sch[0].plan, sch.at(-1)!.key, sch.at(-1)!.plan], [9, '2026-12-01', 2000, 'INV-900#body', 120000]);
check('вклад: сумма процентов в графике = остаток процентов', sch.filter(o => o.cat === 'Инвестор — проценты').reduce((s, o) => s + o.plan, 0), 22000);
check('закрытый вклад: долга нет и графика нет', [dealCalc({ ...deal, status: 'Пролонгирован' }, []).owed, investorSchedule(dealCalc({ ...deal, status: 'Возвращён' }, []), '2026-11-18').length], [0, 0]);
const end = investorSchedule(dealCalc({ ...deal, mode: 'В конце срока', start: '2025-01-10' }, []), '2026-11-18');
check('просроченный вклад: выплата на сегодня с пометкой', [end[0].date, end[0].comment.startsWith('срок вклада прошёл')], ['2026-11-18', true]);

// ─── кредиты ───────────────────────────────────────────────────────────────
const ls = loanSchedule('K-9', 'Банк', '2026-11-30', 3, 1000, 'month', 'Точка');
check('кредит: помесячно, конец месяца не уезжает', ls.map(o => o.date), ['2026-11-30', '2026-12-30', '2027-01-30']);
check('кредит: ключи', ls.map(o => o.key), ['K-9#1', 'K-9#2', 'K-9#3']);
check('кредит: раз в неделю', loanSchedule('K-9', 'Б', '2026-12-30', 2, 1, 'week', '').map(o => o.date), ['2026-12-30', '2027-01-06']);

// ─── база ──────────────────────────────────────────────────────────────────
const dir = mkdtempSync(join(tmpdir(), 'fin-'));
process.env.CACHE_DIR = dir;
(async () => {
  const f = await import('../api/_lib/finance');
  try {
    f.importAll({ settings: S, ops: [], deals: [], moves: [], loans: [], categories: [{ name: 'Выплата Ozon', type: 'in' }], accounts: ['Точка'] }, 'проверка');
    const a = f.saveOp({ date: '2026-11-25', type: 'in', cat: 'Выплата Ozon', descr: '', plan: 1000, fact: null, status: 'Прогноз' }, 'проверка');
    const b = f.saveOp({ ...a, status: 'Исполнено', fact: 990 }, 'проверка');
    check('строка: правка сохраняется', [b.id, b.status, b.fact], [a.id, 'Исполнено', 990]);
    let err = ''; try { f.saveOp({ date: '2026-13-01', type: 'in', plan: 1, status: 'План', cat: 'x' }, 'проверка'); } catch (e) { err = (e as Error).message; }
    check('строка: неверная дата не сохраняется', err, 'укажите дату');
    const d = f.saveDeal({ person: 'Тест', start: '2026-06-15', amount: 120000, rate: 20, term: 12, mode: 'Ежемесячно' }, 'проверка');
    check('новый вклад: номер и строки в календаре', [d.id, f.allOps().filter(o => o.key?.startsWith('INV-001#')).length > 0], ['INV-001', true]);
    const afterPay = f.addMove({ dealId: 'INV-001', kind: 'Проценты', date: '2026-12-02', amount: 2000 }, 'проверка');
    check('выплата %: строка календаря исполнена', f.allOps().filter(o => o.key?.startsWith('INV-001#%') && o.status === 'Исполнено').length, 1);
    check('выплата %: остаток процентов уменьшился', afterPay.remInt, 22000);
    const p = f.prolong({ id: 'INV-001', start: '2027-06-15', amount: 120000, rate: 22, term: 6, mode: 'В конце срока' }, 'проверка');
    check('пролонгация: новый вклад ссылается на старый', [p.id, p.fromId], ['INV-002', 'INV-001']);
    check('пролонгация: старые будущие строки сняты, исполненная осталась', f.allOps().filter(o => o.key?.startsWith('INV-001#')).map(o => o.status), ['Исполнено']);
    check('пролонгация: старый вклад закрыт', f.dealsCalc().find(x => x.id === 'INV-001')!.status, 'Пролонгирован');
    f.addMove({ dealId: 'INV-002', kind: 'Возврат тела', date: '2027-12-15', amount: 120000 }, 'проверка');
    check('полный возврат: вклад «Возвращён», будущих строк нет', [f.dealsCalc().find(x => x.id === 'INV-002')!.status, f.allOps().filter(o => o.key?.startsWith('INV-002#') && o.status !== 'Исполнено').length], ['Возвращён', 0]);
    const l = f.saveLoan({ loan: { lender: 'Банк' }, schedule: { first: '2026-12-01', count: 3, payment: 500, every: 'week' } }, 'проверка');
    check('новый кредит: номер и график', [l.id, l.leftCount, l.leftSum], ['K-1', 3, 1500]);
    f.deleteOp(a.id, 'проверка');
    check('удаление строки', f.allOps().some(o => o.id === a.id), false);

    // справочники
    f.saveOp({ date: '2026-11-26', type: 'out', cat: 'Новая статья', descr: 'ООО Ромашка', plan: 10, status: 'План', account: 'Сбер' }, 'проверка');
    check('новая статья и счёт из строки попали в справочник', [f.lists().cat.some(i => i.name === 'Новая статья' && i.type === 'out'), f.lists().account.some(i => i.name === 'Сбер')], [true, true]);
    f.editList({ kind: 'party', action: 'add', name: 'ООО Ромашка' }, 'проверка');
    let dup = ''; try { f.editList({ kind: 'party', action: 'add', name: 'ООО Ромашка' }, 'проверка'); } catch (e) { dup = (e as Error).message; }
    check('контрагент: дубль не добавляется', dup, 'такое название уже есть');
    f.editList({ kind: 'party', action: 'rename', name: 'ООО Ромашка', to: 'ООО Лютик' }, 'проверка');
    check('контрагент: переименован и в строках календаря', [f.lists().party.find(i => i.name === 'ООО Лютик')?.used, f.allOps().some(o => o.descr === 'ООО Ромашка')], [1, false]);
    f.editList({ kind: 'cat', action: 'delete', name: 'Новая статья' }, 'проверка');
    check('статья убрана из списка, строка осталась', [f.lists().cat.some(i => i.name === 'Новая статья'), f.allOps().some(o => o.cat === 'Новая статья')], [false, true]);

    if (process.env.FIN_EXPORT) {
      const p2 = JSON.parse(readFileSync(process.env.FIN_EXPORT, 'utf8'));
      f.importAll(p2, 'проверка', true);
      const { summary } = await import('../shared/finance');
      const s = summary(f.allOps(), f.getSettings(), f.dealsCalc(), '2026-11-18', '2027-12');
      const d23 = s.series.find(x => x.date === '2026-11-23');
      console.log('— перенос: строк', f.allOps().length, '· остаток 23.11', d23?.end, '· должны инвесторам', s.investors.owed, '· кредиты впереди', s.loansLeft);
    }
  } finally { f.closeFinDb(); rmSync(dir, { recursive: true, force: true }); }
  if (fails) { console.error(`check-finance: ошибок ${fails}`); process.exit(1); }
  console.log('check-finance: всё верно');
})();
