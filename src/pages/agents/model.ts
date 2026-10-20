/** «Сборщики»: типы ответа /api/agents/live, время по МСК, расписания и список агентов (вынесено из AgentHosts.tsx 20.10.2026). */

// ─── Типы ответа /api/agents/live (сервер — единственная точка истины) ───────

export type StageDef = { stage: string; title: string; counted: boolean };
export type Progress = {
  stage: string; stage_index: number; stages_total: number;
  items_done?: number; items_total?: number; current_item?: string | null;
  message: string; eta_sec?: number;
};
export type Task = {
  id: number; type: string; params: { marketplace?: 'wb' | 'ozon'; [k: string]: unknown };
  status: string; scheduled_for: number; claimed_by?: string | null;
  started_at?: number | null; finished_at?: number | null; error?: string | null;
  created_by: string; progress?: Progress | null; progress_updated_at?: number | null;
  summary?: string | null; stats?: Record<string, number> | null; created_at: number;
};
export type Host = { name: string; last_seen_at: number | null; paused: boolean; version: string; chrome_ok: boolean; online: boolean };
export type Pause = { id: number; marketplace: 'wb' | 'ozon'; reason: string; paused_until: number | null };
export type Run = { task_id: number; level: string; message: string; data?: any; created_at: number };
export type Schedule = { id: number; type: string; params?: { marketplace?: string; [k: string]: unknown }; cron: string; enabled: boolean; next_run_at: number | null };
export type Live = {
  ok: boolean; disabled?: boolean; hosts: Host[]; tasks: Task[]; queued: Task[];
  finished_today: Task[]; last_runs?: Record<string, Task>; pauses: Pause[]; runs: Run[]; schedules?: Schedule[];
  stages: Record<string, StageDef[]>; titles: Record<string, string>; now: number;
};

export type Post = (url: string, body?: unknown) => Promise<void>;

export const MP_LABEL: Record<string, string> = { wb: 'Wildberries', ozon: 'Ozon' };
export const PAUSE_LABEL: Record<string, string> = { captcha: 'капча', blocked: 'блокировка', login_required: 'нужен вход' };
export const CREATOR_LABEL: Record<string, string> = { schedule: 'по расписанию', panel: 'из панели', button: 'кнопкой «Обновить цены»', dev: 'демо' };

// ─── Время: всё по Москве (UTC+3 круглый год, как в utils/mskDate) ──────────

export const MSK_OFFSET_MS = 3 * 3_600_000;
export const DAY_MS = 86_400_000;
export const mskDayStart = (t: number) => Math.floor((t + MSK_OFFSET_MS) / DAY_MS) * DAY_MS - MSK_OFFSET_MS;

export const fmtClock = (ms: number | null | undefined) =>
  ms ? new Date(ms).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' }) : '—';
export const fmtSpan = (sec: number) => {
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s} с`;
  if (s < 3600) return `${Math.round(s / 60)} мин`;
  const m = Math.round((s % 3600) / 60);
  return m ? `${Math.floor(s / 3600)} ч ${m} мин` : `${Math.floor(s / 3600)} ч`;
};
export const fmtAgo = (ms: number, nowMs: number) => fmtSpan((nowMs - ms) / 1000);
export const fmtIn = (ms: number, nowMs: number) => (ms - nowMs < 60_000 ? 'меньше чем через минуту' : `через ${fmtSpan((ms - nowMs) / 1000)}`);
/** Время «13:00», а если не сегодня по МСК — «завтра в 06:00». */
export const fmtWhen = (ms: number, nowMs: number) =>
  mskDayStart(ms) === mskDayStart(nowMs) ? fmtClock(ms) : `завтра в ${fmtClock(ms)}`;
/** Прошедший момент: «13:04», «вчера в 20:03» или «08.10 в 20:03». */
export const fmtPast = (ms: number, nowMs: number) => {
  const days = Math.round((mskDayStart(nowMs) - mskDayStart(ms)) / DAY_MS);
  if (days <= 0) return fmtClock(ms);
  if (days === 1) return `вчера в ${fmtClock(ms)}`;
  return `${new Date(ms).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', timeZone: 'Europe/Moscow' })} в ${fmtClock(ms)}`;
};

/** Плановые моменты суток из cron вида "0 6,13,20 * * *" (тот же формат, что понимает сервер). */
export function cronTimes(cron: string, dayStart: number): number[] {
  const m = cron.trim().match(/^(\d{1,2})\s+([\d,]+)\s+\*\s+\*\s+\*$/);
  if (!m) return [];
  const minute = Number(m[1]);
  return m[2].split(',').map(Number).filter(h => h >= 0 && h <= 23)
    .map(h => dayStart + h * 3_600_000 + minute * 60_000);
}

