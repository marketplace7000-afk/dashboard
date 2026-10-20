/**
 * Пользователи кабинета и роли.
 *
 * До раздела «Склад» вход был один — общий пароль AUTH_PASSWORD (владелец).
 * Он работает как раньше: такая сессия = роль owner. Личные учётные записи
 * нужны сотрудникам складов и фулфилментов: им нельзя видеть цены, рекламу,
 * себестоимость и чужие склады.
 *
 * Роли:
 *   owner     — всё, включая пользователей и настройки;
 *   manager   — весь кабинет (РОП, менеджеры), в «Складе» всё, кроме пользователей;
 *   buyer     — «Склад»: товары, закупки, цены партий;
 *   warehouse — «Склад», только свои склады, без цен и себестоимости (фулфилменты).
 *
 * Разделы кабинета: роль задаёт набор по умолчанию (ROLE_SECTIONS), владелец
 * может поставить человеку свои галочки (users.sections). Тем, у кого из
 * разделов только «Склад» (фулфилменты, закупщики), сервер закрывает всё,
 * кроме /api/sklad/*; остальным меню показывает только отмеченное.
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { getSkladDb } from './db';
import { audit } from './audit';

export type Role = 'owner' | 'manager' | 'buyer' | 'warehouse';
export const ROLES: Role[] = ['owner', 'manager', 'buyer', 'warehouse'];
export const ROLE_LABEL: Record<Role, string> = {
  owner: 'Владелец',
  manager: 'Менеджер',
  buyer: 'Закупщик',
  warehouse: 'Сотрудник склада',
};

/** Кто делает запрос. id = null — вход по общему паролю (владелец). */
export type AuthUser = {
  id: number | null;
  login: string;
  name: string;
  role: Role;
  /** null = все склады; иначе только эти (роль warehouse). */
  warehouseIds: number[] | null;
  /** Открытые разделы кабинета. */
  sections: Section[];
};

/** Разделы кабинета (= страницы в src/App.tsx). */
export const SECTIONS = ['dashboard', 'sklad', 'prices', 'reviews', 'chats', 'rnp', 'ads', 'competitors', 'collectors', 'settings'] as const;
export type Section = typeof SECTIONS[number];
export const SECTION_LABEL: Record<Section, string> = {
  dashboard: 'Дашборд', sklad: 'Склад', prices: 'Цены', reviews: 'Отзывы и вопросы', chats: 'Чаты с покупателями',
  rnp: 'РНП', ads: 'Реклама', competitors: 'Конкуренты', collectors: 'Сборщики', settings: 'Настройки',
};
export const ROLE_SECTIONS: Record<Role, Section[]> = {
  owner: [...SECTIONS],
  manager: SECTIONS.filter(s => s !== 'settings'),
  buyer: ['sklad'],
  warehouse: ['sklad'],
};

export const OWNER_BY_PASSWORD: AuthUser = { id: null, login: 'owner', name: 'Владелец', role: 'owner', warehouseIds: null, sections: [...SECTIONS] };

/** Открыт ли кабинет шире «Склада» (иначе сервер пускает только в /api/sklad/*). */
export function hasFullCabinet(u: Pick<AuthUser, 'role' | 'sections'>): boolean {
  if (u.role === 'warehouse') return false; // фулфилменту продажи и реклама не нужны никогда
  return u.sections.some(s => s !== 'sklad');
}

function sectionsOf(role: Role, stored: string | null): Section[] {
  if (role === 'owner') return [...SECTIONS];
  if (role === 'warehouse') return ['sklad'];
  if (!stored) return ROLE_SECTIONS[role];
  try {
    const list = (JSON.parse(stored) as string[]).filter((s): s is Section => (SECTIONS as readonly string[]).includes(s));
    return list.includes('sklad') ? list : ['sklad', ...list];
  } catch { return ROLE_SECTIONS[role]; }
}

/** Что хранить в users.sections: NULL, если совпадает с набором роли. */
function storedSections(role: Role, list: string[] | null | undefined): string | null {
  if (!list || role === 'owner' || role === 'warehouse') return null;
  const norm = SECTIONS.filter(s => s === 'sklad' || list.includes(s));
  return JSON.stringify(norm) === JSON.stringify(ROLE_SECTIONS[role]) ? null : JSON.stringify(norm);
}
/** Видит ли роль деньги: себестоимость, цены партий. */
export function canSeeMoney(role: Role): boolean {
  return role !== 'warehouse';
}

// ─── Пароли ────────────────────────────────────────────────────────────────
const SCRYPT_N = 16384;

