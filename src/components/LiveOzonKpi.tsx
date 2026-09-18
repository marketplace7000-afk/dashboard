import { useEffect, useState } from 'react';
import { SpinnerIcon, WarningIcon } from '@phosphor-icons/react';
import { ozonAnalyticsTotals, ozonProductList } from '../api/marketplaces';
import { mskDate } from '../utils/mskDate';

type State = {
  loading: boolean;
  error?: string;
  totalProducts?: number;
  today?: { orders: number; revenue: number };
  week?: { orders: number; revenue: number; daily: number[] };
};

export function LiveOzonKpi() {
  const [s, setS] = useState<State>({ loading: true });

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [products, today, week] = await Promise.all([
          ozonProductList(1),
          ozonAnalyticsTotals(1),
          (async () => {
            const r = await fetch('/ozon/v1/analytics/data', {
              method: 'POST',
              body: JSON.stringify({
                date_from: mskDate(7),
                date_to: mskDate(0),
                metrics: ['ordered_units', 'revenue'],
                dimension: ['day'],
                limit: 100,
                offset: 0,
              }),
            }).then((r) => r.json());
            const rows: { metrics: number[] }[] = r?.result?.data ?? [];
            return {
              orders: rows.reduce((sum, x) => sum + (x.metrics[0] ?? 0), 0),
              revenue: rows.reduce((sum, x) => sum + (x.metrics[1] ?? 0), 0),
              daily: rows.map((x) => x.metrics[1] ?? 0),
            };
          })(),
        ]);
        if (!alive) return;
        setS({
          loading: false,
          totalProducts: products.total,
          today: { orders: today.ordered_units, revenue: today.revenue },
          week,
        });
      } catch (e: any) {
        if (!alive) return;
        setS({ loading: false, error: String(e?.message ?? e) });
      }
    })();
    return () => { alive = false; };
  }, []);

  if (s.loading) {
    return (
      <div className="card" style={{ display: 'flex', alignItems: 'center', gap: 12, color: 'var(--muted)' }}>
        <SpinnerIcon size={18} weight="bold" className="spin" />
        Тянем живые данные Ozon…
      </div>
    );
  }

  if (s.error) {
    return (
      <div className="card" style={{ display: 'flex', alignItems: 'center', gap: 10, background: 'rgba(220,38,38,.08)' }}>
        <WarningIcon size={18} weight="bold" style={{ color: 'var(--bad)' }} />
        <div>
          <b style={{ color: 'var(--bad)' }}>Ozon API недоступен</b>
          <div className="muted" style={{ fontSize: 12 }}>{s.error}</div>
        </div>
      </div>
    );
  }

  const fmt = (n: number) => n.toLocaleString('ru-RU') + ' ₽';
  const avgWeek = s.week!.orders > 0 ? Math.round(s.week!.revenue / s.week!.orders) : 0;

  return (
    <div className="card" style={{ background: 'linear-gradient(135deg, #f0f6ff, #fff)' }}>
      <div className="flex-between" style={{ marginBottom: 14 }}>
        <h2 style={{ margin: 0, display: 'inline-flex', alignItems: 'center', gap: 10 }}>
          <span className="mp-tab-dot" style={{ background: '#005bff' }} />
          Ozon · живые данные из API клиента
        </h2>
        <span className="chip good"><span className="dot" /> подключено</span>
      </div>
      <div className="grid grid-4">
        <div className="kpi">
          <div className="card-title">Товаров в кабинете</div>
          <div className="v">{s.totalProducts}</div>
          <div className="d muted">Seller API · v3/product/list</div>
        </div>
        <div className="kpi">
          <div className="card-title">Сегодня · выручка</div>
          <div className="v">{fmt(s.today!.revenue)}</div>
          <div className="d muted">{s.today!.orders} заказов</div>
        </div>
        <div className="kpi">
          <div className="card-title">За 7 дней · выручка</div>
          <div className="v">{fmt(s.week!.revenue)}</div>
          <div className="d muted">{s.week!.orders} заказов</div>
        </div>
        <div className="kpi">
          <div className="card-title">Средний чек (7д)</div>
          <div className="v">{fmt(avgWeek)}</div>
          <div className="d muted">v1/analytics/data</div>
        </div>
      </div>
    </div>
  );
}
