/**
 * «Финансы» (19.11.2026) — платёжный календарь, инвесторы и кредиты вместо Google-таблицы
 * «Платежный календарь 2026–2027». Только владелец: сервер закрывает /api/finance всем остальным.
 *
 * Четыре листа: Сводка · Календарь (месяц по дням, строки добавляются у нужного дня) ·
 * Инвесторы (вклады по людям: новый вклад, выплата %, возврат, пролонгация) · Кредиты.
 * Все расчёты — на сервере и в shared/finance.ts; экран только показывает и отправляет правки.
 */
import { Fragment, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { CaretLeftIcon, CaretRightIcon, PlusIcon, PencilSimpleIcon, TrashIcon, CheckIcon, ArrowClockwiseIcon, XIcon, CaretDownIcon, CaretUpIcon } from '@phosphor-icons/react';
import { Area, AreaChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import '../finance.css';
import { apiGet, apiPost, errText } from '../api/http';
import {
  OP_STATUSES, shiftMonth, type DealCalc, type FinOp, type FinSummary, type LoanCalc, type MonthView, type OpStatus, type OpType,
} from '../../shared/finance';

type Meta = { settings: { balance: number; balanceDate: string; minBalance: number }; today: string; categories: Array<{ name: string; type: OpType }>; accounts: string[]; people: string[]; parties: string[]; lastMonth: string };
type Tab = 'summary' | 'calendar' | 'investors' | 'loans' | 'lists';

const nf0 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
const rub = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? '–' : `${nf0.format(v)} ₽`);
const mln = (v: number) => `${(v / 1e6).toLocaleString('ru-RU', { maximumFractionDigits: 2, minimumFractionDigits: 2 })} млн`;
const MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const WD = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const monthTitle = (m: string) => { const t = MONTHS[Number(m.slice(5, 7)) - 1]; return `${t[0].toUpperCase()}${t.slice(1)} ${m.slice(0, 4)}`; };
const ddmm = (d: string | null | undefined) => (d ? `${d.slice(8, 10)}.${d.slice(5, 7)}` : '–');
const ddmmyy = (d: string | null | undefined) => (d ? `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}` : '–');
const wd = (d: string) => WD[new Date(d + 'T00:00:00Z').getUTCDay()];
const isWeekend = (d: string) => { const n = new Date(d + 'T00:00:00Z').getUTCDay(); return n === 0 || n === 6; };
const sigClass = (v: number | null, min: number) => (v === null ? '' : v < 0 ? 'bad' : v < min ? 'warn' : 'good');
const STATUS_CLASS: Record<OpStatus, string> = { 'План': 'plan', 'Прогноз': 'fc', 'Подтверждено': 'conf', 'Исполнено': 'done', 'Перенесено': 'moved', 'Отменено': 'cancel' };

function useLoad<T>(url: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const reload = useCallback(async () => {
    if (!url) return;
    setBusy(true);
    try { const r = await apiGet<T>(url); setData(r.data); setErr(''); } catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  }, [url]);
  useEffect(() => { void reload(); }, [reload]);
  return { data, err, busy, reload };
}

export function Finance() {
  const [tab, setTab] = useState<Tab>(() => { try { return (localStorage.getItem('fin.tab') as Tab) || 'calendar'; } catch { return 'calendar'; } });
  const [month, setMonth] = useState<string>(() => new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 7));
  const meta = useLoad<Meta & { ok: boolean }>('/api/finance/meta');
  const go = (t: Tab) => { setTab(t); try { localStorage.setItem('fin.tab', t); } catch { /* вкладка просто не запомнится */ } };
  const openMonth = (m: string) => { setMonth(m); go('calendar'); };

  return (
    <div className="sa fin">
      <div className="fin-tabs" role="tablist">
        {([['summary', 'Сводка'], ['calendar', 'Календарь'], ['investors', 'Инвесторы'], ['loans', 'Кредиты'], ['lists', 'Справочники']] as Array<[Tab, string]>).map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => go(k)}>{l}</button>
        ))}
        <span className="fin-spacer" />
        {meta.data && <span className="fin-bal" title="Остаток на счетах из финучёта; агент обновляет его каждое утро">
          На счетах {ddmm(meta.data.settings.balanceDate)}: <b>{rub(meta.data.settings.balance)}</b>
        </span>}
      </div>
      {meta.err && <div className="fin-alert">Не удалось загрузить раздел: {meta.err}</div>}
      {meta.data && tab === 'summary' && <SummaryTab onOpenMonth={openMonth} meta={meta.data} onMetaChange={meta.reload} />}
      {meta.data && tab === 'calendar' && <CalendarTab month={month} setMonth={setMonth} meta={meta.data} />}
      {meta.data && tab === 'investors' && <InvestorsTab meta={meta.data} onOpenMonth={openMonth} />}
      {meta.data && tab === 'loans' && <LoansTab meta={meta.data} onOpenMonth={openMonth} />}
      {meta.data && tab === 'lists' && <ListsTab onChange={meta.reload} />}
    </div>
  );
}

