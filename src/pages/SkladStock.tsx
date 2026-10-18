/**
 * «Склад», этап 2: остатки, журнал движений (приход, списание, перемещения),
 * инвентаризация сканером и перенос истории из Google-таблицы.
 */
import { useEffect, useMemo, useState } from 'react';
import { PlusIcon, MinusIcon, ArrowsLeftRightIcon, WarningIcon, CheckIcon, TrashIcon, ArrowCounterClockwiseIcon } from '@phosphor-icons/react';
import {
  sklad2, skladErr, type Bootstrap, type Product, type StockData, type Movement, type Inventory, type InventoryBrief,
  type HistoryReport, type ReconcileReport, type LineInput,
} from '../api/sklad';
import { Modal, Field, ScanInput, fmtDate, fmtDay, fmtNum } from '../components/SkladUi';

const canFix = (b: Bootstrap) => b.me.role === 'owner' || b.me.role === 'manager';
const money = (b: Bootstrap) => b.me.role !== 'warehouse';
const kindLabel = (b: Bootstrap, k: string) => b.dict.kinds.find(x => x.value === k)?.label ?? k;
const whName = (b: Bootstrap, id: number | null) => (id ? b.warehouses.find(w => w.id === id)?.name ?? `склад #${id}` : '');

// ─── Остатки ───────────────────────────────────────────────────────────────
export function StockTab({ data, onOpenProduct }: { data: Bootstrap; onOpenProduct: (p: Product) => void }) {
  const [st, setSt] = useState<StockData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [wh, setWh] = useState<number | 'all'>('all');
  const load = () => sklad2.stock().then(setSt).catch(e => setErr(skladErr(e)));
  useEffect(() => { load(); }, []);

  const whs = data.warehouses.filter(w => w.active && (wh === 'all' || w.id === wh));
  const rows = useMemo(() => {
    if (!st) return [];
    const byP = new Map<number, { stock: Map<number, number>; transit: Map<number, number> }>();
    const get = (pid: number) => byP.get(pid) ?? byP.set(pid, { stock: new Map(), transit: new Map() }).get(pid)!;
    for (const s of st.stock) get(s.productId).stock.set(s.whId, s.qty);
    for (const t of st.inTransit) get(t.productId).transit.set(t.toWhId, t.qty);
    const s = q.trim().toLowerCase();
    const digits = s.replace(/\D+/g, '');
    return data.products.filter(p => byP.has(p.id)).filter(p => !s || p.article.toLowerCase().includes(s) || p.name.toLowerCase().includes(s)
      || (digits.length >= 4 && p.barcodes.some(b => b.barcode.includes(digits))))
      .map(p => ({ p, ...byP.get(p.id)! }))
      .filter(r => whs.some(w => (r.stock.get(w.id) ?? 0) !== 0 || (r.transit.get(w.id) ?? 0) !== 0));
  }, [st, q, wh, data.products]);

  if (err) return <div className="card sk-err"><WarningIcon size={16} /> {err}</div>;
  if (!st) return <div className="card muted">Считаю остатки…</div>;
  const total = (r: typeof rows[number]) => whs.reduce((s, w) => s + (r.stock.get(w.id) ?? 0), 0);
  const negatives = rows.filter(r => whs.some(w => (r.stock.get(w.id) ?? 0) < 0)).length;
  return (
    <>
      <div className="sk-toolbar">
        <div className="sk-search"><input className="input" placeholder="Артикул, название или баркод" value={q} onChange={e => setQ(e.target.value)} /></div>
        {data.warehouses.length > 1 && (
          <select className="input sk-select" value={wh} onChange={e => setWh(e.target.value === 'all' ? 'all' : Number(e.target.value))}>
            <option value="all">Все склады</option>
            {data.warehouses.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        )}
        <button className="btn" onClick={load}>Обновить</button>
      </div>
      {!st.stock.length && <div className="card muted">Движений пока нет. Остатки появятся после переноса истории из таблицы (вкладка «Перенос из таблицы») или первого прихода.</div>}
      {negatives > 0 && <div className="sk-hints"><span className="chip bad">Отрицательный остаток: {negatives} — расход без прихода, проверьте журнал</span></div>}
      {st.stock.length > 0 && (
        <div className="card sk-table-card">
          <div className="sk-scroll">
            <table className="sk-table">
              <thead><tr><th>Артикул / название</th><th>Баркод</th>{whs.map(w => <th key={w.id} className="num">{w.name}</th>)}{whs.length > 1 && <th className="num">Всего</th>}</tr></thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.p.id} onClick={() => onOpenProduct(r.p)} className={r.p.status === 'archived' ? 'sk-row-muted' : ''}>
                    <td><div className="sk-art">{r.p.article}</div><div className="muted sk-name">{r.p.name || '—'}</div></td>
                    <td className="sk-mono">{r.p.barcodes[0]?.barcode ?? '—'}</td>
                    {whs.map(w => {
                      const s = r.stock.get(w.id) ?? 0;
                      const t = r.transit.get(w.id) ?? 0;
                      return <td key={w.id} className={`num ${s < 0 ? 'sk-bad' : ''}`}>{s || (t ? '0' : '·')}{t ? <div className="muted sk-transit">+{t} в пути</div> : null}</td>;
                    })}
                    {whs.length > 1 && <td className="num"><b>{total(r)}</b></td>}
                  </tr>
                ))}
                {!rows.length && <tr><td colSpan={whs.length + 3} className="muted sk-empty">Ничего не найдено</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}

// ─── Журнал движений ───────────────────────────────────────────────────────
export function MovesTab({ data, productFilter, clearProductFilter }: { data: Bootstrap; productFilter?: Product | null; clearProductFilter?: () => void }) {
  const [list, setList] = useState<{ items: Movement[]; total: number } | null>(null);
  const [incoming, setIncoming] = useState<Movement[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [wh, setWh] = useState<number | ''>('');
  const [kind, setKind] = useState('');
  const [q, setQ] = useState('');
  const [limit, setLimit] = useState(100);
  const [modal, setModal] = useState<'in' | 'out' | 'transfer' | null>(null);
  const [receive, setReceive] = useState<Movement | null>(null);
  const [fix, setFix] = useState<Movement | null>(null);

  const load = () => {
    sklad2.movements({ whId: wh, kind, q, productId: productFilter?.id, limit }).then(setList).catch(e => setErr(skladErr(e)));
    sklad2.movements({ inTransit: 1, limit: 200 }).then(r => setIncoming(r.items)).catch(() => setIncoming([]));
  };
  useEffect(() => { load(); }, [wh, kind, productFilter?.id, limit]);
  const mine = (id: number | null) => !!id && (!data.me.warehouseIds || data.me.warehouseIds.includes(id));

  return (
    <>
      <div className="sk-toolbar">
        <button className="btn btn-primary" onClick={() => setModal('in')}><PlusIcon size={16} /> Приход</button>
        <button className="btn" onClick={() => setModal('out')}><MinusIcon size={16} /> Расход / списание</button>
        <button className="btn" onClick={() => setModal('transfer')}><ArrowsLeftRightIcon size={16} /> Перемещение</button>
        <span className="sk-spacer" />
        {productFilter && <span className="chip info">Товар: {productFilter.article} <button className="btn btn-sm" onClick={clearProductFilter}>×</button></span>}
      </div>

      {incoming.filter(m => mine(m.counterWh)).length > 0 && (
        <div className="card sk-incoming">
          <div className="field-label">Едет к вам — примите, когда товар приедет</div>
          {incoming.filter(m => mine(m.counterWh)).map(m => (
            <div key={m.id} className="sk-incoming-row">
              <span><b>{whName(data, m.whId)} → {whName(data, m.counterWh)}</b> · отправлено {fmtDay(m.ts)} · {m.lines.map(l => `${l.article} × ${l.qty}`).join(', ')}</span>
              <button className="btn btn-sm btn-primary" onClick={() => setReceive(m)}>Принять</button>
            </div>
          ))}
        </div>
      )}

      <div className="sk-toolbar">
        <select className="input sk-select" value={wh} onChange={e => setWh(e.target.value ? Number(e.target.value) : '')}>
          <option value="">Все склады</option>
          {data.warehouses.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
        </select>
        <select className="input sk-select" value={kind} onChange={e => setKind(e.target.value)}>
          <option value="">Все операции</option>
          {data.dict.kinds.map(k => <option key={k.value} value={k.value}>{k.label}</option>)}
        </select>
        <div className="sk-search"><input className="input" placeholder="№ заказа, артикул, баркод, комментарий" value={q} onChange={e => setQ(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') load(); }} /></div>
        <button className="btn" onClick={load}>Найти</button>
      </div>

      {err && <div className="sk-err"><WarningIcon size={14} /> {err}</div>}
      {!list ? <div className="card muted">Загрузка…</div> : (
        <div className="card sk-table-card">
          <div className="sk-scroll">
            <table className="sk-table sk-moves">
              <thead><tr><th>Дата</th><th>Склад</th><th>Операция</th><th>Товары</th><th>№ / комментарий</th><th>Кто</th>{canFix(data) && <th />}</tr></thead>
              <tbody>
                {list.items.map(m => (
                  <tr key={m.id} className={m.reversed ? 'sk-row-muted' : ''}>
                    <td className="sk-nowrap">{fmtDay(m.ts)}</td>
                    <td>{whName(data, m.whId)}</td>
                    <td>
                      <span className={`chip ${m.kind === 'storno' ? 'warn' : m.sign > 0 ? 'good' : ''}`}>{kindLabel(data, m.kind)}</span>
                      {m.counterpart && <div className="muted sk-name">{m.sign > 0 ? 'от: ' : 'куда: '}{m.counterpart}</div>}
                      {m.status === 'in_transit' && <div className="chip info sk-mt">в пути</div>}
                      {m.reversed && <div className="chip sk-mt">исправлено</div>}
                    </td>
                    <td>{m.lines.map(l => (
                      <div key={l.productId} className="sk-line"><b className={m.sign > 0 ? 'sk-plus' : 'sk-minus'}>{m.sign > 0 ? '+' : '−'}{Math.abs(l.qty)}</b> {l.article}
                        {l.price && money(data) ? <span className="muted"> × {fmtNum(l.price)} ₽</span> : null}</div>
                    ))}</td>
                    <td><div>{m.ref}</div><div className="muted sk-name">{m.note}</div></td>
                    <td className="muted sk-name">{m.createdName}</td>
                    {canFix(data) && <td>{!m.reversed && m.kind !== 'storno' && <button className="btn btn-sm" title="Исправить ошибку обратным движением" onClick={() => setFix(m)}><ArrowCounterClockwiseIcon size={14} /></button>}</td>}
                  </tr>
                ))}
                {!list.items.length && <tr><td colSpan={7} className="muted sk-empty">Движений нет</td></tr>}
              </tbody>
            </table>
          </div>
          {list.total > list.items.length && <div className="sk-more"><button className="btn btn-sm" onClick={() => setLimit(l => l + 200)}>Показать ещё (всего {list.total})</button></div>}
        </div>
      )}

      {modal && <MovementModal data={data} mode={modal} onClose={() => setModal(null)} onDone={() => { setModal(null); load(); }} />}
      {receive && <ReceiveModal data={data} m={receive} onClose={() => setReceive(null)} onDone={() => { setReceive(null); load(); }} />}
      {fix && <FixModal m={fix} data={data} onClose={() => setFix(null)} onDone={() => { setFix(null); load(); }} />}
    </>
  );
}

type Line = { product: Product; qty: string; price: string };

function LinesEditor({ data, lines, setLines, withPrice }: { data: Bootstrap; lines: Line[]; setLines: (l: Line[]) => void; withPrice: boolean }) {
  const add = (p: Product) => {
    const i = lines.findIndex(l => l.product.id === p.id);
    if (i >= 0) { const next = [...lines]; next[i] = { ...next[i], qty: String((Number(next[i].qty) || 0) + 1) }; setLines(next); }
    else setLines([{ product: p, qty: '1', price: '' }, ...lines]);
  };
  return (
    <>
      <ScanInput products={data.products} onPick={add} autoFocus />
      {lines.length > 0 && (
        <table className="sk-table sk-lines">
          <thead><tr><th>Товар</th><th className="num">Кол-во</th>{withPrice && <th className="num">Цена за шт., ₽</th>}<th /></tr></thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={l.product.id}>
                <td><b>{l.product.article}</b><div className="muted sk-name">{l.product.name}</div></td>
                <td className="num"><input className="input sk-qty" inputMode="numeric" value={l.qty} onChange={e => { const n = [...lines]; n[i] = { ...l, qty: e.target.value }; setLines(n); }} /></td>
                {withPrice && <td className="num"><input className="input sk-qty" inputMode="decimal" value={l.price} onChange={e => { const n = [...lines]; n[i] = { ...l, price: e.target.value }; setLines(n); }} /></td>}
                <td><button className="btn btn-sm" onClick={() => setLines(lines.filter((_, j) => j !== i))} title="Убрать"><TrashIcon size={14} /></button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

function MovementModal({ data, mode, onClose, onDone }: { data: Bootstrap; mode: 'in' | 'out' | 'transfer'; onClose: () => void; onDone: () => void }) {
  const kinds = data.dict.kinds.filter(k => k.canPost && (mode === 'in' ? k.sign > 0 : k.sign < 0));
  const myWhs = data.warehouses.filter(w => w.active && (!data.me.warehouseIds || data.me.warehouseIds.includes(w.id)));
  const [kind, setKind] = useState(kinds[0]?.value ?? '');
  const [whId, setWhId] = useState<number>(myWhs[0]?.id ?? 0);
  const [toWhId, setToWhId] = useState<number>(data.warehouses.find(w => w.active && w.id !== myWhs[0]?.id)?.id ?? 0);
  const [lines, setLines] = useState<Line[]>([]);
  const [note, setNote] = useState('');
  const [ref, setRef] = useState('');
  const [counterpart, setCounterpart] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const withPrice = mode === 'in' && kind === 'purchase';
  const save = async () => {
    setBusy(true); setErr(null);
    const ls: LineInput[] = lines.map(l => ({ productId: l.product.id, qty: Number(l.qty), price: withPrice ? l.price : null }));
    try {
      if (mode === 'transfer') await sklad2.sendTransfer({ whId, toWhId, lines: ls, note, ref });
      else await sklad2.postMovement({ kind, whId, lines: ls, note, ref, counterpart });
      onDone();
    } catch (e) { setErr(skladErr(e)); } finally { setBusy(false); }
  };
  const title = mode === 'in' ? 'Приход на склад' : mode === 'out' ? 'Расход / списание' : 'Перемещение на другой склад';
  return (
    <Modal title={title} onClose={onClose} wide>
      <div className="grid grid-2">
        <Field label={mode === 'transfer' ? 'Откуда' : 'Склад'}>
          <select className="input" value={whId} onChange={e => setWhId(Number(e.target.value))}>{myWhs.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}</select>
        </Field>
        {mode === 'transfer' ? (
          <Field label="Куда"><select className="input" value={toWhId} onChange={e => setToWhId(Number(e.target.value))}>
            {data.warehouses.filter(w => w.active && w.id !== whId).map(w => <option key={w.id} value={w.id}>{w.name}</option>)}</select></Field>
        ) : (
          <Field label="Операция"><select className="input" value={kind} onChange={e => setKind(e.target.value)}>{kinds.map(k => <option key={k.value} value={k.value}>{k.label}</option>)}</select></Field>
        )}
      </div>
      {mode === 'transfer' && <div className="muted sk-hint">Товар спишется с отправителя и будет «в пути», пока получатель не примет его по факту.</div>}
      <LinesEditor data={data} lines={lines} setLines={setLines} withPrice={withPrice} />
      <div className="grid grid-2">
        {mode === 'in' && kind === 'purchase' && <Field label="Поставщик / карго"><input className="input" value={counterpart} onChange={e => setCounterpart(e.target.value)} /></Field>}
        <Field label="№ документа, заказа, поставки"><input className="input" value={ref} onChange={e => setRef(e.target.value)} /></Field>
        <Field label={kind === 'writeoff' ? 'Причина (обязательно)' : 'Комментарий'}><input className="input" value={note} onChange={e => setNote(e.target.value)} /></Field>
      </div>
      {err && <div className="sk-err"><WarningIcon size={14} /> {err}</div>}
      <div className="row gap-8 sk-actions">
        <button className="btn btn-primary" disabled={busy || !lines.length} onClick={save}>{busy ? 'Провожу…' : mode === 'transfer' ? 'Отправить' : 'Провести'}</button>
        <button className="btn" onClick={onClose}>Отмена</button>
      </div>
    </Modal>
  );
}

function ReceiveModal({ data, m, onClose, onDone }: { data: Bootstrap; m: Movement; onClose: () => void; onDone: () => void }) {
  const [fact, setFact] = useState<Record<number, string>>(Object.fromEntries(m.lines.map(l => [l.productId, String(l.qty)])));
  const [note, setNote] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const diff = m.lines.some(l => Number(fact[l.productId]) !== l.qty);
  const save = () => sklad2.receiveTransfer(m.id, m.lines.map(l => ({ productId: l.productId, qty: Number(fact[l.productId]) || 0 })), note)
    .then(onDone).catch(e => setErr(skladErr(e)));
  return (
    <Modal title={`Приёмка: ${whName(data, m.whId)} → ${whName(data, m.counterWh)}`} onClose={onClose}>
      <p className="muted">Отправлено {fmtDate(m.ts)}{m.ref ? ` · ${m.ref}` : ''}. Впишите, сколько реально приехало.</p>
      <table className="sk-table sk-lines">
        <thead><tr><th>Товар</th><th className="num">Отправлено</th><th className="num">Принято</th></tr></thead>
        <tbody>{m.lines.map(l => (
          <tr key={l.productId}><td><b>{l.article}</b><div className="muted sk-name sk-mono">{l.barcode}</div></td><td className="num">{l.qty}</td>
            <td className="num"><input className="input sk-qty" inputMode="numeric" value={fact[l.productId]} onChange={e => setFact({ ...fact, [l.productId]: e.target.value })} /></td></tr>
        ))}</tbody>
      </table>
      {diff && <Field label="Что случилось с разницей"><input className="input" value={note} onChange={e => setNote(e.target.value)} placeholder="Например: 1 шт. повреждена" /></Field>}
      {err && <div className="sk-err"><WarningIcon size={14} /> {err}</div>}
      <div className="row gap-8 sk-actions"><button className="btn btn-primary" onClick={save}><CheckIcon size={16} /> Принять</button><button className="btn" onClick={onClose}>Отмена</button></div>
    </Modal>
  );
}

function FixModal({ data, m, onClose, onDone }: { data: Bootstrap; m: Movement; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<string | null>(null);
  return (
    <Modal title={`Исправить движение №${m.id}`} onClose={onClose}>
      <p>{kindLabel(data, m.kind)} · {whName(data, m.whId)} · {fmtDate(m.ts)}<br />{m.lines.map(l => `${l.article} × ${l.qty}`).join(', ')}</p>
      <p className="muted">Движение не удаляется: проводится обратное (сторно), и остаток возвращается как было. Обе записи остаются в журнале.</p>
      <Field label="Причина"><input className="input" value={reason} onChange={e => setReason(e.target.value)} autoFocus /></Field>
      {err && <div className="sk-err"><WarningIcon size={14} /> {err}</div>}
      <div className="row gap-8 sk-actions">
        <button className="btn btn-bad" onClick={() => sklad2.reverse(m.id, reason).then(onDone).catch(e => setErr(skladErr(e)))}>Сторнировать</button>
        <button className="btn" onClick={onClose}>Отмена</button>
      </div>
    </Modal>
  );
}

// ─── Инвентаризация ────────────────────────────────────────────────────────
export function InventoryTab({ data }: { data: Bootstrap }) {
  const myWhs = data.warehouses.filter(w => w.active && (!data.me.warehouseIds || data.me.warehouseIds.includes(w.id)));
  const [list, setList] = useState<InventoryBrief[] | null>(null);
  const [cur, setCur] = useState<Inventory | null>(null);
  const [whId, setWhId] = useState<number>(myWhs[0]?.id ?? 0);
  const [err, setErr] = useState<string | null>(null);
  const loadList = () => sklad2.inventories().then(setList).catch(e => setErr(skladErr(e)));
  useEffect(() => { loadList(); }, []);
  const open = (id: number) => sklad2.inventory(id).then(setCur).catch(e => setErr(skladErr(e)));
  const start = () => sklad2.createInventory(whId, false).then(setCur).catch(e => setErr(skladErr(e)));

  if (cur) return <InventorySheet data={data} inv={cur} setInv={setCur} onBack={() => { setCur(null); loadList(); }} />;
  return (
    <>
      <div className="card">
        <h2>Инвентаризация</h2>
        <p className="muted">Выберите склад и начните. Сканируйте баркод каждой единицы (или впишите количество руками) — сайт сам покажет, сколько должно быть, и разницу. Считать можно частями: всё сохраняется сразу.</p>
        <div className="sk-toolbar">
          <select className="input sk-select" value={whId} onChange={e => setWhId(Number(e.target.value))}>{myWhs.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}</select>
          <button className="btn btn-primary" onClick={start} disabled={!whId}>Начать / продолжить</button>
        </div>
        {err && <div className="sk-err"><WarningIcon size={14} /> {err}</div>}
      </div>
      {list && list.length > 0 && (
        <div className="card sk-table-card">
          <table className="sk-table">
            <thead><tr><th>№</th><th>Склад</th><th>Статус</th><th className="num">Позиций</th><th>Начал</th><th>Провёл</th></tr></thead>
            <tbody>{list.map(i => (
              <tr key={i.id} onClick={() => open(i.id)}>
                <td>{i.id}</td><td>{whName(data, i.whId)}</td>
                <td><span className={`chip ${i.status === 'done' ? 'good' : i.status === 'draft' ? 'info' : ''}`}>{i.status === 'done' ? 'проведена' : i.status === 'draft' ? 'идёт' : 'отменена'}</span></td>
                <td className="num">{i.linesCount}</td><td className="muted">{i.createdName} · {fmtDay(i.createdAt)}</td><td className="muted">{i.doneAt ? `${i.doneName} · ${fmtDay(i.doneAt)}` : '—'}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </>
  );
}

function InventorySheet({ data, inv, setInv, onBack }: { data: Bootstrap; inv: Inventory; setInv: (i: Inventory) => void; onBack: () => void }) {
  const [err, setErr] = useState<string | null>(null);
  const [last, setLast] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [done, setDone] = useState<{ plus: number; minus: number } | null>(null);
  const [showUncounted, setShowUncounted] = useState(false);
  const draft = inv.status === 'draft';
  const call = (p: Promise<Inventory>) => p.then(i => { setInv(i); setErr(null); }).catch(e => setErr(skladErr(e)));
  const scan = (p: Product) => {
    sklad2.count(inv.id, p.id, 1, true).then(i => {
      setInv(i); setErr(null);
      setLast(`${p.article}: +1, всего ${i.lines.find(l => l.productId === p.id)?.counted ?? 1} шт.`);
    }).catch(e => setErr(skladErr(e)));
  };
  const setQty = (pid: number, v: string) => { const n = Number(v); if (Number.isInteger(n) && n >= 0) call(sklad2.count(inv.id, pid, n)); };
  const plus = inv.lines.reduce((s, l) => s + Math.max(0, l.diff), 0);
  const minus = inv.lines.reduce((s, l) => s + Math.max(0, -l.diff), 0) + (inv.fullCount ? inv.uncounted.reduce((s, u) => s + Math.max(0, u.expected), 0) : 0);
  const prod = (pid: number) => data.products.find(p => p.id === pid);

  return (
    <>
      <div className="sk-toolbar">
        <button className="btn" onClick={onBack}>← К списку</button>
        <h2 className="sk-h">Инвентаризация №{inv.id} · {whName(data, inv.whId)}</h2>
        <span className={`chip ${draft ? 'info' : inv.status === 'done' ? 'good' : ''}`}>{draft ? 'идёт' : inv.status === 'done' ? `проведена ${fmtDate(inv.doneAt)}` : 'отменена'}</span>
      </div>
      {draft && (
        <div className="card">
          <ScanInput products={data.products} onPick={scan} autoFocus placeholder="Сканируйте баркод — каждое сканирование +1 шт." />
          {last && <div className="chip good sk-mt">{last}</div>}
          <div className="sk-toolbar sk-mt">
            <label className="row gap-8"><input type="checkbox" checked={inv.fullCount} onChange={e => call(sklad2.updateInventory(inv.id, { fullCount: e.target.checked }))} />
              Полная инвентаризация — всё, что не посчитано, списать в ноль</label>
          </div>
          <div className="muted sk-hint">«Ожидается» = остаток + несобранные заказы (они уже списаны при заказе, но физически ещё на полке).</div>
        </div>
      )}
      {err && <div className="sk-err"><WarningIcon size={14} /> {err}</div>}
      {done && <div className="card"><span className="chip good">Проведено: излишек +{done.plus}, недостача −{done.minus}</span></div>}

      <div className="card sk-table-card">
        <div className="sk-scroll">
          <table className="sk-table">
            <thead><tr><th>Товар</th><th>Баркод</th><th>Д×Ш×В, вес</th><th className="num">Ожидается</th><th className="num">Посчитано</th><th className="num">Разница</th>{draft && <th />}</tr></thead>
            <tbody>
              {inv.lines.map(l => {
                const p = prod(l.productId);
                return (
                  <tr key={l.productId}>
                    <td><b>{l.article}</b><div className="muted sk-name">{l.name}</div></td>
                    <td className="sk-mono">{l.barcode || '—'}</td>
                    <td className="muted sk-name">{p?.lengthCm ? `${fmtNum(p.lengthCm)}×${fmtNum(p.widthCm)}×${fmtNum(p.heightCm)} см` : '—'}{p?.weightG ? `, ${fmtNum(p.weightG)} г` : ''}</td>
                    <td className="num">{l.expected}{l.pending ? <div className="muted sk-transit">в т.ч. {l.pending} в заказах</div> : null}</td>
                    <td className="num">{draft ? <input className="input sk-qty" inputMode="numeric" defaultValue={l.counted} key={l.counted} onBlur={e => e.target.value !== String(l.counted) && setQty(l.productId, e.target.value)} /> : l.counted}</td>
                    <td className={`num ${l.diff > 0 ? 'sk-plus' : l.diff < 0 ? 'sk-minus' : ''}`}><b>{l.diff > 0 ? `+${l.diff}` : l.diff}</b></td>
                    {draft && <td><button className="btn btn-sm" title="Убрать из подсчёта" onClick={() => call(sklad2.count(inv.id, l.productId, 0, false, true))}><TrashIcon size={14} /></button></td>}
                  </tr>
                );
              })}
              {!inv.lines.length && <tr><td colSpan={7} className="muted sk-empty">Пока ничего не посчитано — начните сканировать</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      {draft && inv.uncounted.length > 0 && (
        <div className="card">
          <button className="btn btn-sm" onClick={() => setShowUncounted(s => !s)}>{showUncounted ? 'Скрыть' : 'Показать'} непосчитанное ({inv.uncounted.length}){inv.fullCount ? ' — спишется в ноль' : ''}</button>
          {showUncounted && <div className="sk-uncounted">{inv.uncounted.map(u => <div key={u.productId} className="sk-line"><b>{u.article}</b> <span className="muted">{u.barcode}</span> — ожидается {u.expected}</div>)}</div>}
        </div>
      )}

      {draft && (
        <div className="row gap-8 sk-actions">
          <button className="btn btn-primary" onClick={() => setConfirm(true)} disabled={!inv.lines.length && !inv.fullCount}>Провести инвентаризацию</button>
          <button className="btn" onClick={() => call(sklad2.updateInventory(inv.id, { cancel: true }))}>Отменить</button>
        </div>
      )}
      {confirm && (
        <Modal title="Провести инвентаризацию?" onClose={() => setConfirm(false)}>
          <p>Излишек: <b className="sk-plus">+{plus}</b> шт. · недостача: <b className="sk-minus">−{minus}</b> шт.</p>
          <p className="muted">Разница будет проведена движениями «Инвентаризация», остатки на складе станут равны посчитанному.</p>
          <div className="row gap-8 sk-actions">
            <button className="btn btn-primary" onClick={() => sklad2.finishInventory(inv.id).then(r => { setInv(r.inventory); setDone({ plus: r.plus, minus: r.minus }); setConfirm(false); }).catch(e => { setErr(skladErr(e)); setConfirm(false); })}>Провести</button>
            <button className="btn" onClick={() => setConfirm(false)}>Отмена</button>
          </div>
        </Modal>
      )}
    </>
  );
}

// ─── Перенос из таблицы ────────────────────────────────────────────────────
export function HistoryTab({ data, reload }: { data: Bootstrap; reload: () => void }) {
  const [status, setStatus] = useState<{ importedAt: number | null; cutoverAt: number | null; reconcile: ReconcileReport | null } | null>(null);
  const [rep, setRep] = useState<HistoryReport | null>(null);
  const [rec, setRec] = useState<ReconcileReport | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = () => sklad2.historyStatus().then(s => { setStatus(s); setRec(s.reconcile); }).catch(e => setErr(skladErr(e)));
  useEffect(() => { load(); }, []);
  const run = (what: 'dry' | 'import' | 'reconcile') => {
    setBusy(what === 'dry' ? 'Читаю таблицу (пробно)…' : what === 'import' ? 'Переношу историю и сверяю… (до пары минут)' : 'Сверяю остатки…');
    setErr(null);
    const p = what === 'reconcile' ? sklad2.reconcile().then(r => { setRec(r); })
      : sklad2.importHistory(what === 'dry').then(r => { setRep(r); if (r.reconcile) setRec(r.reconcile); if (!r.dryRun) reload(); });
    p.catch(e => setErr(skladErr(e))).finally(() => { setBusy(null); load(); });
  };
  if (!data.dict.sheetConfigured) return <div className="card muted">Google-таблица не подключена на сервере (SKLAD_SHEET_ID).</div>;
  return (
    <>
      <div className="card">
        <h2>Перенос истории из Google-таблицы</h2>
        <p className="muted">Все строки «Приемки» и «Отгрузки» переносятся в журнал движений. Повторный перенос заменяет перенесённое целиком (ручные движения сайта не трогает), поэтому его можно запускать, пока таблица ещё работает. После каждого переноса остатки сайта сверяются с колонкой «Остаток, ед.» на листах складов.</p>
        <div className="muted">Последний перенос: {status?.importedAt ? fmtDate(status.importedAt) : 'не было'}{status?.cutoverAt ? ` · переход завершён ${fmtDate(status.cutoverAt)}` : ''}</div>
        {!status?.cutoverAt && (
          <div className="sk-toolbar sk-mt">
            <button className="btn" disabled={!!busy} onClick={() => run('dry')}>Пробный перенос</button>
            <button className="btn btn-primary" disabled={!!busy} onClick={() => run('import')}>Перенести и сверить</button>
            <button className="btn" disabled={!!busy || !status?.importedAt} onClick={() => run('reconcile')}>Только сверить остатки</button>
          </div>
        )}
        {busy && <div className="muted sk-mt">{busy}</div>}
        {err && <div className="sk-err"><WarningIcon size={14} /> {err}</div>}
      </div>
      {rep && (
        <div className="card">
          <span className={`chip ${rep.dryRun ? 'info' : 'good'}`}>{rep.dryRun ? 'Пробный перенос — ничего не записано' : 'Перенесено'}</span>
          <ul className="sk-report">
            <li>Строк: «Приемка» {rep.receipts}, «Отгрузка» {rep.shipments} → движений <b>{rep.imported}</b></li>
            <li>По видам: {Object.entries(rep.byKind).map(([k, n]) => `${kindLabel(data, k)} — ${n}`).join('; ')}</li>
            {rep.newArchived.length > 0 && <li>Заведены архивными (нет в справочнике): <b>{rep.newArchived.length}</b><div className="muted sk-report-items">{rep.newArchived.join(', ')}</div></li>}
            {rep.skipped.length > 0 && <li className="sk-bad">Пропущено строк: <b>{rep.skipped.length}</b><div className="sk-report-items">{rep.skipped.slice(0, 50).map(s => `${s.sheet} ${s.row}: ${s.reason}`).join('; ')}</div></li>}
          </ul>
        </div>
      )}
      {rec && (
        <div className="card">
          <h2>Сверка с таблицей · {fmtDate(rec.checkedAt)}</h2>
          {rec.warehouses.map(w => (
            <div key={w.name} className="sk-block">
              <div><b>{w.name}</b> — {w.error ? <span className="sk-bad">{w.error}</span> :
                w.diffs.length ? <span className="sk-bad">совпало {w.matched} из {w.items}, расхождений {w.diffs.length}</span> : <span className="chip good">совпало {w.matched} из {w.items}</span>}</div>
              {w.diffs.length > 0 && (
                <table className="sk-table sk-lines"><thead><tr><th>Артикул</th><th className="num">В таблице</th><th className="num">На сайте</th><th className="num">Разница</th></tr></thead>
                  <tbody>{w.diffs.map(d0 => <tr key={d0.article}><td>{d0.article}</td><td className="num">{d0.sheet}</td><td className="num">{d0.site}</td><td className="num sk-bad">{d0.site - d0.sheet > 0 ? '+' : ''}{d0.site - d0.sheet}</td></tr>)}</tbody></table>
              )}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
