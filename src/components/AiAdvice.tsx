import { useState, useRef, useEffect } from 'react';
import { SparkleIcon, SpinnerIcon, ArrowsClockwiseIcon, WarningIcon, FireIcon, ClockIcon, CheckCircleIcon } from '@phosphor-icons/react';
import { aiAdvise, AdviceModule, Advice } from '../api/ai';

// Переиспользуемая карточка «Совет ИИ» для любого модуля. Клиент просил, чтобы
// Ишка подсказывал в каждом разделе: выходить/не выходить, что подсветить.
// Данные НЕ перезапрашиваются — берём то, что уже загружено на экране (проп context).

const PRIO: Record<'high' | 'medium' | 'low', { color: string; bg: string; Icon: any; label: string }> = {
  high:   { color: '#dc2626', bg: 'rgba(220,38,38,.10)', Icon: FireIcon,        label: 'Важно' },
  medium: { color: '#d97706', bg: 'rgba(217,119,6,.10)', Icon: ClockIcon,       label: 'Средне' },
  low:    { color: '#16a34a', bg: 'rgba(22,163,74,.10)', Icon: CheckCircleIcon, label: 'План' },
};

export function AiAdvice({ module, context, disabled }: { module: AdviceModule; context: any; disabled?: boolean }) {
  const [advice, setAdvice] = useState<Advice | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  // После генерации совета подкручиваем панель в вид — на длинных страницах
  // ответ появляется ниже экрана и клиент его не видит (просьба 19.07).
  useEffect(() => {
    if (advice && cardRef.current) {
      cardRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [advice]);

  const run = async (forceRefresh = false) => {
    setLoading(true); setError(null);
    if (forceRefresh) setAdvice(null);
    try {
      const res = await aiAdvise(module, context, { noCache: forceRefresh });
      setAdvice(res.advice);
    } catch (e: any) { setError(e?.message || 'Ошибка ИИ'); }
    finally { setLoading(false); }
  };

  return (
    <div ref={cardRef} className="card" style={{ background: 'var(--accent-soft)', border: '1px solid rgba(37,99,235,.18)' }}>
      <div className="flex-between" style={{ flexWrap: 'wrap', gap: 8 }}>
        <div className="row gap-8" style={{ alignItems: 'center' }}>
          <SparkleIcon size={16} weight="fill" style={{ color: 'var(--accent)' }} />
          <strong style={{ fontSize: 14, color: 'var(--accent-2)' }}>Совет ИИ по разделу</strong>
        </div>
        {advice
          ? <button className="btn btn-sm" onClick={() => run(true)} disabled={loading} title="Пересчитать (тратит токены)">
              {loading ? <SpinnerIcon size={13} weight="bold" className="spin" /> : <ArrowsClockwiseIcon size={13} weight="bold" />} Обновить
            </button>
          : <button className="btn btn-sm btn-primary" onClick={() => run(false)} disabled={loading || disabled}>
              {loading ? <><SpinnerIcon size={13} weight="bold" className="spin" /> Анализирую…</> : <><SparkleIcon size={13} weight="bold" /> Проанализировать</>}
            </button>}
      </div>

      {error && (
        <div className="row gap-6" style={{ marginTop: 10, color: 'var(--bad)', fontSize: 13 }}>
          <WarningIcon size={14} weight="bold" /> {error}
        </div>
      )}

      {advice && (
        <div style={{ marginTop: 12, display: 'grid', gap: 12 }}>
          {advice.verdict && (
            <div style={{ fontSize: 13.5, lineHeight: 1.55, color: 'var(--text)' }}>{advice.verdict}</div>
          )}

          {advice.actions?.length > 0 && (
            <div style={{ display: 'grid', gap: 6 }}>
              {advice.actions.map((a, i) => {
                const m = PRIO[a.priority] || PRIO.medium;
                return (
                  <div key={i} className="row gap-8" style={{ alignItems: 'flex-start', padding: '8px 10px', borderRadius: 8, background: m.bg }}>
                    <m.Icon size={14} weight="bold" style={{ color: m.color, marginTop: 1, flexShrink: 0 }} />
                    <div style={{ fontSize: 13, lineHeight: 1.5 }}>
                      {a.sku && <span style={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 11.5, color: m.color, marginRight: 6 }}>{a.sku}</span>}
                      {a.text}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {advice.warnings?.length > 0 && (
            <div style={{ display: 'grid', gap: 4 }}>
              {advice.warnings.map((w, i) => (
                <div key={i} className="row gap-6" style={{ fontSize: 12.5, color: 'var(--warn)' }}>
                  <WarningIcon size={13} weight="bold" style={{ flexShrink: 0, marginTop: 2 }} /> {w}
                </div>
              ))}
            </div>
          )}

          {advice.raw && !advice.verdict && (
            <div className="muted" style={{ fontSize: 12.5, whiteSpace: 'pre-wrap' }}>{advice.raw}</div>
          )}

          <div className="muted" style={{ fontSize: 11 }}>
            Совет ИИ на основе данных на экране. Это рекомендация — решение за вами.
          </div>
        </div>
      )}
    </div>
  );
}
