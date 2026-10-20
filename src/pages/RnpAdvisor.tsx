/**
 * Лист «Советник» в разделе РНП (этап А «Советник 2.0», 15.10.2026).
 *
 * Выпуски четыре раза в рабочий день (08:00, 12:00, 15:30, 17:30 МСК): темп дня против
 * того же часа в прошлые дни, разбор вчера и сигналы по товарам — что случилось, сколько ₽
 * на кону, что сделать и кому (реклама / цены / контент / поставки / карточка). Менеджер
 * отмечает «Сделано» или откладывает до завтра. История выпусков — 14 дней.
 * Данные — GET/POST /api/ads2/signals (api/_lib/ads/signals.ts).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowsClockwiseIcon, WarningIcon, WarningOctagonIcon, InfoIcon, LightbulbIcon, TrendUpIcon, CheckCircleIcon, ClockIcon, ArrowCounterClockwiseIcon,
} from '@phosphor-icons/react';
import { apiGet, apiPost, errText } from '../api/http';
import {
  SIGNAL_ROLE_LABEL, type Ads2Mp, type Ads2Signal, type Ads2SignalRole, type Ads2SignalsResponse, type Ads2AdvisorIssue, type Ads2AdvisorProduct, type Ads2AdvisorCause,
} from '../../shared/ads2';
import { nf1, rub, num, pct, ddmm, kRub, whenRel, ProductCell } from './ads2ui';

const WEEKDAY = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const wd = (d: string) => WEEKDAY[new Date(d + 'T12:00:00Z').getUTCDay()];
const ROLES: Ads2SignalRole[] = ['card', 'supply', 'ads', 'price', 'content'];
const SLOT_LABEL: Record<string, string> = { morning: 'Утро', noon: 'Полдень', day: 'День', evening: 'Вечер', manual: 'По кнопке' };
const hmOf = (ms: number) => new Date(ms + 3 * 3600_000).toISOString().slice(11, 16);
const dayWord = (n: number) => (n === 1 ? '1-й день' : `${n}-й день`);

function LevelIcon({ level }: { level: Ads2Signal['level'] | 'good' }) {
  const Icon = level === 'critical' ? WarningOctagonIcon : level === 'warn' ? WarningIcon : level === 'good' ? TrendUpIcon : InfoIcon;
  return <Icon size={18} weight="fill" />;
}

function Delta({ a, b }: { a: number; b: number }) {
  if (!b) return null;
  const v = Math.round((a / b - 1) * 100);
  if (!v) return <span className="muted adv-delta">как обычно</span>;
  return <span className={`adv-delta ${v < 0 ? 'bad' : 'good'}`}>{v > 0 ? '+' : ''}{v}% к обычному</span>;
}

// ─── Темп дня ───────────────────────────────────────────────────────────────

function PaceCards({ issue }: { issue: Ads2AdvisorIssue }) {
  const p = issue.pace;
  if (!p) return null;
  const t = hmOf(p.at);
  const base = p.base;
  const sub = (k: 'orders' | 'revenue' | 'spend', f: (v: number) => string) => base
    ? `обычно к ${t}: ${f(base[k])} (${base.days} дн)${p.fullDay ? ` · за день ${f(p.fullDay[k])}` : ''}`
    : p.fullDay ? `обычно за полный день ${f(p.fullDay[k])}` : '';
  return (
    <section className="ad2-kpis">
      <div className="card ad2-kpi"><div className="card-title">Заказов к {t}</div><div className="ad2-kpi-v">{num(p.orders)}</div>{base && <Delta a={p.orders} b={base.orders} />}<div className="ad2-kpi-sub">{sub('orders', v => nf1.format(v))}</div></div>
      <div className="card ad2-kpi"><div className="card-title">Выручка к {t}</div><div className="ad2-kpi-v">{kRub(p.revenue)}</div>{base && <Delta a={p.revenue} b={base.revenue} />}<div className="ad2-kpi-sub">{sub('revenue', kRub)}</div></div>
      <div className="card ad2-kpi"><div className="card-title">Реклама к {t}</div><div className="ad2-kpi-v">{rub(p.spend)}</div>{base && <Delta a={p.spend} b={base.spend} />}<div className="ad2-kpi-sub">{sub('spend', rub)}</div></div>
      <div className="card ad2-kpi"><div className="card-title">ДРР дня</div><div className={`ad2-kpi-v ${p.drr != null && p.drr > 10 ? 'bad' : ''}`}>{pct(p.drr)}</div><div className="ad2-kpi-sub">{p.fullDay && p.fullDay.revenue > 0 ? `обычно ${pct(Math.round(p.fullDay.spend / p.fullDay.revenue * 1000) / 10)} · норма 5%` : 'норма 5%'}</div></div>
    </section>
  );
}

/** Маржа месяца против плана (план владельца: ниже — нет KPI; край = план + запас; цель 20%+). */
function MonthMargin({ m }: { m: NonNullable<Ads2AdvisorIssue['monthMargin']> }) {
  const f1 = (v: number) => nf1.format(v);
  const state = m.pct == null ? 'none' : m.pct < m.plan ? 'bad' : m.pct < m.floor ? 'warn' : m.pct >= m.target ? 'good' : 'ok';
  const label = state === 'none' ? 'маржа не посчитана' : state === 'bad' ? 'ниже плана — KPI под угрозой' : state === 'warn' ? 'на грани плана' : state === 'good' ? 'цель достигнута' : 'выше края, ниже цели';
  const mon = `${m.month.slice(5)}.${m.month.slice(0, 4)}`;
  return (
    <section className={`card sg-mm sg-mm-${state}`}>
      <div className="sg-mm-main">
        <span className="card-title">Маржа месяца ({mon})</span>
        <b className="sg-mm-v">{m.pct == null ? '–' : `${f1(m.pct)}%`}</b>
        <span className={`chip ${state === 'bad' ? 'bad' : state === 'warn' ? 'warn' : state === 'good' ? 'good' : 'info'}`}>{label}</span>
      </div>
      <div className="sg-mm-scale" aria-hidden>
        {[['план', m.plan], ['край', m.floor], ['цель', m.target]].map(([t, v]) => (
          <span key={String(t)} className={`sg-mm-mark ${m.pct != null && m.pct >= Number(v) ? 'on' : ''}`}><b>{f1(Number(v))}%</b><span>{t}</span></span>
        ))}
      </div>
      <div className="muted sg-mm-sub">Средняя по выручке с начала месяца при текущей марже товаров; маржа известна по {Math.round(m.covered * 100)}% выручки ({kRub(m.revenue)} всего). План и запас — «Цены» → «Репрайсер».</div>
    </section>
  );
}

