/**
 * Проверка связки «Платёжный календарь → YouGile» на поддельном YouGile (23.11.2026 — одна задача в день):
 * задача дня со списком платежей на 3 дня вперёд и просроченных, «Исполнено» убирает строку, всё оплачено — задача закрыта,
 * назавтра вчерашняя закрывается, плашка при платеже сегодня/завтра, выводы (приходы) не берём, ночью не пишем,
 * задачи старой схемы (по одной на платёж) удаляются. Запуск: npx tsx scripts/check-fin-yougile.ts
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let fails = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fails++; console.error(`✗ ${name}: получили ${JSON.stringify(got)}, ждали ${JSON.stringify(want)}`); } else console.log(`✓ ${name}`);
};

// ─── поддельный YouGile ───────────────────────────────────────────────────
type Task = { id: string; col: string; title: string; description?: string; deadline?: any; stickers: Record<string, string>; completed: boolean; deleted: boolean; assigned: string[]; msgs: string[] };
const tasks = new Map<string, Task>(); let seq = 0;
const stickers: any[] = [{ id: 'S1', name: 'Приоритет', states: [{ id: 'ST0', name: 'срочно' }, { id: 'ST1', name: 'критично важно' }] }]; let boardCustom: Record<string, boolean> = {};
(globalThis as any).fetch = async (url: string, init: any) => {
  const u = new URL(url); const path = u.pathname.replace('/api-v2', ''); const m = init?.method ?? 'GET';
  const body = init?.body ? JSON.parse(init.body) : undefined;
  const ok = (j: unknown, status = 200) => new Response(JSON.stringify(j), { status });
  if (m === 'GET' && path === '/projects') return ok({ content: [{ id: 'P1', title: 'Александр' }, { id: 'P2', title: 'Дмитрий' }] });
  if (m === 'GET' && path === '/boards') return ok({ content: u.searchParams.get('projectId') === 'P1' ? [{ id: 'B1', title: 'Бизнес задачи', projectId: 'P1' }, { id: 'B2', title: 'Заметки', projectId: 'P1' }] : [] });
  if (m === 'GET' && path === '/boards/B1') return ok({ id: 'B1', stickers: { deadline: true, custom: boardCustom } });
  if (m === 'PUT' && path === '/boards/B1') { boardCustom = body.stickers.custom; return ok({ id: 'B1' }); }
  if (m === 'GET' && path === '/columns') return ok({ content: u.searchParams.get('boardId') === 'B1' ? [{ id: 'C0', title: 'Выполнены' }, { id: 'C1', title: 'К Работе' }] : [{ id: 'C9', title: 'Новая колонка' }] });
  if (m === 'GET' && path === '/users') return ok({ content: [{ id: 'U-A', realName: 'Александр Алешко', email: 'a@x' }, { id: 'U-D', realName: 'Дмитрий', email: 'd@x' }] });
  if (m === 'GET' && path === '/string-stickers') return ok({ content: stickers });
  if (m === 'POST' && path === '/string-stickers') { const s = { id: 'S1', name: body.name, states: body.states.map((x: any, i: number) => ({ ...x, id: 'ST' + i })) }; stickers.push(s); return ok({ id: 'S1' }, 201); }
  if (m === 'GET' && path === '/string-stickers/S1') return ok(stickers[0]);
  if (m === 'POST' && path === '/tasks') {
    const id = 'T' + (++seq);
    tasks.set(id, { id, col: body.columnId, title: body.title, description: body.description, deadline: body.deadline, stickers: body.stickers ?? {}, completed: false, deleted: false, assigned: body.assigned, msgs: [] });
    return ok({ id }, 201);
  }
  const tm = path.match(/^\/tasks\/(T\d+)$/);
  if (tm && m === 'PUT') {
    const t = tasks.get(tm[1]); if (!t || t.deleted) return ok({ error: 'not found' }, 404);
    if (body.title) t.title = body.title;
    if (body.description) t.description = body.description;
    if (body.deadline) t.deadline = body.deadline;
    if (body.completed !== undefined) t.completed = body.completed;
    if (body.deleted) t.deleted = true;
    if (body.stickers) for (const [k, v] of Object.entries(body.stickers)) { if (v === '-') delete t.stickers[k]; else t.stickers[k] = v as string; }
    return ok({ id: t.id });
  }
  const cm = path.match(/^\/chats\/(T\d+)\/messages$/);
  if (cm && m === 'POST') { const t = tasks.get(cm[1]); if (!t || t.deleted) return ok({ error: 'not found' }, 404); t.msgs.push(body.text); return ok({ id: Date.now() }, 201); }
  return ok({ error: 'unknown ' + m + ' ' + path }, 404);
};

(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fin-yg-'));
  process.env.CACHE_DIR = dir; process.env.YOUGILE_KEY = 'test'; process.env.YOUGILE_GAP_MS = '0';
  const f = await import('../api/_lib/finance');
  const y = await import('../api/_lib/financeYougile');
  const ddate = (t: Task) => new Date(t.deadline.deadline + 3 * 3_600_000).toISOString().slice(0, 10);
  const open = () => [...tasks.values()].filter(t => !t.deleted && !t.completed);
  try {
    const at = (day: string, h = 11) => Date.parse(`${day}T${String(h - 3).padStart(2, '0')}:00:00Z`);   // h — час по Москве

    const kofi = f.saveOp({ date: '2026-11-25', type: 'out', cat: 'Ко-Фи — платёж по займу', descr: '', plan: 117280, status: 'План' }, 'проверка');
    const salary = f.saveOp({ date: '2026-11-25', type: 'out', cat: 'ЗП дизайнера', descr: '', plan: 30000, status: 'Подтверждено' }, 'проверка');
    f.saveOp({ date: '2026-11-24', type: 'in', cat: 'Выплата Ozon', descr: '', plan: 500000, status: 'Подтверждено' }, 'проверка');
    f.saveOp({ date: '2026-12-10', type: 'out', cat: 'Аренда помещения', descr: '', plan: 50000, status: 'План' }, 'проверка');
    f.saveOp({ date: '2026-11-01', type: 'out', cat: 'Старый неотмеченный', descr: '', plan: 1000, status: 'План' }, 'проверка');

    // Задача старой схемы (по одной на платёж) — должна удалиться при первом проходе.
    tasks.set('T0', { id: 'T0', col: 'C1', title: 'Ко-Фи — платёж по займу', stickers: {}, completed: false, deleted: false, assigned: ['U-A'], msgs: [] });
    f.finDb().exec(`CREATE TABLE IF NOT EXISTS fin_yougile (op_id INTEGER PRIMARY KEY, task_id TEXT NOT NULL, stage INTEGER, sig TEXT NOT NULL DEFAULT '',
      done INTEGER NOT NULL DEFAULT 0, critical INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
    f.finDb().prepare("INSERT INTO fin_yougile (op_id, task_id, created_at, updated_at) VALUES (?, 'T0', 'x', 'x')").run(kofi.id);

    const night = await y.syncYougile(at('2026-11-22', 4));
    check('ночью задачу не ставим, старую по платежу убрали', [night?.ok, open().length, tasks.get('T0')!.deleted], [true, 0, true]);

    const s1 = await y.syncYougile(at('2026-11-22'));
    const d1 = open();
    check('утром — одна задача на все платежи ближайших 3 дней', [s1?.created, d1.length, d1[0]?.title], [1, 1, 'Пора платить по платежам · 22.11']);
    check('в задаче: Александр, колонка «К работе», дедлайн — ближайший платёж', [d1[0].assigned, d1[0].col, ddate(d1[0])], [['U-A'], 'C1', '2026-11-25']);
    const msg = d1[0].msgs[0] ?? '';
    check('комментарий: упоминание, оба платежа, итог; вывод, аренда и старьё не попали',
      [msg.startsWith('[!mention:U-A!], дорогой друг, пора платить'), msg.includes('Ко-Фи — платёж по займу — 117 280 ₽'), msg.includes('ЗП дизайнера'), msg.includes('Итого: 2 платежа на 147 280 ₽'),
        msg.includes('Выплата Ozon'), msg.includes('Аренда'), msg.includes('Старый')], [true, true, true, true, false, false, false]);
    check('за 3 дня плашки нет', Object.keys(d1[0].stickers).length, 0);

    const again = await y.syncYougile(at('2026-11-22', 15));
    check('в тот же день вторую задачу не ставим', [again?.created, open().length, d1[0].msgs.length], [0, 1, 1]);

    f.saveOp({ ...salary, status: 'Исполнено', fact: 30000 }, 'проверка');
    const s2 = await y.syncYougile(at('2026-11-22', 16));
    check('отметили «Исполнено» — строка ушла из списка (описание поправлено)', [s2?.updated, d1[0].description.includes('ЗП дизайнера'), d1[0].description.includes('Итого: 1 платёж')], [1, false, true]);

    const s3 = await y.syncYougile(at('2026-11-24'));
    const d2 = open();
    check('на следующий день: вчерашняя закрыта, новая одна, с плашкой (платёж завтра)', [s3?.closed, d1[0].completed, d2.length, d2[0]?.title, d2[0]?.stickers.S1], [1, true, 1, 'Пора платить по платежам · 24.11', 'ST1']);
    check('в новой — «завтра, 25.11»', (d2[0]?.msgs[0] ?? '').includes('завтра, 25.11'), true);

    f.saveOp({ ...kofi, status: 'Исполнено', fact: 117280 }, 'проверка');
    const s4 = await y.syncYougile(at('2026-11-24', 13));
    check('всё оплачено — задача закрыта', [s4?.closed, d2[0].completed, open().length], [1, true, 0]);
    await y.syncYougile(at('2026-11-24', 14));
    check('после закрытия в тот же день новую не ставим', open().length, 0);

    const late = f.saveOp({ date: '2026-11-24', type: 'out', cat: 'Услуги банка', descr: '', plan: 990, status: 'План' }, 'проверка');
    await y.syncYougile(at('2026-11-26'));
    const d3 = open();
    check('просроченный и не отмеченный — в списке, с плашкой', [d3.length, (d3[0]?.msgs[0] ?? '').includes('просрочено (24.11)'), d3[0]?.stickers.S1], [1, true, 'ST1']);

    // Задачу дня удалили руками — ставится заново.
    d3[0].deleted = true;
    f.saveOp({ ...late, plan: 1200 }, 'проверка');
    await y.syncYougile(at('2026-11-26', 12));
    await y.syncYougile(at('2026-11-26', 13));
    check('задачу дня удалили руками — поставлена заново', open().length, 1);

    check('последний проход записан', y.ygState()?.ok, true);
    delete process.env.YOUGILE_KEY;
    check('без ключа связка спит', await y.syncYougile(at('2026-11-27')), null);
  } finally { f.closeFinDb(); rmSync(dir, { recursive: true, force: true }); }
  if (fails) { console.error(`check-fin-yougile: ошибок ${fails}`); process.exit(1); }
  console.log('check-fin-yougile: всё верно');
})();
