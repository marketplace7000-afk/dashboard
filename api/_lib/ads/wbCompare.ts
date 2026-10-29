/**
 * «Сравнение карточек» WB раз в неделю (26.10.2026, решение владельца).
 *
 * Четверг утром бот напоминает в рабочем чате; менеджер в «Конкурентах» → WB отмечает
 * товары (наш + до 4 закреплённых конкурентов) и жмёт «Запустить сравнения». Сервер ставит
 * Агенту 3 задание competitor_watch с params.compare: агент создаёт наборы в кабинете
 * (каждый — 1 сравнение из лимита, см. WB_CREATE), сразу читает их за 7 и 30 дней и
 * присылает снимок; отсюда — итог в чат. Лимит тарифа «Продвинутый» — 20 в месяц
 * (обновляется 15-го), докупается в кабинете; не больше 10 в неделю — правило владельца.
 */
import { adsDb } from './store';
import { createTask, listTasks, cancelTask } from '../agentQueue';
import { tgSend, tgEscape as esc, tgConfigured, chatId } from '../telegram';
import type { Ads2WbCompare, Ads2WbReport } from '../../../shared/ads2';

export const WB_COMPARE_MAX_WEEK = 10;
const SITE = 'https://e-avtovibe.ru/#competitors-wb';
const MSK = 3 * 3600_000;

let ready = false;
function db(): any {
  const d = adsDb();
  if (!d) throw new Error('хранилище рекламы недоступно');
  if (!ready) {
    d.exec(`CREATE TABLE IF NOT EXISTS ad_wb_compare_run (
        id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, by TEXT NOT NULL, sets TEXT NOT NULL,
        task_id INTEGER, status TEXT NOT NULL, result TEXT, done_at INTEGER);
      CREATE TABLE IF NOT EXISTS ad_tg_sent (key TEXT PRIMARY KEY, at INTEGER NOT NULL);
      -- Отмеченные «В сравнение» товары (29.10.2026): общие для всех менеджеров до запуска.
      CREATE TABLE IF NOT EXISTS ad_wb_compare_pick (key TEXT PRIMARY KEY, at INTEGER NOT NULL, by TEXT NOT NULL);
      -- История наборов по неделям: что было у нас и у конкурентов на дату сравнения (7 и 30 дней).
      CREATE TABLE IF NOT EXISTS ad_wb_comp_hist (
        set_id TEXT NOT NULL, date TEXT NOT NULL, nm TEXT NOT NULL, at INTEGER NOT NULL, json TEXT NOT NULL,
        PRIMARY KEY (set_id, nm));`);
    ready = true;
  }
  return d;
}

/** Понедельник текущей недели по Москве (мс, полночь МСК). */
function weekStart(now = Date.now()): number {
  const m = new Date(now + MSK);
  const day = (m.getUTCDay() + 6) % 7;
  return Date.UTC(m.getUTCFullYear(), m.getUTCMonth(), m.getUTCDate() - day) - MSK;
}

/**
 * Пятничный запуск (29.10.2026, решение владельца): сравнения создаются в пятницу в 08:30 МСК,
 * чтобы в недельный период целиком вошёл четверг (период — с прошлой пятницы по четверг).
 * null — слот этой недели уже прошёл (пятница после 08:30 и выходные): тогда только «запустить сейчас».
 */
export function fridaySlot(now = Date.now()): number | null {
  const t = weekStart(now) + 4 * 86_400_000 + (8 * 60 + 30) * 60_000;
  return now < t ? t : null;
}

function latestLimits(): { left: number | null; free: number[][] } {
  const row = db().prepare("SELECT json FROM ad_cabinet_snapshot WHERE mp = 'wb' AND json NOT LIKE '%\"light\":true%' ORDER BY at DESC LIMIT 1").get() as any;
  try {
    const l = row ? JSON.parse(row.json)?.comparisons?.limits : null;
    // purchasedLimits — сколько сравнений осталось из купленных/входящих в тариф (20 − потрачено);
    // remainingComparisonsThisMonth — общий потолок подписки (1 100), для нас не ограничение.
    return { left: l && Number.isFinite(Number(l.purchasedLimits)) ? Number(l.purchasedLimits) : null,
      free: Array.isArray(l?.availableWithoutCharge) ? l.availableWithoutCharge.map((x: any[]) => x.map(Number)) : [] };
  } catch { return { left: null, free: [] }; }
}

