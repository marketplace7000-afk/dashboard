/**
 * «Остатки» (до 28.10.2026 — «Остатки FBO») — остатки на складах маркетплейсов по кластерам Ozon и регионам WB,
 * поставки, где покупают и свои склады (FBS). Снимок собирает сервер
 * (api/_lib/fboStocks.ts) раз в 3 часа; расчёты — utils/fboModel.ts.
 *
 * 27.10.2026 по просьбе владельца: вместо карточек — таблица «один товар — одна строка»
 * (слева фото, артикул, название; справа остатки, поставки, заказы, FBS), кластеры —
 * строкой сверху, подробности по кластерам — по клику на строку.
 *
 * 28.10.2026 по просьбе владельца — меньше цифр в строке, порядок столбцов:
 * товар → FBO всего → FBS всего (по складам) → запас в днях (FBO + FBS вместе) →
 * едет в поставках → заказы 7 дн → заказы 30 дн → статусы поставок (справа).
 * 28.10 вечером: «Едет» перед «Хватит на», цифры по центру, разбивки FBO / FBS — двумя строками,
 * у FBS и статусов количество рядом с названием, а не через всю ширину.
 * «Где лежит FBO», кластеры покупателей и «издалека» — в раскрытии строки.
 */
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowsClockwiseIcon, CaretDownIcon, CaretRightIcon } from '@phosphor-icons/react';
import '../fbo.css';
import { apiGet, apiPost, errText } from '../api/http';
import {
  type FboBundle, type Mp, type Source, type Supply, type ProductRow, type SortKey, type RowFilter,
  buildOzon, buildWb, clustersOf, demandRows, productRows, sortRows, filterRows, fmt, pct, plural, KIND_ORDER, shortPlace,
} from '../utils/fboModel';

type Resp = { ok: boolean; data: FboBundle | null; collecting: boolean; ageMin: number | null };
type View = 'items' | 'demand' | 'supplies' | 'fbs';

const SORTS: { key: SortKey; label: string }[] = [
  { key: 'fbo', label: 'по остатку FBO' },
  { key: 'fbs', label: 'по остатку FBS' },
  { key: 'days', label: 'по запасу в днях' },
  { key: 'going', label: 'по количеству в поставках' },
  { key: 'orders7', label: 'по заказам за 7 дней' },
  { key: 'orders', label: 'по заказам за 30 дней' },
  { key: 'name', label: 'по названию' },
];

