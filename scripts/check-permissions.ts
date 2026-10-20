/**
 * Галочки разделов действуют на сервере, а не только в меню (20.10.2026).
 * Запуск: npm run check
 */
import { checkSectionAccess } from '../api/_lib/permissions';
import type { AuthUser, Section } from '../api/_lib/sklad/users';
import { loginLockedFor, noteLoginFailure, noteLoginSuccess } from '../api/_lib/loginGuard';

let failed = 0;
function check(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n      получили ${JSON.stringify(actual)}\n      ждали    ${JSON.stringify(expected)}`}`);
}

const user = (role: AuthUser['role'], sections: Section[]): AuthUser =>
  ({ id: 1, login: 'u', name: 'U', role, warehouseIds: null, sections });
const ok = (u: AuthUser, section: string, rest: string[], method: string) => checkSectionAccess(u, section, rest, method) === null;

const owner = user('owner', []);
const reviewsOnly = user('manager', ['sklad', 'reviews']);
const adsManager = user('manager', ['sklad', 'ads', 'rnp', 'prices']);

console.log('Владелец');
check('меняет ставки', ok(owner, 'ads2', ['action'], 'POST'), true);
check('пишет цены через прокси Ozon', ok(owner, 'ozon', ['v1', 'product', 'import', 'prices'], 'POST'), true);

console.log('Менеджер только с «Отзывами»');
check('не меняет ставки', ok(reviewsOnly, 'ads2', ['action'], 'POST'), false);
check('не принимает автопилот', ok(reviewsOnly, 'ads2', ['autopilot'], 'POST'), false);
check('не меняет настройки', ok(reviewsOnly, 'settings', [], 'POST'), false);
check('не меняет себестоимость', ok(reviewsOnly, 'costs', [], 'POST'), false);
check('не ставит задания агентам', ok(reviewsOnly, 'agents', ['tasks'], 'POST'), false);
check('не видит пульт агентов', ok(reviewsOnly, 'agents', ['live'], 'GET'), false);
check('не меняет цены через прокси Ozon', ok(reviewsOnly, 'ozon', ['v1', 'product', 'import', 'prices'], 'POST'), false);
check('не меняет цены WB через прокси', ok(reviewsOnly, 'wb', ['prices', 'api', 'v2', 'upload', 'task'], 'POST'), false);
check('отвечает на отзывы', ok(reviewsOnly, 'reviews', ['publish'], 'POST'), true);
check('читает отзывы', ok(reviewsOnly, 'reviews', ['list'], 'GET'), true);
check('читает аналитику Ozon (POST-чтение)', ok(reviewsOnly, 'ozon', ['v1', 'analytics', 'data'], 'POST'), true);
check('читает воронку WB (POST-чтение)', ok(reviewsOnly, 'wb', ['analytics', 'api', 'analytics', 'v3', 'sales-funnel', 'products'], 'POST'), true);
check('сохраняет общие настройки экрана', ok(reviewsOnly, 'ui-state', [], 'POST'), true);

console.log('Менеджер рекламы');
check('меняет ставки', ok(adsManager, 'ads2', ['action'], 'POST'), true);
check('закрывает сигнал советника', ok(adsManager, 'ads2', ['signals'], 'POST'), true);
check('собирает РНП', ok(adsManager, 'rnp', ['collect'], 'POST'), true);
check('меняет репрайсер', ok(adsManager, 'repricer', [], 'POST'), true);
check('не видит отзывы', ok(adsManager, 'reviews', ['list'], 'GET'), false);
check('не меняет ставки напрямую через прокси (PUT)', ok(adsManager, 'ozon-perf', ['api', 'client', 'campaign', '1', 'products'], 'PUT'), false);
check('не активирует кампанию через прокси', ok(adsManager, 'ozon-perf', ['api', 'client', 'campaign', 'activate'], 'POST'), false);
check('не меняет настройки кабинета', ok(adsManager, 'settings', [], 'POST'), false);

console.log('Подбор пароля');
const t0 = 1_000_000;
for (let i = 0; i < 4; i++) noteLoginFailure('1.1.1.1', '', t0 + i);
check('4 неудачи — ещё можно', loginLockedFor('1.1.1.1', '', t0 + 10), 0);
noteLoginFailure('1.1.1.1', '', t0 + 5);
check('5-я неудача — адрес закрыт на 15 минут', loginLockedFor('1.1.1.1', '', t0 + 10), 900);
check('другой адрес владельца не заперт', loginLockedFor('2.2.2.2', '', t0 + 10), 0);
check('через 15 минут снова можно', loginLockedFor('1.1.1.1', '', t0 + 15 * 60_000 + 10), 0);
for (let i = 0; i < 3; i++) noteLoginFailure('3.3.3.3', 'anna', t0 + i);
noteLoginSuccess('3.3.3.3', 'anna');
for (let i = 0; i < 4; i++) noteLoginFailure('3.3.3.3', 'anna', t0 + 10 + i);
check('удачный вход обнуляет счётчик', loginLockedFor('3.3.3.3', 'anna', t0 + 20), 0);

if (failed) { console.error(`\n✗ провалено: ${failed}`); process.exit(1); }
console.log('\n✓ права разделов в порядке');
