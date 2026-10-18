/**
 * Общие мелочи раздела «Склад»: окно, поле формы, даты, поиск товара сканером.
 */
import { useRef, useState } from 'react';
import { XIcon, BarcodeIcon } from '@phosphor-icons/react';
import type { Product } from '../api/sklad';

export const fmtDate = (ts: number | null | undefined) =>
  ts ? new Date(ts).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
export const fmtDay = (ts: number | null | undefined) =>
  ts ? new Date(ts).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit' }) : '—';
export const fmtNum = (v: number | null | undefined) => (v === null || v === undefined ? '—' : String(v).replace('.', ','));

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className={`modal ${wide ? 'sk-modal-wide' : ''}`} onClick={e => e.stopPropagation()}>
        <div className="flex-between"><h2>{title}</h2><button className="close" onClick={onClose} title="Закрыть"><XIcon size={18} /></button></div>
        {children}
      </div>
    </div>
  );
}

export function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return <div className="field"><label className="field-label">{label}</label>{children}{hint && <div className="muted sk-hint">{hint}</div>}</div>;
}

/** Найти товар по баркоду (как сканер: только цифры) или артикулу. */
export function matchProduct(products: Product[], raw: string): Product | null {
  const s = raw.trim();
  if (!s) return null;
  const digits = s.replace(/\D+/g, '');
  if (digits.length >= 6) {
    const byCode = products.find(p => p.barcodes.some(b => b.barcode === digits || b.barcode.replace(/^0+/, '') === digits.replace(/^0+/, '')));
    if (byCode) return byCode;
  }
  const up = s.toUpperCase();
  return products.find(p => p.article.toUpperCase() === up) ?? null;
}

/**
 * Поле для сканера штрихкодов: сканер «печатает» цифры и жмёт Enter.
 * Можно вписать и артикул руками; под полем — подсказки по совпадению.
 */
export function ScanInput({ products, onPick, placeholder, autoFocus }: {
  products: Product[]; onPick: (p: Product) => void; placeholder?: string; autoFocus?: boolean;
}) {
  const [v, setV] = useState('');
  const [miss, setMiss] = useState<string | null>(null);
  const ref = useRef<HTMLInputElement>(null);
  const s = v.trim().toLowerCase();
  const hints = s.length >= 2 ? products.filter(p => p.status !== 'archived' && (p.article.toLowerCase().includes(s) || p.name.toLowerCase().includes(s))).slice(0, 6) : [];
  const pick = (p: Product) => { onPick(p); setV(''); setMiss(null); ref.current?.focus(); };
  const submit = () => {
    const p = matchProduct(products, v) ?? (hints.length === 1 ? hints[0] : null);
    if (p) pick(p); else if (v.trim()) setMiss(`Не найден: «${v.trim()}»`);
  };
  return (
    <div className="sk-scan">
      <div className="sk-search">
        <BarcodeIcon size={18} />
        <input ref={ref} className="input" value={v} placeholder={placeholder ?? 'Отсканируйте баркод или введите артикул'} autoFocus={autoFocus}
          onChange={e => { setV(e.target.value); setMiss(null); }}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }} />
      </div>
      {miss && <div className="sk-bad sk-hint">{miss}</div>}
      {hints.length > 0 && (
        <div className="sk-hints-list">
          {hints.map(p => (
            <button key={p.id} type="button" className="sk-hint-item" onClick={() => pick(p)}>
              <b>{p.article}</b> <span className="muted">{p.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
