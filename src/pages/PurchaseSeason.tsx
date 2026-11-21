/**
 * «Закупки» → «Сезонность» (21.11.2026): когда в каждой категории наших товаров пик спроса и когда спад.
 * Источники — одни и те же главные запросы категории на WB (API, год), Ozon (кабинет, год, агент на ПК) и
 * в Вордстате (2 года, доля от всех запросов Яндекса, агент на ПК). Данные — api/_lib/season.ts, расчёт —
 * shared/season.ts. Экран только показывает и может поставить агенту задание «дособрать».
 */
import { Fragment, useCallback, useEffect, useState } from 'react';
import { ArrowClockwiseIcon, CaretDownIcon, CaretUpIcon, PlayIcon } from '@phosphor-icons/react';
import { apiGet, apiPost, errText } from '../api/http';
import { MONTHS_RU, SEASON_SOURCES, type SeasonCategory, type SeasonResponse, type SeasonSource } from '../../shared/season';

type View = SeasonSource | 'all';
type K = (number | null)[];
const VIEWS: { key: View; label: string }[] = [{ key: 'all', label: 'Среднее' }, { key: 'wb', label: 'WB' }, { key: 'ozon', label: 'Ozon' }, { key: 'wordstat', label: 'Вордстат' }];
const SRC_NAME: Record<SeasonSource, string> = { wb: 'WB', ozon: 'Ozon', wordstat: 'Вордстат' };
const SRC_HINT: Record<SeasonSource, string> = {
  wb: 'частота запросов на WB по API, последние 12 месяцев',
  ozon: 'кабинет Ozon «Поисковые запросы», 12 месяцев — собирает агент на ПК',
  wordstat: 'доля запроса во всём поиске Яндекса, 2 года — собирает агент на ПК',
};

const avgK = (list: K[]): K => MONTHS_RU.map((_, i) => {
  const xs = list.map(k => k[i]).filter((x): x is number => x != null);
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
});
const combined = (c: SeasonCategory): K => avgK(Object.values(c.sources).map(s => s!.k));
const kOf = (c: SeasonCategory, v: View): K => (v === 'all' ? combined(c) : c.sources[v]?.k ?? MONTHS_RU.map(() => null));
const pct = (k: number) => { const p = Math.round((k - 1) * 100); return p === 0 ? '0' : p > 0 ? `+${p}` : `−${-p}`; };
const cellStyle = (k: number | null) => {
  if (k == null) return undefined;
  const d = Math.max(-1, Math.min(1, (k - 1) / 0.6));
  const a = Math.round(Math.abs(d) * 55) / 100;
  return { background: d >= 0 ? `rgba(22, 163, 74, ${a})` : `rgba(220, 38, 38, ${a})` };
};
function drop(k: K): number | null {
  const [j, f, n, d] = [k[0], k[1], k[10], k[11]];
  return j == null || f == null || n == null || d == null || n + d <= 0 ? null : (j + f) / (n + d);
}
/** Месяцы пика (на 15 % и больше выше обычного) и спада (на 15 % и больше ниже), по силе. */
function peaksDips(k: K): { peaks: string[]; dips: string[] } {
  const xs = k.map((x, i) => ({ x, i })).filter((o): o is { x: number; i: number } => o.x != null);
  return {
    peaks: xs.filter(o => o.x >= 1.15).sort((a, b) => b.x - a.x).slice(0, 3).map(o => MONTHS_RU[o.i]),
    dips: xs.filter(o => o.x <= 0.85).sort((a, b) => a.x - b.x).slice(0, 3).map(o => MONTHS_RU[o.i]),
  };
}

function Cells({ k }: { k: K }) {
  return <>{k.map((x, i) => <td key={i} className="num pur-sea-cell" style={cellStyle(x)}>{x == null ? <span className="muted">·</span> : pct(x)}</td>)}</>;
}
function MonthHead() {
  return <>{MONTHS_RU.map(m => <th key={m} className="num">{m}</th>)}</>;
}

