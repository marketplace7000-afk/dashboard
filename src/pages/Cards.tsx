/**
 * «Ведение карточек» (31.10.2026) — только владелец.
 * Два листа: Wildberries и Ozon. Поиск: щёлкнул товар — выбран, рядом «Закрепить» и «Отменить».
 * Карточка — компактная строка, по щелчку раскрываются запросы, конкуренты и рамки.
 * На площадках раздел ничего не меняет.
 */
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { CaretDownIcon, CaretRightIcon } from '@phosphor-icons/react';
import { apiGet, apiPost, errText } from '../api/http';

type Mp = 'wb' | 'ozon';
type Goal = 'growth' | 'hold' | 'sell_out';
type Period = { orders: number; amount: number; ads: number; drrPct: number | null };
type Pin = {
  mp: Mp; sku: string; article: string; name: string; photo: string;
  goal: Goal; minMarginPct: number | null; maxDrrPct: number | null; minStockDays: number | null;
  cur: Period | null; prev: Period | null; stock: number | null; price: number | null; dataDate: string | null;
};
type Item = { sku: string; article: string; name: string; photo: string };
type Query = {
  text: string; freq: number | null; freqDyn: number | null; pos: number | null; posDyn: number | null;
  reach: number | null; cart: number | null; orders: number | null; ordersDyn: number | null; gmv: number | null;
  viewConv: number | null; visibility: number | null;
};
type CompNm = { nmId: number; shown: boolean | null; pos: number | null; open: number | null; cart: number | null; orders: number | null };
type Comp = {
  setDate: string;
  cards: { nmId: number; name: string; brand: string }[];
  queries: { text: string; freq: number | null; nms?: CompNm[] }[];
};
type Details = { queries: Query[]; collectedAt: number | null; comp: Comp | null };

const GOAL_LABEL: Record<Goal, string> = { growth: 'Рост продаж', hold: 'Удержание', sell_out: 'Распродажа' };
const MP_INFO: Record<Mp, { label: string; color: string }> = {
  wb: { label: 'Wildberries', color: '#cb11ab' },
  ozon: { label: 'Ozon', color: '#005bff' },
};
const num = (n: number | null | undefined) => n == null ? '—' : Math.round(n).toLocaleString('ru-RU');
const rub = (n: number | null | undefined) => n == null ? '—' : `${Math.round(n).toLocaleString('ru-RU')} ₽`;
const pct = (n: number | null | undefined) => n == null ? '—' : `${String(n).replace('.', ',')} %`;
const dateRu = (s: string) => s.split('-').reverse().join('.');
const danger = 'var(--danger, #c00)';
const th = { textAlign: 'right', padding: '6px 10px', whiteSpace: 'nowrap', fontWeight: 600 } as const;
const td = { textAlign: 'right', padding: '6px 10px', whiteSpace: 'nowrap', borderTop: '1px solid var(--line, #e6e6e6)' } as const;
const tdText = { ...td, textAlign: 'left', whiteSpace: 'normal', minWidth: 180 } as const;

function change(cur?: number, prev?: number) {
  if (cur == null || !prev) return null;
  const d = Math.round(((cur - prev) / prev) * 100);
  return <div className="muted" style={{ color: d < 0 ? danger : undefined }}>{d > 0 ? '+' : ''}{d} %</div>;
}

function Settings({ pin, onSaved }: { pin: Pin; onSaved: () => void }) {
  const [f, setF] = useState<{ goal: Goal; minMarginPct: number | string; maxDrrPct: number | string; minStockDays: number | string }>({
    goal: pin.goal, minMarginPct: pin.minMarginPct ?? '', maxDrrPct: pin.maxDrrPct ?? '', minStockDays: pin.minStockDays ?? '',
  });
  const [msg, setMsg] = useState('');
  const save = async () => {
    setMsg('');
    try { await apiPost('/api/cards/pin', { mp: pin.mp, sku: pin.sku, ...f }); setMsg('Сохранено'); onSaved(); }
    catch (e) { setMsg(errText(e)); }
  };
  const field = (key: 'minMarginPct' | 'maxDrrPct' | 'minStockDays', label: string) => (
    <label style={{ display: 'grid', gap: 4 }}>
      <span className="muted">{label}</span>
      <input className="input" inputMode="decimal" value={f[key]} onChange={e => setF({ ...f, [key]: e.target.value })} style={{ width: 110 }} />
    </label>
  );
  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'end' }}>
        <label style={{ display: 'grid', gap: 4 }}>
          <span className="muted">Цель</span>
          <select className="input" style={{ width: 160 }} value={f.goal} onChange={e => setF({ ...f, goal: e.target.value as Goal })}>
            {(Object.keys(GOAL_LABEL) as Goal[]).map(g => <option key={g} value={g}>{GOAL_LABEL[g]}</option>)}
          </select>
        </label>
        {field('minMarginPct', 'Мин. маржа, %')}
        {field('maxDrrPct', 'Макс. ДРР, %')}
        {field('minStockDays', 'Мин. запас, дней')}
        <button className="btn btn-sm" onClick={save}>Сохранить</button>
        {msg && <span className="muted">{msg}</span>}
      </div>
      <p className="muted" style={{ marginBottom: 0 }}>Рамки пока только сохраняются: агент начнёт учитывать их, когда появится план действий.</p>
    </div>
  );
}

