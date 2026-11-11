/**
 * «План» (02.11.2026) — план заказов по артикулам и месяцам вместо таблицы «AV План 2026».
 *
 * Формат по просьбе владельца: артикулы в одном столбце, значения — в остальных; месяц выбирается
 * сверху, каждый хранится отдельно. Рубли: штуки × средний чек за 7 или 30 дней. Новинку можно
 * заложить заранее, с плановой ценой и датой старта. Заполняют руководитель продаж и менеджеры,
 * утверждает владелец. Расчёты — на сервере (api/_lib/plan.ts).
 *
 * Оформление — как в «Ведении карточек» (классы .cm-*), просьба владельца: всё должно быть крупно.
 * Сохранение: число пишется само через секунду после ввода, галочка ставится только после сверки
 * с ответом сервера. При ошибке ячейка краснеет и число не выдаётся за сохранённое.
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CaretDownIcon, CaretRightIcon, CaretLeftIcon, PlusIcon, TrashIcon, CheckCircleIcon, CheckIcon, ArrowClockwiseIcon, ArrowSquareOutIcon, CopyIcon, ArchiveIcon } from '@phosphor-icons/react';
import '../plan.css';
import { apiGet, apiPost, errText } from '../api/http';
import { planStatus, shiftMonth, type PlanArchived, type PlanMp, type PlanResponse, type PlanRow, type PlanStats, type PlanVersion, type PlanView } from '../../shared/plan';

const nf0 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });
const n0 = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? '–' : nf0.format(v));
const n1 = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? '–' : nf1.format(v));
const rub = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? '–' : `${nf0.format(v)} ₽`);
const pct = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? '–' : `${nf0.format(v)} %`);
const pct1 = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? '–' : `${nf1.format(v)} %`);
const MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
const monthName = (m: string) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
const shortMonth = (m: string) => `${MONTHS[Number(m.slice(5, 7)) - 1].slice(0, 3)}. ${m.slice(2, 4)}`;
const ddmm = (d: string | null) => (d ? `${d.slice(8, 10)}.${d.slice(5, 7)}` : '–');
const moscowMonth = () => new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 7);

type Filter = 'all' | 'behind' | 'outside' | 'loss' | 'new' | 'short';
type SortKey = 'planRub' | 'factRub' | 'qty' | 'fact' | 'pct' | 'forecast' | 'pace7' | 'drr' | 'marginPct' | 'article';
type PostFn = (path: string, body: object) => Promise<any | null>;
const SOURCE: Record<string, string> = {
  manual: 'плановая цена', frozen: 'зафиксирован', avg7: 'чек за 7 дней', avg30: 'чек за 30 дней', avg90: 'чек за 90 дней', none: 'задайте цену',
};
const FILTERS: Array<[Filter, string]> = [['all', 'Все'], ['behind', 'Отстают'], ['outside', 'Вне плана'], ['loss', 'В минусе'], ['short', 'Не хватит товара'], ['new', 'Новинки']];
const inFilter = (r: PlanRow, f: Filter) => {
  switch (f) {
    case 'behind': return r.behind;
    case 'outside': return r.qty <= 0 && r.fact > 0;
    case 'loss': return r.qty > 0 && r.marginPct !== null && r.marginPct < 0;
    case 'new': return r.isNew;
    case 'short': return r.stockShort;
    default: return true;
  }
};

function pctClass(p: number | null, expected: number | null, qty: number) {
  if (p === null) return '';
  const ok = expected !== null && qty > 0 ? expected / qty * 100 : 100;
  return p >= ok ? 'good' : p >= ok * 0.8 ? 'warn' : 'bad';
}

/** Цвет полосы товара — по тому же правилу, что и статус в РНП. Для месяцев без заказов по дням — по проценту. */
function rowTone(r: PlanRow, data: PlanResponse): string {
  if (r.qty <= 0) return '';
  if (!r.daily.length || data.period !== 'current') return pctClass(r.pct, r.expected, r.qty);
  const k = planStatus(r, data.month, data.today).key;
  return k === 'done' || k === 'ok' ? 'good' : k === 'near' ? 'warn' : k === 'bad' ? 'bad' : '';
}

/** Окно подтверждения: действие с планом выполняется только после галочки. */
function ConfirmDialog({ title, keep, change, tick, action, onYes, onNo }: { title: string; keep: string[]; change: string[]; tick: string; action: string; onYes: () => void; onNo: () => void }) {
  const [ok, setOk] = useState(false);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onNo(); };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [onNo]);
  return (
    <div className="plan-dlg-wrap" role="dialog" aria-modal="true" aria-label={title}>
      <div className="plan-dlg">
        <h2>{title}</h2>
        <div><b>Что сохранится</b><ul>{keep.map(x => <li key={x}>{x}</li>)}</ul></div>
        <div><b>Что изменится</b><ul>{change.map(x => <li key={x}>{x}</li>)}</ul></div>
        <label><input type="checkbox" checked={ok} autoFocus onChange={e => setOk(e.target.checked)} /> {tick}</label>
        <div className="plan-dlg-btns">
          <button className="btn" onClick={onNo}>Отмена</button>
          <button className="btn btn-primary" disabled={!ok} onClick={onYes}>{action}</button>
        </div>
      </div>
    </div>
  );
}

