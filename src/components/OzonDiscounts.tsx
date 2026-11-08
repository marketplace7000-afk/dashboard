/**
 * «Цены» → «Заявки на скидку» (08.11.2026). Правила по товарам и заявки покупателей Ozon.
 * Логика и расчёт — на сервере (api/_lib/discounts.ts); здесь маржа при выбранной скидке
 * пересчитывается тем же калькулятором (src/utils/ozonProfit.ts), чтобы цифры менялись сразу.
 *
 * Решения владельца 08.11: режима «Менеджеры» нет — у товара «Одобрять» или «Отклонять», без
 * режима заявку обрабатывают вручную. Для «Одобрять» ограничение ОДНО: либо макс. скидка, либо
 * мин. маржа. Значения в ячейках по центру, шрифт на 1 крупнее «Рекламы», маржа с точностью 0,1 %.
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
  purchased: boolean;
};
/** Эффективность: одобрено → купили (is_purchased от Ozon). */
type Eff = { approved: number; bought: number; conv: number | null; revenue: number; avgPct: number | null };
type Stats = { since: string | null; w7: Eff; w30: Eff; agent: Eff; hand: Eff; products: (Eff & { article: string; name: string; photo: string })[] };
type Data = {
  settings: { auto: boolean; defaultMode: 'manual' | 'decline' }; canToggle: boolean;
  lastRun: number; lastError: string | null; lastSummary: string; products: Product[]; tasks: Task[]; stats?: Stats;
};

const nf = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
// Неразрывный пробел перед ₽ — знак рубля не уезжает на отдельную строку.
const rub = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? '—' : `${nf.format(Math.round(v))} ₽`);
const pctS = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? '—' : `${String(Math.round(v * 10) / 10).replace('.', ',')} %`);
/** Маржа — всегда с одной цифрой после запятой (просьба владельца 08.11). */
const pct1 = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? '—' : `${nf1.format(v)} %`);
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

const num = (s: string): number | null => { const t = s.trim().replace(',', '.'); if (t === '') return null; const n = Number(t); return Number.isFinite(n) ? n : null; };

type Filter = 'all' | 'requests' | 'norule' | 'approve' | 'decline';
const FILTERS: [Filter, string][] = [['all', 'Все'], ['requests', 'Есть заявки'], ['norule', 'Режим не выбран'], ['approve', 'Одобряем'], ['decline', 'Отклоняем']];
const MODES: [Mode, string][] = [['approve', 'Одобрять'], ['decline', 'Отклонять']];

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
  const auto = data.settings.auto;

  return (
    <div className="dr grid" style={{ gap: 16 }}>
      <div className="card dr-head">
        <div className="dr-head-main">
          <h2>Заявки на скидку · Ozon</h2>
          <div className="dr-sub">
            Новые заявки забираются с Ozon каждые 2 минуты. Последний раз: {data.lastRun ? time(data.lastRun) : 'ещё не было'}
            {data.lastError && <span className="dr-bad"> · ошибка: {data.lastError}</span>}
          </div>
        </div>
        <div className="dr-head-ctl">
          <label className={`dr-switch ${auto ? 'on' : ''} ${data.canToggle ? '' : 'locked'}`}
            title={data.canToggle ? '' : 'Включать и выключать автоответ может только владелец'}>
            <input type="checkbox" checked={auto} disabled={!data.canToggle}
              onChange={e => {
                if (e.target.checked && !window.confirm('Включить автоответ? Агент начнёт сам одобрять и отклонять заявки по правилам.')) return;
                void setSettings({ auto: e.target.checked });
              }} />
            <span className="dr-switch-track"><span className="dr-switch-dot" /></span>
            <span className="dr-switch-text">
              <span className="dr-switch-title">Автоматический режим</span>
              <span className="dr-switch-hint">{auto ? 'включён — агент сам отвечает на заявки по правилам' : 'выключен — агент только показывает, что сделал бы'}</span>
            </span>
          </label>
          <button className="btn" onClick={refresh} disabled={busy} title="Не ждать 2 минуты: сразу забрать новые заявки с Ozon (и ответить на них, если автоответ включён)">
            <ArrowClockwiseIcon size={18} /> {busy ? 'Забираю…' : 'Забрать заявки сейчас'}
          </button>
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
        Для «Одобрять» задаётся одно ограничение: либо максимальная скидка, либо минимальная маржа.
      </div>

      <div className="row gap-8" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
        <div className="sa-seg">
          <button className={view === 'products' ? 'active' : ''} onClick={() => setView('products')}>Товары и правила</button>
          <button className={view === 'tasks' ? 'active' : ''} onClick={() => setView('tasks')}>Заявки{pending.length ? ` · ждут ${pending.length}` : ''}</button>
        </div>
        <span className="dr-def">Режим не выбран — заявки по товару обрабатываются вручную в кабинете Ozon</span>
      </div>

      {view === 'products'
        ? <Products data={data} post={post} reload={load} />
        : <Tasks data={data} post={post} reload={load} />}
    </div>
  );
}