const sameSet = (a: number[], b: number[]) => a.length === b.length && [...a].sort().join(',') === [...b].sort().join(',');

function weekUsed(): number {
  let n = 0;
  for (const r of db().prepare("SELECT sets, result, status FROM ad_wb_compare_run WHERE at >= ? AND status NOT IN ('failed', 'cancelled')").all(weekStart()) as any[]) {
    try {
      const res = r.result ? JSON.parse(r.result) : null;
      n += res?.created != null ? Number(res.created) : JSON.parse(r.sets).length;
    } catch { /* пропуск */ }
  }
  return n;
}

function openTask(): any | null {
  return listTasks({ status: ['queued', 'claimed', 'running'], type: 'competitor_watch', limit: 30 })
    .find((t: any) => t.params?.marketplace !== 'ozon' && Array.isArray(t.params?.compare)) ?? null;
}

export function compareState(): Ads2WbCompare {
  const lim = latestLimits();
  const last = db().prepare('SELECT * FROM ad_wb_compare_run ORDER BY id DESC LIMIT 1').get() as any;
  let lastRun: Ads2WbCompare['lastRun'] = null;
  if (last) {
    let res: any = null; try { res = last.result ? JSON.parse(last.result) : null; } catch { /* пусто */ }
    lastRun = { id: last.id, at: last.at, status: last.status, total: JSON.parse(last.sets).length, created: res?.created ?? null, message: res?.message ?? null, doneAt: last.done_at ?? null };
  }
  const open = openTask();
  const planned = open && open.status === 'queued' && Number(open.scheduled_for) > Date.now()
    ? { runId: Number(open.params?.compare_run) || 0, at: Number(open.scheduled_for), keys: (open.params.compare as any[]).map(s => String(s.key)) } : null;
  const picks = (db().prepare('SELECT key FROM ad_wb_compare_pick ORDER BY at').all() as any[]).map(r => String(r.key));
  return { maxWeek: WB_COMPARE_MAX_WEEK, weekUsed: weekUsed(), limitLeft: lim.left, freeSets: lim.free, running: !!open && !planned, planned, picks,
    fridayAt: fridaySlot(), lastRun, telegram: tgConfigured() };
}

/** Отметить / снять «В сравнение» (видно всем менеджерам). */
export function setPick(key: unknown, on: boolean, by: string): void {
  const k = String(key ?? '').slice(0, 80);
  if (!k) return;
  if (!on) db().prepare('DELETE FROM ad_wb_compare_pick WHERE key = ?').run(k);
  else db().prepare('INSERT OR REPLACE INTO ad_wb_compare_pick (key, at, by) VALUES (?, ?, ?)').run(k, Date.now(), by);
}
export function clearPicks(): void { db().prepare('DELETE FROM ad_wb_compare_pick').run(); }

/** Отменить запланированный запуск, пока агент его не взял, — лимит не тратится. */
export function cancelPlanned(): { ok: true } | { ok: false; error: string } {
  const open = openTask();
  if (!open) return { ok: false, error: 'запланированных сравнений нет' };
  if (open.status !== 'queued') return { ok: false, error: 'агент уже создаёт сравнения — отменить нельзя' };
  const runId = Number(open.params?.compare_run);
  // Сначала запуск, потом задание: closeStaleRuns иначе принял бы отмену за сбой и написал в чат.
  if (runId) db().prepare("UPDATE ad_wb_compare_run SET status = 'cancelled', done_at = ? WHERE id = ?").run(Date.now(), runId);
  cancelTask(open.id);
  return { ok: true };
}

