/**
 * «Цены» → «Заявки на скидку» (08.11.2026). Правила по товарам и заявки покупателей Ozon.
 * Логика и расчёт — на сервере (api/_lib/discounts.ts); здесь маржа при выбранной скидке
 * пересчитывается тем же калькулятором (src/utils/ozonProfit.ts), чтобы цифры менялись сразу.
 * Шрифт — как в «Рекламе» и «РНП»: текст 19, подписи 16–17.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowClockwiseIcon, CheckIcon, MagnifyingGlassIcon, XIcon } from '@phosphor-icons/react';
import '../discounts.css';
import { apiGet, apiPost, errText } from '../api/http';
import { calcOzonProfit, type OzonCalcInput } from '../utils/ozonProfit';

type Mode = 'approve' | 'decline' | 'manual';
type Rule = { article: string; mode: Mode; maxPct: number | null; minMargin: number | null; updatedAt: number; updatedBy: string };
type Decision = { action: 'approve' | 'decline' | 'skip'; price: number | null; pct: number | null; marginPct: number | null; reason: string };
type Product = {
  article: string; name: string; photo: string; sku: string;
  price: number | null; showcase: number | null; showcaseSource: string;
  cost: number | null; marginPct: number | null; marginRub: number | null;
  input: OzonCalcInput | null; rule: Rule | null; req7: number; pending: number;
};
type Task = {
  id: string; article: string; sku: string; status: string; createdAt: string; customer: string; comment: string;
  base: number; showcase: number; requested: number; requestedPct: number; qtyMin: number; qtyMax: number;
  approvedPrice: number | null; moderatedAt: string | null; decision: Decision | null;
  by: 'agent' | 'user' | null; byName: string | null; appliedAt: number | null; error: string | null;
};
type Data = {
  settings: { auto: boolean; defaultMode: 'manual' | 'decline' }; canToggle: boolean;
  lastRun: number; lastError: string | null; lastSummary: string; products: Product[]; tasks: Task[];
};

const nf = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
const rub = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? '—' : `${nf.format(Math.round(v))} ₽`);
const pctS = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? '—' : `${String(Math.round(v * 10) / 10).replace('.', ',')} %`);
// Пороги цвета — как на листе «Цены» (30 / 15).
const tone = (m: number | null | undefined) => (m == null ? '' : m >= 30 ? 'good' : m >= 15 ? 'warn' : 'bad');
const time = (iso: string | number | null) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' });
};
const isPending = (t: Task) => t.status === 'NEW' || t.status === 'SEEN';

/**
 * Маржа при скидке pct % от витрины — как на сервере (marginAtDiscount): цена ЛК падает
 * на ту же долю, соинвест Ozon сохраняется.
 */
function marginAt(input: OzonCalcInput | null, pct: number): { pct: number; rub: number } | null {
  if (!input || !(input.price > 0) || !(input.cost > 0)) return null;
  const price = input.price * (1 - pct / 100);
  const r = calcOzonProfit({ ...input, price, acquiring: Math.round(input.acquiring / input.price * price) });
  return r ? { pct: Math.round(r.margin * 10) / 10, rub: Math.round(r.profit) } : null;
}

/** Наибольшая скидка, при которой маржа не ниже порога (шаг 0,1 %). */
function maxPctForMargin(input: OzonCalcInput | null, minMargin: number): number | null {
  const m0 = marginAt(input, 0);
  if (!m0) return null;
  if (m0.pct < minMargin) return 0;
  let lo = 0, hi = 90;
  if ((marginAt(input, hi)?.pct ?? -1e9) >= minMargin) return hi;
  for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if ((marginAt(input, mid)?.pct ?? -1e9) >= minMargin) lo = mid; else hi = mid; }
  return Math.floor(lo * 10) / 10;
}

type Filter = 'all' | 'requests' | 'norule' | 'approve' | 'decline';
const FILTERS: [Filter, string][] = [['all', 'Все'], ['requests', 'Есть заявки'], ['norule', 'Без правила'], ['approve', 'Одобряем'], ['decline', 'Отклоняем']];
const MODES: [Mode, string][] = [['approve', 'Одобрять'], ['decline', 'Отклонять'], ['manual', 'Менеджеры']];

