/**
 * «Склад», этап 3: заказы FBS с WB и Ozon.
 *
 * Пока учёт ведёт таблица, сайт заказы только записывает (теневой режим) и
 * сверяет с «Отгрузкой» — кнопка «Сверить с таблицей». Списание включится
 * при переходе (этап 4).
 */
import { useEffect, useState } from 'react';
import { WarningIcon, ArrowsClockwiseIcon, ScalesIcon } from '@phosphor-icons/react';
import {
  sklad3, skladErr, ORDER_STATE_LABEL, MP_LABEL,
  type Bootstrap, type OrderRow, type OrderState, type PollStatus, type OrdersCompare, type PollResult,
} from '../api/sklad';
import { fmtDate } from '../components/SkladUi';

const STATE_CHIP: Record<OrderState, string> = {
  open: 'info', assembled: 'warn', shipped: 'good', cancelled_before: '', cancelled_after: 'bad', removed: '',
};
const mpShort = (mp: string) => (mp === 'ozon' ? 'Ozon' : mp === 'wb2' ? 'WB 2' : 'WB');

function pollLine(r: PollResult): string {
  if ('error' in r) return `ошибка: ${r.error}`;
  if ('skipped' in r) return `пропуск: ${r.skipped}`;
  return `получено ${r.fetched}, новых ${r.added}, изменилось ${r.changed}${r.unmapped ? `, без привязки ${r.unmapped}` : ''}${r.created ? `, списано ${r.created}` : ''}${r.reversed ? `, сторно ${r.reversed}` : ''}`;
}