// ─── Сигналы ────────────────────────────────────────────────────────────────

function SignalRow({ s, onAct, busy }: { s: Ads2Signal; onAct: (id: number, action: 'done' | 'snooze' | 'reopen') => void; busy: boolean }) {
  const done = s.status === 'done', snoozed = s.status === 'snoozed', gone = s.status === 'gone';
  return (
    <div className={`sg-row adv-${s.level} ${done || gone ? 'sg-done' : ''} ${snoozed ? 'sg-snoozed' : ''}`}>
      <div className="sg-ico"><LevelIcon level={s.level} /></div>
      <div className="sg-prod"><ProductCell p={{ photo: s.photo, name: s.article, article: s.name, link: s.link }} /></div>
      <div className="sg-body">
        <div className="sg-title"><b>{s.title}</b>
          {s.days > 1 && <span className="chip warn">{dayWord(s.days)}</span>}
          {s.rub != null && s.rub >= 100 && <span className="chip bad">{kRub(s.rub)} на кону</span>}
          {done && <span className="chip good">сделано {s.statusAt ? whenRel(s.statusAt) : ''}</span>}
          {snoozed && <span className="chip info">отложено до утра</span>}
          {gone && <span className="chip">условие ушло</span>}
        </div>
        <div className="sg-text">{s.text}</div>
        {s.action && <div className="adv-action">→ {s.action}</div>}
      </div>
      <div className="sg-btns">
        {!done && !gone && <button className="btn btn-sm" disabled={busy} onClick={() => onAct(s.id, 'done')} title="Отметить сделанным"><CheckCircleIcon size={16} /> Сделано</button>}
        {!done && !snoozed && !gone && <button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => onAct(s.id, 'snooze')} title="Убрать до завтрашнего утреннего выпуска"><ClockIcon size={16} /> До завтра</button>}
        {(done || snoozed) && <button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => onAct(s.id, 'reopen')}><ArrowCounterClockwiseIcon size={16} /> Вернуть</button>}
      </div>
    </div>
  );
}

