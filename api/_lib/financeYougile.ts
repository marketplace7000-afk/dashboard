/**
 * Платёжный календарь → YouGile (21.11.2026, решение владельца).
 *
 * Каждый расход календаря (кроме выводов — это приходы) за 3 дня до даты становится задачей
 * на доске «Платежи» в YouGile: название = операция, дедлайн = дата платежа, исполнитель — партнёр.
 *   • за 3 дня — задача и первое упоминание в её чате;
 *   • за 2 дня, если строка в календаре всё ещё не «Исполнено», — второе упоминание;
 *   • за 1 день (или день платежа) — третье упоминание и плашка «Критически важно».
 * Строка стала «Исполнено» — задача закрывается. Удалена / «Отменено» / «Перенесено» — задача удаляется.
 * Поменяли дату, сумму или название — задача правится; дату отодвинули дальше 3 дней — напоминания начнутся заново.
 *
 * Статус в календаре ставит только человек — отсюда календарь не меняется никогда.
 * Связь «строка ↔ задача» — таблица fin_yougile в базе финансов. Последний проход — fin_setting 'yougile_state'
 * (его читает серверный сторож). Ключ — YOUGILE_KEY в .env сервера (вносит владелец через окно, не через чат).
 * Лимит YouGile — 50 запросов в минуту на компанию: держим паузу 1,3 с между запросами.
 *
 * Настройки (.env): YOUGILE_KEY — обязательно; YOUGILE_BOARD (по умолчанию «Платежи»),
 * YOUGILE_PROJECT (по умолчанию «Александр» — где искать доску, если досок с таким именем несколько),
 * YOUGILE_ASSIGNEE — почта исполнителя (иначе ищем сотрудника по имени «Александр»).
 */
import { dayNum, mskToday, type FinOp } from '../../shared/finance';
import { allOps, finDb } from './finance';

const BASE = 'https://ru.yougile.com/api-v2';
const CRITICAL = 'Критически важно';
const LINK = 'https://e-avtovibe.ru → Финансы → Календарь';
const SKIP = new Set(['Исполнено', 'Отменено', 'Перенесено']);
/** Напоминания пишем днём по Москве, ночью только правим и закрываем задачи. */
const REMIND_FROM_H = 10, REMIND_TO_H = 21;

type Row = { op_id: number; task_id: string; stage: number | null; sig: string; done: number; critical: number };
type Ctx = { columnId: string; userId: string; stickerId: string; stateId: string };

