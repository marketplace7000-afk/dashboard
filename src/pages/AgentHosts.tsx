/**
 * Экран «Сборщики» — живая визуализация сети агентов (ТЗ раздел 7.1).
 *
 * Назначение: за 3 секунды понять, какие агенты живы, что каждый делает сейчас,
 * на сколько процентов готово, когда был прошлый прогон и когда следующий.
 *
 * Сверху вниз: связь с ПК → «Сейчас» (идущие задания с процентом) → «Сутки»
 * (шкала 00–24 МСК: прошедшие прогоны, идущий, плановые) → карточки агентов →
 * журнал (очередь и завершённые).
 *
 * Источник данных — только сервер: GET /api/agents/live раз в 4 с, пока вкладка
 * видима (скрыта — раз в 30 с). На клиенте только форматирование: процент из
 * этапа и счётчика, плановые моменты дня из cron расписания. Время — МСК.
 * Стили — блок «Сборщики» в styles.css (префикс .ah-).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { reviewsApi } from '../api/reviews';
import type { ReviewsOverview } from '../../shared/reviews';
import { fetchAiUsage, type UsageResponse, type AiHealth } from '../api/aiUsage';
import {
  RobotIcon, PlayIcon, XCircleIcon, PauseIcon, WarningIcon, CheckCircleIcon,
  ProhibitIcon, ClockIcon, CaretDownIcon, CaretUpIcon, ArrowsClockwiseIcon, MoonIcon,
} from '@phosphor-icons/react';

// ─── Типы ответа /api/agents/live (сервер — единственная точка истины) ───────

type StageDef = { stage: string; title: string; counted: boolean };
type Progress = {
  stage: string; stage_index: number; stages_total: number;
  items_done?: number; items_total?: number; current_item?: string | null;
  message: string; eta_sec?: number;
};
type Task = {
  id: number; type: string; params: { marketplace?: 'wb' | 'ozon'; [k: string]: unknown };
  status: string; scheduled_for: number; claimed_by?: string | null;
  started_at?: number | null; finished_at?: number | null; error?: string | null;
  created_by: string; progress?: Progress | null; progress_updated_at?: number | null;
  summary?: string | null; stats?: Record<string, number> | null; created_at: number;
};
type Host = { name: string; last_seen_at: number | null; paused: boolean; version: string; chrome_ok: boolean; online: boolean };
type Pause = { id: number; marketplace: 'wb' | 'ozon'; reason: string; paused_until: number | null };
type Run = { task_id: number; level: string; message: string; data?: any; created_at: number };
type Schedule = { id: number; type: string; params?: { marketplace?: string; [k: string]: unknown }; cron: string; enabled: boolean; next_run_at: number | null };
type Live = {
  ok: boolean; disabled?: boolean; hosts: Host[]; tasks: Task[]; queued: Task[];
  finished_today: Task[]; last_runs?: Record<string, Task>; pauses: Pause[]; runs: Run[]; schedules?: Schedule[];
  stages: Record<string, StageDef[]>; titles: Record<string, string>; now: number;
};

type Post = (url: string, body?: unknown) => Promise<void>;

const MP_LABEL: Record<string, string> = { wb: 'Wildberries', ozon: 'Ozon' };
const PAUSE_LABEL: Record<string, string> = { captcha: 'капча', blocked: 'блокировка', login_required: 'нужен вход' };
const CREATOR_LABEL: Record<string, string> = { schedule: 'по расписанию', panel: 'из панели', button: 'кнопкой «Обновить цены»', dev: 'демо' };

// ─── Время: всё по Москве (UTC+3 круглый год, как в utils/mskDate) ──────────

const MSK_OFFSET_MS = 3 * 3_600_000;
const DAY_MS = 86_400_000;
const mskDayStart = (t: number) => Math.floor((t + MSK_OFFSET_MS) / DAY_MS) * DAY_MS - MSK_OFFSET_MS;

const fmtClock = (ms: number | null | undefined) =>
  ms ? new Date(ms).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' }) : '—';
const fmtSpan = (sec: number) => {
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s} с`;
  if (s < 3600) return `${Math.round(s / 60)} мин`;
  const m = Math.round((s % 3600) / 60);
  return m ? `${Math.floor(s / 3600)} ч ${m} мин` : `${Math.floor(s / 3600)} ч`;
};
const fmtAgo = (ms: number, nowMs: number) => fmtSpan((nowMs - ms) / 1000);
const fmtIn = (ms: number, nowMs: number) => (ms - nowMs < 60_000 ? 'меньше чем через минуту' : `через ${fmtSpan((ms - nowMs) / 1000)}`);
/** Время «13:00», а если не сегодня по МСК — «завтра в 06:00». */
const fmtWhen = (ms: number, nowMs: number) =>
  mskDayStart(ms) === mskDayStart(nowMs) ? fmtClock(ms) : `завтра в ${fmtClock(ms)}`;
/** Прошедший момент: «13:04», «вчера в 20:03» или «08.10 в 20:03». */
const fmtPast = (ms: number, nowMs: number) => {
  const days = Math.round((mskDayStart(nowMs) - mskDayStart(ms)) / DAY_MS);
  if (days <= 0) return fmtClock(ms);
  if (days === 1) return `вчера в ${fmtClock(ms)}`;
  return `${new Date(ms).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', timeZone: 'Europe/Moscow' })} в ${fmtClock(ms)}`;
};