export function OzonDiscounts() {
  const [data, setData] = useState<Data | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [view, setView] = useState<'products' | 'tasks'>('products');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { setData((await apiGet<Data>('/api/discounts')).data); setErr(null); }
    catch (e) { setErr(errText(e)); }
  }, []);
  useEffect(() => { void load(); const t = setInterval(load, 60_000); return () => clearInterval(t); }, [load]);

  const post = useCallback(async (path: string, body: object) => {
    try { await apiPost(`/api/discounts/${path}`, body); setErr(null); return true; }
    catch (e) { setErr(errText(e)); return false; }
  }, []);

  const refresh = async () => { setBusy(true); await post('refresh', {}); await load(); setBusy(false); };
  const setSettings = async (p: object) => { if (await post('settings', p)) await load(); };

  if (!data) return <div className="card dr">{err ? <div className="dr-err">{err}</div> : 'Загружаю заявки Ozon…'}</div>;

  const pending = data.tasks.filter(isPending);
  const byAgent = data.tasks.filter(t => t.by === 'agent' && !t.error);
  const approved = byAgent.filter(t => t.decision?.action === 'approve').length;
  const declined = byAgent.filter(t => t.decision?.action === 'decline').length;
  const errors = data.tasks.filter(t => t.error).length;

  return (
    <div className="dr grid" style={{ gap: 16 }}>
      <div className="card dr-head">
        <div className="dr-head-main">
          <h2>Заявки на скидку · Ozon</h2>
          <div className="dr-sub">
            Агент проверяет новые заявки каждые 2 минуты. Последняя проверка: {data.lastRun ? time(data.lastRun) : 'ещё не было'}
            {data.lastError && <span className="dr-bad"> · ошибка: {data.lastError}</span>}
          </div>
        </div>
        <div className="dr-head-ctl">
          <label className={`dr-switch ${data.settings.auto ? 'on' : ''} ${data.canToggle ? '' : 'locked'}`}
            title={data.canToggle ? '' : 'Включать и выключать агента может только владелец'}>
            <input type="checkbox" checked={data.settings.auto} disabled={!data.canToggle}
              onChange={e => {
                if (e.target.checked && !window.confirm('Включить автоответ? Агент начнёт сам одобрять и отклонять заявки по правилам.')) return;
                void setSettings({ auto: e.target.checked });
              }} />
            <span className="dr-switch-track"><span className="dr-switch-dot" /></span>
            <span>{data.settings.auto ? 'Автоответ включён' : 'Автоответ выключен — агент только показывает решения'}</span>
          </label>
          <button className="btn" onClick={refresh} disabled={busy}><ArrowClockwiseIcon size={18} /> {busy ? 'Проверяю…' : 'Проверить сейчас'}</button>
        </div>
      </div>

      {err && <div className="dr-err">{err}</div>}

      <div className="dr-tiles">
        <button className={`dr-tile ${pending.length ? 'warn' : ''}`} onClick={() => setView('tasks')}>
          <span className="dr-tile-label">Ждут ответа</span><span className="dr-tile-num">{pending.length}</span>
        </button>
        <div className="dr-tile"><span className="dr-tile-label">Агент одобрил за 7 дней</span><span className="dr-tile-num">{approved}</span></div>
        <div className="dr-tile"><span className="dr-tile-label">Агент отклонил за 7 дней</span><span className="dr-tile-num">{declined}</span></div>
        <div className={`dr-tile ${errors ? 'bad' : ''}`}><span className="dr-tile-label">Ozon не принял ответ</span><span className="dr-tile-num">{errors}</span></div>
      </div>

      <div className="dr-note">
        Скидка в процентах — от цены, которую покупатель видит на витрине. Ozon сохраняет свою скидку,
        поэтому ваша цена в кабинете для этой продажи снижается на тот же процент — от неё и считается маржа.
      </div>

      <div className="row gap-8" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
        <div className="sa-seg">
          <button className={view === 'products' ? 'active' : ''} onClick={() => setView('products')}>Товары и правила</button>
          <button className={view === 'tasks' ? 'active' : ''} onClick={() => setView('tasks')}>Заявки{pending.length ? ` · ждут ${pending.length}` : ''}</button>
        </div>
        <span className="dr-def">
          Товары без правила:
          <span className="sa-seg">
            <button className={data.settings.defaultMode === 'manual' ? 'active' : ''} onClick={() => setSettings({ defaultMode: 'manual' })}>решают менеджеры</button>
            <button className={data.settings.defaultMode === 'decline' ? 'active' : ''} onClick={() => setSettings({ defaultMode: 'decline' })}>отклонять</button>
          </span>
        </span>
      </div>

      {view === 'products'
        ? <Products data={data} post={post} reload={load} />
        : <Tasks data={data} post={post} reload={load} />}
    </div>
  );
}

// ─── Товары и правила ───────────────────────────────────────────────────────

type PostFn = (path: string, body: object) => Promise<boolean>;