// ─── Товары и правила ───────────────────────────────────────────────────────

type PostFn = (path: string, body: object) => Promise<boolean>;
type SaveFn = (articles: string[], patch: Partial<Rule>) => Promise<void>;

function Products({ data, post, reload }: { data: Data; post: PostFn; reload: () => Promise<void> }) {
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [sel, setSel] = useState<Set<string>>(new Set());
  // Массовое правило: заполнено одно из двух полей — либо скидка, либо маржа.
  const [bulkPct, setBulkPct] = useState('');
  const [bulkMargin, setBulkMargin] = useState('');
  // Правки, ещё не дошедшие до сервера, — чтобы поле не прыгало при обновлении списка.
  const [local, setLocal] = useState<Record<string, Partial<Rule>>>({});

  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    return data.products
      .map(p => ({ ...p, rule: p.rule || local[p.article] ? { ...(p.rule ?? { article: p.article, mode: 'manual' as Mode, maxPct: null, minMargin: null, updatedAt: 0, updatedBy: '' }), ...local[p.article] } as Rule : null }))
      .filter(p => !s || p.article.toLowerCase().includes(s) || p.name.toLowerCase().includes(s))
      .filter(p => filter === 'all' ? true : filter === 'requests' ? p.req7 > 0 : filter === 'norule' ? !p.rule || p.rule.mode === 'manual' : p.rule?.mode === filter)
      .sort((a, b) => b.pending - a.pending || b.req7 - a.req7 || (b.showcase ?? 0) - (a.showcase ?? 0));
  }, [data.products, q, filter, local]);

  const save: SaveFn = async (articles, patch) => {
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
  const bulkApprove = () => {
    const p = num(bulkPct);
    void bulk({ mode: 'approve', maxPct: p, minMargin: p != null ? null : num(bulkMargin) });
    setBulkPct(''); setBulkMargin('');
  };

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
          <div className="dr-bulk-lead"><b>Выбрано: {sel.size}</b><span>правило для всех выбранных</span></div>
          <div className="dr-limits">
            <PctField label="Скидка до" value={bulkPct} dim={bulkMargin.trim() !== ''}
              onChange={v => { setBulkPct(v); if (v.trim()) setBulkMargin(''); }} />
            <span className="dr-or">или</span>
            <PctField label="Маржа не ниже" value={bulkMargin} dim={bulkPct.trim() !== ''}
              onChange={v => { setBulkMargin(v); if (v.trim()) setBulkPct(''); }} />
          </div>
          <button className="btn btn-primary" onClick={bulkApprove}>Одобрять</button>
          <span className="dr-sep" />
          <button className="btn" onClick={() => bulk({ mode: 'decline' })}>Отклонять</button>
          <button className="btn" onClick={() => bulk({ mode: 'manual' })}>Снять режим</button>
          <button className="btn" onClick={() => setSel(new Set())}><XIcon size={16} /> Снять выбор</button>
        </div>
      )}

      <div className="dr-table-wrap">
        <table className="dr-table">
          <thead>
            <tr>
              <th className="dr-cb"><input type="checkbox" checked={allSel} onChange={toggleAll} /></th>
              <th className="l">Товар</th>
              <th>На витрине</th>
              <th>Текущая<br />маржа</th>
              <th>Правило агента</th>
              <th>После скидки</th>
              <th>Заявок<br />за 7 дн</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(p => <ProductRow key={p.article} p={p} checked={sel.has(p.article)} onCheck={() => toggle(p.article)} save={save} />)}
            {!rows.length && <tr><td colSpan={7} className="dr-empty">Ничего не нашлось</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Поле процента: подпись сверху, окошко со знаком % снизу. dim — заполнено соседнее поле. */
function PctField({ label, value, onChange, onCommit, dim }: {
  label: string; value: string; onChange: (v: string) => void; onCommit?: () => void; dim?: boolean;
}) {
  return (
    <label className={`dr-field${dim ? ' dim' : ''}${value.trim() ? ' filled' : ''}`}>
      <span className="dr-field-label">{label}</span>
      <span className="dr-field-box">
        <input value={value} placeholder="—" inputMode="decimal" onChange={e => onChange(e.target.value)} onBlur={onCommit}
          onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
        <span className="dr-field-unit">%</span>
      </span>
    </label>
  );
}

/**
 * Ограничение «Одобрять» в строке товара: «Скидка до» или «Маржа не ниже» — одно из двух.
 * Заполненное поле очищает соседнее; сохраняется, когда курсор уходит из поля.
 */
function RuleLimits({ maxPct, minMargin, onSave }: {
  maxPct: number | null; minMargin: number | null; onSave: (patch: Partial<Rule>) => void;
}) {
  const show = (x: number | null) => (x == null ? '' : String(x).replace('.', ','));
  const [pct, setPct] = useState(show(maxPct));
  const [mar, setMar] = useState(show(minMargin));
  const editing = useRef(false);
  useEffect(() => { if (!editing.current) { setPct(show(maxPct)); setMar(show(minMargin)); } }, [maxPct, minMargin]);
  const ok = (s: string) => { const n = num(s); return s.trim() === '' || (n !== null && n >= 0 && n <= 90); };
  const commit = () => {
    editing.current = false;
    if (!ok(pct) || !ok(mar)) { setPct(show(maxPct)); setMar(show(minMargin)); return; }
    const np = num(pct);
    const nm = np != null ? null : num(mar);
    if (np !== maxPct || nm !== minMargin) onSave({ maxPct: np, minMargin: nm });
  };
  return (
    <div className="dr-limits" onFocus={() => { editing.current = true; }}>
      <PctField label="Скидка до" value={pct} dim={mar.trim() !== ''} onCommit={commit}
        onChange={v => { setPct(v); if (v.trim()) setMar(''); }} />
      <PctField label="Маржа не ниже" value={mar} dim={pct.trim() !== ''} onCommit={commit}
        onChange={v => { setMar(v); if (v.trim()) setPct(''); }} />
    </div>
  );
}

function ProductRow({ p, checked, onCheck, save }: { p: Product; checked: boolean; onCheck: () => void; save: SaveFn }) {
  const r = p.rule;
  const mode: Mode | null = r && r.mode !== 'manual' ? r.mode : null;
  const show = p.showcase ?? 0;

  // Сколько реально даст агент: по скидке — заданный процент; по марже — пока маржа не ниже порога.
  const eff = mode !== 'approve' ? null
    : r?.maxPct != null ? r.maxPct
    : r?.minMargin != null ? maxPctForMargin(p.input, r.minMargin) : null;
  const discPrice = eff != null && show > 0 ? Math.ceil(show * (1 - eff / 100)) : null;
  const newLk = eff != null && p.price ? Math.round(p.price * (1 - eff / 100)) : null;
  const m = eff != null ? marginAt(p.input, eff) : null;
  const cur = marginAt(p.input, 0);
  const curPct = cur?.pct ?? p.marginPct;

  return (
    <tr className={checked ? 'sel' : ''}>
      <td className="dr-cb"><input type="checkbox" checked={checked} onChange={onCheck} /></td>
      <td className="l">
        <div className="dr-prod">
          {p.photo ? <img src={p.photo} alt="" loading="lazy" /> : <span className="dr-noimg" />}
          <div>
            <div className="dr-name" title={p.name}>{p.name || p.article}</div>
            <div className="dr-art">{p.article}</div>
          </div>
        </div>
      </td>
      <td>
        <b>{rub(p.showcase)}</b>
        <div className="dr-cap">наша {rub(p.price)}</div>
      </td>
      <td>
        {curPct != null ? <><b className={tone(curPct)}>{pct1(curPct)}</b><div className="dr-cap">{rub(cur?.rub ?? p.marginRub)}</div></>
          : <span className="dr-cap">{p.cost ? '—' : 'нет себе­стоимости'}</span>}
      </td>
      <td>
        <div className="sa-seg dr-mode">
          {MODES.map(([k, l]) => (
            <button key={k} className={`${mode === k ? 'active' : ''} m-${k}`} title={mode === k ? 'Нажмите ещё раз, чтобы снять режим' : ''}
              onClick={() => save([p.article], { mode: mode === k ? 'manual' : k })}>{l}</button>
          ))}
        </div>
        {!mode && <div className="dr-cap">не выбран — вручную</div>}
        {mode === 'approve' && (
          <RuleLimits maxPct={r?.maxPct ?? null} minMargin={r?.minMargin ?? null} onSave={patch => save([p.article], patch)} />
        )}
      </td>
      <td>
        {discPrice == null ? <span className="dr-cap">—</span> : <>
          <div className="nw"><b>{rub(discPrice)}</b> <span className="dr-cap">−{pctS(eff)}</span></div>
          {m ? <>
            <div className={`dr-after ${tone(m.pct)}`}>маржа {pct1(m.pct)}</div>
            <div className="dr-cap">прибыль {rub(m.rub)}</div>
          </> : <div className="dr-cap">{p.cost ? '—' : 'нет себе­стоимости'}</div>}
          <div className="dr-cap">в кабинете {rub(newLk)}</div>
        </>}
      </td>
      <td>
        {p.req7 ? <b>{p.req7}</b> : <span className="dr-cap">0</span>}
        {p.pending > 0 && <div><span className="dr-pend">ждут {p.pending}</span></div>}
      </td>
    </tr>
  );
}

// ─── Заявки ─────────────────────────────────────────────────────────────────

const STATUS: Record<string, string> = { NEW: 'Новая', SEEN: 'Просмотрена', APPROVED: 'Одобрена', DECLINED: 'Отклонена', CLOSED: 'Закрыта Ozon' };

function Tasks({ data, post, reload }: { data: Data; post: PostFn; reload: () => Promise<void> }) {
  const [only, setOnly] = useState<'pending' | 'all' | 'eff'>('pending');
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
    <div className="card dr-card dr-tasks">
      <div className="dr-tools">
        <div className="sa-seg">
          <button className={only === 'pending' ? 'active' : ''} onClick={() => setOnly('pending')}>Ждут ответа</button>
          <button className={only === 'all' ? 'active' : ''} onClick={() => setOnly('all')}>Все за 7 дней</button>
          <button className={only === 'eff' ? 'active' : ''} onClick={() => setOnly('eff')}>Эффективность скидок</button>
        </div>
      </div>
      {only === 'eff' ? <Effect stats={data.stats} /> : (
      <div className="dr-table-wrap">
        <table className="dr-table">
          <thead>
            <tr>
              <th>Когда</th>
              <th className="l">Товар</th>
              <th>На витрине</th>
              <th>Текущая<br />маржа</th>
              <th>Просит</th>
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
              // Маржа сейчас — при нашей цене в ЛК, без скидки покупателю.
              const curM = marginAt(p?.input ?? null, 0);
              const curPct = curM?.pct ?? p?.marginPct ?? null;
              return (
                <tr key={t.id}>
                  <td><div className="nw">{time(t.createdAt)}</div><div className="dr-cap">{t.customer}</div></td>
                  <td className="l">
                    <div className="dr-prod">
                      {p?.photo ? <img src={p.photo} alt="" loading="lazy" /> : <span className="dr-noimg" />}
                      <div>
                        <div className="dr-name" title={p?.name}>{p?.name || t.article}</div>
                        <div className="dr-art">{t.article}{t.qtyMax > 1 ? ` · ${t.qtyMin}–${t.qtyMax} шт` : ''}</div>
                        {t.comment && <div className="dr-cap">«{t.comment}»</div>}
                      </div>
                    </div>
                  </td>
                  <td><b>{rub(t.showcase)}</b><div className="dr-cap nw">наша {rub(p?.price ?? t.base)}</div></td>
                  <td>
                    {curPct != null
                      ? <><b className={tone(curPct)}>{pct1(curPct)}</b><div className="dr-cap nw">{rub(curM?.rub ?? p?.marginRub)}</div></>
                      : <span className="dr-cap">—</span>}
                  </td>
                  <td>
                    <b>{rub(t.requested)}</b>
                    <div className="dr-cap nw">−{pctS(t.requestedPct)}</div>
                    {askM && <div className={`dr-cap nw ${tone(askM.pct)}`}>маржа {pct1(askM.pct)}</div>}
                  </td>
                  <td className="dr-dec">
                    {d ? (
                      <div>
                        <span className={`dr-badge ${d.action}`}>
                          {d.action === 'approve' ? `Одобрить ${rub(d.price)}` : d.action === 'decline' ? 'Отклонить' : 'Вручную'}
                        </span>
                        {d.action === 'approve' && d.marginPct != null && <div className={`dr-m ${tone(d.marginPct)}`}>маржа {pct1(d.marginPct)}</div>}
                        <div className="dr-cap">{d.reason}</div>
                      </div>
                    ) : <span className="dr-cap">—</span>}
                  </td>
                  <td className="dr-st">
                    <span className={`dr-status s-${t.status}`}>{STATUS[t.status] ?? t.status}</span>
                    {t.purchased && <div><span className="dr-bought">Купил</span></div>}
                    {t.approvedPrice && t.status === 'APPROVED' ? <div className="dr-cap"><span className="nw">по {rub(t.approvedPrice)}</span>{t.showcase > 0 ? <span className="nw"> (−{pctS(Math.round((1 - t.approvedPrice / t.showcase) * 1000) / 10)})</span> : null}</div> : null}
                    {!pend && t.status !== 'CLOSED' && <div className="dr-cap">{t.by === 'agent' ? 'ответил агент' : t.by === 'user' ? `с сайта: ${t.byName}` : 'в кабинете Ozon'}</div>}
                    {t.error && <div className="dr-bad dr-cap">Ozon: {t.error}</div>}
                  </td>
                  <td className="nw">
                    {pend && (
                      <div className="dr-acts">
                        <button className="btn btn-primary" disabled={busyId === t.id}
                          onClick={() => act(t, 'approve', d?.action === 'approve' && d.price ? d.price : Math.round(t.requested))}>
                          <CheckIcon size={17} /> Одобрить<span className="dr-btn-price">{rub(d?.action === 'approve' && d.price ? d.price : t.requested)}</span>
                        </button>
                        <button className="btn" disabled={busyId === t.id} onClick={() => act(t, 'decline')}><XIcon size={17} /> Отклонить</button>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
            {!list.length && <tr><td colSpan={8} className="dr-empty">{only === 'pending' ? 'Новых заявок нет' : 'За 7 дней заявок нет'}</td></tr>}
          </tbody>
        </table>
      </div>
      )}
    </div>
  );
}

/** «Эффективность скидок»: сколько одобренных заявок закончились покупкой. */
function Effect({ stats }: { stats?: Stats }) {
  if (!stats) return <div className="dr-empty">Нет данных</div>;
  const Tile = ({ label, e }: { label: string; e: Eff }) => (
    <div className="dr-eff-tile">
      <div className="dr-tile-label">{label}</div>
      <div className="dr-eff-main"><b>{e.conv == null ? '—' : pctS(e.conv)}</b><span>купили</span></div>
      <div className="dr-cap">одобрено {e.approved} · купили {e.bought}</div>
      <div className="dr-cap">средняя скидка {e.avgPct == null ? '—' : pctS(e.avgPct)} · выручка {rub(e.revenue)}</div>
    </div>
  );
  return (
    <div className="dr-eff">
      <div className="dr-eff-tiles">
        <Tile label="За 7 дней" e={stats.w7} />
        <Tile label="За 30 дней" e={stats.w30} />
        <Tile label="Ответил агент (30 дн)" e={stats.agent} />
        <Tile label="Вручную: кабинет и сайт (30 дн)" e={stats.hand} />
      </div>
      <div className="dr-note">
        «Купили» — Ozon отмечает у одобренной заявки, что покупатель оформил заказ по одобренной цене.
        Отметка может появиться не сразу — сайт перепроверяет одобренные заявки раз в час.
        {stats.since ? ` Данные собираются с ${time(stats.since)}.` : ''}
      </div>
      <div className="dr-table-wrap">
        <table className="dr-table">
          <thead><tr>
            <th className="l">Товар</th><th>Одобрено<br />заявок</th><th>Купили</th><th>Конверсия</th><th>Средняя<br />скидка</th><th>Выручка<br />по скидке</th>
          </tr></thead>
          <tbody>
            {stats.products.map(p => (
              <tr key={p.article}>
                <td className="l"><div className="dr-prod">
                  {p.photo ? <img src={p.photo} alt="" loading="lazy" /> : <span className="dr-noimg" />}
                  <div><div className="dr-name" title={p.name}>{p.name || p.article}</div><div className="dr-art">{p.article}</div></div>
                </div></td>
                <td><b>{p.approved}</b></td>
                <td><b className={p.bought ? 'good' : ''}>{p.bought}</b></td>
                <td><b>{p.conv == null ? '—' : pctS(p.conv)}</b></td>
                <td>{p.avgPct == null ? '—' : pctS(p.avgPct)}</td>
                <td>{p.bought ? rub(p.revenue) : '—'}</td>
              </tr>
            ))}
            {!stats.products.length && <tr><td colSpan={6} className="dr-empty">За 30 дней одобренных заявок нет</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
