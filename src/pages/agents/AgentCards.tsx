/** «Сборщики»: карточки агентов с направлениями и кнопками запуска. */
import { useCallback, useEffect, useState } from 'react';
import { RobotIcon, PlayIcon, WarningIcon, CheckCircleIcon, ArrowsClockwiseIcon } from '@phosphor-icons/react';
import {
  type Live, type Post, PAUSE_LABEL, fmtClock, fmtSpan, fmtAgo, fmtIn, fmtWhen, fmtPast, taskPct, type Lane, AGENTS, sameLane, scheduleOf, SERVER_DIRS,
} from './model';
import { reviewsApi } from '../../api/reviews';
import type { ReviewsOverview } from '../../../shared/reviews';

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

export function AgentCards({ live, busy, post }: { live: Live; busy: boolean; post: Post }) {
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
