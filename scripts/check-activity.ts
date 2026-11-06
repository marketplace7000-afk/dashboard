/**
 * «Доступы» → «Активность» (06.11.2026): минуты на сайте, активные минуты,
 * разделы, входы и границы суток по Москве. Работает на временной базе.
 *
 * Запуск: npm run check
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'activity-check-'));
process.env.CACHE_DIR = dir;

let failed = 0;
function check(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n      получили ${JSON.stringify(actual)}\n      ждали    ${JSON.stringify(expected)}`}`);
}

async function main() {
  const act = await import('../api/_lib/activity');
  // 05.11.2026 09:00 МСК = 06:00 UTC.
  const t0 = Date.parse('2026-11-05T06:00:00Z');
  const min = (n: number) => t0 + n * 60_000;

  act.notePing(7, 'rnp', true, true, min(0));
  act.notePing(7, 'rnp', false, false, min(0) + 20_000); // та же минута: активность не теряется
  act.notePing(7, 'rnp', false, false, min(1));
  act.notePing(7, 'ads', true, true, min(2));
  act.notePing(7, 'ads', true, false, min(65));
  act.notePing(7, '<script>', true, false, min(66)); // мусорный раздел не пишем
  act.notePing(7, 'rnp', true, false, Date.parse('2026-11-05T20:59:00Z')); // 23:59 МСК — ещё 05.11
  act.notePing(7, 'rnp', true, false, Date.parse('2026-11-05T21:00:00Z')); // 00:00 МСК — уже 06.11
  const req = { headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36' } } as any;
  act.noteAuthEvent(req, 'login', 7, 'ivan', '1.2.3.4');
  act.noteAuthEvent(req, 'login_fail', null, 'Ivan', '1.2.3.4');
  act.noteAuthEvent(req, 'login_fail', null, 'hacker', '5.6.7.8');

  const r = act.dayReport(7, 'ivan', '2026-11-05');
  console.log('Сутки 05.11');
  check('начал в 09:00 МСК', r.first, t0);
  check('минут на сайте', r.onlineMin, 6);
  check('активных минут', r.activeMin, 5);
  check('по часам: 9 ч — 2, 10 ч — 2, 23 ч — 1', [r.hours[9], r.hours[10], r.hours[23]], [2, 2, 1]);
  check('разделы', r.sections.map(s => [s.section, s.min, s.views]), [['rnp', 3, 1], ['ads', 2, 1]]);
  check('06.11 — одна минута', act.dayReport(7, 'ivan', '2026-11-06').onlineMin, 1);
  const today = act.daysBack(1)[0];
  check('вход сегодня записан с устройством', act.dayReport(7, 'ivan', today).logins.map(l => l.device), ['Chrome · Windows']);
  check('неудачный вход по своему логину (без учёта регистра)', act.dayReport(7, 'ivan', today).failedLogins, 1);
  check('чужие логины — отдельно', act.unknownFailures(today, ['ivan', '']).map(f => [f.login, f.count]), [['hacker', 1]]);
  check('последнее появление', act.lastSeen(7), Date.parse('2026-11-05T21:00:00Z'));
  check('кто не заходил — пусто', act.dayReport(8, 'petr', '2026-11-05').first, null);

  act.closeActivityDb();
  rmSync(dir, { recursive: true, force: true });
  if (failed) { console.log(`\n✗ ${failed} проверок не прошли`); process.exit(1); }
  console.log('\n✓ всё сходится');
}

main().catch(e => { console.error(e); process.exit(1); });
