import { useMemo, useState, useRef, useEffect } from 'react';
import { BellIcon, FireIcon, ClockIcon, CurrencyRubIcon, CheckCircleIcon } from '@phosphor-icons/react';
import { useProcurement } from '../api/useProcurement';

// Рабочий колокольчик: алерты из уже загруженных данных (лист «Маржа» + закупки).
// Никаких лишних запросов к API — только то, что и так есть на фронте.
const ROI_ALERT_THRESHOLD = 20;

export function NotificationsBell({ onNav }: { onNav: (page: string) => void }) {
  const { items } = useProcurement();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  const alerts = useMemo(() => {
    const orderNow = items.filter((p) => p.urgency === 'order_now');
    const orderSoon = items.filter((p) => p.urgency === 'order_soon');
    // ROI ниже порога — по последней неделе «Маржи», только товары в наличии на Озоне
    const lowRoi = items.filter((p) => p.stockOzon > 0 && p.roiOzonMarzha != null && p.roiOzonMarzha < ROI_ALERT_THRESHOLD);
    const list: { key: string; Icon: any; color: string; text: string; sub: string; page: string }[] = [];
    if (orderNow.length) list.push({
      key: 'order-now', Icon: FireIcon, color: '#dc2626',
      text: `Заказать сейчас: ${orderNow.length} SKU`,
      sub: orderNow.slice(0, 4).map((p) => p.sku).join(', ') + (orderNow.length > 4 ? '…' : ''),
      page: 'procurement',
    });
    if (orderSoon.length) list.push({
      key: 'order-soon', Icon: ClockIcon, color: '#d97706',
      text: `Скоро заказывать: ${orderSoon.length} SKU`,
      sub: orderSoon.slice(0, 4).map((p) => p.sku).join(', ') + (orderSoon.length > 4 ? '…' : ''),
      page: 'procurement',
    });
    if (lowRoi.length) list.push({
      key: 'low-roi', Icon: CurrencyRubIcon, color: '#dc2626',
      text: `ROI ниже ${ROI_ALERT_THRESHOLD}%: ${lowRoi.length} SKU`,
      sub: lowRoi.slice(0, 4).map((p) => `${p.sku} ${(p.roiOzonMarzha as number).toFixed(0)}%`).join(', ') + (lowRoi.length > 4 ? '…' : ''),
      page: 'roi',
    });
    return list;
  }, [items]);

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button className="icon-btn" title="Уведомления" onClick={() => setOpen((o) => !o)}>
        <BellIcon size={18} weight="bold" />
        {alerts.length > 0 && <span className="icon-btn-dot" />}
      </button>
      {open && (
        <div style={{
          position: 'absolute', right: 0, top: 'calc(100% + 8px)', zIndex: 100,
          width: 320, background: 'var(--bg)', border: '1px solid var(--border)',
          borderRadius: 12, boxShadow: '0 8px 24px rgba(0,0,0,.12)', padding: 8,
        }}>
          {alerts.length === 0 ? (
            <div className="row gap-8" style={{ padding: 14, color: 'var(--muted)', fontSize: 13 }}>
              <CheckCircleIcon size={16} weight="bold" style={{ color: 'var(--good)' }} />
              Все спокойно — критичных алертов нет
            </div>
          ) : alerts.map((a) => (
            <button key={a.key}
              onClick={() => { setOpen(false); onNav(a.page); }}
              style={{
                display: 'block', width: '100%', textAlign: 'left', font: 'inherit', color: 'inherit',
                background: 'transparent', border: 'none', borderRadius: 8, padding: '10px 10px', cursor: 'pointer',
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-2)')}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
            >
              <div className="row gap-8" style={{ alignItems: 'center' }}>
                <a.Icon size={15} weight="fill" style={{ color: a.color, flexShrink: 0 }} />
                <strong style={{ fontSize: 13 }}>{a.text}</strong>
              </div>
              <div className="muted" style={{ fontSize: 11.5, marginTop: 3, paddingLeft: 23, fontFamily: 'ui-monospace, Menlo, monospace' }}>{a.sub}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
