/**
 * «Доступы» → лист «Активность»: когда каждый человек начал и закончил
 * работу, сколько был на месте, в каких разделах и откуда входил.
 * Время — по Москве. Сервер: api/_lib/activity.ts, /api/access/activity.
 */
import { Fragment, useEffect, useState } from 'react';
import { CaretLeftIcon, CaretRightIcon, WarningIcon } from '@phosphor-icons/react';
import { apiGet, errText } from '../api/http';
import { mskDate } from '../utils/mskDate';

type Day = {
  day: string; first: number | null; last: number | null; onlineMin: number; activeMin: number; hours: number[];
  sections: Array<{ section: string; min: number; views: number }>;
  logins: Array<{ ts: number; ip: string; device: string }>; failedLogins: number;
};
type Person = { uid: number; login: string; name: string; role: string; active: boolean };
type DayData = {
  day: string; labels: Record<string, string>;
  people: Array<Person & { report: Day; lastSeen: number | null }>;
  unknownFailures: Array<{ login: string; count: number; lastTs: number; ip: string }>;
};
type History = { person: Person; labels: Record<string, string>; days: Day[] };

const TZ = 'Europe/Moscow';
const time = (ts: number | null) => (ts ? new Date(ts).toLocaleTimeString('ru-RU', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }) : '—');
const dateTime = (ts: number | null) => (ts ? new Date(ts).toLocaleString('ru-RU', { timeZone: TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : 'ещё не заходил');
const dur = (min: number) => (!min ? '—' : min < 60 ? `${min} мин` : `${Math.floor(min / 60)} ч ${String(min % 60).padStart(2, '0')} мин`);
const dayTitle = (d: string) => new Date(d + 'T12:00:00Z').toLocaleDateString('ru-RU', { weekday: 'short', day: 'numeric', month: 'long' });
const shift = (d: string, n: number) => new Date(Date.parse(d + 'T12:00:00Z') + n * 86_400_000).toISOString().slice(0, 10);

/** Полоска дня: 24 часа, высота столбика — активные минуты в часе. */
function HoursBar({ hours }: { hours: number[] }) {
  return (
    <div className="aa-hours" title="Активные минуты по часам (МСК), 0–24">
      {hours.map((m, h) => <span key={h} title={`${h}:00–${h + 1}:00 — ${m} мин`} style={{ height: `${Math.max(m ? 12 : 0, Math.round((m / 60) * 100))}%` }} />)}
    </div>
  );
}

export function AccessActivity() {
  const today = mskDate(0);
  const [day, setDay] = useState(today);
  const [data, setData] = useState<DayData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [history, setHistory] = useState<History | null>(null);

  const load = () => apiGet<DayData>(`/api/access/activity?day=${day}`).then(r => { setData(r.data); setError(null); }).catch(e => setError(errText(e)));
  useEffect(() => { setData(null); load(); }, [day]);
  // Сегодняшний день обновляем раз в минуту — видно, кто сейчас на месте.
  useEffect(() => {
    if (day !== today) return;
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [day, today]);

  const toggle = (uid: number) => {
    if (open === uid) { setOpen(null); setHistory(null); return; }
    setOpen(uid); setHistory(null);
    apiGet<History>(`/api/access/activity?uid=${uid}&days=14`).then(r => setHistory(r.data)).catch(e => setError(errText(e)));
  };
  const label = (s: string) => data?.labels[s] ?? history?.labels[s] ?? s;
  const now = Date.now();

  return (
    <div className="acc">
      <div className="card">
        <div className="flex-between acc-head">
          <div className="row gap-8 aa-nav">
            <button className="btn btn-sm" onClick={() => setDay(shift(day, -1))} title="Предыдущий день"><CaretLeftIcon size={14} /></button>
            <b className="aa-day">{dayTitle(day)}</b>
            <button className="btn btn-sm" onClick={() => setDay(shift(day, 1))} disabled={day >= today} title="Следующий день"><CaretRightIcon size={14} /></button>
            {day !== today && <button className="btn btn-sm" onClick={() => setDay(today)}>Сегодня</button>}
            <input className="input aa-date" type="date" value={day} max={today} onChange={e => e.target.value && setDay(e.target.value)} />
          </div>
          <p className="muted">Время по Москве. «На сайте» — кабинет был открыт на экране, «Работал» — из них минуты, когда двигалась мышь или нажимались клавиши. Нажмите на строку — разделы, входы и история за 2 недели.</p>
        </div>
      </div>

      {error && <div className="card sk-err"><WarningIcon size={16} /> {error} <button className="btn btn-sm" onClick={load}>Повторить</button></div>}
      {!data && !error && <div className="card muted">Загрузка…</div>}

      {data && (
        <div className="card sk-table-card">
          <div className="sk-scroll">
            <table className="sk-table aa-table">
              <thead><tr><th>Сотрудник</th><th>Начал</th><th>Закончил</th><th>На сайте</th><th>Работал</th><th>День по часам</th><th>Главные разделы</th></tr></thead>
              <tbody>
                {data.people.filter(p => p.active || p.report.onlineMin).map(p => {
                  const r = p.report;
                  const online = day === today && r.last !== null && now - r.last < 3 * 60_000;
                  return (
                    <Fragment key={p.uid}>
                      <tr className={r.onlineMin ? 'aa-row' : 'aa-row sk-row-muted'} onClick={() => toggle(p.uid)}>
                        <td>
                          <b>{p.name}</b>{online && <span className="aa-online" title="Сейчас на сайте">● сейчас</span>}
                          <div className="muted aa-sub">{p.uid === 0 ? 'общий пароль без логина' : p.login}{r.failedLogins ? <span className="aa-bad"> · неудачных входов: {r.failedLogins}</span> : null}</div>
                        </td>
                        {r.onlineMin ? (<>
                          <td>{time(r.first)}</td>
                          <td>{online ? '—' : time(r.last)}</td>
                          <td>{dur(r.onlineMin)}</td>
                          <td><b>{dur(r.activeMin)}</b></td>
                          <td><HoursBar hours={r.hours} /></td>
                          <td className="muted">{r.sections.filter(s => s.min).slice(0, 3).map(s => `${label(s.section)} ${dur(s.min)}`).join(' · ') || '—'}</td>
                        </>) : <td colSpan={6} className="muted">не заходил · последний раз {dateTime(p.lastSeen)}</td>}
                      </tr>
                      {open === p.uid && (
                        <tr className="aa-detail"><td colSpan={7}>
                          <div className="aa-grid">
                            <div>
                              <div className="field-label">Разделы за день</div>
                              {r.sections.length ? r.sections.map(s => (
                                <div key={s.section} className="aa-line"><span>{label(s.section)}</span><span className="muted">{dur(s.min)}{s.views ? ` · открывал ${s.views} раз` : ''}</span></div>
                              )) : <span className="muted">—</span>}
                            </div>
                            <div>
                              <div className="field-label">Входы за день</div>
                              {r.logins.length ? r.logins.map(l => (
                                <div key={l.ts} className="aa-line"><span>{time(l.ts)}</span><span className="muted">{l.device || 'устройство неизвестно'} · {l.ip}</span></div>
                              )) : <span className="muted">новых входов не было — работал в уже открытом кабинете</span>}
                            </div>
                          </div>
                          <div className="field-label aa-hist-title">Последние 14 дней</div>
                          {!history ? <span className="muted">Загрузка…</span> : (
                            <table className="sk-table aa-hist">
                              <thead><tr><th>День</th><th>Начал</th><th>Закончил</th><th>На сайте</th><th>Работал</th><th>Главный раздел</th></tr></thead>
                              <tbody>{history.days.map(d => (
                                <tr key={d.day} className={d.onlineMin ? '' : 'sk-row-muted'}>
                                  <td>{dayTitle(d.day)}</td>
                                  {d.onlineMin ? (<>
                                    <td>{time(d.first)}</td><td>{time(d.last)}</td><td>{dur(d.onlineMin)}</td><td><b>{dur(d.activeMin)}</b></td>
                                    <td className="muted">{d.sections[0] ? label(d.sections[0].section) : '—'}</td>
                                  </>) : <td colSpan={5} className="muted">не заходил</td>}
                                </tr>
                              ))}</tbody>
                            </table>
                          )}
                        </td></tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {data && data.unknownFailures.length > 0 && (
        <div className="card">
          <b>Попытки входа с несуществующими логинами</b>
          {data.unknownFailures.map(f => (
            <div key={f.login} className="aa-line"><span className="sk-mono">{f.login}</span><span className="muted">{f.count} раз, последний в {time(f.lastTs)} · {f.ip}</span></div>
          ))}
        </div>
      )}
    </div>
  );
}