function SignalGroups({ signals, onAct, busy }: { signals: Ads2Signal[]; onAct: (id: number, action: 'done' | 'snooze' | 'reopen') => void; busy: boolean }) {
  const open = signals.filter(s => s.status === 'open');
  const rest = signals.filter(s => s.status !== 'open');
  const [showRest, setShowRest] = useState(false);
  if (!signals.length) return <section className="card"><p className="muted" style={{ margin: 0 }}>Сигналов нет — по данным всё в норме.</p></section>;
  return (
    <>
      {ROLES.map(role => {
        const xs = open.filter(s => s.role === role);
        if (!xs.length) return null;
        const crit = xs.filter(s => s.level === 'critical').length;
        const money = xs.reduce((a, s) => a + (s.rub != null && s.rub >= 100 ? s.rub : 0), 0);
        return (
          <section key={role} className="card sg-group">
            <h2 className={`sg-h sg-h-${role}`}>{SIGNAL_ROLE_LABEL[role]} <span className="muted">· {xs.length}{crit ? ` · срочных ${crit}` : ''}{money > 0 ? ` · ${kRub(money)} на кону` : ''}</span></h2>
            <div className="sg-list">{xs.map(s => <SignalRow key={s.id} s={s} onAct={onAct} busy={busy} />)}</div>
          </section>
        );
      })}
      {rest.length > 0 && (
        <section className="card sg-group sg-rest">
          <button className="sg-toggle" onClick={() => setShowRest(v => !v)}>{showRest ? 'Скрыть' : 'Показать'} сделанные и отложенные · {rest.length}</button>
          {showRest && <div className="sg-list">{rest.map(s => <SignalRow key={s.id} s={s} onAct={onAct} busy={busy} />)}</div>}
        </section>
      )}
    </>
  );
}

// ─── Разбор вчера ───────────────────────────────────────────────────────────

function CauseLine({ c }: { c: Ads2AdvisorCause }) {
  return (
    <div className={`adv-cause adv-${c.level}`}>
      <LevelIcon level={c.level} />
      <div><div>{c.text}</div>{c.action && <div className="adv-action">→ {c.action}</div>}</div>
    </div>
  );
}

