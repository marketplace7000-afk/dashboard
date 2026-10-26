/**
 * «Остатки FBO» (26.10.2026) — остатки на складах маркетплейсов по кластерам Ozon
 * и регионам WB, поставки к ним, где покупают и свои склады (FBS) отдельным блоком.
 * Снимок собирает сервер (api/_lib/fboStocks.ts) раз в 3 часа; расчёты — utils/fboModel.ts.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowsClockwiseIcon } from '@phosphor-icons/react';
import '../fbo.css';
import { apiGet, apiPost, errText } from '../api/http';
import {
  type FboBundle, type Mp, type Source, type Item, type Supply,
  buildOzon, buildWb, clustersOf, demandRows, itemsFor, fmt, pct, plural, KIND_ORDER,
} from '../utils/fboModel';

type Resp = { ok: boolean; data: FboBundle | null; collecting: boolean; ageMin: number | null };

const SUP_MAX = 4;

export function Fbo() {
  const [resp, setResp] = useState<Resp | null>(null);
  const [err, setErr] = useState('');
  const [mp, setMp] = useState<Mp>('o');
  const [cluster, setCluster] = useState<string | null>(null);
  const [wh, setWh] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [supOpen, setSupOpen] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  const load = async () => {
    try {
      const r = await apiGet<Resp>('/api/fbo');
      setResp(r.data); setErr('');
      // Пока сервер собирает снимок — спрашиваем снова.
      window.clearTimeout(timer.current);
      if (r.data.collecting) timer.current = window.setTimeout(load, 20_000);
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

  const pickMp = (m: Mp) => { setMp(m); setCluster(null); setWh(null); setSupOpen(false); };
  const pickCluster = (c: string | null) => { setCluster(c); setWh(null); setSupOpen(false); };

  if (err && !D) return <div className="card">Не удалось загрузить остатки: {err}</div>;
  if (!resp) return <div className="card muted">Загружаю остатки…</div>;
  if (!D || !src) {
    return (
      <div className="card">
        <h2>Остатки FBO</h2>
        <p className="muted">{resp.collecting
          ? 'Собираю данные с Ozon, WB и таблицы «Склад» — это занимает 2–4 минуты (у WB строгие лимиты на поставки). Страница обновится сама.'
          : 'Данных пока нет.'}</p>
        {!resp.collecting && <button className="btn btn-primary" onClick={refresh}>Собрать сейчас</button>}
      </div>
    );
  }

  const S = src[mp];
  const at = new Date(D.at).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });

  return (
    <div className="fbo">
      <div className="fbo-top">
        <div>
          <div className="fbo-sub">Остатки на складах маркетплейса, поставки к ним и где покупают. Ваши склады (FBS) — отдельным блоком, в остатки FBO не входят.</div>
        </div>
        <div className="fbo-upd">
          <span className="muted">Данные на {at}</span>
          <button className="btn btn-sm" onClick={refresh} disabled={resp.collecting} title="Собрать данные заново">
            <ArrowsClockwiseIcon size={16} weight="bold" /> {resp.collecting ? 'Обновляю…' : 'Обновить'}
          </button>
        </div>
      </div>
      {D.notes.length > 0 && <div className="fbo-note">Не всё удалось получить: {D.notes.join('; ')}</div>}

      <div className="fbo-controls">
        <div className="fbo-seg" role="group" aria-label="Площадка">
          <button aria-pressed={mp === 'o'} onClick={() => pickMp('o')}>Ozon</button>
          <button aria-pressed={mp === 'w'} onClick={() => pickMp('w')}>Wildberries</button>
        </div>
        <input className="fbo-search" type="search" placeholder="Найти товар или артикул" value={query} onChange={e => setQuery(e.target.value)} />
      </div>

      <div className="fbo-layout">
        <ClusterNav src={S} cluster={cluster} wh={wh} onCluster={pickCluster} onWh={w => setWh(cur => (cur === w ? null : w))} />
        <main className="fbo-panel">
          <Panel D={D} src={S} cluster={cluster} wh={wh} query={query} supOpen={supOpen}
            onSupToggle={() => setSupOpen(v => !v)} onCluster={c => { pickCluster(c); window.scrollTo({ top: 0 }); }} />
        </main>
      </div>
    </div>
  );
}

function ClusterNav({ src, cluster, wh, onCluster, onWh }: {
  src: Source; cluster: string | null; wh: string | null; onCluster: (c: string | null) => void; onWh: (w: string) => void;
}) {
  const cls = clustersOf(src);
  const total = cls.reduce((a, c) => a + c.q, 0);
  return (
    <nav className="fbo-nav" aria-label="Кластеры и склады">
      <button className="fbo-cl" aria-current={!cluster} onClick={() => onCluster(null)}>
        <span className="n">Все {src.noun === 'кластер' ? 'кластеры' : 'регионы'}</span><span className="q">{fmt(total)}</span>
      </button>
      <div className="fbo-sep" />
      {cls.map(c => {
        const cur = cluster === c.name;
        return (
          <div key={c.name}>
            <button className="fbo-cl" aria-current={cur} onClick={() => onCluster(c.name)}>
              <span className="n">{c.name}</span><span className="q">{c.q ? fmt(c.q) : '—'}</span>
              {(c.ord > 0 || c.go > 0 || c.soon > 0) && (
                <span className="s">
                  {c.ord > 0 && <span>заказов {fmt(c.ord)}</span>}
                  {c.go > 0 && <span className="go">едет {fmt(c.go)}</span>}
                  {c.soon > 0 && <span className="wait">готовится {fmt(c.soon)}</span>}
                </span>
              )}
            </button>
            {cur && c.whs.size > 1 && (
              <div className="fbo-whs">
                {[...c.whs].sort((a, b) => b[1] - a[1]).map(([w, q]) => (
                  <button key={w} className="fbo-whb" aria-current={wh === w} onClick={() => onWh(w)}><span>{w}</span><span>{fmt(q)}</span></button>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </nav>
  );
}

const SUP_NOTE: Record<Mp, string> = {
  o: 'Ozon принимает поставку на кластер, а не на конкретный склад. Поставки видны при выборе кластера целиком.',
  w: 'Поставки WB идут через сортировочный центр, итоговый склад становится известен после приёмки. Поставки видны при выборе региона целиком.',
};

function Panel({ D, src, cluster, wh, query, supOpen, onSupToggle, onCluster }: {
  D: FboBundle; src: Source; cluster: string | null; wh: string | null; query: string; supOpen: boolean;
  onSupToggle: () => void; onCluster: (c: string) => void;
}) {
  const { items, supplies } = itemsFor(src, cluster, wh, query);
  const isOz = src.mp === 'o';
  const title = wh || cluster || (isOz ? 'Все кластеры' : 'Все регионы');
  const stockSum = items.reduce((a, it) => a + it.q, 0);
  const goSum = items.reduce((a, it) => a + it.lines.filter(l => l.s.status.kind !== 'idle' && l.s.status.kind !== 'done').reduce((x, l) => x + l.q, 0), 0);
  const zeroGoing = items.filter(it => !it.q).length;
  const sups = supplies.slice().sort((a, b) => KIND_ORDER[a.status.kind] - KIND_ORDER[b.status.kind] || (a.sortDate || '').localeCompare(b.sortDate || ''));
  const demHere = isOz && cluster ? demandRows(src.orders).find(r => r.key === cluster) : undefined;
  const stockByCluster = new Map<string, number>();
  for (const r of src.stock) stockByCluster.set(r.cluster, (stockByCluster.get(r.cluster) ?? 0) + r.q);

  return (
    <>
      <section className="fbo-head">
        <h2>{title}</h2>
        <div className="fbo-facts">
          <span><b>{fmt(stockSum)}</b>шт. FBO на складах {isOz ? 'Ozon' : 'WB'}</span>
          <span><b>{fmt(items.filter(i => i.q).length)}</b>товаров в наличии</span>
          {!wh && <span><b>{fmt(goSum)}</b>шт. едет или готовится</span>}
          {isOz && cluster && (demHere
            ? <><span><b>{fmt(demHere.q)}</b>шт. заказали сюда за 30 дней</span>
                <span><b className={pct(demHere.far, demHere.q) >= 50 ? 'bad' : ''}>{pct(demHere.far, demHere.q)}%</b>везли из других кластеров</span></>
            : <span><b>0</b>заказов сюда за 30 дней</span>)}
          {zeroGoing > 0 && <span><b>{zeroGoing}</b>нет здесь, но есть в поставке</span>}
        </div>
        {isOz && cluster && !wh && demHere && demHere.far > 0 && (
          <p className="fbo-farfrom">Откуда везли заказы этого кластера: {[...demHere.from].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ')}.</p>
        )}
        {wh
          ? <div className="fbo-sups muted">{SUP_NOTE[src.mp]}</div>
          : sups.length
            ? <div className="fbo-sups">
                <h3>Поставки{cluster ? ' сюда' : ''}</h3>
                {sups.slice(0, supOpen ? 999 : SUP_MAX).map(s => <SupplyRow key={s.id + s.cluster} s={s} showCluster={!cluster} />)}
                {sups.length > SUP_MAX && <button className="fbo-more" onClick={onSupToggle}>{supOpen ? 'Свернуть' : `Показать все поставки (${sups.length})`}</button>}
              </div>
            : <div className="fbo-sups muted">Активных поставок нет.</div>}
      </section>

      {!cluster && !wh && <>
        {src.stopped.size > 0 && <Stopped stopped={src.stopped} />}
        <Demand src={src} stockByCluster={stockByCluster} onCluster={onCluster} />
        <FbsBlock D={D} />
      </>}

      {items.length
        ? <div className="fbo-grid">{items.map(it => <Card key={it.art} it={it} src={src} D={D} cluster={cluster} wh={wh} />)}</div>
        : <div className="fbo-empty">Ничего не нашлось. Измените поиск или выберите другой {src.noun}.</div>}
    </>
  );
}

function SupplyRow({ s, showCluster }: { s: Supply; showCluster: boolean }) {
  const n = s.items.reduce((a, i) => a + i.q, 0);
  const where = s.from ? `сдаём в ${s.from}` : s.to ? `на ${s.to}` : '';
  return (
    <div className="fbo-sup">
      <span className={`fbo-st ${s.status.kind}`}>{s.status.label}</span>
      <span>№ {s.id}, {fmt(n)} шт., {s.items.length} {plural(s.items.length, 'товар', 'товара', 'товаров')}{showCluster ? ` → ${s.cluster}` : ''}
        <div className="meta">{s.status.note}{where ? ', ' + where : ''}</div>
      </span>
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

function Demand({ src, stockByCluster, onCluster }: { src: Source; stockByCluster: Map<string, number>; onCluster: (c: string) => void }) {
  const rows = demandRows(src.orders);
  const total = rows.reduce((a, r) => a + r.q, 0);
  if (!total) return null;
  const max = rows[0].q;
  const isOz = src.mp === 'o';
  const fbo = rows.reduce((a, r) => a + r.fbo, 0);
  const far = rows.reduce((a, r) => a + r.far, 0);
  return (
    <section className={`fbo-box fbo-dem ${isOz ? 'oz' : 'wb'}`}>
      <h3>Где покупают</h3>
      <p className="lead">
        {isOz
          ? <>За 30 дней {fmt(total)} шт.: со складов Ozon (FBO) {fmt(fbo)}, с ваших складов (FBS) {fmt(total - fbo)}. <b>{pct(far, total)}%</b> заказов везли в кластер покупателя из другого кластера — это дольше для покупателя.</>
          : <>За 30 дней {fmt(total)} заказов: со складов WB (FBO) {fmt(fbo)}, с ваших складов (FBS) {fmt(total - fbo)}. WB сообщает только округ покупателя, а склад отправки FBO скрывает.</>}
      </p>
      <div className="fbo-dhead">
        <span>{isOz ? 'Кластер покупателя' : 'Округ покупателя'}</span><span className="r">FBO</span><span /><span className="r">FBS</span>
        {isOz ? <><span className="r">Лежит FBO</span><span className="r">Издалека</span></> : <span className="r">Всего</span>}
      </div>
      {rows.map(r => {
        const bar = (
          <span className="fbo-bar">
            <i className="fbs" style={{ width: `${(r.q / max) * 100}%` }} />
            <i style={{ width: `${Math.max(r.fbo ? 2 : 0, (r.fbo / max) * 100)}%` }} />
          </span>
        );
        if (!isOz) return (
          <div key={r.key} className="fbo-drow"><span>{r.key}</span><span className="r">{fmt(r.fbo)}</span>{bar}<span className="r muted">{fmt(r.q - r.fbo)}</span><span className="r">{fmt(r.q)}</span></div>
        );
        const stock = stockByCluster.get(r.key) ?? 0, farP = pct(r.far, r.q);
        return (
          <button key={r.key} className="fbo-drow" onClick={() => onCluster(r.key)}>
            <span>{r.key}</span><span className="r">{fmt(r.fbo)}</span>{bar}<span className="r muted">{fmt(r.q - r.fbo)}</span>
            <span className={`r ${stock ? '' : 'bad'}`}>{stock ? fmt(stock) : 'нет'}</span>
            <span className={`r ${farP >= 50 ? 'bad' : ''}`}>{farP}%</span>
          </button>
        );
      })}
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
    ow: D.fbs.ord.filter(o => o.wh === w.id && o.mp === 'w').reduce((a, o) => a + o.q, 0),
    oo: D.fbs.ord.filter(o => o.wh === w.id && o.mp === 'o').reduce((a, o) => a + o.q, 0),
  })).sort((a, b) => b.q - a.q);
  return (
    <section className="fbo-box fbo-fbs">
      <h3>Ваши склады (FBS)</h3>
      <p className="lead">Остатки — из Google‑таблицы «Склад», лист каждого склада. Это общий запас для WB и Ozon, поэтому к остаткам FBO он не прибавляется.</p>
      <div className="fbo-dhead"><span>Склад</span><span className="r">Остаток</span><span className="r">Едет на склад</span><span className="r">Заказы WB</span><span className="r">Заказы Ozon</span></div>
      {rows.map(r => (
        <div key={r.id} className="fbo-drow">
          <span>{r.own ? `${r.name} (свой)` : `ФФ ${r.name}`}</span><span className="r"><b>{fmt(r.q)}</b></span>
          <span className="r muted">{r.way ? fmt(r.way) : '—'}</span><span className="r">{fmt(r.ow)}</span><span className="r">{fmt(r.oo)}</span>
        </div>
      ))}
      <p className="lead" style={{ margin: '8px 0 0' }}>Заказы FBS за 30 дней: WB — по листу «Отгрузка», Ozon — по данным Ozon.</p>
    </section>
  );
}

function Card({ it, src, D, cluster, wh }: { it: Item; src: Source; D: FboBundle; cluster: string | null; wh: string | null }) {
  const own = src.orders.filter(o => o.art.toUpperCase() === it.art.toUpperCase());
  const total = own.reduce((a, o) => a + o.q, 0);
  let demand: JSX.Element;
  if (!own.length) demand = <div className="dem muted">Заказов за 30 дней не было</div>;
  else if (cluster && src.mp === 'o') {
    const here = own.filter(o => o.key === cluster);
    const n = here.reduce((a, o) => a + o.q, 0), far = here.filter(o => o.from !== o.key).reduce((a, o) => a + o.q, 0);
    demand = n
      ? <div className="dem">Заказали сюда за 30 дней: <b>{fmt(n)}</b>{far ? <>, <span className="bad">из них {fmt(far)} везли из других кластеров</span></> : ', всё из этого кластера'}</div>
      : <div className="dem muted">Сюда за 30 дней не заказывали (всего {fmt(total)} шт.)</div>;
  } else {
    const top = demandRows(own).slice(0, 3).map(r => `${r.key} ${pct(r.q, total)}%`).join(', ');
    const fbo = own.filter(o => !o.fbs).reduce((a, o) => a + o.q, 0);
    demand = <div className="dem">Покупают: {top} <span className="muted">(FBO {fmt(fbo)}, FBS {fmt(total - fbo)} за 30 дней)</span></div>;
  }
  const ffName = new Map(D.fbs.wh.map(w => [w.id, w.own ? w.name : 'ФФ ' + w.name]));
  const fbs = D.fbs.stock.filter(r => r.art.toUpperCase() === it.art.toUpperCase()).sort((a, b) => b.q - a.q);
  return (
    <article className="fbo-card">
      <div className="ph" style={it.img ? { backgroundImage: `url("${it.img}")` } : undefined} role="img" aria-label={it.name} />
      <div>
        <div className="nm" title={it.name}>{it.name}</div>
        <div className="art">{it.art}</div>
        <div className={`qty ${it.q ? '' : 'zero'}`}><b>{fmt(it.q)}</b><span>шт. {it.q ? 'на складе' : '— на складе нет'}</span></div>
        {(it.whs.length > 1 || (it.whs.length === 1 && !wh)) && (
          <div className="where">{it.whs.map(([w, q], i) => <span key={w}>{i ? ', ' : ''}{w} <b>{q}</b></span>)}</div>
        )}
        {demand}
        {fbs.length > 0 && (
          <div className="fbsl">FBS у вас: {fbs.map((r, i) => <span key={r.wh}>{i ? ', ' : ''}{ffName.get(r.wh)} <b className={r.q < 0 ? 'bad' : ''}>{r.q}</b></span>)}</div>
        )}
      </div>
      {it.lines.length
        ? <div className="go-lines">{it.lines.map((l, i) => (
            <div key={i} className="gl"><span className={`fbo-st ${l.s.status.kind}`}>{l.s.status.label}</span><span className="t">{l.s.status.note.split(',')[0]}</span><b>+{fmt(l.q)}</b></div>
          ))}</div>
        : !wh && <div className="nogo">{cluster ? 'Поставок сюда нет' : 'Активных поставок нет'}</div>}
    </article>
  );
}
