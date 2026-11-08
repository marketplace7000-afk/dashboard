import { useState, useEffect } from 'react';
import { LiveOzonPricing } from '../components/LiveOzonPricing';
import { LiveWbPricing } from '../components/LiveWbPricing';
import { LiveWbGlobalPricing } from '../components/LiveWbGlobalPricing';
import { Repricer } from '../components/Repricer';
import { PriceAdvice } from '../components/PriceAdvice';
import { OzonDiscounts } from '../components/OzonDiscounts';

// Третья вкладка — репрайсер. Он про WB и живёт рядом с ценами, а не в
// «Конкурентах»: там разовый поиск по выдаче, здесь работа с нашим прайсом.
// «WB Global» (03.11.2026) — второй кабинет WB, китайская компания, цены в юанях.
// «Заявки на скидку» (08.11.2026) — правила и автоответ на заявки покупателей Ozon.
type MpScope = 'wb' | 'wbg' | 'ozon' | 'discounts' | 'repricer';

export function Prices() {
  const [mp, setMp] = useState<MpScope>(() => (typeof location !== 'undefined' && location.hash === '#prices-discounts' ? 'discounts' : 'wb'));
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
    <div className="grid pr-page" style={{ gap: 16 }}>
      {/* Липкие вкладки — тот же вид, что на «РНП» (.rnp-tabs: sticky, ниже топбара, выше карточек). */}
      <div className="row gap-8 rnp-tabs" style={{ top: topbarH }}>
        <button className={`mp-tab ${mp === 'wb' ? 'active' : ''}`} onClick={() => setMp('wb')}>
          <span className="mp-tab-dot" style={{ background: '#cb11ab' }} />
          Wildberries
          <span className="muted" style={{ marginLeft: 6 }}>live API</span>
        </button>
        <button className={`mp-tab ${mp === 'wbg' ? 'active' : ''}`} onClick={() => setMp('wbg')}>
          <span className="mp-tab-dot" style={{ background: '#8a2be2' }} />
          WB Global
          <span className="muted" style={{ marginLeft: 6 }}>юани</span>
        </button>
        <button className={`mp-tab ${mp === 'ozon' ? 'active' : ''}`} onClick={() => setMp('ozon')}>
          <span className="mp-tab-dot" style={{ background: '#005bff' }} />
          Ozon
          <span className="muted" style={{ marginLeft: 6 }}>live API</span>
        </button>
        <button className={`mp-tab ${mp === 'discounts' ? 'active' : ''}`} onClick={() => setMp('discounts')}>
          <span className="mp-tab-dot" style={{ background: '#005bff' }} />
          Заявки на скидку
          <span className="muted" style={{ marginLeft: 6 }}>Ozon</span>
        </button>
        <button className={`mp-tab ${mp === 'repricer' ? 'active' : ''}`} onClick={() => setMp('repricer')}>
          <span className="mp-tab-dot" style={{ background: 'var(--accent-2)' }} />
          Репрайсер
          <span className="muted" style={{ marginLeft: 6 }}>предложения</span>
        </button>
      </div>

      {(mp === 'wb' || mp === 'ozon') && <PriceAdvice mp={mp} />}

      {mp === 'wb' && <LiveWbPricing />}

      {mp === 'wbg' && <LiveWbGlobalPricing />}

      {mp === 'ozon' && <LiveOzonPricing />}

      {mp === 'discounts' && <OzonDiscounts />}

      {mp === 'repricer' && <Repricer />}
    </div>
  );
}
