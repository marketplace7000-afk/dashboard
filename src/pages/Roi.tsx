import { useState } from 'react';
import { LiveOzonRoi } from '../components/LiveOzonRoi';
import { LiveWbRoi } from '../components/LiveWbRoi';
import { MissingCostsNote } from '../components/MissingCostsNote';

// Страница «ROI и алерты»: две вкладки-площадки. Озон — цены/заказы из API + деньги
// из «Маржи»; ВБ — деньги целиком из «Маржи» (колонки N/Q/R), заказы из кэша ВБ.
export function Roi() {
  const [mp, setMp] = useState<'ozon' | 'wb'>('ozon');
  return (
    <div className="grid" style={{ gap: 16 }}>
      {/* Пробелы в ROI объясняем причиной, а не оставляем пустые ячейки */}
      <MissingCostsNote />
      <div className="row gap-8" style={{ flexWrap: 'wrap' }}>
        <button className={`mp-tab ${mp === 'ozon' ? 'active' : ''}`} onClick={() => setMp('ozon')}>
          <span className="mp-tab-dot" style={{ background: '#005bff' }} />
          Ozon
        </button>
        <button className={`mp-tab ${mp === 'wb' ? 'active' : ''}`} onClick={() => setMp('wb')}>
          <span className="mp-tab-dot" style={{ background: '#cb11ab' }} />
          Wildberries
          <span className="muted" style={{ marginLeft: 6 }}>из «Маржи»</span>
        </button>
      </div>
      {mp === 'ozon' ? <LiveOzonRoi /> : <LiveWbRoi />}
    </div>
  );
}
