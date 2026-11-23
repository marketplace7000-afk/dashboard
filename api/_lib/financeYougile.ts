/**
 * Платёжный календарь → YouGile (21.11.2026, решение владельца).
 *
 * 23.11: ОДНА задача в день «Пора платить по платежам · ДД.ММ» (колонка «К работе» проекта «Александр», доска «Бизнес задачи»),
 * если есть расходы календаря (кроме выводов — это приходы) с датой в ближайшие 3 дня или просроченные и не «Исполнено».
 * Список операций — в описании и в комментарии с упоминанием Александра. «Исполнено» — строка уходит из списка,
 * всё оплачено — задача закрывается; на следующий день вчерашняя закрывается и приходит новая. Платёж сегодня/завтра — плашка
 * «Критически важно». (21–23.11 была задача на каждый платёж — владелец попросил одну: так ничего не теряется.)
 *
 * Статус в календаре ставит только человек — отсюда календарь не меняется никогда.
 * Задачи дней — таблица fin_yougile_day в базе финансов (fin_yougile — от старой схемы, очищается). Последний проход — fin_setting 'yougile_state'
 * (его читает серверный сторож). Ключ — YOUGILE_KEY в .env сервера (вносит владелец через окно, не через чат).
 * Лимит YouGile — 50 запросов в минуту на компанию: держим паузу 1,3 с между запросами.
 *
 * Настройки (.env): YOUGILE_KEY — обязательно; YOUGILE_PROJECT (по умолчанию «Александр»), YOUGILE_COLUMN (по умолчанию «К работе»),
 * YOUGILE_BOARD — если колонок с таким именем в проекте несколько,
 * YOUGILE_ASSIGNEE — почта исполнителя (иначе ищем сотрудника по имени «Александр»).
 */
import { dayNum, type FinOp } from '../../shared/finance';
import { allOps, finDb } from './finance';

const BASE = 'https://ru.yougile.com/api-v2';
const CRITICAL = 'Критически важно';
const LINK = 'https://e-avtovibe.ru → Финансы → Календарь';
const SKIP = new Set(['Исполнено', 'Отменено', 'Перенесено']);
/** Напоминания пишем днём по Москве, ночью только правим и закрываем задачи. */
const REMIND_FROM_H = 10, REMIND_TO_H = 21;

type Day = { day: string; task_id: string; sig: string; critical: number; done: number };
type Ctx = { columnId: string; userId: string; stickerId: string; stateId: string };