function ensureTable() {
  finDb().exec(`CREATE TABLE IF NOT EXISTS fin_yougile (op_id INTEGER PRIMARY KEY, task_id TEXT NOT NULL, stage INTEGER, sig TEXT NOT NULL DEFAULT '',
    done INTEGER NOT NULL DEFAULT 0, critical INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
}

// ─── запросы к YouGile ────────────────────────────────────────────────────
let lastCall = 0;
class YgError extends Error { constructor(msg: string, public status: number) { super(msg); } }
async function yg(method: string, path: string, body?: unknown): Promise<any> {
  const key = process.env.YOUGILE_KEY; if (!key) throw new YgError('нет ключа YOUGILE_KEY', 0);
  const wait = lastCall + Number(process.env.YOUGILE_GAP_MS ?? 1300) - Date.now(); if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastCall = Date.now();
  const r = await fetch(BASE + path, {
    method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000),
  });
  const text = await r.text(); let j: any = null; try { j = text ? JSON.parse(text) : null; } catch { /* не JSON */ }
  if (!r.ok) throw new YgError(`YouGile ${method} ${path.split('?')[0]} → ${r.status} ${String(j?.error ?? j?.message ?? text).slice(0, 160)}`, r.status);
  return j;
}
const list = async (path: string): Promise<any[]> => ((await yg('GET', path))?.content ?? []).filter((x: any) => !x.deleted);

/** Доска, первая колонка, исполнитель, плашка «Критически важно» (создаётся один раз, если её нет). */
let ctxCache: { at: number; ctx: Ctx } | null = null;
async function context(): Promise<Ctx> {
  if (ctxCache && Date.now() - ctxCache.at < 6 * 3_600_000) return ctxCache.ctx;
  const boardName = process.env.YOUGILE_BOARD || 'Платежи', projName = process.env.YOUGILE_PROJECT || 'Александр';
  let boards = (await list(`/boards?title=${encodeURIComponent(boardName)}&limit=100`)).filter(b => String(b.title).trim().toLowerCase() === boardName.toLowerCase());
  if (boards.length > 1) {
    const projects = (await list(`/projects?title=${encodeURIComponent(projName)}&limit=100`)).map(p => p.id);
    const inProj = boards.filter(b => projects.includes(b.projectId)); if (inProj.length) boards = inProj;
  }
  if (!boards.length) throw new Error(`в YouGile нет доски «${boardName}»`);
  if (boards.length > 1) throw new Error(`в YouGile несколько досок «${boardName}» — уточните YOUGILE_PROJECT`);
  const board = boards[0];
  const cols = await list(`/columns?boardId=${board.id}&limit=100`);
  if (!cols.length) throw new Error(`на доске «${boardName}» нет ни одной колонки`);

  const users = await list('/users?limit=1000');
  const mail = (process.env.YOUGILE_ASSIGNEE || '').trim().toLowerCase();
  const who = mail ? users.filter(u => String(u.email).toLowerCase() === mail)
    : users.filter(u => /^александр(\s|$)/i.test(String(u.realName ?? '').trim()));
  if (who.length !== 1) throw new Error(mail ? 'исполнитель из YOUGILE_ASSIGNEE не найден в YouGile' : `сотрудников «Александр» в YouGile: ${who.length} — укажите YOUGILE_ASSIGNEE`);

  // Плашка: ищем любое поле-стикер с состоянием «Критически важно», иначе создаём «Важность».
  let stickerId = '', stateId = '';
  for (const s of await list('/string-stickers?limit=1000')) {
    const st = (s.states ?? []).find((x: any) => !x.deleted && String(x.name).trim().toLowerCase() === CRITICAL.toLowerCase());
    if (st) { stickerId = s.id; stateId = st.id; break; }
  }
  if (!stickerId) {
    const made = await yg('POST', '/string-stickers', { name: 'Важность', states: [{ name: CRITICAL, color: '#E33B3B' }] });
    stickerId = made.id;
    const full = await yg('GET', `/string-stickers/${stickerId}`);
    stateId = (full.states ?? []).find((x: any) => x.name === CRITICAL)?.id;
    if (!stateId) throw new Error('плашка «Критически важно» создана без состояния');
    console.warn('[yougile] создана плашка «Важность: Критически важно»');
  }
  // Плашка должна быть включена на доске, иначе её не видно на карточках.
  const b = await yg('GET', `/boards/${board.id}`);
  const custom = b?.stickers?.custom ?? {};
  if (!custom[stickerId]) {
    await yg('PUT', `/boards/${board.id}`, { stickers: { ...(b?.stickers ?? {}), custom: { ...custom, [stickerId]: true } } });
    console.warn(`[yougile] плашка «${CRITICAL}» включена на доске «${boardName}»`);
  }
  const ctx = { columnId: cols[0].id, userId: who[0].id, stickerId, stateId };
  ctxCache = { at: Date.now(), ctx };
  return ctx;
}

// ─── тексты ───────────────────────────────────────────────────────────────
const rub = (n: number) => `${Math.round(n).toLocaleString('ru-RU').replace(/ /g, ' ')} ₽`;
const ddmm = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}`;
export const taskTitle = (o: FinOp) => {
  const cat = o.cat.trim(), descr = o.descr.trim();
  const t = cat && descr && !cat.toLowerCase().includes(descr.toLowerCase()) ? `${cat} — ${descr}` : (cat || descr);
  return t.length > 150 ? t.slice(0, 149) + '…' : t;
};
const taskDescr = (o: FinOp) => [
  `Сумма: ${rub(o.plan)}`, `Дата платежа: ${ddmm(o.date)}.${o.date.slice(0, 4)}`,
  o.descr && `Описание: ${o.descr}`, o.account && `Счёт: ${o.account}`, o.comment && `Комментарий: ${o.comment}`,
  '', `Когда оплатите — поставьте строке статус «Исполнено» в платёжном календаре (${LINK}), задача закроется сама.`,
].filter((x): x is string => typeof x === 'string').join('<br>');
const sig = (o: FinOp) => JSON.stringify([o.date, taskTitle(o), o.plan, o.descr, o.account, o.comment]);
/** Мск-полдень даты платежа — чтобы дедлайн не уехал на соседний день ни в одном поясе. */
const deadlineMs = (d: string) => Date.parse(d + 'T09:00:00Z');
export function reminderText(userId: string, o: FinOp, stage: number): string {
  const when = stage >= 3 ? `через 3 дня, ${ddmm(o.date)}` : stage === 2 ? `через 2 дня, ${ddmm(o.date)}` : stage === 1 ? `завтра, ${ddmm(o.date)}` : `сегодня, ${ddmm(o.date)}`;
  const head = stage <= 1 ? `‼️ ${CRITICAL}. ` : stage === 2 ? 'Повторно: ' : '';
  return `[!mention:${userId}!], ${head}${when} — платёж «${taskTitle(o)}» на ${rub(o.plan)}. `
    + `После оплаты отметьте «Исполнено» в платёжном календаре (${LINK}).`;
}
/** Какое напоминание положено сегодня: 3, 2, 1 или 0 (день платежа). null — рано или дата прошла. */
export function stageFor(date: string, today: string): number | null {
  const d = dayNum(date) - dayNum(today);
  return d < 0 || d > 3 ? null : d;
}

// ─── проход ───────────────────────────────────────────────────────────────
export type YgState = { at: string; ok: boolean; error?: string; created: number; reminded: number; closed: number; removed: number; updated: number };
function saveState(s: YgState) {
  finDb().prepare('INSERT INTO fin_setting (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run('yougile_state', JSON.stringify(s));
}
export function ygState(): YgState | null {
  try { const r = finDb().prepare("SELECT v FROM fin_setting WHERE k = 'yougile_state'").get() as { v: string } | undefined; return r ? JSON.parse(r.v) : null; } catch { return null; }
}

let running = false;
export async function syncYougile(now = Date.now()): Promise<YgState | null> {
  if (!process.env.YOUGILE_KEY) return null;   // ключ ещё не внесён — связка спит
  if (running) return null; running = true;
  const st: YgState = { at: new Date(now).toISOString(), ok: true, created: 0, reminded: 0, closed: 0, removed: 0, updated: 0 };
  try {
    ensureTable();
    const ctx = await context();
    const today = new Date(now + 3 * 3_600_000).toISOString().slice(0, 10);
    const hour = new Date(now + 3 * 3_600_000).getUTCHours();
    const canRemind = hour >= REMIND_FROM_H && hour < REMIND_TO_H;
    const ops = new Map(allOps().map(o => [o.id, o]));
    const rows = finDb().prepare('SELECT * FROM fin_yougile').all() as Row[];
    const touch = (opId: number, f: Partial<Row>) => {
      const keys = Object.keys(f); if (!keys.length) return;
      finDb().prepare(`UPDATE fin_yougile SET ${keys.map(k => `${k} = @${k}`).join(', ')}, updated_at = @at WHERE op_id = @op_id`).run({ ...f, at: new Date().toISOString(), op_id: opId });
    };
    const drop = (opId: number) => finDb().prepare('DELETE FROM fin_yougile WHERE op_id = ?').run(opId);
    /** Задачу удалили в YouGile руками — забываем связь, в следующий проход она создастся заново. */
    const gone = (e: unknown) => e instanceof YgError && (e.status === 404 || e.status === 410);

    // 1) Уже связанные задачи: закрыть, удалить, поправить.
    for (const r of rows) {
      const o = ops.get(r.op_id);
      try {
        if (!o || o.type !== 'out' || o.status === 'Отменено' || o.status === 'Перенесено') {
          await yg('PUT', `/tasks/${r.task_id}`, { deleted: true }); drop(r.op_id); st.removed++; continue;
        }
        if (o.status === 'Исполнено') {
          if (!r.done) { await yg('PUT', `/tasks/${r.task_id}`, { completed: true }); touch(r.op_id, { done: 1 }); st.closed++; }
          continue;
        }
        if (r.done) { await yg('PUT', `/tasks/${r.task_id}`, { completed: false }); touch(r.op_id, { done: 0 }); }   // «Исполнено» сняли обратно
        if (r.sig !== sig(o)) {
          const far = stageFor(o.date, today) === null && o.date > today;   // дату отодвинули дальше 3 дней
          await yg('PUT', `/tasks/${r.task_id}`, {
            title: taskTitle(o), description: taskDescr(o), deadline: { deadline: deadlineMs(o.date), withTime: false },
            ...(far && r.critical ? { stickers: { [ctx.stickerId]: '-' } } : {}),
          });
          touch(r.op_id, far ? { sig: sig(o), stage: null, critical: 0 } : { sig: sig(o) }); st.updated++;
          r.stage = far ? null : r.stage; r.critical = far ? 0 : r.critical;
        }
        const want = stageFor(o.date, today);
        if (want !== null && canRemind && (r.stage === null || want < r.stage)) {
          if (want <= 1 && !r.critical) { await yg('PUT', `/tasks/${r.task_id}`, { stickers: { [ctx.stickerId]: ctx.stateId } }); touch(r.op_id, { critical: 1 }); }
          await yg('POST', `/chats/${r.task_id}/messages`, { text: reminderText(ctx.userId, o, want) });
          touch(r.op_id, { stage: want }); st.reminded++;
        }
      } catch (e) {
        if (gone(e)) { drop(r.op_id); continue; }
        throw e;
      }
      ops.delete(r.op_id);
    }

    // 2) Новые задачи: расходы с датой через 0–3 дня, ещё не исполненные.
    if (canRemind) {
      const linked = new Set(rows.map(r => r.op_id));
      for (const o of ops.values()) {
        if (linked.has(o.id) || o.type !== 'out' || SKIP.has(o.status) || !(o.plan > 0)) continue;
        const want = stageFor(o.date, today); if (want === null) continue;
        const crit = want <= 1;
        const t = await yg('POST', '/tasks', {
          title: taskTitle(o), columnId: ctx.columnId, description: taskDescr(o), assigned: [ctx.userId],
          deadline: { deadline: deadlineMs(o.date), withTime: false },
          ...(crit ? { stickers: { [ctx.stickerId]: ctx.stateId } } : {}),        });
        if (!t?.id) throw new Error('YouGile не вернул id новой задачи');
        const at = new Date().toISOString();
        finDb().prepare('INSERT INTO fin_yougile (op_id, task_id, stage, sig, done, critical, created_at, updated_at) VALUES (?, ?, NULL, ?, 0, ?, ?, ?)')
          .run(o.id, t.id, sig(o), crit ? 1 : 0, at, at);
        st.created++;
        await yg('POST', `/chats/${t.id}/messages`, { text: reminderText(ctx.userId, o, want) });
        touch(o.id, { stage: want }); st.reminded++;
      }
    }
  } catch (e) {
    st.ok = false; st.error = (e as Error).message;
    ctxCache = null;
    console.warn('[yougile] проход не удался:', st.error);
  } finally {
    running = false;
    try { saveState(st); } catch { /* база занята — следующий проход запишет */ }
  }
  if (st.ok && (st.created || st.reminded || st.closed || st.removed || st.updated))
    console.warn(`[yougile] задач создано ${st.created}, напоминаний ${st.reminded}, закрыто ${st.closed}, удалено ${st.removed}, поправлено ${st.updated}`);
  return st;
}
