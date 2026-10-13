// Общие детали экранов «Отзывы и вопросы» и «Чаты с покупателями» (стили .rv- в styles.css).
import { useLayoutEffect, useRef, type CSSProperties, type ReactNode } from 'react';

export const MP_COLOR = { wb: '#cb11ab', ozon: '#005bff' } as const;
export const MP_NAME = { wb: 'WB', ozon: 'Ozon' } as const;
export type Mp = keyof typeof MP_COLOR;

/** CSS-переменная --mp для цвета площадки. */
export const mpVar = (mp: Mp) => ({ '--mp': MP_COLOR[mp] } as CSSProperties);

export function MpTag({ mp }: { mp: Mp }) {
  return <span className="rv-mp" style={mpVar(mp)}>{MP_NAME[mp]}</span>;
}

/** Переключатель вместо голого чекбокса. */
export function Switch({ checked, onChange, disabled, title, children }: {
  checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; title?: string; children: ReactNode;
}) {
  return (
    <label className={`rv-switch${disabled ? ' is-disabled' : ''}`} title={title}>
      <input type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={e => onChange(e.target.checked)} />
      <span className="rv-switch-track" aria-hidden="true" />
      <span>{children}</span>
    </label>
  );
}

export type Tone = 'good' | 'bad' | 'info' | 'warn' | 'neutral';
export function Badge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`rv-badge rv-badge--${tone}`}>{children}</span>;
}

/** Поле ответа растёт по тексту, чтобы черновик было видно целиком. */
export function useAutoGrow(value: string) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight + 2, 420)}px`;
  }, [value]);
  return ref;
}

const SOURCE_NAMES: Record<string, string> = {
  style: 'профиль стиля', card: 'карточка товара', product: 'материалы Диска',
  history: 'прошлые ответы', chat: 'переписка', telegram: 'Telegram',
};
/** «опора: карточка товара, прошлые ответы» — на чём ИИ построил черновик. */
export function sourcesText(sources: string[]): string {
  const names = [...new Set(sources.map(s => s.split(':')[0]))].map(s => SOURCE_NAMES[s] || s);
  return names.length ? `Опора: ${names.join(', ')}` : '';
}
