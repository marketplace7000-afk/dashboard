/**
 * «План» (02.11.2026) — план заказов по артикулам и месяцам вместо таблицы «AV План 2026».
 *
 * Формат по просьбе владельца: артикулы в одном столбце, значения — в остальных; месяц выбирается
 * сверху, каждый хранится отдельно. Рубли: штуки × средний чек за 7 или 30 дней. Новинку можно
 * заложить заранее, с плановой ценой и датой старта. Заполняют руководитель продаж и менеджеры,
 * утверждает владелец. Расчёты — на сервере (api/_lib/plan.ts).
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CaretDownIcon, CaretRightIcon, CaretLeftIcon, PlusIcon, TrashIcon, CheckCircleIcon, ArrowSquareOutIcon, CopyIcon } from '@phosphor-icons/react';
import '../plan.css';
import { apiGet, apiPost, errText } from '../api/http';
import { shiftMonth, type PlanMp, type PlanResponse, type PlanRow, type PlanStats, type PlanView } from '../../shared/plan';

const nf0 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });
const n0 = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? '–' : nf0.format(v));
const n1 = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? '–' : nf1.format(v));
const rub = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? '–' : `${nf0.format(v)} ₽`);
const pct = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? '–' : `${nf0.format(v)} %`);
const MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
const monthName = (m: string) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
const shortMonth = (m: string) => `${MONTHS[Number(m.slice(5, 7)) - 1].slice(0, 3)}. ${m.slice(2, 4)}`;
const ddmm = (d: string | null) => (d ? `${d.slice(8, 10)}.${d.slice(5, 7)}` : '–');
const moscowMonth = () => new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 7);

type Filter = 'all' | 'behind' | 'outside' | 'loss' | 'new' | 'short';
type SortKey = 'planRub' | 'qty' | 'fact' | 'pct' | 'needPerDay' | 'pace7' | 'ads' | 'marginPct' | 'article';
const SOURCE: Record<string, string> = {
  manual: 'плановая цена', frozen: 'зафиксирован', avg7: 'чек за 7 дней', avg30: 'чек за 30 дней', avg90: 'чек за 90 дней', none: 'задайте цену',
};

function pctClass(p: number | null, expected: number | null, qty: number) {
  if (p === null) return '';
  const ok = expected !== null && qty > 0 ? expected / qty * 100 : 100;
  return p >= ok ? 'good' : p >= ok * 0.8 ? 'warn' : 'bad';
}

export function Plan() {
  const [tab, setTab] = useState<'plan' | 'stats'>('plan');
  const [view, setView] = useState<PlanView>(() => { try { const v = localStorage.getItem('plan:view'); return v === 'ozon' || v === 'all' ? v : 'wb'; } catch { return 'wb'; } });
  const [month, setMonth] = useState(moscowMonth);
  const pickView = (v: PlanView) => { setView(v); try { localStorage.setItem('plan:view', v); } catch { /* не критично */ } };
  return (
    <div className="plan">
      <div className="plan-head">
        <div className="plan-seg" role="group" aria-label="Площадка">
          {([['wb', 'Wildberries'], ['ozon', 'Ozon'], ['all', 'Все площадки']] as const).map(([k, l]) => (
            <button key={k} aria-pressed={view === k} onClick={() => pickView(k)}>{l}</button>
          ))}
        </div>
        <div className="plan-seg" role="group" aria-label="Экран">
          <button aria-pressed={tab === 'plan'} onClick={() => setTab('plan')}>План месяца</button>
          <button aria-pressed={tab === 'stats'} onClick={() => setTab('stats')}>Статистика по месяцам</button>
        </div>
      </div>
      {tab === 'plan'
        ? <MonthPlan view={view} month={month} setMonth={setMonth} />
        : <Stats view={view} onOpen={m => { setMonth(m); setTab('plan'); }} />}
    </div>
  );
}