/** Запуск сравнений менеджером: [{key, nmIDs:[наш, конкуренты…]}]. */
export function requestCompare(items: unknown, by: string, mode: 'friday' | 'now' = 'now'): { ok: true; runId: number; taskId: number; charged: number; at: number } | { ok: false; error: string } {
  const at = mode === 'friday' ? fridaySlot() : Date.now();
  if (at == null) return { ok: false, error: 'пятница 08:30 этой недели уже прошла — запустите сравнения сейчас' };
  if (!Array.isArray(items) || !items.length) return { ok: false, error: 'не выбрано ни одного товара' };
  const sets: { key: string; nmIDs: number[] }[] = [];
  for (const it of items as any[]) {
    const ids = [...new Set((Array.isArray(it?.nmIDs) ? it.nmIDs : []).map(Number).filter((n: number) => Number.isFinite(n) && n > 0))] as number[];
    if (ids.length < 2) return { ok: false, error: `${it?.key ?? 'товар'}: нужен наш товар и хотя бы один конкурент` };
    if (ids.length > 5) return { ok: false, error: `${it?.key ?? 'товар'}: в одно сравнение WB помещается 5 карточек` };
    sets.push({ key: String(it?.key ?? ids[0]).slice(0, 80), nmIDs: ids });
  }
  const busy = openTask();
  if (busy) return { ok: false, error: busy.status === 'queued' && Number(busy.scheduled_for) > Date.now() ? 'сравнения уже запланированы — отмените план, чтобы поменять товары' : 'сравнения уже запущены — дождитесь окончания' };
  const lim = latestLimits();
  const charged = sets.filter(s => !lim.free.some(f => sameSet(f, s.nmIDs))).length;
  const used = weekUsed();
  if (used + charged > WB_COMPARE_MAX_WEEK) return { ok: false, error: `выбрано ${charged}, а на этой неделе можно ещё ${Math.max(0, WB_COMPARE_MAX_WEEK - used)} (не больше ${WB_COMPARE_MAX_WEEK} в неделю)` };
  if (lim.left != null && charged > lim.left) return { ok: false, error: `в лимите WB осталось ${lim.left}, выбрано ${charged} — докупите сравнения в кабинете («Сравнение карточек» → «Купить»)` };
  const d = db();
  const runId = Number(d.prepare("INSERT INTO ad_wb_compare_run (at, by, sets, status) VALUES (?, ?, ?, 'queued')").run(Date.now(), by, JSON.stringify(sets)).lastInsertRowid);
  const t = createTask('competitor_watch', { marketplace: 'wb', compare: sets, compare_run: runId }, by, { priority: 5, scheduledFor: at });
  if (!t) { d.prepare("UPDATE ad_wb_compare_run SET status = 'failed', result = ? WHERE id = ?").run(JSON.stringify({ message: 'очередь агентов недоступна' }), runId); return { ok: false, error: 'очередь агентов недоступна' }; }
  d.prepare('UPDATE ad_wb_compare_run SET task_id = ? WHERE id = ?').run(t.id, runId);
  clearPicks();
  return { ok: true, runId, taskId: t.id, charged, at };
}

const pct = (v: number | null | undefined) => v == null ? '–' : `${(Math.round(v * 10) / 10).toString().replace('.', ',')}%`;
const n0 = (v: number | null | undefined) => v == null ? '–' : Math.round(v).toLocaleString('ru-RU');
const median = (a: number[]) => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };

/** Итог по одному набору: наш против медианы конкурентов (за 7 дней, если есть, иначе 30). */
function setSummary(key: string, set: any): string {
  const rows: any[] = set.nms7?.length ? set.nms7 : set.nms ?? [];
  const per = set.nms7?.length ? '7 дн' : '30 дн';
  const names = new Map<string, string>((set.nms ?? []).map((x: any) => [String(x.nmId), String(x.name ?? '')]));
  const ourNm = String((set.created?.nmIDs ?? [])[0] ?? rows[0]?.nmId ?? '');
  const our = rows.find(r => String(r.nmId) === ourNm);
  const comp = rows.filter(r => String(r.nmId) !== ourNm);
  if (!our) return `• <b>${esc(key)}</b> — данных по нашей карточке нет`;
  const cCtr = median(comp.map(r => Number(r.ctr))), cOrd = median(comp.map(r => Number(r.orders)));
  const best = comp.map(r => Number(r.avgPos)).filter(v => Number.isFinite(v) && v > 0).sort((a, b) => a - b)[0] ?? null;
  const notes: string[] = [];
  if (our.ctr != null && cCtr != null && our.ctr < cCtr * 0.8) notes.push('CTR ниже конкурентов — проверить главное фото');
  if (our.avgPos != null && best != null && our.avgPos > best * 2 && our.avgPos - best >= 5) notes.push('позиция заметно ниже лидера');
  if (our.orders != null && cOrd != null && our.orders < cOrd * 0.6) notes.push('заказов меньше, чем у конкурентов');
  return [
    `• <b>${esc(key)}</b> — ${esc((names.get(ourNm) || '').slice(0, 60))}`,
    `  CTR ${pct(our.ctr)} · у конкурентов ${pct(cCtr)} (медиана)`,
    `  Позиция ${our.avgPos != null ? n0(our.avgPos) : '–'} · лучшая у конкурентов ${best != null ? n0(best) : '–'}`,
    `  Заказы за ${per}: ${n0(our.orders)} · у конкурентов ${n0(cOrd)} (медиана)`,
    ...(notes.length ? [`  ⚠️ ${notes.join('; ')}`] : []),
  ].join('\n');
}

