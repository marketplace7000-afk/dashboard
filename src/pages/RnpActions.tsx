/**
 * «РНП действия» (12.11.2026) — календарь действий по каждой карточке WB и Ozon.
 *
 * Тот же вид, что у РНП: сверху даты, слева товар, по строке на вид действия.
 * Только вместо метрик — отметки: когда меняли главное фото, название, описание,
 * характеристики, цену, рекламу, акции, когда товар заканчивался. Внизу блока —
 * строка заказов, чтобы видеть, что было после правки.
 *
 * Щелчок по клетке открывает справа день товара: что именно изменилось (было и
 * стало) и заметки — их может оставить любой сотрудник.
 * Данные собирает сервер (api/_lib/rnpActions.ts), здесь только показ.
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowsClockwiseIcon, MagnifyingGlassIcon, CaretDownIcon, CaretRightIcon, ArrowSquareOutIcon, XIcon, NotePencilIcon, TrashIcon } from '@phosphor-icons/react';
import { apiGet, apiPost, errText } from '../api/http';
import type { RnpMp } from '../../shared/rnp';
import { ACT_KINDS, type ActEvent, type ActItem, type ActKind, type ActNote, type ActResponse } from '../../shared/rnpActions';

type Period = '14' | '30' | '60' | '90' | 'custom';
type Settings = {
  period: Period; from: string; to: string;
  inStock: boolean;
  onlyChanged: boolean;
  expandAll: boolean;
  orders: boolean;
  kinds: ActKind[];
  sort: 'orders' | 'changes';
};

const ALL_KINDS = ACT_KINDS.map(k => k.key);
const KIND = Object.fromEntries(ACT_KINDS.map(k => [k.key, k])) as Record<ActKind, typeof ACT_KINDS[number]>;
const DEFAULTS: Settings = { period: '30', from: '', to: '', inStock: true, onlyChanged: false, expandAll: false, orders: true, kinds: ALL_KINDS, sort: 'orders' };
const PAGE = 30;
const MSK_OFFSET_MS = 3 * 3_600_000;
const mskToday = () => new Date(Date.now() + MSK_OFFSET_MS).toISOString().slice(0, 10);
const addDays = (d: string, n: number) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86_400_000).toISOString().slice(0, 10);
const ddmm = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}`;
const WEEKDAY = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const weekday = (d: string) => new Date(d + 'T00:00:00Z').getUTCDay();
const nf = new Intl.NumberFormat('ru-RU');

function loadSettings(): Settings {
  try {
    const s = { ...DEFAULTS, ...JSON.parse(localStorage.getItem('rnp-actions:settings') ?? '{}') } as Settings;
    s.kinds = (s.kinds ?? ALL_KINDS).filter(k => ALL_KINDS.includes(k));
    return s;
  } catch { return DEFAULTS; }
}

function useHeight<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [h, setH] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setH(el.offsetHeight));
    ro.observe(el);
    setH(el.offsetHeight);
    return () => ro.disconnect();
  }, []);
  return [ref, h] as const;
}

type Open = { sku: string; date: string; kind?: ActKind };

// ─── Правая панель: день товара ─────────────────────────────────────────────

function Images({ json }: { json?: string }) {
  let list: string[] = [];
  try { list = JSON.parse(json ?? '[]'); } catch { list = []; }
  if (!list.length) return <span className="muted">—</span>;
  return <div className="act-imgs">{list.map(src => <a key={src} href={src} target="_blank" rel="noreferrer"><img src={src} alt="" loading="lazy" /></a>)}</div>;
}

function EventCard({ e }: { e: ActEvent }) {
  const k = KIND[e.kind];
  const hasDiff = e.before !== undefined || e.after !== undefined;
  return (
    <div className="act-ev" style={{ ['--k' as string]: k.color }}>
      <div className="act-ev-head"><span className="act-dot" /> <b>{k.label}</b></div>
      <div className="act-ev-text">{e.text}</div>
      {hasDiff && (
        <div className="act-diff">
          <div><div className="act-diff-cap">Было</div>{e.view === 'images' ? <Images json={e.before} /> : <div className="act-diff-text">{e.before || '—'}</div>}</div>
          <div><div className="act-diff-cap">Стало</div>{e.view === 'images' ? <Images json={e.after} /> : <div className="act-diff-text">{e.after || '—'}</div>}</div>
        </div>
      )}
    </div>
  );
}

function DayPanel({ mp, item, open, dates, onClose, onChanged }: { mp: RnpMp; item: ActItem; open: Open; dates: string[]; onClose: () => void; onChanged: () => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { setText(''); setErr(null); }, [open.sku, open.date]);
  const events = item.events.filter(e => e.date === open.date);
  // Сначала то, по чему щёлкнули.
  events.sort((a, b) => Number(b.kind === open.kind) - Number(a.kind === open.kind));
  const notes = item.notes.filter(n => n.date === open.date);
  const orders = item.orders[dates.indexOf(open.date)];

  const save = async () => {
    if (!text.trim()) return;
    setBusy(true);
    try {
      await apiPost('/api/rnp-actions/note', { mp, sku: item.sku, date: open.date, text });
      setText(''); setErr(null); onChanged();
    } catch (e) { setErr(errText(e)); }
    finally { setBusy(false); }
  };
  const remove = async (n: ActNote) => {
    setBusy(true);
    try { await apiPost('/api/rnp-actions/note/delete', { id: n.id }); onChanged(); }
    catch (e) { setErr(errText(e)); }
    finally { setBusy(false); }
  };

  return (
    <aside className="act-panel" role="dialog" aria-label="День товара">
      <div className="act-panel-head">
        <div>
          <div className="act-panel-date">{ddmm(open.date)}.{open.date.slice(0, 4)}, {WEEKDAY[weekday(open.date)]}</div>
          <div className="act-panel-item">{item.article}</div>
          <div className="muted act-panel-name">{item.name}</div>
        </div>
        <button className="btn btn-sm" onClick={onClose} aria-label="Закрыть"><XIcon size={15} /></button>
      </div>
      <div className="act-panel-body">
        <div className="muted">Заказы за день: {orders == null ? 'нет данных' : `${nf.format(orders)} шт`}</div>
        {events.length ? events.map((e, i) => <EventCard key={i} e={e} />) : <div className="act-empty">В этот день изменений не замечено.</div>}

        <div className="act-notes">
          <div className="act-notes-cap"><NotePencilIcon size={16} /> Заметки</div>
          {notes.map(n => (
            <div key={n.id} className="act-note">
              <div className="act-note-text">{n.text}</div>
              <div className="act-note-meta">
                <span className="muted">{n.author} · {new Date(n.at).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
                <button className="btn btn-sm" onClick={() => remove(n)} disabled={busy} title="Убрать заметку"><TrashIcon size={13} /></button>
              </div>
            </div>
          ))}
          <textarea className="input act-note-input" rows={3} placeholder="Что сделали в этот день: раздача блогеру, новая упаковка, самовыкупы…" value={text} onChange={e => setText(e.target.value)} maxLength={1000} />
          {err && <div className="rnp-alert">{err}</div>}
          <button className="btn btn-primary" onClick={save} disabled={busy || !text.trim()}>Сохранить заметку</button>
        </div>
      </div>
    </aside>
  );
}

// ─── Таблица ────────────────────────────────────────────────────────────────

type Row = { item: ActItem; byDay: Map<string, ActEvent[]>; notesByDay: Map<string, number>; changes: number; ordersSum: number; ordersMax: number };

function ItemBlock({ row, dates, kinds, expanded, showOrders, open, onToggle, onOpen }: {
  row: Row; dates: string[]; kinds: ActKind[]; expanded: boolean; showOrders: boolean; open: Open | null;
  onToggle: () => void; onOpen: (o: Open) => void;
}) {
  const { item } = row;
  const lines: Array<{ key: string; label: string; hint?: string }> = expanded
    ? [...kinds.map(k => ({ key: k, label: KIND[k].label, hint: KIND[k].hint })), { key: 'notes', label: 'Заметки' }]
    : [{ key: 'all', label: 'Все действия', hint: 'Каждая точка — действие своего цвета. Чем больше действий в день, тем темнее клетка. Щёлкните по товару, чтобы развернуть по видам' }];
  if (showOrders) lines.push({ key: 'orders', label: 'Заказы, шт' });
  const isOpen = (d: string) => open?.sku === item.sku && open.date === d;

  return (
    <>
      {lines.map((ln, li) => (
        <tr key={ln.key} className={`${li === 0 ? 'rnp-first' : ''} ${ln.key === 'orders' ? 'act-row-orders' : ''}`}>
          {li === 0 && (
            <td className="rnp-sticky rnp-col-item act-col-item" rowSpan={lines.length}>
              <div className="rnp-item">
                <button className="act-caret" onClick={onToggle} title={expanded ? 'Свернуть' : 'Развернуть по видам действий'}>
                  {expanded ? <CaretDownIcon size={15} /> : <CaretRightIcon size={15} />}
                </button>
                {item.photo ? <img src={item.photo} alt="" loading="lazy" className="rnp-photo" /> : <span className="rnp-photo rnp-photo-empty" />}
                <div className="rnp-item-text">
                  <div className="rnp-item-title" title={item.article}>
                    <span>{item.article}</span>
                    {item.link && <a href={item.link} target="_blank" rel="noreferrer" title="Открыть на площадке" className="rnp-ext"><ArrowSquareOutIcon size={12} /></a>}
                  </div>
                  <div className="rnp-item-sub" title={item.name}>{item.name}</div>
                  <div className="rnp-item-cat">{row.changes ? `действий за период: ${row.changes}` : 'без изменений за период'}{!item.inStock ? ' · нет в наличии' : ''}</div>
                </div>
              </div>
            </td>
          )}
          <td className="rnp-sticky rnp-col-metric act-col-kind" title={ln.hint}>
            {ln.key !== 'all' && ln.key !== 'orders' && ln.key !== 'notes' && <span className="act-dot" style={{ ['--k' as string]: KIND[ln.key as ActKind].color }} />}
            {ln.label}
          </td>
          {dates.map((d, di) => {
            const wk = weekday(d);
            const base = `act-cell ${wk === 0 || wk === 6 ? 'act-we' : ''} ${isOpen(d) ? 'act-open' : ''}`;
            if (ln.key === 'orders') {
              const v = item.orders[di];
              const heat = v && row.ordersMax ? Math.min(1, v / row.ordersMax) : 0;
              return <td key={d} className={`${base} act-num`} style={heat ? { backgroundColor: `rgba(37,99,235,${(0.05 + heat * 0.2).toFixed(3)})` } : undefined} onClick={() => onOpen({ sku: item.sku, date: d })}>{v == null ? '' : nf.format(v)}</td>;
            }
            const evs = (row.byDay.get(d) ?? []).filter(e => kinds.includes(e.kind));
            const noteN = row.notesByDay.get(d) ?? 0;
            if (ln.key === 'notes') {
              return <td key={d} className={base} onClick={() => onOpen({ sku: item.sku, date: d })} title={noteN ? `Заметок: ${noteN}` : 'Добавить заметку'}>{noteN ? <span className="act-notemark"><NotePencilIcon size={15} weight="fill" /></span> : null}</td>;
            }
            if (ln.key === 'all') {
              const n = evs.length;
              const kindsHere = [...new Set(evs.map(e => e.kind))];
              return (
                <td key={d} className={`${base} ${n ? `act-heat${Math.min(3, n)}` : ''}`} onClick={() => onOpen({ sku: item.sku, date: d })}
                  title={[...evs.map(e => `${KIND[e.kind].label}: ${e.text}`), noteN ? `Заметок: ${noteN}` : ''].filter(Boolean).join('\n') || undefined}>
                  <span className="act-dots">
                    {kindsHere.map(k => <span key={k} className="act-dot" style={{ ['--k' as string]: KIND[k].color }} />)}
                    {noteN ? <span className="act-notemark"><NotePencilIcon size={13} weight="fill" /></span> : null}
                  </span>
                </td>
              );
            }
            const k = ln.key as ActKind;
            const mine = evs.filter(e => e.kind === k);
            const adsBg = k === 'ads' && item.adsOn[di] ? 'act-adson' : '';
            return (
              <td key={d} className={`${base} ${adsBg}`} onClick={() => onOpen({ sku: item.sku, date: d, kind: k })} title={mine.map(e => e.text).join('\n') || (adsBg ? 'Реклама шла' : undefined)}>
                {mine.length ? <span className="act-mark" style={{ ['--k' as string]: KIND[k].color }}>{mine.length > 1 ? mine.length : ''}</span> : null}
              </td>
            );
          })}
          <td className="act-total">
            {ln.key === 'orders' ? nf.format(row.ordersSum)
              : ln.key === 'notes' ? (item.notes.length || '')
              : ln.key === 'all' ? (row.changes || '')
              : (item.events.filter(e => e.kind === ln.key).length || '')}
          </td>
        </tr>
      ))}
    </>
  );
}

function Board({ mp }: { mp: RnpMp }) {
  const [s, setS] = useState<Settings>(loadSettings);
  const set = (p: Partial<Settings>) => setS(prev => {
    const next = { ...prev, ...p };
    try { localStorage.setItem('rnp-actions:settings', JSON.stringify(next)); } catch { /* не критично */ }
    return next;
  });
  const [data, setData] = useState<(ActResponse & { collecting?: boolean }) | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [shown, setShown] = useState(PAGE);
  const [toggled, setToggled] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<Open | null>(null);
  const [filtersRef, filtersH] = useHeight<HTMLElement>();

  const to = s.period === 'custom' && s.to ? s.to : mskToday();
  const from = s.period === 'custom' && s.from ? s.from : addDays(to, -(Number(s.period === 'custom' ? 30 : s.period) - 1));

  const seq = useRef(0);
  const load = useCallback(async () => {
    const my = ++seq.current;
    setLoading(true);
    try {
      const r = await apiGet<ActResponse & { collecting?: boolean }>(`/api/rnp-actions?mp=${mp}&from=${from}&to=${to}`);
      if (my === seq.current) { setData(r.data); setErr(null); }
    } catch (e) { if (my === seq.current) setErr(errText(e)); }
    finally { if (my === seq.current) setLoading(false); }
  }, [mp, from, to]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const t = setInterval(load, data?.collecting ? 20_000 : 300_000);
    return () => clearInterval(t);
  }, [load, data?.collecting]);

  const checkNow = async () => {
    try { await apiPost('/api/rnp-actions/check'); setData(d => (d ? { ...d, collecting: true } : d)); }
    catch (e) { setErr(errText(e)); }
  };

  const kinds = useMemo(() => ALL_KINDS.filter(k => s.kinds.includes(k)), [s.kinds]);
  const rows = useMemo<Row[]>(() => {
    if (!data) return [];
    const q = search.trim().toLowerCase();
    const out: Row[] = [];
    for (const item of data.items) {
      if (s.inStock && !item.inStock) continue;
      if (q && !`${item.article} ${item.name} ${item.sku}`.toLowerCase().includes(q)) continue;
      const byDay = new Map<string, ActEvent[]>();
      let changes = 0;
      for (const e of item.events) {
        if (!kinds.includes(e.kind)) continue;
        changes++;
        byDay.set(e.date, [...(byDay.get(e.date) ?? []), e]);
      }
      const notesByDay = new Map<string, number>();
      for (const n of item.notes) notesByDay.set(n.date, (notesByDay.get(n.date) ?? 0) + 1);
      if (s.onlyChanged && !changes && !item.notes.length) continue;
      const nums = item.orders.map(v => v ?? 0);
      out.push({ item, byDay, notesByDay, changes, ordersSum: nums.reduce((a, b) => a + b, 0), ordersMax: Math.max(0, ...nums) });
    }
    out.sort((a, b) => (s.sort === 'changes' ? b.changes - a.changes : 0) || b.ordersSum - a.ordersSum || a.item.article.localeCompare(b.item.article));
    return out;
  }, [data, search, s.inStock, s.onlyChanged, s.sort, kinds]);

  const totalChanges = rows.reduce((a, r) => a + r.changes, 0);
  const openItem = open ? data?.items.find(i => i.sku === open.sku) : null;
  const dates = data?.dates ?? [];

  return (
    <div className="rnp act" style={{ ['--rnp-filters-h' as string]: `${filtersH}px` }}>
      <section className="card rnp-filters rnp-quick" ref={filtersRef}>
        <div className="rnp-frow">
          <div className="period-switch" role="group" aria-label="Период">
            {(['14', '30', '60', '90'] as const).map(p => (
              <button key={p} className={`period-btn ${s.period === p ? 'active' : ''}`} onClick={() => set({ period: p })}>{p} дн</button>
            ))}
            <button className={`period-btn ${s.period === 'custom' ? 'active' : ''}`} onClick={() => set({ period: 'custom', from: s.from || from, to: s.to || to })}>свой</button>
          </div>
          {s.period === 'custom' && (
            <span className="rnp-dates">
              <input className="input" type="date" value={s.from || from} max={s.to || to} onChange={e => set({ from: e.target.value })} aria-label="Начало периода" />
              <span className="muted">–</span>
              <input className="input" type="date" value={s.to || to} min={s.from || from} max={mskToday()} onChange={e => set({ to: e.target.value })} aria-label="Конец периода" />
            </span>
          )}
          <label className="rnp-search">
            <MagnifyingGlassIcon size={15} />
            <input className="input" placeholder="Артикул, название или SKU" value={search} onChange={e => { setSearch(e.target.value); setShown(PAGE); }} />
          </label>
          <label className="rnp-check"><input type="checkbox" checked={s.inStock} onChange={e => set({ inStock: e.target.checked })} /> только в наличии</label>
          <label className="rnp-check"><input type="checkbox" checked={s.onlyChanged} onChange={e => set({ onlyChanged: e.target.checked })} /> только с действиями</label>
          <span className="rnp-spacer" />
          <span className="muted rnp-upd">
            {data?.collecting ? <><ArrowsClockwiseIcon size={13} className="spin" /> идёт сверка…</> : data?.checkedAt ? `карточки сверены ${new Date(data.checkedAt).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}` : ''}
          </span>
          <button className="btn btn-sm" onClick={checkNow} disabled={!!data?.collecting} title="Сверить карточки с площадкой сейчас, не дожидаясь планового прохода (раз в 3 часа)">
            <ArrowsClockwiseIcon size={13} /> Сверить
          </button>
        </div>
        <div className="rnp-frow">
          <span className="muted">Показывать:</span>
          {ACT_KINDS.map(k => {
            const on = s.kinds.includes(k.key);
            return (
              <button key={k.key} className={`act-chip ${on ? 'on' : ''}`} style={{ ['--k' as string]: k.color }} title={k.hint}
                onClick={() => set({ kinds: on ? s.kinds.filter(x => x !== k.key) : [...s.kinds, k.key] })}>
                <span className="act-dot" /> {k.label}
              </button>
            );
          })}
          <label className="rnp-check"><input type="checkbox" checked={s.orders} onChange={e => set({ orders: e.target.checked })} /> строка заказов</label>
          <span className="rnp-spacer" />
          <span className="rnp-sort">
            <span className="muted">Сначала</span>
            <select className="select" value={s.sort} onChange={e => set({ sort: e.target.value as Settings['sort'] })} aria-label="Сортировка">
              <option value="orders">где больше заказов</option>
              <option value="changes">где больше действий</option>
            </select>
          </span>
          <button className="btn btn-sm" onClick={() => { set({ expandAll: !s.expandAll }); setToggled(new Set()); }}>
            {s.expandAll ? 'Свернуть все' : 'Развернуть все'}
          </button>
        </div>
      </section>

      {err && <div className="rnp-alert">Не удалось загрузить действия: {err}</div>}
      {data?.notes.map(n => <div key={n} className="rnp-note">{n}</div>)}

      <section className="card rnp-table-card">
        <div className="rnp-table-head">
          <b>{rows.length ? `Товаров: ${rows.length}` : loading ? 'Загрузка…' : 'Нет товаров под фильтры'}</b>
          {rows.length > 0 && <span className="muted">действий за период: {nf.format(totalChanges)} · щёлкните по клетке, чтобы увидеть подробности или оставить заметку</span>}
        </div>
        {rows.length > 0 && (
          <div className="rnp-scroll">
            <table className="rnp-table act-table">
              <thead>
                <tr>
                  <th className="rnp-sticky rnp-col-item">Товар</th>
                  <th className="rnp-sticky rnp-col-metric act-col-kind">Действие</th>
                  {dates.map(d => {
                    const wk = weekday(d);
                    return <th key={d} className={`act-th ${wk === 0 || wk === 6 ? 'act-we' : ''} ${d === mskToday() ? 'act-today' : ''}`}><div>{ddmm(d)}</div><div className="act-wd">{WEEKDAY[wk]}</div></th>;
                  })}
                  <th className="act-total">Всего</th>
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, shown).map(r => (
                  <Fragment key={r.item.sku}>
                    <ItemBlock row={r} dates={dates} kinds={kinds} showOrders={s.orders} open={open}
                      expanded={s.expandAll !== toggled.has(r.item.sku)}
                      onToggle={() => setToggled(t => { const n = new Set(t); if (n.has(r.item.sku)) n.delete(r.item.sku); else n.add(r.item.sku); return n; })}
                      onOpen={setOpen} />
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {rows.length > shown && <button className="btn" onClick={() => setShown(n => n + PAGE)}>Показать ещё {Math.min(PAGE, rows.length - shown)} из {rows.length - shown}</button>}
      </section>

      {open && openItem && <DayPanel mp={mp} item={openItem} open={open} dates={dates} onClose={() => setOpen(null)} onChanged={load} />}
    </div>
  );
}

export function RnpActions() {
  const [mp, setMp] = useState<RnpMp>(() => {
    try { return localStorage.getItem('rnp-actions:mp') === 'ozon' ? 'ozon' : 'wb'; } catch { return 'wb'; }
  });
  const choose = (m: RnpMp) => { setMp(m); try { localStorage.setItem('rnp-actions:mp', m); } catch { /* не критично */ } };
  const [topbarH, setTopbarH] = useState(56);
  useEffect(() => {
    const tb = document.querySelector('.topbar') as HTMLElement | null;
    if (!tb) return;
    const measure = () => setTopbarH(h => (tb.offsetHeight !== h ? tb.offsetHeight : h));
    measure();
    const timers = [100, 400, 1000, 2500].map(ms => setTimeout(measure, ms));
    window.addEventListener('resize', measure);
    return () => { timers.forEach(clearTimeout); window.removeEventListener('resize', measure); };
  }, []);
  const [tabsRef, tabsH] = useHeight<HTMLDivElement>();

  return (
    <div className="grid" style={{ gap: 16, ['--rnp-stick-top' as string]: `${topbarH + tabsH - 10}px` }}>
      <div className="row gap-8 rnp-tabs" style={{ top: topbarH }} ref={tabsRef}>
        <button className={`mp-tab ${mp === 'wb' ? 'active' : ''}`} onClick={() => choose('wb')}>
          <span className="mp-tab-dot" style={{ background: '#cb11ab' }} /> Wildberries
        </button>
        <button className={`mp-tab ${mp === 'ozon' ? 'active' : ''}`} onClick={() => choose('ozon')}>
          <span className="mp-tab-dot" style={{ background: '#005bff' }} /> Ozon
        </button>
      </div>
      <Fragment key={mp}><Board mp={mp} /></Fragment>
    </div>
  );
}
