import { useState } from 'react';
import { TrendUpIcon, TrendDownIcon, SpinnerIcon } from '@phosphor-icons/react';
import { marketplaces, Marketplace } from '../mock';
import { Sparkline } from '../components/Sparkline';
import { DailyAiInsights } from '../components/DailyAiInsights';
import { LastUpdated } from '../components/LastUpdated';
import { FinanceSummary } from '../components/FinanceSummary';
import { useLiveOzon, PeriodKey, PERIOD_LABEL } from '../api/useLiveOzon';
import { useLiveWb, refreshLiveWb } from '../api/useLiveWb';
import { fmtClock } from '../api/sideResource';

const fmt = (n: number) => n.toLocaleString('ru-RU') + ' ₽';
const delta = (cur: number, prev: number) => {
  if (!prev) return null;
  const pct = ((cur - prev) / prev) * 100;
  const up = pct >= 0;
  const Ico = up ? TrendUpIcon : TrendDownIcon;
  return (
    <span className={up ? 'delta-up' : 'delta-down'} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <Ico size={13} weight="bold" /> {Math.abs(pct).toFixed(1)}%
    </span>
  );
};

type Scope = Marketplace | 'all';

function periodLabelSuffix(p: PeriodKey) {
  return p === 'day' ? 'сегодня' : p === 'week' ? 'за 7 дней' : 'за 30 дней';
}
function prevLabel(p: PeriodKey) {
  return p === 'day' ? 'предыдущему дню' : p === 'week' ? 'предыдущей неделе' : 'предыдущему месяцу';
}
// Понятная подпись «данные за DD.MM–DD.MM» — клиент не понимал, с какого дня считается.
function fmtD(d: Date) { return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' }); }
function periodRange(p: PeriodKey): string {
  const to = new Date();
  const days = p === 'day' ? 0 : p === 'week' ? 6 : 29;
  const from = new Date(); from.setDate(from.getDate() - days);
  return p === 'day' ? fmtD(to) : `${fmtD(from)} – ${fmtD(to)}`;
}

export function Dashboard({ onNav }: { onNav: (k: string) => void }) {
  const [period, setPeriod] = useState<PeriodKey>('day');
  const [scope, setScope] = useState<Scope>('all');
  const ozon = useLiveOzon(period);
  const wb = useLiveWb(period);

  const ozonConnected = !ozon.loading && !ozon.error;
  const wbConnected = !wb.loading && !wb.error;

  const showOzon = scope === 'all' || scope === 'ozon';
  const showWb = scope === 'all' || scope === 'wb';
  const totalRevenue = (showOzon ? ozon.revenue : 0) + (showWb ? wb.revenue : 0);
  const totalOrders = (showOzon ? ozon.orders : 0) + (showWb ? wb.orders : 0);
  const totalAvg = totalOrders > 0 ? Math.round(totalRevenue / totalOrders) : 0;
  const prevRevenue = (showOzon ? ozon.prevRevenue : 0) + (showWb ? wb.prevRevenue : 0);
  const prevOrders = (showOzon ? ozon.prevOrders : 0) + (showWb ? wb.prevOrders : 0);
  const totalSpark = showOzon ? ozon.daily : [];
  const anyLoading = ozon.loading || wb.loading;

  return (
    <div className="grid" style={{ gap: 20 }}>
      <div className="flex-between" style={{ flexWrap: 'wrap', gap: 12 }}>
        <div className="row gap-8" style={{ flexWrap: 'wrap' }}>
          <button className={`mp-tab ${scope === 'all' ? 'active' : ''}`} onClick={() => setScope('all')}>
            <span className="mp-tab-dot" style={{ background: 'linear-gradient(135deg, #cb11ab, #005bff)' }} />
            Все площадки
            <span className="muted" style={{ marginLeft: 6 }}>{marketplaces.length}</span>
          </button>
          <button className={`mp-tab ${scope === 'wb' ? 'active' : ''}`} onClick={() => setScope('wb')}>
            <span className="mp-tab-dot" style={{ background: '#cb11ab' }} />
            Wildberries
            <span className="muted" style={{ marginLeft: 6 }}>
              {wbConnected
                ? wb.staleFrom ? `${wb.totalProducts} SKU · на ${wb.staleFrom}`
                  // sticky — на экране прошлые цифры: свежий ответ был пустой/с ошибкой.
                  // Говорим момент, на который они верны, вместо бодрого «live».
                  : wb.sticky ? `${wb.totalProducts} SKU · данные от ${fmtClock(wb.shownAt)}`
                  : `${wb.totalProducts} SKU · live`
                : wb.loading ? 'загрузка…' : 'ошибка'}
            </span>
          </button>
          <button className={`mp-tab ${scope === 'ozon' ? 'active' : ''}`} onClick={() => setScope('ozon')}>
            <span className="mp-tab-dot" style={{ background: '#005bff' }} />
            Ozon
            <span className="muted" style={{ marginLeft: 6 }}>
              {ozonConnected ? `${ozon.totalProducts} SKU · live` : ozon.loading ? 'загрузка…' : 'ошибка'}
            </span>
          </button>
        </div>

        <div className="period-switch">
          {(['day', 'week', 'month'] as PeriodKey[]).map((p) => (
            <button
              key={p}
              className={`period-btn ${period === p ? 'active' : ''}`}
              onClick={() => setPeriod(p)}
            >
              {PERIOD_LABEL[p]}
            </button>
          ))}
        </div>
      </div>

      <div className="row gap-12" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
        {/* Кнопка обновления была не подключена: refreshLiveWb существовал, но его
            никто не звал, и «обновить» лишь перечитывало статус. Теперь она реально
            идёт в WB по текущему периоду (сервер пускает не чаще раза в 5 мин на
            датасет) — это просьба клиента сверять сегодняшнюю цифру с кабинетом. */}
        <LastUpdated
          namespaces={['ozon-seller', 'wb:analytics', 'wb:statistics']}
          label="Дашборд (выручка, заказы, KPI)"
          onRefresh={async () => { await refreshLiveWb(period); }}
        />
        {/* Обе площадки теперь считают ОДНО окно, заканчивающееся сегодня. Сегодня
            неполный — говорим об этом прямо, иначе цифра ниже кабинета выглядит
            как ошибка платформы, а не как свойство ещё не закрытых суток. */}
        <span className="chip info" style={{ fontSize: 12 }} title="WB и Ozon считаются за одно и то же окно, включая сегодняшний день. Сегодня ещё не закрыт: площадки досчитывают его в течение суток, поэтому к вечеру цифра вырастет.">
          данные за {periodRange(period)} · WB и Ozon · сегодня неполный день
        </span>
      </div>

      <DailyAiInsights
        period={`${PERIOD_LABEL[period]} (${periodRange(period)})`}
        ready={!anyLoading}
        kpis={{
          totalRevenue,
          totalOrders,
          totalAvgCheck: totalAvg,
          prevRevenue,
          prevOrders,
        }}
        marketplaces={{
          ...(showOzon && !ozon.error ? { ozon: { revenue: ozon.revenue, orders: ozon.orders, products: ozon.totalProducts } } : {}),
          ...(showWb && !wb.error ? { wb: { revenue: wb.revenue, orders: wb.orders, products: wb.totalProducts } } : {}),
        }}
        errors={{
          ...(showOzon && ozon.error ? { ozon: String(ozon.error).slice(0, 200) } : {}),
          ...(showWb && wb.error ? { wb: String(wb.error).slice(0, 200) } : {}),
        }}
      />

      {/* Финсводка — общий P&L обеих площадок. Показываем ТОЛЬКО на «Все площадки»:
          под тумблером WB/Ozon по отдельности она путала (клиент думал, что это по
          одной площадке, а там сумма обеих). */}
      {scope === 'all' && <FinanceSummary />}

      <div className="grid grid-3">
        <div className="card kpi">
          <div className="card-title">
            Выручка по заказам · {periodLabelSuffix(period)}
            {anyLoading && <SpinnerIcon size={12} weight="bold" className="spin" style={{ marginLeft: 6, verticalAlign: -2 }} />}
          </div>
          <div className="v">{fmt(totalRevenue)}</div>
          <div className="d">
            {delta(totalRevenue, prevRevenue)} к {prevLabel(period)}
            {scope === 'all' && <span className="muted" style={{ marginLeft: 6 }}>· WB + Ozon</span>}
          </div>
          <div className="d muted" style={{ fontSize: 11 }}>
            сумма заказов · выкуп и прибыль — в финсводке выше
            {showWb && wb.sticky && (
              <span style={{ color: 'var(--warn)' }} title="Свежий ответ WB пришёл пустым или с ошибкой. Чтобы цифра не «пропала», показываем прошлую — и честно указываем, на какой момент она верна. Нажмите «Обновить», чтобы попробовать снова.">
                {' '}· WB: данные от {fmtClock(wb.shownAt)}
              </span>
            )}
          </div>
        </div>
        <div className="card kpi">
          <div className="card-title">Заказов · {periodLabelSuffix(period)}</div>
          <div className="v">{totalOrders}</div>
          <div className="d">{delta(totalOrders, prevOrders)} к {prevLabel(period)}</div>
        </div>
        <div className="card kpi">
          <div className="card-title">Средний чек</div>
          <div className="v">{fmt(totalAvg)}</div>
          <div className="d muted">{scope === 'wb' ? 'WB Analytics' : scope === 'ozon' ? 'Ozon Analytics' : 'WB + Ozon'}</div>
        </div>
      </div>

      {scope === 'all' && (
        <div className="card">
          <div className="flex-between" style={{ marginBottom: 14 }}>
            <h2>Разбивка по площадкам</h2>
            <span className="chip info">{PERIOD_LABEL[period]} ({periodRange(period)})</span>
          </div>
          <table>
            <thead>
              <tr>
                <th>Площадка</th>
                <th>Статус</th>
                <th className="right">SKU</th>
                <th className="right">Сумма заказов</th>
                <th className="right">Заказы</th>
                <th className="right">Средний чек</th>
                <th>Тренд</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>
                  <div className="row" style={{ gap: 8 }}>
                    <span className="mp-tab-dot" style={{ background: '#cb11ab' }} />
                    <b>Wildberries</b>
                  </div>
                </td>
                <td>
                  {wbConnected
                    ? <span className="chip good"><span className="dot" /> live API</span>
                    : <span className="chip warn"><span className="dot" /> {wb.loading ? 'загрузка' : 'ошибка'}</span>}
                </td>
                <td className="right">{wbConnected ? wb.totalProducts : '—'}</td>
                <td className="right"><b>{wbConnected ? fmt(wb.revenue) : '—'}</b></td>
                <td className="right">{wbConnected ? wb.orders : '—'}</td>
                <td className="right">{wbConnected ? fmt(wb.avgCheck) : '—'}</td>
                <td><span className="muted">{wbConnected ? 'sales-funnel v3' : '—'}</span></td>
              </tr>
              <tr>
                <td>
                  <div className="row" style={{ gap: 8 }}>
                    <span className="mp-tab-dot" style={{ background: '#005bff' }} />
                    <b>Ozon</b>
                  </div>
                </td>
                <td>
                  {ozonConnected
                    ? <span className="chip good"><span className="dot" /> live API</span>
                    : <span className="chip warn"><span className="dot" /> {ozon.loading ? 'загрузка' : 'ошибка'}</span>}
                </td>
                <td className="right">{ozonConnected ? ozon.totalProducts : '—'}</td>
                <td className="right"><b>{ozonConnected ? fmt(ozon.revenue) : '—'}</b></td>
                <td className="right">{ozonConnected ? ozon.orders : '—'}</td>
                <td className="right">{ozonConnected ? fmt(ozon.avgCheck) : '—'}</td>
                <td>
                  {ozonConnected && ozon.daily.length > 0
                    ? <Sparkline data={ozon.daily} width={140} height={32} color="#005bff" />
                    : <span className="muted">—</span>}
                </td>
              </tr>
            </tbody>
          </table>
          {ozon.error && (
            <div className="muted" style={{ fontSize: 12, marginTop: 10 }}>
              Ozon API ошибка: {ozon.error}
            </div>
          )}
        </div>
      )}

      <div className="grid grid-3">
        <div className="card">
          <div className="flex-between">
            <h2>Цены</h2>
            <span className="chip info"><span className="dot" /> WB + Ozon</span>
          </div>
          <div className="muted" style={{ marginTop: 6, fontSize: 13 }}>Цены, скидки, маржа и ROI по каждому SKU.</div>
          <div style={{ marginTop: 12 }}>
            <button className="btn btn-sm" onClick={() => onNav('prices')}>Открыть модуль →</button>
          </div>
        </div>

        <div className="card">
          <div className="flex-between">
            <h2>Отзывы</h2>
            <span className="chip info"><span className="dot" /> WB Feedbacks</span>
          </div>
          <div className="muted" style={{ marginTop: 6, fontSize: 13 }}>Неотвеченные отзывы WB + черновики ответов от Claude.</div>
          <div style={{ marginTop: 12 }}>
            <button className="btn btn-sm" onClick={() => onNav('reviews')}>Открыть очередь →</button>
          </div>
        </div>

        <div className="card">
          <div className="flex-between">
            <h2>Аналитика</h2>
            <span className="chip info">{PERIOD_LABEL[period]} ({periodRange(period)})</span>
          </div>
          <div style={{ marginTop: 4 }}>
            {totalSpark.length > 0
              ? <Sparkline data={totalSpark} width={240} height={56} color="#005bff" />
              : <span className="muted">—</span>}
          </div>
          <div style={{ marginTop: 6 }}>
            <button className="btn btn-sm" onClick={() => onNav('analytics')}>Полный отчёт →</button>
          </div>
        </div>
      </div>
    </div>
  );
}