/** Снимок агента пришёл (из saveCabinetSnapshot): история наборов, итог запуска и сообщение в чат. */
export function onWbSnapshot(data: any, at: number): void {
  const d = db();
  const ins = d.prepare('INSERT OR REPLACE INTO ad_wb_comp_hist (set_id, date, nm, at, json) VALUES (?, ?, ?, ?, ?)');
  for (const set of data?.compDetails ?? []) {
    const w7 = new Map((set.nms7 ?? []).map((x: any) => [String(x.nmId), x]));
    for (const x of set.nms ?? []) ins.run(String(set.id), String(set.date ?? ''), String(x.nmId), at, JSON.stringify({ d30: x, d7: w7.get(String(x.nmId)) ?? null, p30: set.per30 ?? null, p7: set.per7 ?? null }));
  }
  const runId = Number(data?.compareRun);
  if (!runId || !Array.isArray(data?.compareCreated)) return;
  const created: any[] = data.compareCreated;
  const ok = created.filter(c => c.id || c.ok);
  const sets: any[] = data.compDetails ?? [];
  // Набор: по номеру из ответа, иначе по составу карточек (ответ создания номера может не содержать).
  const setOf = (c: any) => sets.find(s => c.id && String(s.id) === String(c.id))
    ?? sets.find(s => sameSet((s.nms ?? []).map((x: any) => Number(x.nmId)), (c.nmIDs ?? []).map(Number))) ?? {};
  const parts = ok.map(c => setSummary(c.key, { ...setOf(c), created: c }));
  const failed = created.filter(c => !(c.id || c.ok));
  const message = `создано ${ok.length} из ${created.length}${failed.length ? `, не создано: ${failed.map(f => f.key).join(', ')}` : ''}`;
  d.prepare("UPDATE ad_wb_compare_run SET status = ?, result = ?, done_at = ? WHERE id = ?")
    .run(ok.length ? 'done' : 'failed', JSON.stringify({ created: ok.length, message, failed }), Date.now(), runId);
  lastResultText = resultText(message, parts, failed);
  void tgSend(lastResultText);
}

/** Последний итог — для проверки на копии данных без отправки. */
let lastResultText = '';
export const lastResult = () => lastResultText;

function resultText(message: string, parts: string[], failed: any[]): string {
  const lim = latestLimits();
  return [
    `${parts.length ? '📊 <b>Сравнения WB готовы</b>' : '❌ <b>Сравнения WB не созданы</b>'} — ${message}`,
    '',
    ...parts,
    ...(failed.length ? ['', `❌ Не создано: ${failed.map(f => `${esc(f.key)} (${esc(String(f.error ?? '').slice(0, 80))})`).join('; ')}`] : []),
    '',
    `В лимите WB осталось: ${lim.left ?? '–'}. Подробно — <a href="${SITE}">«Конкуренты» → WB</a>`,
  ].join('\n');
}