export function Fbo() {
  const [resp, setResp] = useState<Resp | null>(null);
  const [err, setErr] = useState('');
  const [mp, setMp] = useState<Mp>('o');
  const [cluster, setCluster] = useState<string | null>(null);
  const [view, setView] = useState<View>('items');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<RowFilter>('all');
  const [sort, setSort] = useState<SortKey>('fbo');
  const [open, setOpen] = useState<Set<string>>(new Set());
  const timer = useRef<number | undefined>(undefined);

  const load = async () => {
    try {
      const r = await apiGet<Resp>('/api/fbo');
      setResp(r.data); setErr('');
      window.clearTimeout(timer.current);
      if (r.data.collecting) timer.current = window.setTimeout(load, 20_000); // сервер собирает — спросим снова
    } catch (e) { setErr(errText(e)); }
  };
  useEffect(() => { void load(); return () => window.clearTimeout(timer.current); }, []);

  const refresh = async () => {
    try { await apiPost('/api/fbo/refresh'); } catch (e) { setErr(errText(e)); return; }
    setResp(r => (r ? { ...r, collecting: true } : r));
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(load, 15_000);
  };

  const D = resp?.data ?? null;
  const src = useMemo(() => (D ? { o: buildOzon(D), w: buildWb(D) } : null), [D]);
  const S = src?.[mp];
  const allRows = useMemo(() => (S && D ? productRows(S, D, cluster) : []), [S, D, cluster]);
  const rows = useMemo(() => sortRows(filterRows(allRows, filter, query), sort, sort !== 'name'), [allRows, filter, query, sort]);

  if (err && !D) return <div className="card">Не удалось загрузить остатки: {err}</div>;
  if (!resp) return <div className="card muted">Загружаю остатки…</div>;
  if (!D || !S) {
    return (
      <div className="card">
        <h2>Остатки</h2>
        <p className="muted">{resp.collecting
          ? 'Собираю данные с Ozon, WB и таблицы «Склад» — это занимает 2–4 минуты. Страница обновится сама.'
          : 'Данных пока нет.'}</p>
        {!resp.collecting && <button className="btn btn-primary" onClick={refresh}>Собрать сейчас</button>}
      </div>
    );
  }

  const isOz = mp === 'o';
  const at = new Date(D.at).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
  const pickMp = (m: Mp) => { setMp(m); setCluster(null); setOpen(new Set()); };
  const pickCluster = (c: string | null) => { setCluster(c); setOpen(new Set()); };
  const toggle = (art: string) => setOpen(s => { const n = new Set(s); if (n.has(art)) n.delete(art); else n.add(art); return n; });

  const scopeSupplies = S.supplies.filter(s => !cluster || s.cluster === cluster);
  const shortCount = allRows.filter(r => r.fbo === 0 && r.ordFbo + r.ordFbs > 0).length;

  return (
    <div className="fbo">
      <div className="fbo-top">
        <div className="fbo-sub">Остатки на складах {isOz ? 'Ozon' : 'WB'} (FBO) и на ваших складах (FBS), запас в днях, поставки и заказы за 7 и 30 дней. Нажмите на товар — откроются кластеры, покупатели и поставки.</div>
        <div className="fbo-upd">
          <span className="muted">Данные на {at}</span>
          <button className="btn btn-sm" onClick={refresh} disabled={resp.collecting} title="Собрать данные заново">
            <ArrowsClockwiseIcon size={16} weight="bold" /> {resp.collecting ? 'Обновляю…' : 'Обновить'}
          </button>
        </div>
      </div>
      {D.notes.length > 0 && <div className="fbo-note">{D.notes.join('; ')}</div>}

      <div className="fbo-controls">
        <div className="fbo-seg" role="group" aria-label="Площадка">
          <button aria-pressed={isOz} onClick={() => pickMp('o')}>Ozon</button>
          <button aria-pressed={!isOz} onClick={() => pickMp('w')}>Wildberries</button>
        </div>
        <div className="fbo-seg" role="group" aria-label="Раздел">
          <button aria-pressed={view === 'items'} onClick={() => setView('items')}>Товары</button>
          <button aria-pressed={view === 'demand'} onClick={() => setView('demand')}>Где покупают</button>
          <button aria-pressed={view === 'supplies'} onClick={() => setView('supplies')}>Поставки{scopeSupplies.length ? ` (${scopeSupplies.length})` : ''}</button>
          <button aria-pressed={view === 'fbs'} onClick={() => setView('fbs')}>Ваши склады</button>
        </div>
      </div>

      <ClusterBar src={S} cluster={cluster} onPick={pickCluster} />
      {!isOz && S.stopped.size > 0 && <Stopped stopped={S.stopped} />}

      {view === 'items' && <>
        <div className="fbo-tools">
          <input className="fbo-search" type="search" placeholder="Найти товар или артикул" value={query} onChange={e => setQuery(e.target.value)} />
          <div className="fbo-seg fbo-seg--sm" role="group" aria-label="Фильтр">
            <button aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>Все</button>
            <button aria-pressed={filter === 'instock'} onClick={() => setFilter('instock')}>Есть на FBO</button>
            <button aria-pressed={filter === 'short'} onClick={() => setFilter('short')}>Нет на FBO, но заказывают{shortCount ? ` (${shortCount})` : ''}</button>
          </div>
          <label className="fbo-sort">Сортировка
            <select value={sort} onChange={e => setSort(e.target.value as SortKey)}>
              {SORTS.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
            </select>
          </label>
          <span className="muted fbo-count">{fmt(rows.length)} {plural(rows.length, 'товар', 'товара', 'товаров')}</span>
        </div>
        <ItemsTable rows={rows} isOz={isOz} cluster={cluster} open={open} onToggle={toggle} />
      </>}
      {view === 'demand' && <Demand src={S} onCluster={c => { pickCluster(c); setView('items'); }} />}
      {view === 'supplies' && <Supplies sups={scopeSupplies} showCluster={!cluster} mp={mp} />}
      {view === 'fbs' && <FbsBlock D={D} />}
    </div>
  );
}

/** Кластеры (Ozon) / регионы (WB) — кнопками в строку над таблицей. */
function ClusterBar({ src, cluster, onPick }: { src: Source; cluster: string | null; onPick: (c: string | null) => void }) {
  const cls = clustersOf(src);
  const total = cls.reduce((a, c) => a + c.q, 0);
  return (
    <div className="fbo-clbar" role="group" aria-label={src.mp === 'o' ? 'Кластеры' : 'Регионы'}>
      <button className="fbo-chip" aria-pressed={!cluster} onClick={() => onPick(null)}>
        <span className="n">Все {src.mp === 'o' ? 'кластеры' : 'регионы'}</span><span className="q">{fmt(total)}</span>
      </button>
      {cls.map(c => (
        <button key={c.name} className="fbo-chip" aria-pressed={cluster === c.name} onClick={() => onPick(cluster === c.name ? null : c.name)}
          title={`FBO ${fmt(c.q)} шт.${c.ord ? `, заказов за 30 дней ${fmt(c.ord)}` : ''}${c.go + c.soon ? `, едет/готовится ${fmt(c.go + c.soon)}` : ''}`}>
          <span className="n">{shortPlace(c.name)}</span>
          <span className={`q ${c.q ? '' : 'zero'}`}>{c.q ? fmt(c.q) : '0'}</span>
          {c.ord > 0 && <span className="o">зак. {fmt(c.ord)}</span>}
        </button>
      ))}
    </div>
  );
}

function ItemsTable({ rows, isOz, cluster, open, onToggle }: {
  rows: ProductRow[]; isOz: boolean; cluster: string | null; open: Set<string>; onToggle: (art: string) => void;
}) {
  if (!rows.length) return <div className="fbo-empty">Ничего не нашлось. Измените поиск, фильтр или кластер.</div>;
  const here = cluster ? (isOz ? 'в кластере' : 'в регионе') : 'всего';
  const daysHint = cluster
    ? 'Запас FBO в выбранном кластере при темпе заказов FBO за 30 дней. Свои склады к кластеру не относятся — их запас подписан ниже отдельно.'
    : 'Сколько дней хватит всего товара: (FBO + свои склады) ÷ заказы за 30 дней. Свои склады общие для WB и Ozon, поэтому для них берутся FBS-заказы обеих площадок.';
  return (
    <div className="fbo-table" role="table">
      <div className="fbo-tr fbo-th" role="row">
        <span role="columnheader">Товар</span>
        <span role="columnheader" className="c">FBO {here}</span>
        <span role="columnheader" className="c">FBS всего</span>
        <span role="columnheader" className="c" title="Поставки в пути и готовые к отгрузке. «Ждёт акта» не считается: этот товар уже принят и лежит в FBO">Едет в поставках</span>
        <span role="columnheader" className="c" title={daysHint}>Хватит на</span>
        <span role="columnheader" className="c">Заказы 7 дн</span>
        <span role="columnheader" className="c">Заказы 30 дн</span>
        <span role="columnheader">Статусы поставок</span>
        <span role="columnheader" aria-label="Подробнее" />
      </div>
      {rows.map(r => {
        const isOpen = open.has(r.art);
        const draftsOnly = r.going === 0 && r.lines.some(l => l.s.status.kind === 'idle');
        return (
          <Fragment key={r.art}>
            <div className={`fbo-tr ${isOpen ? 'open' : ''}`} role="row" tabIndex={0} aria-expanded={isOpen}
              onClick={() => onToggle(r.art)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(r.art); } }}>
              <span className="c-prod" role="cell" data-area="prod">
                <span className="ph" style={r.img ? { backgroundImage: `url("${r.img}")` } : undefined} />
                <span className="pt">
                  <span className="art">{r.art}</span>
                  <span className="nm" title={r.name}>{r.name}</span>
                </span>
              </span>
              <span className="c-num" role="cell" data-area="fbo" data-l={`FBO ${here}`}>
                <b className={r.fbo ? '' : 'bad'}>{fmt(r.fbo)}</b>
              </span>
              <span className="c-list c-fbs" role="cell" data-area="fbs" data-l="FBS всего">
                <b className={`big ${r.fbsTotal > 0 ? '' : 'muted'}`}>{fmt(r.fbsTotal)}</b>
                {r.fbs.length > 0 && (
                  <span className="fbs-grid">
                    {r.fbs.slice(0, 5).map(([k, v]) => <Fragment key={k}><span>{k}</span><b className={v < 0 ? 'bad' : ''}>{fmt(v)}</b></Fragment>)}
                  </span>
                )}
                {r.fbs.length > 5 && <div className="more">ещё {r.fbs.length - 5}</div>}
              </span>
              <span className="c-num" role="cell" data-area="going" data-l="Едет в поставках">
                {r.going > 0
                  ? <><b>+{fmt(r.going)}</b><span className="sub">в {fmt(r.goingN)} {plural(r.goingN, 'поставке', 'поставках', 'поставках')}</span></>
                  : <><b className="muted">—</b>{draftsOnly && <span className="sub">только черновик</span>}</>}
              </span>
              <span className="c-num" role="cell" data-area="days" data-l="Хватит на" title={daysHint}>
                {r.days === null
                  ? <b className="muted">—</b>
                  : <b className={r.days < 14 ? 'bad' : ''}>{fmt(r.days)} <small>дн</small></b>}
                {cluster
                  ? <span className="sub">FBS {r.fbsDays === null ? '—' : `${fmt(r.fbsDays)} дн`} (все склады)</span>
                  : <>
                      <span className="sub">FBO {r.fboDays === null ? '—' : `${fmt(r.fboDays)} дн`}</span>
                      <span className="sub">FBS {r.fbsDays === null ? '—' : `${fmt(r.fbsDays)} дн`}</span>
                    </>}
              </span>
              <span className="c-num c-ord" role="cell" data-area="ord7" data-l="Заказы 7 дн">
                <b>{fmt(r.ord7Fbo + r.ord7Fbs)}</b>
                <span className="sub">FBO {fmt(r.ord7Fbo)}</span>
                <span className="sub">FBS {fmt(r.ord7Fbs)}</span>
              </span>
              <span className="c-num c-ord" role="cell" data-area="ord30" data-l={`Заказы 30 дн${cluster && isOz ? ' сюда' : ''}`}>
                <b>{fmt(r.ordFbo + r.ordFbs)}</b>
                <span className="sub">FBO {fmt(r.ordFbo)}</span>
                <span className="sub">FBS {fmt(r.ordFbs)}</span>
              </span>
              <span className="c-list" role="cell" data-area="st" data-l="Статусы поставок">
                {r.lines.length ? <SupplyBadges lines={r.lines} /> : <span className="muted">—</span>}
              </span>
              <span className="c-exp" role="cell" data-area="exp" aria-hidden>{isOpen ? <CaretDownIcon size={24} /> : <CaretRightIcon size={24} />}</span>
            </div>
            {isOpen && <RowDetail r={r} isOz={isOz} />}
          </Fragment>
        );
      })}
    </div>
  );
}

