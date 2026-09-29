import { useState } from 'react';
import { Stub } from '../components/Stub';
import { LiveOzonAnalytics } from '../components/LiveOzonAnalytics';
import { LiveWbAnalytics } from '../components/LiveWbAnalytics';
import { PeriodKey, PERIOD_LABEL } from '../api/useLiveOzon';

// Конкурентная разведка вынесена в отдельную вкладку «Конкуренты» (реальный парсер
// WB+Ozon). Здесь — только свои показатели по живым данным Ozon/WB.
export function Analytics() {
  const [source, setSource] = useState<'ozon' | 'wb'>('ozon');
  const [period, setPeriod] = useState<PeriodKey>('week');

  return (
    <div className="grid" style={{ gap: 16 }}>
      <div className="flex-between" style={{ flexWrap: 'wrap', gap: 12 }}>
        <div className="row gap-8" style={{ flexWrap: 'wrap' }}>
          <button className={`mp-tab ${source === 'ozon' ? 'active' : ''}`} onClick={() => setSource('ozon')}>
            <span className="mp-tab-dot" style={{ background: '#005bff' }} />
            Ozon
            <span className="muted" style={{ marginLeft: 6 }}>live API</span>
          </button>
          <button className={`mp-tab ${source === 'wb' ? 'active' : ''}`} onClick={() => setSource('wb')}>
            <span className="mp-tab-dot" style={{ background: '#cb11ab' }} />
            Wildberries
            <span className="muted" style={{ marginLeft: 6 }}>live API</span>
          </button>
        </div>
        <div className="period-switch">
          {(['day', 'week', 'month'] as PeriodKey[]).map((p) => (
            <button key={p} className={`period-btn ${period === p ? 'active' : ''}`} onClick={() => setPeriod(p)}>
              {PERIOD_LABEL[p]}
            </button>
          ))}
        </div>
      </div>

      {source === 'ozon' ? (
        <>
          <Stub title="Реальные данные Ozon · период переключается выше">
            Цифры тянутся из <code>v1/analytics/data</code>. Сравнение — с предыдущим равным периодом.
            Топ-10 SKU — разрез <code>dimension: sku</code>.
          </Stub>
          <LiveOzonAnalytics period={period} />
        </>
      ) : (
        <LiveWbAnalytics period={period} />
      )}
    </div>
  );
}