export function PurchaseSeason() {
  const [data, setData] = useState<SeasonResponse | null>(null);
  const [err, setErr] = useState('');
  const [view, setView] = useState<View>(() => { try { return (localStorage.getItem('pur.season.view') as View) || 'all'; } catch { return 'all'; } });
  const [open, setOpen] = useState<string | null>(null);
  const [msg, setMsg] = useState('');

  const load = useCallback(async () => {
    try { const r = await apiGet<SeasonResponse>('/api/purchase/season'); setData(r.data); setErr(''); }
    catch (e) { setErr(errText(e)); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const pick = (v: View) => { setView(v); try { localStorage.setItem('pur.season.view', v); } catch { /* вид просто не запомнится */ } };
  const runAgent = async () => {
    try { const r = await apiPost<{ result?: string }>('/api/purchase/season/agent', {}); setMsg(`Агент на ПК: ${r.data.result ?? 'задание поставлено'}.`); void load(); }
    catch (e) { setErr(errText(e)); }
  };

  if (!data) return <div className="card">{err ? <span className="bad">Не загрузилось: {err}</span> : 'Собираю сезонность…'}</div>;
  const cats = data.categories;
  const total = avgK(cats.map(c => kOf(c, view)).filter(k => k.some(x => x != null)));
  const pending = data.pending ?? { ozon: 0, wordstat: 0 };

  return (
    <>
      {err && <div className="card pur-fail">Не выполнено: {err}</div>}
      <div className="card pur-sea-intro">
        <h2>Сезонность по категориям</h2>
        <div className="pur-sea-text">
          Насколько спрос в месяце выше или ниже обычного: <b className="pur-sea-up">+40</b> — на 40 % выше среднего месяца, <b className="pur-sea-down">−30</b> — на 30 % ниже.
          Считаем по главным поисковым запросам каждой категории — одним и тем же на WB, Ozon и в Яндексе.
          Для закупки главное — столбец «Янв–фев к ноя–дек»: партия, заказанная в ноябре, продаётся после Нового года.
        </div>
        <div className="pur-panel pur-sea-src">
          {SEASON_SOURCES.map(s => {
            const cv = data.coverage?.[s.key];
            const n = cv?.months ?? 0;
            const left = s.key === 'ozon' ? pending.ozon : s.key === 'wordstat' ? pending.wordstat : 0;
            return (
              <div key={s.key} className={`pur-box ${n >= 3 ? '' : 'empty'}`}>
                <div className="pur-box-h">{s.label}</div>
                <div className="pur-box-big"><b>{n}</b><span className="muted">мес. истории</span></div>
                <div className="muted pur-sub">{n > 0 && cv ? `${cv.from.slice(5, 7)}.${cv.from.slice(0, 4)} – ${cv.to.slice(5, 7)}.${cv.to.slice(0, 4)} · ` : ''}{SRC_HINT[s.key]}</div>
                {left > 0 && <div className="pur-sub warn">агенту осталось собрать: {left} {s.key === 'ozon' ? 'пар «месяц × запрос»' : 'запросов'}</div>}
              </div>
            );
          })}
        </div>
      </div>

      <div className="pur-bar">
        <div className="sa-seg">
          {VIEWS.map(v => <button key={v.key} className={view === v.key ? 'on' : ''} onClick={() => pick(v.key)}>{v.label}</button>)}
        </div>
        <span className="pur-spacer" />
        {(pending.ozon > 0 || pending.wordstat > 0) && <button className="btn" onClick={() => void runAgent()}><PlayIcon size={18} /> Дособрать агентом</button>}
        <button className="btn" onClick={() => void load()}><ArrowClockwiseIcon size={18} /> Обновить</button>
      </div>
      {msg && <div className="muted pur-meta">{msg}</div>}

      <div className="card pur-table-card">
        <div className="pur-scroll">
          <table className="pur-table pur-sea">
            <thead>
              <tr>
                <th>Категория</th>
                <MonthHead />
                <th>Пик</th>
                <th>Спад</th>
                <th className="num">Янв–фев к ноя–дек</th>
              </tr>
            </thead>
            <tbody>
              {cats.length > 1 && (() => {
                const pd = peaksDips(total); const dr = drop(total);
                return (
                  <tr className="pur-sea-total">
                    <td className="pur-name"><b>Все категории</b><div className="muted pur-sub">среднее по категориям</div></td>
                    <Cells k={total} />
                    <td className="pur-sea-up">{pd.peaks.join(', ') || '–'}</td>
                    <td className="pur-sea-down">{pd.dips.join(', ') || '–'}</td>
                    <td className={`num ${dr != null && dr < 0.85 ? 'bad' : ''}`}>{dr == null ? '–' : `${pct(dr)} %`}</td>
                  </tr>
                );
              })()}
              {cats.map(c => {
                const k = kOf(c, view);
                const dr = drop(k);
                const pd = peaksDips(k);
                const isOpen = open === c.category;
                const srcs = (Object.keys(c.sources) as SeasonSource[]).map(s => SRC_NAME[s]);
                return (
                  <Fragment key={c.category}>
                    <tr className={`pur-row ${isOpen ? 'open' : ''}`} onClick={() => setOpen(isOpen ? null : c.category)}>
                      <td className="pur-name"><div className="pur-name-in">
                        <span className="pur-caret">{isOpen ? <CaretUpIcon size={16} /> : <CaretDownIcon size={16} />}</span>
                        <div>
                          <div>{c.category}</div>
                          <div className="muted pur-sub">{c.products.length} тов. · {srcs.length ? srcs.join(', ') : 'данных пока нет'}</div>
                        </div>
                      </div></td>
                      <Cells k={k} />
                      <td className="pur-sea-up">{pd.peaks.join(', ') || '–'}</td>
                      <td className="pur-sea-down">{pd.dips.join(', ') || '–'}</td>
                      <td className={`num ${dr != null && dr < 0.85 ? 'bad' : ''}`}>{dr == null ? '–' : `${pct(dr)} %`}</td>
                    </tr>
                    {isOpen && <tr className="pur-detail"><td colSpan={16}><CategoryDetail c={c} /></td></tr>}
                  </Fragment>
                );
              })}
              {!cats.length && <tr><td colSpan={16} className="muted pur-empty">Товаров для закупки нет.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <div className="muted pur-foot">
        <b>WB</b> — {SRC_HINT.wb}; <b>Ozon</b> — {SRC_HINT.ozon}; <b>Вордстат</b> — {SRC_HINT.wordstat}.
        Каждый запрос приводится к своему среднему месяцу, поэтому частый запрос не перекрикивает редкий. «Среднее» — среднее доступных источников.
        Сбор — 1-го и 16-го числа: WB ночью, агент на ПК с 09:25. Вся история хранится на нашем сервере.
        {data.runs.length > 0 && <div>Последние сборы: {data.runs.slice(0, 4).map(r => `${SRC_NAME[r.source as SeasonSource] ?? (r.source === 'agent' ? 'агент' : r.source)} ${new Date(r.at).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })} — ${r.ok ? r.detail : 'сбой: ' + r.detail}`).join('; ')}</div>}
      </div>
    </>
  );
}

/** Раскрытая категория: итог словами, год по источникам, год по каждому запросу, товары. */
function CategoryDetail({ c }: { c: SeasonCategory }) {
  const all = combined(c);
  const pd = peaksDips(all);
  const dr = drop(all);
  const rows: { name: string; k: K; hint?: string }[] = SEASON_SOURCES.map(s => ({ name: SRC_NAME[s.key], k: c.sources[s.key]?.k ?? MONTHS_RU.map(() => null), hint: c.sources[s.key] ? undefined : 'нет данных' }));
  return (
    <div className="pur-panel pur-sea-det">
      <div className="pur-box pur-sea-sum">
        <div className="pur-box-h">Итог по категории</div>
        <div className="pur-sea-sum-grid">
          <div><span className="muted">Пик спроса</span><b className="pur-sea-up">{pd.peaks.join(', ') || 'ровно'}</b></div>
          <div><span className="muted">Спад</span><b className="pur-sea-down">{pd.dips.join(', ') || 'нет'}</b></div>
          <div><span className="muted">Янв–фев к ноя–дек</span><b className={dr != null && dr < 0.85 ? 'bad' : ''}>{dr == null ? '–' : `${pct(dr)} %`}</b></div>
        </div>
      </div>

      <div className="pur-box pur-sea-wide">
        <div className="pur-box-h">Год по источникам</div>
        <div className="pur-scroll">
          <table className="pur-table pur-sea pur-sea-mini">
            <thead><tr><th>Источник</th><MonthHead /><th className="num">Янв–фев к ноя–дек</th></tr></thead>
            <tbody>
              {rows.map(r => { const d = drop(r.k); return (
                <tr key={r.name}><td>{r.name}{r.hint && <span className="muted"> · {r.hint}</span>}</td><Cells k={r.k} /><td className="num">{d == null ? '–' : `${pct(d)} %`}</td></tr>
              ); })}
              <tr className="pur-sea-total"><td><b>Среднее</b></td><Cells k={all} /><td className="num"><b>{dr == null ? '–' : `${pct(dr)} %`}</b></td></tr>
            </tbody>
          </table>
        </div>
      </div>

      {c.queries.length > 0 && (
        <div className="pur-box pur-sea-wide">
          <div className="pur-box-h">Главные запросы категории</div>
          <div className="pur-scroll">
            <table className="pur-table pur-sea pur-sea-mini">
              <thead><tr><th>Запрос</th><MonthHead /><th>Где есть</th></tr></thead>
              <tbody>
                {c.queries.map(q => {
                  const have = SEASON_SOURCES.filter(s => q[s.key]);
                  const k = avgK(have.map(s => q[s.key]!));
                  return <tr key={q.query}><td>{q.query}</td><Cells k={k} /><td className="muted">{have.map(s => SRC_NAME[s.key]).join(', ') || 'пока нет данных'}</td></tr>;
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="pur-box pur-sea-goods">
        <div className="pur-box-h">Товары в категории</div>
        <ul>{c.products.map(p => <li key={p.key}>{p.name}</li>)}</ul>
      </div>
    </div>
  );
}
