/**
 * Проверка связки «Платёжный календарь → YouGile» (21.11.2026) на поддельном YouGile:
 * задача за 3 дня, повтор за 2, «Критически важно» за 1, закрытие по «Исполнено», удаление по «Отменено»,
 * правка при смене даты, выводы (приходы) не трогаем, ночью не пишем. Запуск: npx tsx scripts/check-fin-yougile.ts
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
type Task = { id: string; col: string; title: string; deadline?: any; stickers: Record<string, string>; completed: boolean; deleted: boolean; assigned: string[]; msgs: string[] };
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
    tasks.set(id, { id, col: body.columnId, title: body.title, deadline: body.deadline, stickers: body.stickers ?? {}, completed: false, deleted: false, assigned: body.assigned, msgs: [] });
    return ok({ id }, 201);
  }
  const tm = path.match(/^\/tasks\/(T\d+)$/);
  if (tm && m === 'PUT') {
    const t = tasks.get(tm[1]); if (!t || t.deleted) return ok({ error: 'not found' }, 404);
    if (body.title) t.title = body.title;
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
  try {
    const at = (day: string, h = 11) => Date.parse(`${day}T${String(h - 3).padStart(2, '0')}:00:00Z`);   // h — час по Москве
    check('напоминание: за 3 дня', y.stageFor('2026-11-25', '2026-11-22'), 3);
    check('напоминание: рано', y.stageFor('2026-11-26', '2026-11-22'), null);
    check('напоминание: дата прошла', y.stageFor('2026-11-21', '2026-11-22'), null);

    const pay = f.saveOp({ date: '2026-11-25', type: 'out', cat: 'Ко-Фи — платёж по займу', descr: '', plan: 117280, status: 'План' }, 'проверка');
    const salary = f.saveOp({ date: '2026-11-25', type: 'out', cat: 'ЗП дизайнера', descr: '', plan: 30000, status: 'Подтверждено' }, 'проверка');
    f.saveOp({ date: '2026-11-24', type: 'in', cat: 'Вывод WB', descr: '', plan: 500000, status: 'Прогноз' }, 'проверка');
    f.saveOp({ date: '2026-12-10', type: 'out', cat: 'Аренда помещения', descr: '', plan: 50000, status: 'План' }, 'проверка');

    const night = await y.syncYougile(at('2026-11-22', 4));
    check('ночью задачи не ставим', [night?.ok, tasks.size], [true, 0]);

    const s1 = await y.syncYougile(at('2026-11-22'));
    check('за 3 дня: две задачи, вывод и далёкая аренда — без задач', [s1?.ok, s1?.created, tasks.size], [true, 2, 2]);
    const t1 = [...tasks.values()].find(t => t.title.startsWith('Ко-Фи'))!;
    check('задача: колонка «К работе», исполнитель Александр, дедлайн = дата платежа', [t1.col, t1.assigned, ddate(t1)], ['C1', ['U-A'], '2026-11-25']);
    check('первое упоминание с суммой', [t1.msgs.length, t1.msgs[0].includes('[!mention:U-A!]'), t1.msgs[0].includes('117 280 ₽'), t1.msgs[0].includes('через 3 дня')], [1, true, true, true]);
    check('взята своя плашка «Приоритет: критично важно», новая не создана, включена на доске', [stickers.length, boardCustom.S1], [1, true]);

    const again = await y.syncYougile(at('2026-11-22', 15));
    check('в тот же день повторно не пишем', [again?.reminded, t1.msgs.length, tasks.size], [0, 1, 2]);

    await y.syncYougile(at('2026-11-23'));
    check('за 2 дня — второе упоминание', [t1.msgs.length, t1.msgs[1].startsWith('[!mention:U-A!], Повторно'), Object.keys(t1.stickers).length], [2, true, 0]);

    f.saveOp({ ...salary, status: 'Исполнено', fact: 30000 }, 'проверка');
    const s3 = await y.syncYougile(at('2026-11-24'));
    const t2 = [...tasks.values()].find(t => t.title.startsWith('ЗП'))!;
    check('за 1 день — «Критически важно»', [t1.msgs.length, t1.stickers.S1, t1.msgs[2].includes('Критически важно')], [3, 'ST1', true]);
    check('исполнено — задача закрыта, напоминаний больше нет', [t2.completed, t2.msgs.length, s3?.closed], [true, 2, 1]);

    f.saveOp({ ...pay, date: '2026-12-05' }, 'проверка');
    await y.syncYougile(at('2026-11-24', 16));
    check('дату отодвинули — дедлайн новый, плашка снята', [ddate(t1), t1.stickers.S1 ?? null], ['2026-12-05', null]);
    await y.syncYougile(at('2026-12-02'));
    check('…и напоминания пошли заново за 3 дня', [t1.msgs.length, t1.msgs[3]?.includes('через 3 дня')], [4, true]);

    f.saveOp({ ...pay, date: '2026-12-05', status: 'Отменено' }, 'проверка');
    const s5 = await y.syncYougile(at('2026-12-02', 12));
    check('отменено — задача удалена', [t1.deleted, s5?.removed], [true, 1]);

    // Задачу удалили в YouGile руками — связь забывается и задача ставится заново.
    const bank = f.saveOp({ date: '2026-12-04', type: 'out', cat: 'Услуги банка', descr: '', plan: 990, status: 'План' }, 'проверка');
    await y.syncYougile(at('2026-12-02', 13));
    [...tasks.values()].find(t => t.title === 'Услуги банка')!.deleted = true;
    f.saveOp({ ...bank, plan: 1200 }, 'проверка');
    await y.syncYougile(at('2026-12-02', 14));
    await y.syncYougile(at('2026-12-02', 15));
    check('задачу удалили руками — поставлена заново', [...tasks.values()].filter(t => t.title === 'Услуги банка' && !t.deleted).length, 1);

    check('последний проход записан', y.ygState()?.ok, true);
    delete process.env.YOUGILE_KEY;
    check('без ключа связка спит', await y.syncYougile(at('2026-12-03')), null);
  } finally { f.closeFinDb(); rmSync(dir, { recursive: true, force: true }); }
  if (fails) { console.error(`check-fin-yougile: ошибок ${fails}`); process.exit(1); }
  console.log('check-fin-yougile: всё верно');
})();