export function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(pw, salt, 32, { N: SCRYPT_N });
  return `scrypt$${SCRYPT_N}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export function verifyPassword(pw: string, stored: string | null): boolean {
  if (!stored) return false;
  const [algo, n, saltB64, keyB64] = stored.split('$');
  if (algo !== 'scrypt' || !saltB64 || !keyB64) return false;
  const key = Buffer.from(keyB64, 'base64');
  const test = scryptSync(pw, Buffer.from(saltB64, 'base64'), key.length, { N: Number(n) || SCRYPT_N });
  return test.length === key.length && timingSafeEqual(test, key);
}

export function validatePassword(pw: string): string | null {
  if (pw.length < 8) return 'Пароль — не короче 8 символов';
  return null;
}

// ─── Чтение ────────────────────────────────────────────────────────────────
type UserRow = {
  id: number; login: string; name: string; role: Role; pass_hash: string | null;
  tg_id: number | null; active: number; token_ver: number; sections: string | null;
  created_at: number; updated_at: number; last_login_at: number | null;
};

export type UserView = {
  id: number; login: string; name: string; role: Role;
  active: boolean; hasPassword: boolean; warehouseIds: number[];
  /** Итоговые разделы и признак «свои галочки, не по роли». */
  sections: Section[]; customSections: boolean;
  createdAt: number; lastLoginAt: number | null;
};

function warehouseIdsOf(userId: number): number[] {
  return (getSkladDb().prepare('SELECT warehouse_id FROM user_warehouses WHERE user_id = ? ORDER BY warehouse_id')
    .all(userId) as any[]).map(r => Number(r.warehouse_id));
}

function toView(r: UserRow): UserView {
  return {
    id: r.id, login: r.login, name: r.name, role: r.role,
    active: !!r.active, hasPassword: !!r.pass_hash, warehouseIds: warehouseIdsOf(r.id),
    sections: sectionsOf(r.role, r.sections), customSections: !!r.sections && r.role !== 'owner' && r.role !== 'warehouse',
    createdAt: r.created_at, lastLoginAt: r.last_login_at,
  };
}

export function listUsers(): UserView[] {
  return (getSkladDb().prepare('SELECT * FROM users ORDER BY active DESC, role, name').all() as UserRow[]).map(toView);
}

function getRow(id: number): UserRow | undefined {
  return getSkladDb().prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
}

function toAuthUser(r: UserRow): AuthUser {
  return {
    id: r.id, login: r.login, name: r.name, role: r.role,
    warehouseIds: r.role === 'warehouse' ? warehouseIdsOf(r.id) : null,
    sections: sectionsOf(r.role, r.sections),
  };
}

/** Пользователь по сессии: только активный и с той же версией токена. */
export function userForSession(uid: number, ver: number): AuthUser | null {
  const r = getRow(uid);
  if (!r || !r.active || r.token_ver !== ver) return null;
  return toAuthUser(r);
}

export function sessionVersion(uid: number): number {
  return getRow(uid)?.token_ver ?? 0;
}

/** Вход по логину и паролю. null — неверно или учётка выключена. */
export function loginWithPassword(login: string, pw: string): AuthUser | null {
  const r = getSkladDb().prepare('SELECT * FROM users WHERE login = ?').get(login.trim()) as UserRow | undefined;
  if (!r || !r.active || !verifyPassword(pw, r.pass_hash)) return null;
  getSkladDb().prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(Date.now(), r.id);
  return toAuthUser(r);
}

// ─── Изменение ─────────────────────────────────────────────────────────────
export type UserInput = {
  login?: string; name?: string; role?: Role; password?: string;
  active?: boolean; warehouseIds?: number[];
  /** Свои разделы; null — вернуть набор по роли. */
  sections?: string[] | null;
};

function clean(input: UserInput, isNew: boolean): { error?: string } {
  if (isNew || input.login !== undefined) {
    const login = String(input.login ?? '').trim();
    // Логин — придуманное слово или почта сотрудника; писем не шлём, это просто имя для входа.
    if (!/^[a-zA-Z0-9._@+-]{3,64}$/.test(login)) return { error: 'Логин — почта или 3–64 символа: латиница, цифры, точка, дефис' };
  }
  if (isNew || input.name !== undefined) {
    if (!String(input.name ?? '').trim()) return { error: 'Укажите имя' };
  }
  if (isNew || input.role !== undefined) {
    if (!ROLES.includes(input.role as Role)) return { error: 'Неизвестная роль' };
  }
  if (input.password) {
    const e = validatePassword(input.password);
    if (e) return { error: e };
  }
  if (input.sections) {
    const bad = input.sections.filter(s => !(SECTIONS as readonly string[]).includes(s));
    if (bad.length) return { error: `Неизвестные разделы: ${bad.join(', ')}` };
  }
  return {};
}

function setWarehouses(userId: number, ids: number[]): void {
  const d = getSkladDb();
  d.prepare('DELETE FROM user_warehouses WHERE user_id = ?').run(userId);
  const ins = d.prepare('INSERT OR IGNORE INTO user_warehouses (user_id, warehouse_id) VALUES (?, ?)');
  for (const w of [...new Set(ids)]) ins.run(userId, w);
}

function uniqueError(e: unknown): string | null {
  const m = String((e as Error)?.message ?? '');
  if (/users\.login/.test(m)) return 'Такой логин уже есть';
  return null;
}

export function createUser(input: UserInput, by: AuthUser): { user?: UserView; error?: string } {
  const c = clean(input, true);
  if (c.error) return c;
  if (input.role !== 'warehouse' && input.warehouseIds?.length) input.warehouseIds = [];
  if (input.role === 'warehouse' && !input.warehouseIds?.length) return { error: 'Сотруднику склада нужно выбрать хотя бы один склад' };
  if (!input.password) return { error: 'Задайте пароль — иначе пользователь не сможет войти' };
  const d = getSkladDb();
  const now = Date.now();
  try {
    d.exec('BEGIN IMMEDIATE');
    const r = d.prepare(`INSERT INTO users (login, name, role, pass_hash, tg_id, active, sections, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`).run(
      String(input.login).trim(), String(input.name).trim(), input.role,
      hashPassword(input.password), null,
      storedSections(input.role as Role, input.sections), now, now,
    );
    const id = Number(r.lastInsertRowid);
    setWarehouses(id, input.warehouseIds ?? []);
    audit(by, 'user', id, 'create', { login: [null, input.login], role: [null, input.role] });
    d.exec('COMMIT');
    return { user: toView(getRow(id)!) };
  } catch (e) {
    d.exec('ROLLBACK');
    const u = uniqueError(e);
    if (u) return { error: u };
    throw e;
  }
}

export function updateUser(id: number, input: UserInput, by: AuthUser): { user?: UserView; error?: string } {
  const before = getRow(id);
  if (!before) return { error: 'Пользователь не найден' };
  const c = clean(input, false);
  if (c.error) return c;
  const role = input.role ?? before.role;
  const whIds = input.warehouseIds ?? warehouseIdsOf(id);
  if (role === 'warehouse' && !whIds.length) return { error: 'Сотруднику склада нужно выбрать хотя бы один склад' };
  // Нельзя запереть кабинет: последний активный владелец остаётся владельцем.
  if (before.role === 'owner' && (role !== 'owner' || input.active === false)) {
    const owners = Number((getSkladDb().prepare(`SELECT COUNT(*) AS n FROM users WHERE role='owner' AND active=1`).get() as any).n);
    if (owners <= 1 && !process.env.AUTH_PASSWORD) return { error: 'Это последний владелец — нельзя понизить или выключить' };
  }
  const d = getSkladDb();
  const diff: Record<string, [unknown, unknown]> = {};
  const set: string[] = [];
  const args: unknown[] = [];
  const put = (col: string, field: string, from: unknown, to: unknown) => {
    if (to === undefined || to === from) return;
    set.push(`${col} = ?`); args.push(to); diff[field] = [from, to];
  };
  put('login', 'login', before.login, input.login?.trim());
  put('name', 'name', before.name, input.name?.trim());
  put('role', 'role', before.role, input.role);
  if (input.active !== undefined) put('active', 'active', before.active, input.active ? 1 : 0);
  if (input.sections !== undefined || (input.role !== undefined && input.role !== before.role)) {
    // Сменили роль без своих галочек — разделы снова по роли.
    const next = input.sections === undefined ? null : storedSections(role, input.sections);
    put('sections', 'sections', before.sections, next);
  }
  // Смена пароля, роли или выключение — старые сессии этого человека гасим.
  const killSessions = !!input.password || (input.role && input.role !== before.role) || input.active === false
    || diff.sections !== undefined
    || (input.warehouseIds !== undefined && JSON.stringify([...new Set(input.warehouseIds)].sort()) !== JSON.stringify(warehouseIdsOf(id)));
  if (input.password) { set.push('pass_hash = ?'); args.push(hashPassword(input.password)); diff.password = ['***', '***']; }
  if (killSessions) set.push('token_ver = token_ver + 1');
  try {
    d.exec('BEGIN IMMEDIATE');
    if (set.length) d.prepare(`UPDATE users SET ${set.join(', ')}, updated_at = ? WHERE id = ?`).run(...args, Date.now(), id);
    if (input.warehouseIds !== undefined || role !== 'warehouse') {
      const next = role === 'warehouse' ? whIds : [];
      const prev = warehouseIdsOf(id);
      if (JSON.stringify(prev) !== JSON.stringify([...new Set(next)].sort((a, b) => a - b))) diff.warehouses = [prev, next];
      setWarehouses(id, next);
    }
    if (Object.keys(diff).length) audit(by, 'user', id, 'update', diff);
    d.exec('COMMIT');
    return { user: toView(getRow(id)!) };
  } catch (e) {
    d.exec('ROLLBACK');
    const u = uniqueError(e);
    if (u) return { error: u };
    throw e;
  }
}
