import { useMemo, useState } from 'react';
import { SpinnerIcon, ArrowsClockwiseIcon, WarningIcon, PackageIcon, BellIcon } from '@phosphor-icons/react';
import { OzonStockRow, OzonProductInfo } from '../api/marketplaces';
import { useLiveOzonBundle, productInfoIndex } from '../api/useLiveOzonCache';

type Row = OzonStockRow & {
  name?: string;
  primary_image?: string;
  fbo: number;
  fbs: number;
  total: number;
  reserved: number;
  dailySales?: number;
  daysLeft?: number;
};

export function LiveOzonStocks() {
  const bundle = useLiveOzonBundle();
  const [threshold, setThreshold] = useState(14);

  const rows: Row[] = useMemo(() => {
    const byId = productInfoIndex(bundle);
    const salesByPid = new Map<number, number>();
    for (const t of bundle.topByMonth) {
      const pid = bundle.skuToPid.get(t.sku);
      if (!pid) continue;
      salesByPid.set(pid, (salesByPid.get(pid) ?? 0) + t.orders);
    }

    return bundle.stocks.map((s) => {
      const meta = byId.get(s.product_id) as OzonProductInfo | undefined;
      const fbo = s.stocks.filter((x) => x.type === 'fbo').reduce((a, b) => a + (b.present ?? 0), 0);
      const fbs = s.stocks.filter((x) => x.type === 'fbs').reduce((a, b) => a + (b.present ?? 0), 0);
      const reserved = s.stocks.reduce((a, b) => a + (b.reserved ?? 0), 0);
      const total = fbo + fbs;
      const salesPerDay = (salesByPid.get(s.product_id) ?? 0) / 30;
      const daysLeft = salesPerDay > 0 ? Math.floor(total / salesPerDay) : undefined;
      return {
        ...s,
        name: meta?.name,
        primary_image: meta?.primary_image,
        fbo, fbs, total, reserved,
        dailySales: salesPerDay,
        daysLeft,
      };
    });
  }, [bundle]);

  const critical = useMemo(
    () => rows
      .filter((r) => r.daysLeft != null && r.daysLeft <= threshold && (r.dailySales ?? 0) > 0)
      .sort((a, b) => (a.daysLeft ?? 0) - (b.daysLeft ?? 0)),
    [rows, threshold]
  );
  const outOfStock = rows.filter((r) => r.total === 0 && (r.dailySales ?? 0) > 0);
  const totalUnits = rows.reduce((s, r) => s + r.total, 0);
  const fboUnits = rows.reduce((s, r) => s + r.fbo, 0);
  const fbsUnits = rows.reduce((s, r) => s + r.fbs, 0);
  const withStock = rows.filter((r) => r.total > 0).length;

  return (
    <div className="grid" style={{ gap: 20 }}>
      <div className="flex-between" style={{ flexWrap: 'wrap', gap: 12 }}>
        <div className="row gap-8">
          {bundle.loading && bundle.fetchedAt == null
            ? <span className="chip info"><SpinnerIcon size={11} weight="bold" className="spin" /> загрузка…</span>
            : <>
                <span className="chip info">{rows.length} SKU всего · {withStock} с остатком</span>
                {outOfStock.length > 0 && (
                  <span className="chip bad">
                    <BellIcon size={11} weight="bold" /> {outOfStock.length} продаются, но out-of-stock
                  </span>
                )}
                {critical.length > 0 && (
                  <span className="chip warn">
                    <BellIcon size={11} weight="bold" /> {critical.length} закончатся за ≤ {threshold} дней
                  </span>
                )}
              </>
          }
        </div>
        <div className="row gap-8">
          <div className="row" style={{ gap: 8 }}>
            <span className="muted" style={{ fontSize: 12 }}>Порог дней:</span>
            <input className="input" type="number" value={threshold} onChange={(e) => setThreshold(+e.target.value)} style={{ width: 70 }} />
          </div>
          <button className="btn btn-sm" onClick={bundle.refresh} disabled={bundle.loading}>
            {bundle.loading
              ? <SpinnerIcon size={13} weight="bold" className="spin" />
              : <ArrowsClockwiseIcon size={13} weight="bold" />}
            Обновить
          </button>
        </div>
      </div>

      {bundle.error && (
        <div className="card" style={{ background: 'rgba(220,38,38,.08)', display: 'flex', gap: 10 }}>
          <WarningIcon size={18} weight="bold" style={{ color: 'var(--bad)' }} />
          <div className="muted">{bundle.error}</div>
        </div>
      )}

      {rows.length > 0 && (
        <>
          <div className="grid grid-4">
            <div className="card kpi">
              <div className="card-title">Всего единиц</div>
              <div className="v">{totalUnits}</div>
              <div className="d muted">{rows.length} SKU · {withStock} с остатком</div>
            </div>
            <div className="card kpi">
              <div className="card-title">FBO (склад Ozon)</div>
              <div className="v">{fboUnits}</div>
              <div className="d muted">{totalUnits > 0 ? Math.round((fboUnits / totalUnits) * 100) : 0}% от запасов</div>
            </div>
            <div className="card kpi">
              <div className="card-title">FBS (свой склад)</div>
              <div className="v">{fbsUnits}</div>
              <div className="d muted">{totalUnits > 0 ? Math.round((fbsUnits / totalUnits) * 100) : 0}% от запасов</div>
            </div>
            <div
              className="card kpi"
              style={{ background: critical.length > 0 ? 'rgba(217,119,6,.08)' : 'rgba(22,163,74,.08)' }}
            >
              <div className="card-title">Критический уровень</div>
              <div className="v" style={{ color: critical.length > 0 ? 'var(--warn)' : 'var(--good)' }}>{critical.length}</div>
              <div className="d muted">SKU закончатся за ≤ {threshold} дней</div>
            </div>
          </div>

          {outOfStock.length > 0 && (
            <div className="card" style={{ background: 'rgba(220,38,38,.04)' }}>
              <div className="flex-between" style={{ marginBottom: 12 }}>
                <h2 style={{ margin: 0, display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                  <BellIcon size={18} weight="fill" style={{ color: 'var(--bad)' }} />
                  Out of stock, но имеют продажи
                </h2>
                <span className="chip bad">{outOfStock.length} SKU</span>
              </div>
              <table>
                <thead>
                  <tr><th></th><th>Артикул</th><th>Товар</th><th className="right">Продаж/день (30д)</th></tr>
                </thead>
                <tbody>
                  {outOfStock.slice(0, 15).map((r) => (
                    <tr key={r.product_id}>
                      <td style={{ width: 36 }}>
                        {r.primary_image
                          ? <img src={r.primary_image} alt="" style={{ width: 28, height: 28, borderRadius: 6, objectFit: 'cover' }} />
                          : <div style={{ width: 28, height: 28, borderRadius: 6, background: 'var(--bg-2)' }} />}
                      </td>
                      <td className="muted" style={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12 }}>{r.offer_id}</td>
                      <td style={{ maxWidth: 360, fontSize: 13 }}>
                        <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>{r.name ?? '—'}</div>
                      </td>
                      <td className="right">{(r.dailySales ?? 0).toFixed(1)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {critical.length > 0 && (
            <div className="card" style={{ background: 'rgba(217,119,6,.04)' }}>
              <div className="flex-between" style={{ marginBottom: 12 }}>
                <h2 style={{ margin: 0, display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                  <PackageIcon size={18} weight="bold" style={{ color: 'var(--warn)' }} />
                  Прогноз окончания запасов
                </h2>
                <span className="chip warn">{critical.length} SKU</span>
              </div>
              <table>
                <thead>
                  <tr>
                    <th></th>
                    <th>Артикул</th>
                    <th>Товар</th>
                    <th className="right">FBO</th>
                    <th className="right">FBS</th>
                    <th className="right">Резерв</th>
                    <th className="right">Продаж/день</th>
                    <th className="right">Дней до 0</th>
                  </tr>
                </thead>
                <tbody>
                  {critical.map((r) => (
                    <tr key={r.product_id}>
                      <td style={{ width: 36 }}>
                        {r.primary_image
                          ? <img src={r.primary_image} alt="" style={{ width: 28, height: 28, borderRadius: 6, objectFit: 'cover' }} />
                          : <div style={{ width: 28, height: 28, borderRadius: 6, background: 'var(--bg-2)' }} />}
                      </td>
                      <td className="muted" style={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12 }}>{r.offer_id}</td>
                      <td style={{ maxWidth: 320, fontSize: 13 }}>
                        <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>{r.name ?? '—'}</div>
                      </td>
                      <td className="right">{r.fbo}</td>
                      <td className="right">{r.fbs}</td>
                      <td className="right muted">{r.reserved}</td>
                      <td className="right">{(r.dailySales ?? 0).toFixed(1)}</td>
                      <td className="right">
                        <span className={`chip ${(r.daysLeft ?? 0) <= 7 ? 'bad' : 'warn'}`}>
                          {r.daysLeft ?? '—'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="muted" style={{ fontSize: 11.5, marginTop: 10 }}>
                Прогноз = текущие остатки / средние продажи за 30 дней. Telegram-бот будет слать алерт
                за N дней до прогнозируемого окончания.
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