function ensureTable() {
  finDb().exec(`CREATE TABLE IF NOT EXISTS fin_yougile (op_id INTEGER PRIMARY KEY, task_id TEXT NOT NULL, stage INTEGER, sig TEXT NOT NULL DEFAULT '',
    done INTEGER NOT NULL DEFAULT 0, critical INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS fin_yougile_day (day TEXT PRIMARY KEY, task_id TEXT NOT NULL, sig TEXT NOT NULL DEFAULT '', critical INTEGER NOT NULL DEFAULT 0,
    done INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
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

/**
 * Куда ставить задачи: колонка «К работе» (регистр не важен) на досках проекта «Александр» — сейчас это
 * доска «Бизнес задачи». Исполнитель — Александр. Плашка — состояние «критично/критически важно» у любого
 * стикера компании (у владельца это «Приоритет: критично важно»); нет такого — создаём «Важность: Критически важно».
 */
const norm = (s: unknown) => String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
const IS_CRITICAL = /^критич\S*\s+важно$/i;
let ctxCache: { at: number; ctx: Ctx } | null = null;
async function context(): Promise<Ctx> {
  if (ctxCache && Date.now() - ctxCache.at < 6 * 3_600_000) return ctxCache.ctx;
  const projName = process.env.YOUGILE_PROJECT || 'Александр', colName = process.env.YOUGILE_COLUMN || 'К работе', boardName = process.env.YOUGILE_BOARD || '';
  const projects = (await list('/projects?limit=1000')).filter(p => norm(p.title) === norm(projName));
  if (projects.length !== 1) throw new Error(`проектов «${projName}» в YouGile: ${projects.length}`);
  const boards = (await list(`/boards?projectId=${projects[0].id}&limit=1000`)).filter(b => !boardName || norm(b.title) === norm(boardName));
  const cols: any[] = [];
  for (const b of boards) for (const c of await list(`/columns?boardId=${b.id}&limit=100`)) if (norm(c.title) === norm(colName)) cols.push({ ...c, board: b });
  if (cols.length !== 1) throw new Error(`колонок «${colName}» в проекте «${projName}»: ${cols.length}${cols.length > 1 ? ' — укажите YOUGILE_BOARD' : ''}`);
  const board = cols[0].board;

  const users = await list('/users?limit=1000');
  const mail = norm(process.env.YOUGILE_ASSIGNEE);
  const who = mail ? users.filter(u => norm(u.email) === mail) : users.filter(u => /^александр(\s|$)/i.test(String(u.realName ?? '').trim()));
  if (who.length !== 1) throw new Error(mail ? 'исполнитель из YOUGILE_ASSIGNEE не найден в YouGile' : `сотрудников «Александр» в YouGile: ${who.length} — укажите YOUGILE_ASSIGNEE`);

  let stickerId = '', stateId = '';
  for (const s of await list('/string-stickers?limit=1000')) {
    const st = (s.states ?? []).find((x: any) => !x.deleted && IS_CRITICAL.test(String(x.name).trim()));
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
    console.warn(`[yougile] плашка важности включена на доске «${board.title}»`);
  }
  const ctx = { columnId: cols[0].id, userId: who[0].id, stickerId, stateId };
  ctxCache = { at: Date.now(), ctx };
  return ctx;
}


// ─── тексты ───────────────────────────────────────────────────────────────
const rub = (n: number) => `${Math.round(n).toLocaleString('ru-RU').replace(/ /g, ' ')} ₽`;
const ddmm = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}`;
export const opName = (o: FinOp) => {
  const cat = o.cat.trim(), descr = o.descr.trim();
  const t = cat && descr && !cat.toLowerCase().includes(descr.toLowerCase()) ? `${cat} — ${descr}` : (cat || descr);
  return t.length > 150 ? t.slice(0, 149) + '…' : t;
};
/** Мск-полдень даты — чтобы дедлайн не уехал на соседний день ни в одном поясе. */
const deadlineMs = (d: string) => Date.parse(d + 'T09:00:00Z');
const whenLabel = (date: string, today: string) => {
  const d = dayNum(date) - dayNum(today);
  return d < 0 ? `просрочено (${ddmm(date)})` : d === 0 ? `сегодня, ${ddmm(date)}` : d === 1 ? `завтра, ${ddmm(date)}` : `${ddmm(date)}, через ${d} дн.`;
};

/**
 * Что надо оплатить: расходы календаря (выводы — приходы, их нет) с датой не позже чем через 3 дня,
 * ещё не «Исполнено» / не отменённые / не перенесённые. Просроченные за последние 14 дней тоже — пока не отмечены.
 */
export function dueOps(ops: FinOp[], today: string): FinOp[] {
  const t = dayNum(today);
  return ops.filter(o => o.type === 'out' && !SKIP.has(o.status) && o.plan > 0 && dayNum(o.date) <= t + 3 && dayNum(o.date) >= t - 14)
    .sort((a, b) => a.date.localeCompare(b.date) || b.plan - a.plan);
}
/** Список операций по дням — и в описание задачи, и в комментарий к ней. */
export function digestLines(list: FinOp[], today: string): string[] {
  const out: string[] = []; let day = '';
  for (const o of list) {
    if (o.date !== day) { day = o.date; out.push('', `📅 ${whenLabel(o.date, today)}`); }
    out.push(`• ${opName(o)} — ${rub(o.plan)}${o.account ? ` (${o.account})` : ''}`);
  }
  const total = list.reduce((s, o) => s + o.plan, 0);
  out.push('', `Итого: ${list.length} ${plural(list.length)} на ${rub(total)}`);
  return out.slice(1);
}
const plural = (n: number) => (n % 10 === 1 && n % 100 !== 11 ? 'платёж' : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? 'платежа' : 'платежей');
export const digestTitle = (today: string) => `Пора платить по платежам · ${ddmm(today)}`;
const digestDescr = (list: FinOp[], today: string) => [...digestLines(list, today), '',
  `Оплатили — поставьте строке «Исполнено» в платёжном календаре (${LINK}): она уйдёт из списка. Всё оплачено — задача закроется сама.`].join('<br>');
export const digestMessage = (userId: string, list: FinOp[], today: string) =>
  [`[!mention:${userId}!], дорогой друг, пора платить по платежам 👇`, '', ...digestLines(list, today), '',
    `После оплаты отметьте «Исполнено» в платёжном календаре (${LINK}).`].join('\n');
const listSig = (list: FinOp[]) => JSON.stringify(list.map(o => [o.id, o.date, o.plan, opName(o), o.account]));

// ─── проход ───────────────────────────────────────────────────────────────
export type YgState = { at: string; ok: boolean; error?: string; created: number; updated: number; closed: number; removed: number; due: number };
function saveState(s: YgState) {
  finDb().prepare('INSERT INTO fin_setting (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run('yougile_state', JSON.stringify(s));
}
export function ygState(): YgState | null {
  try { const r = finDb().prepare("SELECT v FROM fin_setting WHERE k = 'yougile_state'").get() as { v: string } | undefined; return r ? JSON.parse(r.v) : null; } catch { return null; }
}

/**
 * 23.11 (просьба владельца): одна задача в день вместо задачи на каждый платёж — «много задач, всё теряется из фокуса».
 *   • с 10:00 МСК, если есть что оплатить в ближайшие 3 дня (или просрочено) — задача «Пора платить по платежам · ДД.ММ»
 *     с полным списком в описании и в комментарии с упоминанием Александра; вчерашняя задача закрывается;
 *   • в течение дня строки, отмеченные «Исполнено», уходят из списка (описание правится); всё оплачено — задача закрывается;
 *   • есть платёж сегодня/завтра/просроченный — плашка «Критически важно».
 * Задачи старой схемы (по одной на платёж, 22–23.11) удаляются при первом проходе.
 */
let running = false;
export async function syncYougile(now = Date.now()): Promise<YgState | null> {
  if (!process.env.YOUGILE_KEY) return null;   // ключ не внесён — связка спит
  if (running) return null; running = true;
  const st: YgState = { at: new Date(now).toISOString(), ok: true, created: 0, updated: 0, closed: 0, removed: 0, due: 0 };
  try {
    ensureTable();
    const ctx = await context();
    const msk = new Date(now + 3 * 3_600_000), today = msk.toISOString().slice(0, 10), hour = msk.getUTCHours();
    const canPost = hour >= REMIND_FROM_H && hour < REMIND_TO_H;
    const at = () => new Date().toISOString();
    const gone = (e: unknown) => e instanceof YgError && (e.status === 404 || e.status === 410);

    // 0) Старая схема: задачи по одной на платёж — убрать.
    for (const r of finDb().prepare('SELECT op_id, task_id FROM fin_yougile').all() as Array<{ op_id: number; task_id: string }>) {
      try { await yg('PUT', `/tasks/${r.task_id}`, { deleted: true }); st.removed++; } catch (e) { if (!gone(e)) throw e; }
      finDb().prepare('DELETE FROM fin_yougile WHERE op_id = ?').run(r.op_id);
    }

    const list = dueOps(allOps(), today); st.due = list.length;
    const sigNow = listSig(list), crit = list.some(o => dayNum(o.date) <= dayNum(today) + 1);
    const open = finDb().prepare('SELECT * FROM fin_yougile_day WHERE done = 0 ORDER BY day').all() as Day[];

    // 1) Задачи прошлых дней — закрыть: их список переехал в сегодняшнюю (или всё оплачено).
    for (const d of open.filter(d => d.day < today)) {
      if (!canPost && list.length) continue;   // ночью не трогаем — утром закроем вместе с новой
      try {
        await yg('PUT', `/tasks/${d.task_id}`, { completed: true });
        await yg('POST', `/chats/${d.task_id}/messages`, { text: list.length ? `Список обновлён — новая задача «${digestTitle(today)}».` : 'Все платежи из списка оплачены 👍' });
      } catch (e) { if (!gone(e)) throw e; }
      finDb().prepare('UPDATE fin_yougile_day SET done = 1, updated_at = ? WHERE day = ?').run(at(), d.day); st.closed++;
    }

    // 2) Сегодняшняя задача.
    let cur = open.find(d => d.day === today) ?? null;
    if (cur) {
      try {
        if (!list.length) {
          await yg('PUT', `/tasks/${cur.task_id}`, { completed: true });
          await yg('POST', `/chats/${cur.task_id}/messages`, { text: 'Все платежи оплачены 👍 Задача закрыта.' });
          finDb().prepare('UPDATE fin_yougile_day SET done = 1, updated_at = ? WHERE day = ?').run(at(), today); st.closed++;
        } else if (cur.sig !== sigNow || !!cur.critical !== crit) {
          await yg('PUT', `/tasks/${cur.task_id}`, {
            description: digestDescr(list, today), deadline: { deadline: deadlineMs(list[0].date < today ? today : list[0].date), withTime: false },
            stickers: { [ctx.stickerId]: crit ? ctx.stateId : '-' },
          });
          finDb().prepare('UPDATE fin_yougile_day SET sig = ?, critical = ?, updated_at = ? WHERE day = ?').run(sigNow, crit ? 1 : 0, at(), today); st.updated++;
        }
      } catch (e) {
        if (!gone(e)) throw e;
        finDb().prepare('DELETE FROM fin_yougile_day WHERE day = ?').run(today); cur = null;   // удалили руками — поставим заново
      }
    }
    const doneToday = finDb().prepare('SELECT 1 FROM fin_yougile_day WHERE day = ?').get(today);
    if (!cur && !doneToday && list.length && canPost) {
      const t = await yg('POST', '/tasks', {
        title: digestTitle(today), columnId: ctx.columnId, description: digestDescr(list, today), assigned: [ctx.userId],
        deadline: { deadline: deadlineMs(list[0].date < today ? today : list[0].date), withTime: false },
        ...(crit ? { stickers: { [ctx.stickerId]: ctx.stateId } } : {}),
      });
      if (!t?.id) throw new Error('YouGile не вернул id новой задачи');
      finDb().prepare('INSERT INTO fin_yougile_day (day, task_id, sig, critical, done, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)')
        .run(today, t.id, sigNow, crit ? 1 : 0, at(), at());
      st.created++;
      await yg('POST', `/chats/${t.id}/messages`, { text: digestMessage(ctx.userId, list, today) });
    }
  } catch (e) {
    st.ok = false; st.error = (e as Error).message;
    ctxCache = null;
    console.warn('[yougile] проход не удался:', st.error);
  } finally {
    running = false;
    try { saveState(st); } catch (e) { console.warn('[yougile] состояние прохода не записано:', (e as Error).message); }
  }
  if (st.ok && (st.created || st.updated || st.closed || st.removed))
    console.warn(`[yougile] задача дня: создано ${st.created}, поправлено ${st.updated}, закрыто ${st.closed}, старых удалено ${st.removed}; платежей в списке ${st.due}`);
  return st;
}
