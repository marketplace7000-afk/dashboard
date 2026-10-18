/**
 * Журнал действий «Склада»: кто, когда и что изменил.
 * Пишется в той же транзакции, что и само изменение, — запись без следа
 * в журнале невозможна.
 */
import { getSkladDb } from './db';
import type { AuthUser } from './users';

export function audit(
  by: Pick<AuthUser, 'id' | 'name'>,
  entity: string,
  entityId: string | number,
  action: string,
  diff: Record<string, unknown> = {},
): void {
  getSkladDb().prepare(`INSERT INTO audit_log (ts, user_id, user_name, entity, entity_id, action, diff)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(Date.now(), by.id, by.name, entity, String(entityId), action, JSON.stringify(diff));
}

export type AuditRow = {
  id: number; ts: number; userName: string; entity: string; entityId: string; action: string;
  diff: Record<string, unknown>;
};

export function listAudit(opts: { entity?: string; entityId?: string; limit?: number } = {}): AuditRow[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (opts.entity) { where.push('entity = ?'); args.push(opts.entity); }
  if (opts.entityId) { where.push('entity_id = ?'); args.push(opts.entityId); }
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 1000);
  const rows = getSkladDb().prepare(`SELECT * FROM audit_log ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY id DESC LIMIT ${limit}`).all(...args) as any[];
  return rows.map(r => {
    let diff: Record<string, unknown> = {};
    try { diff = JSON.parse(r.diff); } catch { /* битый JSON — показываем пусто */ }
    return { id: r.id, ts: r.ts, userName: r.user_name, entity: r.entity, entityId: r.entity_id, action: r.action, diff };
  });
}
