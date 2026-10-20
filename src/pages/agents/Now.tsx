/** «Сборщики»: связь с ПК и паузы площадок, «Сейчас» — идущие задания крупно. */
import { useState } from 'react';
import {
  PlayIcon, XCircleIcon, PauseIcon, WarningIcon, CheckCircleIcon, CaretDownIcon, CaretUpIcon, MoonIcon,
} from '@phosphor-icons/react';
import {
  type StageDef, type Progress, type Task, type Live, type Post, MP_LABEL, PAUSE_LABEL, CREATOR_LABEL, fmtClock, fmtSpan, fmtAgo, fmtIn, fmtWhen, taskPct, ALL_LANES, laneOf,
} from './model';

// ─── Связь с ПК и паузы площадок ────────────────────────────────────────────

export function StatusBar({ live, busy, post }: { live: Live; busy: boolean; post: Post }) {
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

export function RunningCard({ task, live, onCancel }: { task: Task; live: Live; onCancel: (id: number) => void }) {
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

export function IdleCard({ live, busy, post }: { live: Live; busy: boolean; post: Post }) {
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
      {/* Фиктивный прогон — только при разработке: на проде клиент принимал его за настоящий. */}
      {import.meta.env.DEV && (
        <button className="btn btn-sm ah-idle-demo" disabled={busy} onClick={() => post('/api/agents/dev/fake-task', { marketplace: 'wb' })}
          title="Фиктивное задание: прогресс двигает сам сервер — проверка экрана без ПК">
          Демо-задание
        </button>
      )}
    </div>
  );
}
