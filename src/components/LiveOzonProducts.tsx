import { useMemo } from 'react';
import { SpinnerIcon, WarningIcon, ArrowsClockwiseIcon } from '@phosphor-icons/react';
import { OzonPriceRow, OzonProductInfo } from '../api/marketplaces';
import { useLiveOzonBundle, productInfoIndex } from '../api/useLiveOzonCache';

type Row = OzonPriceRow & { name?: string; primary_image?: string; old_price?: string; price?: any };

const fmt = (v: any) => {
  if (v == null || v === '') return '—';
  const n = parseFloat(typeof v === 'object' ? v.price : v);
  if (isNaN(n)) return '—';
  return n.toLocaleString('ru-RU') + ' ₽';
};

export function LiveOzonProducts({ limit = 20 }: { limit?: number }) {
  const bundle = useLiveOzonBundle();

  const rows: Row[] = useMemo(() => {
    const byId = productInfoIndex(bundle);
    return bundle.prices.slice(0, limit).map((p) => {
      const meta = byId.get(p.product_id) as OzonProductInfo | undefined;
      return { ...p, name: meta?.name, primary_image: meta?.primary_image };
    });
  }, [bundle, limit]);

  return (
    <div className="card">
      <div className="flex-between" style={{ marginBottom: 12 }}>
        <h2 style={{ margin: 0, display: 'inline-flex', alignItems: 'center', gap: 10 }}>
          <span className="mp-tab-dot" style={{ background: '#005bff' }} />
          Реальные SKU из кабинета Ozon
        </h2>
        <div className="row gap-8">
          {!bundle.loading && bundle.prices.length > 0 && (
            <span className="chip info">{rows.length} из {bundle.prices.length}</span>
          )}
          <button className="btn btn-sm" onClick={bundle.refresh} disabled={bundle.loading}>
            {bundle.loading
              ? <SpinnerIcon size={13} weight="bold" className="spin" />
              : <ArrowsClockwiseIcon size={13} weight="bold" />}
            Обновить
          </button>
        </div>
      </div>

      {bundle.error && (
        <div className="row" style={{ gap: 10, padding: 12, background: 'rgba(220,38,38,.08)', borderRadius: 8, marginBottom: 12 }}>
          <WarningIcon size={18} weight="bold" style={{ color: 'var(--bad)' }} />
          <div className="muted" style={{ fontSize: 12.5 }}>{bundle.error}</div>
        </div>
      )}

      {bundle.loading && rows.length === 0 && (
        <div className="muted" style={{ padding: 24, textAlign: 'center' }}>
          <SpinnerIcon size={20} weight="bold" className="spin" /> Загружаем данные из Ozon Seller API…
        </div>
      )}

      {rows.length > 0 && (
        <table>
          <thead>
            <tr>
              <th></th>
              <th>Артикул</th>
              <th>Название</th>
              <th className="right">Цена</th>
              <th className="right">Старая</th>
              <th className="right">Min</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.product_id}>
                <td style={{ width: 44 }}>
                  {r.primary_image
                    ? <img src={r.primary_image} alt="" style={{ width: 36, height: 36, borderRadius: 6, objectFit: 'cover', background: 'var(--bg-2)' }} />
                    : <div style={{ width: 36, height: 36, borderRadius: 6, background: 'var(--bg-2)' }} />}
                </td>
                <td className="muted" style={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12 }}>{r.offer_id}</td>
                <td style={{ maxWidth: 360 }}>
                  <div style={{ fontSize: 13, lineHeight: 1.35, overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
                    {r.name ?? '—'}
                  </div>
                  <div className="muted" style={{ fontSize: 11 }}>product_id {r.product_id}</div>
                </td>
                <td className="right"><b>{fmt(r.price.price)}</b></td>
                <td className="right muted">{fmt(r.price.old_price)}</td>
                <td className="right muted">{fmt(r.price.min_price)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
