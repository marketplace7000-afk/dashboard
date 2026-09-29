import { useEffect, useState } from 'react';
import { SpinnerIcon, TrendUpIcon, TrendDownIcon } from '@phosphor-icons/react';
import { wbNmReportAll, wbSupplierOrders, type WbNmReportCard } from '../api/marketplaces';
import { useLiveWb } from '../api/useLiveWb';
import { PeriodKey, PERIOD_LABEL, PERIOD_DAYS, fmtRangeRu } from '../api/useLiveOzon';
import { DailyBarsChart } from './DailyBarsChart';
import { mskDateOf } from '../utils/mskDate';
import { wbImageUrl } from '../utils/wbBasket';

type DailyPoint = { date: string; revenue: number; orders: number };

// Ряд выручки по дням (последний N дней, заканчивая maxDt из отчёта). Пропущенные
// дни заполняем нулём, порядок хронологический — как ждёт DailyBarsChart.
function buildDailyData(series: DailyPoint[], maxDt: string | null, days: number): number[] {
  if (!maxDt) return [];
  const map = new Map(series.map((s) => [s.date, s.revenue]));
  const end = new Date(maxDt + 'T00:00:00Z');
  const out: number[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(end.getTime() - i * 86_400_000);
    out.push(map.get(d.toISOString().slice(0, 10)) ?? 0);
  }
  return out;
}

const fmt = (n: number) => n.toLocaleString('ru-RU') + ' ₽';

function delta(cur: number, prev: number) {
  if (!prev) return <span className="muted">—</span>;
  const pct = ((cur - prev) / prev) * 100;
  const up = pct >= 0;
  const Ico = up ? TrendUpIcon : TrendDownIcon;
  return (
    <span className={up ? 'delta-up' : 'delta-down'} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <Ico size={13} weight="bold" /> {Math.abs(pct).toFixed(1)}%
    </span>
  );
}

// По МОСКВЕ (см. utils/mskDate). NB: цикл построения ряда выше намеренно шагает
// по UTC-полуночи от maxDt — там дата уже строка, сдвигать её не нужно.
function isoDate(d: Date) {
  return mskDateOf(d);
}

// Фото товара WB с basket-CDN по nmID — формула общая (utils/wbBasket).
// Здесь она была скопирована с потолком 26: все карточки выше vol 4565 уходили
// в basket-26, и фото не грузились.
const wbImg = (nm: number) => wbImageUrl(nm, 1, 'c246x328');

type TopSkuRow = {
  nmID: number;
  vendorCode: string;
  brandName: string;
  objectName: string;
  revenue: number;
  orders: number;
};

