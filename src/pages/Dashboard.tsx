/**
 * Главная «Дашборд» в стиле А (21.10.2026): один период на всю страницу,
 * плитки с мини-графиками, заказы по дням, «Требует внимания», куда уходят
 * деньги, площадки, растущие и падающие товары, быстрые переходы.
 * Графики — components/DashCharts.tsx, оформление — блок .db в styles.css.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  ArrowUpRightIcon, TrendUpIcon, TrendDownIcon, SpinnerIcon, WarningIcon,
} from '@phosphor-icons/react';
import '@fontsource/golos-text/400.css';
import '@fontsource/golos-text/500.css';
import '@fontsource/golos-text/600.css';
import { DailyAiInsights } from '../components/DailyAiInsights';
import { LastUpdated } from '../components/LastUpdated';
import { useLiveOzon, PeriodKey, PERIOD_LABEL } from '../api/useLiveOzon';
import { useLiveWb, refreshLiveWb } from '../api/useLiveWb';
import { useFinanceSummary } from '../api/useFinanceSummary';
import { fmtClock } from '../api/sideResource';
import { apiGet } from '../api/http';
import { reviewsApi } from '../api/reviews';
import { chatsApi } from '../api/chats';
import { periodRange, prevPeriodRange, PERIOD_DAYS } from '../utils/period';
import { noteSwallowed } from '../utils/log';
import type { RnpSummary, RnpSummaryProduct } from '../../shared/rnp';
import type { Ads2Signal, Ads2SignalsResponse } from '../../shared/ads2';
import {
  MiniArea, MiniBars, OrdersChart, Donut, StripeBar, ProgressBar,
  fmtRub, fmtShort, fmtDay, type Point, type DayRow, type Slice,
} from '../components/DashCharts';

type Scope = 'all' | 'wb' | 'ozon';
type Nav = (k: string) => void;

const pct1 = (n: number) => n.toLocaleString('ru-RU', { maximumFractionDigits: 1, minimumFractionDigits: 1 }) + ' %';
const fmtRange = (from: string, to: string) => from === to ? fmtDay(to) : `${fmtDay(from)} – ${fmtDay(to)}`;
const PREV_LABEL: Record<PeriodKey, string> = { day: 'к вчера', week: 'к прошлым 7 дням', month: 'к прошлым 30 дням' };

/** Выжимка РНП по обеим площадкам; без прав или без данных — просто null. */
function useRnpSummary(period: PeriodKey) {
  const [data, setData] = useState<{ wb: RnpSummary | null; ozon: RnpSummary | null }>({ wb: null, ozon: null });
  useEffect(() => {
    let alive = true;
    const days = PERIOD_DAYS[period];
    const one = (mp: 'wb' | 'ozon') => apiGet<RnpSummary>(`/api/rnp/summary?mp=${mp}&days=${days}`)
      .then(r => r.data).catch(e => { noteSwallowed('dashboard', `выжимка РНП ${mp} не получена`, e); return null; });
    const load = () => Promise.all([one('wb'), one('ozon')]).then(([wb, ozon]) => { if (alive) setData({ wb, ozon }); });
    void load();
    const t = setInterval(load, 5 * 60_000);
    return () => { alive = false; clearInterval(t); };
  }, [period]);
  return data;
}