/** Агент не смог (задание упало) — отметить запуск, чтобы кнопка снова стала доступна. */
function closeStaleRuns(): void {
  const d = db();
  for (const r of d.prepare("SELECT id, task_id FROM ad_wb_compare_run WHERE status = 'queued' AND task_id IS NOT NULL").all() as any[]) {
    const t = listTasks({ limit: 200 }).find((x: any) => x.id === r.task_id);
    if (t && (t.status === 'failed' || t.status === 'cancelled')) {
      d.prepare("UPDATE ad_wb_compare_run SET status = 'failed', result = ?, done_at = ? WHERE id = ?").run(JSON.stringify({ created: 0, message: `агент не выполнил: ${String(t.error ?? '').slice(0, 160)}` }), Date.now(), r.id);
      void tgSend(`❌ Сравнения WB не запустились: ${esc(String(t.error ?? 'ошибка агента').slice(0, 200))}. Попробуйте ещё раз в <a href="${SITE}">«Конкурентах»</a>.`);
    } else if (t && t.status === 'done') {
      // Снимок пришёл без итогов (старый агент) — закрываем без сообщения.
      d.prepare("UPDATE ad_wb_compare_run SET status = 'done', done_at = ? WHERE id = ? AND status = 'queued'").run(Date.now(), r.id);
    }
  }
}

/**
 * Напоминания по четвергам (МСК): 09:30 всегда, 14:00 — если на неделе ещё ничего не запланировано.
 * Пятница 08:50 — если запланированное агент так и не взял (ПК выключен или спит).
 */
async function tick(): Promise<void> {
  try { closeStaleRuns(); } catch (e) { console.warn('[wb-compare] проверка запусков:', (e as Error).message); }
  if (!tgConfigured()) return;
  const m = new Date(Date.now() + MSK);
  const hm = m.getUTCHours() * 60 + m.getUTCMinutes();
  const week = new Date(weekStart() + MSK).toISOString().slice(0, 10);
  const d = db();
  const sent = (k: string) => !!d.prepare('SELECT 1 FROM ad_tg_sent WHERE key = ?').get(k);
  const mark = (k: string) => d.prepare('INSERT OR IGNORE INTO ad_tg_sent (key, at) VALUES (?, ?)').run(k, Date.now());
  if (m.getUTCDay() === 5 && hm >= 8 * 60 + 50 && hm < 12 * 60 && !sent(`late:${week}`)) {
    const open = openTask();
    if (open && open.status === 'queued') {
      if (await tgSend('⚠️ Сравнения WB запланированы на 08:30, но агент их ещё не взял — проверьте, что ПК с агентом включён («3 Проверить агента»). Как только агент выйдет на связь, он создаст сравнения сам.')) mark(`late:${week}`);
    }
  }
  if (m.getUTCDay() !== 4) return;
  const st = compareState();
  const head = `В лимите WB осталось: <b>${st.limitLeft ?? '–'}</b> · на этой неделе можно до ${st.maxWeek}${st.weekUsed ? ` (уже ${st.weekUsed})` : ''}.`;
  const how = `Откройте <a href="${SITE}">«Конкуренты» → WB</a>, проверьте конкурентов у нужных товаров, отметьте «В сравнение» и нажмите «Запланировать на пятницу 08:30» — агент создаст сравнения в пятницу утром, чтобы в неделю вошёл весь четверг.`;
  if (hm >= 9 * 60 + 30 && hm < 13 * 60 && !sent(`remind1:${week}`)) {
    if (await tgSend(`📌 <b>Четверг — время сравнений WB.</b>\n${head}\n${how}`)) mark(`remind1:${week}`);
  } else if (hm >= 14 * 60 && hm < 18 * 60 && !sent(`remind2:${week}`) && !st.weekUsed && !st.running && !st.planned) {
    if (await tgSend(`⏰ Напоминание: сравнения WB на этой неделе ещё не запланированы.\n${head}\n${how}`)) mark(`remind2:${week}`);
  }
  if (st.limitLeft != null && st.limitLeft < 7 && !sent(`lowlimit:${week}`) && hm >= 9 * 60 + 30) {
    if (await tgSend(`⚠️ В лимите сравнений WB осталось ${st.limitLeft} — меньше недельной нормы. Докупить: кабинет WB → «Сравнение карточек» → «Купить». Лимит тарифа обновляется 15-го.`)) mark(`lowlimit:${week}`);
  }
}

export function scheduleWbCompare(): void {
  void chatId();
  setInterval(() => { void tick(); }, 60_000).unref();
  console.log('[wb-compare] напоминания по четвергам 09:30 / 14:00 МСК, запуск в пятницу 08:30' + (tgConfigured() ? '' : ' — токен Telegram не задан'));
}


