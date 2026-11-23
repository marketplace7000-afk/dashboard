/**
 * Проверка «Выплаты Ozon → платёжный календарь» (23.11.2026) на ответе Ozon от 23.11 (цифры из пробного запроса диспетчера API):
 * дата выплаты — среда через две недели после недели продаж, части недели на стыке месяцев складываются,
 * открытая неделя не берётся, «Исполнено» не трогаем, сумма правится, новая выплата добавляется, второй проход ничего не меняет.
 * Запуск: npx tsx scripts/check-fin-ozon.ts
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let fails = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fails++; console.error(`✗ ${name}: получили ${JSON.stringify(got)}, ждали ${JSON.stringify(want)}`); } else console.log(`✓ ${name}`);
};
const det = (begin: string, end: string, invoice: number, paid = 0) =>
  ({ period: { begin: `${begin}T00:00:00Z`, end: `${end}T00:00:00Z` }, invoice_transfer: invoice, payments: paid ? [{ payment: -paid, currency_code: 'RUB' }] : [] });
const OZON = { result: { details: [
  det('2026-10-19', '2026-10-25', 3397828),
  det('2026-10-26', '2026-10-31', 2559285),
  det('2026-11-01', '2026-11-01', 0),
  det('2026-11-02', '2026-11-08', 2328112, 3366525),
  det('2026-11-09', '2026-11-15', 2702609, 3402759),
  det('2026-11-16', '2026-11-22', 5171321, 2559285),
  det('2026-11-23', '2026-11-29', 12086572),
] } };

(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fin-oz-'));
  process.env.CACHE_DIR = dir;
  const f = await import('../api/_lib/finance');
  const z = await import('../api/_lib/financeOzon');
  try {
    const weeks = z.parseWeeks(OZON);
    const pays = z.payoutsFrom(weeks, '2026-11-23');
    check('даты выплат — среды через 2 недели; стык месяцев сложен; открытая неделя не взята',
      pays.map(p => [p.date, p.amount]), [['2026-11-11', 3397828], ['2026-11-18', 2559285], ['2026-11-25', 2328112], ['2026-12-02', 2702609], ['2026-12-09', 5171321]]);
    check('подпись периода у выплаты 18.11 — 26.10–01.11', [pays[1].begin, pays[1].end], ['2026-10-26', '2026-11-01']);

    const base = { type: 'in', cat: 'Выплата Ozon', account: 'Номинальный счёт (Альт1)', resp: '', comment: '' };
    const paid18 = f.saveOp({ ...base, date: '2026-11-18', descr: 'Ozon · старая подпись', plan: 2559285, fact: 2559285, status: 'Исполнено', key: 'OZ#2026-11-18' }, 'проверка');
    const r25 = f.saveOp({ ...base, date: '2026-11-25', descr: 'Ozon · старая подпись', plan: 2323181, fact: null, status: 'Подтверждено', key: 'OZ#2026-11-25' }, 'проверка');
    const loose = f.saveOp({ ...base, date: '2026-12-03', descr: 'Выплата Ozon примерный срок и сумма', plan: 2000000, fact: null, status: 'Прогноз', key: null }, 'проверка');
    const fc16 = f.saveOp({ ...base, date: '2026-12-16', descr: 'прогноз', plan: 3000000, fact: null, status: 'Прогноз', key: 'OZ#2026-12-16' }, 'проверка');

    const res = z.applyPayouts(weeks, '2026-11-23', new Date('2026-11-23T05:06:00Z'));
    const by = (id: number) => f.allOps().find(o => o.id === id)!;
    check('итог прохода: 1 добавлена (09.12), 2 исправлены (25.11, примерная 03.12 → 02.12)', [res.added, res.updated], [1, 2]);
    check('«Исполнено» 18.11 не тронуто', [by(paid18.id).descr, by(paid18.id).fact], ['Ozon · старая подпись', 2559285]);
    check('25.11: сумма из Ozon, подпись периода, «было» в комментарии', [by(r25.id).plan, by(r25.id).descr, by(r25.id).comment.includes('было 2 323 181 ₽')],
      [2328112, 'Ozon Avto Vibe · реализация за 02.11–08.11', true]);
    check('примерная строка 03.12 стала выплатой 02.12 с ключом', [by(loose.id).date, by(loose.id).plan, by(loose.id).key, by(loose.id).status], ['2026-12-02', 2702609, 'OZ#2026-12-02', 'Подтверждено']);
    const n09 = f.allOps().find(o => o.key === 'OZ#2026-12-09');
    check('новая выплата 09.12 добавлена', [n09?.plan, n09?.status, n09?.account, n09?.source], [5171321, 'Подтверждено', 'Номинальный счёт (Альт1)', 'Ozon API']);
    check('прогноз 16.12 (неделя ещё идёт) не тронут', [by(fc16.id).plan, by(fc16.id).status], [3000000, 'Прогноз']);
    check('выплаты не стали «Исполнено» сами', f.allOps().filter(o => o.source === 'Ozon API' || o.key?.startsWith('OZ#')).filter(o => o.status === 'Исполнено').length, 1);

    const again = z.applyPayouts(weeks, '2026-11-23', new Date('2026-11-23T09:06:00Z'));
    check('второй проход ничего не меняет', [again.added, again.updated], [0, 0]);

    // 25.11 наступило, деньги пришли — подсказка «отметьте Исполнено», статус не меняется.
    const paidWeeks = z.parseWeeks({ result: { details: [...OZON.result.details, det('2026-11-23', '2026-11-29', 12086572, 2328112)] } });
    const later = z.applyPayouts(paidWeeks, '2026-11-25', new Date('2026-11-25T05:06:00Z'));
    check('выплата пришла — подсказка в комментарии, статус прежний', [later.hinted >= 1, by(r25.id).comment.includes('выплачено 2 328 112 ₽'), by(r25.id).status], [true, true, 'Подтверждено']);
  } finally { f.closeFinDb(); rmSync(dir, { recursive: true, force: true }); }
  if (fails) { console.error(`check-fin-ozon: ошибок ${fails}`); process.exit(1); }
  console.log('check-fin-ozon: всё верно');
})();
