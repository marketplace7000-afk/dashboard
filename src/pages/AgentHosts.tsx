/**
 * Экран «Сборщики · В работе» — живая визуализация сети агентов (ТЗ раздел 7.1).
 *
 * Назначение: за 3 секунды понять, какие агенты живы, что каждый делает сейчас,
 * на каком шаге, сколько осталось и не застрял ли он.
 *
 * Источник данных — только сервер: GET /api/agents/live раз в 4 с, пока вкладка
 * видима (скрыта — раз в 30 с). На клиенте ничего не вычисляется, кроме
 * форматирования (конституция). Списки этапов приезжают в ответе live.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  RobotIcon, PlayIcon, XCircleIcon, PauseIcon, WarningIcon, CheckCircleIcon,
  ProhibitIcon, ClockIcon, CaretDownIcon, CaretUpIcon,
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
type Schedule = { id: number; type: string; cron: string; enabled: boolean; next_run_at: number | null };
type Live = {
  ok: boolean; disabled?: boolean; hosts: Host[]; tasks: Task[]; queued: Task[];
  finished_today: Task[]; pauses: Pause[]; runs: Run[]; schedules?: Schedule[];
  stages: Record<string, StageDef[]>; titles: Record<string, string>; now: number;
};

const MP_LABEL: Record<string, string> = { wb: 'Wildberries', ozon: 'Ozon' };
const PAUSE_LABEL: Record<string, string> = { captcha: 'капча', blocked: 'блокировка', login_required: 'нужен вход' };
const CREATOR_LABEL: Record<string, string> = { schedule: 'по расписанию', panel: 'запуск из панели', button: 'кнопка «Обновить цены»', dev: 'демо' };

const fmtClock = (ms: number | null | undefined) =>
  ms ? new Date(ms).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : '—';
const fmtAgo = (ms: number, nowMs: number) => {
  const s = Math.max(0, Math.round((nowMs - ms) / 1000));
  if (s < 60) return `${s} с`;
  if (s < 3600) return `${Math.round(s / 60)} мин`;
  return `${Math.floor(s / 3600)} ч ${Math.round((s % 3600) / 60)} мин`;
};
const fmtDur = (sec: number) => {
  if (sec < 90) return `${Math.round(sec)} с`;
  return `≈ ${Math.round(sec / 60)} мин`;
};

// ─── Компоненты ──────────────────────────────────────────────────────────────

function Stepper({ stages, progress }: { stages: StageDef[]; progress: Progress | null | undefined }) {
  const cur = progress ? progress.stage_index : 0; // 1-based; 0 = не начато
  return (
    <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 4, margin: '10px 0' }}>
      {stages.map((s, i) => {
        const idx = i + 1;
        const state = idx < cur ? 'done' : idx === cur ? 'active' : 'todo';
        const color = state === 'done' ? 'var(--good)' : state === 'active' ? 'var(--accent, #4f6ef7)' : 'var(--muted)';
        return (
          <div key={s.stage} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            {i > 0 && <span style={{ color: 'var(--muted)', opacity: .5 }}>→</span>}
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 8px', borderRadius: 12,
              fontSize: 12, fontWeight: state === 'active' ? 600 : 500, color,
              background: state === 'active' ? 'color-mix(in srgb, var(--accent, #4f6ef7) 12%, transparent)' : 'transparent',
              border: `1px solid ${state === 'todo' ? 'var(--border, #e3e6ee)' : color}`,
              animation: state === 'active' ? 'agents-pulse 1.6s ease-in-out infinite' : undefined,
            }}>
              {state === 'done' && <CheckCircleIcon size={13} weight="fill" />}
              {s.title}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function ProgressBar({ p }: { p: Progress }) {
  const pct = p.items_total ? Math.min(100, Math.round(((p.items_done ?? 0) / p.items_total) * 100)) : null;
  return (
    <div>
      <div style={{ height: 8, borderRadius: 4, background: 'var(--border, #e9ebf2)', overflow: 'hidden' }}>
        <div style={{
          height: '100%', borderRadius: 4, background: 'var(--accent, #4f6ef7)',
          width: pct === null ? '100%' : `${pct}%`,
          opacity: pct === null ? .35 : 1,
          transition: 'width .6s ease',
        }} />
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
        <span>{p.items_total ? `${p.items_done ?? 0} / ${p.items_total}` : ' '}{p.current_item ? ` · ${p.current_item}` : ''}</span>
        <span>{p.eta_sec ? fmtDur(p.eta_sec) : ''}</span>
      </div>
    </div>
  );
}

function Timeline({ taskId }: { taskId: number }) {
  const [data, setData] = useState<{ stages: Array<{ stage: string; started_at: number; finished_at: number | null }> } | null>(null);
  useEffect(() => {
    fetch(`/api/agents/tasks/${taskId}/timeline`, { credentials: 'include' })
      .then(r => r.json()).then(setData).catch(() => setData({ stages: [] }));
  }, [taskId]);
  if (!data) return <div style={{ fontSize: 12, color: 'var(--muted)', padding: '6px 0' }}>Загружаю таймлайн…</div>;
  if (!data.stages.length) return <div style={{ fontSize: 12, color: 'var(--muted)', padding: '6px 0' }}>Этапы не записаны.</div>;
  const total = data.stages.reduce((a, s) => a + ((s.finished_at ?? s.started_at) - s.started_at), 0) || 1;
  return (
    <div style={{ padding: '8px 0' }}>
      <div style={{ display: 'flex', height: 14, borderRadius: 4, overflow: 'hidden', border: '1px solid var(--border, #e3e6ee)' }}>
        {data.stages.map((s, i) => {
          const dur = (s.finished_at ?? s.started_at) - s.started_at;
          const w = Math.max(3, Math.round((dur / total) * 100));
          const colors = ['#4f6ef7', '#7c93f9', '#a9b8fb', '#5cb98a', '#e0b252'];
          return <div key={i} title={`${s.stage}: ${fmtDur(dur / 1000)}`} style={{ width: `${w}%`, background: colors[i % colors.length] }} />;
        })}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
        {data.stages.map((s, i) => (
          <span key={i}>{s.stage}: {fmtDur(((s.finished_at ?? s.started_at) - s.started_at) / 1000)}</span>
        ))}
      </div>
    </div>
  );
}

function TaskCard({ task, live, onCancel }: { task: Task; live: Live; onCancel: (id: number) => void }) {
  const stages = live.stages[task.type] ?? [];
  const p = task.progress;
  const nowMs = live.now;
  const staleSec = task.progress_updated_at ? (nowMs - task.progress_updated_at) / 1000 : null;
  const stale = task.status === 'running' && staleSec !== null && staleSec > 180;
  const dead = task.status === 'running' && staleSec !== null && staleSec > 900;
  const taskRuns = live.runs.filter(r => r.task_id === task.id).slice(0, 5);
  return (
    <div className="card" style={{ borderLeft: '3px solid var(--accent, #4f6ef7)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <div>
          <strong>{live.titles[task.type] ?? task.type}</strong>
          {' · '}{MP_LABEL[task.params?.marketplace ?? ''] ?? '—'}
          <span style={{ color: 'var(--muted)', fontSize: 12, marginLeft: 8 }}>
            {CREATOR_LABEL[task.created_by] ?? task.created_by} · старт {fmtClock(task.started_at)} · идёт {task.started_at ? fmtAgo(task.started_at, nowMs) : '—'}
          </span>
        </div>
        <button className="btn" onClick={() => onCancel(task.id)}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, padding: '4px 10px' }}>
          <XCircleIcon size={14} /> Отменить
        </button>
      </div>

      {(stale || dead) && (
        <div style={{
          margin: '8px 0 0', padding: '6px 10px', borderRadius: 8, fontSize: 12, fontWeight: 600,
          background: dead ? 'color-mix(in srgb, var(--bad, #d64545) 12%, transparent)' : 'color-mix(in srgb, var(--warn, #d69b45) 14%, transparent)',
          color: dead ? 'var(--bad, #d64545)' : 'var(--warn, #b07f2f)',
        }}>
          <WarningIcon size={13} weight="fill" style={{ verticalAlign: -2 }} />{' '}
          {dead ? `Похоже, зависло: нет обновлений ${fmtAgo(task.progress_updated_at!, nowMs)}` : `Нет обновлений ${fmtAgo(task.progress_updated_at!, nowMs)}`}
        </div>
      )}

      <Stepper stages={stages} progress={p} />
      {p && <>
        <div style={{ fontSize: 15, fontWeight: 600, margin: '2px 0 6px' }}>{p.message}</div>
        <ProgressBar p={p} />
      </>}
      {!p && <div style={{ fontSize: 13, color: 'var(--muted)' }}>Ожидание первого отчёта от хоста…</div>}

      {taskRuns.length > 0 && (
        <div style={{ marginTop: 10, borderTop: '1px solid var(--border, #edeff5)', paddingTop: 6 }}>
          {taskRuns.map((r, i) => (
            <div key={i} style={{ fontSize: 12, display: 'flex', gap: 8, padding: '2px 0', color: r.level === 'error' ? 'var(--bad)' : r.level === 'warn' ? 'var(--warn)' : 'var(--muted)' }}>
              <span style={{ flexShrink: 0 }}>{fmtClock(r.created_at)}</span>
              <span>{r.message === 'stage' ? `этап: ${r.data?.stage ?? ''}` : r.message}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function FinishedRow({ task, live }: { task: Task; live: Live }) {
  const [open, setOpen] = useState(false);
  const dur = task.started_at && task.finished_at ? (task.finished_at - task.started_at) / 1000 : null;
  const ok = task.status === 'done';
  const statsStr = task.stats
    ? Object.entries(task.stats).map(([k, v]) => `${k}: ${v}`).join(', ')
    : '';
  return (
    <div style={{ borderTop: '1px solid var(--border, #edeff5)' }}>
      <div onClick={() => setOpen(o => !o)} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 0', cursor: 'pointer', fontSize: 13 }}>
        {ok ? <CheckCircleIcon size={15} weight="fill" color="var(--good, #3c9d67)" />
            : task.status === 'cancelled' ? <ProhibitIcon size={15} color="var(--muted)" />
            : <WarningIcon size={15} weight="fill" color="var(--bad, #d64545)" />}
        <span style={{ fontWeight: 600 }}>{live.titles[task.type] ?? task.type}</span>
        <span>{MP_LABEL[task.params?.marketplace ?? ''] ?? ''}</span>
        <span style={{ color: 'var(--muted)' }}>
          {fmtClock(task.finished_at)}{dur !== null ? ` · ${fmtDur(dur)}` : ''}
          {ok && task.summary ? ` · ${task.summary}` : ''}
          {!ok && task.error ? ` · ${task.error}` : ''}
        </span>
        <span style={{ marginLeft: 'auto', color: 'var(--muted)' }}>{open ? <CaretUpIcon size={14} /> : <CaretDownIcon size={14} />}</span>
      </div>
      {open && (
        <div style={{ paddingBottom: 8 }}>
          {statsStr && <div style={{ fontSize: 12, color: 'var(--muted)' }}>{statsStr}</div>}
          <Timeline taskId={task.id} />
        </div>
      )}
    </div>
  );
}

// ─── Страница ────────────────────────────────────────────────────────────────

export function AgentHosts() {
  const [live, setLive] = useState<Live | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

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

  if (!live) return <div className="card">{err ? `Не удалось загрузить: ${err}` : 'Загружаю…'}</div>;

  const nowMs = live.now;
  const anyHost = live.hosts.filter(h => h.name !== 'dev-sim');
  const nextSchedule = (live.schedules ?? []).filter(s => s.enabled && s.next_run_at)
    .sort((a, b) => (a.next_run_at ?? 0) - (b.next_run_at ?? 0))[0];

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <style>{`@keyframes agents-pulse { 0%,100% { opacity: 1 } 50% { opacity: .55 } }`}</style>

      {/* Полоса хостов + паузы площадок */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        {live.hosts.map(h => {
          const cur = live.tasks.find(t => t.claimed_by === h.name);
          const dot = h.paused ? 'var(--warn, #d69b45)' : h.online ? 'var(--good, #3c9d67)' : 'var(--muted, #9aa1b5)';
          return (
            <div key={h.name} className="card" style={{ minWidth: 230, flex: '0 1 auto', padding: '12px 14px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ width: 9, height: 9, borderRadius: '50%', background: dot, flexShrink: 0 }} />
                <RobotIcon size={16} />
                <strong>{h.name}</strong>
                <span style={{ fontSize: 11, color: 'var(--muted)' }}>{h.version}</span>
                <button className="btn" disabled={busy} title={h.paused ? 'Продолжить' : 'Пауза'}
                  onClick={() => post(`/api/agents/hosts/${h.name}/${h.paused ? 'resume' : 'pause'}`)}
                  style={{ marginLeft: 'auto', padding: '2px 8px', fontSize: 11 }}>
                  {h.paused ? <PlayIcon size={12} /> : <PauseIcon size={12} />}
                </button>
              </div>
              <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 5 }}>
                {h.online
                  ? (cur
                      ? `Сейчас: ${live.titles[cur.type] ?? cur.type}${cur.progress ? ` · этап ${cur.progress.stage_index} из ${cur.progress.stages_total}` : ''}`
                      : h.paused ? 'На паузе' : `Свободен${nextSchedule?.next_run_at ? `, следующее в ${fmtClock(nextSchedule.next_run_at)}` : ''}`)
                  : `Не выходил на связь ${h.last_seen_at ? fmtAgo(h.last_seen_at, nowMs) : '— ещё ни разу'}`}
                {!h.chrome_ok && h.online && <span style={{ color: 'var(--warn)' }}> · Chrome не готов</span>}
              </div>
            </div>
          );
        })}
        {live.pauses.map(pz => (
          <div key={pz.id} className="card" style={{ minWidth: 220, padding: '12px 14px', borderLeft: '3px solid var(--bad, #d64545)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 600, color: 'var(--bad, #d64545)' }}>
              <WarningIcon size={15} weight="fill" />
              {MP_LABEL[pz.marketplace]} на паузе ({PAUSE_LABEL[pz.reason] ?? pz.reason})
            </div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
              {pz.paused_until ? `до ${fmtClock(pz.paused_until)}` : 'до ручного снятия — войдите в аккаунт в профиле агента'}
            </div>
            <button className="btn" disabled={busy} onClick={() => post(`/api/agents/pauses/${pz.id}/clear`)}
              style={{ marginTop: 6, fontSize: 12, padding: '3px 10px' }}>Снять паузу</button>
          </div>
        ))}
        {!anyHost.length && (
          <div className="card" style={{ padding: '12px 14px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><RobotIcon size={16} /><strong>Хостов пока нет</strong></div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
              Установите agent-host на ПК (agent-host/README.md) — он появится здесь после первого heartbeat.
              Экран можно проверить демо-заданием.
            </div>
          </div>
        )}
      </div>

      {/* Карточки текущих заданий */}
      {live.tasks.length > 0 && (
        <div style={{ display: 'grid', gap: 10 }}>
          {live.tasks.map(t => <TaskCard key={t.id} task={t} live={live} onCancel={cancel} />)}
        </div>
      )}
      {live.tasks.length === 0 && (
        <div className="card" style={{ textAlign: 'center', padding: '22px 14px' }}>
          <ClockIcon size={22} style={{ color: 'var(--muted)' }} />
          <div style={{ fontWeight: 600, marginTop: 4 }}>Агенты свободны</div>
          <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 2 }}>
            {nextSchedule?.next_run_at
              ? `Следующее по расписанию: ${live.titles[nextSchedule.type] ?? nextSchedule.type} в ${fmtClock(nextSchedule.next_run_at)}`
              : 'Расписания выключены — запустите вручную.'}
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 12, flexWrap: 'wrap' }}>
            <button className="btn" disabled={busy} onClick={() => post('/api/agents/tasks', { type: 'showcase_prices', marketplace: 'wb' })}>
              <PlayIcon size={13} style={{ verticalAlign: -2 }} /> Цены WB сейчас
            </button>
            <button className="btn" disabled={busy} onClick={() => post('/api/agents/tasks', { type: 'showcase_prices', marketplace: 'ozon' })}>
              <PlayIcon size={13} style={{ verticalAlign: -2 }} /> Цены Ozon сейчас
            </button>
            <button className="btn" disabled={busy} onClick={() => post('/api/agents/dev/fake-task', { marketplace: 'wb' })}
              title="Фиктивное задание: прогресс двигает сам сервер — проверка экрана без хоста">
              Демо-задание
            </button>
          </div>
        </div>
      )}

      {/* Очередь и завершённые за сегодня */}
      <div className="card">
        <h2>Очередь на сегодня</h2>
        {live.queued.length === 0 && <div style={{ fontSize: 13, color: 'var(--muted)' }}>В очереди пусто.</div>}
        {live.queued.map(t => (
          <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, padding: '5px 0', borderTop: '1px solid var(--border, #edeff5)' }}>
            <ClockIcon size={14} style={{ color: 'var(--muted)' }} />
            <span style={{ fontWeight: 600 }}>{live.titles[t.type] ?? t.type}</span>
            <span>{MP_LABEL[t.params?.marketplace ?? ''] ?? ''}</span>
            <span style={{ color: 'var(--muted)' }}>{CREATOR_LABEL[t.created_by] ?? t.created_by} · на {fmtClock(t.scheduled_for)}</span>
            <button className="btn" disabled={busy} onClick={() => cancel(t.id)} style={{ marginLeft: 'auto', fontSize: 11, padding: '2px 8px' }}>Отменить</button>
          </div>
        ))}
        {live.finished_today.length > 0 && <>
          <h2 style={{ marginTop: 16 }}>Завершённые за сегодня</h2>
          {live.finished_today.map(t => <FinishedRow key={t.id} task={t} live={live} />)}
        </>}
      </div>
    </div>
  );
}
