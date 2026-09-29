/**
 * Таблица товаров WB — артикулы, фото, названия, цены.
 * Аналог LiveOzonProducts.tsx.
 */
import { SpinnerIcon, ArrowClockwiseIcon, ImageIcon } from '@phosphor-icons/react';
import { useLiveWbBundle, wbCardIndex } from '../api/useLiveWbCache';
import type { WbPriceRow, WbCard } from '../api/marketplaces';

const fmt = (n: number) => n.toLocaleString('ru-RU') + ' ₽';

type Row = WbPriceRow & { card?: WbCard };

export function LiveWbProducts({ limit = 20 }: { limit?: number }) {
  const bundle = useLiveWbBundle();
  const cards = wbCardIndex(bundle);

  if (bundle.loading) {
    return (
      <div className="card" style={{ textAlign: 'center', padding: 40 }}>
        <SpinnerIcon size={24} weight="bold" className="spin" />
        <div className="muted" style={{ marginTop: 8 }}>Загрузка товаров WB…</div>
      </div>
    );
  }

  if (bundle.error) {
    return (
      <div className="card" style={{ background: 'var(--bg-danger, #fff0f0)', padding: 20 }}>
        <div style={{ fontWeight: 600, color: 'var(--danger, #d00)' }}>Ошибка загрузки WB</div>
        <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>{bundle.error}</div>
        <button className="btn btn-sm" style={{ marginTop: 10 }} onClick={bundle.refresh}>Повторить</button>
      </div>
    );
  }

  const rows: Row[] = bundle.prices.slice(0, limit).map((p) => ({
    ...p,
    card: cards.get(p.nmId),
  }));

  if (!rows.length) {
    return (
      <div className="card">
        <div className="muted" style={{ textAlign: 'center', padding: 20 }}>Нет данных о товарах</div>
      </div>
    );
  }

  return (
    <div className="card">
      <div className="flex-between" style={{ marginBottom: 14 }}>
        <h2 style={{ margin: 0 }}>Каталог WB · {rows.length} SKU</h2>
        <button className="btn btn-sm" onClick={bundle.refresh} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <ArrowClockwiseIcon size={14} weight="bold" /> Обновить
        </button>
      </div>

      <table>
        <thead>
          <tr>
            <th style={{ width: 44 }}></th>
            <th>Артикул</th>
            <th>Название</th>
            <th className="right">Цена</th>
            <th className="right">Скидка</th>
            <th className="right">Цена со скидкой</th>
            <th className="right">WB Club</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const photo = r.card?.photos?.[0]?.c246x328 || r.card?.photos?.[0]?.big;
            const mainSize = r.sizes?.[0];
            return (
              <tr key={r.nmId}>
                <td>
                  {photo ? (
                    <img
                      src={photo}
                      alt=""
                      style={{ width: 36, height: 48, objectFit: 'cover', borderRadius: 6 }}
                    />
                  ) : (
                    <div
                      style={{
                        width: 36,
                        height: 48,
                        borderRadius: 6,
                        background: 'var(--bg-subtle, #f4f4f5)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      <ImageIcon size={16} weight="light" style={{ color: 'var(--muted)' }} />
                    </div>
                  )}
                </td>
                <td>
                  <code style={{ fontSize: 12 }}>{r.vendorCode}</code>
                  <div className="muted" style={{ fontSize: 11 }}>nm{r.nmId}</div>
                </td>
                <td style={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {r.card?.title || r.card?.subjectName || '—'}
                </td>
                <td className="right">
                  {mainSize ? fmt(mainSize.price) : '—'}
                </td>
                <td className="right">
                  <span className="chip warn" style={{ fontSize: 12, padding: '2px 8px' }}>
                    −{r.discount}%
                  </span>
                </td>
                <td className="right">
                  <b>{mainSize ? fmt(mainSize.discountedPrice) : '—'}</b>
                </td>
                <td className="right">
                  {mainSize?.clubDiscountedPrice
                    ? <span style={{ color: 'var(--accent-2)' }}>{fmt(mainSize.clubDiscountedPrice)}</span>
                    : <span className="muted">—</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {bundle.fetchedAt && (
        <div className="muted" style={{ fontSize: 11, marginTop: 8, textAlign: 'right' }}>
          Данные на {bundle.fetchedAt.toLocaleTimeString('ru-RU')}
        </div>
      )}
    </div>
  );
}