function Products({ data, post, reload }: { data: Data; post: PostFn; reload: () => Promise<void> }) {
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [bulkPct, setBulkPct] = useState('10');
  // Правки, ещё не дошедшие до сервера, — чтобы поле не прыгало при обновлении списка.
  const [local, setLocal] = useState<Record<string, Partial<Rule>>>({});

  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    return data.products
      .map(p => ({ ...p, rule: p.rule || local[p.article] ? { ...(p.rule ?? { article: p.article, mode: 'manual' as Mode, maxPct: null, minMargin: null, updatedAt: 0, updatedBy: '' }), ...local[p.article] } as Rule : null }))
      .filter(p => !s || p.article.toLowerCase().includes(s) || p.name.toLowerCase().includes(s))
      .filter(p => filter === 'all' ? true : filter === 'requests' ? p.req7 > 0 : filter === 'norule' ? !p.rule : p.rule?.mode === filter)
      .sort((a, b) => b.pending - a.pending || b.req7 - a.req7 || (b.showcase ?? 0) - (a.showcase ?? 0));
  }, [data.products, q, filter, local]);

  const save = async (articles: string[], patch: Partial<Rule>) => {
    setLocal(l => { const n = { ...l }; for (const a of articles) n[a] = { ...n[a], ...patch }; return n; });
    if (await post('rules', { articles, ...patch })) {
      await reload();
      setLocal(l => { const n = { ...l }; for (const a of articles) delete n[a]; return n; });
    }
  };

  const allSel = rows.length > 0 && rows.every(r => sel.has(r.article));
  const toggleAll = () => setSel(allSel ? new Set() : new Set(rows.map(r => r.article)));
  const toggle = (a: string) => setSel(s => { const n = new Set(s); if (n.has(a)) n.delete(a); else n.add(a); return n; });
  const bulk = async (patch: Partial<Rule>) => { await save([...sel], patch); setSel(new Set()); };

  return (
    <div className="card dr-card">
      <div className="dr-tools">
        <label className="dr-search"><MagnifyingGlassIcon size={20} />
          <input className="input" placeholder="Артикул или название" value={q} onChange={e => setQ(e.target.value)} />
        </label>
        <div className="sa-seg">
          {FILTERS.map(([k, l]) => <button key={k} className={filter === k ? 'active' : ''} onClick={() => setFilter(k)}>{l}</button>)}
        </div>
      </div>

      {sel.size > 0 && (
        <div className="dr-bulk">
          <b>Выбрано: {sel.size}</b>
          <span className="dr-bulk-group">
            <button className="btn btn-primary" onClick={() => bulk({ mode: 'approve', maxPct: Number(bulkPct.replace(',', '.')) || 0 })}>Одобрять до</button>
            <input className="input dr-num" value={bulkPct} onChange={e => setBulkPct(e.target.value)} inputMode="decimal" /> %
          </span>
          <button className="btn" onClick={() => bulk({ mode: 'decline' })}>Отклонять</button>
          <button className="btn" onClick={() => bulk({ mode: 'manual' })}>Оставить менеджерам</button>
          <button className="btn" onClick={() => setSel(new Set())}><XIcon size={16} /> Снять выбор</button>
        </div>
      )}

      <div className="dr-table-wrap">
        <table className="dr-table">
          <thead>
            <tr>
              <th className="dr-cb"><input type="checkbox" checked={allSel} onChange={toggleAll} /></th>
              <th>Товар</th>
              <th className="r">На витрине</th>
              <th className="r">Маржа сейчас</th>
              <th>Что делать с заявками</th>
              <th className="r">Макс. скидка</th>
              <th className="r">Цена со скидкой</th>
              <th className="r">Маржа со скидкой</th>
              <th className="r">Маржа не ниже</th>
              <th className="r">Заявок за 7 дн</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(p => <ProductRow key={p.article} p={p} checked={sel.has(p.article)} onCheck={() => toggle(p.article)} save={save} />)}
            {!rows.length && <tr><td colSpan={10} className="dr-empty">Ничего не нашлось</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function NumInput({ value, onSave, placeholder, disabled }: { value: number | null; onSave: (v: number | null) => void; placeholder?: string; disabled?: boolean }) {
  const [v, setV] = useState(value == null ? '' : String(value).replace('.', ','));
  const focused = useRef(false);
  useEffect(() => { if (!focused.current) setV(value == null ? '' : String(value).replace('.', ',')); }, [value]);
  const commit = () => {
    focused.current = false;
    const s = v.trim().replace(',', '.');
    const n = s === '' ? null : Number(s);
    if (n !== null && (!Number.isFinite(n) || n < 0 || n > 90)) { setV(value == null ? '' : String(value)); return; }
    if (n !== value) onSave(n);
  };
  return (
    <span className="dr-numwrap">
      <input className="input dr-num" value={v} placeholder={placeholder} disabled={disabled} inputMode="decimal"
        onFocus={() => { focused.current = true; }} onChange={e => setV(e.target.value)} onBlur={commit}
        onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
      <span className="dr-unit">%</span>
    </span>
  );
}

function ProductRow({ p, checked, onCheck, save }: { p: Product; checked: boolean; onCheck: () => void; save: (a: string[], patch: Partial<Rule>) => Promise<void> }) {
  const r = p.rule;
  const mode: Mode | null = r?.mode ?? null;
  const show = p.showcase ?? 0;
  // Сколько реально даст агент: заданный процент, но не больше, чем позволяет порог маржи.
  const setPct = mode === 'approve' ? r?.maxPct ?? null : null;
  const byMargin = mode === 'approve' && r?.minMargin != null ? maxPctForMargin(p.input, r.minMargin) : null;
  const eff = setPct == null && byMargin == null ? null : Math.min(setPct ?? 90, byMargin ?? 90);
  const limited = byMargin != null && (setPct == null || byMargin < setPct);
  const discPrice = eff != null && show > 0 ? Math.ceil(show * (1 - eff / 100)) : null;
  const newLk = eff != null && p.price ? Math.round(p.price * (1 - eff / 100)) : null;
  const m = eff != null ? marginAt(p.input, eff) : null;

  return (
    <tr className={checked ? 'sel' : ''}>
      <td className="dr-cb"><input type="checkbox" checked={checked} onChange={onCheck} /></td>
      <td>
        <div className="dr-prod">
          {p.photo ? <img src={p.photo} alt="" loading="lazy" /> : <span className="dr-noimg" />}
          <div>
            <div className="dr-name" title={p.name}>{p.name || p.article}</div>
            <div className="dr-art">{p.article}</div>
          </div>
        </div>
      </td>
      <td className="r">
        <b>{rub(p.showcase)}</b>
        <div className="dr-cap">наша {rub(p.price)}</div>
      </td>
      <td className="r">
        {p.marginPct != null ? <><b className={tone(p.marginPct)}>{pctS(p.marginPct)}</b><div className="dr-cap">{rub(p.marginRub)}</div></>
          : <span className="dr-cap">{p.cost ? '—' : 'нет себестоимости'}</span>}
      </td>
      <td>
        <div className="sa-seg dr-mode">
          {MODES.map(([k, l]) => (
            <button key={k} className={`${mode === k ? 'active' : ''} m-${k}`} onClick={() => save([p.article], { mode: k })}>{l}</button>
          ))}
        </div>
      </td>
      <td className="r">
        {mode === 'approve' ? <NumInput value={r?.maxPct ?? null} placeholder="0" onSave={v => save([p.article], { maxPct: v })} /> : <span className="dr-cap">—</span>}
      </td>
      <td className="r">
        {discPrice != null
          ? <><b>{rub(discPrice)}</b><div className={`dr-cap ${limited ? 'warn' : ''}`}>−{pctS(eff)}{limited ? ' — ограничила маржа' : ''} · ЛК {rub(newLk)}</div></>
          : <span className="dr-cap">—</span>}
      </td>
      <td className="r">
        {mode !== 'approve' || eff == null ? <span className="dr-cap">—</span>
          : !m ? <span className="dr-cap">{p.cost ? '—' : 'нет себестоимости'}</span>
          : <><b className={tone(m.pct)}>{pctS(m.pct)}</b><div className="dr-cap">{rub(m.rub)}</div></>}
      </td>
      <td className="r">
        {mode === 'approve' ? <NumInput value={r?.minMargin ?? null} placeholder="—" onSave={v => save([p.article], { minMargin: v })} /> : <span className="dr-cap">—</span>}
      </td>
      <td className="r">
        {p.req7 ? <b>{p.req7}</b> : <span className="dr-cap">0</span>}
        {p.pending > 0 && <div className="dr-pend">ждут {p.pending}</div>}
      </td>
    </tr>
  );
}

// ─── Заявки ─────────────────────────────────────────────────────────────────

const STATUS: Record<string, string> = { NEW: 'Новая', SEEN: 'Просмотрена', APPROVED: 'Одобрена', DECLINED: 'Отклонена' };

function Tasks({ data, post, reload }: { data: Data; post: PostFn; reload: () => Promise<void> }) {
  const [only, setOnly] = useState<'pending' | 'all'>('pending');
  const [busyId, setBusyId] = useState<string | null>(null);
  const prod = useMemo(() => new Map(data.products.map(p => [p.article, p])), [data.products]);
  const list = data.tasks.filter(t => only === 'all' || isPending(t));

  const act = async (t: Task, action: 'approve' | 'decline', price?: number) => {
    if (action === 'approve' && !window.confirm(`Одобрить заявку по цене ${rub(price)}?`)) return;
    if (action === 'decline' && !window.confirm('Отклонить заявку?')) return;
    setBusyId(t.id);
    await post('apply', { id: t.id, action, price });
    await reload();
    setBusyId(null);
  };

  return (
    <div className="card dr-card">
      <div className="dr-tools">
        <div className="sa-seg">
          <button className={only === 'pending' ? 'active' : ''} onClick={() => setOnly('pending')}>Ждут ответа</button>
          <button className={only === 'all' ? 'active' : ''} onClick={() => setOnly('all')}>Все за 7 дней</button>
        </div>
      </div>
      <div className="dr-table-wrap">
        <table className="dr-table">
          <thead>
            <tr>
              <th>Когда</th>
              <th>Товар</th>
              <th className="r">На витрине</th>
              <th className="r">Просит</th>
              <th>Решение агента</th>
              <th>Статус</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list.map(t => {
              const p = prod.get(t.article);
              const d = t.decision;
              const pend = isPending(t);
              const askM = marginAt(p?.input ?? null, Math.max(0, t.requestedPct));
              return (
                <tr key={t.id}>
                  <td className="nw">{time(t.createdAt)}<div className="dr-cap">{t.customer}</div></td>
                  <td>
                    <div className="dr-prod">
                      {p?.photo ? <img src={p.photo} alt="" loading="lazy" /> : <span className="dr-noimg" />}
                      <div>
                        <div className="dr-name" title={p?.name}>{p?.name || t.article}</div>
                        <div className="dr-art">{t.article}{t.qtyMax > 1 ? ` · ${t.qtyMin}–${t.qtyMax} шт` : ''}</div>
                        {t.comment && <div className="dr-cap">«{t.comment}»</div>}
                      </div>
                    </div>
                  </td>
                  <td className="r"><b>{rub(t.showcase)}</b></td>
                  <td className="r">
                    <b>{rub(t.requested)}</b>
                    <div className="dr-cap">−{pctS(t.requestedPct)}{askM ? ` · маржа ${pctS(askM.pct)}` : ''}</div>
                  </td>
                  <td>
                    {d ? (
                      <div>
                        <span className={`dr-badge ${d.action}`}>
                          {d.action === 'approve' ? `Одобрить ${rub(d.price)}` : d.action === 'decline' ? 'Отклонить' : 'Менеджерам'}
                        </span>
                        {d.action === 'approve' && d.marginPct != null && <span className={`dr-m ${tone(d.marginPct)}`}> маржа {pctS(d.marginPct)}</span>}
                        <div className="dr-cap">{d.reason}</div>
                      </div>
                    ) : <span className="dr-cap">—</span>}
                  </td>
                  <td>
                    <span className={`dr-status s-${t.status}`}>{STATUS[t.status] ?? t.status}</span>
                    {t.approvedPrice && t.status === 'APPROVED' ? <div className="dr-cap">по {rub(t.approvedPrice)}{t.showcase > 0 ? ` (−${pctS(Math.round((1 - t.approvedPrice / t.showcase) * 1000) / 10)})` : ''}</div> : null}
                    {!pend && <div className="dr-cap">{t.by === 'agent' ? 'ответил агент' : t.by === 'user' ? `ответил ${t.byName}` : 'ответили в кабинете'}</div>}
                    {t.error && <div className="dr-bad dr-cap">Ozon: {t.error}</div>}
                  </td>
                  <td className="nw">
                    {pend && (
                      <div className="dr-acts">
                        <button className="btn btn-sm btn-primary" disabled={busyId === t.id}
                          onClick={() => act(t, 'approve', d?.action === 'approve' && d.price ? d.price : Math.round(t.requested))}>
                          <CheckIcon size={16} /> Одобрить {rub(d?.action === 'approve' && d.price ? d.price : t.requested)}
                        </button>
                        <button className="btn btn-sm" disabled={busyId === t.id} onClick={() => act(t, 'decline')}><XIcon size={16} /> Отклонить</button>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
            {!list.length && <tr><td colSpan={7} className="dr-empty">{only === 'pending' ? 'Новых заявок нет' : 'За 7 дней заявок нет'}</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