export function Plan() {
  const [tab, setTab] = useState<'plan' | 'stats'>('plan');
  const [view, setView] = useState<PlanView>(() => { try { const v = localStorage.getItem('plan:view'); return v === 'ozon' || v === 'all' ? v : 'wb'; } catch { return 'wb'; } });
  const [month, setMonth] = useState(moscowMonth);
  const pickView = (v: PlanView) => { setView(v); try { localStorage.setItem('plan:view', v); } catch { /* не критично */ } };
  return (
    <div className="plan cm">
      <div className="plan-bar">
        <div className="cm-tabs" role="group" aria-label="Площадка">
          {([['wb', 'Wildberries'], ['ozon', 'Ozon'], ['all', 'Все площадки']] as const).map(([k, l]) => (
            <button key={k} className={`cm-tab ${view === k ? 'active' : ''}`} aria-pressed={view === k} onClick={() => pickView(k)}>{l}</button>
          ))}
        </div>
        <span className="plan-spacer" />
        <div className="cm-tabs" role="group" aria-label="Экран">
          <button className={`cm-tab ${tab === 'plan' ? 'active' : ''}`} aria-pressed={tab === 'plan'} onClick={() => setTab('plan')}>План месяца</button>
          <button className={`cm-tab ${tab === 'stats' ? 'active' : ''}`} aria-pressed={tab === 'stats'} onClick={() => setTab('stats')}>Статистика по месяцам</button>
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
  const [undo, setUndo] = useState<{ text: string; run: () => void } | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<{ k: SortKey; desc: boolean }>({ k: 'planRub', desc: true });
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const [showArchive, setShowArchive] = useState(false);
  const [reopening, setReopening] = useState(false);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const my = ++seq.current;
    try {
      const r = await apiGet<PlanResponse>(`/api/plan?view=${view}&month=${month}`);
      if (my === seq.current) { setData(r.data); setErr(''); }
    } catch (e) { if (my === seq.current) setErr(errText(e)); }
  }, [view, month]);
  useEffect(() => { setData(null); setUndo(null); void load(); }, [load]);
  useEffect(() => { const t = setInterval(load, 300_000); return () => clearInterval(t); }, [load]);

  const post: PostFn = async (path, body) => {
    try {
      const r = await apiPost<any>(`/api/plan/${path}`, { month, mp: view, ...body });
      setMsg(''); await load();
      return r.data ?? {};
    } catch (e) { setMsg(`Не сохранилось: ${errText(e)}`); return null; }
  };

  const archive = async (mp: PlanMp, article: string, qty: number) => {
    if (await post('archive', { mp, article })) {
      setUndo({
        text: `${article} убран в архив${qty > 0 ? `, план ${n0(qty)} шт снят` : ''}.`,
        run: () => { void (async () => { setUndo(null); if (await post('unarchive', { mp, article }) && qty > 0) await post('line', { mp, article, qty }); })(); },
      });
    }
  };

  // Пока вводят числа, строки не прыгают: порядок меняется только при смене сортировки или фильтра.
  const order = useRef<{ key: string; list: string[] }>({ key: '', list: [] });
  const rows = useMemo(() => {
    if (!data) return [];
    const q = query.trim().toLowerCase();
    const dir = sort.desc ? -1 : 1;
    const list = data.rows.filter(r => (!q || `${r.article} ${r.name}`.toLowerCase().includes(q)) && inFilter(r, filter)).sort((a, b) => {
      if (sort.k === 'article') return a.article.localeCompare(b.article) * dir;
      const x = a[sort.k], y = b[sort.k];
      if (x === null && y === null) return 0;
      if (x === null) return 1;
      if (y === null) return -1;
      return ((x as number) - (y as number)) * dir;
    });
    const key = `${view}|${month}|${filter}|${q}|${sort.k}|${sort.desc}`;
    if (order.current.key === key) {
      const pos = new Map(order.current.list.map((a, i) => [a, i]));
      list.sort((a, b) => (pos.get(a.article) ?? -1) - (pos.get(b.article) ?? -1));
    }
    order.current = { key, list: list.map(r => r.article) };
    return list;
  }, [data, filter, query, sort, view, month]);

  if (err && !data) return <div className="cm-card cm-bad">Не удалось загрузить план: {err}</div>;

  const months = data?.months ?? [month];
  const cur = moscowMonth();
  const options = [...new Set([...months, month])].sort().reverse();
  const t = data?.totals;
  const mpEdit = view !== 'all';
  const approved = data?.state === 'approved';
  const archived = data?.archived ?? [];
  const count = (f: Filter) => data?.rows.filter(r => inFilter(r, f)).length ?? 0;
  const sortBtn = (k: SortKey, label: string, title?: string) => (
    <button title={title} onClick={() => setSort(s => ({ k, desc: s.k === k ? !s.desc : k !== 'article' }))}>{label}{sort.k === k ? (sort.desc ? ' ↓' : ' ↑') : ''}</button>
  );

  return (
    <>
      <div className="plan-bar">
        <div className="plan-month">
          <button className="btn btn-sm" onClick={() => setMonth(shiftMonth(month, -1))} aria-label="Предыдущий месяц"><CaretLeftIcon size={18} /></button>
          <select className="input" value={month} onChange={e => setMonth(e.target.value)} aria-label="Месяц">
            {options.map(m => <option key={m} value={m}>{monthName(m)}</option>)}
          </select>
          <button className="btn btn-sm" onClick={() => setMonth(shiftMonth(month, 1))} disabled={month >= shiftMonth(cur, 1)} aria-label="Следующий месяц"><CaretRightIcon size={18} /></button>
        </div>
        {data && mpEdit && (
          <span className={`plan-state ${approved ? 'ok' : ''}`}>
            {approved ? <><CheckCircleIcon size={20} weight="fill" /> Утверждён{data.approvedBy ? `: ${data.approvedBy}` : ''}</> : 'Черновик'}
          </span>
        )}
        {data && !mpEdit && <span className="muted">Правка плана — на листе площадки</span>}
        <span className="plan-spacer" />
        {data && mpEdit && !approved && data.period !== 'past' && (
          <label className="plan-basis" title="Количество × средний чек = план в рублях. При утверждении цена фиксируется. Если сменить срок, чек всех строк считается заново">Средний чек за
            <select className="input" value={data.basis} disabled={!data.canEdit} onChange={e => post('basis', { basis: e.target.value })}>
              <option value="7d">7 дней</option>
              <option value="30d">30 дней</option>
            </select>
          </label>
        )}
        {data?.canEdit && !approved && <button className="btn" onClick={() => setAdding(a => !a)}><PlusIcon size={17} /> Товар или новинка</button>}
        {data?.canEdit && !approved && <button className="btn" onClick={() => post('copy', {})} title="Перенести количества прошлого месяца в пустые строки"><CopyIcon size={17} /> Из прошлого месяца</button>}
        {data?.canApprove && !approved && <button className="btn btn-primary" onClick={() => post('approve', {})}>Утвердить план</button>}
        {data?.canApprove && approved && <button className="btn" onClick={() => setReopening(true)}>Открыть для правок</button>}
        {mpEdit && <button className="btn" onClick={() => setLogOpen(o => !o)}>История правок</button>}
      </div>
      {reopening && (
        <ConfirmDialog title="Открыть план для правок?" action="Открыть для правок"
          keep={['Все количества и цены плана', 'Зафиксированный средний чек', 'Копия утверждённого плана, её можно вернуть из «Истории правок»']}
          change={['Менеджеры снова смогут менять числа', 'В РНП появится пометка «план ещё не утверждён»', 'План нужно будет утвердить заново']}
          tick={`Понимаю, что план ${view === 'wb' ? 'WB' : 'Ozon'} на ${monthName(month)} снова станет редактируемым`}
          onNo={() => setReopening(false)} onYes={() => { setReopening(false); void post('unapprove', {}); }} />
      )}
      {msg && <div className="plan-alert" role="alert">{msg}</div>}
      {undo && <div className="plan-ok">{undo.text} <button className="btn btn-sm" onClick={undo.run}>Отменить</button></div>}
      {!data && <div className="cm-card muted">Загружаю план…</div>}
      {data?.finance.error && <div className="plan-warn">Отчёт финансиста сейчас не прочитался: {data.finance.error}. Показана последняя загруженная маржа.</div>}

      {data && t && (
        <>
          <div className="plan-money">
            <div className="plan-kpi main">
              <span className="l">План выручки в заказах, {monthName(month)}{view === 'all' ? ', WB + Ozon' : ''}</span>
              <b>{rub(t.planRub)}</b>
              <span className="s">{n0(t.qty)} шт</span>
            </div>
            <Kpi label="Факт выручки в заказах" main={rub(t.factRub)} sub={`${n0(t.fact)} шт`} note={t.factOutOfPlan > 0 ? `из них вне плана ${n0(t.factOutOfPlan)} шт` : undefined} />
            <Kpi label="Выполнение в рублях" main={pct(t.pctRub)} sub={`в штуках ${pct(t.pct)}`} tone={pctClass(t.pct, t.expected, t.qty)}
              note={data.period === 'current' && t.expected !== null ? `по графику к вчера: ${n0(t.expected)} шт` : undefined} />
          </div>
          <div className="plan-kpis">
            {data.period !== 'past' && <Kpi label="Нужно в день" main={t.needPerDay === null ? '–' : `${n1(t.needPerDay)} шт`} sub={t.needRubPerDay === null ? '' : rub(t.needRubPerDay)}
              note={t.needPerDay === null ? undefined : `осталось дней: ${data.daysLeft}; сумма по артикулам ${n1(t.needSumByArticle)} шт`}
              title="(план − заказы по вчера) ÷ дней до конца месяца, включая сегодня. Излишек одного товара не закрывает недобор другого, поэтому сумма по артикулам больше" />}
            {data.period === 'current' && <Kpi label="Темп за 7 дней, в день" main={t.pace7 === null ? '–' : `${n1(t.pace7)} шт`} tone={t.needPerDay !== null && t.pace7 !== null && t.pace7 < t.needPerDay ? 'bad' : 'good'}
              sub={t.forecast === null ? '' : `прогноз: ${n0(t.forecast)} шт`} note={t.forecastRub === null ? undefined : `≈ ${rub(t.forecastRub)}`} />}
            <Kpi label="Реклама" main={rub(t.ads)} sub={`${pct(t.drr)} от заказов`} />
            <Kpi label="Маржа, финансист" main={pct(t.marginPct)}
              sub={t.marginRub === null ? '' : rub(t.marginRub)}
              note={data.finance.approxTo ? `примерно по ${ddmm(data.finance.approxTo)}` : data.finance.month ? shortMonth(data.finance.month) : 'отчёта ещё нет'}
              title="Как в отчёте финансиста: маржа с налогом в рублях ÷ выручка, по всему кабинету за месяц. Обновляется, когда финансист заполняет отчёт" />
          </div>
        </>
      )}

      {data && adding && mpEdit && <AddPanel data={data} onClose={() => setAdding(false)} onSave={async b => { if (await post('line', b)) setAdding(false); }} />}
      {data && logOpen && mpEdit && <LogPanel mp={view as PlanMp} month={month} canRestore={data.canApprove} onRestore={id => post('restore', { id })} stamp={`${data.state}|${data.approvedAt ?? ''}`} />}

      {data && (
        <>
          <div className="cm-filter">
            <input className="input" type="search" placeholder="Артикул или название" value={query} onChange={e => setQuery(e.target.value)} />
            {FILTERS.map(([k, l]) => (
              <button key={k} className={`cm-chip ${filter === k ? 'active' : ''}`} aria-pressed={filter === k} onClick={() => setFilter(k)}>{l}{k !== 'all' && count(k) ? ` · ${count(k)}` : ''}</button>
            ))}
            <button className={`cm-chip ${showArchive ? 'active' : ''}`} aria-pressed={showArchive} onClick={() => setShowArchive(s => !s)}><ArchiveIcon size={17} /> Архив · {archived.length}</button>
            <span className="plan-count">{rows.length} из {data.rows.length}</span>
          </div>
          {showArchive && <ArchivePanel list={archived} canEdit={data.canEdit} onBack={a => post('unarchive', { mp: a.mp, article: a.article })} />}
          {!rows.length && <div className="cm-card muted">{data.rows.length ? 'Ничего не нашлось.' : 'Строк пока нет. Добавьте товар или перенесите план из прошлого месяца.'}</div>}
          {rows.length > 0 && t && (
            <div className="cm-scroll">
              <table className="cm-table cm-list plan-table">
                <thead>
                  <tr>
                    <th className="l stick">{sortBtn('article', 'Товар')}</th>
                    <th title="FBO на этой площадке, FBS на всех своих складах (общие для WB и Ozon) и товар в пути">Остаток</th>
                    <th>{sortBtn('pace7', 'Темп 7 дн', 'Заказов в день за последние 7 полных дней')}</th>
                    <th title="Заказы по вчера + темп за 7 дней × оставшиеся дни">{sortBtn('forecast', 'Прогноз')}</th>
                    <th>{sortBtn('qty', 'План, шт')}</th>
                    <th>{sortBtn('fact', 'Факт, шт')}</th>
                    <th title="Чек, на который умножается количество плана. Чек по факту — в подробностях товара">Чек плана</th>
                    <th>{sortBtn('planRub', 'План, ₽')}</th>
                    <th>{sortBtn('factRub', 'Факт, ₽')}</th>
                    <th className="l" title="Чёрная риска: сколько должно быть к вчерашнему дню при ровных продажах">{sortBtn('pct', 'Выполнение')}</th>
                    <th>{sortBtn('drr', 'Реклама', 'Расход на рекламу ÷ заказы в рублях')}</th>
                    <th>{sortBtn('marginPct', 'Маржа', 'Из отчёта финансиста: маржа ÷ выручка товара, последний месяц с продажами')}</th>
                    <th className="l">Статус</th>
                    <th aria-label="Действия" />
                  </tr>
                </thead>
                <tbody key={`${view}|${month}`}>
                  <tr className="cm-row plan-total">
                    <td className="l stick">Итого, все товары</td>
                    <td />
                    <td>{t.pace7 === null ? '–' : n1(t.pace7)}</td>
                    <td>{t.forecast === null ? '–' : n0(t.forecast)}</td>
                    <td>{n0(t.qty)}</td>
                    <td>{n0(t.fact)}</td>
                    <td>{t.qty > 0 ? rub(t.planRub / t.qty) : '–'}</td>
                    <td>{rub(t.planRub)}</td>
                    <td>{rub(t.factRub)}</td>
                    <td className="l"><Progress p={t.pct} tone={pctClass(t.pct, t.expected, t.qty)} expected={t.expected} qty={t.qty} showMark={data.period === 'current'} outside={false} /></td>
                    <td>{pct1(t.drr)}</td>
                    <td>{pct1(t.marginPct)}</td>
                    <td />
                    <td />
                  </tr>
                  {rows.map(r => (
                    <PlanLine key={r.article} r={r} data={data} open={open.has(r.article)}
                      onToggle={() => setOpen(s => { const n = new Set(s); if (n.has(r.article)) n.delete(r.article); else n.add(r.article); return n; })}
                      post={post} onArchive={mpEdit ? () => archive(r.mp as PlanMp, r.article, r.qty) : null} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {view === 'ozon' && <p className="cm-note">Заказы Ozon в рублях — по цене продавца, как в «Заказано на сумму» Ozon. Покупатель платит меньше.</p>}
        </>
      )}
    </>
  );
}

function ArchivePanel({ list, canEdit, onBack }: { list: PlanArchived[]; canEdit: boolean; onBack: (a: PlanArchived) => void }) {
  const fact = list.reduce((s, a) => s + a.fact, 0);
  return (
    <div className="cm-card">
      {!list.length ? <span className="muted">В архиве этого месяца пусто. Убрать товар можно кнопкой с коробкой в конце его строки.</span> : (
        <div className="cm-scroll">
          <table className="cm-table wide">
            <thead><tr><th className="l">Товар</th><th>Площадка</th><th>Факт, шт</th><th>Факт, ₽</th><th>Остаток</th><th aria-label="Действия" /></tr></thead>
            <tbody>
              {list.map(a => (
                <tr key={`${a.mp}:${a.article}`}>
                  <td className="l"><div className="cm-prod">{a.photo ? <img src={a.photo} alt="" loading="lazy" /> : <span className="ph" />}<div className="t"><b>{a.article}</b>{a.name && <div className="nm">{a.name}</div>}</div></div></td>
                  <td>{a.mp === 'wb' ? 'WB' : 'Ozon'}</td>
                  <td>{n0(a.fact)}</td><td>{rub(a.factRub)}</td><td>{n0(a.stock)}</td>
                  <td>{canEdit && <button className="cm-mark" onClick={() => onBack(a)}>Вернуть</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="cm-note">Товар скрыт начиная с этого месяца, прошлые месяцы не меняются. Заказы архивных товаров не входят в выполнение плана и в статистику этих месяцев{fact > 0 ? `: сейчас это ${n0(fact)} шт` : ''}.</p>
    </div>
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

const parseNum = (s: string) => Math.max(0, Math.round(Number(s.replace(',', '.')) || 0));

/** Ячейка с числом: сохраняет сама через секунду после ввода и показывает, чем кончилось. */
function NumInput({ value, disabled, onSave, label, width = 96 }: { value: number; disabled: boolean; onSave: (v: number) => Promise<boolean>; label: string; width?: number }) {
  const [v, setV] = useState(String(value || ''));
  const [st, setSt] = useState<'idle' | 'busy' | 'ok' | 'err'>('idle');
  const focused = useRef(false);
  const live = useRef({ v, saved: value, onSave, timer: 0 as number | undefined, busy: false });
  live.current.v = v;
  live.current.onSave = onSave;

  const commit = useCallback(async () => {
    const c = live.current;
    window.clearTimeout(c.timer); c.timer = undefined;
    if (c.busy) return;
    const n = parseNum(c.v);
    if (n === c.saved) { setSt(s => (s === 'err' ? 'idle' : s)); return; }
    c.busy = true; setSt('busy');
    const ok = await c.onSave(n);
    c.busy = false;
    if (ok) c.saved = n;
    setSt(ok ? 'ok' : 'err');
    if (ok && parseNum(c.v) !== n) void commit(); // пока сохранялось, ввели другое число
  }, []);

  useEffect(() => {
    const c = live.current;
    if (c.timer !== undefined || c.busy) return;
    c.saved = value;
    if (!focused.current) { setV(String(value || '')); setSt(s => (s === 'err' ? 'idle' : s)); }
  }, [value]);
  // Ушли со страницы месяца или отфильтровали строку, а таймер ещё шёл: дописываем сразу.
  useEffect(() => () => { if (live.current.timer !== undefined) void commit(); }, [commit]);

  const unsaved = st === 'busy' || st === 'err' || parseNum(v) !== live.current.saved;
  useEffect(() => {
    if (!unsaved) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [unsaved]);

  const change = (text: string) => {
    setV(text); setSt('idle');
    window.clearTimeout(live.current.timer);
    live.current.timer = window.setTimeout(() => { void commit(); }, 1000);
  };
  return (
    <span className="plan-cell" onClick={e => e.stopPropagation()}>
      <span className={`plan-mark ${st === 'err' ? 'bad' : ''}`}>
        {st === 'ok' && <span title="Сохранено"><CheckIcon size={18} weight="bold" aria-label="Сохранено" /></span>}
        {st === 'err' && <button className="plan-exp cm-bad" title="Не сохранилось. Нажмите, чтобы повторить" aria-label="Не сохранилось, повторить" onClick={() => void commit()}><ArrowClockwiseIcon size={18} weight="bold" /></button>}
      </span>
      <input className={`plan-num ${st === 'err' ? 'err' : ''} ${st === 'busy' ? 'busy' : ''}`} style={{ width }} inputMode="numeric" value={v} disabled={disabled} aria-label={label} placeholder="0"
        onFocus={() => { focused.current = true; }}
        onChange={e => change(e.target.value.replace(/[^\d.,]/g, ''))}
        onBlur={() => { focused.current = false; void commit(); }}
        onKeyDown={e => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') { window.clearTimeout(live.current.timer); live.current.timer = undefined; setV(String(live.current.saved || '')); setSt('idle'); }
        }} />
    </span>
  );
}

function Progress({ p, tone, expected, qty, showMark, outside }: { p: number | null; tone: string; expected: number | null; qty: number; showMark: boolean; outside: boolean }) {
  return (
    <div className="p-prog">
      <b className={tone}>{p === null ? (outside ? 'вне плана' : '–') : pct1(p)}</b>
      <div className="plan-prog"><i className={tone} style={{ width: `${p === null ? 0 : Math.min(100, p)}%` }} />
        {showMark && expected !== null && qty > 0 && <u style={{ left: `${Math.min(100, expected / qty * 100)}%` }} title={`По графику к вчера: ${n0(expected)} шт`} />}
      </div>
    </div>
  );
}

function PlanLine({ r, data, open, onToggle, post, onArchive }: { r: PlanRow; data: PlanResponse; open: boolean; onToggle: () => void; post: PostFn; onArchive: (() => void) | null }) {
  const can = data.canEdit;
  // Утверждённый план не правится случайно, даже владельцем: сначала «Открыть для правок».
  const canNumbers = can && data.state !== 'approved';
  const priceEditable = canNumbers && (r.isNew || r.priceSource === 'none' || r.priceSource === 'manual');
  const preSale = r.isNew && !r.inSale;
  // Галочка ставится, только если сервер вернул именно то число, что ввели.
  const saveQty = async (qty: number) => (await post('line', { article: r.article, qty }))?.saved?.qty === qty;
  const savePrice = async (price: number) => (await post('line', { article: r.article, price }))?.saved?.price === price;
  const rowCls = `cm-row ${open ? 'p-open' : ''} ${r.qty <= 0 && r.fact > 0 ? 'outside' : ''} ${r.archived ? 'is-archived' : ''}`;
  return (
    <Fragment>
      <tr className={rowCls} onClick={onToggle} aria-expanded={open}>
        <td className="l stick">
          <div className="cm-prod">
            {r.photo ? <img src={r.photo} alt="" loading="lazy" /> : <span className="ph" />}
            <div className="t">
              <b title={r.name || r.article}>{r.article}</b>{r.link && <a href={r.link} target="_blank" rel="noreferrer" title="Открыть на площадке" onClick={e => e.stopPropagation()}><ArrowSquareOutIcon size={16} /></a>}
              {r.name && <div className="nm" title={r.name}>{r.name}</div>}
              {r.archived && <div className="cm-sub cm-warn">в архиве, до конца месяца в плане</div>}
            </div>
          </div>
        </td>
        <td>
          <div className="p-stock">
            {r.stock === null ? '–' : <span>FBO <b>{n0(r.stockFbo)}</b> · FBS <b>{n0(r.stockFbs)}</b></span>}
            {!!r.transit && <span className="go">едет {n0(r.transit)}</span>}
            {r.stockShort && <span className="short" title={r.stockShortShared ? 'Свои склады общие для площадок: вместе с планом другой площадки товара не хватит' : 'Оставшийся план больше остатка и товара в пути'}>{r.stockShortShared ? `не хватит с учётом ${data.view === 'wb' ? 'Ozon' : data.view === 'ozon' ? 'WB' : 'обеих площадок'}` : 'не хватит'}</span>}
          </div>
        </td>
        <td className="pq">{r.pace7 === null ? '–' : n1(r.pace7)}</td>
        <td className="pq">{r.forecast === null ? '–' : n0(r.forecast)}</td>
        <td className="pq" onClick={r.mp === 'all' ? undefined : e => e.stopPropagation()}>
          {r.mp === 'all'
            ? <>{n0(r.qty)}{(r.wb || r.ozon) && <div className="cm-sub">WB {n0(r.wb?.qty ?? 0)} · Ozon {n0(r.ozon?.qty ?? 0)}</div>}</>
            : <NumInput value={r.qty} disabled={!canNumbers} label={`План ${r.article}`} onSave={saveQty} />}
        </td>
        <td className="pm">{n0(r.fact)}{r.mp === 'all' && (r.wb || r.ozon) && <div className="cm-sub">WB {n0(r.wb?.fact ?? 0)} · Ozon {n0(r.ozon?.fact ?? 0)}</div>}</td>
        <td className="pq" title={SOURCE[r.priceSource]} onClick={priceEditable ? e => e.stopPropagation() : undefined}>
          {priceEditable
            ? <NumInput value={r.price} disabled={false} width={116} label={`Цена ${r.article}`} onSave={savePrice} />
            : <span className={r.price <= 0 ? 'bad' : ''}>{r.price > 0 ? rub(r.price) : 'нет цены'}</span>}
        </td>
        <td className="pq">{r.planRub > 0 ? rub(r.planRub) : '–'}</td>
        <td className="pm">{rub(r.factRub)}</td>
        <td className="l"><Progress p={r.pct} tone={rowTone(r, data)} expected={r.expected} qty={r.qty} showMark={data.period === 'current'} outside={r.fact > 0} /></td>
        <td className="pq">{pct1(r.drr)}</td>
        <td className={`pq ${r.marginPct !== null && r.marginPct < 0 ? 'bad' : r.marginPct !== null && r.marginPct < 15 ? 'warn' : ''}`} title={r.marginMonth ? `Отчёт финансиста, ${shortMonth(r.marginMonth)}` : undefined}>{pct1(r.marginPct)}</td>
        <td className="l" onClick={e => e.stopPropagation()}>
          {can && !r.isNew
            ? <select className="plan-st" value={r.status} aria-label="Статус товара" onChange={e => post('line', { article: r.article, status: e.target.value })}>
                <option>Рабочий</option><option>Вывод</option><option>Новинка</option>
              </select>
            : <span className="plan-st">{r.status}</span>}
          {preSale && <div className="cm-sub">{r.startDate ? `старт ${ddmm(r.startDate)}` : 'ещё не в продаже'}</div>}
        </td>
        <td>
          <span className="plan-acts">
            {can && onArchive && !r.archived && <button className="cm-mark" title="Убрать в архив" aria-label={`Убрать в архив: ${r.article}`} onClick={e => { e.stopPropagation(); onArchive(); }}><ArchiveIcon size={18} /></button>}
            <button className="plan-exp" aria-expanded={open} aria-label={`Подробнее: ${r.article}`}>{open ? <CaretDownIcon size={20} /> : <CaretRightIcon size={20} />}</button>
          </span>
        </td>
      </tr>
      {open && <tr className="plan-detail"><td colSpan={14}><Detail r={r} data={data} post={post} /></td></tr>}
    </Fragment>
  );
}

function Detail({ r, data, post }: { r: PlanRow; data: PlanResponse; post: PostFn }) {
  const [to, setTo] = useState('');
  let cum = 0;
  const can = data.canEdit;
  const canNumbers = can && data.state !== 'approved';
  const days = r.daily.filter(d => d.date <= data.today).map(d => { cum += d.cnt; return { ...d, cum }; }).reverse();
  return (
    <div className="plan-det">
      <div className="plan-det-side">
        <dl className="plan-facts">
          {r.needPerDay !== null && <><dt>Нужно в день</dt><dd className={r.behind ? 'bad' : ''}>{n0(r.needPerDay)} шт</dd></>}
          <dt>Чек по факту</dt><dd>{r.fact > 0 ? rub(r.factRub / r.fact) : '–'}</dd>
          <dt>Выполнение в рублях</dt><dd>{pct1(r.pctRub)}</dd>
          <dt>Реклама</dt><dd>{rub(r.ads)}</dd>
          <dt>Откуда чек плана</dt><dd>{SOURCE[r.priceSource]}</dd>
          {r.prevFact !== null && <><dt>Заказов в прошлом месяце</dt><dd>{n0(r.prevFact)} шт</dd></>}
          {r.marginMonth && <><dt>Маржа за</dt><dd>{shortMonth(r.marginMonth)}</dd></>}
        </dl>
        {r.isNew && canNumbers && (
          <>
            <label>Плановая цена, ₽ <NumInput value={r.priceSource === 'manual' ? r.price : 0} disabled={false} width={130} label="Плановая цена" onSave={async price => (await post('line', { article: r.article, price }))?.saved?.price === price} /></label>
            <label>Дата старта продаж <input type="date" className="input plan-txt" defaultValue={r.startDate ?? ''} onBlur={e => { if ((e.target.value || null) !== r.startDate) void post('line', { article: r.article, startDate: e.target.value || null }); }} /></label>
            {!r.inSale && <label>Артикул на площадке <span className="plan-inline"><input className="input plan-txt" value={to} onChange={e => setTo(e.target.value)} placeholder={r.article} /><button className="btn" disabled={!to.trim()} onClick={() => post('rename', { article: r.article, to })}>Привязать</button></span></label>}
          </>
        )}
        {can && <label>Комментарий <textarea className="input plan-txt" rows={2} defaultValue={r.comment} onBlur={e => { if (e.target.value !== r.comment) void post('line', { article: r.article, comment: e.target.value }); }} /></label>}
        {!can && r.comment && <p>{r.comment}</p>}
        {canNumbers && r.hasLine && <button className="btn" onClick={() => post('remove', { article: r.article })}><TrashIcon size={17} /> Убрать из плана</button>}
      </div>
      {days.length > 0 ? (
        <table className="cm-table">
          <thead><tr><th className="l">День</th><th>Заказы</th><th>Накоплено</th><th>% плана</th></tr></thead>
          <tbody>{days.map(d => <tr key={d.date}><td className="l">{ddmm(d.date)}</td><td>{n0(d.cnt)}</td><td><b>{n0(d.cum)}</b></td><td>{r.qty > 0 ? pct(d.cum / r.qty * 100) : '–'}</td></tr>)}</tbody>
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
    <section className="cm-card plan-add">
      <div className="cm-filter" role="group" aria-label="Что добавить">
        <button className={`cm-chip ${mode === 'new' ? 'active' : ''}`} aria-pressed={mode === 'new'} onClick={() => { setMode('new'); setArticle(''); }}>Новинка, ещё не на площадке</button>
        <button className={`cm-chip ${mode === 'catalog' ? 'active' : ''}`} aria-pressed={mode === 'catalog'} onClick={() => { setMode('catalog'); setArticle(''); }}>Товар из каталога</button>
      </div>
      {mode === 'new' ? (
        <div className="plan-add-grid">
          <label>Артикул <input className="input plan-txt" value={article} onChange={e => setArticle(e.target.value)} placeholder="можно рабочее название" /></label>
          <label>Название <input className="input plan-txt" value={name} onChange={e => setName(e.target.value)} /></label>
          <label>План, шт <input className="input plan-txt" inputMode="numeric" value={qty} onChange={e => setQty(e.target.value.replace(/\D/g, ''))} /></label>
          <label>Плановая цена, ₽ <input className="input plan-txt" inputMode="numeric" value={price} onChange={e => setPrice(e.target.value.replace(/\D/g, ''))} /></label>
          <label>Старт продаж <input className="input plan-txt" type="date" value={start} min={`${data.month}-01`} onChange={e => setStart(e.target.value)} /></label>
          {Number(qty) > 0 && Number(price) > 0 && <p className="plan-add-sum">В плане: <b>{rub(Number(qty) * Number(price))}</b></p>}
          <p className="cm-note plan-add-hint">Минимум в день считается от даты старта. Если артикул совпадёт с площадкой, заказы подхватятся сами; рабочее название потом можно привязать к настоящему артикулу.</p>
        </div>
      ) : (
        <div className="plan-add-grid">
          <label>Найти товар <input className="input plan-txt" value={q} onChange={e => setQ(e.target.value)} placeholder="артикул или название" /></label>
          <label>План, шт <input className="input plan-txt" inputMode="numeric" value={qty} onChange={e => setQty(e.target.value.replace(/\D/g, ''))} /></label>
          <div className="plan-found">
            {found.map(c => <button key={c.article} className={article === c.article ? 'on' : ''} onClick={() => setArticle(c.article)}><b>{c.article}</b> <span className="muted">{c.name}</span></button>)}
            {!found.length && <span className="muted">Все товары каталога уже в таблице.</span>}
          </div>
        </div>
      )}
      <div className="plan-add-btns">
        <button className="btn btn-primary" disabled={!ok} onClick={save}>Добавить в план</button>
        <button className="btn" onClick={onClose}>Отмена</button>
      </div>
    </section>
  );
}

function LogPanel({ mp, month, canRestore, onRestore, stamp }: { mp: PlanMp; month: string; canRestore: boolean; onRestore: (id: number) => Promise<any | null>; stamp: string }) {
  const [rows, setRows] = useState<Array<{ at: number; user: string; article: string; field: string; before: string; after: string }> | null>(null);
  const [versions, setVersions] = useState<PlanVersion[] | null>(null);
  const [back, setBack] = useState<PlanVersion | null>(null);
  useEffect(() => {
    apiGet<{ rows: any[] }>(`/api/plan/log?mp=${mp}&month=${month}`).then(r => setRows(r.data.rows)).catch(() => setRows([]));
    apiGet<{ rows: PlanVersion[] }>(`/api/plan/versions?mp=${mp}&month=${month}`).then(r => setVersions(r.data.rows)).catch(() => setVersions([]));
  }, [mp, month, stamp]);
  const when = (at: number) => new Date(at).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  return (
    <section className="cm-card plan-add">
      <span className="cm-now">Версии плана</span>
      {!versions ? <p className="muted">Загружаю…</p> : !versions.length ? <p className="muted">Копий пока нет. Первая появится при утверждении плана или при открытии его для правок.</p> : (
        <div className="plan-vers">
          {versions.map(v => (
            <div className="plan-ver" key={v.id}>
              <span><b>{when(v.at)}</b> <span className="muted">· {v.reason}{v.user ? `, ${v.user}` : ''} · {n0(v.qty)} шт · {rub(v.rub)}</span></span>
              {canRestore && <button className="btn btn-sm" onClick={() => setBack(v)}>Вернуть эту версию</button>}
            </div>
          ))}
        </div>
      )}
      {back && (
        <ConfirmDialog title="Вернуть эту версию плана?" action="Вернуть версию"
          keep={['Текущий план сохранится отдельной копией, и его тоже можно будет вернуть', 'Заказы и факт не изменятся']}
          change={[`План станет как в версии от ${when(back.at)}: ${n0(back.qty)} шт, ${rub(back.rub)}`, back.state === 'approved' ? 'План будет утверждён' : 'План будет открыт для правок']}
          tick="Понимаю, что текущие числа плана будут заменены"
          onNo={() => setBack(null)} onYes={() => { const id = back.id; setBack(null); void onRestore(id).then(() => {
            apiGet<{ rows: any[] }>(`/api/plan/log?mp=${mp}&month=${month}`).then(r => setRows(r.data.rows)).catch(() => {});
            apiGet<{ rows: PlanVersion[] }>(`/api/plan/versions?mp=${mp}&month=${month}`).then(r => setVersions(r.data.rows)).catch(() => {});
          }); }} />
      )}
      <span className="cm-now">История правок</span>
      {!rows ? <p className="muted">Загружаю…</p> : !rows.length ? <p className="muted">Правок пока нет.</p> : (
        <div className="cm-scroll">
          <table className="cm-table wide">
            <thead><tr><th className="l">Когда</th><th className="l">Кто</th><th className="l">Артикул</th><th className="l">Что</th><th>Было</th><th>Стало</th></tr></thead>
            <tbody>{rows.map((r, i) => <tr key={i}><td className="l">{new Date(r.at).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</td><td className="l">{r.user}</td><td className="l">{r.article || '–'}</td><td className="l">{r.field}</td><td>{r.before || '–'}</td><td>{r.after || '–'}</td></tr>)}</tbody>
          </table>
        </div>
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
      <form className="cm-filter" onSubmit={e => { e.preventDefault(); setApplied(article.trim()); }}>
        <input className="input" value={article} onChange={e => setArticle(e.target.value)} placeholder="Артикул целиком, пусто — все товары" />
        <button className="btn">Показать</button>
      </form>
      {err && <div className="plan-alert">{err}</div>}
      {!data && !err && <div className="cm-card muted">Считаю статистику…</div>}
      {data && (
        <div className="cm-scroll">
          <table className="cm-table cm-list wide">
            <thead><tr><th className="l stick">Месяц</th><th className="l">Статус</th><th>План, шт</th><th>Факт, шт</th><th>Выполнение</th><th>План, ₽</th><th>Факт, ₽</th><th>Выполнение, ₽</th><th>Реклама</th><th>Доля рекламы</th><th>Маржа</th><th className="l">Источник факта</th></tr></thead>
            <tbody>
              {data.rows.map(r => (
                <tr key={r.month} className="cm-row" onClick={() => onOpen(r.month)}>
                  <td className="l stick"><b>{monthName(r.month)}</b></td>
                  <td className="l">{r.state === 'approved' ? 'Утверждён' : r.state === 'draft' ? 'Черновик' : r.state === 'mixed' ? 'Частично' : 'Нет плана'}</td>
                  <td>{n0(r.qty)}</td><td><b>{n0(r.fact)}</b></td>
                  <td><b className={pctClass(r.pct, null, r.qty)}>{pct(r.pct)}</b></td>
                  <td>{rub(r.planRub)}</td><td>{rub(r.factRub)}</td><td>{pct(r.pctRub)}</td>
                  <td>{rub(r.ads)}</td><td>{pct(r.drr)}</td><td>{pct(r.marginPct)}</td>
                  <td className="l muted">{r.factSource === 'finance' ? 'отчёт финансиста' : 'API площадки'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data && <p className="cm-note">Январь–октябрь перенесены из таблицы AV План: рублёвый план там считался по последней цене товара, поэтому процент в рублях за прошлые месяцы приблизительный. С ноября цена фиксируется при утверждении. Выполнение считается по всем заказам месяца, включая товары вне плана; товары в архиве не считаются с месяца, когда их убрали.</p>}
    </>
  );
}