export function LiveWbAnalytics({ period }: { period: PeriodKey }) {
  const wb = useLiveWb(period);
  const [top, setTop] = useState<{ data: TopSkuRow[]; loading: boolean; error?: string }>({ data: [], loading: true });
  const [daily, setDaily] = useState<{ series: DailyPoint[]; maxDt: string | null }>({ series: [], maxDt: null });

  // Дневной ряд для графика «Заказано по дням» — из ЖИВОГО потока заказов WB
  // (supplier/orders, по датам). Синхронная воронка даёт только итоги за период
  // без разбивки по дням, поэтому график строим из заказов (28.07).
  useEffect(() => {
    let alive = true;
    const from = isoDate(new Date(Date.now() - 30 * 86_400_000)); // 30-дн окно — прогрето cron
    wbSupplierOrders(from)
      .then((list) => {
        if (!alive || !Array.isArray(list)) return;
        const map = new Map<string, number>();
        for (const o of list) {
          if (o.isCancel) continue;
          const d = (o.date || '').slice(0, 10);
          if (!d) continue;
          map.set(d, (map.get(d) || 0) + (o.priceWithDisc ?? o.finishedPrice ?? o.totalPrice ?? 0));
        }
        const series: DailyPoint[] = [...map.entries()]
          .map(([date, revenue]) => ({ date, revenue: Math.round(revenue), orders: 0 }))
          .sort((a, b) => (a.date < b.date ? -1 : 1));
        const maxDt = series.length ? series[series.length - 1].date : isoDate(new Date());
        setDaily({ series, maxDt });
      })
      .catch(() => { /* график опционален — молча */ });
    return () => { alive = false; };
  }, []);

  // Форму по дням берём из живых заказов, а МАСШТАБИРУЕМ под итог воронки (KPI
  // «Выручка» = wb.revenue). Так столбики суммируются ровно в KPI над графиком, а
  // дневной тренд сохраняется — иначе график (orders) и KPI (воронка) расходились.
  const rawDaily = buildDailyData(daily.series, daily.maxDt, PERIOD_DAYS[period]);
  const rawSum = rawDaily.reduce((a, b) => a + b, 0);
  const scale = rawSum > 0 && wb.revenue > 0 ? wb.revenue / rawSum : 1;
  const dailyData = scale === 1 ? rawDaily : rawDaily.map(v => Math.round(v * scale));

  useEffect(() => {
    let alive = true;
    setTop({ data: [], loading: true });

    // Окно = ровно N суток, включая сегодня (как в useLiveWb.dateRange и как
    // просит сборщик). Было на сутки длиннее — ключ кэша не совпадал с телом,
    // которое сборщик реально шлёт в WB.
    const days = PERIOD_DAYS[period];
    const end = isoDate(new Date());
    const begin = isoDate(new Date(Date.now() - (days - 1) * 86_400_000));

    wbNmReportAll(begin, end)
      .then((cards: WbNmReportCard[]) => {
        if (!alive) return;
        const rows: TopSkuRow[] = cards
          .map((c) => ({
            nmID: c.nmID,
            vendorCode: c.vendorCode,
            brandName: c.brandName ?? '',
            objectName: c.object?.name ?? '',
            revenue: c.statistics?.selectedPeriod?.ordersSumRub ?? 0,
            orders: c.statistics?.selectedPeriod?.ordersCount ?? 0,
          }))
          .sort((a, b) => b.revenue - a.revenue)
          .slice(0, 10);
        setTop({ data: rows, loading: false });
      })
      .catch((e: any) => {
        if (alive) setTop({ data: [], loading: false, error: String(e?.message ?? e) });
      });

    return () => { alive = false; };
  }, [period]);

  // Числа периода WB (окно today−N..today). Клиент просил, чтобы везде было видно,
  // за какие именно даты цифры.
  const wbPeriodLabel = (() => {
    const days = PERIOD_DAYS[period];
    const b = new Date(Date.now() - (days - 1) * 86_400_000);
    return `${PERIOD_LABEL[period]} (${fmtRangeRu(isoDate(b), isoDate(new Date()))})`;
  })();

  return (
    <div className="grid" style={{ gap: 20 }}>
      <div className="grid grid-4">
        <div className="card kpi">
          <div className="card-title">
            Выручка · {wbPeriodLabel}
            {wb.loading && <SpinnerIcon size={12} weight="bold" className="spin" style={{ marginLeft: 6, verticalAlign: -2 }} />}
          </div>
          <div className="v">{fmt(wb.revenue)}</div>
          <div className="d">{delta(wb.revenue, wb.prevRevenue)}</div>
        </div>
        <div className="card kpi">
          <div className="card-title">Заказов</div>
          <div className="v">{wb.orders}</div>
          <div className="d">{delta(wb.orders, wb.prevOrders)}</div>
        </div>
        <div className="card kpi">
          <div className="card-title">Средний чек</div>
          <div className="v">{fmt(wb.avgCheck)}</div>
          <div className="d muted">sales-funnel v3 · WB</div>
        </div>
        <div className="card kpi">
          <div className="card-title">SKU в кабинете</div>
          <div className="v">{wb.totalProducts}</div>
          <div className="d muted">content/v2/get/cards/list</div>
        </div>
      </div>

      <div className="card">
        <div className="flex-between" style={{ marginBottom: 12 }}>
          <h2 style={{ margin: 0 }}>Заказано по дням · WB</h2>
          <span className="chip info">{wbPeriodLabel} · sales-funnel v3</span>
        </div>
        {daily.maxDt && dailyData.some((v) => v > 0)
          ? <DailyBarsChart data={dailyData} days={PERIOD_DAYS[period]} endDate={daily.maxDt} color="#cb11ab" colorHover="#a00d87" />
          : <div className="muted" style={{ padding: 30, textAlign: 'center' }}>
              {wb.loading
                ? <><SpinnerIcon size={20} weight="bold" className="spin" /> Загружаем…</>
                : 'Данные по дням появятся после ближайшего обновления отчёта WB.'}
            </div>}
      </div>

      <div className="card">
        <div className="flex-between" style={{ marginBottom: 12 }}>
          <h2 style={{ margin: 0 }}>Топ-10 SKU по выручке · {wbPeriodLabel}</h2>
          <span className="chip info">sales-funnel v3 · WB</span>
        </div>
        {top.loading && top.data.length === 0 && (
          <div className="muted" style={{ padding: 24, textAlign: 'center' }}>
            <SpinnerIcon size={18} weight="bold" className="spin" /> Тянем sales-funnel…
          </div>
        )}
        {top.error && (
          <div className="muted" style={{ fontSize: 12 }}>WB API: {top.error}</div>
        )}
        {top.data.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th></th>
                <th>Артикул</th>
                <th>Бренд / Категория</th>
                <th className="right">Заказов</th>
                <th className="right">Выручка</th>
                <th className="right">Доля</th>
              </tr>
            </thead>
            <tbody>
              {top.data.map((s, i) => {
                const share = wb.revenue > 0 ? (s.revenue / wb.revenue) * 100 : 0;
                return (
                  <tr key={s.nmID}>
                    <td className="muted">{i + 1}</td>
                    <td>
                      <img src={wbImg(s.nmID)} alt="" style={{ width: 34, height: 45, objectFit: 'cover', borderRadius: 6 }} onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                    </td>
                    <td className="muted" style={{ fontSize: 12 }}>
                      <div>{s.vendorCode}</div>
                      <div style={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 11, opacity: 0.6 }}>nm{s.nmID}</div>
                    </td>
                    <td style={{ maxWidth: 460, fontSize: 13 }}>
                      {s.brandName}{s.objectName ? ` · ${s.objectName}` : ''}
                    </td>
                    <td className="right">{s.orders}</td>
                    <td className="right"><b>{fmt(s.revenue)}</b></td>
                    <td className="right">
                      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                        <div style={{ width: 60, height: 5, background: 'var(--bg-2)', borderRadius: 3, overflow: 'hidden' }}>
                          <div style={{ width: `${Math.min(100, share)}%`, height: '100%', background: '#cb11ab' }} />
                        </div>
                        <span className="muted" style={{ fontSize: 11 }}>{share.toFixed(1)}%</span>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
