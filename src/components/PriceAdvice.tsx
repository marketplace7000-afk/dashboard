/**
 * Советы по ценам на листах «Цены» (этап Б советника, 15.10.2026): открытые сигналы
 * адресата «Цены» из ленты советника — маржа ниже порога, цена выше рынка, запас по цене,
 * конкурент снизил цену, СПП. Полная лента с кнопками — РНП → «Советник».
 */
import { useEffect, useState } from 'react';
import { WarningIcon, WarningOctagonIcon, InfoIcon, CaretDownIcon, CaretUpIcon } from '@phosphor-icons/react';
import { apiGet } from '../api/http';
import type { Ads2Mp, Ads2Signal, Ads2SignalsResponse } from '../../shared/ads2';

export function PriceAdvice({ mp }: { mp: Ads2Mp }) {
  const [sig, setSig] = useState<Ads2Signal[] | null>(null);
  const [open, setOpen] = useState(() => { try { return localStorage.getItem('prices:advice') !== '0'; } catch { return true; } });
  useEffect(() => {
    let alive = true;
    apiGet<Ads2SignalsResponse>(`/api/ads2/signals?mp=${mp}`)
      .then(r => { if (alive) setSig((r.data.issue?.signals ?? []).filter(s => s.role === 'price' && s.status === 'open')); })
      .catch(() => { if (alive) setSig([]); });
    return () => { alive = false; };
  }, [mp]);
  if (!sig || !sig.length) return null;
  const toggle = () => setOpen(o => { try { localStorage.setItem('prices:advice', o ? '0' : '1'); } catch { /* не критично */ } return !o; });
  const crit = sig.filter(s => s.level === 'critical').length;
  return (
    <section className="card pa-card">
      <button className="pa-head" onClick={toggle} aria-expanded={open}>
        <b>Советник по ценам · {sig.length}{crit ? ` · срочных ${crit}` : ''}</b>
        <span className="muted">по последнему выпуску советника · полная лента и отметки «сделано» — РНП → «Советник»</span>
        <span className="pa-caret">{open ? <CaretUpIcon size={14} /> : <CaretDownIcon size={14} />}</span>
      </button>
      {open && (
        <div className="pa-list">
          {sig.map(s => {
            const Icon = s.level === 'critical' ? WarningOctagonIcon : s.level === 'warn' ? WarningIcon : InfoIcon;
            return (
              <div key={s.id} className={`pa-row adv-${s.level}`}>
                <Icon size={17} weight="fill" />
                <div>
                  <div><b>{s.article}</b> — {s.title}{s.days > 1 ? <span className="muted"> · {s.days}-й день</span> : null}</div>
                  <div className="pa-text">{s.text}</div>
                  {s.action && <div className="adv-action">→ {s.action}</div>}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
