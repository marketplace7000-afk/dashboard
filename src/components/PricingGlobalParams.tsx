import { SlidersHorizontalIcon, ArrowCounterClockwiseIcon, CheckIcon } from '@phosphor-icons/react';

// Панель ГЛОБАЛЬНЫХ параметров расчёта — одинаковая для WB и Ozon (просьба клиента
// 21.07). Значения применяются КО ВСЕМ товарам как «умолчание»: пустое поле → берётся
// факт по товару (из таблицы/API); вписанное значение + «Применить» → становится
// умолчанием там, где факта нет. Крутилка в конкретной строке всё равно главнее.
export type GParamField = { key: string; label: string; suffix?: string };

export function PricingGlobalParams({
  fields, draft, onChange, onApply, onReset, color,
}: {
  fields: GParamField[];
  draft: Record<string, string>;
  onChange: (key: string, v: string) => void;
  onApply: () => void;
  onReset: () => void;
  color: string;
}) {
  const hasAny = Object.values(draft).some((v) => v != null && String(v).trim() !== '');
  return (
    <div className="card">
      <div className="card-title" style={{ marginBottom: 10, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <SlidersHorizontalIcon size={14} weight="bold" style={{ color }} />
        Глобальные параметры — применяются ко всем товарам
      </div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        {fields.map((f) => (
          <label key={f.key} style={{ fontSize: 12 }}>
            <div className="muted" style={{ marginBottom: 3 }}>{f.label}{f.suffix ? `, ${f.suffix}` : ''}</div>
            <input
              className="input"
              type="number"
              value={draft[f.key] ?? ''}
              placeholder="—"
              onChange={(e) => onChange(f.key, e.target.value)}
              style={{ width: 96 }}
            />
          </label>
        ))}
        <button className="btn btn-sm btn-good" onClick={onApply} disabled={!hasAny} title="Применить ко всем товарам">
          <CheckIcon size={13} weight="bold" /> Применить
        </button>
        <button className="btn btn-sm" onClick={onReset} disabled={!hasAny} title="Очистить все глобальные параметры">
          <ArrowCounterClockwiseIcon size={13} weight="bold" /> Сбросить
        </button>
      </div>
      <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>
        Пусто — берётся факт по товару (из таблицы/API). Впиши значение и «Применить» — оно станет
        умолчанием там, где факта нет. Значение в конкретной строке (раскрытый сценарий) всё равно главнее.
      </div>
    </div>
  );
}
