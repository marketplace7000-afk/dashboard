import { useProcurement } from '../api/useProcurement';
import { WarningIcon } from '@phosphor-icons/react';

/**
 * «По N товарам нет себестоимости» — предупреждение там, где смотрят на ROI.
 *
 * Без себестоимости ROI и прибыль не считаются, и строка просто остаётся пустой.
 * Пустая строка выглядит как «данные ещё грузятся», хотя на самом деле цифры не
 * появятся никогда, пока закупочную цену не внесут. Клиент просил «добиться
 * верных цифр» — честно назвать причину пробела и есть часть этой работы.
 */
export function MissingCostsNote({ onOpenCosts }: { onOpenCosts?: () => void }) {
  const { items, loading } = useProcurement();
  if (loading || !items?.length) return null;

  const missing = items.filter((p: any) => !(Number(p.purchasePrice) > 0));
  if (!missing.length) return null;

  const sample = missing.slice(0, 5).map((p: any) => p.sku).join(', ');

  return (
    <div className="card" style={{ borderLeft: '3px solid var(--warn)' }}>
      <div className="row gap-8" style={{ alignItems: 'flex-start' }}>
        <WarningIcon size={16} weight="bold" style={{ color: 'var(--warn)', marginTop: 2 }} />
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 600 }}>
            Нет себестоимости по {missing.length} товарам — ROI и прибыль по ним не считаются
          </div>
          <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
            {sample}{missing.length > 5 ? ` и ещё ${missing.length - 5}` : ''}.
            Прочерк в этих строках означает «нет закупочной цены», а не нулевую прибыль.
          </div>
        </div>
        {onOpenCosts && (
          <button className="btn btn-sm" onClick={onOpenCosts}>Внести</button>
        )}
      </div>
    </div>
  );
}