function AdvTable({ rows, kind }: { rows: Ads2AdvisorProduct[]; kind: 'down' | 'up' }) {
  if (!rows.length) return <p className="muted">{kind === 'down' ? 'Заметных просадок по товарам нет.' : 'Заметного роста по товарам нет.'}</p>;
  return (
    <div className="ad2-scroll adv-scroll">
      <table className="ad2-table adv-table">
        <thead><tr><th className="cmp-col-prod">Товар</th><th className="ad2-num">Заказы: день / среднее</th><th className="ad2-num">Выручка: день / среднее</th><th className="ad2-num">Разница</th><th>Что видно в данных и что сделать</th></tr></thead>
        <tbody>
          {rows.map(p => (
            <tr key={p.key}>
              <td className="cmp-col-prod"><ProductCell p={{ photo: p.photo, name: p.article, article: p.name, link: p.link }} /></td>
              <td className="ad2-num">{num(p.orders)} / {nf1.format(p.ordersBase)}</td>
              <td className="ad2-num">{kRub(p.revenue)} / {kRub(p.revenueBase)}</td>
              <td className={`ad2-num ${p.delta < 0 ? 'ad2-bad' : 'adv-good'}`}>{p.delta > 0 ? '+' : ''}{kRub(p.delta)}</td>
              <td className="adv-causes">{p.causes.length ? p.causes.map(c => <CauseLine key={c.code + c.text} c={c} />)
                : <span className="muted">{kind === 'down' ? 'Причина не видна в данных — возможно, спрос; смотреть динамику ещё день' : 'Рост без явной причины в данных'}</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Yesterday({ y, open: openInit }: { y: NonNullable<Ads2AdvisorIssue['yesterday']>; open: boolean }) {
  const [open, setOpen] = useState(openInit);
  useEffect(() => setOpen(openInit), [openInit, y.date]);
  const drivers = y.drivers.filter(x => x.code !== 'low_volume' && x.code !== 'unknown');
  const maxDrv = Math.max(1, ...drivers.map(x => Math.abs(x.delta)));
  return (
    <section className="card adv-summary sg-yday">
      <button className="sg-yhead" onClick={() => setOpen(v => !v)} aria-expanded={open}>
        <h2><LightbulbIcon size={18} weight="fill" /> Разбор вчера · {wd(y.date)} {ddmm(y.date)}</h2>
        {!open && y.summary[0] && <span className="muted sg-yfirst">{y.summary[0]}</span>}
        <span className="muted">{open ? 'свернуть' : 'развернуть'}</span>
      </button>
      {open && (
        <>
          <ul>{y.summary.map(s => <li key={s}>{s}</li>)}</ul>
          {drivers.length > 0 && (
            <div className="adv-drivers">
              {drivers.map(x => (
                <div key={x.code} className="adv-driver">
                  <div className="adv-driver-t"><b>{x.label}</b> <span className="muted">· {x.products} тов.</span></div>
                  <div className="adv-bar"><span style={{ width: `${Math.max(3, Math.abs(x.delta) / maxDrv * 100)}%` }} /></div>
                  <div className="adv-driver-v">−{kRub(Math.abs(x.delta))}</div>
                  {x.action && <div className="adv-action adv-driver-a">→ {x.action}</div>}
                </div>
              ))}
            </div>
          )}
          <h3 className="sg-h3">Что просело</h3>
          <AdvTable rows={y.down} kind="down" />
          <h3 className="sg-h3">Что выросло</h3>
          <AdvTable rows={y.up} kind="up" />
        </>
      )}
    </section>
  );
}

// ─── Лист ───────────────────────────────────────────────────────────────────

export function RnpAdvisorSheet({ mp }: { mp: Ads2Mp }) {
  const [date, setDate] = useState<string | null>(null);
  const [issueId, setIssueId] = useState<number | null>(null);
  const [d, setD] = useState<Ads2SignalsResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const datesRef = useRef<HTMLDivElement | null>(null);

  // Номер запроса: при быстром переключении фильтров старый ответ мог прийти
  // позже нового и затереть его (прожарка 20.10.2026) — применяем только последний.
  const seq = useRef(0);
  const load = useCallback(async (quiet = false) => {
    const my = ++seq.current;
    if (!quiet) setLoading(true);
    try {
      const r = await apiGet<Ads2SignalsResponse>(`/api/ads2/signals?mp=${mp}${date ? `&date=${date}` : ''}${issueId ? `&id=${issueId}` : ''}`);
      if (my === seq.current) { setD(r.data); setErr(null); }
    } catch (e) { if (my === seq.current) setErr(errText(e)); }
    finally { if (my === seq.current) setLoading(false); }
  }, [mp, date, issueId]);
  useEffect(() => { void load(); }, [load]);
  // Пока сервер собирает выпуск — переспрашиваем; иначе раз в 5 минут (к 12:00 выпуск появится сам).
  useEffect(() => {
    const t = setInterval(() => void load(true), d?.building ? 10_000 : 300_000);
    return () => clearInterval(t);
  }, [load, d?.building]);
  useEffect(() => { const el = datesRef.current?.querySelector('.adv-date.active') as HTMLElement | null; el?.scrollIntoView({ block: 'nearest', inline: 'center' }); }, [d?.date]);

  const run = async () => {
    setBusy(true);
    try {
      const r = await apiPost<Ads2SignalsResponse>('/api/ads2/signals', { mp, run: true });
      setDate(r.data.date); setIssueId(r.data.issue?.id ?? null); setD(r.data); setErr(null);
    } catch (e) { setErr(errText(e)); }
    finally { setBusy(false); }
  };
  const act = async (id: number, action: 'done' | 'snooze' | 'reopen') => {
    setBusy(true);
    try {
      const r = await apiPost<{ ok: boolean; signal?: Ads2Signal }>('/api/ads2/signals', { id, action });
      const s = r.data.signal;
      if (s) setD(prev => prev && prev.issue ? { ...prev, issue: { ...prev.issue, signals: prev.issue.signals.map(x => x.id === s.id ? { ...x, status: s.status, statusAt: s.statusAt, snoozedUntil: s.snoozedUntil } : x) } } : prev);
    } catch (e) { setErr(errText(e)); }
    finally { setBusy(false); }
  };

  const today = d?.dates[0];
  const isToday = d && d.date === today;
  const slotsView = useMemo(() => {
    if (!d) return [];
    const nowHM = hmOf(Date.now());
    const scheduled = d.slots.map(s => {
      const got = d.issues.filter(i => i.slot === s.slot).sort((a, b) => b.at - a.at)[0];
      const state = got ? 'ready' : isToday && nowHM < s.time ? 'future' : 'missed';
      return { key: s.slot, label: s.label, time: s.time, issue: got ?? null, state };
    });
    const manual = d.issues.filter(i => i.slot === 'manual').map(i => ({ key: `m${i.id}`, label: 'По кнопке', time: hmOf(i.at), issue: i, state: 'ready' as const }));
    return [...scheduled, ...manual];
  }, [d, isToday]);

  if (err && !d) return <div className="rnp-alert">Советник не загрузился: {err}</div>;
  if (!d) return <div className="card muted">Загружаю…</div>;
  const issue = d.issue;
  const activeId = issue?.id ?? null;
  const sigs = issue?.signals ?? [];
  const openCnt = sigs.filter(s => s.status === 'open').length;
  const crit = sigs.filter(s => s.status === 'open' && s.level === 'critical').length;

  return (
    <>
      {err && <div className="rnp-alert">{err}</div>}
      <section className="card cmp-card sg-head">
        <div className="cmp-head">
          <h2>Советник · {wd(d.date)} {ddmm(d.date)}{issue ? ` · выпуск ${SLOT_LABEL[issue.slot]} ${hmOf(issue.at)}` : ''}</h2>
          <div className="row gap-8">
            {loading && <span className="muted">обновляю…</span>}
            <button className="btn btn-sm" onClick={run} disabled={busy || d.building}><ArrowsClockwiseIcon size={16} className={busy || d.building ? 'spin' : ''} /> {d.building ? 'Собираю…' : 'Собрать сейчас'}</button>
          </div>
        </div>
        <p className="muted cmp-lead">Выпуски в 08:00 (разбор вчера и план дня), 12:00, 15:30 и 17:30 МСК (что изменилось за сегодня). Сигналы живут, пока условие держится: отмечайте «Сделано» или откладывайте до завтра. Реклама и цены меняются только через «Применить» в «Рекламе» и «Ценах».</p>
        <div className="adv-dates" role="group" aria-label="День" ref={datesRef}>
          {[...d.dates].reverse().map(x => (
            <button key={x} className={`adv-date ${x === d.date ? 'active' : ''} ${['сб', 'вс'].includes(wd(x)) ? 'we' : ''}`} onClick={() => { setDate(x); setIssueId(null); }}>
              <span>{wd(x)}</span><b>{ddmm(x)}</b>
            </button>
          ))}
        </div>
        <div className="sg-slots" role="tablist">
          {slotsView.map(s => (
            <button key={s.key} role="tab" aria-selected={!!s.issue && s.issue.id === activeId} disabled={!s.issue}
              className={`sg-slot ${s.issue && s.issue.id === activeId ? 'active' : ''} sg-slot-${s.state}`}
              onClick={() => s.issue && setIssueId(s.issue.id)}
              title={s.state === 'future' ? `будет в ${s.time}` : s.state === 'missed' ? 'выпуска не было (сервер был выключен или данных не было)' : `собран в ${hmOf(s.issue!.at)}`}>
              <b>{s.label}</b><span>{s.state === 'ready' ? hmOf(s.issue!.at) : s.state === 'future' ? `в ${s.time}` : `${s.time} · не было`}</span>
            </button>
          ))}
        </div>
      </section>

      {!issue && (
        <section className="card">
          <p className="muted" style={{ margin: 0 }}>{isToday ? 'Сегодня выпусков ещё не было — первый в 08:00 МСК. Нажмите «Собрать сейчас», чтобы не ждать.' : 'За этот день выпусков нет.'}</p>
        </section>
      )}

      {issue && (
        <>
          <PaceCards issue={issue} />
          {issue.pace?.note && <div className="rnp-note">{issue.pace.note}</div>}
          {issue.monthMargin && <MonthMargin m={issue.monthMargin} />}
          <section className="card sg-summary">
            <div className="sg-sumline">
              <b>{openCnt ? `Открытых сигналов ${openCnt}${crit ? `, срочных ${crit}` : ''}` : 'Открытых сигналов нет'}</b>
              <span className="muted">· данные: РНП {whenRel(issue.dataAt.rnp)}, реклама {whenRel(issue.dataAt.ads)}, витрина конкурентов {whenRel(issue.dataAt.comp)}</span>
            </div>
          </section>
          <SignalGroups signals={sigs} onAct={act} busy={busy} />
          {issue.yesterday && <Yesterday y={issue.yesterday} open={issue.slot === 'morning'} />}
          {issue.notes.map(n => <div key={n} className="rnp-note">{n}</div>)}
        </>
      )}
    </>
  );
}