/** Плановые моменты суток из cron вида "0 6,13,20 * * *" (тот же формат, что понимает сервер). */
function cronTimes(cron: string, dayStart: number): number[] {
  const m = cron.trim().match(/^(\d{1,2})\s+([\d,]+)\s+\*\s+\*\s+\*$/);
  if (!m) return [];
  const minute = Number(m[1]);
  return m[2].split(',').map(Number).filter(h => h >= 0 && h <= 23)
    .map(h => dayStart + h * 3_600_000 + minute * 60_000);
}

/** Читаемое расписание: «06:00, 13:00, 20:00», «каждый час, 07:20–23:20» или «каждый час». */
function cronLabel(cron: string): string {
  const times = cronTimes(cron, mskDayStart(Date.now()));
  if (!times.length) return cron;
  if (times.length >= 24) return 'каждый час';
  // Подряд идущие часы одной строкой — иначе подпись на шкале «Сутки» растягивается на полэкрана.
  const hourly = times.length > 4 && times.every((t, i) => i === 0 || t - times[i - 1] === 3_600_000);
  if (hourly) return `каждый час, ${fmtClock(times[0])}⁠–⁠${fmtClock(times[times.length - 1])}`;
  return times.map(t => fmtClock(t)).join(', ');
}

/** Процент выполнения задания: пройденные этапы + доля текущего по счётчику. */
function taskPct(t: Task): number | null {
  const p = t.progress;
  if (!p || !p.stages_total) return null;
  const within = p.items_total ? Math.min(1, (p.items_done ?? 0) / p.items_total) : 0;
  const pct = Math.round(((Math.max(1, p.stage_index) - 1 + within) / p.stages_total) * 100);
  return Math.max(0, Math.min(99, pct)); // 100 % — только когда сервер отметит «готово»
}

// ─── Агенты и их направления ────────────────────────────────────────────────

type Lane = { type: string; mp: 'wb' | 'ozon'; label: string; short: string; color: string };
type AgentDef = { num: number; title: string; about: string; lanes: Lane[]; server?: boolean };

const MP_COLOR = { wb: '#cb11ab', ozon: '#005bff' } as const;

const AGENTS: AgentDef[] = [
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
    about: 'Кампании, ставки и статистику рекламы собирает сервер через API, автопилот — в разделе «Реклама». В Chrome агента — то, чего нет в API: разведка разделов аналитики кабинетов (основа для сбора конкурентов и воронки).',
    lanes: [
      { type: 'cabinet_recon', mp: 'wb', label: 'Разведка кабинета WB', short: 'Разведка WB', color: MP_COLOR.wb },
      { type: 'cabinet_recon', mp: 'ozon', label: 'Разведка кабинета Ozon', short: 'Разведка Ozon', color: MP_COLOR.ozon },
    ],
  },
];

const ALL_LANES = AGENTS.flatMap(a => a.lanes.map(l => ({ ...l, agent: a })));
const sameLane = (l: Lane) => (t: Task) => t.type === l.type && (t.params?.marketplace ?? '') === l.mp;
const laneOf = (t: Task) => ALL_LANES.find(l => sameLane(l)(t));
const scheduleOf = (l: Lane, live: Live) =>
  (live.schedules ?? []).find(s => s.type === l.type && (!s.params?.marketplace || s.params.marketplace === l.mp));

const SERVER_DIRS: { key: 'wb_reviews' | 'wb_questions' | 'ozon_questions'; label: string }[] = [
  { key: 'wb_reviews', label: 'Отзывы WB' },
  { key: 'wb_questions', label: 'Вопросы WB' },
  { key: 'ozon_questions', label: 'Вопросы Ozon' },
];

// ─── Связь с ПК и паузы площадок ────────────────────────────────────────────

function StatusBar({ live, busy, post }: { live: Live; busy: boolean; post: Post }) {
  const nowMs = live.now;
  // Демо-хост показываем, только пока он жив: иначе он вечно висит «не в сети».
  const hosts = live.hosts.filter(h => h.name !== 'dev-sim' || h.online);
  return (
    <div className="ah-status">
      {hosts.map(h => {
        const state = !h.online ? 'off' : h.paused ? 'paused' : 'on';
        const text = !h.online
          ? `не на связи ${h.last_seen_at ? fmtAgo(h.last_seen_at, nowMs) : '— ещё ни разу'}`
          : h.paused ? 'на паузе, задания не берёт' : 'на связи';
        return (
          <div key={h.name} className={`ah-host ah-host--${state}`}>
            <span className="ah-host-dot" aria-hidden />
            <div className="ah-host-text">
              <div><strong>{h.name}</strong> {text}</div>
              <div className="ah-sub">
                {h.online ? (h.chrome_ok ? 'Chrome агента готов' : <span className="ah-warn-text">Chrome агента не готов</span>) : 'Проверьте ПК: «3 Проверить агента», затем «1 Запустить агента»'}
                {h.version ? `, версия ${h.version}` : ''}
              </div>
            </div>
            <button className="btn btn-sm" disabled={busy}
              onClick={() => post(`/api/agents/hosts/${h.name}/${h.paused ? 'resume' : 'pause'}`)}>
              {h.paused ? <><PlayIcon size={13} weight="fill" /> Продолжить</> : <><PauseIcon size={13} weight="fill" /> Пауза</>}
            </button>
          </div>
        );
      })}
      {!hosts.length && (
        <div className="ah-host ah-host--off">
          <span className="ah-host-dot" aria-hidden />
          <div className="ah-host-text">
            <div><strong>ПК с агентом не подключён</strong></div>
            <div className="ah-sub">Запустите «1 Запустить агента» на ПК — он появится здесь через минуту.</div>
          </div>
        </div>
      )}
      {live.pauses.map(pz => (
        <div key={pz.id} className="ah-pause" role="alert">
          <WarningIcon size={18} weight="fill" />
          <div className="ah-host-text">
            <div><strong>{MP_LABEL[pz.marketplace]} на паузе: {PAUSE_LABEL[pz.reason] ?? pz.reason}</strong></div>
            <div className="ah-sub">
              {pz.paused_until
                ? `Снимется сама в ${fmtWhen(pz.paused_until, nowMs)}`
                : 'Войдите в аккаунт в окне Chrome агента, затем снимите паузу'}
            </div>
          </div>
          <button className="btn btn-sm" disabled={busy} onClick={() => post(`/api/agents/pauses/${pz.id}/clear`)}>Снять паузу</button>
        </div>
      ))}
    </div>
  );
}