/** Открытые сигналы Советника и счётчики отзывов/чатов. Раздел закрыт правами — пропускаем молча. */
function useAttention() {
  const [signals, setSignals] = useState<Ads2Signal[] | null>(null);
  const [reviews, setReviews] = useState<number | null>(null);
  const [chats, setChats] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => {
      Promise.all((['wb', 'ozon'] as const).map(mp => apiGet<Ads2SignalsResponse>(`/api/ads2/signals?mp=${mp}`)
        .then(r => r.data?.issue?.signals ?? []).catch(() => null)))
        .then(([wb, oz]) => {
          if (!alive) return;
          if (wb === null && oz === null) { setSignals(null); return; }
          setSignals([...(wb ?? []), ...(oz ?? [])].filter(s => s.status === 'open'));
        });
      reviewsApi.overview()
        .then(o => { if (alive) setReviews(Object.values(o.counters).reduce((s, c) => s + (c?.unanswered ?? 0), 0)); })
        .catch(() => { if (alive) setReviews(null); });
      chatsApi.counts()
        .then(c => { if (alive) setChats(c.waiting); })
        .catch(() => { if (alive) setChats(null); });
    };
    load();
    const t = setInterval(load, 5 * 60_000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  return { signals, reviews, chats };
}

function Delta({ cur, prev, invert, suffix }: { cur: number; prev: number; invert?: boolean; suffix: string }) {
  if (!prev) return <span className="db-d">{suffix && `нет данных ${suffix.replace(/^к /, 'за ')}`}</span>;
  const p = ((cur - prev) / prev) * 100;
  const up = p >= 0;
  const good = invert ? !up : up;
  const Ico = up ? TrendUpIcon : TrendDownIcon;
  return (
    <span className="db-d">
      <span className={good ? 'db-good' : 'db-bad'}><Ico size={14} weight="bold" /> {pct1(Math.abs(p))}</span> {suffix}
    </span>
  );
}

function Card({ title, extra, children, className }: { title: string; extra?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={`db-card ${className ?? ''}`}>
      <div className="db-card-h"><h2>{title}</h2>{extra && <div className="db-card-x">{extra}</div>}</div>
      {children}
    </section>
  );
}

function GoBtn({ to, onNav, children }: { to: string; onNav: Nav; children: React.ReactNode }) {
  return <button type="button" className="db-go" onClick={() => onNav(to)}>{children} <ArrowUpRightIcon size={14} weight="bold" /></button>;
}

const LEVEL_RANK = { critical: 0, warn: 1, info: 2 } as const;
const ROLE_PAGE: Record<string, string> = { ads: 'ads', price: 'prices', supply: 'rnp', card: 'rnp', content: 'rnp' };

function ProductRow({ p, mp }: { p: RnpSummaryProduct; mp: 'wb' | 'ozon' }) {
  const d = p.prev > 0 ? ((p.cur - p.prev) / p.prev) * 100 : null;
  const up = p.cur >= p.prev;
  return (
    <div className="db-prod">
      {p.photo ? <img src={p.photo} alt="" loading="lazy" /> : <span className="db-prod-ph" />}
      <div className="db-prod-n">
        <b title={p.name || p.article}>{p.name || p.article}</b>
        <span><i className={`db-dot ${mp}`} />{mp === 'wb' ? 'WB' : 'Ozon'} · {p.article} · {p.cur} шт {p.prev ? `(было ${p.prev})` : ''}</span>
      </div>
      <span className={`db-prod-d ${up ? 'db-good' : 'db-bad'}`}>
        {d === null ? 'новый' : `${up ? '+' : '−'}${Math.round(Math.abs(d))} %`}
      </span>
    </div>
  );
}

export function Dashboard({ onNav, can = () => true }: { onNav: Nav; can?: (k: string) => boolean }) {
  const [period, setPeriod] = useState<PeriodKey>('week');
  const [scope, setScope] = useState<Scope>('all');
  const ozon = useLiveOzon(period);
  const wb = useLiveWb(period);
  const fin = useFinanceSummary(period);
  const rnp = useRnpSummary(period);
  const att = useAttention();

  const showOz = scope !== 'wb';
  const showWb = scope !== 'ozon';
  const wbOk = !wb.loading && !wb.error;
  const ozOk = !ozon.loading && !ozon.error;
  const revenue = (showOz ? ozon.revenue : 0) + (showWb ? wb.revenue : 0);
  const orders = (showOz ? ozon.orders : 0) + (showWb ? wb.orders : 0);
  const prevRevenue = (showOz ? ozon.prevRevenue : 0) + (showWb ? wb.prevRevenue : 0);
  const prevOrders = (showOz ? ozon.prevOrders : 0) + (showWb ? wb.prevOrders : 0);
  const avg = orders > 0 ? Math.round(revenue / orders) : 0;
  const anyLoading = ozon.loading || wb.loading;
  const range = periodRange(period);
  const prevRange = prevPeriodRange(period);

  // Ряды по дням из РНП: площадки выбранного охвата, сумма по дням.
  const daily = useMemo(() => {
    const base = rnp.wb ?? rnp.ozon;
    if (!base) return null;
    const pick = (s: RnpSummary | null, key: 'amount' | 'cnt' | 'ads' | 'prevAmount', i: number) => s?.[key]?.[i] ?? null;
    const sum = (key: 'amount' | 'cnt' | 'ads' | 'prevAmount', i: number) => {
      const a = showWb ? pick(rnp.wb, key, i) : null, b = showOz ? pick(rnp.ozon, key, i) : null;
      // Прошлый период: день без одной из площадок не рисуем, иначе линия «проваливается» на её долю.
      if (key === 'prevAmount' && ((showWb && a === null) || (showOz && b === null))) return null;
      return a === null && b === null ? null : (a ?? 0) + (b ?? 0);
    };
    const today = base.dates[base.dates.length - 1];
    const rows: (DayRow & { today?: boolean })[] = base.dates.map((date, i) => ({
      date, label: fmtDay(date), today: date === today,
      wb: showWb ? pick(rnp.wb, 'amount', i) : null, oz: showOz ? pick(rnp.ozon, 'amount', i) : null, prev: sum('prevAmount', i),
    }));
    const amount: Point[] = base.dates.map((d, i) => ({ label: fmtDay(d), value: sum('amount', i) }));
    const cnt: Point[] = base.dates.map((d, i) => ({ label: fmtDay(d), value: sum('cnt', i) }));
    const drr: Point[] = base.dates.map((d, i) => {
      const a = sum('ads', i), r = sum('amount', i);
      return { label: fmtDay(d), value: a !== null && r ? Math.round(a / r * 1000) / 10 : null };
    });
    const closed = rows.slice(0, -1).map(r => (r.wb ?? 0) + (r.oz ?? 0)).filter(v => v > 0);
    const best = rows.slice(0, -1).reduce<DayRow | null>((b, r) => ((r.wb ?? 0) + (r.oz ?? 0)) > (b ? (b.wb ?? 0) + (b.oz ?? 0) : 0) ? r : b, null);
    // История РНП короче окна (WB собирается с конца сентября) — сравнивать с дырявым прошлым нельзя.
    const prevComplete = (['wb', 'ozon'] as const).every(mp => (mp === 'wb' ? !showWb : !showOz) || (rnp[mp]?.prevAmount.every(v => v !== null) ?? false));
    return {
      rows, amount, cnt, drr, best, prevComplete,
      avgDay: closed.length ? closed.reduce((s, v) => s + v, 0) / closed.length : null,
      // Сравниваем закрытые дни: неполное «сегодня» против полного дня прошлого окна занижало итог.
      closedDays: rows.length - 1,
      sumCur: rows.slice(0, -1).reduce((s, r) => s + (r.wb ?? 0) + (r.oz ?? 0), 0),
      sumPrev: rows.slice(0, -1).reduce((s, r) => s + (r.prev ?? 0), 0),
    };
  }, [rnp, showWb, showOz]);

  // Деньги: при «Все площадки» — с себестоимостью, по одной площадке — до неё.
  const s = fin.summary;
  const money = useMemo(() => {
    if (!s) return null;
    const m = scope === 'all' ? null : scope === 'wb' ? s.wb : s.ozon;
    const net = m ? m.netRevenue : s.totalNetRevenue;
    if (!(net > 0)) return null;
    const cogsOk = scope === 'all' && s.totalCogs > 0 && s.skusWithoutCost.length === 0;
    const parts: Slice[] = [
      ...(cogsOk ? [{ label: 'Себестоимость', value: s.totalCogs, color: 'var(--db-c5)' }] : []),
      { label: 'Комиссия площадок', value: m ? m.commission : s.totalCommission, color: 'var(--db-c1)' },
      { label: 'Логистика и эквайринг', value: m ? m.logistics : s.totalLogistics, color: 'var(--db-c3)' },
      { label: 'Реклама', value: m ? m.ads : s.totalAds, color: 'var(--db-c2)' },
      { label: 'Хранение', value: m ? m.storage : s.totalStorage, color: 'var(--db-c4)' },
      { label: 'Прочее и штрафы', value: Math.max(0, m ? m.other : s.totalOther), color: 'var(--db-c6)' },
    ];
    const spent = parts.reduce((a, p) => a + p.value, 0);
    const left = net - spent;
    parts.push({ label: cogsOk ? 'Остаётся вам' : 'Остаётся до себестоимости', value: Math.max(0, left), color: 'var(--db-good)' });
    const adsKnown = m ? m.adsKnown : s.wb.adsKnown && s.ozon.adsKnown;
    const ads = m ? m.ads : s.totalAds;
    return { net, parts, left, cogsOk, adsKnown, drr: adsKnown ? ads / net * 100 : null, ads, missing: s.skusWithoutCost.length };
  }, [s, scope]);

  // «Требует внимания»: сигналы Советника по важности и деньгам, плюс отзывы и чаты.
  const attention = useMemo(() => {
    const items: { key: string; level: 'critical' | 'warn' | 'info' | 'good'; title: string; text: string; to: string; label: string }[] = [];
    const sig = (att.signals ?? [])
      .filter(x => (scope === 'all' || x.mp === scope) && x.level !== 'info')
      .sort((a, b) => LEVEL_RANK[a.level] - LEVEL_RANK[b.level] || (b.rub ?? 0) - (a.rub ?? 0));
    for (const x of sig.slice(0, 4)) {
      const to = ROLE_PAGE[x.role] ?? 'rnp';
      items.push({
        key: `s${x.id}`, level: x.level, to, label: to === 'ads' ? 'Реклама' : to === 'prices' ? 'Цены' : 'Советник',
        title: `${x.title}${x.name ? ` · ${x.name}` : ''}`,
        text: [x.mp === 'wb' ? 'WB' : 'Ozon', x.rub ? `на кону ${fmtRub(x.rub)}` : '', x.days > 1 ? `${x.days} дн. подряд` : '', x.action].filter(Boolean).join(' · '),
      });
    }
    if (!att.signals) {
      // Советник недоступен — хотя бы закончившиеся товары из РНП.
      for (const [mp, sum] of [['wb', rnp.wb], ['ozon', rnp.ozon]] as const) {
        if (scope !== 'all' && scope !== mp) continue;
        for (const p of (sum?.outOfStock ?? []).slice(0, 2)) items.push({
          key: `o${mp}${p.sku}`, level: 'critical', to: 'rnp', label: 'РНП',
          title: `Закончился: ${p.name || p.article}`, text: `${mp === 'wb' ? 'WB' : 'Ozon'} · продавался ${p.perDay} шт в день`,
        });
      }
    }
    if (att.reviews) items.push({ key: 'rv', level: 'info', to: 'reviews', label: 'Отзывы', title: `${att.reviews} отзывов и вопросов без ответа`, text: 'черновики ответов готовит ИИ' });
    if (att.chats) items.push({ key: 'ch', level: 'info', to: 'chats', label: 'Чаты', title: `${att.chats} чатов ждут ответа`, text: 'покупатели WB и Ozon' });
    return items.filter(i => can(i.to));
  }, [att, rnp, scope, can]);

  const movers = useMemo(() => {
    const all = (k: 'up' | 'down') => (['wb', 'ozon'] as const)
      .filter(mp => scope === 'all' || scope === mp)
      .flatMap(mp => (rnp[mp]?.movers[k] ?? []).map(p => ({ p, mp })))
      .sort((a, b) => k === 'up' ? (b.p.cur - b.p.prev) - (a.p.cur - a.p.prev) : (a.p.cur - a.p.prev) - (b.p.cur - b.p.prev))
      .slice(0, 5);
    const mv = (rnp.wb ?? rnp.ozon)?.movers;
    return { up: all('up'), down: all('down'), range: mv ? fmtRange(mv.from, mv.to) : '' };
  }, [rnp, scope]);

  const outCount = (['wb', 'ozon'] as const).filter(mp => scope === 'all' || scope === mp).reduce((n, mp) => n + (rnp[mp]?.outOfStock.length ?? 0), 0);
  const openSignals = att.signals?.filter(x => scope === 'all' || x.mp === scope).length ?? null;
  const total = wb.revenue + ozon.revenue;

  const tiles = (
    <div className="db-tiles">
      <div className="db-card db-tile">
        <div className="db-tile-t">Сумма заказов {anyLoading && <SpinnerIcon size={13} className="spin" />}</div>
        <div className="db-tile-v">{fmtRub(revenue)}</div>
        <Delta cur={revenue} prev={prevRevenue} suffix={PREV_LABEL[period]} />
        <MiniArea points={daily?.amount ?? []} color="var(--db-acc)" name="Заказано" format={fmtRub} />
      </div>
      <div className="db-card db-tile">
        <div className="db-tile-t">Заказы</div>
        <div className="db-tile-v">{orders.toLocaleString('ru-RU')} шт</div>
        <span className="db-d">
          {prevOrders > 0 && <><Delta cur={orders} prev={prevOrders} suffix="" /> · </>}средний чек {fmtRub(avg)}
        </span>
        <MiniArea points={daily?.cnt ?? []} color="var(--db-c2)" name="Заказов" format={v => `${Math.round(v)} шт`} />
      </div>
      <div className="db-card db-tile">
        {money?.cogsOk ? (<>
          <div className="db-tile-t">Прибыль</div>
          <div className={`db-tile-v ${money.left < 0 ? 'db-bad' : ''}`}>{fmtRub(money.left)}</div>
          <span className="db-d">{pct1(money.left / money.net * 100)} от выручки нетто</span>
          <ProgressBar pct={money.left / money.net * 100} color="var(--db-good)"
            left={<>прибыль {fmtShort(money.left)} ₽</>} right={<>выручка {fmtShort(money.net)} ₽</>} />
        </>) : (<>
          <div className="db-tile-t">Выручка нетто</div>
          <div className="db-tile-v">{money ? fmtRub(money.net) : fin.loading ? '…' : '—'}</div>
          <span className="db-d">
            {!money ? (fin.loading ? 'тянем отчёты площадок…' : 'финотчёт пока не пришёл')
              : scope !== 'all' ? 'прибыль считаем по обеим площадкам'
              : money.missing ? `прибыль не считаем: нет себестоимости у ${money.missing} товаров` : 'после возвратов'}
          </span>
          {money && <ProgressBar pct={money.left / money.net * 100} color="var(--db-good)"
            left={<>до себестоимости {fmtShort(money.left)} ₽</>} right={<>{Math.round(money.left / money.net * 100)} %</>} />}
        </>)}
      </div>
      <div className="db-card db-tile">
        <div className="db-tile-t">ДРР</div>
        <div className="db-tile-v" style={{ color: money?.drr == null ? undefined : money.drr < 10 ? 'var(--db-good)' : money.drr < 20 ? 'var(--db-warn)' : 'var(--db-bad)' }}>
          {money?.drr != null ? pct1(money.drr) : '—'}
        </div>
        <span className="db-d">
          {money?.drr != null ? `реклама ${fmtRub(money.ads)} · по финотчёту` : money && !money.adsKnown ? 'расход на рекламу не получен' : 'ждём финотчёт'}
        </span>
        <MiniBars points={daily?.drr ?? []} color="var(--db-c2)" name="ДРР по заказам" format={v => pct1(v)} />
      </div>
    </div>
  );

  return (
    <div className="db">
      <header className="db-head">
        <div>
          <div className="db-range">{PERIOD_LABEL[period]} · {fmtRange(range.from, range.to)}</div>
          <div className="db-sub">
            сравнение с {fmtRange(prevRange.from, prevRange.to)}
            {' · сегодня ещё не закрыт'}
            {showWb && wb.sticky && <span className="db-warn-t"> · WB: данные от {fmtClock(wb.shownAt)}</span>}
            {showWb && wb.staleFrom && <span className="db-warn-t"> · WB: снимок на {wb.staleFrom}</span>}
          </div>
        </div>
        <div className="db-ctrls">
          <div className="db-seg" role="tablist" aria-label="Площадка">
            {([['all', 'Все площадки'], ['wb', 'Wildberries'], ['ozon', 'Ozon']] as [Scope, string][]).map(([k, l]) => (
              <button key={k} type="button" className={scope === k ? 'on' : ''} onClick={() => setScope(k)}>
                {k !== 'all' && <i className={`db-dot ${k}`} />}{l}
              </button>
            ))}
          </div>
          <div className="db-seg" role="tablist" aria-label="Период">
            {(['day', 'week', 'month'] as PeriodKey[]).map(p => (
              <button key={p} type="button" className={period === p ? 'on' : ''} onClick={() => setPeriod(p)}>{PERIOD_LABEL[p]}</button>
            ))}
          </div>
          <LastUpdated compact namespaces={['ozon-seller', 'wb:analytics', 'wb:statistics']} label="Сводка (выручка, заказы)"
            onRefresh={async () => { await Promise.all([refreshLiveWb(period), Promise.resolve(fin.refresh())]); }} />
        </div>
      </header>

      {tiles}

      <div className="db-row db-row-main">
        <Card title="Заказы по дням, ₽" extra={
          <div className="db-legend">
            {showWb && <span><i className="db-mark" style={{ background: 'var(--db-wb)' }} />Wildberries</span>}
            {showOz && <span><i className="db-mark" style={{ background: 'var(--db-oz)' }} />Ozon</span>}
            <span><i className="db-mark db-mark-dash" />прошлый период</span>
          </div>}>
          {daily ? (<>
            <OrdersChart rows={daily.rows} showWb={showWb} showOz={showOz} prevName={period === 'day' ? 'Две недели назад' : 'Прошлый период'} />
            <div className="db-metrics">
              <div><span>За {daily.closedDays} дн. без сегодня</span><b>{fmtShort(daily.sumCur)} ₽</b>
                {!daily.prevComplete && <em>прошлый период собран не целиком</em>}
                {daily.prevComplete && daily.sumPrev > 0 && <em className={daily.sumCur >= daily.sumPrev ? 'db-good' : 'db-bad'}>{daily.sumCur >= daily.sumPrev ? '+' : '−'}{pct1(Math.abs((daily.sumCur - daily.sumPrev) / daily.sumPrev * 100))}</em>}</div>
              <div><span>В среднем за день</span><b>{daily.avgDay ? `${fmtShort(daily.avgDay)} ₽` : '—'}</b><em>без сегодняшнего</em></div>
              <div><span>Лучший день</span><b>{daily.best ? fmtDay(daily.best.date) : '—'}</b><em>{daily.best ? `${fmtShort((daily.best.wb ?? 0) + (daily.best.oz ?? 0))} ₽` : ''}</em></div>
              <div><span>Доля WB</span><b>{total > 0 ? `${Math.round(wb.revenue / total * 100)} %` : '—'}</b><em>Ozon {total > 0 ? `${100 - Math.round(wb.revenue / total * 100)} %` : '—'}</em></div>
            </div>
            <div className="db-note">По данным РНП: WB — цена со скидкой продавца, без СПП, поэтому сумма может немного отличаться от плитки сверху.</div>
          </>) : <div className="db-empty">График появится, когда РНП соберёт данные по дням.</div>}
        </Card>

        <Card title="Требует внимания" extra={attention.length ? <span className="db-chip">{attention.length}</span> : undefined}>
          {attention.length ? (
            <ul className="db-att">
              {attention.map(i => (
                <li key={i.key} title={`${i.title}\n${i.text}`}>
                  <i className={`db-att-bar ${i.level}`} />
                  <div><b>{i.title}</b><span>{i.text}</span></div>
                  <GoBtn to={i.to} onNav={onNav}>{i.label}</GoBtn>
                </li>
              ))}
            </ul>
          ) : (
            <div className="db-empty">{att.signals === null && att.reviews === null ? 'Загружаем сигналы…' : 'Срочного ничего нет.'}</div>
          )}
        </Card>
      </div>

      <DailyAiInsights
        period={`${PERIOD_LABEL[period]} (${fmtRange(range.from, range.to)})`}
        ready={!anyLoading}
        kpis={{ totalRevenue: revenue, totalOrders: orders, totalAvgCheck: avg, prevRevenue, prevOrders }}
        marketplaces={{
          ...(showOz && !ozon.error ? { ozon: { revenue: ozon.revenue, orders: ozon.orders, products: ozon.totalProducts } } : {}),
          ...(showWb && !wb.error ? { wb: { revenue: wb.revenue, orders: wb.orders, products: wb.totalProducts } } : {}),
        }}
        errors={{
          ...(showOz && ozon.error ? { ozon: String(ozon.error).slice(0, 200) } : {}),
          ...(showWb && wb.error ? { wb: String(wb.error).slice(0, 200) } : {}),
        }}
      />

      <div className="db-row db-row-2">
        <Card title="Из каждых 100 ₽ выручки" extra={money ? <span className="db-sub">выручка нетто {fmtRub(money.net)}</span> : undefined}>
          {money ? (<>
            <StripeBar slices={money.parts} />
            <div className="db-mleg">
              {money.parts.map(p => (
                <div key={p.label} className={p.color === 'var(--db-good)' ? 'db-mleg-profit' : ''}>
                  <i className="db-mark" style={{ background: p.color }} />
                  <span>{p.label}</span>
                  <b>{Math.round(p.value / money.net * 100)} ₽</b>
                  <em>{fmtRub(p.value)}</em>
                </div>
              ))}
            </div>
            {!money.cogsOk && <div className="db-note">
              {scope !== 'all' ? 'Себестоимость считается по обеим площадкам вместе — выберите «Все площадки».'
                : money.missing ? `Себестоимость не учтена: её нет у ${money.missing} проданных товаров. Заполните её в таблице «Склад».`
                : 'Себестоимость не учтена.'}
            </div>}
            {period === 'day' && <div className="db-note">WB сдаёт финансовый отчёт раз в неделю, поэтому за сегодня его расходы — из последнего закрытого отчёта.</div>}
            {fin.warnings.filter(w => !/Себестоимости нет/.test(w)).slice(0, 2).map(w => <div key={w} className="db-note db-warn-t"><WarningIcon size={13} weight="bold" /> {w}</div>)}
          </>) : <div className="db-empty">{fin.loading ? 'Тянем финансовые отчёты Ozon и WB…' : fin.error ? `Финотчёт не получен: ${fin.error}` : 'За период выручки нет.'}</div>}
        </Card>

        <Card title="Площадки" extra={<span className="db-sub">сумма заказов</span>}>
          <div className="db-plats">
            <Donut
              slices={[{ label: 'Wildberries', value: wb.revenue, color: 'var(--db-wb)' }, { label: 'Ozon', value: ozon.revenue, color: 'var(--db-oz)' }]}
              center={total > 0 ? fmtShort(total) : '—'} sub="₽ заказов" />
            <div className="db-plat-list">
              {([['wb', 'Wildberries', wb, wbOk, s?.wb], ['ozon', 'Ozon', ozon, ozOk, s?.ozon]] as const).map(([k, l, st, ok, f]) => (
                <div key={k} className="db-plat">
                  <div className="db-plat-h">
                    <span><i className={`db-dot ${k}`} />{l}</span>
                    <span className={`db-status ${ok ? 'ok' : st.loading ? '' : 'bad'}`} title={st.error ? String(st.error) : undefined}>
                      {ok ? 'на связи' : st.loading ? 'загрузка…' : 'нет связи'}
                    </span>
                  </div>
                  <div className="db-plat-g">
                    <div><span>Заказы</span><b>{ok ? fmtShort(st.revenue) + ' ₽' : '—'}</b></div>
                    <div><span>Штук</span><b>{ok ? st.orders.toLocaleString('ru-RU') : '—'}</b></div>
                    <div><span>Ср. чек</span><b>{ok ? fmtRub(st.avgCheck) : '—'}</b></div>
                    <div><span>ДРР</span><b>{f && f.adsKnown && f.netRevenue > 0 ? pct1(f.ads / f.netRevenue * 100) : '—'}</b></div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </Card>
      </div>

      <div className="db-row db-row-2">
        <Card title="Растут" extra={<span className="db-sub">заказы за {movers.range || 'период'}</span>}>
          {movers.up.length ? movers.up.map(({ p, mp }) => <ProductRow key={mp + p.sku} p={p} mp={mp} />)
            : <div className="db-empty">{rnp.wb || rnp.ozon ? 'Заметного роста нет.' : 'Нет данных РНП.'}</div>}
          {can('rnp') && <div className="db-card-f"><GoBtn to="rnp" onNav={onNav}>Все товары в РНП</GoBtn></div>}
        </Card>
        <Card title="Падают" extra={<span className="db-sub">против такого же окна до этого</span>}>
          {movers.down.length ? movers.down.map(({ p, mp }) => <ProductRow key={mp + p.sku} p={p} mp={mp} />)
            : <div className="db-empty">{rnp.wb || rnp.ozon ? 'Заметного падения нет.' : 'Нет данных РНП.'}</div>}
          {can('rnp') && <div className="db-card-f"><GoBtn to="rnp" onNav={onNav}>Причины в Советнике</GoBtn></div>}
        </Card>
      </div>

      <div className="db-quick">
        {([
          ['reviews', att.reviews, 'отзывов и вопросов без ответа', 'Отзывы'],
          ['chats', att.chats, 'чатов ждут ответа', 'Чаты'],
          ['rnp', openSignals, 'открытых сигналов Советника', 'РНП'],
          ['rnp', outCount || null, 'товаров закончились, а их покупали', 'Остатки'],
          ['prices', null, 'цены, маржа и ROI по каждому товару', 'Цены'],
          ['ads', null, 'кампании, автопилот и ДРР', 'Реклама'],
        ] as [string, number | null, string, string][]).filter(([to]) => can(to)).map(([to, n, text, label]) => (
          <button key={label} type="button" className="db-card db-q" onClick={() => onNav(to)}>
            <span className="db-q-l">{label} <ArrowUpRightIcon size={14} weight="bold" /></span>
            {n !== null && <b>{n.toLocaleString('ru-RU')}</b>}
            <span className="db-q-t">{text}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
