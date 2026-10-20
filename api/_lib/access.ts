/**
 * /api/access/* — «Доступы»: учётные записи сотрудников и их разделы.
 * Только для владельца. Не зависит от раздела «Склад» (тот может быть в
 * архиве — api/_lib/sklad/archive.ts), хотя учётки живут в той же базе.
 *
 *   GET  /api/access          → { users, roles, sections, archivedSklad }
 *   POST /api/access          → создать { login, name, role, password, sections? }
 *   POST /api/access/:id      → изменить (те же поля + active)
 *   GET  /api/access/journal  → журнал изменений учёток
 *
 * Пока «Склад» в архиве, роли «Закупщик» и «Сотрудник склада» (им открыт
 * только «Склад») не выдаются, а раздела «Склад» нет среди галочек.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import type { AuthUser } from './sklad/users';

export async function handleAccess(req: VercelRequest, res: VercelResponse, rest: string[], user: AuthUser) {
  if (user.role !== 'owner') return res.status(403).json({ error: 'forbidden', reason: 'Доступы выдаёт только владелец' });
  try {
    const users = await import('./sklad/users');
    const { SKLAD_ARCHIVED } = await import('./sklad/archive');
    const { listAudit } = await import('./sklad/audit');
    const body = () => (typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body ?? {}));
    const roles = users.ROLES.filter(r => !SKLAD_ARCHIVED || r === 'owner' || r === 'manager');
    const sections = users.SECTIONS.filter(s => !SKLAD_ARCHIVED || s !== 'sklad');
    const clean = (input: any) => {
      if (SKLAD_ARCHIVED && input?.role && !roles.includes(input.role)) return { error: 'Эта роль недоступна, пока раздел «Склад» в архиве' };
      return null;
    };
    const [a] = rest;

    if (req.method !== 'POST') {
      if (a === 'journal') {
        return res.status(200).json({ ok: true, journal: listAudit({ entity: 'user', limit: 200 }) });
      }
      return res.status(200).json({
        ok: true,
        users: users.listUsers().map(u => ({ ...u, sections: u.sections.filter(s => sections.includes(s)) })),
        roles: roles.map(r => ({ value: r, label: users.ROLE_LABEL[r], sections: users.ROLE_SECTIONS[r].filter(s => sections.includes(s)) })),
        sections: sections.map(s => ({ value: s, label: users.SECTION_LABEL[s] })),
        archivedSklad: SKLAD_ARCHIVED,
      });
    }

    const input = body();
    const bad = clean(input);
    if (bad) return res.status(400).json({ ok: false, ...bad });
    const id = Number(a);
    const r = Number.isInteger(id) && id > 0 ? users.updateUser(id, input, user) : users.createUser(input, user);
    if (r.error) return res.status(400).json({ ok: false, error: r.error });
    return res.status(200).json({ ok: true, user: r.user });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String((e as Error)?.message ?? e).slice(0, 300) });
  }
}