// ═══ Сводка ════════════════════════════════════════════════════════════════
function SummaryTab({ onOpenMonth, meta, onMetaChange }: { onOpenMonth: (m: string) => void; meta: Meta; onMetaChange: () => void }) {
  const { data, err, reload } = useLoad<{ summary: FinSummary }>('/api/finance/summary');
  const [edit, setEdit] = useState(false);
  if (err) return <div className="fin-alert">Сводка не загрузилась: {err}</div>;
  if (!data) return <div className="card muted">Загружаю сводку…</div>;
  const s = data.summary, min = s.settings.minBalance;
  const gapEnd = s.firstGap ? s.series.find(c => c.date > s.firstGap! && c.end >= 0)?.date : null;
  return (
    <div className="fin-col">
      {s.firstGap ? (
        <div className="fin-alert big">
          <b>Кассовый разрыв с {ddmm(s.firstGap)}</b>{s.minNext30 && s.minNext30.end < 0 ? ` · самая низкая точка ${rub(s.minNext30.end)} ${ddmm(s.minNext30.date)}` : ''}
          {gapEnd ? ` · закрывается ${ddmm(gapEnd)}` : ' · в ближайшие 2,5 месяца не закрывается'}
        </div>
      ) : <div className="fin-ok big">Кассовых разрывов в ближайшие 2,5 месяца нет.</div>}

      <div className="fin-kpis">
        <div className="fin-kpi main"><span className="l">Остаток на счетах на {ddmmyy(s.settings.balanceDate)}</span><b>{rub(s.settings.balance)}</b>
          <span className="n">из финучёта · <button className="fin-link" onClick={() => setEdit(true)}>изменить</button></span></div>
        <div className="fin-kpi"><span className="l">Минимум за 30 дней</span><b className={sigClass(s.minNext30?.end ?? null, min)}>{rub(s.minNext30?.end)}</b><span className="n">{s.minNext30 ? `${ddmm(s.minNext30.date)}, ${wd(s.minNext30.date)}` : ''}</span></div>
        <div className="fin-kpi"><span className="l">Платежи по кредитам впереди</span><b>{rub(s.loansLeft)}</b><span className="n">за 30 дней: {rub(s.loansNext30)}</span></div>
        <div className="fin-kpi"><span className="l">Должны инвесторам</span><b>{rub(s.investors.owed)}</b><span className="n">тело {rub(s.investors.body)} · % {rub(s.investors.remInt)}</span></div>
      </div>

      <div className="card">
        <h2>Остаток на счетах по дням</h2>
        <div className="fin-chart">
          <ResponsiveContainer width="100%" height={300}>
            <AreaChart data={s.series.map(c => ({ d: ddmm(c.date), v: Math.round(c.end) }))} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
              <defs><linearGradient id="finFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#1f5fd1" stopOpacity={0.25} /><stop offset="100%" stopColor="#1f5fd1" stopOpacity={0.02} /></linearGradient></defs>
              <CartesianGrid stroke="#e9edf2" vertical={false} />
              <XAxis dataKey="d" tick={{ fontSize: 15 }} interval={6} tickLine={false} axisLine={false} />
              <YAxis tick={{ fontSize: 15 }} tickFormatter={(v: number) => `${(v / 1e6).toFixed(0)} млн`} width={70} tickLine={false} axisLine={false} />
              <Tooltip formatter={(v: number) => [rub(v), 'Остаток']} labelStyle={{ fontSize: 15 }} contentStyle={{ fontSize: 15, borderRadius: 8 }} />
              <ReferenceLine y={0} stroke="#c62828" strokeWidth={1.5} />
              <ReferenceLine y={min} stroke="#b45309" strokeDasharray="4 4" />
              <Area type="stepAfter" dataKey="v" stroke="#1f5fd1" strokeWidth={2} fill="url(#finFill)" />
            </AreaChart>
          </ResponsiveContainer>
        </div>
        <div className="muted fin-note">Красная линия — ноль, жёлтая — порог «мало денег» {rub(min)}. Закупки на будущие месяцы в календарь ещё не внесены: растущий остаток — это деньги, свободные под закупки.</div>
      </div>

      <div className="card">
        <h2>По месяцам</h2>
        <div className="fin-scroll">
          <table className="fin-table">
            <thead><tr><th>Месяц</th><th className="r">Приход</th><th className="r">Расход</th><th className="r">Сальдо</th><th className="r">Остаток на конец</th><th className="r">Минимум</th><th>Когда</th></tr></thead>
            <tbody>{s.months.map(m => (
              <tr key={m.month} className="click" onClick={() => onOpenMonth(m.month)}>
                <td><b>{monthTitle(m.month)}</b></td><td className="r in">{rub(m.in)}</td><td className="r">{rub(m.out)}</td>
                <td className={`r ${m.net < 0 ? 'bad' : ''}`}>{rub(m.net)}</td><td className={`r ${sigClass(m.end, min)}`}>{rub(m.end)}</td>
                <td className={`r ${sigClass(m.min, min)}`}><b>{rub(m.min)}</b></td><td>{m.min !== null && m.min < 0 ? <span className="fin-pill bad">разрыв {ddmm(m.minDate)}</span> : m.minDate ? ddmm(m.minDate) : ''}</td>
              </tr>))}</tbody>
          </table>
        </div>
      </div>
      {edit && <SettingsForm meta={meta} onClose={() => setEdit(false)} onSaved={() => { setEdit(false); void reload(); onMetaChange(); }} />}
    </div>
  );
}

function SettingsForm({ meta, onClose, onSaved }: { meta: Meta; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ balance: String(meta.settings.balance), balanceDate: meta.settings.balanceDate, minBalance: String(meta.settings.minBalance) });
  const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try { await apiPost('/api/finance/settings', { balance: Number(f.balance.replace(/\s/g, '')), balanceDate: f.balanceDate, minBalance: Number(f.minBalance.replace(/\s/g, '')) }); onSaved(); }
    catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  };
  return (
    <Modal title="Остаток на счетах" onClose={onClose}>
      <p className="muted">Обычно его каждое утро ставит агент из финучёта. Меняйте вручную, только если знаете точную сумму.</p>
      <div className="fin-grid2">
        <Field label="Остаток, ₽"><input className="input" inputMode="decimal" value={f.balance} onChange={e => setF({ ...f, balance: e.target.value })} /></Field>
        <Field label="На дату"><input className="input" type="date" value={f.balanceDate} onChange={e => setF({ ...f, balanceDate: e.target.value })} /></Field>
        <Field label="Порог «мало денег», ₽"><input className="input" inputMode="decimal" value={f.minBalance} onChange={e => setF({ ...f, minBalance: e.target.value })} /></Field>
      </div>
      {err && <div className="fin-alert">{err}</div>}
      <div className="fin-actions"><button className="btn" onClick={onClose}>Отмена</button><button className="btn btn-primary" disabled={busy} onClick={save}><CheckIcon /> Сохранить</button></div>
    </Modal>
  );
}