function MonthPlan({ view, month, setMonth }: { view: PlanView; month: string; setMonth: (m: string) => void }) {
  const [data, setData] = useState<PlanResponse | null>(null);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<{ k: SortKey; desc: boolean }>({ k: 'planRub', desc: true });
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const my = ++seq.current;
    try {
      const r = await apiGet<PlanResponse>(`/api/plan?view=${view}&month=${month}`);
      if (my === seq.current) { setData(r.data); setErr(''); }
    } catch (e) { if (my === seq.current) setErr(errText(e)); }
  }, [view, month]);
  useEffect(() => { setData(null); void load(); }, [load]);
  useEffect(() => { const t = setInterval(load, 300_000); return () => clearInterval(t); }, [load]);

  const post = async (path: string, body: object) => {
    try {
      await apiPost(`/api/plan/${path}`, { month, mp: view, ...body });
      setMsg(''); await load();
    } catch (e) { setMsg(errText(e)); }
  };

  const rows = useMemo(() => {
    if (!data) return [];
    const q = query.trim().toLowerCase();
    const list = data.rows.filter(r => {
      if (q && !`${r.article} ${r.name}`.toLowerCase().includes(q)) return false;
      switch (filter) {
        case 'behind': return r.behind;
        case 'outside': return r.qty <= 0 && r.fact > 0;
        case 'loss': return r.qty > 0 && r.marginPct !== null && r.marginPct < 0;
        case 'new': return r.isNew;
        case 'short': return r.stockShort;
        default: return true;
      }
    });
    const dir = sort.desc ? -1 : 1;
    return list.sort((a, b) => {
      if (sort.k === 'article') return a.article.localeCompare(b.article) * dir;
      const x = a[sort.k], y = b[sort.k];
      if (x === null && y === null) return 0;
      if (x === null) return 1;
      if (y === null) return -1;
      return ((x as number) - (y as number)) * dir;
    });
  }, [data, filter, query, sort]);

  if (err && !data) return <div className="card">Не удалось загрузить план: {err}</div>;

  const months = data?.months ?? [month];
  const cur = moscowMonth();
  const options = [...new Set([...months, month])].sort().reverse();
  const t = data?.totals;
  const mpEdit = view !== 'all';
  const approved = data?.state === 'approved';
  const count = (f: Filter) => data?.rows.filter(r => f === 'behind' ? r.behind : f === 'outside' ? r.qty <= 0 && r.fact > 0 : f === 'loss' ? r.qty > 0 && r.marginPct !== null && r.marginPct < 0 : f === 'new' ? r.isNew : f === 'short' ? r.stockShort : true).length ?? 0;
  const sortBtn = (k: SortKey, label: string, title?: string) => (
    <button className="plan-th" title={title} onClick={() => setSort(s => ({ k, desc: s.k === k ? !s.desc : k !== 'article' }))}>{label}{sort.k === k ? (sort.desc ? ' ↓' : ' ↑') : ''}</button>
  );

  return (
    <>
      <div className="plan-bar">
        <div className="plan-month">
          <button className="btn btn-sm" onClick={() => setMonth(shiftMonth(month, -1))} aria-label="Предыдущий месяц"><CaretLeftIcon size={16} /></button>
          <select value={month} onChange={e => setMonth(e.target.value)} aria-label="Месяц">
            {options.map(m => <option key={m} value={m}>{monthName(m)}</option>)}
          </select>
          <button className="btn btn-sm" onClick={() => setMonth(shiftMonth(month, 1))} disabled={month >= shiftMonth(cur, 1)} aria-label="Следующий месяц"><CaretRightIcon size={16} /></button>
        </div>
        {data && mpEdit && (
          <span className={`plan-state ${approved ? 'ok' : ''}`}>
            {approved ? <><CheckCircleIcon size={18} weight="fill" /> Утверждён{data.approvedBy ? `: ${data.approvedBy}` : ''}</> : 'Черновик'}
          </span>
        )}
        {data && !mpEdit && <span className="muted">Правка плана — на листе площадки</span>}
        <span className="plan-spacer" />
        {data && mpEdit && !approved && data.period !== 'past' && (
          <label className="plan-basis" title="Количество × средний чек = план в рублях. При утверждении цена фиксируется.">Средний чек за
            <select value={data.basis} disabled={!data.canEdit} onChange={e => post('basis', { basis: e.target.value })}>
              <option value="7d">7 дней</option>
              <option value="30d">30 дней</option>
            </select>
          </label>
        )}
        {data?.canEdit && <button className="btn btn-sm" onClick={() => setAdding(a => !a)}><PlusIcon size={15} /> Товар или новинка</button>}
        {data?.canEdit && !approved && <button className="btn btn-sm" onClick={() => post('copy', {})} title="Перенести количества прошлого месяца в пустые строки"><CopyIcon size={15} /> Из прошлого месяца</button>}
        {data?.canApprove && !approved && <button className="btn btn-sm btn-primary" onClick={() => post('approve', {})}>Утвердить план</button>}
        {data?.canApprove && approved && <button className="btn btn-sm" onClick={() => post('unapprove', {})}>Вернуть в черновик</button>}
        {mpEdit && <button className="btn btn-sm" onClick={() => setLogOpen(o => !o)}>История правок</button>}
      </div>
      {msg && <div className="plan-alert">{msg}</div>}
      {!data && <div className="card muted">Загружаю план…</div>}
      {data?.finance.error && <div className="plan-note">Отчёт финансиста сейчас не прочитался: {data.finance.error}. Показана последняя загруженная маржа.</div>}

      {data && t && (
        <div className="plan-kpis">
          <Kpi label="План" main={`${n0(t.qty)} шт`} sub={rub(t.planRub)} />
          <Kpi label="Факт заказов" main={`${n0(t.fact)} шт`} sub={rub(t.factRub)} note={t.factOutOfPlan > 0 ? `из них вне плана ${n0(t.factOutOfPlan)} шт` : undefined} />
          <Kpi label="Выполнение" main={pct(t.pct)} sub={`в рублях ${pct(t.pctRub)}`} tone={pctClass(t.pct, t.expected, t.qty)}
            note={data.period === 'current' && t.expected !== null ? `по графику к вчера: ${n0(t.expected)} шт` : undefined} />
          {data.period !== 'past' && <Kpi label="Нужно в день" main={t.needPerDay === null ? '–' : `${n1(t.needPerDay)} шт`} sub={t.needRubPerDay === null ? '' : rub(t.needRubPerDay)}
            note={t.needPerDay === null ? undefined : `осталось дней: ${data.daysLeft}; сумма по артикулам ${n1(t.needSumByArticle)} шт`}
            title="(план − заказы по вчера) ÷ дней до конца месяца, включая сегодня. Излишек одного товара не закрывает недобор другого, поэтому сумма по артикулам больше" />}
          {data.period === 'current' && <Kpi label="Темп за 7 дней, в день" main={t.pace7 === null ? '–' : `${n1(t.pace7)} шт`} tone={t.needPerDay !== null && t.pace7 !== null && t.pace7 < t.needPerDay ? 'bad' : 'good'}
            sub={t.forecast === null ? '' : `прогноз: ${n0(t.forecast)} шт`} note={t.forecastRub === null ? undefined : `≈ ${rub(t.forecastRub)}`} />}
          <Kpi label="Реклама" main={rub(t.ads)} sub={`${pct(t.drr)} от заказов`} />
          <Kpi label="Маржа, финансист" main={pct(t.marginPct)}
            sub={data.finance.approxTo ? `примерно по ${ddmm(data.finance.approxTo)}` : data.finance.month ? shortMonth(data.finance.month) : 'отчёта ещё нет'}
            title="Маржа с налогом из таблицы финансиста, средняя с весом заказов в рублях. Обновляется, когда финансист заполняет отчёт" />
        </div>
      )}

      {data && adding && mpEdit && <AddPanel data={data} onClose={() => setAdding(false)} onSave={async b => { await post('line', b); setAdding(false); }} />}
      {data && logOpen && mpEdit && <LogPanel mp={view as PlanMp} month={month} />}

      {data && (
        <>
          <div className="plan-tools">
            <input className="plan-search" type="search" placeholder="Артикул или название" value={query} onChange={e => setQuery(e.target.value)} />
            <div className="plan-seg sm" role="group" aria-label="Фильтр">
              {([['all', 'Все'], ['behind', 'Отстают'], ['outside', 'Вне плана'], ['loss', 'В минусе'], ['short', 'Не хватит товара'], ['new', 'Новинки']] as const).map(([k, l]) => (
                <button key={k} aria-pressed={filter === k} onClick={() => setFilter(k)}>{l}{k !== 'all' && count(k) ? ` · ${count(k)}` : ''}</button>
              ))}
            </div>
            <span className="muted plan-count">{rows.length} из {data.rows.length}</span>
          </div>
          {!rows.length && <div className="card muted">{data.rows.length ? 'Ничего не нашлось.' : 'Строк пока нет. Добавьте товар или перенесите план из прошлого месяца.'}</div>}
          {rows.length > 0 && (
            <div className="plan-scroll">
              <table className="plan-table">
                <thead>
                  <tr>
                    <th className="plan-sticky">{sortBtn('article', 'Артикул')}</th>
                    <th>Статус</th>
                    <th className="r">{sortBtn('qty', 'План, шт')}</th>
                    <th className="r" title="На что умножается количество">Средний чек</th>
                    <th className="r">{sortBtn('planRub', 'План, ₽')}</th>
                    <th className="r">{sortBtn('fact', 'Факт, шт')}</th>
                    <th>{sortBtn('pct', 'Выполнение')}</th>
                    <th className="r">Факт, ₽</th>
                    <th className="r">{sortBtn('needPerDay', 'Нужно в день', '(план − заказы по вчера) ÷ оставшиеся дни')}</th>
                    <th className="r">{sortBtn('pace7', 'Темп 7 дн', 'Заказов в день за последние 7 полных дней')}</th>
                    <th className="r" title="Заказы по вчера + темп за 7 дней × оставшиеся дни">Прогноз</th>
                    <th className="r">{sortBtn('ads', 'Реклама')}</th>
                    <th className="r">{sortBtn('marginPct', 'Маржа', 'Из отчёта финансиста, последний заполненный месяц')}</th>
                    <th className="r" title="Текущий остаток и товар в пути">Остаток</th>
                    <th aria-label="Подробнее" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map(r => (
                    <PlanLine key={r.article} r={r} data={data} open={open.has(r.article)}
                      onToggle={() => setOpen(s => { const n = new Set(s); if (n.has(r.article)) n.delete(r.article); else n.add(r.article); return n; })}
                      post={post} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {view === 'ozon' && <p className="muted plan-foot">Заказы Ozon в рублях — по цене продавца, как в «Заказано на сумму» Ozon. Покупатель платит меньше.</p>}
        </>
      )}
    </>
  );
}

function Kpi({ label, main, sub, note, tone, title }: { label: string; main: string; sub?: string; note?: string; tone?: string; title?: string }) {
  return (
    <div className="plan-kpi" title={title}>
      <span className="l">{label}</span>
      <b className={tone || ''}>{main}</b>
      {sub && <span className="s">{sub}</span>}
      {note && <span className="n">{note}</span>}
    </div>
  );
}

function NumInput({ value, disabled, onSave, label, width = 76 }: { value: number; disabled: boolean; onSave: (v: number) => void; label: string; width?: number }) {
  const [v, setV] = useState(String(value || ''));
  useEffect(() => { setV(String(value || '')); }, [value]);
  const commit = () => { const n = Math.max(0, Math.round(Number(v.replace(',', '.')) || 0)); if (n !== value) onSave(n); };
  return (
    <input className="plan-num" style={{ width }} inputMode="numeric" value={v} disabled={disabled} aria-label={label} placeholder="0" onClick={e => e.stopPropagation()}
      onChange={e => setV(e.target.value.replace(/[^\d.,]/g, ''))} onBlur={commit}
      onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') { setV(String(value || '')); (e.target as HTMLInputElement).blur(); } }} />
  );
}

function PlanLine({ r, data, open, onToggle, post }: { r: PlanRow; data: PlanResponse; open: boolean; onToggle: () => void; post: (p: string, b: object) => Promise<void> }) {
  const can = data.canEdit;
  const priceEditable = can && data.state !== 'approved' && (r.isNew || r.priceSource === 'none' || r.priceSource === 'manual');
  const tone = pctClass(r.pct, r.expected, r.qty);
  const width = r.pct === null ? 0 : Math.min(100, r.pct);
  const preSale = r.isNew && !r.inSale;
  return (
    <Fragment>
      <tr className={`${open ? 'open' : ''} ${r.qty <= 0 && r.fact > 0 ? 'outside' : ''}`}>
        <td className="plan-sticky">
          <div className="plan-prod">
            {r.photo ? <img src={r.photo} alt="" loading="lazy" /> : <span className="ph" />}
            <div>
              <div className="a" title={r.name || r.article}>{r.article}{r.link && <a href={r.link} target="_blank" rel="noreferrer" title="Открыть на площадке" onClick={e => e.stopPropagation()}><ArrowSquareOutIcon size={13} /></a>}</div>
              {r.name && <div className="nm" title={r.name}>{r.name}</div>}
            </div>
          </div>
        </td>
        <td>
          {can && !r.isNew
            ? <select className={`plan-st st-${r.status}`} value={r.status} aria-label="Статус товара" onChange={e => post('line', { article: r.article, status: e.target.value })}>
                <option>Рабочий</option><option>Вывод</option><option>Новинка</option>
              </select>
            : <span className={`plan-st st-${r.status}`}>{r.status}</span>}
          {preSale && <div className="plan-sub">{r.startDate ? `старт ${ddmm(r.startDate)}` : 'ещё не в продаже'}</div>}
        </td>
        <td className="r">
          {r.mp === 'all'
            ? <><b>{n0(r.qty)}</b>{(r.wb || r.ozon) && <div className="plan-sub">WB {n0(r.wb?.qty ?? 0)} · Ozon {n0(r.ozon?.qty ?? 0)}</div>}</>
            : <NumInput value={r.qty} disabled={!can} label={`План ${r.article}`} onSave={qty => post('line', { article: r.article, qty })} />}
          {r.prevFact !== null && r.mp !== 'all' && <div className="plan-sub" title="Заказов в прошлом месяце">пр. мес. {n0(r.prevFact)}</div>}
        </td>
        <td className="r">
          {priceEditable
            ? <NumInput value={r.price} disabled={false} width={92} label={`Цена ${r.article}`} onSave={price => post('line', { article: r.article, price })} />
            : <span className={r.price <= 0 ? 'bad' : ''}>{r.price > 0 ? rub(r.price) : 'нет цены'}</span>}
          <div className="plan-sub">{SOURCE[r.priceSource]}</div>
        </td>
        <td className="r"><b>{r.planRub > 0 ? rub(r.planRub) : '–'}</b></td>
        <td className="r"><b>{n0(r.fact)}</b>{r.mp === 'all' && (r.wb || r.ozon) && <div className="plan-sub">WB {n0(r.wb?.fact ?? 0)} · Ozon {n0(r.ozon?.fact ?? 0)}</div>}</td>
        <td>
          <div className="plan-prog"><i className={tone} style={{ width: `${width}%` }} />
            {r.expected !== null && r.qty > 0 && data.period === 'current' && <u style={{ left: `${Math.min(100, r.expected / r.qty * 100)}%` }} title={`По графику к вчера: ${n0(r.expected)} шт`} />}
          </div>
          <span className={`plan-pct ${tone}`}>{r.pct === null ? (r.fact > 0 ? 'вне плана' : '–') : pct(r.pct)}</span>
        </td>
        <td className="r">{rub(r.factRub)}{r.pctRub !== null && <div className="plan-sub">{pct(r.pctRub)}</div>}</td>
        <td className="r"><b className={r.behind ? 'bad' : ''}>{r.needPerDay === null ? '–' : n1(r.needPerDay)}</b></td>
        <td className="r">{r.pace7 === null ? '–' : n1(r.pace7)}</td>
        <td className="r">{r.forecast === null ? '–' : n0(r.forecast)}</td>
        <td className="r">{rub(r.ads)}{r.drr !== null && <div className="plan-sub">{pct(r.drr)}</div>}</td>
        <td className="r">
          <b className={r.marginPct === null ? 'muted' : r.marginPct < 0 ? 'bad' : r.marginPct < 15 ? 'warn' : 'good'}>{r.marginPct === null ? '–' : `${n1(r.marginPct)} %`}</b>
          {r.marginMonth && <div className="plan-sub">{shortMonth(r.marginMonth)}</div>}
        </td>
        <td className="r">
          <span className={r.stockShort ? 'bad' : ''}>{n0(r.stock)}</span>
          {!!r.transit && <div className="plan-sub">едет {n0(r.transit)}</div>}
          {r.stockShort && <div className="plan-sub bad">не хватит</div>}
        </td>
        <td><button className="plan-exp" onClick={onToggle} aria-expanded={open} aria-label={`Подробнее: ${r.article}`}>{open ? <CaretDownIcon size={18} /> : <CaretRightIcon size={18} />}</button></td>
      </tr>
      {open && <tr className="plan-detail"><td colSpan={15}><Detail r={r} data={data} post={post} /></td></tr>}
    </Fragment>
  );
}

function Detail({ r, data, post }: { r: PlanRow; data: PlanResponse; post: (p: string, b: object) => Promise<void> }) {
  const [to, setTo] = useState('');
  let cum = 0;
  const can = data.canEdit;
  const days = r.daily.filter(d => d.date <= data.today).map(d => { cum += d.cnt; return { ...d, cum }; }).reverse();
  return (
    <div className="plan-det">
      <div className="plan-det-side">
        {r.isNew && can && (
          <>
            <label>Плановая цена, ₽ <NumInput value={r.priceSource === 'manual' ? r.price : 0} disabled={false} width={110} label="Плановая цена" onSave={price => post('line', { article: r.article, price })} /></label>
            <label>Дата старта продаж <input type="date" className="plan-date" defaultValue={r.startDate ?? ''} onBlur={e => { if ((e.target.value || null) !== r.startDate) void post('line', { article: r.article, startDate: e.target.value || null }); }} /></label>
            {!r.inSale && <label>Артикул на площадке <span className="plan-inline"><input className="plan-txt" value={to} onChange={e => setTo(e.target.value)} placeholder={r.article} /><button className="btn btn-sm" disabled={!to.trim()} onClick={() => post('rename', { article: r.article, to })}>Привязать</button></span></label>}
          </>
        )}
        {can && <label>Комментарий <textarea className="plan-txt" rows={2} defaultValue={r.comment} onBlur={e => { if (e.target.value !== r.comment) void post('line', { article: r.article, comment: e.target.value }); }} /></label>}
        {!can && r.comment && <p>{r.comment}</p>}
        {can && r.hasLine && <button className="btn btn-sm" onClick={() => post('remove', { article: r.article })}><TrashIcon size={14} /> Убрать из плана</button>}
      </div>
      {days.length > 0 ? (
        <table className="plan-days">
          <thead><tr><th>День</th><th className="r">Заказы</th><th className="r">Накоплено</th><th className="r">% плана</th></tr></thead>
          <tbody>{days.map(d => <tr key={d.date}><td>{ddmm(d.date)}</td><td className="r">{n0(d.cnt)}</td><td className="r"><b>{n0(d.cum)}</b></td><td className="r">{r.qty > 0 ? pct(d.cum / r.qty * 100) : '–'}</td></tr>)}</tbody>
        </table>
      ) : <p className="muted">По дням: {data.factSource === 'finance' ? 'за этот месяц есть только итог из отчёта финансиста.' : 'заказов пока нет.'}</p>}
    </div>
  );
}

function AddPanel({ data, onClose, onSave }: { data: PlanResponse; onClose: () => void; onSave: (b: object) => Promise<void> }) {
  const [mode, setMode] = useState<'new' | 'catalog'>('new');
  const [article, setArticle] = useState('');
  const [name, setName] = useState('');
  const [qty, setQty] = useState('');
  const [price, setPrice] = useState('');
  const [start, setStart] = useState('');
  const [q, setQ] = useState('');
  const found = data.catalog.filter(c => `${c.article} ${c.name}`.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 8);
  const save = () => mode === 'new'
    ? onSave({ article, name, qty: Number(qty) || 0, price: Number(price) || 0, startDate: start || null, isNew: true })
    : onSave({ article, qty: Number(qty) || 0 });
  const ok = !!article.trim() && (mode === 'catalog' || Number(price) > 0);
  return (
    <section className="plan-add">
      <div className="plan-seg sm" role="group" aria-label="Что добавить">
        <button aria-pressed={mode === 'new'} onClick={() => { setMode('new'); setArticle(''); }}>Новинка, ещё не на площадке</button>
        <button aria-pressed={mode === 'catalog'} onClick={() => { setMode('catalog'); setArticle(''); }}>Товар из каталога</button>
      </div>
      {mode === 'new' ? (
        <div className="plan-add-grid">
          <label>Артикул <input className="plan-txt" value={article} onChange={e => setArticle(e.target.value)} placeholder="можно рабочее название" /></label>
          <label>Название <input className="plan-txt" value={name} onChange={e => setName(e.target.value)} /></label>
          <label>План, шт <input className="plan-txt" inputMode="numeric" value={qty} onChange={e => setQty(e.target.value.replace(/\D/g, ''))} /></label>
          <label>Плановая цена, ₽ <input className="plan-txt" inputMode="numeric" value={price} onChange={e => setPrice(e.target.value.replace(/\D/g, ''))} /></label>
          <label>Старт продаж <input className="plan-txt" type="date" value={start} min={`${data.month}-01`} onChange={e => setStart(e.target.value)} /></label>
          {Number(qty) > 0 && Number(price) > 0 && <p className="plan-add-sum">В плане: <b>{rub(Number(qty) * Number(price))}</b></p>}
          <p className="muted plan-add-hint">Минимум в день считается от даты старта. Если артикул совпадёт с площадкой, заказы подхватятся сами; рабочее название потом можно привязать к настоящему артикулу.</p>
        </div>
      ) : (
        <div className="plan-add-grid">
          <label>Найти товар <input className="plan-txt" value={q} onChange={e => setQ(e.target.value)} placeholder="артикул или название" /></label>
          <label>План, шт <input className="plan-txt" inputMode="numeric" value={qty} onChange={e => setQty(e.target.value.replace(/\D/g, ''))} /></label>
          <div className="plan-found">
            {found.map(c => <button key={c.article} className={article === c.article ? 'on' : ''} onClick={() => setArticle(c.article)}><b>{c.article}</b> <span className="muted">{c.name}</span></button>)}
            {!found.length && <span className="muted">Все товары каталога уже в таблице.</span>}
          </div>
        </div>
      )}
      <div className="plan-add-btns">
        <button className="btn btn-sm btn-primary" disabled={!ok} onClick={save}>Добавить в план</button>
        <button className="btn btn-sm" onClick={onClose}>Отмена</button>
      </div>
    </section>
  );
}

function LogPanel({ mp, month }: { mp: PlanMp; month: string }) {
  const [rows, setRows] = useState<Array<{ at: number; user: string; article: string; field: string; before: string; after: string }> | null>(null);
  useEffect(() => { apiGet<{ rows: any[] }>(`/api/plan/log?mp=${mp}&month=${month}`).then(r => setRows(r.data.rows)).catch(() => setRows([])); }, [mp, month]);
  return (
    <section className="plan-add">
      <strong>История правок</strong>
      {!rows ? <p className="muted">Загружаю…</p> : !rows.length ? <p className="muted">Правок пока нет.</p> : (
        <table className="plan-days wide">
          <thead><tr><th>Когда</th><th>Кто</th><th>Артикул</th><th>Что</th><th>Было</th><th>Стало</th></tr></thead>
          <tbody>{rows.map((r, i) => <tr key={i}><td>{new Date(r.at).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</td><td>{r.user}</td><td>{r.article || '–'}</td><td>{r.field}</td><td>{r.before || '–'}</td><td>{r.after || '–'}</td></tr>)}</tbody>
        </table>
      )}
    </section>
  );
}

function Stats({ view, onOpen }: { view: PlanView; onOpen: (m: string) => void }) {
  const [article, setArticle] = useState('');
  const [applied, setApplied] = useState('');
  const [data, setData] = useState<PlanStats | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    let live = true;
    setData(null);
    apiGet<PlanStats>(`/api/plan/stats?view=${view}${applied ? `&article=${encodeURIComponent(applied)}` : ''}`)
      .then(r => { if (live) { setData(r.data); setErr(''); } }).catch(e => { if (live) setErr(errText(e)); });
    return () => { live = false; };
  }, [view, applied]);
  return (
    <>
      <div className="plan-tools">
        <form className="plan-inline" onSubmit={e => { e.preventDefault(); setApplied(article.trim()); }}>
          <input className="plan-search" value={article} onChange={e => setArticle(e.target.value)} placeholder="Артикул целиком, пусто — все товары" />
          <button className="btn btn-sm">Показать</button>
        </form>
      </div>
      {err && <div className="plan-alert">{err}</div>}
      {!data && !err && <div className="card muted">Считаю статистику…</div>}
      {data && (
        <div className="plan-scroll">
          <table className="plan-table plan-stats">
            <thead><tr><th className="plan-sticky">Месяц</th><th>Статус</th><th className="r">План, шт</th><th className="r">Факт, шт</th><th className="r">Выполнение</th><th className="r">План, ₽</th><th className="r">Факт, ₽</th><th className="r">Выполнение, ₽</th><th className="r">Реклама</th><th className="r">Доля рекламы</th><th className="r">Маржа</th><th>Источник факта</th></tr></thead>
            <tbody>
              {data.rows.map(r => (
                <tr key={r.month} className="click" onClick={() => onOpen(r.month)}>
                  <td className="plan-sticky"><b>{monthName(r.month)}</b></td>
                  <td>{r.state === 'approved' ? 'Утверждён' : r.state === 'draft' ? 'Черновик' : r.state === 'mixed' ? 'Частично' : 'Нет плана'}</td>
                  <td className="r">{n0(r.qty)}</td><td className="r"><b>{n0(r.fact)}</b></td>
                  <td className={`r plan-pct ${pctClass(r.pct, null, r.qty)}`}>{pct(r.pct)}</td>
                  <td className="r">{rub(r.planRub)}</td><td className="r">{rub(r.factRub)}</td><td className="r">{pct(r.pctRub)}</td>
                  <td className="r">{rub(r.ads)}</td><td className="r">{pct(r.drr)}</td><td className="r">{pct(r.marginPct)}</td>
                  <td className="muted">{r.factSource === 'finance' ? 'отчёт финансиста' : 'API площадки'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data && <p className="muted plan-foot">Январь–октябрь перенесены из таблицы AV План: рублёвый план там считался по последней цене товара, поэтому процент в рублях за прошлые месяцы приблизительный. С ноября цена фиксируется при утверждении. Выполнение считается по всем заказам месяца, включая товары вне плана.</p>}
    </>
  );
}
