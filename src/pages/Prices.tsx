import { useState, useEffect } from 'react';
import { LiveOzonPricing } from '../components/LiveOzonPricing';
import { LiveWbPricing } from '../components/LiveWbPricing';
import { Repricer } from '../components/Repricer';

// Третья вкладка — репрайсер. Он про WB и живёт рядом с ценами, а не в
// «Конкурентах»: там разовый поиск по выдаче, здесь работа с нашим прайсом.
type MpScope = 'wb' | 'ozon' | 'repricer';

export function Prices() {
  const [mp, setMp] = useState<MpScope>('wb');
  // Плашки WB/Ozon липнут ПОД топбаром (он сам sticky top:0). Высоту топбара
  // меряем в рантайме — иначе на мобиле, где он переносится, top не угадать.
  const [topbarH, setTopbarH] = useState(56);
  useEffect(() => {
    const tb = document.querySelector('.topbar') as HTMLElement | null;
    if (!tb) return;
    const measure = () => setTopbarH(h => (tb.offsetHeight !== h ? tb.offsetHeight : h));
    measure();
    // Высота шапки меняется ПОЗЖЕ монтирования: на узком экране она переносится
    // в две строки, а в мини-аппе Telegram ещё и добавляет отступ под системную
    // панель. Раньше замер был один, и плашки липли к старой высоте, оказываясь
    // под шапкой (жалоба 30.07). ResizeObserver на это не годится: он не ловит
    // изменение паддинга. Поэтому перемеряем на прокрутке (когда липкость и
    // важна) и несколько раз в первые секунды, пока раскладка устаканивается.
    const timers = [100, 400, 1000, 2500, 5000].map(ms => setTimeout(measure, ms));
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, { passive: true });
    return () => {
      timers.forEach(clearTimeout);
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure);
    };
  }, []);

  return (
    <div className="grid" style={{ gap: 20 }}>
      <div
        className="row gap-8"
        style={{
          flexWrap: 'wrap',
          position: 'sticky',
          top: topbarH,
          zIndex: 4,               // ниже топбара (5), выше карточек
          background: 'var(--bg)',
          padding: '10px 0',
          margin: '-10px 0 0',      // компенсируем padding, чтобы не рос зазор
          boxShadow: '0 6px 8px -8px rgba(0,0,0,.18)',
        }}
      >
        <button className={`mp-tab ${mp === 'wb' ? 'active' : ''}`} onClick={() => setMp('wb')}>
          <span className="mp-tab-dot" style={{ background: '#cb11ab' }} />
          Wildberries
          <span className="muted" style={{ marginLeft: 6 }}>live API</span>
        </button>
        <button className={`mp-tab ${mp === 'ozon' ? 'active' : ''}`} onClick={() => setMp('ozon')}>
          <span className="mp-tab-dot" style={{ background: '#005bff' }} />
          Ozon
          <span className="muted" style={{ marginLeft: 6 }}>live API</span>
        </button>
        <button className={`mp-tab ${mp === 'repricer' ? 'active' : ''}`} onClick={() => setMp('repricer')}>
          <span className="mp-tab-dot" style={{ background: 'var(--accent-2)' }} />
          Репрайсер
          <span className="muted" style={{ marginLeft: 6 }}>предложения</span>
        </button>
      </div>

      {mp === 'wb' && <LiveWbPricing />}

      {mp === 'ozon' && <LiveOzonPricing />}

      {mp === 'repricer' && <Repricer />}
    </div>
  );
}