function SupplyBadges({ lines }: { lines: { s: Supply; q: number }[] }) {
  // Одинаковые статусы склеиваем: «Готова к отгрузке ×3 · +45».
  const by = new Map<string, { s: Supply; q: number; n: number }>();
  for (const l of lines) { const k = l.s.status.short ?? l.s.status.label; const v = by.get(k) ?? { s: l.s, q: 0, n: 0 }; v.q += l.q; v.n++; by.set(k, v); }
  const all = [...by.values()].sort((a, b) => KIND_ORDER[a.s.status.kind] - KIND_ORDER[b.s.status.kind]);
  // В строке — три главных статуса, остальное в раскрытии (иначе строка вытягивается).
  return <>{all.slice(0, 3).map(v => (
    <div key={v.s.status.short ?? v.s.status.label} className="kv"><span className={`fbo-st ${v.s.status.kind}`} title={v.s.status.label}>{v.s.status.short ?? v.s.status.label}{v.n > 1 ? ` ×${v.n}` : ''}</span><b>+{fmt(v.q)}</b></div>
  ))}{all.length > 3 && <div className="more">ещё {all.length - 3} — по клику</div>}</>;
}

/** Раскрытие строки: по каждому кластеру/региону — лежит, заказы, издалека, поставки. */
function RowDetail({ r, isOz }: { r: ProductRow; isOz: boolean }) {
  const places = r.places.filter(p => p.stock || p.ordFbo || p.ordFbs || p.lines.length);
  const orders = r.ordFbo + r.ordFbs;
  const totalBuy = r.buyers.reduce((a, b) => a + b[1], 0);
  return (
    <div className="fbo-detail" role="row">
      <div role="cell">
        {/* То, что 28.10 убрано из строки, — сводкой над подробностями. */}
        <div className="fbo-dsum">
          <span><b>Где лежит FBO:</b> {r.where.length ? r.where.map(([k, v]) => `${shortPlace(k)} ${fmt(v)}`).join(', ') : 'нигде'}</span>
          <span><b>{isOz ? 'Кластеры покупателей' : 'Округа покупателей'} за 30 дн:</b> {r.buyers.length ? r.buyers.slice(0, 6).map(([k, v]) => `${shortPlace(k)} ${pct(v, totalBuy)}%`).join(', ') : 'заказов не было'}</span>
          {isOz && orders > 0 && <span><b>Издалека:</b> {pct(r.far, orders)}% заказов везли из другого кластера</span>}
        </div>
        {isOz ? (
          <table className="fbo-dt">
            <thead><tr><th>Кластер</th><th className="r">Лежит FBO</th><th>Склады</th><th className="r">Заказы FBO</th><th className="r">Заказы FBS</th><th className="r">Издалека</th><th>Откуда везли</th><th>Поставки сюда</th></tr></thead>
            <tbody>{places.map(p => {
              const o = p.ordFbo + p.ordFbs, fp = pct(p.far, o);
              return (
                <tr key={p.key}>
                  <td className="k" title={p.key}>{shortPlace(p.key)}</td>
                  <td className={`r ${p.stock ? '' : 'bad'}`}>{p.stock ? fmt(p.stock) : (o ? 'нет' : '—')}</td>
                  <td>{p.whs.length ? p.whs.map(([w, q]) => `${w} ${q}`).join(', ') : ''}</td>
                  <td className="r">{p.ordFbo || '—'}</td>
                  <td className="r">{p.ordFbs || '—'}</td>
                  <td className={`r ${fp >= 50 ? 'bad' : ''}`}>{o ? `${fp}%` : '—'}</td>
                  <td>{p.from.map(([k, v]) => `${k} ${v}`).join(', ')}</td>
                  <td>{p.lines.map((l, i) => <div key={i}><span className={`fbo-st ${l.s.status.kind}`}>{l.s.status.label}</span> +{fmt(l.q)} <span className="muted">{l.s.status.note.split(',')[0]}</span></div>)}</td>
                </tr>
              );
            })}</tbody>
          </table>
        ) : (
          <div className="fbo-dgrid">
            <table className="fbo-dt">
              <thead><tr><th>Где лежит</th><th className="r">FBO</th></tr></thead>
              <tbody>{places.filter(p => p.stock).map(p => <tr key={p.key}><td className="k" title={p.key}>{shortPlace(p.key)}</td><td className="r">{fmt(p.stock)}</td></tr>)}
                {!places.some(p => p.stock) && <tr><td colSpan={2} className="muted">на складах WB нет</td></tr>}</tbody>
            </table>
            <table className="fbo-dt">
              <thead><tr><th>Округ покупателя</th><th className="r">Заказов</th><th className="r">Доля</th></tr></thead>
              <tbody>{r.buyers.map(([k, v]) => <tr key={k}><td className="k">{k}</td><td className="r">{fmt(v)}</td><td className="r">{pct(v, r.ordFbo + r.ordFbs)}%</td></tr>)}
                {!r.buyers.length && <tr><td colSpan={3} className="muted">заказов за 30 дней не было</td></tr>}</tbody>
            </table>
            <table className="fbo-dt">
              <thead><tr><th>Поставка</th><th>Куда</th><th className="r">Шт</th></tr></thead>
              <tbody>{r.lines.map((l, i) => <tr key={i}><td><span className={`fbo-st ${l.s.status.kind}`}>{l.s.status.label}</span> <span className="muted">{l.s.status.note.split(',')[0]}</span></td><td>{l.s.to}</td><td className="r">+{fmt(l.q)}</td></tr>)}
                {!r.lines.length && <tr><td colSpan={3} className="muted">поставок нет</td></tr>}</tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function Stopped({ stopped }: { stopped: Map<string, number> }) {
  const total = [...stopped.values()].reduce((a, b) => a + b, 0);
  return (
    <details className="fbo-stopped">
      <summary>Не учтено {fmt(total)} шт. на остановленных складах WB</summary>
      <p>С августа 2026 WB показывает живые склады России одной строкой «Склад WB РФ». Склады ниже остались в отчёте отдельно: это пострадавшие склады, остаток на момент остановки. WB доступным его не считает, поэтому в цифры страницы он не входит.</p>
      <p>{[...stopped].sort((a, b) => b[1] - a[1]).map(([w, q]) => `${w} ${fmt(q)}`).join(', ')}.</p>
    </details>
  );
}

function Supplies({ sups, showCluster, mp }: { sups: Supply[]; showCluster: boolean; mp: Mp }) {
  if (!sups.length) return <div className="fbo-empty">Активных поставок нет.</div>;
  const sorted = sups.slice().sort((a, b) => KIND_ORDER[a.status.kind] - KIND_ORDER[b.status.kind] || (a.sortDate || '').localeCompare(b.sortDate || ''));
  return (
    <section className="fbo-box">
      <p className="lead">{mp === 'o'
        ? 'Ozon принимает поставку на кластер, а не на конкретный склад.'
        : 'Поставки WB идут через сортировочный центр — итоговый склад WB не сообщает.'}</p>
      <table className="fbo-dt fbo-dt--wide">
        <thead><tr><th>Статус</th><th>№</th>{showCluster && <th>{mp === 'o' ? 'Кластер' : 'Регион'}</th>}<th>Куда сдаём</th><th>Когда</th><th className="r">Товаров</th><th className="r">Шт</th></tr></thead>
        <tbody>{sorted.map(s => (
          <tr key={s.id + s.cluster}>
            <td><span className={`fbo-st ${s.status.kind}`}>{s.status.label}</span></td>
            <td>{s.id}</td>
            {showCluster && <td>{s.cluster}</td>}
            <td>{s.from || s.to || '—'}</td>
            <td className="muted">{s.status.note}</td>
            <td className="r">{s.items.length}</td>
            <td className="r"><b>{fmt(s.items.reduce((a, i) => a + i.q, 0))}</b></td>
          </tr>
        ))}</tbody>
      </table>
    </section>
  );
}

function Demand({ src, onCluster }: { src: Source; onCluster: (c: string) => void }) {
  const rows = demandRows(src.orders);
  const total = rows.reduce((a, r) => a + r.q, 0);
  if (!total) return <div className="fbo-empty">Заказов за 30 дней нет.</div>;
  const isOz = src.mp === 'o';
  const max = rows[0].q;
  const fbo = rows.reduce((a, r) => a + r.fbo, 0), far = rows.reduce((a, r) => a + r.far, 0);
  const stock = new Map<string, number>();
  for (const r of src.stock) stock.set(r.cluster, (stock.get(r.cluster) ?? 0) + r.q);
  return (
    <section className="fbo-box">
      <p className="lead">
        {isOz
          ? <>За 30 дней {fmt(total)} шт.: со складов Ozon (FBO) {fmt(fbo)}, с ваших складов (FBS) {fmt(total - fbo)}. <b>{pct(far, total)}%</b> заказов везли в кластер покупателя из другого кластера. Нажмите на кластер — откроется список товаров в нём.</>
          : <>За 30 дней {fmt(total)} заказов: со складов WB (FBO) {fmt(fbo)}, с ваших складов (FBS) {fmt(total - fbo)}. WB сообщает только округ покупателя, склад отправки FBO скрывает.</>}
      </p>
      <table className="fbo-dt fbo-dt--wide">
        <thead><tr>
          <th>{isOz ? 'Кластер покупателя' : 'Округ покупателя'}</th><th className="r">FBO</th><th className="r">FBS</th><th className="bar-h" />
          {isOz && <><th className="r">Лежит FBO</th><th className="r">Издалека</th></>}
          {!isOz && <th className="r">Всего</th>}
        </tr></thead>
        <tbody>{rows.map(r => {
          const st = stock.get(r.key) ?? 0, fp = pct(r.far, r.q);
          return (
            <tr key={r.key} className={isOz ? 'click' : ''} onClick={isOz ? () => onCluster(r.key) : undefined}>
              <td className="k">{r.key}</td><td className="r">{fmt(r.fbo)}</td><td className="r muted">{fmt(r.q - r.fbo)}</td>
              <td className="bar-c"><span className="fbo-bar"><i className="fbs" style={{ width: `${(r.q / max) * 100}%` }} /><i style={{ width: `${Math.max(r.fbo ? 2 : 0, (r.fbo / max) * 100)}%` }} /></span></td>
              {isOz && <><td className={`r ${st ? '' : 'bad'}`}>{st ? fmt(st) : 'нет'}</td><td className={`r ${fp >= 50 ? 'bad' : ''}`}>{fp}%</td></>}
              {!isOz && <td className="r">{fmt(r.q)}</td>}
            </tr>
          );
        })}</tbody>
      </table>
      <div className="fbo-legend">
        <span><i style={{ background: 'var(--accent)' }} />FBO — со складов {isOz ? 'Ozon' : 'WB'}</span>
        <span><i style={{ background: 'var(--fbo-fbs)' }} />FBS — с ваших складов</span>
      </div>
    </section>
  );
}

function FbsBlock({ D }: { D: FboBundle }) {
  const rows = D.fbs.wh.map(w => ({
    ...w,
    q: D.fbs.stock.filter(r => r.wh === w.id).reduce((a, r) => a + r.q, 0),
    n: D.fbs.stock.filter(r => r.wh === w.id && r.q > 0).length,
    ow: D.fbs.ord.filter(o => o.wh === w.id && o.mp === 'w').reduce((a, o) => a + o.q, 0),
    oo: D.fbs.ord.filter(o => o.wh === w.id && o.mp === 'o').reduce((a, o) => a + o.q, 0),
  })).sort((a, b) => b.q - a.q);
  return (
    <section className="fbo-box">
      <p className="lead">Остатки — из Google‑таблицы «Склад», лист каждого склада. Это общий запас для WB и Ozon, к остаткам FBO он не прибавляется. Заказы FBS за 30 дней: WB — по листу «Отгрузка», Ozon — по данным Ozon.</p>
      <table className="fbo-dt fbo-dt--wide">
        <thead><tr><th>Склад</th><th className="r">Остаток, шт</th><th className="r">Товаров</th><th className="r">Едет на склад</th><th className="r">Заказы WB</th><th className="r">Заказы Ozon</th></tr></thead>
        <tbody>{rows.map(r => (
          <tr key={r.id}><td className="k">{r.own ? `${r.name} (свой)` : `ФФ ${r.name}`}</td><td className="r"><b>{fmt(r.q)}</b></td><td className="r">{r.n}</td><td className="r muted">{r.way ? fmt(r.way) : '—'}</td><td className="r">{fmt(r.ow)}</td><td className="r">{fmt(r.oo)}</td></tr>
        ))}</tbody>
      </table>
    </section>
  );
}