type SortKey = 'freq' | 'pos' | 'reach' | 'orders';

function Queries({ mp, d }: { mp: Mp; d: Details }) {
  const [sort, setSort] = useState<SortKey>('freq');
  const [q, setQ] = useState('');
  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    const list = d.queries.filter(r => r.text.toLowerCase().includes(s));
    // Позиция: меньше — лучше; пустые значения всегда внизу.
    const val = (r: Query) => r[sort] ?? (sort === 'pos' ? Infinity : -Infinity);
    return [...list].sort((a, b) => sort === 'pos' ? val(a) - val(b) : val(b) - val(a));
  }, [d.queries, q, sort]);
  if (!d.queries.length) return <div className="muted">Запросов пока нет: они соберутся при следующем обновлении данных.</div>;
  const head = (key: SortKey, label: string) => (
    <th style={{ ...th, cursor: 'pointer', textDecoration: sort === key ? 'underline' : undefined }} onClick={() => setSort(key)} aria-sort={sort === key ? (key === 'pos' ? 'ascending' : 'descending') : 'none'}>{label}</th>
  );
  return (
    <div>
      <input className="input" style={{ maxWidth: 320, marginBottom: 8 }} placeholder="Найти запрос" value={q} onChange={e => setQ(e.target.value)} />
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr>
            <th style={{ ...th, textAlign: 'left' }}>Запрос</th>
            {head('freq', mp === 'wb' ? 'Частота' : 'Искали')}
            {head('pos', 'Позиция')}
            {head('reach', mp === 'wb' ? 'Переходы' : 'Увидели')}
            {mp === 'wb' ? <th style={th}>Корзины</th> : <th style={th}>В карточку</th>}
            {head('orders', 'Заказы')}
          </tr></thead>
          <tbody>{rows.map(r => (
            <tr key={r.text}>
              <td style={tdText}>{r.text}</td>
              <td style={td}>{num(r.freq)}</td>
              <td style={td}>{num(r.pos)}</td>
              <td style={td}>{num(r.reach)}</td>
              <td style={td}>{mp === 'wb' ? num(r.cart) : pct(r.viewConv)}</td>
              <td style={td}>{num(r.orders)}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      <p className="muted" style={{ marginBottom: 0 }}>
        {mp === 'wb'
          ? `За 7 дней, ${d.queries.length} запросов по переходам. Показы и CTR по запросу WB не отдаёт.`
          : `Период около 4 недель, без последних 3 дней. Через API Ozon отдаёт не больше 15 самых частых запросов.`}
        {d.collectedAt ? ` Собрано ${new Date(d.collectedAt).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}.` : ''}
      </p>
    </div>
  );
}

function Competitors({ mp, comp }: { mp: Mp; comp: Comp | null }) {
  if (mp === 'ozon') return <div className="muted">Запросы конкурентов на Ozon требуют Premium Pro. Снимки выдачи по важным запросам добавим следующим шагом.</div>;
  if (!comp) return <div className="muted">Данных пока нет: они появятся после ночного прохода агента, если у карточки есть открытое сравнение.</div>;
  const [own, ...rest] = comp.cards;
  const hasNms = comp.queries.some(q => q.nms?.length);
  const of = (q: Comp['queries'][number], nm: number) => q.nms?.find(n => n.nmId === nm);
  const cell = (n?: CompNm) => n == null ? '—' : n.shown === false ? 'нет в поиске' : `${num(n.pos)} · ${num(n.orders)}`;
  return (
    <div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr>
            <th style={{ ...th, textAlign: 'left' }}>Запрос</th>
            <th style={th}>Частота</th>
            {hasNms && <th style={th}>Мы</th>}
            {hasNms && rest.map(c => <th key={c.nmId} style={th} title={c.name}>{c.brand || c.nmId}</th>)}
          </tr></thead>
          <tbody>{comp.queries.map(q => (
            <tr key={q.text}>
              <td style={tdText}>{q.text}</td>
              <td style={td}>{num(q.freq)}</td>
              {hasNms && <td style={td}><b>{cell(of(q, own.nmId))}</b></td>}
              {hasNms && rest.map(c => <td key={c.nmId} style={td}>{cell(of(q, c.nmId))}</td>)}
            </tr>
          ))}</tbody>
        </table>
      </div>
      <p className="muted" style={{ marginBottom: 0 }}>
        Сравнение от {dateRu(comp.setDate)}, за 30 дней. {hasNms ? 'В ячейке: средняя позиция · заказы.' : 'Цифры по каждой карточке появятся после ночного прохода агента.'}
      </p>
    </div>
  );
}

function PinDetails({ pin, onChanged }: { pin: Pin; onChanged: () => void }) {
  const [tab, setTab] = useState<'queries' | 'comp' | 'rules'>('queries');
  const [d, setD] = useState<Details | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    let live = true;
    apiGet<Details>(`/api/cards/details?mp=${pin.mp}&sku=${encodeURIComponent(pin.sku)}`)
      .then(r => { if (live) setD(r.data); })
      .catch(e => { if (live) setErr(errText(e)); });
    return () => { live = false; };
  }, [pin.mp, pin.sku]);
  const tabs: [typeof tab, string][] = [['queries', 'Запросы'], ['comp', 'Конкуренты'], ['rules', 'Рамки']];
  return (
    <div>
      <div className="rnp-tabs" style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
        {tabs.map(([k, label]) => <button key={k} className={`mp-tab ${tab === k ? 'active' : ''}`} onClick={() => setTab(k)}>{label}</button>)}
      </div>
      {tab === 'rules'
        ? <Settings key={`${pin.goal}|${pin.minMarginPct}|${pin.maxDrrPct}|${pin.minStockDays}`} pin={pin} onSaved={onChanged} />
        : err ? <div style={{ color: danger }}>{err}</div>
        : !d ? <div className="muted">Загрузка…</div>
        : tab === 'queries' ? <Queries mp={pin.mp} d={d} />
        : <Competitors mp={pin.mp} comp={d.comp} />}
    </div>
  );
}

