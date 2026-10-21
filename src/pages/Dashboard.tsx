/**
 * Главная «Дашборд» (21.10.2026, вторая редакция по замечаниям владельца):
 * любой период в календаре, заказы до или после СПП (одинаково для WB и Ozon),
 * расходы по площадкам отдельными колонками, крупный шрифт, по 10 растущих и
 * падающих товаров. Всё — из накопленной истории на сервере: заказы из РНП
 * (/api/rnp/summary), расходы — /api/fin-history.
 * Графики — components/DashCharts.tsx, оформление — блок .db в styles.css.
 */
import { useEffect, useMemo, useState } from 'react';
import { TrendUpIcon, TrendDownIcon, SpinnerIcon, ArrowsClockwiseIcon } from '@phosphor-icons/react';
import '@fontsource/golos-text/400.css';
import '@fontsource/golos-text/500.css';
import '@fontsource/golos-text/600.css';
import { apiGet } from '../api/http';
import { mskDate } from '../utils/mskDate';
import { noteSwallowed } from '../utils/log';
import type { RnpSummary, RnpSummaryProduct } from '../../shared/rnp';
import {
  MiniArea, MiniBars, OrdersChart, Donut, StripeBar, ProgressBar,
  fmtRub, fmtShort, fmtDay, type Point, type DayRow,
} from '../components/DashCharts';

type Scope = 'all' | 'wb' | 'ozon';
type Preset = 'day' | 'week' | 'month' | 'custom';
type Price = 'before' | 'after';
type Nav = (k: string) => void;
type Mp = 'wb' | 'ozon';

/** Расходы площадки за период из /api/fin-history (api/_lib/finHistory.ts). */
type Fin = {
  days: number; total: number; coveredTo: string | null;
  /** Выручка после возвратов по цене продавца (до СПП) — одинаково у WB и Ozon. */
  rev: number; commission: number; logistics: number; storage: number; other: number; adsFin: number; units: number;
  cogs: number;
  excluded: { skus: string[]; rev: number };
};

const PRESET_LABEL: Record<Preset, string> = { day: 'Сегодня', week: '7 дней', month: '30 дней', custom: 'Свой период' };
const PRICE_LABEL: Record<Price, string> = { before: 'До СПП', after: 'После СПП' };
const PRICE_LOWER: Record<Price, string> = { before: 'до СПП', after: 'после СПП' };
const PRICE_HINT: Record<Price, string> = {
  before: 'до СПП — по цене продавца со всеми его скидками',
  after: 'после СПП — сколько заплатил покупатель (у Ozon — после соинвеста)',
};
const MP_NAME: Record<Mp, string> = { wb: 'Wildberries', ozon: 'Ozon' };
const pct1 = (n: number) => n.toLocaleString('ru-RU', { maximumFractionDigits: 1, minimumFractionDigits: 1 }) + ' %';
const fmtFull = (iso: string) => iso.split('-').reverse().join('.');
const fmtRange = (from: string, to: string) => from === to ? fmtFull(to) : `${fmtDay(from)} – ${fmtFull(to)}`;
const addDays = (iso: string, n: number) => new Date(Date.parse(iso + 'T00:00:00Z') + n * 86_400_000).toISOString().slice(0, 10);
const sumArr = (a: Array<number | null> | undefined, from = 0, to?: number) => (a ?? []).slice(from, to).reduce<number>((s, v) => s + (v ?? 0), 0);

function presetRange(p: Exclude<Preset, 'custom'>): { from: string; to: string } {
  const to = mskDate(0);
  return { from: p === 'day' ? to : mskDate(p === 'week' ? 6 : 29), to };
}

/** Выжимка РНП по обеим площадкам за [from, to]; нет данных или прав — null. */
function useRnp(from: string, to: string, tick: number) {
  const [data, setData] = useState<Record<Mp, RnpSummary | null>>({ wb: null, ozon: null });
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    const one = (mp: Mp) => apiGet<RnpSummary>(`/api/rnp/summary?mp=${mp}&from=${from}&to=${to}`)
      .then(r => r.data).catch(e => { noteSwallowed('dashboard', `выжимка РНП ${mp} не получена`, e); return null; });
    Promise.all([one('wb'), one('ozon')]).then(([wb, ozon]) => { if (alive) { setData({ wb, ozon }); setLoading(false); } });
    return () => { alive = false; };
  }, [from, to, tick]);
  return { ...data, loading };
}

