/**
 * «Доступы» 27.10.2026: вход по паролю владельца гаснет при смене пароля и по
 * кнопке «выйти везде»; выданные сотрудникам пароли можно прочитать обратно.
 * Работает на временном файле базы — рабочую .av-cache/sklad.sqlite не трогает.
 *
 * Запуск: npm run check
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'access-check-'));
process.env.SKLAD_DB_PATH = join(dir, 'sklad.sqlite');
process.env.AUTH_PASSWORD = 'old-owner-pass';
process.env.AUTH_SECRET = 'test-secret';

let failed = 0;
function check(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n      получили ${JSON.stringify(actual)}\n      ждали    ${JSON.stringify(expected)}`}`);
}

/** requireAuth на поддельном запросе: true — пустил. */
function passes(auth: typeof import('../api/_lib/auth'), token: string): boolean {
  const req = { headers: { cookie: `av_session=${token}` } } as any;
  const res = { status: () => res, json: () => res } as any;
  return auth.requireAuth(req, res);
}

async function main() {
  const { closeSkladDb } = await import('../api/_lib/sklad/db');
  const users = await import('../api/_lib/sklad/users');
  const auth = await import('../api/_lib/auth');
  const owner = users.OWNER_BY_PASSWORD;

  console.log('Пароль владельца');
  const t1 = auth.signSession(process.env.AUTH_SECRET!);
  check('свежий вход владельца пускает', passes(auth, t1), true);
  process.env.AUTH_PASSWORD = 'new-owner-pass';
  check('после смены пароля старый вход не пускает', passes(auth, t1), false);
  const t2 = auth.signSession(process.env.AUTH_SECRET!);
  check('вход с новым паролем пускает', passes(auth, t2), true);
  auth.bumpOwnerSessionVersion();
  check('«выйти везде» гасит вход владельца', passes(auth, t2), false);
  check('новый вход после «выйти везде» пускает', passes(auth, auth.signSession(process.env.AUTH_SECRET!)), true);
  const legacy = auth.signSession(process.env.AUTH_SECRET!).split('.')[0];
  const oldPayload = Buffer.from(JSON.stringify({ iat: Date.now(), exp: Date.now() + 86_400_000 })).toString('base64url');
  const { createHmac } = await import('node:crypto');
  const oldToken = `${oldPayload}.${createHmac('sha256', process.env.AUTH_SECRET!).update(oldPayload).digest('base64url')}`;
  check('вход старого образца (до 27.10) не пускает', !!legacy && passes(auth, oldToken), false);

  console.log('Пароли сотрудников');
  const c = users.createUser({ login: 'ivan', name: 'Иван', role: 'manager', password: 'ivan-pass-1' }, owner);
  const id = c.user!.id;
  check('выданный пароль виден владельцу', users.issuedPasswords()[id], 'ivan-pass-1');
  const tUser = auth.signSession(process.env.AUTH_SECRET!, { uid: id, ver: users.sessionVersion(id) });
  check('сотрудник входит', passes(auth, tUser), true);
  users.updateUser(id, { logoutAll: true }, owner);
  check('«выйти на всех устройствах» гасит сессию сотрудника', passes(auth, tUser), false);
  check('пароль после выхода не изменился', users.issuedPasswords()[id], 'ivan-pass-1');
  users.updateUser(id, { password: 'ivan-pass-2' }, owner);
  check('новый пароль виден', users.issuedPasswords()[id], 'ivan-pass-2');
  check('вход новым паролем', users.loginWithPassword('ivan', 'ivan-pass-2')?.id, id);
  check('старым паролем не входит', users.loginWithPassword('ivan', 'ivan-pass-1'), null);

  closeSkladDb();
  rmSync(dir, { recursive: true, force: true });
  if (failed) { console.log(`\n✗ ${failed} проверок не прошли`); process.exit(1); }
  console.log('\n✓ всё сходится');
}

main().catch(e => { console.error(e); process.exit(1); });