export function Cards() {
  const [pins, setPins] = useState<Pin[] | null>(null);
  const [error, setError] = useState('');
  const [mp, setMp] = useState<Mp>('wb');
  const [items, setItems] = useState<Item[]>([]);
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<Item | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setPins((await apiGet<{ pins: Pin[] }>('/api/cards')).data.pins); setError(''); }
    catch (e) { setError(errText(e)); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    let live = true;
    apiGet<{ items: Item[] }>(`/api/cards/catalog?mp=${mp}`)
      .then(r => { if (live) setItems(r.data.items); })
      .catch(e => { if (live) setError(errText(e)); });
    return () => { live = false; };
  }, [mp, pins]);

  const found = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s || picked) return [];
    return items.filter(i => `${i.article} ${i.name} ${i.sku}`.toLowerCase().includes(s)).slice(0, 8);
  }, [items, q, picked]);

  const cancel = () => { setPicked(null); setQ(''); };
  const choose = (m: Mp) => { setMp(m); cancel(); setOpen(null); };
  const pin = async () => {
    if (!picked) return;
    try { await apiPost('/api/cards/pin', { mp, sku: picked.sku }); cancel(); await load(); }
    catch (e) { setError(errText(e)); }
  };
  const unpin = async (p: Pin) => {
    try { await apiPost('/api/cards/unpin', { mp: p.mp, sku: p.sku }); await load(); }
    catch (e) { setError(errText(e)); }
  };

  const list = pins?.filter(p => p.mp === mp) ?? [];
  const count = (m: Mp) => pins?.filter(p => p.mp === m).length ?? 0;

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div className="rnp-tabs" style={{ display: 'flex', gap: 6 }}>
        {(Object.keys(MP_INFO) as Mp[]).map(m => (
          <button key={m} className={`mp-tab ${mp === m ? 'active' : ''}`} onClick={() => choose(m)}>
            <span className="mp-tab-dot" style={{ background: MP_INFO[m].color }} /> {MP_INFO[m].label} · {count(m)}
          </button>
        ))}
      </div>

      <div className="card" style={{ position: 'relative' }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          <input
            className="input" style={{ flex: '1 1 260px', width: 'auto' }} placeholder={`Найти товар ${MP_INFO[mp].label}: артикул или название`}
            value={picked ? `${picked.article || picked.sku} · ${picked.name}` : q} readOnly={!!picked} onChange={e => setQ(e.target.value)}
          />
          {picked && <button className="btn btn-sm btn-primary" onClick={pin}>Закрепить</button>}
          {(picked || q) && <button className="btn btn-sm" onClick={cancel}>Отменить</button>}
        </div>
        {found.length > 0 && (
          <div style={{ marginTop: 6 }}>
            {found.map(i => (
              <button key={i.sku} className="btn btn-sm" style={{ display: 'flex', gap: 10, alignItems: 'center', width: '100%', textAlign: 'left', marginTop: 4 }} onClick={() => setPicked(i)}>
                {i.photo && <img src={i.photo} alt="" width={28} height={36} style={{ objectFit: 'cover', borderRadius: 4 }} />}
                <span style={{ minWidth: 0 }}><b>{i.article || i.sku}</b> · {i.name}</span>
              </button>
            ))}
          </div>
        )}
        {q.trim() && !picked && !found.length && <div className="muted" style={{ marginTop: 8 }}>Ничего не найдено</div>}
      </div>

      {error && <div className="card" style={{ color: danger }}>{error}</div>}
      {pins === null && !error && <div className="card muted">Загрузка…</div>}
      {pins && !list.length && <div className="card muted">На этом листе карточек нет. Найдите товар выше, щёлкните по нему и нажмите «Закрепить».</div>}

      {list.length > 0 && (
        <div className="card" style={{ overflowX: 'auto', padding: 0 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr>
              <th style={{ ...th, textAlign: 'left' }}>Карточка</th>
              <th style={th}>Заказы, 7 дн</th><th style={th}>Сумма</th><th style={th}>Реклама</th><th style={th}>ДРР</th><th style={th}>Цена</th><th style={th}>Остаток</th><th style={th} />
            </tr></thead>
            <tbody>
              {list.map(p => {
                const key = `${p.mp}:${p.sku}`, isOpen = open === key;
                return (
                  <Fragment key={key}>
                    <tr style={{ cursor: 'pointer' }} onClick={() => setOpen(isOpen ? null : key)} aria-expanded={isOpen}>
                      <td style={{ ...tdText, minWidth: 260 }}>
                        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                          {isOpen ? <CaretDownIcon size={14} /> : <CaretRightIcon size={14} />}
                          {p.photo && <img src={p.photo} alt="" width={36} height={48} style={{ objectFit: 'cover', borderRadius: 4 }} />}
                          <span style={{ minWidth: 0 }}>
                            <b>{p.article || p.sku}</b>
                            <div className="muted" style={{ overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 1, WebkitBoxOrient: 'vertical' }}>{p.name}</div>
                          </span>
                        </div>
                      </td>
                      <td style={td}>{num(p.cur?.orders)}{change(p.cur?.orders, p.prev?.orders)}</td>
                      <td style={td}>{rub(p.cur?.amount)}{change(p.cur?.amount, p.prev?.amount)}</td>
                      <td style={td}>{rub(p.cur?.ads)}</td>
                      <td style={td}>{pct(p.cur?.drrPct)}</td>
                      <td style={td}>{rub(p.price)}</td>
                      <td style={td}>{num(p.stock)}</td>
                      <td style={td}><button className="btn btn-sm" onClick={e => { e.stopPropagation(); void unpin(p); }}>Открепить</button></td>
                    </tr>
                    {isOpen && <tr><td colSpan={8} style={{ padding: 12, borderTop: '1px solid var(--line, #e6e6e6)' }}><PinDetails pin={p} onChanged={load} /></td></tr>}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <div className="muted">Агент пока только наблюдает: на площадках ничего не меняется.</div>
    </div>
  );
}