function useFin(from: string, to: string, tick: number) {
  const [data, setData] = useState<Record<Mp, Fin> | null>(null);
  const [state, setState] = useState<'loading' | 'ok' | 'error'>('loading');
  useEffect(() => {
    let alive = true;
    setState('loading');
    apiGet<{ ok: true; wb: Fin; ozon: Fin }>(`/api/fin-history?from=${from}&to=${to}`)
      .then(r => { if (alive) { setData({ wb: r.data.wb, ozon: r.data.ozon }); setState('ok'); } })
      .catch(e => { noteSwallowed('dashboard', 'финистория не получена', e); if (alive) { setData(null); setState('error'); } });
    return () => { alive = false; };
  }, [from, to, tick]);
  return { data, state };
}

function Delta({ cur, prev, invert, suffix }: { cur: number; prev: number; invert?: boolean; suffix: string }) {
  if (!prev) return null;
  const p = ((cur - prev) / prev) * 100;
  const up = p >= 0;
  const good = invert ? !up : up;
  const Ico = up ? TrendUpIcon : TrendDownIcon;
  return (
    <span className="db-d">
      <span className={good ? 'db-good' : 'db-bad'}><Ico size={16} weight="bold" /> {pct1(Math.abs(p))}</span> {suffix}
    </span>
  );
}

function Card({ title, extra, children }: { title: string; extra?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="db-card">
      <div className="db-card-h"><h2>{title}</h2>{extra && <div className="db-card-x">{extra}</div>}</div>
      {children}
    </section>
  );
}

function ProductRow({ p, mp, n }: { p: RnpSummaryProduct; mp: Mp; n: number }) {
  const d = p.prev > 0 ? ((p.cur - p.prev) / p.prev) * 100 : null;
  const up = p.cur >= p.prev;
  return (
    <div className="db-prod">
      <span className="db-prod-i">{n}</span>
      {p.photo ? <img src={p.photo} alt="" loading="lazy" /> : <span className="db-prod-ph" />}
      <div className="db-prod-n">
        <b title={p.name || p.article}>{p.name || p.article}</b>
        <span><i className={`db-dot ${mp}`} />{mp === 'wb' ? 'WB' : 'Ozon'} · {p.cur} шт, было {p.prev}</span>
      </div>
      <span className={`db-prod-d ${up ? 'db-good' : 'db-bad'}`}>
        {d === null ? 'новый' : `${up ? '+' : '−'}${Math.round(Math.abs(d))} %`}
      </span>
    </div>
  );
}

