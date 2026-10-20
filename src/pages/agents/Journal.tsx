/** «Сборщики» → журнал: очередь и завершённые за сегодня. */
import { useEffect, useState } from 'react';
import { WarningIcon, CheckCircleIcon, ProhibitIcon, ClockIcon, CaretDownIcon, CaretUpIcon } from '@phosphor-icons/react';
import { type Task, type Live, MP_LABEL, CREATOR_LABEL, fmtClock, fmtSpan, laneOf } from './model';
import { notifyUnauthorized } from '../../api/http';

// ─── Журнал: очередь и завершённые за сегодня ───────────────────────────────

function Timeline({ taskId }: { taskId: number }) {
  const [data, setData] = useState<{ stages: Array<{ stage: string; started_at: number; finished_at: number | null }> } | null>(null);
  useEffect(() => {
    // Ответ с ошибкой ({error}) раньше попадал в состояние без stages, и
    // data.stages.length ронял всю страницу.
    fetch(`/api/agents/tasks/${taskId}/timeline`, { credentials: 'include' })
      .then(r => { notifyUnauthorized(r.status); return r.ok ? r.json() : null; })
      .then(j => setData({ stages: Array.isArray(j?.stages) ? j.stages : [] }))
      .catch(() => setData({ stages: [] }));
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

export function Journal({ live, busy, onCancel }: { live: Live; busy: boolean; onCancel: (id: number) => void }) {
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