/** Читаемое расписание: «06:00, 13:00, 20:00», «каждый час, 07:20–23:20» или «каждый час». */
export function cronLabel(cron: string): string {
  const times = cronTimes(cron, mskDayStart(Date.now()));
  if (!times.length) return cron;
  if (times.length >= 24) return 'каждый час';
  // Подряд идущие часы одной строкой — иначе подпись на шкале «Сутки» растягивается на полэкрана.
  const hourly = times.length > 4 && times.every((t, i) => i === 0 || t - times[i - 1] === 3_600_000);
  if (hourly) return `каждый час, ${fmtClock(times[0])}⁠–⁠${fmtClock(times[times.length - 1])}`;
  return times.map(t => fmtClock(t)).join(', ');
}

/** Процент выполнения задания: пройденные этапы + доля текущего по счётчику. */
export function taskPct(t: Task): number | null {
  const p = t.progress;
  if (!p || !p.stages_total) return null;
  const within = p.items_total ? Math.min(1, (p.items_done ?? 0) / p.items_total) : 0;
  const pct = Math.round(((Math.max(1, p.stage_index) - 1 + within) / p.stages_total) * 100);
  return Math.max(0, Math.min(99, pct)); // 100 % — только когда сервер отметит «готово»
}

// ─── Агенты и их направления ────────────────────────────────────────────────

export type Lane = { type: string; mp: 'wb' | 'ozon'; label: string; short: string; color: string };
export type AgentDef = { num: number; title: string; about: string; lanes: Lane[]; server?: boolean };

export const MP_COLOR = { wb: '#cb11ab', ozon: '#005bff' } as const;

export const AGENTS: AgentDef[] = [
  {
    num: 1, title: 'Цены покупателя',
    about: 'Снимает цены с витрин WB и Ozon в Chrome агента. Итог — в разделе «Цены».',
    lanes: [
      { type: 'showcase_prices', mp: 'wb', label: 'Wildberries', short: 'Цены WB', color: MP_COLOR.wb },
      { type: 'showcase_prices', mp: 'ozon', label: 'Ozon', short: 'Цены Ozon', color: MP_COLOR.ozon },
    ],
  },
  {
    num: 2, title: 'Отзывы и вопросы',
    about: 'Отзывы Ozon забирает из кабинета продавца. Отзывы и вопросы WB и вопросы Ozon собирает сервер.',
    lanes: [{ type: 'ozon_reviews', mp: 'ozon', label: 'Отзывы Ozon из кабинета', short: 'Отзывы Ozon', color: MP_COLOR.ozon }],
    server: true,
  },
  {
    num: 3, title: 'Реклама',
    about: 'Кампании, ставки и статистику рекламы собирает сервер через API, автопилот — в разделе «Реклама». В Chrome агента — то, чего нет в API: конкуренты и позиции из аналитики кабинетов (вкладка «Конкуренты» в «Рекламе»), разведка новых разделов.',
    lanes: [
      { type: 'competitor_watch', mp: 'wb', label: 'Конкуренты и позиции WB', short: 'Конкуренты WB', color: MP_COLOR.wb },
      { type: 'competitor_watch', mp: 'ozon', label: 'Конкуренты Ozon', short: 'Конкуренты Ozon', color: MP_COLOR.ozon },
      { type: 'cabinet_recon', mp: 'wb', label: 'Разведка кабинета WB', short: 'Разведка WB', color: MP_COLOR.wb },
      { type: 'cabinet_recon', mp: 'ozon', label: 'Разведка кабинета Ozon', short: 'Разведка Ozon', color: MP_COLOR.ozon },
    ],
  },
];

export const ALL_LANES = AGENTS.flatMap(a => a.lanes.map(l => ({ ...l, agent: a })));
export const sameLane = (l: Lane) => (t: Task) => t.type === l.type && (t.params?.marketplace ?? '') === l.mp;
export const laneOf = (t: Task) => ALL_LANES.find(l => sameLane(l)(t));
export const scheduleOf = (l: Lane, live: Live) =>
  (live.schedules ?? []).find(s => s.type === l.type && (!s.params?.marketplace || s.params.marketplace === l.mp));
/** Все расписания дорожки: у «Конкурентов» ночной полный проход и дневные быстрые (15.10.2026). */
export const schedulesOf = (l: Lane, live: Live) =>
  (live.schedules ?? []).filter(s => s.type === l.type && (!s.params?.marketplace || s.params.marketplace === l.mp));

export const SERVER_DIRS: { key: 'wb_reviews' | 'wb_questions' | 'ozon_questions'; label: string }[] = [
  { key: 'wb_reviews', label: 'Отзывы WB' },
  { key: 'wb_questions', label: 'Вопросы WB' },
  { key: 'ozon_questions', label: 'Вопросы Ozon' },
];
