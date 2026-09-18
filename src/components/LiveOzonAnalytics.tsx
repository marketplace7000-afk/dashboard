import { useEffect, useState } from 'react';
import { SpinnerIcon, TrendUpIcon, TrendDownIcon } from '@phosphor-icons/react';
import { ozonAnalyticsBySku, OzonTopSku } from '../api/marketplaces';
import { useLiveOzon, PeriodKey, PERIOD_LABEL, PERIOD_DAYS, ozonPeriodRange, fmtRangeRu, periodLabelRu } from '../api/useLiveOzon';
import { useLiveOzonBundle, productInfoIndex } from '../api/useLiveOzonCache';
import { AiAdvice } from './AiAdvice';
import { DailyBarsChart } from './DailyBarsChart';

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

export function LiveOzonAnalytics({ period }: { period: PeriodKey }) {
  const ozon = useLiveOzon(period);
  // Обогащение топ-10 артикулом (offer_id) и фото: числовой sku → product_id → инфо.
  const bundle = useLiveOzonBundle();
  const pidIndex = productInfoIndex(bundle);
  const infoForSku = (sku: string) => {
    const pid = bundle.skuToPid.get(sku);
    return pid != null ? pidIndex.get(pid) : undefined;
  };
  const [top, setTop] = useState<{ data: OzonTopSku[]; loading: boolean; error?: string }>({ data: [], loading: true });

  useEffect(() => {
    let alive = true;
    setTop({ data: [], loading: true });
    ozonAnalyticsBySku(PERIOD_DAYS[period], 10)
      .then((data) => { if (alive) setTop({ data, loading: false }); })
      .catch((e) => { if (alive) setTop({ data: [], loading: false, error: String(e?.message ?? e) }); });
    return () => { alive = false; };
  }, [period]);

  const adviceContext = {
    площадка: 'Ozon', период: periodLabelRu(period),
    выручка: Math.round(ozon.revenue), выручка_пред: Math.round(ozon.prevRevenue),
    заказов: ozon.orders, заказов_пред: ozon.prevOrders,
    топ_SKU: top.data.slice(0, 10).map((s) => ({ sku: infoForSku(s.sku)?.offer_id || s.sku, заказов: s.orders, выручка: Math.round(s.revenue) })),
  };

  return (
    <div className="grid" style={{ gap: 20 }}>
      <AiAdvice module="analytics" context={adviceContext} disabled={ozon.revenue === 0 && top.data.length === 0} />
      <div className="grid grid-4">
        <div className="card kpi">
          <div className="card-title">
            Заказано · {periodLabelRu(period)}
            {ozon.loading && <SpinnerIcon size={12} weight="bold" className="spin" style={{ marginLeft: 6, verticalAlign: -2 }} />}
          </div>
          <div className="v">{fmt(ozon.revenue)}</div>
          <div className="d">{delta(ozon.revenue, ozon.prevRevenue)}</div>
        </div>
        <div className="card kpi">
          <div className="card-title">Заказов</div>
          <div className="v">{ozon.orders}</div>
          <div className="d">{delta(ozon.orders, ozon.prevOrders)}</div>
        </div>
        <div className="card kpi">
          <div className="card-title">Средний чек</div>
          <div className="v">{fmt(ozon.avgCheck)}</div>
          <div className="d muted">v1/analytics/data · ozon</div>
        </div>
        <div className="card kpi">
          <div className="card-title">SKU в кабинете</div>
          <div className="v">{ozon.totalProducts}</div>
          <div className="d muted">v3/product/list</div>
        </div>
      </div>

      <div className="card">
        <div className="flex-between" style={{ marginBottom: 12 }}>
          <h2 style={{ margin: 0 }}>Заказано по дням · Ozon</h2>
          <span className="chip info">{PERIOD_LABEL[period]} ({fmtRangeRu(ozonPeriodRange(period).from, ozonPeriodRange(period).to)}) · live</span>
        </div>
        {ozon.loading && ozon.daily.length === 0
          ? <div className="muted" style={{ padding: 30, textAlign: 'center' }}>
              <SpinnerIcon size={20} weight="bold" className="spin" /> Загружаем…
            </div>
          : <DailyBarsChart data={ozon.daily} days={PERIOD_DAYS[period]} endDate={ozonPeriodRange(period).to} />
        }
      </div>

      <div className="card">
        <div className="flex-between" style={{ marginBottom: 12 }}>
          <h2 style={{ margin: 0 }}>Топ-10 SKU по сумме заказов · {periodLabelRu(period)}</h2>
          <span className="chip info">v1/analytics/data · dimension: sku</span>
        </div>
        {top.loading && top.data.length === 0 && (
          <div className="muted" style={{ padding: 24, textAlign: 'center' }}>
            <SpinnerIcon size={18} weight="bold" className="spin" /> Тянем разбивку по товарам…
          </div>
        )}
        {top.error && (
          <div className="muted" style={{ fontSize: 12 }}>Ozon API: {top.error}</div>
        )}
        {top.data.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th></th>
                <th>Артикул</th>
                <th>Название</th>
                <th className="right">Заказов</th>
                <th className="right">Сумма заказов</th>
                <th className="right">Доля</th>
              </tr>
            </thead>
            <tbody>
              {top.data.map((s, i) => {
                const share = ozon.revenue > 0 ? (s.revenue / ozon.revenue) * 100 : 0;
                const info = infoForSku(s.sku);
                const img = info?.primary_image || info?.images?.[0];
                return (
                  <tr key={s.sku}>
                    <td className="muted">{i + 1}</td>
                    <td>
                      {img
                        ? <img src={img} alt="" style={{ width: 34, height: 34, objectFit: 'cover', borderRadius: 6 }} onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                        : <div style={{ width: 34, height: 34, borderRadius: 6, background: 'var(--bg-2)' }} />}
                    </td>
                    <td className="muted" style={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12 }}>
                      {info?.offer_id || s.sku}
                    </td>
                    <td style={{ maxWidth: 420, fontSize: 13 }}>{s.name}</td>
                    <td className="right">{s.orders}</td>
                    <td className="right"><b>{fmt(s.revenue)}</b></td>
                    <td className="right">
                      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                        <div style={{ width: 60, height: 5, background: 'var(--bg-2)', borderRadius: 3, overflow: 'hidden' }}>
                          <div style={{ width: `${Math.min(100, share)}%`, height: '100%', background: '#005bff' }} />
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