export function Dashboard({ onNav, can = () => true }: { onNav: Nav; can?: (k: string) => boolean }) {
  const [preset, setPreset] = useState<Preset>('week');
  const [custom, setCustom] = useState(() => presetRange('month'));
  const [scope, setScope] = useState<Scope>('all');
  const [price, setPrice] = useState<Price>('before');
  const [tick, setTick] = useState(0);

  const { from, to } = preset === 'custom' ? custom : presetRange(preset);
  const today = mskDate(0);
  // Короткий период — график за две недели до его конца, иначе одна-две точки ни о чём не скажут.
  const short = (Date.parse(to) - Date.parse(from)) / 86_400_000 + 1 < 7;
  const chartFrom = short ? addDays(to, -13) : from;
  const rnp = useRnp(from, to, tick);
  const chartRnp = useRnp(chartFrom, to, tick);
  const fin = useFin(from, to, tick);

  const mps: Mp[] = scope === 'all' ? ['wb', 'ozon'] : [scope];
  const amountKey = price === 'before' ? 'amount' : 'after';
  const prevKey = price === 'before' ? 'prevAmount' : 'prevAfter';
  const firstDate = [rnp.wb?.firstDate, rnp.ozon?.firstDate].filter(Boolean).sort()[0] ?? '2026-09-12';

  // Итоги периода по выбранным площадкам. Сравнение — по закрытым дням: неполное
  // «сегодня» против полного дня прошлого окна занижало бы рост.
  const totals = useMemo(() => {
    const per = (mp: Mp) => {
      const s = rnp[mp];
      if (!s) return null;
      const closedEnd = s.to === today && s.dates.length > 1 ? s.dates.length - 1 : s.dates.length;
      const complete = s[prevKey].slice(0, closedEnd).every(v => v !== null);
      return {
        amount: sumArr(s[amountKey]), before: sumArr(s.amount), cnt: sumArr(s.cnt), ads: sumArr(s.ads),
        closed: sumArr(s[amountKey], 0, closedEnd), prevClosed: complete ? sumArr(s[prevKey], 0, closedEnd) : 0,
        closedCnt: sumArr(s.cnt, 0, closedEnd), prevCnt: complete ? sumArr(s.prevCnt, 0, closedEnd) : 0,
        afterKnown: s.after.some(v => v !== null),
      };
    };
    const by = { wb: per('wb'), ozon: per('ozon') };
    const list = mps.map(mp => by[mp]).filter((x): x is NonNullable<typeof x> => !!x);
    const add = (k: keyof NonNullable<typeof by.wb>) => list.reduce((s, x) => s + Number(x[k]), 0);
    return {
      by, any: list.length > 0,
      amount: add('amount'), before: add('before'), cnt: add('cnt'), ads: add('ads'),
      closed: add('closed'), prevClosed: list.every(x => x.prevClosed > 0) ? add('prevClosed') : 0,
      closedCnt: add('closedCnt'), prevCnt: list.every(x => x.prevCnt > 0) ? add('prevCnt') : 0,
    };
  }, [rnp, mps.join(), amountKey, prevKey, today]);

  // Ряды графика (и мини-графиков в плитках) по выбранным площадкам.
  const daily = useMemo(() => {
    const base = chartRnp.wb ?? chartRnp.ozon;
    if (!base) return null;
    const val = (mp: Mp, key: 'amount' | 'after' | 'cnt' | 'ads' | 'prevAmount' | 'prevAfter', i: number) => chartRnp[mp]?.[key]?.[i] ?? null;
    const sum = (key: 'amount' | 'after' | 'cnt' | 'ads' | 'prevAmount' | 'prevAfter', i: number, strict = false) => {
      const vs = mps.map(mp => val(mp, key, i));
      if (strict && vs.some(v => v === null)) return null;   // день без одной из площадок — линия «провалилась» бы
      return vs.every(v => v === null) ? null : vs.reduce<number>((s, v) => s + (v ?? 0), 0);
    };
    const rows: DayRow[] = base.dates.map((date, i) => ({
      date, label: fmtDay(date), today: date === today,
      wb: mps.includes('wb') ? val('wb', amountKey, i) : null,
      oz: mps.includes('ozon') ? val('ozon', amountKey, i) : null,
      prev: sum(prevKey, i, true),
    }));
    const pts = (key: 'amount' | 'after' | 'cnt'): Point[] => base.dates.map((d, i) => ({ label: fmtDay(d), value: sum(key, i) }));
    const drr: Point[] = base.dates.map((d, i) => {
      const a = sum('ads', i), r = sum('amount', i);
      return { label: fmtDay(d), value: a !== null && r ? Math.round(a / r * 1000) / 10 : null };
    });
    const closed = rows.filter(r => !r.today);
    const dayTotal = (r: DayRow) => (r.wb ?? 0) + (r.oz ?? 0);
    const best = closed.reduce<DayRow | null>((b, r) => dayTotal(r) > (b ? dayTotal(b) : 0) ? r : b, null);
    const withData = closed.filter(r => dayTotal(r) > 0);
    return {
      rows, amount: pts(amountKey), cnt: pts('cnt'), drr, best,
      avgDay: withData.length ? withData.reduce((s, r) => s + dayTotal(r), 0) / withData.length : null,
      afterMissing: price === 'after' && rows.some(r => (r.wb === null && mps.includes('wb')) || (r.oz === null && mps.includes('ozon'))),
    };
  }, [chartRnp, mps.join(), amountKey, prevKey, price, today]);

  // Расходы: статьи по каждой площадке и итог. Реклама — кампании из РНП плюс промо-начисления Ozon.
  const money = useMemo(() => {
    if (!fin.data) return null;
    const col = (mp: Mp) => {
      const f = fin.data![mp];
      const ads = (totals.by[mp]?.ads ?? 0) + f.adsFin;
      const left = f.rev - f.commission - f.logistics - f.storage - ads - f.other - f.cogs;
      return { f, ads, left };
    };
    const cols = { wb: col('wb'), ozon: col('ozon') };
    // kind: 'rev' — выручка, 'cost' — расход (минус; отрицательный расход — доход, плюс), 'left' — остаток.
    const rows: { label: string; get: (c: ReturnType<typeof col>) => number; color: string; kind: 'rev' | 'cost' | 'left' }[] = [
      { label: 'Выручка после возвратов, до СПП', get: c => c.f.rev, color: '', kind: 'rev' },
      { label: 'Комиссия и эквайринг', get: c => c.f.commission, color: 'var(--db-c1)', kind: 'cost' },
      { label: 'Логистика', get: c => c.f.logistics, color: 'var(--db-c3)', kind: 'cost' },
      { label: 'Реклама', get: c => c.ads, color: 'var(--db-c2)', kind: 'cost' },
      { label: 'Хранение', get: c => c.f.storage, color: 'var(--db-c4)', kind: 'cost' },
      { label: 'Штрафы, приёмка и прочее', get: c => c.f.other, color: 'var(--db-c6)', kind: 'cost' },
      { label: 'Себестоимость', get: c => c.f.cogs, color: 'var(--db-c5)', kind: 'cost' },
      { label: 'Прибыль', get: c => c.left, color: 'var(--db-good)', kind: 'left' },
    ];
    const tot = (r: typeof rows[number]) => mps.reduce((s, mp) => s + r.get(cols[mp]), 0);
    const net = mps.reduce((s, mp) => s + cols[mp].f.rev, 0);
    const left = mps.reduce((s, mp) => s + cols[mp].left, 0);
    const excluded = mps.reduce((s, mp) => s + cols[mp].f.excluded.skus.length, 0);
    // Неполная история — пропуски внутри периода; хвост после последнего отчёта площадки говорится отдельно.
    const partial = mps.filter(mp => {
      const f = cols[mp].f;
      const end = f.coveredTo && f.coveredTo < to ? f.coveredTo : to;
      return end >= from && f.days < (Date.parse(end) - Date.parse(from)) / 86_400_000 + 1;
    });
    return { cols, rows, tot, net, left, excluded, partial };
  }, [fin.data, totals, mps.join(), from, to]);

  const movers = useMemo(() => {
    const all = (k: 'up' | 'down') => mps
      .flatMap(mp => (rnp[mp]?.movers[k] ?? []).map(p => ({ p, mp })))
      .sort((a, b) => k === 'up' ? (b.p.cur - b.p.prev) - (a.p.cur - a.p.prev) : (a.p.cur - a.p.prev) - (b.p.cur - b.p.prev))
      .slice(0, 10);
    const mv = (rnp.wb ?? rnp.ozon)?.movers;
    return { up: all('up'), down: all('down'), range: mv ? fmtRange(mv.from, mv.to) : '' };
  }, [rnp, mps.join()]);

  // Товары для выкупов (без себестоимости в «Складе») — сколько и на какую сумму не учтено.
  const excluded = useMemo(() => {
    const skus = new Set<string>();
    let amount = 0;
    for (const mp of mps) {
      for (const s of rnp[mp]?.excluded.skus ?? []) skus.add(`${mp}:${s}`);
      for (const s of fin.data?.[mp]?.excluded.skus ?? []) skus.add(`${mp}:${s}`);
      amount += rnp[mp]?.excluded.amount ?? 0;
    }
    return { count: skus.size, amount, list: [...skus].map(s => s.split(':').slice(1).join(':')).join(', ') };
  }, [rnp, fin.data, mps.join()]);

  const drr = totals.before > 0 && totals.any ? totals.ads / totals.before * 100 : null;
  const avg = totals.cnt > 0 ? totals.amount / totals.cnt : 0;
  const collectedAt = [rnp.wb?.collectedAt, rnp.ozon?.collectedAt].filter((x): x is number => !!x).sort((a, b) => a - b)[0];
  const prevLabel = `к ${fmtRange(addDays(from, -((Date.parse(to) - Date.parse(from)) / 86_400_000 + 1)), addDays(from, -1))}`;

  return (
    <div className="db">
      <header className="db-head">
        <div className="db-ctrls">
          <div className="db-seg" role="group" aria-label="Период">
            {(Object.keys(PRESET_LABEL) as Preset[]).map(p => (
              <button key={p} type="button" className={preset === p ? 'on' : ''} onClick={() => setPreset(p)}>{PRESET_LABEL[p]}</button>
            ))}
          </div>
          {preset === 'custom' && (
            <div className="db-dates">
              <label>с <input type="date" id="db-from" value={custom.from} min={firstDate} max={custom.to}
                onChange={e => e.target.value && setCustom(c => ({ ...c, from: e.target.value }))} /></label>
              <label>по <input type="date" id="db-to" value={custom.to} min={custom.from} max={today}
                onChange={e => e.target.value && setCustom(c => ({ ...c, to: e.target.value }))} /></label>
            </div>
          )}
        </div>
        <div className="db-ctrls">
          <div className="db-seg" role="group" aria-label="Площадка">
            {([['all', 'Все площадки'], ['wb', 'Wildberries'], ['ozon', 'Ozon']] as [Scope, string][]).map(([k, l]) => (
              <button key={k} type="button" className={scope === k ? 'on' : ''} onClick={() => setScope(k)}>
                {k !== 'all' && <i className={`db-dot ${k}`} />}{l}
              </button>
            ))}
          </div>
          <div className="db-seg" role="group" aria-label="Цена заказов">
            {(Object.keys(PRICE_LABEL) as Price[]).map(p => (
              <button key={p} type="button" className={price === p ? 'on' : ''} onClick={() => setPrice(p)}>{PRICE_LABEL[p]}</button>
            ))}
          </div>
        </div>
        <div className="db-range">
          {fmtRange(from, to)}
          <span className="db-sub">
            {to === today && ' · сегодня ещё не закрыт'}
            {collectedAt && ` · данные на ${new Date(collectedAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`}
          </span>
          <button type="button" className="db-go" onClick={() => setTick(t => t + 1)} title="Перечитать данные с сервера">
            {rnp.loading ? <SpinnerIcon size={16} className="spin" /> : <ArrowsClockwiseIcon size={16} weight="bold" />} Обновить
          </button>
        </div>
      </header>

      <div className="db-tiles">
        <div className="db-card db-tile">
          <div className="db-tile-t">Сумма заказов · {PRICE_LOWER[price]}</div>
          <div className="db-tile-v">{totals.any ? fmtRub(totals.amount) : '—'}</div>
          {totals.prevClosed > 0 ? <Delta cur={totals.closed} prev={totals.prevClosed} suffix={prevLabel} />
            : <span className="db-d">{to === today && from === to ? 'день ещё идёт — сравним завтра' : 'прошлый период собран не целиком'}</span>}
          <MiniArea points={daily?.amount ?? []} color="var(--db-acc)" name="Заказано" format={fmtRub} />
        </div>
        <div className="db-card db-tile">
          <div className="db-tile-t">Заказы</div>
          <div className="db-tile-v">{totals.any ? `${totals.cnt.toLocaleString('ru-RU')} шт` : '—'}</div>
          <span className="db-d">средний чек {fmtRub(avg)}</span>
          {totals.prevCnt > 0 && <Delta cur={totals.closedCnt} prev={totals.prevCnt} suffix={prevLabel} />}
          <MiniArea points={daily?.cnt ?? []} color="var(--db-c2)" name="Заказов" format={v => `${Math.round(v)} шт`} />
        </div>
        <div className="db-card db-tile">
          <div className="db-tile-t">Прибыль</div>
          <div className={`db-tile-v ${money && money.left < 0 ? 'db-bad' : ''}`}>{money && money.net > 0 ? fmtRub(money.left) : fin.state === 'loading' ? '…' : '—'}</div>
          <span className="db-d">
            {money && money.net > 0 ? `${pct1(money.left / money.net * 100)} от выручки до СПП`
              : fin.state === 'loading' ? 'считаем расходы…' : 'за период нет финотчёта'}
          </span>
          {money && money.net > 0 && <ProgressBar pct={money.left / money.net * 100} color="var(--db-good)"
            left={<>прибыль {fmtShort(money.left)} ₽</>} right={<>выручка {fmtShort(money.net)} ₽</>} />}
        </div>
        <div className="db-card db-tile">
          <div className="db-tile-t">ДРР — реклама ÷ заказы до СПП</div>
          <div className="db-tile-v" style={{ color: drr == null ? undefined : drr < 10 ? 'var(--db-good)' : drr < 20 ? 'var(--db-warn)' : 'var(--db-bad)' }}>
            {drr != null ? pct1(drr) : '—'}
          </div>
          <span className="db-d">реклама {fmtRub(totals.ads)}</span>
          <MiniBars points={daily?.drr ?? []} color="var(--db-c2)" name="ДРР" format={v => pct1(v)} />
        </div>
      </div>

      <Card title={`Заказы по дням, ₽ · ${PRICE_LOWER[price]}`} extra={
        <div className="db-legend">
          {mps.includes('wb') && <span><i className="db-mark" style={{ background: 'var(--db-wb)' }} />Wildberries</span>}
          {mps.includes('ozon') && <span><i className="db-mark" style={{ background: 'var(--db-oz)' }} />Ozon</span>}
          <span><i className="db-mark db-mark-dash" />прошлый период</span>
        </div>}>
        <div className="db-note db-note-top">
          Обе площадки в одном формате: {PRICE_HINT[price]}. WB — как «Заказали на сумму» в аналитике кабинета.
          {short && ' Выбран короткий период — на графике две недели до его конца.'}
        </div>
        {daily ? (<>
          <OrdersChart rows={daily.rows} showWb={mps.includes('wb')} showOz={mps.includes('ozon')} prevName="Прошлый период" />
          <div className="db-metrics">
            <div><span>В среднем за день</span><b>{daily.avgDay ? `${fmtShort(daily.avgDay)} ₽` : '—'}</b><em>без сегодняшнего</em></div>
            <div><span>Лучший день</span><b>{daily.best ? fmtDay(daily.best.date) : '—'}</b><em>{daily.best ? `${fmtShort((daily.best.wb ?? 0) + (daily.best.oz ?? 0))} ₽` : ''}</em></div>
          </div>
          {daily.afterMissing && <div className="db-note">За дни без данных о СПП сумма после СПП не показана.</div>}
        </>) : <div className="db-empty">{chartRnp.loading ? 'Загружаем…' : 'За этот период данных РНП нет.'}</div>}
      </Card>

      <Card title="Расходы и прибыль" extra={money ? <span className="db-sub">по цене продавца (до СПП), из каждых 100 ₽ выручки</span> : undefined}>
        {money && money.net > 0 ? (<>
          <StripeBar slices={money.rows.slice(1).map(r => ({ label: r.label, value: Math.max(0, money.tot(r)), color: r.color }))} />
          <div className="db-tbl-wrap">
            <table className="db-tbl">
              <thead><tr>
                <th>Статья</th>
                {mps.map(mp => <th key={mp} className="r"><i className={`db-dot ${mp}`} />{MP_NAME[mp]}</th>)}
                {mps.length > 1 && <th className="r">Всего</th>}
                <th className="r">Из 100 ₽</th>
              </tr></thead>
              <tbody>
                {money.rows.map(r => {
                  // Расход — со знаком минус; отрицательный расход (доплаты, компенсации) — доход, с плюсом.
                  const cell = (v: number) => r.kind !== 'cost' ? fmtRub(v) : v > 0 ? `−${fmtRub(v)}` : v < 0 ? `+${fmtRub(-v)}` : fmtRub(0);
                  const t = money.tot(r);
                  return (
                    <tr key={r.label} className={r.kind !== 'cost' ? 'db-tbl-strong' : ''}>
                      <td>{r.color && <i className="db-mark" style={{ background: r.color }} />}{r.label}</td>
                      {mps.map(mp => {
                        const v = r.get(money.cols[mp]);
                        return <td key={mp} className={`r ${r.kind === 'left' && v < 0 ? 'db-bad' : ''}`}>{cell(v)}</td>;
                      })}
                      {mps.length > 1 && <td className={`r ${r.kind === 'left' && t < 0 ? 'db-bad' : ''}`}>{cell(t)}</td>}
                      <td className="r">{r.kind === 'rev' ? '100 ₽' : `${Math.round(t / money.net * 100)} ₽`}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="db-note">
            Выручка у обеих площадок — по цене продавца до СПП; комиссия — всё, что площадка удержала с этой цены, кроме логистики.
            Реклама — расход кампаний из РНП{mps.includes('ozon') ? ' плюс начисления Ozon за продвижение' : ''}.
            {mps.map(mp => money.cols[mp].f.coveredTo && money.cols[mp].f.coveredTo! < to ? ` Финотчёт ${MP_NAME[mp]} есть по ${fmtFull(money.cols[mp].f.coveredTo!)}.` : '').join('')}
            {money.partial.length ? ` История расходов ${money.partial.map(mp => MP_NAME[mp]).join(' и ')} за этот период неполная.` : ''}
          </div>
        </>) : <div className="db-empty">{fin.state === 'loading' ? 'Считаем расходы…' : 'За этот период финансовых данных нет.'}</div>}
      </Card>

      <Card title="Площадки" extra={<span className="db-sub">сумма заказов {PRICE_LOWER[price]}</span>}>
        <div className="db-plats">
          <Donut
            slices={[{ label: 'Wildberries', value: totals.by.wb?.amount ?? 0, color: 'var(--db-wb)' }, { label: 'Ozon', value: totals.by.ozon?.amount ?? 0, color: 'var(--db-oz)' }]}
            center={fmtShort((totals.by.wb?.amount ?? 0) + (totals.by.ozon?.amount ?? 0))} sub="₽ заказов" />
          <div className="db-plat-list">
            {(['wb', 'ozon'] as Mp[]).map(mp => {
              const t = totals.by[mp];
              const all = (totals.by.wb?.amount ?? 0) + (totals.by.ozon?.amount ?? 0);
              return (
                <div key={mp} className="db-plat">
                  <div className="db-plat-h"><span><i className={`db-dot ${mp}`} />{MP_NAME[mp]}</span>{t && all > 0 && <span>{Math.round(t.amount / all * 100)} %</span>}</div>
                  <div className="db-plat-g">
                    <div><span>Заказы</span><b>{t ? fmtShort(t.amount) + ' ₽' : '—'}</b></div>
                    <div><span>Штук</span><b>{t ? t.cnt.toLocaleString('ru-RU') : '—'}</b></div>
                    <div><span>Ср. чек</span><b>{t && t.cnt ? fmtRub(t.amount / t.cnt) : '—'}</b></div>
                    <div><span>ДРР</span><b>{t && t.before ? pct1(t.ads / t.before * 100) : '—'}</b></div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </Card>

      <div className="db-row-2">
        <Card title="Растут" extra={<span className="db-sub">заказы, шт: {movers.range} к такому же сроку до этого</span>}>
          {movers.up.length ? movers.up.map(({ p, mp }, i) => <ProductRow key={mp + p.sku} p={p} mp={mp} n={i + 1} />)
            : <div className="db-empty">{rnp.loading ? 'Загружаем…' : 'Заметного роста нет.'}</div>}
        </Card>
        <Card title="Падают" extra={can('rnp') ? <button type="button" className="db-go" onClick={() => onNav('rnp')}>Причины в РНП</button> : undefined}>
          {movers.down.length ? movers.down.map(({ p, mp }, i) => <ProductRow key={mp + p.sku} p={p} mp={mp} n={i + 1} />)
            : <div className="db-empty">{rnp.loading ? 'Загружаем…' : 'Заметного падения нет.'}</div>}
        </Card>
      </div>

      {excluded.count > 0 && (
        <div className="db-note db-excl" title={excluded.list}>
          Не учтены товары для выкупов — артикулы без себестоимости в таблице «Склад»: {excluded.count} шт.
          {excluded.amount > 0 && ` Их заказы за период — ${fmtRub(excluded.amount)}.`}
          {' '}Чтобы товар попал в расчёты, заведите его себестоимость в «Складе».
        </div>
      )}
    </div>
  );
}