export function OrdersTab({ data }: { data: Bootstrap }) {
  const [list, setList] = useState<{ items: OrderRow[]; total: number; counts: Record<string, number> } | null>(null);
  const [status, setStatus] = useState<{ quick: PollStatus | null; full: PollStatus | null; liveSince: number | null; enabled: boolean; compare: OrdersCompare | null } | null>(null);
  const [mp, setMp] = useState('');
  const [state, setState] = useState('');
  const [problems, setProblems] = useState(false);
  const [days, setDays] = useState(7);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [compare, setCompare] = useState<OrdersCompare | null>(null);
  const boss = data.me.role === 'owner' || data.me.role === 'manager';
  const whName = (id: number | null) => (id ? data.warehouses.find(w => w.id === id)?.name ?? `#${id}` : '—');

  const load = () => {
    sklad3.orders({ mp, state, problems: problems ? 1 : undefined, days, q, limit: 300 }).then(setList).catch(e => setErr(skladErr(e)));
    sklad3.status().then(s => { setStatus(s); if (!compare) setCompare(s.compare); }).catch(() => {});
  };
  useEffect(() => { load(); }, [mp, state, problems, days]);

  const run = (what: 'poll' | 'full' | 'compare') => {
    setBusy(what === 'compare' ? 'Сверяю с «Отгрузкой» таблицы…' : what === 'full' ? 'Полный опрос за 30 дней… (до пары минут)' : 'Опрашиваю WB и Ozon…');
    setErr(null);
    const p = what === 'compare' ? sklad3.compare(3).then(setCompare) : sklad3.poll(what === 'full').then(() => undefined);
    p.catch(e => setErr(skladErr(e))).finally(() => { setBusy(null); load(); });
  };

  const c = list?.counts ?? {};
  const last = status?.quick && status?.full ? (status.quick.at > status.full.at ? status.quick : status.full) : status?.quick ?? status?.full ?? null;
  return (
    <>
      <div className="card">
        <div className="flex-between">
          <div>
            <h2>Заказы FBS</h2>
            <div className="muted">{status?.liveSince
              ? <>Боевой режим с {fmtDate(status.liveSince)}: заказы списываются с остатков, отмены возвращают товар.</>
              : <>Теневой режим: сайт записывает заказы и сверяет их с таблицей, остатки пока считает таблица.</>}</div>
          </div>
          {boss && (
            <div className="row gap-8">
              <button className="btn" disabled={!!busy} onClick={() => run('poll')}><ArrowsClockwiseIcon size={16} /> Опросить</button>
              <button className="btn" disabled={!!busy} onClick={() => run('full')}>За 30 дней</button>
              {data.dict.sheetConfigured && !status?.liveSince && <button className="btn btn-primary" disabled={!!busy} onClick={() => run('compare')}><ScalesIcon size={16} /> Сверить с таблицей</button>}
            </div>
          )}
        </div>
        {last && (
          <div className="sk-poll">
            <span className="muted">Последний опрос {fmtDate(last.at)} ({last.full ? 'полный' : 'быстрый'}, {Math.round(last.ms / 1000)} с):</span>
            {Object.entries(last.results).map(([k, r]) => <div key={k} className={'error' in r ? 'sk-bad' : 'skipped' in r ? 'muted' : ''}>{MP_LABEL[k as 'wb1']}: {pollLine(r)}</div>)}
          </div>
        )}
        {status && !status.enabled && <div className="sk-bad">Опрос выключен на сервере (SKLAD_ORDERS_DISABLED=1)</div>}
        {busy && <div className="muted sk-mt">{busy}</div>}
        {err && <div className="sk-err"><WarningIcon size={14} /> {err}</div>}
      </div>

      {compare && <CompareCard r={compare} />}

      <div className="sk-toolbar">
        <select className="input sk-select" value={mp} onChange={e => setMp(e.target.value)}>
          <option value="">WB и Ozon</option><option value="wb1">WB кабинет 1</option><option value="wb2">WB кабинет 2</option><option value="ozon">Ozon</option>
        </select>
        <select className="input sk-select" value={days} onChange={e => setDays(Number(e.target.value))}>
          {[1, 3, 7, 14, 30].map(n => <option key={n} value={n}>за {n} дн.</option>)}
        </select>
        <div className="sk-search"><input className="input" placeholder="№ заказа или артикул" value={q} onChange={e => setQ(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') load(); }} /></div>
      </div>
      <div className="sk-hints">
        <button className={`chip ${!state && !problems ? 'info' : ''}`} onClick={() => { setState(''); setProblems(false); }}>Все · {Object.entries(c).filter(([k]) => k !== 'problems').reduce((s, [, n]) => s + n, 0)}</button>
        {(Object.keys(ORDER_STATE_LABEL) as OrderState[]).map(s => c[s] ? (
          <button key={s} className={`chip ${state === s ? 'info' : ''}`} onClick={() => { setState(s); setProblems(false); }}>{ORDER_STATE_LABEL[s]} · {c[s]}</button>
        ) : null)}
        {c.problems ? <button className={`chip ${problems ? 'info' : 'bad'}`} onClick={() => { setProblems(true); setState(''); }}>Требуют внимания · {c.problems}</button> : null}
      </div>

      {!list ? <div className="card muted">Загрузка…</div> : (
        <div className="card sk-table-card">
          <div className="sk-scroll">
            <table className="sk-table sk-moves">
              <thead><tr><th>Заказ</th><th>Площадка</th><th>Товар</th><th className="num">Шт.</th><th>Склад</th><th>Статус</th><th>Списание</th></tr></thead>
              <tbody>
                {list.items.map(o => (
                  <tr key={o.id} className={o.state === 'cancelled_before' || o.state === 'removed' ? 'sk-row-muted' : ''}>
                    <td><div className="sk-mono">{o.orderId}</div><div className="muted sk-name">{fmtDate(o.orderedAt)}</div></td>
                    <td>{mpShort(o.mp)}</td>
                    <td><b>{o.article ?? o.offer}</b>{o.problem && <div className="sk-bad sk-name">{o.problem}</div>}</td>
                    <td className="num">{o.qty}</td>
                    <td>{whName(o.whId)}</td>
                    <td><span className={`chip ${STATE_CHIP[o.state]}`}>{ORDER_STATE_LABEL[o.state]}</span><div className="muted sk-name">{o.rawStatus}</div></td>
                    <td className="muted sk-name">{o.movementId ? `№${o.movementId}${o.stornoId ? `, сторно №${o.stornoId}` : ''}` : status?.liveSince ? '—' : 'теневой режим'}</td>
                  </tr>
                ))}
                {!list.items.length && <tr><td colSpan={7} className="muted sk-empty">Заказов нет{status?.quick ? '' : ' — первый опрос пройдёт в течение минуты после запуска сервера'}</td></tr>}
              </tbody>
            </table>
          </div>
          {list.total > list.items.length && <div className="sk-more muted">Показано {list.items.length} из {list.total} — уточните фильтр</div>}
        </div>
      )}
    </>
  );
}

function CompareCard({ r }: { r: OrdersCompare }) {
  const issues = r.missingInTable.length + r.cancelledButInTable.length + r.qtyMismatch.length + r.whMismatch.length + r.tableOnly.length;
  return (
    <div className="card">
      <h2>Сверка с «Отгрузкой» · {fmtDate(r.checkedAt)}, за {r.days} дн.</h2>
      <div>{issues ? <span className="chip warn">Совпало {r.matched} из {r.orders}, расхождений {issues}</span> : <span className="chip good">Совпало {r.matched} из {r.orders} — расхождений нет</span>}
        {r.unmapped ? <span className="chip sk-ml">без привязки (не сверялись): {r.unmapped}</span> : null}</div>
      <ul className="sk-report">
        <CmpList title="Есть на площадке, нет в таблице" items={r.missingInTable.map(x => `${mpShort(x.mp)} ${x.orderId} · ${x.article} × ${x.qty} · ${x.wh} · ${ORDER_STATE_LABEL[x.state as OrderState] ?? x.state}`)} />
        <CmpList title="Отменён до передачи, а строка в таблице осталась" items={r.cancelledButInTable.map(x => `${mpShort(x.mp)} ${x.orderId} · ${x.article} · строка ${x.row}`)} />
        <CmpList title="Разное количество" items={r.qtyMismatch.map(x => `${x.orderId} · ${x.article}: площадка ${x.site}, таблица ${x.table}`)} />
        <CmpList title="Разный склад" items={r.whMismatch.map(x => `${x.orderId} · ${x.article}: площадка → ${x.site}, таблица → ${x.table}`)} />
        <CmpList title="Есть в таблице, сайт заказ не видел" items={r.tableOnly.map(x => `строка ${x.row}: ${x.ref} · ${x.sku} · ${x.from} → ${x.dest}`)} />
      </ul>
    </div>
  );
}

function CmpList({ title, items }: { title: string; items: string[] }) {
  const [all, setAll] = useState(false);
  if (!items.length) return null;
  const shown = all ? items : items.slice(0, 10);
  return (
    <li className="sk-bad">{title}: <b>{items.length}</b>
      <div className="sk-report-items muted">{shown.map((s, i) => <div key={i}>{s}</div>)}</div>
      {items.length > shown.length && <button className="btn btn-sm" onClick={() => setAll(true)}>показать все</button>}
    </li>
  );
}
