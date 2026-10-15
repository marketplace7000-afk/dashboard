/**
 * Сигналы и выпуски советника (этап А, 15.10.2026): сборка выпуска на пустой базе,
 * расписание, статусы «сделано / отложить / вернуть», история выпусков.
 * Содержательная проверка правил идёт на копии прод-базы (scratchpad), здесь — каркас.
 *
 * Запуск: node node_modules/tsx/dist/cli.mjs scripts/check-ads-signals.ts
 */
import './_ads-check-env';
import { adsDb } from '../api/_lib/ads/store';
import { ISSUE_SLOTS, buildIssue, getSignals, decideSignal, listSignals, sortSignals } from '../api/_lib/ads/signals';

let failed = 0;
function check(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n      получили ${JSON.stringify(actual)}\n      ждали    ${JSON.stringify(expected)}`}`);
}

process.env.OZON_CLIENT_ID = '466884';

(async () => {
  console.log('Расписание');
  check('четыре выпуска по МСК', ISSUE_SLOTS.map(s => s.time), ['08:00', '12:00', '15:30', '17:30']);
  check('прогрев раньше выпуска', ISSUE_SLOTS.every(s => s.refresh < s.time), true);

  console.log('Выпуск на пустой базе');
  const iss = await buildIssue('wb', 'manual');
  check('выпуск создан', iss.id > 0 && iss.slot === 'manual' && iss.mp === 'wb', true);
  check('сигналов нет', iss.signals.length, 0);
  check('разбор вчера есть', !!iss.yesterday, true);
  const g = getSignals('wb');
  check('дней в ленте 14', g.dates.length, 14);
  check('выпуск дня виден', g.issues.map(i => i.id), [iss.id]);
  check('последний выпуск отдан', g.issue?.id, iss.id);
  check('по чужой дате выпусков нет', getSignals('wb', g.dates[3]).issues.length, 0);

  console.log('Статусы сигнала');
  const d = adsDb();
  d.prepare(`INSERT INTO signal (mp, sku, code, level, role, title, text, action, rub, data, since, last_seen, status)
    VALUES ('wb', '1', 'drr_high', 'warn', 'ads', 'ДРР', 'текст', 'действие', 500, '{"article":"A"}', ?, ?, 'open')`).run(Date.now() - 2 * 86_400_000, Date.now());
  const s = listSignals('wb')[0];
  check('сигнал читается, 3-й день', [s.code, s.days, s.status], ['drr_high', 3, 'open']);
  check('сделано', decideSignal(s.id, 'done', 'тест').signal?.status, 'done');
  check('в «сделано сегодня»', getSignals('wb').doneToday.length, 1);
  check('вернуть', decideSignal(s.id, 'reopen', 'тест').signal?.status, 'open');
  const sn = decideSignal(s.id, 'snooze', 'тест').signal!;
  check('отложено до завтра 08:00 МСК', [sn.status, new Date(sn.snoozedUntil!).toISOString().slice(11, 16)], ['snoozed', '05:00']);
  check('неизвестный id — ошибка', decideSignal(999999, 'done', 'тест').ok, false);
  // пересчёт: условия для sku 1 в данных нет → сигнал закрывается
  await buildIssue('wb', 'manual');
  check('пропавший сигнал закрыт', listSignals('wb').length, 0);
  check('сортировка: критичное раньше', sortSignals([
    { level: 'warn', role: 'ads', rub: 1, article: 'b' } as any, { level: 'critical', role: 'ads', rub: null, article: 'a' } as any,
  ]).map(x => x.level), ['critical', 'warn']);

  console.log(failed ? `\nОшибок: ${failed}` : '\nВсе проверки пройдены');
  process.exit(failed ? 1 : 0);
})();
