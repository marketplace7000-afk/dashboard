/** «Сборщики» → «Сутки»: шкала 00–24 МСК по направлениям. */
import { type Live, DAY_MS, mskDayStart, fmtClock, cronTimes, cronLabel, taskPct, ALL_LANES, sameLane, schedulesOf } from './model';

// ─── «Сутки»: шкала 00–24 МСК по направлениям ───────────────────────────────

export function DayTrack({ live }: { live: Live }) {
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
            const schs = schedulesOf(l, live);
            const sch = schs.find(x => x.enabled) ?? schs[0];
            const done = live.finished_today.filter(t => match(t) && inDay(t.finished_at));
            const running = live.tasks.filter(match);
            const queued = live.queued.filter(t => match(t) && inDay(t.scheduled_for));
            const planned = schs.filter(x => x.enabled).flatMap(x => cronTimes(x.cron, day)).filter(t => t > nowMs).sort((a, b) => a - b);
            return (
              <div key={l.type + l.mp} className="ah-day-row" style={{ ['--lane' as any]: l.color }}>
                <div className="ah-day-label">
                  <span className="ah-lane-dot" />
                  <div>
                    <div className="ah-day-name">{l.short}</div>
                    <div className="ah-sub">{sch ? (schs.some(x => x.enabled) ? schs.filter(x => x.enabled).map(x => `${cronLabel(x.cron)}${x.params?.light ? ' (быстро)' : ''}`).join(' · ') : 'расписание выключено') : 'вручную'}</div>
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