// ═══ Календарь ═════════════════════════════════════════════════════════════
type Filter = 'all' | 'in' | 'out' | 'open';
function CalendarTab({ month, setMonth, meta }: { month: string; setMonth: (m: string) => void; meta: Meta }) {
  const { data, err, busy, reload } = useLoad<{ view: MonthView }>(`/api/finance/month?m=${month}`);
  const [form, setForm] = useState<Partial<FinOp> | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const [showEmpty, setShowEmpty] = useState(false);
  const [menu, setMenu] = useState<number | null>(null);
  const [toast, setToast] = useState('');
  const v = data?.view; const min = v?.settings.minBalance ?? 0;

  useEffect(() => { // открыть сегодняшний день
    if (!v || v.month !== v.today.slice(0, 7)) return;
    const t = setTimeout(() => document.getElementById(`fin-d-${v.today}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 150);
    return () => clearTimeout(t);
  }, [v?.month]);

  const match = (o: FinOp) => {
    if (filter === 'in' && o.type !== 'in') return false;
    if (filter === 'out' && o.type !== 'out') return false;
    if (filter === 'open' && (o.status === 'Исполнено' || o.status === 'Отменено' || o.status === 'Перенесено')) return false;
    const s = q.trim().toLowerCase(); return !s || `${o.cat} ${o.descr} ${o.comment} ${o.account}`.toLowerCase().includes(s);
  };
  const setStatus = async (o: FinOp, status: OpStatus) => {
    setMenu(null);
    let fact = o.fact;
    if (status === 'Исполнено' && fact === null) fact = o.plan;
    try { await apiPost('/api/finance/op', { op: { ...o, status, fact } }); setToast(`${o.cat || o.descr}: ${status.toLowerCase()}`); void reload(); }
    catch (e) { setToast('Не сохранилось: ' + errText(e)); }
  };
  const remove = async (o: FinOp) => {
    if (!window.confirm(`Удалить строку «${o.cat || o.descr}» на ${rub(o.plan)}?`)) return;
    try { await apiPost('/api/finance/op/delete', { id: o.id }); setToast('Строка удалена'); void reload(); } catch (e) { setToast('Не удалилась: ' + errText(e)); }
  };
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(''), 3500); return () => clearTimeout(t); }, [toast]);

  return (
    <div className="fin-col">
      <div className="fin-bar">
        <div className="fin-month">
          <button className="btn" aria-label="Предыдущий месяц" onClick={() => setMonth(shiftMonth(month, -1))}><CaretLeftIcon /></button>
          <h2>{monthTitle(month)}</h2>
          <button className="btn" aria-label="Следующий месяц" onClick={() => setMonth(shiftMonth(month, 1))}><CaretRightIcon /></button>
          {v && month !== v.today.slice(0, 7) && <button className="btn btn-sm" onClick={() => setMonth(v.today.slice(0, 7))}>Сегодня</button>}
        </div>
        <span className="fin-spacer" />
        <button className="btn" onClick={() => void reload()} disabled={busy} title="Обновить"><ArrowClockwiseIcon /></button>
        <button className="btn btn-primary" onClick={() => setForm({ date: v && month === v.today.slice(0, 7) ? v.today : `${month}-01`, type: 'out', status: 'План' })}><PlusIcon /> Операция</button>
      </div>
      {err && <div className="fin-alert">Месяц не загрузился: {err}</div>}
      {v && (
        <div className="fin-kpis">
          <div className="fin-kpi"><span className="l">Приход за месяц</span><b className="in">{rub(v.totals.in)}</b></div>
          <div className="fin-kpi"><span className="l">Расход за месяц</span><b>{rub(v.totals.out)}</b></div>
          <div className="fin-kpi"><span className="l">Сальдо</span><b className={v.totals.net < 0 ? 'bad' : 'good'}>{rub(v.totals.net)}</b></div>
          <div className="fin-kpi"><span className="l">Остаток на конец месяца</span><b className={sigClass(v.totals.end, min)}>{rub(v.totals.end)}</b></div>
          <div className="fin-kpi"><span className="l">Самый низкий остаток</span><b className={sigClass(v.totals.min, min)}>{rub(v.totals.min)}</b><span className="n">{v.totals.minDate ? `${ddmm(v.totals.minDate)}, ${wd(v.totals.minDate)}` : 'месяц уже прошёл'}</span></div>
        </div>
      )}
      <div className="fin-bar">
        <div className="fin-seg">
          {([['all', 'Все'], ['in', 'Приходы'], ['out', 'Расходы'], ['open', 'Не исполнено']] as Array<[Filter, string]>).map(([k, l]) => (
            <button key={k} className={filter === k ? 'on' : ''} onClick={() => setFilter(k)}>{l}</button>))}
        </div>
        <input className="input fin-search" placeholder="Поиск: статья, контрагент, комментарий" value={q} onChange={e => setQ(e.target.value)} />
        <label className="fin-check"><input type="checkbox" checked={showEmpty} onChange={e => setShowEmpty(e.target.checked)} /> Пустые дни</label>
      </div>

      {v && <div className="fin-days">
        {v.days.map(d => {
          const ops = d.ops.filter(match);
          const filtered = filter !== 'all' || q.trim();
          if (!ops.length && (!showEmpty || filtered) && d.date !== v.today) return null;
          const past = d.date < v.settings.balanceDate;
          return (
            <section key={d.date} id={`fin-d-${d.date}`} className={`fin-day ${d.date === v.today ? 'today' : ''} ${isWeekend(d.date) ? 'we' : ''} ${past ? 'past' : ''}`}>
              <header>
                <div className="fin-date"><b>{Number(d.date.slice(8, 10))}</b><span>{MONTHS_GEN[Number(d.date.slice(5, 7)) - 1]}, {wd(d.date)}{d.date === v.today ? ' · сегодня' : ''}</span></div>
                <div className="fin-daysum">
                  {d.in > 0 && <span className="in">+{rub(d.in)}</span>}
                  {d.out > 0 && <span>−{rub(d.out)}</span>}
                </div>
                <div className={`fin-end ${d.signal ?? ''}`} title="Остаток на счетах на вечер этого дня">
                  {d.end !== null ? <>на вечер <b>{rub(d.end)}</b></> : <span className="muted">прошло</span>}
                </div>
                <button className="btn btn-sm fin-add" aria-label="Добавить операцию в этот день" onClick={() => setForm({ date: d.date, type: 'out', status: 'План' })}><PlusIcon /></button>
              </header>
              {ops.map(o => (
                <div key={o.id} className={`fin-op ${o.type} st-${STATUS_CLASS[o.status]}`}>
                  <span className={`fin-dot ${o.type}`} aria-hidden />
                  <div className="fin-what" onClick={() => setForm(o)} role="button" tabIndex={0} onKeyDown={e => { if (e.key === 'Enter') setForm(o); }}>
                    <b>{o.cat || o.descr}</b>
                    <span className="muted">{o.cat ? o.descr : ''}{o.account ? `${o.cat && o.descr ? ' · ' : ''}${o.account}` : ''}</span>
                    {o.comment && <span className="fin-com">{o.comment}</span>}
                  </div>
                  <div className={`fin-sum ${o.type}`}>
                    {(() => { const a = o.status === 'Исполнено' && o.fact !== null ? o.fact : o.plan; return `${a ? (o.type === 'in' ? '+' : '−') : ''}${rub(a)}`; })()}
                    {o.status === 'Исполнено' && o.fact !== null && o.fact !== o.plan && <span className="muted">план {rub(o.plan)}</span>}
                  </div>
                  <div className="fin-st">
                    <button className={`fin-pill ${STATUS_CLASS[o.status]}`} onClick={() => setMenu(menu === o.id ? null : o.id)}>{o.status} <CaretDownIcon size={14} /></button>
                    {menu === o.id && <div className="fin-menu" onMouseLeave={() => setMenu(null)}>
                      {OP_STATUSES.map(s => <button key={s} className={s === o.status ? 'on' : ''} onClick={() => void setStatus(o, s)}>{s}</button>)}
                    </div>}
                  </div>
                  <div className="fin-tools">
                    <button className="btn btn-sm" aria-label="Изменить" onClick={() => setForm(o)}><PencilSimpleIcon /></button>
                    <button className="btn btn-sm" aria-label="Удалить" onClick={() => void remove(o)}><TrashIcon /></button>
                  </div>
                </div>
              ))}
              {!ops.length && <div className="fin-empty muted">Нет операций</div>}
            </section>
          );
        })}
      </div>}
      {form && <OpForm op={form} meta={meta} onClose={() => setForm(null)} onSaved={(m) => { setForm(null); setToast(m); void reload(); }} />}
      {toast && <div className="fin-toast">{toast}</div>}
    </div>
  );
}

function OpForm({ op, meta, onClose, onSaved }: { op: Partial<FinOp>; meta: Meta; onClose: () => void; onSaved: (msg: string) => void }) {
  const [f, setF] = useState({
    date: op.date ?? meta.today, type: (op.type ?? 'out') as OpType, cat: op.cat ?? '', descr: op.descr ?? '', plan: op.plan !== undefined ? String(op.plan) : '',
    fact: op.fact !== null && op.fact !== undefined ? String(op.fact) : '', status: (op.status ?? 'План') as OpStatus, account: op.account ?? '', resp: op.resp ?? '', comment: op.comment ?? '',
  });
  const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const cats = meta.categories.filter(c => c.type === f.type);
  const num = (s: string) => Number(s.replace(/\s/g, '').replace(',', '.'));
  const save = async () => {
    if (!f.plan.trim() || !Number.isFinite(num(f.plan))) { setErr('Укажите сумму'); return; }
    setBusy(true);
    try {
      await apiPost('/api/finance/op', { op: { ...op, ...f, plan: num(f.plan), fact: f.fact.trim() ? num(f.fact) : null } });
      onSaved(op.id ? 'Строка сохранена' : `Добавлено на ${ddmm(f.date)}`);
    } catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  };
  return (
    <Modal title={op.id ? 'Изменить операцию' : 'Новая операция'} onClose={onClose}>
      <div className="fin-seg wide">
        <button className={f.type === 'in' ? 'on in' : ''} onClick={() => setF({ ...f, type: 'in' })}>Приход</button>
        <button className={f.type === 'out' ? 'on out' : ''} onClick={() => setF({ ...f, type: 'out' })}>Расход</button>
      </div>
      <div className="fin-grid2">
        <Field label="Дата"><input className="input" type="date" value={f.date} onChange={e => setF({ ...f, date: e.target.value })} /></Field>
        <Field label="Статья">
          <input className="input" list="fin-cats" value={f.cat} placeholder="выберите или впишите" onChange={e => setF({ ...f, cat: e.target.value })} />
          <datalist id="fin-cats">{cats.map(c => <option key={c.name} value={c.name} />)}</datalist>
        </Field>
        <Field label="Контрагент / описание" wide>
          <input className="input" list="fin-parties" value={f.descr} placeholder="выберите или впишите" onChange={e => setF({ ...f, descr: e.target.value })} />
          <datalist id="fin-parties">{meta.parties.map(p => <option key={p} value={p} />)}</datalist>
        </Field>
        <Field label="Сумма, ₽"><input className="input" inputMode="decimal" value={f.plan} onChange={e => setF({ ...f, plan: e.target.value })} autoFocus={!op.id} /></Field>
        <Field label="Статус">
          <select className="input" value={f.status} onChange={e => setF({ ...f, status: e.target.value as OpStatus, fact: e.target.value === 'Исполнено' && !f.fact ? f.plan : f.fact })}>
            {OP_STATUSES.map(s => <option key={s}>{s}</option>)}
          </select>
        </Field>
        {f.status === 'Исполнено' && <Field label="Сумма по факту, ₽"><input className="input" inputMode="decimal" value={f.fact} onChange={e => setF({ ...f, fact: e.target.value })} /></Field>}
        <Field label="Счёт">
          <input className="input" list="fin-acc" value={f.account} onChange={e => setF({ ...f, account: e.target.value })} />
          <datalist id="fin-acc">{meta.accounts.map(a => <option key={a} value={a} />)}</datalist>
        </Field>
        <Field label="Ответственный">
          <select className="input" value={f.resp} onChange={e => setF({ ...f, resp: e.target.value })}>
            <option value="">— не выбран —</option>
            {[...RESP_PEOPLE, ...(f.resp && !RESP_PEOPLE.includes(f.resp) ? [f.resp] : [])].map(p => <option key={p} value={p}>{p}</option>)}
          </select>
        </Field>
        <Field label="Комментарий" wide><textarea className="input" rows={2} value={f.comment} onChange={e => setF({ ...f, comment: e.target.value })} /></Field>
      </div>
      {op.key && <p className="muted fin-note">Эту строку поставил агент ({op.source}). Сумму и дату можно поправить — агент её не перезапишет.</p>}
      {err && <div className="fin-alert">{err}</div>}
      <div className="fin-actions"><button className="btn" onClick={onClose}>Отмена</button><button className="btn btn-primary" disabled={busy} onClick={save}><CheckIcon /> Сохранить</button></div>
    </Modal>
  );
}

// ═══ Инвесторы ═════════════════════════════════════════════════════════════
type DealDialog = { kind: 'new' } | { kind: 'edit'; d: DealCalc } | { kind: 'pay'; d: DealCalc } | { kind: 'return'; d: DealCalc } | { kind: 'prolong'; d: DealCalc };
type InvSort = 'owed' | 'date' | 'new' | 'abc';
const INV_SORTS: Array<[InvSort, string]> = [['owed', 'По сумме'], ['date', 'По дате возврата'], ['new', 'Новые сверху'], ['abc', 'А–Я']];
function InvestorsTab({ meta, onOpenMonth }: { meta: Meta; onOpenMonth: (m: string) => void }) {
  const { data, err, reload } = useLoad<{ deals: DealCalc[]; today: string }>('/api/finance/investors');
  const opsLoad = useLoad<{ ops: FinOp[]; today: string }>('/api/finance/ops');
  const [sort, setSortRaw] = useState<InvSort>(() => { try { return (localStorage.getItem('fin.invSort') as InvSort) || 'owed'; } catch { return 'owed'; } });
  const setSort = (v: InvSort) => { setSortRaw(v); try { localStorage.setItem('fin.invSort', v); } catch { /* не запомнится */ } };
  const [closed, setClosed] = useState(false);
  const [dlg, setDlg] = useState<DealDialog | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const groups = useMemo(() => {
    const m = new Map<string, DealCalc[]>();
    for (const d of data?.deals ?? []) if (closed || d.status === 'Действует') { if (!m.has(d.person)) m.set(d.person, []); m.get(d.person)!.push(d); }
    const cmpStr = (a: string | null, b: string | null) => (a === b ? 0 : a === null ? 1 : b === null ? -1 : a < b ? -1 : 1);
    const dealOrder = (a: DealCalc, b: DealCalc) => sort === 'date' ? cmpStr(a.end, b.end) : sort === 'new' ? cmpStr(b.start, a.start) : sort === 'owed' ? b.owed - a.owed : cmpStr(a.start, b.start);
    const gs = [...m.entries()].map(([p, list]) => ({ p, list: [...list].sort(dealOrder), owed: list.reduce((s, d) => s + d.owed, 0),
      next: list.filter(d => d.status === 'Действует').map(d => d.end).sort()[0] ?? null, last: list.map(d => d.start).sort().reverse()[0] ?? null }));
    return gs.sort((a, b) => sort === 'owed' ? b.owed - a.owed : sort === 'date' ? cmpStr(a.next, b.next) : sort === 'new' ? cmpStr(b.last, a.last) : a.p.localeCompare(b.p, 'ru'));
  }, [data, closed, sort]);
  if (err) return <div className="fin-alert">Инвесторы не загрузились: {err}</div>;
  if (!data) return <div className="card muted">Загружаю инвесторов…</div>;
  const act = data.deals.filter(d => d.status === 'Действует');
  const tot = { body: act.reduce((s, d) => s + d.remBody, 0), int: act.reduce((s, d) => s + d.remInt, 0), monthly: act.reduce((s, d) => s + d.monthly, 0) };
  const soon = act.filter(d => d.end <= new Date(Date.parse(data.today) + 60 * 86_400_000).toISOString().slice(0, 10));
  return (
    <div className="fin-col">
      <div className="fin-kpis">
        <div className="fin-kpi main"><span className="l">Всего должны инвесторам</span><b>{rub(tot.body + tot.int)}</b><span className="n">{act.length} действующих вкладов</span></div>
        <div className="fin-kpi"><span className="l">Тело в работе</span><b>{rub(tot.body)}</b></div>
        <div className="fin-kpi"><span className="l">Проценты к выплате</span><b>{rub(tot.int)}</b><span className="n">ежемесячно {rub(tot.monthly)}</span></div>
        <div className="fin-kpi"><span className="l">Возвраты за 60 дней</span><b className={soon.length ? 'warn' : ''}>{rub(soon.reduce((s, d) => s + d.owed, 0))}</b><span className="n">{soon.length} вкладов</span></div>
      </div>
      {opsLoad.data && <InvPayouts ops={opsLoad.data.ops} today={data.today} onOpenMonth={onOpenMonth} />}
      <div className="fin-bar">
        <button className="btn btn-primary" onClick={() => setDlg({ kind: 'new' })}><PlusIcon /> Новый вклад</button>
        <div className="fin-seg" role="group" aria-label="Порядок инвесторов">{INV_SORTS.map(([k, t]) => <button key={k} className={sort === k ? 'on' : ''} onClick={() => setSort(k)}>{t}</button>)}</div>
        <label className="fin-check"><input type="checkbox" checked={closed} onChange={e => setClosed(e.target.checked)} /> Показывать закрытые</label>
      </div>
      {groups.map(g => (
        <div key={g.p} className="card fin-person">
          <div className="fin-person-h"><h2>{g.p}</h2><span className="muted">{g.list.length} вкл.</span><span className="fin-spacer" />
            {g.owed > 0 && <span>должны <b>{rub(g.owed)}</b></span>}{g.next && <span className="muted">ближайший возврат {ddmmyy(g.next)}</span>}</div>
          <div className="fin-deals">{g.list.map(d => {
            const late = d.status === 'Действует' && d.end < data.today;
            return (
              <div key={d.id} className={`fin-deal ${d.status !== 'Действует' ? 'closed' : ''} ${late ? 'late' : ''}`}>
                <div className="fin-deal-name">
                  <button className="fin-link" onClick={() => setOpen(open === d.id ? null : d.id)}>{open === d.id ? <CaretUpIcon size={14} /> : <CaretDownIcon size={14} />} {d.name}</button>
                  <span className="muted">{d.id}{d.fromId ? ` · продление ${d.fromId}` : ''}</span>
                </div>
                <div className="fin-deal-terms">
                  <span><b>{rub(d.amount)}</b> · {d.rate}% · {d.term} мес.</span>
                  <span className="muted">{ddmmyy(d.start)} → <span className={late ? 'bad' : ''}>{ddmmyy(d.end)}</span>{late ? ' · срок прошёл' : ''}</span>
                  <span className="muted">{d.mode === 'Ежемесячно' ? `% ежемесячно по ${rub(d.monthly)}` : '% в конце срока'} · выплачено {rub(d.paidInt)}</span>
                </div>
                <div className="fin-deal-owed"><span className="muted">осталось</span><b>{rub(d.owed)}</b><span className={`fin-pill ${d.status === 'Действует' ? 'conf' : 'done'}`}>{d.status}</span></div>
                <div className="fin-deal-act">{d.status === 'Действует' && <>
                  <button className="btn btn-sm" onClick={() => setDlg({ kind: 'pay', d })}>Выплатить %</button>
                  <button className="btn btn-sm" onClick={() => setDlg({ kind: 'return', d })}>Вернуть</button>
                  <button className="btn btn-sm" onClick={() => setDlg({ kind: 'prolong', d })}>Продлить</button>
                  <button className="btn btn-sm" aria-label="Изменить вклад" onClick={() => setDlg({ kind: 'edit', d })}><PencilSimpleIcon /></button>
                </>}</div>
                {open === d.id && <div className="fin-deal-moves">
                  {d.moves.length ? <ul>{d.moves.map(m => <li key={m.id}><span>{ddmmyy(m.date)}</span><span>{m.kind}</span><b>{rub(m.amount)}</b><span className="muted">{m.comment}</span></li>)}</ul> : <span className="muted">Движений нет</span>}
                  {d.comment && <div className="muted">{d.comment}</div>}
                </div>}
              </div>);
          })}</div>
        </div>
      ))}
      {dlg && <DealForm dlg={dlg} meta={meta} today={data.today} onClose={() => setDlg(null)} onSaved={() => { setDlg(null); void reload(); void opsLoad.reload(); }} />}
    </div>
  );
}

function DealForm({ dlg, meta, today, onClose, onSaved }: { dlg: DealDialog; meta: Meta; today: string; onClose: () => void; onSaved: () => void }) {
  const d = dlg.kind === 'new' ? null : dlg.d;
  const [f, setF] = useState({
    person: d?.person ?? '', name: dlg.kind === 'prolong' ? '' : d?.name ?? '', start: dlg.kind === 'prolong' ? d!.end : dlg.kind === 'edit' ? d!.start : today,
    amount: String(dlg.kind === 'prolong' ? d!.remBody : dlg.kind === 'return' ? d!.remBody : dlg.kind === 'pay' ? (d!.monthly || d!.remInt) : d?.amount ?? ''),
    rate: String(d?.rate ?? ''), term: String(d?.term ?? 12), mode: d?.mode ?? 'Ежемесячно', comment: dlg.kind === 'edit' ? d!.comment : '', date: today, addInt: false,
  });
  const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const num = (s: string) => Number(s.replace(/\s/g, '').replace(',', '.'));
  const title = { new: 'Новый вклад', edit: `Изменить вклад ${d?.id}`, pay: `Выплата процентов · ${d?.name}`, return: `Возврат вклада · ${d?.name}`, prolong: `Продлить вклад · ${d?.name}` }[dlg.kind];
  const save = async () => {
    setBusy(true);
    try {
      if (dlg.kind === 'new' || dlg.kind === 'edit') await apiPost('/api/finance/investors/deal', { deal: { id: d?.id, status: d?.status, fromId: d?.fromId, person: f.person, name: f.name, start: f.start, amount: num(f.amount), rate: num(f.rate), term: num(f.term), mode: f.mode, comment: f.comment } });
      else if (dlg.kind === 'pay') await apiPost('/api/finance/investors/move', { move: { dealId: d!.id, kind: 'Проценты', date: f.date, amount: num(f.amount), comment: f.comment } });
      else if (dlg.kind === 'return') await apiPost('/api/finance/investors/move', { move: { dealId: d!.id, kind: 'Возврат тела', date: f.date, amount: num(f.amount), comment: f.comment } });
      else await apiPost('/api/finance/investors/prolong', { id: d!.id, name: f.name, start: f.start, amount: num(f.amount) + (f.addInt ? d!.remInt : 0), rate: num(f.rate), term: num(f.term), mode: f.mode, comment: f.comment });
      onSaved();
    } catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  };
  const dealFields = dlg.kind === 'new' || dlg.kind === 'edit' || dlg.kind === 'prolong';
  return (
    <Modal title={title} onClose={onClose}>
      {dlg.kind === 'prolong' && <p className="muted">Старый вклад станет «Пролонгирован», его будущие выплаты уберутся из календаря. Новый вклад получит свой номер и график.</p>}
      {(dlg.kind === 'pay' || dlg.kind === 'return') && <p className="muted">Осталось: тело {rub(d!.remBody)}, проценты {rub(d!.remInt)}. Ближайшая строка в календаре станет «Исполнено»; при полном возврате вклад закроется.</p>}
      <div className="fin-grid2">
        {(dlg.kind === 'new' || dlg.kind === 'edit') && <Field label="Инвестор">
          <input className="input" list="fin-people" value={f.person} onChange={e => setF({ ...f, person: e.target.value })} autoFocus />
          <datalist id="fin-people">{meta.people.map(p => <option key={p} value={p} />)}</datalist>
        </Field>}
        {dealFields && <Field label="Название вклада (необязательно)"><input className="input" value={f.name} onChange={e => setF({ ...f, name: e.target.value })} placeholder="например: Лидия 200к 2027" /></Field>}
        {dealFields && <Field label={dlg.kind === 'prolong' ? 'Новый вклад с даты' : 'Дата получения'}><input className="input" type="date" value={f.start} onChange={e => setF({ ...f, start: e.target.value })} /></Field>}
        {!dealFields && <Field label="Дата выплаты"><input className="input" type="date" value={f.date} onChange={e => setF({ ...f, date: e.target.value })} /></Field>}
        <Field label="Сумма, ₽"><input className="input" inputMode="decimal" value={f.amount} onChange={e => setF({ ...f, amount: e.target.value })} /></Field>
        {dealFields && <>
          <Field label="Ставка, % годовых"><input className="input" inputMode="decimal" value={f.rate} onChange={e => setF({ ...f, rate: e.target.value })} /></Field>
          <Field label="Срок, месяцев"><input className="input" inputMode="numeric" value={f.term} onChange={e => setF({ ...f, term: e.target.value })} /></Field>
          <Field label="Проценты">
            <select className="input" value={f.mode} onChange={e => setF({ ...f, mode: e.target.value as DealCalc['mode'] })}><option>Ежемесячно</option><option>В конце срока</option></select>
          </Field>
        </>}
        {dlg.kind === 'prolong' && d!.remInt > 0 && <label className="fin-check wide"><input type="checkbox" checked={f.addInt} onChange={e => setF({ ...f, addInt: e.target.checked })} /> Прибавить невыплаченные проценты {rub(d!.remInt)} к сумме нового вклада</label>}
        <Field label="Комментарий" wide><input className="input" value={f.comment} onChange={e => setF({ ...f, comment: e.target.value })} /></Field>
      </div>
      {err && <div className="fin-alert">{err}</div>}
      <div className="fin-actions"><button className="btn" onClick={onClose}>Отмена</button><button className="btn btn-primary" disabled={busy} onClick={save}><CheckIcon /> Сохранить</button></div>
    </Modal>
  );
}

// ─── полоса «Выплаты инвесторам» (19.11): 6 месяцев столбиками + список ближайших ───
const PAY_DONE = new Set(['Исполнено', 'Отменено', 'Перенесено']);
const shortRub = (n: number) => (n >= 1e6 ? `${(n / 1e6).toLocaleString('ru-RU', { maximumFractionDigits: n >= 1e7 ? 1 : 2 })} млн` : n >= 1000 ? `${Math.round(n / 1000)} тыс` : rub(n));
const capMonth = (m: string) => { const t = MONTHS[Number(m.slice(5, 7)) - 1]; return t[0].toUpperCase() + t.slice(1); };
function InvPayouts({ ops, today, onOpenMonth }: { ops: FinOp[]; today: string; onOpenMonth: (m: string) => void }) {
  const [sel, setSel] = useState<string | null>(null);
  const pays = useMemo(() => ops
    .filter(o => o.type === 'out' && o.cat.startsWith('Инвестор') && !PAY_DONE.has(o.status))
    .map(o => ({ ...o, when: o.date < today ? today : o.date, late: o.date < today, body: o.cat.includes('тела'), who: o.descr.split(' · ')[0] || o.descr }))
    .sort((a, b) => (a.when < b.when ? -1 : a.when > b.when ? 1 : b.plan - a.plan)), [ops, today]);
  const months = Array.from({ length: 6 }, (_, i) => shiftMonth(today.slice(0, 7), i));
  const per = months.map(m => {
    const list = pays.filter(p => p.when.slice(0, 7) === m);
    return { m, list, int: list.filter(p => !p.body).reduce((s, p) => s + p.plan, 0), body: list.filter(p => p.body).reduce((s, p) => s + p.plan, 0) };
  });
  const max = Math.max(1, ...per.map(p => p.int + p.body));
  const cur = sel ? per.find(p => p.m === sel) : null;
  const shown = cur ? cur.list : pays.slice(0, 5);
  return (
    <div className="card fin-pay">
      <div className="fin-pay-h">
        <h2>Выплаты инвесторам</h2>
        <span className="fin-legend"><i className="int" /> проценты <i className="body" /> возврат вклада</span>
      </div>
      <div className="fin-pay-grid">
        <div className="fin-pay-months">{per.map(p => (
          <button key={p.m} className={`fin-pay-m ${sel === p.m ? 'on' : ''}`} onClick={() => setSel(sel === p.m ? null : p.m)}
            title={`${capMonth(p.m)}: проценты ${rub(p.int)}, возврат вкладов ${rub(p.body)}`}>
            <span className="fin-pay-bar"><i className="int" style={{ height: `${(p.int / max) * 100}%` }} /><i className="body" style={{ height: `${(p.body / max) * 100}%` }} /></span>
            <b>{p.int + p.body ? shortRub(p.int + p.body) : '—'}</b>
            <span className="muted">{capMonth(p.m)}</span>
          </button>))}
        </div>
        <div className="fin-pay-list">
          <div className="fin-pay-lh">
            <b>{cur ? `${capMonth(cur.m)} · ${rub(cur.int + cur.body)}` : 'Ближайшие выплаты'}</b>
            {cur && <button className="fin-link" onClick={() => onOpenMonth(cur.m)}>открыть в календаре</button>}
          </div>
          {shown.length ? <ul>{shown.map(p => (
            <li key={p.id} className={p.late ? 'late' : ''}>
              <span className="d">{ddmm(p.when)}</span>
              <span className="w">{p.who}<small>{p.body ? 'возврат вклада' : 'проценты'}{p.late ? ` · не выплачено с ${ddmm(p.date)}` : ''}</small></span>
              <b className={p.body ? 'warn' : ''}>{rub(p.plan)}</b>
            </li>))}</ul> : <div className="muted">Выплат нет</div>}
          {!cur && <div className="muted fin-note">Нажмите на месяц, чтобы увидеть все его выплаты.</div>}
        </div>
      </div>
    </div>
  );
}

// ═══ Кредиты ═══════════════════════════════════════════════════════════════
function LoansTab({ meta, onOpenMonth }: { meta: Meta; onOpenMonth: (m: string) => void }) {
  const { data, err, reload } = useLoad<{ loans: LoanCalc[]; today: string }>('/api/finance/loans');
  const [open, setOpen] = useState<string | null>(null);
  const [form, setForm] = useState<LoanCalc | 'new' | null>(null);
  if (err) return <div className="fin-alert">Кредиты не загрузились: {err}</div>;
  if (!data) return <div className="card muted">Загружаю кредиты…</div>;
  const act = data.loans.filter(l => l.status === 'Действует');
  return (
    <div className="fin-col">
      <div className="fin-kpis">
        <div className="fin-kpi main"><span className="l">Впереди платежей по графикам</span><b>{rub(act.reduce((s, l) => s + l.leftSum, 0))}</b><span className="n">{act.length} кредитов и займов</span></div>
        <div className="fin-kpi"><span className="l">Остаток долга (по договорам)</span><b>{rub(act.reduce((s, l) => s + l.debt, 0))}</b></div>
        <div className="fin-kpi"><span className="l">Уже выплачено по графикам</span><b>{rub(act.reduce((s, l) => s + l.paidSum, 0))}</b></div>
      </div>
      <div className="fin-bar"><button className="btn btn-primary" onClick={() => setForm('new')}><PlusIcon /> Новый кредит</button></div>
      {data.loans.map(l => {
        const total = l.paidCount + l.leftCount; const pct = total ? Math.round(l.paidCount / total * 100) : 0;
        return (
          <div key={l.id} className="card fin-loan">
            <div className="fin-person-h">
              <h2>{l.lender}</h2><span className="muted">{l.contract}</span><span className="fin-spacer" />
              <button className="btn btn-sm" onClick={() => setForm(l)} aria-label="Изменить кредит"><PencilSimpleIcon /></button>
            </div>
            <div className="fin-loan-grid">
              <div><span className="l">Сумма</span><b>{rub(l.amount)}</b>{l.issued && <span className="muted">от {ddmmyy(l.issued)}</span>}</div>
              <div><span className="l">Цена</span><b>{l.price || '–'}</b></div>
              <div><span className="l">Ближайший платёж</span>{l.next ? <><b>{rub(l.next.plan)}</b><button className="fin-link" onClick={() => onOpenMonth(l.next!.date.slice(0, 7))}>{ddmmyy(l.next.date)}</button></> : <b>–</b>}</div>
              <div><span className="l">Впереди по графику</span><b>{rub(l.leftSum)}</b><span className="muted">{l.leftCount} платежей</span></div>
              <div><span className="l">Последний платёж</span><b>{ddmmyy(l.schedule[l.schedule.length - 1]?.date ?? l.lastDate)}</b></div>
            </div>
            {l.paidCount > 0 && <div className="fin-progress" title={`В календаре исполнено ${l.paidCount} из ${total}`}><i style={{ width: `${pct}%` }} /></div>}
            <dl className="fin-loan-info">
              <dt>В календаре</dt><dd>{l.paidCount > 0 ? `исполнено ${l.paidCount} из ${total} · ${rub(l.paidSum)}` : `${total} платежей, первый — ${ddmmyy(l.next?.date)}`}</dd>
              {l.how && <><dt>Как платим</dt><dd>{l.how}</dd></>}
              {l.comment && <><dt>Заметка</dt><dd className="muted">{l.comment}</dd></>}
            </dl>
            <button className="btn btn-sm fin-loan-sch" onClick={() => setOpen(open === l.id ? null : l.id)}>{open === l.id ? <CaretUpIcon /> : <CaretDownIcon />} {open === l.id ? 'Скрыть график' : 'Показать график'}</button>
            {open === l.id && <div className="fin-scroll"><table className="fin-table">
              <thead><tr><th>Дата</th><th>Платёж</th><th className="r">Сумма</th><th>Статус</th></tr></thead>
              <tbody>{l.schedule.map(o => <tr key={o.id} className={o.status === 'Исполнено' ? 'closed' : ''}><td>{ddmmyy(o.date)}, {wd(o.date)}</td><td>{o.descr}</td><td className="r">{rub(o.status === 'Исполнено' && o.fact !== null ? o.fact : o.plan)}</td><td><span className={`fin-pill ${STATUS_CLASS[o.status]}`}>{o.status}</span></td></tr>)}</tbody>
            </table></div>}
          </div>
        );
      })}
      {form && <LoanForm loan={form === 'new' ? null : form} meta={meta} onClose={() => setForm(null)} onSaved={() => { setForm(null); void reload(); }} />}
    </div>
  );
}

function LoanForm({ loan, meta, onClose, onSaved }: { loan: LoanCalc | null; meta: Meta; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({
    lender: loan?.lender ?? '', contract: loan?.contract ?? '', issued: loan?.issued ?? meta.today, amount: String(loan?.amount ?? ''), received: String(loan?.received ?? ''),
    price: loan?.price ?? '', term: loan?.term ?? '', how: loan?.how ?? '', debt: String(loan?.debt ?? ''), status: loan?.status ?? 'Действует', comment: loan?.comment ?? '',
    first: meta.today, count: '12', payment: '', every: 'month', account: '',
  });
  const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const num = (s: string) => Number(String(s).replace(/\s/g, '').replace(',', '.')) || 0;
  const save = async () => {
    setBusy(true);
    try {
      await apiPost('/api/finance/loans', {
        loan: { ...(loan ?? {}), schedule: undefined, lender: f.lender, contract: f.contract, issued: f.issued, amount: num(f.amount), received: num(f.received), price: f.price, term: f.term, how: f.how, debt: num(f.debt), status: f.status, comment: f.comment, payment: loan ? loan.payment : num(f.payment), lastDate: loan?.lastDate ?? '' },
        schedule: loan ? undefined : { first: f.first, count: num(f.count), payment: num(f.payment), every: f.every, account: f.account },
      });
      onSaved();
    } catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  };
  return (
    <Modal title={loan ? `Кредит ${loan.id}` : 'Новый кредит'} onClose={onClose}>
      <div className="fin-grid2">
        <Field label="Кредитор"><input className="input" value={f.lender} onChange={e => setF({ ...f, lender: e.target.value })} autoFocus={!loan} /></Field>
        <Field label="Договор"><input className="input" value={f.contract} onChange={e => setF({ ...f, contract: e.target.value })} /></Field>
        <Field label="Дата выдачи"><input className="input" type="date" value={f.issued} onChange={e => setF({ ...f, issued: e.target.value })} /></Field>
        <Field label="Сумма, ₽"><input className="input" inputMode="decimal" value={f.amount} onChange={e => setF({ ...f, amount: e.target.value })} /></Field>
        <Field label="Получено на счёт, ₽"><input className="input" inputMode="decimal" value={f.received} onChange={e => setF({ ...f, received: e.target.value })} /></Field>
        <Field label="Остаток долга, ₽"><input className="input" inputMode="decimal" value={f.debt} onChange={e => setF({ ...f, debt: e.target.value })} /></Field>
        <Field label="Цена (ставка, комиссия)"><input className="input" value={f.price} onChange={e => setF({ ...f, price: e.target.value })} /></Field>
        <Field label="Срок"><input className="input" value={f.term} onChange={e => setF({ ...f, term: e.target.value })} /></Field>
        <Field label="Как платим" wide><input className="input" value={f.how} onChange={e => setF({ ...f, how: e.target.value })} /></Field>
        {loan && <Field label="Статус"><select className="input" value={f.status} onChange={e => setF({ ...f, status: e.target.value as LoanCalc['status'] })}><option>Действует</option><option>Погашен</option></select></Field>}
        <Field label="Комментарий" wide><input className="input" value={f.comment} onChange={e => setF({ ...f, comment: e.target.value })} /></Field>
      </div>
      {!loan && <>
        <h3 className="fin-h3">График платежей — встанет в календарь</h3>
        <div className="fin-grid2">
          <Field label="Первый платёж"><input className="input" type="date" value={f.first} onChange={e => setF({ ...f, first: e.target.value })} /></Field>
          <Field label="Платёж, ₽"><input className="input" inputMode="decimal" value={f.payment} onChange={e => setF({ ...f, payment: e.target.value })} /></Field>
          <Field label="Сколько платежей"><input className="input" inputMode="numeric" value={f.count} onChange={e => setF({ ...f, count: e.target.value })} /></Field>
          <Field label="Как часто"><select className="input" value={f.every} onChange={e => setF({ ...f, every: e.target.value })}><option value="month">раз в месяц</option><option value="week">раз в неделю</option></select></Field>
          <Field label="Со счёта"><input className="input" list="fin-acc2" value={f.account} onChange={e => setF({ ...f, account: e.target.value })} /><datalist id="fin-acc2">{meta.accounts.map(a => <option key={a} value={a} />)}</datalist></Field>
        </div>
        <p className="muted fin-note">Если платежи неравные — поставьте примерный график, а потом поправьте суммы прямо в календаре.</p>
      </>}
      {err && <div className="fin-alert">{err}</div>}
      <div className="fin-actions"><button className="btn" onClick={onClose}>Отмена</button><button className="btn btn-primary" disabled={busy} onClick={save}><CheckIcon /> Сохранить</button></div>
    </Modal>
  );
}

// ═══ Справочники ══════════════════════════════════════════════════════════
type ListKind = 'cat' | 'account' | 'party';
type ListItem = { name: string; type?: OpType; used: number };
const LIST_TITLES: Record<ListKind, { title: string; hint: string; add: string }> = {
  cat: { title: 'Статьи', hint: 'Подсказки в поле «Статья». Приходные и расходные — отдельно.', add: 'Новая статья' },
  party: { title: 'Контрагенты', hint: 'Подсказки в поле «Контрагент / описание»: поставщики, подрядчики, сотрудники.', add: 'Новый контрагент' },
  account: { title: 'Счета', hint: 'Подсказки в поле «Счёт».', add: 'Новый счёт' },
};
function ListsTab({ onChange }: { onChange: () => void }) {
  const { data, err, reload } = useLoad<{ lists: Record<ListKind, ListItem[]> }>('/api/finance/lists');
  const [kind, setKind] = useState<ListKind>('cat');
  const [name, setName] = useState(''); const [type, setType] = useState<OpType>('out');
  const [edit, setEdit] = useState<{ name: string; to: string; type: OpType } | null>(null);
  const [q, setQ] = useState(''); const [msg, setMsg] = useState('');
  const send = async (body: Record<string, unknown>, ok: string) => {
    try { await apiPost('/api/finance/lists', { kind, ...body }); setMsg(ok); setEdit(null); void reload(); onChange(); return true; }
    catch (e) { setMsg('Не сохранилось: ' + errText(e)); return false; }
  };
  const add = async () => { if (!name.trim()) return; if (await send({ action: 'add', name: name.trim(), type }, `Добавлено: ${name.trim()}`)) setName(''); };
  const del = (it: ListItem) => {
    if (!window.confirm(`Убрать «${it.name}» из подсказок?${it.used ? ` Строки календаря (${it.used}) останутся как есть.` : ''}`)) return;
    void send({ action: 'delete', name: it.name }, `Убрано: ${it.name}`);
  };
  if (err) return <div className="fin-alert">Справочники не загрузились: {err}</div>;
  if (!data) return <div className="card muted">Загружаю справочники…</div>;
  const t = LIST_TITLES[kind];
  const items = data.lists[kind].filter(i => !q.trim() || i.name.toLowerCase().includes(q.trim().toLowerCase()));
  const groups: Array<[string, ListItem[]]> = kind === 'cat'
    ? [['Приходы', items.filter(i => i.type === 'in')], ['Расходы', items.filter(i => i.type !== 'in')]]
    : [['', items]];
  return (
    <div className="fin-col">
      <div className="fin-bar">
        <div className="fin-seg">
          {(Object.keys(LIST_TITLES) as ListKind[]).map(k => <button key={k} className={kind === k ? 'on' : ''} onClick={() => { setKind(k); setEdit(null); setQ(''); }}>{LIST_TITLES[k].title} · {data.lists[k].length}</button>)}
        </div>
        <input className="input fin-search" placeholder="Найти" value={q} onChange={e => setQ(e.target.value)} />
      </div>
      <div className="card">
        <p className="muted fin-note fin-lists-hint">{t.hint} Если впишете в операцию новое название статьи или счёта, оно добавится сюда само. Убранное из списка в старых строках календаря остаётся.</p>
        <div className="fin-lists-add">
          <input className="input" placeholder={t.add} value={name} onChange={e => setName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void add(); }} />
          {kind === 'cat' && <div className="fin-seg"><button className={type === 'in' ? 'on in' : ''} onClick={() => setType('in')}>Приход</button><button className={type === 'out' ? 'on out' : ''} onClick={() => setType('out')}>Расход</button></div>}
          <button className="btn btn-primary" onClick={() => void add()} disabled={!name.trim()}><PlusIcon /> Добавить</button>
        </div>
        {msg && <div className="muted fin-note">{msg}</div>}
        {groups.map(([g, list]) => (
          <div key={g || 'all'} className="fin-lists-group">
            {g && <h3 className="fin-h3">{g} · {list.length}</h3>}
            {!list.length && <div className="muted fin-note">Пусто</div>}
            <ul className="fin-lists">{list.map(it => (
              <li key={it.name}>
                {edit?.name === it.name ? <>
                  <input className="input" value={edit.to} autoFocus onChange={e => setEdit({ ...edit, to: e.target.value })}
                    onKeyDown={e => { if (e.key === 'Enter') void send({ action: 'rename', name: it.name, to: edit.to, type: edit.type }, 'Переименовано'); if (e.key === 'Escape') setEdit(null); }} />
                  {kind === 'cat' && <select className="input fin-lists-type" value={edit.type} onChange={e => setEdit({ ...edit, type: e.target.value as OpType })}><option value="in">приход</option><option value="out">расход</option></select>}
                  <button className="btn btn-sm btn-primary" aria-label="Сохранить" onClick={() => void send({ action: 'rename', name: it.name, to: edit.to, type: edit.type }, 'Переименовано')}><CheckIcon /></button>
                  <button className="btn btn-sm" aria-label="Отмена" onClick={() => setEdit(null)}><XIcon /></button>
                </> : <>
                  <span className="fin-lists-name">{it.name}</span>
                  <span className="muted">{it.used ? `в календаре: ${it.used}` : 'не используется'}</span>
                  <button className="btn btn-sm" aria-label={`Переименовать ${it.name}`} title="Переименовать — изменится и во всех строках календаря" onClick={() => setEdit({ name: it.name, to: it.name, type: it.type ?? 'out' })}><PencilSimpleIcon /></button>
                  <button className="btn btn-sm" aria-label={`Убрать ${it.name}`} title="Убрать из подсказок" onClick={() => del(it)}><TrashIcon /></button>
                </>}
              </li>))}</ul>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Кто отвечает за операцию — выбор в форме (19.11, просьба владельца). Старое значение не из списка сохраняется. */
const RESP_PEOPLE = ['Александр', 'Дмитрий', 'Бухгалтер'];

// ═══ мелочи ════════════════════════════════════════════════════════════════
function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [onClose]);
  return (
    <div className="fin-overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="fin-modal sa" role="dialog" aria-modal="true" aria-label={title}>
        <div className="fin-modal-h"><h2>{title}</h2><button className="btn btn-sm" aria-label="Закрыть" onClick={onClose}><XIcon /></button></div>
        {children}
      </div>
    </div>
  );
}
function Field({ label, children, wide }: { label: string; children: ReactNode; wide?: boolean }) {
  return <label className={`fin-field ${wide ? 'wide' : ''}`}><span>{label}</span>{children}</label>;
}