// ─── «Сейчас»: идущие задания крупно ────────────────────────────────────────

function Stepper({ stages, progress }: { stages: StageDef[]; progress: Progress | null | undefined }) {
  const cur = progress ? progress.stage_index : 0; // 1-based; 0 = не начато
  return (
    <ol className="ah-steps">
      {stages.map((s, i) => {
        const idx = i + 1;
        const state = idx < cur ? 'done' : idx === cur ? 'active' : 'todo';
        return (
          <li key={s.stage} className={`ah-step ah-step--${state}`} aria-current={state === 'active' ? 'step' : undefined}>
            <span className="ah-step-mark">{state === 'done' ? <CheckCircleIcon size={16} weight="fill" /> : idx}</span>
            <span className="ah-step-title">{s.title}</span>
          </li>
        );
      })}
    </ol>
  );
}

function RunningCard({ task, live, onCancel }: { task: Task; live: Live; onCancel: (id: number) => void }) {
  const [logOpen, setLogOpen] = useState(false);
  const lane = laneOf(task);
  const stages = live.stages[task.type] ?? [];
  const p = task.progress;
  const nowMs = live.now;
  const pct = taskPct(task);
  const staleSec = task.progress_updated_at ? (nowMs - task.progress_updated_at) / 1000 : null;
  const stale = task.status === 'running' && staleSec !== null && staleSec > 180;
  const dead = task.status === 'running' && staleSec !== null && staleSec > 900;
  const taskRuns = live.runs.filter(r => r.task_id === task.id).slice(0, 8);
  const color = lane?.color ?? 'var(--accent)';

  return (
    <article className="ah-run" style={{ ['--lane' as any]: color }}>
      <div className="ah-run-head">
        <div className="ah-run-title">
          <div className="ah-sub">
            {lane ? `Агент ${lane.agent.num}, ${lane.agent.title.toLowerCase()}` : 'Агент'}
          </div>
          <h2>{lane?.short ?? live.titles[task.type] ?? task.type}</h2>
          <div className="ah-run-msg">{p?.message ?? 'Хост принял задание и открывает Chrome…'}</div>
        </div>
        <div className="ah-run-pct" aria-label={pct === null ? 'Запускается' : `Готово ${pct} процентов`}>
          {pct === null ? <span className="ah-run-pct-wait">старт</span> : <>{pct}<small>%</small></>}
        </div>
      </div>

      <div className="ah-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct ?? undefined}>
        <div className={`ah-bar-fill ${pct === null ? 'ah-bar-fill--wait' : ''}`} style={{ width: `${pct ?? 100}%` }} />
      </div>
      <div className="ah-run-meta">
        <span>
          {p?.items_total ? <><strong>{p.items_done ?? 0} из {p.items_total}</strong> товаров на этапе</> : p ? `Этап ${p.stage_index} из ${p.stages_total}` : 'Ждём первый отчёт от ПК'}
          {p?.current_item ? `, сейчас ${p.current_item}` : ''}
        </span>
        <span>{p?.eta_sec ? `осталось ${fmtSpan(p.eta_sec)}` : ''}</span>
      </div>

      {(stale || dead) && (
        <div className={`ah-alert ${dead ? 'ah-alert--bad' : 'ah-alert--warn'}`}>
          <WarningIcon size={15} weight="fill" />
          {dead
            ? `Похоже, зависло: от ПК нет вестей ${fmtAgo(task.progress_updated_at!, nowMs)}. Проверьте окно Chrome агента или отмените задание.`
            : `От ПК нет вестей ${fmtAgo(task.progress_updated_at!, nowMs)} — возможно, долгая страница.`}
        </div>
      )}

      <Stepper stages={stages} progress={p} />

      <div className="ah-run-foot">
        <span className="ah-sub">
          Запущено {CREATOR_LABEL[task.created_by] ?? task.created_by} в {fmtClock(task.started_at ?? task.created_at)}
          {task.started_at ? `, идёт ${fmtAgo(task.started_at, nowMs)}` : ''}
          {task.claimed_by ? `, ПК ${task.claimed_by}` : ''}
        </span>
        <div className="ah-run-actions">
          {taskRuns.length > 0 && (
            <button className="btn btn-sm" onClick={() => setLogOpen(o => !o)} aria-expanded={logOpen}>
              {logOpen ? <CaretUpIcon size={13} /> : <CaretDownIcon size={13} />} Журнал
            </button>
          )}
          <button className="btn btn-sm btn-bad" onClick={() => onCancel(task.id)}>
            <XCircleIcon size={14} /> Отменить
          </button>
        </div>
      </div>
      {logOpen && (
        <ul className="ah-log">
          {taskRuns.map((r, i) => (
            <li key={i} className={`ah-log-row ah-log-row--${r.level}`}>
              <time>{fmtClock(r.created_at)}</time>
              <span>{r.message === 'stage' ? `этап: ${r.data?.stage ?? ''}` : r.message}</span>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}

function IdleCard({ live, busy, post }: { live: Live; busy: boolean; post: Post }) {
  const nowMs = live.now;
  const next = (live.schedules ?? []).filter(s => s.enabled && s.next_run_at)
    .sort((a, b) => (a.next_run_at ?? 0) - (b.next_run_at ?? 0))[0];
  const lane = next ? ALL_LANES.find(l => l.type === next.type && (!next.params?.marketplace || next.params.marketplace === l.mp)) : undefined;
  return (
    <div className="ah-idle">
      <MoonIcon size={26} weight="duotone" />
      <div>
        <h2>Сейчас агенты ничего не делают</h2>
        <div className="ah-sub">
          {next?.next_run_at
            ? <>Следующий запуск: <strong>{lane?.short ?? live.titles[next.type] ?? next.type}</strong> в {fmtWhen(next.next_run_at, nowMs)}, {fmtIn(next.next_run_at, nowMs)}.</>
            : 'Расписания выключены. Запустите нужное направление кнопкой в карточке агента.'}
        </div>
      </div>
      <button className="btn btn-sm ah-idle-demo" disabled={busy} onClick={() => post('/api/agents/dev/fake-task', { marketplace: 'wb' })}
        title="Фиктивное задание: прогресс двигает сам сервер — проверка экрана без ПК">
        Демо-задание
      </button>
    </div>
  );
}

// ─── «Сутки»: шкала 00–24 МСК по направлениям ───────────────────────────────

function DayTrack({ live }: { live: Live }) {
  const nowMs = live.now;
  const day = mskDayStart(nowMs);
  const x = (t: number) => `${Math.max(0, Math.min(100, ((t - day) / DAY_MS) * 100))}%`;
  const inDay = (t: number | null | undefined) => !!t && t >= day && t < day + DAY_MS;
  const hours = [0, 3, 6, 9, 12, 15, 18, 21];

  return (
    <section className="card ah-day" aria-labelledby="ah-day-title">
      <div className="ah-section-head">
        <h2 id="ah-day-title">Сутки агентов</h2>
        <div className="ah-legend">
          <span><i className="ah-lg ah-lg--done" /> выполнено</span>
          <span><i className="ah-lg ah-lg--fail" /> ошибка</span>
          <span><i className="ah-lg ah-lg--run" /> идёт</span>
          <span><i className="ah-lg ah-lg--plan" /> по плану</span>
        </div>
      </div>
      <div className="ah-day-scroll">
        <div className="ah-day-grid">
          <div />
          <div className="ah-axis">
            {hours.map(h => <span key={h} style={{ left: `${(h / 24) * 100}%` }}>{String(h).padStart(2, '0')}:00</span>)}
            <span className="ah-axis-now" style={{ left: x(nowMs) }}>{fmtClock(nowMs)}</span>
          </div>

          {ALL_LANES.map(l => {
            const match = sameLane(l);
            const sch = scheduleOf(l, live);
            const done = live.finished_today.filter(t => match(t) && inDay(t.finished_at));
            const running = live.tasks.filter(match);
            const queued = live.queued.filter(t => match(t) && inDay(t.scheduled_for));
            const planned = sch?.enabled ? cronTimes(sch.cron, day).filter(t => t > nowMs) : [];
            return (
              <div key={l.type + l.mp} className="ah-day-row" style={{ ['--lane' as any]: l.color }}>
                <div className="ah-day-label">
                  <span className="ah-lane-dot" />
                  <div>
                    <div className="ah-day-name">{l.short}</div>
                    <div className="ah-sub">{sch ? (sch.enabled ? cronLabel(sch.cron) : 'расписание выключено') : 'вручную'}</div>
                  </div>
                </div>
                <div className="ah-day-track">
                  {done.map(t => {
                    const start = Math.max(day, t.started_at ?? t.finished_at!);
                    const ok = t.status === 'done';
                    const cls = ok ? 'done' : t.status === 'cancelled' ? 'cancel' : 'fail';
                    const tip = `${fmtClock(t.started_at)}–${fmtClock(t.finished_at)}: ${ok ? (t.summary || 'выполнено') : t.status === 'cancelled' ? 'отменено' : `ошибка — ${t.error ?? 'неизвестно'}`}`;
                    return (
                      <span key={t.id} className={`ah-seg ah-seg--${cls}`} title={tip}
                        style={{ left: x(start), width: `calc(${x(t.finished_at!)} - ${x(start)})` }} />
                    );
                  })}
                  {running.map(t => {
                    const start = Math.max(day, t.started_at ?? t.created_at);
                    const pct = taskPct(t);
                    return (
                      <span key={t.id} className="ah-seg ah-seg--run" title={`Идёт с ${fmtClock(t.started_at)}${pct !== null ? `, готово ${pct}%` : ''}`}
                        style={{ left: x(start), width: `calc(${x(nowMs)} - ${x(start)})` }}>
                        <b>{pct !== null ? `${pct}%` : 'старт'}</b>
                      </span>
                    );
                  })}
                  {queued.map(t => (
                    <span key={t.id} className="ah-pin ah-pin--queued" style={{ left: x(t.scheduled_for) }} title={`В очереди на ${fmtClock(t.scheduled_for)}`} />
                  ))}
                  {planned.map(t => (
                    <span key={t} className="ah-pin" style={{ left: x(t) }} title={`По расписанию в ${fmtClock(t)}`} />
                  ))}
                </div>
              </div>
            );
          })}

          <div />
          <div className="ah-now-layer" aria-hidden><span className="ah-now-line" style={{ left: x(nowMs) }} /></div>
        </div>
      </div>
    </section>
  );
}

// ─── Карточки агентов ───────────────────────────────────────────────────────

type LaneState = { kind: 'running' | 'queued' | 'paused' | 'ok' | 'failed' | 'never'; chip: string; text: string };

function laneState(l: Lane, live: Live): LaneState {
  const match = sameLane(l);
  const act = live.tasks.find(match);
  if (act) return { kind: 'running', chip: 'работает', text: act.progress?.message ?? 'Запускается' };
  const q = live.queued.find(match);
  if (q) return { kind: 'queued', chip: 'в очереди', text: `Стоит в очереди на ${fmtClock(q.scheduled_for)} и ждёт свободный ПК` };
  const pz = live.pauses.find(p => p.marketplace === l.mp);
  if (pz) return { kind: 'paused', chip: 'на паузе', text: `Площадка на паузе: ${PAUSE_LABEL[pz.reason] ?? pz.reason}. Войдите в аккаунт в Chrome агента и снимите паузу вверху.` };
  const last = live.last_runs?.[`${l.type}:${l.mp}`];
  if (!last) return { kind: 'never', chip: 'не запускался', text: 'Ещё ни разу не запускался' };
  if (last.status === 'done') return { kind: 'ok', chip: 'в порядке', text: last.summary || 'Последний прогон прошёл без ошибок' };
  return { kind: 'failed', chip: 'ошибка', text: last.error ?? 'Последний прогон завершился ошибкой' };
}

const KIND_CHIP: Record<LaneState['kind'], string> = {
  running: 'info', queued: '', paused: 'bad', ok: 'good', failed: 'bad', never: '',
};

function LaneRow({ l, live, busy, post, hostOnline }: { l: Lane; live: Live; busy: boolean; post: Post; hostOnline: boolean }) {
  const st = laneState(l, live);
  const nowMs = live.now;
  const act = live.tasks.find(sameLane(l));
  const pct = act ? taskPct(act) : null;
  const last = live.last_runs?.[`${l.type}:${l.mp}`];
  const sch = scheduleOf(l, live);
  const blocked = st.kind === 'running' || st.kind === 'queued' || st.kind === 'paused';
  const lastDur = last?.started_at && last?.finished_at ? fmtSpan((last.finished_at - last.started_at) / 1000) : null;

  return (
    <div className={`ah-lane ah-lane--${st.kind}`} style={{ ['--lane' as any]: l.color }}>
      <div className="ah-lane-head">
        <span className="ah-lane-dot" />
        <span className="ah-lane-name">{l.label}</span>
        <span className={`chip ${KIND_CHIP[st.kind]}`}>{st.chip}</span>
        <button className="btn btn-sm ah-lane-btn" disabled={busy || blocked || !hostOnline}
          title={!hostOnline ? 'ПК с агентом не на связи — запустите агента на ПК' : blocked ? 'Уже выполняется, в очереди или площадка на паузе' : 'Поставить задание в очередь сейчас'}
          onClick={() => post('/api/agents/tasks', { type: l.type, marketplace: l.mp })}>
          <PlayIcon size={12} weight="fill" /> Запустить
        </button>
      </div>

      {st.kind === 'running' ? (
        <div className="ah-lane-live">
          <div className="ah-bar ah-bar--thin"><div className={`ah-bar-fill ${pct === null ? 'ah-bar-fill--wait' : ''}`} style={{ width: `${pct ?? 100}%` }} /></div>
          <span className="ah-lane-pct">{pct === null ? 'старт' : `${pct}%`}</span>
        </div>
      ) : (
        <div className={`ah-lane-text ${st.kind === 'failed' || st.kind === 'paused' ? 'ah-bad-text' : ''}`}>{st.text}</div>
      )}

      <dl className="ah-lane-facts">
        <div>
          <dt>Прошлый</dt>
          <dd>{last ? `${fmtPast(last.finished_at ?? last.created_at, nowMs)}, ${fmtAgo(last.finished_at ?? last.created_at, nowMs)} назад${lastDur ? `, шёл ${lastDur}` : ''}` : '—'}</dd>
        </div>
        <div>
          <dt>Следующий</dt>
          <dd>
            {st.kind === 'running' ? (act?.progress?.eta_sec ? `закончит ${fmtIn(nowMs + act.progress.eta_sec * 1000, nowMs)}` : 'идёт сейчас')
              : sch?.enabled && sch.next_run_at ? <>{fmtWhen(sch.next_run_at, nowMs)}, <strong>{fmtIn(sch.next_run_at, nowMs)}</strong></>
              : 'только вручную'}
          </dd>
        </div>
      </dl>
    </div>
  );
}

function AgentCards({ live, busy, post }: { live: Live; busy: boolean; post: Post }) {
  const [ov, setOv] = useState<ReviewsOverview | null>(null);
  const [ovErr, setOvErr] = useState<string | null>(null);
  const [collecting, setCollecting] = useState(false);
  const loadOv = useCallback(async () => {
    try { setOv(await reviewsApi.overview()); setOvErr(null); } catch (e: any) { setOvErr(e?.message || 'нет связи'); }
  }, []);
  useEffect(() => { void loadOv(); const t = setInterval(loadOv, 60_000); return () => clearInterval(t); }, [loadOv]);
  const collectNow = async () => {
    setCollecting(true);
    try { await reviewsApi.collect(); } catch (e: any) { setOvErr(`Сбор не удался: ${e?.message}`); }
    setCollecting(false); void loadOv();
  };
  const hostOnline = live.hosts.some(h => h.name !== 'dev-sim' && h.online && !h.paused);

  return (
    <div className="ah-agents">
      {AGENTS.map(a => {
        const states = a.lanes.map(l => laneState(l, live));
        const running = states.some(x => x.kind === 'running');
        const bad = states.some(x => x.kind === 'failed' || x.kind === 'paused');
        const head = running && bad ? 'работает, но есть проблема' : running ? 'работает' : bad ? 'нужно внимание' : 'в порядке';
        const headCls = bad ? 'bad' : running ? 'info' : 'good';
        return (
          <section key={a.num} className="card ah-agent">
            <div className="ah-agent-head">
              <span className="ah-agent-badge" aria-hidden><RobotIcon size={18} weight="duotone" /></span>
              <div>
                <h2>Агент {a.num}: {a.title}</h2>
                <div className="ah-sub">{a.about}</div>
              </div>
              <span className={`chip ${headCls} ah-agent-chip`}>{running && <span className="dot ah-pulse" />}{head}</span>
            </div>

            {a.lanes.map(l => <LaneRow key={l.type + l.mp} l={l} live={live} busy={busy} post={post} hostOnline={hostOnline} />)}

            {a.server && (
              <div className="ah-server">
                <div className="ah-lane-head">
                  <span className="ah-lane-name">Сбор на сервере</span>
                  <span className="ah-sub">каждые 10 мин</span>
                  <button className="btn btn-sm ah-lane-btn" disabled={collecting} onClick={collectNow}>
                    <ArrowsClockwiseIcon size={12} className={collecting ? 'spin' : undefined} /> Собрать сейчас
                  </button>
                </div>
                {ovErr && <div className="ah-bad-text ah-server-err">{ovErr}</div>}
                {ov && (
                  <table className="ah-server-tbl">
                    <tbody>
                      {SERVER_DIRS.map(d => {
                        const cs = ov.collect.find(x => x.direction === d.key);
                        const c = ov.counters[d.key];
                        const ok = !!cs?.ok;
                        return (
                          <tr key={d.key}>
                            <td>{ok ? <CheckCircleIcon size={15} weight="fill" color="var(--good)" /> : <WarningIcon size={15} weight="fill" color="var(--bad)" />}</td>
                            <td>{d.label}</td>
                            <td className="ah-sub">{cs?.at ? `${fmtAgo(cs.at, Date.now())} назад` : 'ещё не собиралось'}</td>
                            <td className="ah-num">{c ? <>без ответа <strong>{c.unanswered}</strong></> : ''}</td>
                            {!ok && cs?.error && <td className="ah-bad-text">{cs.error}</td>}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

// ─── Журнал: очередь и завершённые за сегодня ───────────────────────────────

function Timeline({ taskId }: { taskId: number }) {
  const [data, setData] = useState<{ stages: Array<{ stage: string; started_at: number; finished_at: number | null }> } | null>(null);
  useEffect(() => {
    fetch(`/api/agents/tasks/${taskId}/timeline`, { credentials: 'include' })
      .then(r => r.json()).then(setData).catch(() => setData({ stages: [] }));
  }, [taskId]);
  if (!data) return <div className="ah-sub">Загружаю этапы…</div>;
  if (!data.stages.length) return <div className="ah-sub">Этапы не записаны.</div>;
  const total = data.stages.reduce((a, s) => a + ((s.finished_at ?? s.started_at) - s.started_at), 0) || 1;
  return (
    <div>
      <div className="ah-tl">
        {data.stages.map((s, i) => {
          const dur = (s.finished_at ?? s.started_at) - s.started_at;
          return <span key={i} title={`${s.stage}: ${fmtSpan(dur / 1000)}`} style={{ width: `${Math.max(3, (dur / total) * 100)}%`, opacity: 1 - (i % 4) * 0.2 }} />;
        })}
      </div>
      <div className="ah-tl-legend">
        {data.stages.map((s, i) => <span key={i}>{s.stage}: {fmtSpan(((s.finished_at ?? s.started_at) - s.started_at) / 1000)}</span>)}
      </div>
    </div>
  );
}

function FinishedRow({ task, live }: { task: Task; live: Live }) {
  const [open, setOpen] = useState(false);
  const lane = laneOf(task);
  const dur = task.started_at && task.finished_at ? (task.finished_at - task.started_at) / 1000 : null;
  const ok = task.status === 'done';
  const statsStr = task.stats ? Object.entries(task.stats).map(([k, v]) => `${k}: ${v}`).join(', ') : '';
  return (
    <li className="ah-jrow-wrap">
      <button className="ah-jrow" onClick={() => setOpen(o => !o)} aria-expanded={open} style={{ ['--lane' as any]: lane?.color }}>
        <time>{fmtClock(task.finished_at)}</time>
        {ok ? <CheckCircleIcon size={16} weight="fill" color="var(--good)" />
          : task.status === 'cancelled' ? <ProhibitIcon size={16} color="var(--muted)" />
          : <WarningIcon size={16} weight="fill" color="var(--bad)" />}
        <span className="ah-jrow-name"><span className="ah-lane-dot" />{lane?.short ?? `${live.titles[task.type] ?? task.type} ${MP_LABEL[task.params?.marketplace ?? ''] ?? ''}`}</span>
        <span className={`ah-jrow-text ${!ok && task.status !== 'cancelled' ? 'ah-bad-text' : ''}`}>
          {ok ? (task.summary || 'выполнено') : task.status === 'cancelled' ? 'отменено' : (task.error || 'ошибка')}
        </span>
        <span className="ah-sub ah-num">{dur !== null ? fmtSpan(dur) : ''}</span>
        {open ? <CaretUpIcon size={14} /> : <CaretDownIcon size={14} />}
      </button>
      {open && (
        <div className="ah-jrow-more">
          <div className="ah-sub">Запущено {CREATOR_LABEL[task.created_by] ?? task.created_by}{statsStr ? `. ${statsStr}` : ''}</div>
          <Timeline taskId={task.id} />
        </div>
      )}
    </li>
  );
}

const JOURNAL_SHORT = 8;

function Journal({ live, busy, onCancel }: { live: Live; busy: boolean; onCancel: (id: number) => void }) {
  // Отзывы Ozon идут каждый час — без свёртки список к вечеру занимает экран.
  const [all, setAll] = useState(false);
  const finished = all ? live.finished_today : live.finished_today.slice(0, JOURNAL_SHORT);
  return (
    <section className="card ah-journal">
      <div className="ah-journal-col">
        <h2>Очередь</h2>
        {live.queued.length === 0
          ? <div className="ah-sub">Пусто. Задания по расписанию появятся здесь в момент запуска.</div>
          : (
            <ul className="ah-jlist">
              {live.queued.map(t => {
                const lane = laneOf(t);
                return (
                  <li key={t.id} className="ah-qrow" style={{ ['--lane' as any]: lane?.color }}>
                    <time>{fmtClock(t.scheduled_for)}</time>
                    <ClockIcon size={16} color="var(--muted)" />
                    <span className="ah-jrow-name"><span className="ah-lane-dot" />{lane?.short ?? live.titles[t.type] ?? t.type}</span>
                    <span className="ah-sub">{CREATOR_LABEL[t.created_by] ?? t.created_by}</span>
                    <button className="btn btn-sm" disabled={busy} onClick={() => onCancel(t.id)}>Отменить</button>
                  </li>
                );
              })}
            </ul>
          )}
      </div>
      <div className="ah-journal-col">
        <h2>Завершённые сегодня{live.finished_today.length ? ` (${live.finished_today.length})` : ''}</h2>
        {live.finished_today.length === 0
          ? <div className="ah-sub">Сегодня агенты ещё ничего не завершили.</div>
          : <ul className="ah-jlist">{finished.map(t => <FinishedRow key={t.id} task={t} live={live} />)}</ul>}
        {live.finished_today.length > JOURNAL_SHORT && (
          <button className="btn btn-sm ah-more" onClick={() => setAll(a => !a)} aria-expanded={all}>
            {all ? <><CaretUpIcon size={13} /> Свернуть</> : <><CaretDownIcon size={13} /> Показать все ({live.finished_today.length})</>}
          </button>
        )}
      </div>
    </section>
  );
}

// ─── Расход на нейросеть (бывший раздел «ИИ-агенты», 13.10.2026) ────────────
// Это НАШ учёт по ответам Anthropic, а не выгрузка их счёта: возможны
// расхождения на копейки. Остаток кредитов Anthropic по API не отдаёт.

const AI_LABEL: Record<string, string> = {
  insights: 'Дневной инсайт',
  'card-audit': 'Аудит карточек',
  'review-reply': 'Ответы на отзывы',
  'price-reason': 'Обоснование цены',
  'competitors-summary': 'Конкурентная разведка',
  chat: 'Чат-копилот',
};

const KEY_STATE: Record<AiHealth['state'], { label: string; color: string }> = {
  ok:             { label: 'работает',          color: 'var(--good)' },
  no_credit:      { label: 'кредиты кончились', color: 'var(--bad)' },
  invalid_key:    { label: 'ключ не принят',    color: 'var(--bad)' },
  not_configured: { label: 'ключ не задан',     color: 'var(--warn)' },
  unreachable:    { label: 'нет связи',         color: 'var(--warn)' },
};

const fmtRub = (n: number) => `${n.toFixed(2)} ₽`;

function useAiStatus() {
  const [usage, setUsage] = useState<UsageResponse | null>(null);
  const [health, setHealth] = useState<AiHealth | null>(null);
  useEffect(() => {
    fetchAiUsage(7).then(setUsage);
    const t = setInterval(() => fetchAiUsage(7, true).then(setUsage), 60_000);
    fetch('/api/ai/health', { credentials: 'include' })
      .then(r => r.json()).then((j: AiHealth) => setHealth(j))
      .catch(() => setHealth({
        ok: false, configured: false, state: 'unreachable',
        detail: 'Сервер не ответил на проверку ключа.', model: null, checkedAt: Date.now(),
        consoleUrl: 'https://console.anthropic.com/settings/billing',
      }));
    return () => clearInterval(t);
  }, []);
  return { usage, health };
}

/** Когда ключ не работает, все ИИ-блоки кабинета отдают ошибку — говорим об этом вверху. */
function AiAlert({ health }: { health: AiHealth | null }) {
  if (!health || health.state === 'ok') return null;
  return (
    <div className="ah-alert ah-alert--bad" role="alert">
      <WarningIcon size={15} weight="fill" />
      <span>
        Нейросеть не отвечает: {health.detail}
        {health.state === 'no_credit' && <> <a href={health.consoleUrl} target="_blank" rel="noreferrer">Пополнить баланс</a>.</>}
      </span>
    </div>
  );
}

function AiSpend({ usage, health }: { usage: UsageResponse | null; health: AiHealth | null }) {
  const [open, setOpen] = useState(false);
  const today = usage?.today ?? null;
  const limitRub = usage?.limitRub ?? 0;
  const costToday = today?.totalCostRub ?? 0;
  const limitPct = limitRub > 0 ? Math.min(100, Math.round((costToday / limitRub) * 100)) : 0;
  const barColor = limitPct > 80 ? 'var(--bad)' : limitPct > 50 ? 'var(--warn)' : 'var(--good)';

  // Разбивка по задачам за 7 дней: складываем дневные агрегаты.
  const byTask = new Map<string, { requests: number; costRub: number }>();
  for (const d of usage?.days ?? []) {
    for (const [k, v] of Object.entries(d.byAgent ?? {})) {
      const acc = byTask.get(k) ?? { requests: 0, costRub: 0 };
      acc.requests += v.requests; acc.costRub += v.costRub;
      byTask.set(k, acc);
    }
  }
  const rows = [...byTask.entries()].filter(([, v]) => v.requests > 0).sort((a, b) => b[1].costRub - a[1].costRub);
  const consoleUrl = health?.consoleUrl ?? 'https://console.anthropic.com/settings/billing';

  return (
    <section className="card ah-ai" aria-labelledby="ah-ai-title">
      <div className="ah-ai-row">
        <h2 id="ah-ai-title">Расход на нейросеть</h2>
        <span className="ah-ai-key" style={{ color: health ? KEY_STATE[health.state].color : 'var(--muted)' }}>
          ● {health ? KEY_STATE[health.state].label : 'проверка…'}
          {health?.model && <span className="ah-sub"> · {health.model}</span>}
        </span>
        {usage ? (
          <>
            <span className="ah-ai-fact">
              Сегодня <strong>{fmtRub(costToday)}</strong>
              {limitRub > 0 && <span className="ah-sub"> из {limitRub} ₽</span>}
              {limitRub > 0 && <span className="ah-ai-bar"><span style={{ width: `${limitPct}%`, background: barColor }} /></span>}
            </span>
            <span className="ah-ai-fact">
              7 дней <strong>{fmtRub(usage.totalRub ?? 0)}</strong>
              <span className="ah-sub"> · ${(usage.totalUsd ?? 0).toFixed(2)}</span>
            </span>
            <span className="ah-ai-fact">Запросов сегодня <strong>{(today?.totalRequests ?? 0).toLocaleString('ru-RU')}</strong></span>
            <button className="btn btn-sm ah-ai-more" onClick={() => setOpen(o => !o)} aria-expanded={open}>
              {open ? <CaretUpIcon size={13} /> : <CaretDownIcon size={13} />} По задачам
            </button>
          </>
        ) : <span className="ah-sub">Статистика трат пока недоступна.</span>}
      </div>

      {open && usage && (
        <div className="ah-ai-detail">
          {rows.length === 0
            ? <div className="ah-sub">За 7 дней нейросеть не вызывалась.</div>
            : (
              <table className="ah-server-tbl">
                <tbody>
                  {rows.map(([k, v]) => (
                    <tr key={k}>
                      <td>{AI_LABEL[k] ?? k}</td>
                      <td className="ah-sub ah-num">{v.requests.toLocaleString('ru-RU')} запр.</td>
                      <td className="ah-num"><strong>{fmtRub(v.costRub)}</strong></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          <div className="ah-sub ah-ai-note">
            Учёт платформы по ответам Anthropic, рубли по курсу {usage.fx ? `${usage.fx.rub.toFixed(2)} ₽${usage.fx.source === 'cbr' ? ' (ЦБ)' : ''}` : 'ЦБ'}.
            Остаток на счету видно только в <a href={consoleUrl} target="_blank" rel="noreferrer">консоли Anthropic</a>.
          </div>
        </div>
      )}
    </section>
  );
}

// ─── Страница ────────────────────────────────────────────────────────────────

export function AgentHosts() {
  const [live, setLive] = useState<Live | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const ai = useAiStatus();

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/agents/live', { credentials: 'include' });
      if (!r.ok) { setErr(`сервер ответил ${r.status}`); return; }
      setLive(await r.json()); setErr(null);
    } catch { setErr('нет связи с сервером'); }
  }, []);

  useEffect(() => {
    void load();
    const start = () => {
      if (timer.current) clearInterval(timer.current);
      timer.current = setInterval(load, document.hidden ? 30_000 : 4_000);
    };
    start();
    document.addEventListener('visibilitychange', start);
    return () => { if (timer.current) clearInterval(timer.current); document.removeEventListener('visibilitychange', start); };
  }, [load]);

  const post = useCallback(async (url: string, bodyObj?: unknown) => {
    setBusy(true);
    try { await fetch(url, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(bodyObj ?? {}) }); }
    finally { setBusy(false); void load(); }
  }, [load]);

  const cancel = useCallback((id: number) => { void post(`/api/agents/tasks/${id}/cancel`); }, [post]);

  if (!live) return <div className="card">{err ? `Не удалось загрузить данные агентов: ${err}. Страница повторит попытку сама.` : 'Загружаю…'}</div>;

  return (
    <div className="ah-page">
      {err && <div className="ah-alert ah-alert--warn"><WarningIcon size={15} weight="fill" /> Связь с сервером прервалась ({err}), данные могут быть устаревшими.</div>}
      <AiAlert health={ai.health} />
      <StatusBar live={live} busy={busy} post={post} />

      <section aria-label="Сейчас">
        {live.tasks.length > 0
          ? <div className="ah-runs">{live.tasks.map(t => <RunningCard key={t.id} task={t} live={live} onCancel={cancel} />)}</div>
          : <IdleCard live={live} busy={busy} post={post} />}
      </section>

      <DayTrack live={live} />
      <AgentCards live={live} busy={busy} post={post} />
      <Journal live={live} busy={busy} onCancel={cancel} />
      <AiSpend usage={ai.usage} health={ai.health} />
    </div>
  );
}