export type CompareFact = {
  setId: string; date: string; period: 7 | 30;
  ours: { nm: string; ctr: number | null; views: number | null; avgPos: number | null; orders: number | null; ordersDyn: number | null };
  comps: { nm: string; name: string; ctr: number | null; views: number | null; avgPos: number | null; orders: number | null; ordersDyn: number | null }[];
};

/**
 * Последнее сравнение по каждому нашему товару (для «Советника», 26.10.2026): наш nmId → наш ряд
 * и ряды конкурентов того же набора, за 7 дней (если сняты), иначе за 30. Наборы старше maxAgeDays — не берём.
 */
export function lastCompareFacts(ourNms: Set<string>, maxAgeDays = 10): Map<string, CompareFact> {
  const out = new Map<string, CompareFact>();
  const since = Date.now() - maxAgeDays * 86_400_000;
  const rows = db().prepare('SELECT set_id, date, nm, at, json FROM ad_wb_comp_hist WHERE at >= ? ORDER BY at DESC').all(since) as any[];
  const bySet = new Map<string, any[]>();
  for (const r of rows) { const a = bySet.get(r.set_id) ?? []; a.push(r); bySet.set(r.set_id, a); }
  const num = (v: unknown) => v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v);
  for (const [setId, rs] of bySet) {
    const parsed = rs.map(r => { let j: any = {}; try { j = JSON.parse(r.json); } catch { /* пусто */ } return { nm: String(r.nm), date: String(r.date), j }; });
    const has7 = parsed.every(x => x.j.d7);
    const pick = (x: any) => {
      const s = has7 ? x.j.d7 : x.j.d30 ?? {};
      return { nm: x.nm, name: String(x.j.d30?.name ?? ''), ctr: num(s.ctr), views: num(s.views), avgPos: num(s.avgPos), orders: num(s.orders), ordersDyn: num(s.ordersDyn) };
    };
    for (const x of parsed) {
      if (!ourNms.has(x.nm) || out.has(x.nm)) continue; // строки идут от свежих к старым — первое попадание и есть последнее
      const { name: _n, ...ours } = pick(x);
      out.set(x.nm, { setId, date: x.date, period: has7 ? 7 : 30, ours, comps: parsed.filter(y => y.nm !== x.nm && !ourNms.has(y.nm)).map(pick) });
    }
  }
  return out;
}

/**
 * Отчёт «Показатели» последнего набора по каждому нашему товару (27.10.2026): строки как прислал
 * агент (поле rep), каждая карточка отдельно. Наборы, снятые до 27.10, полей отчёта не имеют — null.
 */
export function compareReports(ourNms: Set<string>): Record<string, Ads2WbReport> {
  const out: Record<string, Ads2WbReport> = {};
  const rows = db().prepare('SELECT set_id, date, nm, json FROM ad_wb_comp_hist ORDER BY date DESC, at DESC, rowid').all() as any[];
  const bySet = new Map<string, { date: string; rs: { nm: string; j: any }[] }>();
  for (const r of rows) {
    let j: any = {}; try { j = JSON.parse(r.json); } catch { /* битая строка — без данных */ }
    const s = bySet.get(r.set_id) ?? { date: String(r.date), rs: [] };
    s.rs.push({ nm: String(r.nm), j });
    bySet.set(r.set_id, s);
  }
  for (const [setId, s] of bySet) { // от свежих к старым — первый набор с нашим товаром и есть последний
    for (const x of s.rs) {
      if (!ourNms.has(x.nm) || out[x.nm]) continue;
      const nms = [...s.rs].sort((a, b) => Number(b.nm === x.nm) - Number(a.nm === x.nm)).map(y => ({
        nm: y.nm, name: String(y.j.d30?.name ?? ''), photo: String(y.j.d30?.photo ?? ''), ours: ourNms.has(y.nm),
        d7: y.j.d7?.rep ?? null, d30: y.j.d30?.rep ?? null }));
      const p = s.rs[0]?.j ?? {};
      out[x.nm] = { setId, date: s.date, per7: p.p7 ?? null, per30: p.p30 ?? null, nms };
    }
  }
  return out;
}
