import { useEffect, useMemo, useState } from 'react';
import { SpinnerIcon, ArrowsClockwiseIcon, WarningIcon, BellIcon } from '@phosphor-icons/react';
import { useProcurement } from '../api/useProcurement';
import { wbSupplierOrders, WbOrder, localDateStr } from '../api/marketplaces';
import { fmtRangeRu } from '../api/useLiveOzon';
import { roiStatus, ROI_STATUS_COLOR } from '../utils/roiLogic';
import { AiAdvice } from './AiAdvice';

// ROI по ВБ. Все деньги (ROI, маржинальная прибыль/ед и /нед, цена, себестоимость)
// — из листа «Маржа» (финансист), колонки N/Q/R/J/K. Никакой API ВБ для этого не
// нужен. Из API ВБ — только заказы за 7 дней (statistics orders, cron-кэш).

const num = (v: any) => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
const fmt = (v: any) => num(v).toLocaleString('ru-RU') + ' ₽';

export function LiveWbRoi() {
  const sheets = useProcurement();
  const [roiThreshold, setRoiThreshold] = useState(20);
  const [orders, setOrders] = useState<{ bySku: Map<string, number>; loading: boolean; error?: string }>({ bySku: new Map(), loading: true });

  // Окно как у Озона: 7 полных суток по вчера включительно.
  const from = localDateStr(7);
  const to = localDateStr(1);

  useEffect(() => {
    let alive = true;
    setOrders((o) => ({ ...o, loading: true }));
    wbSupplierOrders(from)
      .then((rows: WbOrder[]) => {
        if (!alive) return;
        const m = new Map<string, number>();
        for (const o of rows) {
          const d = (o.date || '').slice(0, 10);
          if (d < from || d > to) continue;      // строго 7 суток по вчера
          if (o.isCancel) continue;               // отмены не считаем
          const sku = String(o.supplierArticle || '').trim().toUpperCase();
          if (!sku) continue;
          m.set(sku, (m.get(sku) ?? 0) + 1);
        }
        setOrders({ bySku: m, loading: false });
      })
      .catch((e: any) => { if (alive) setOrders({ bySku: new Map(), loading: false, error: String(e?.message ?? e) }); });
    return () => { alive = false; };
  }, [from, to]);

  // Актуальная неделя листа (максимальная по всем SKU) — старые недели не показываем.
  const currentWeek = useMemo(() => {
    let mx = 0;
    for (const p of sheets.items) if (p.marzhaWeekWb && p.marzhaWeekWb > mx) mx = p.marzhaWeekWb;
    return mx || null;
  }, [sheets.items]);

  // Товары с данными ВБ из «Маржи»; в наличии на ВБ ИЛИ с продажами за период.
  const rows = useMemo(() => sheets.items
    .filter((p) => p.roiWbMarzha != null || p.profitUnitWb != null)
    .map((p) => {
      const sku = p.sku.toUpperCase();
      const ordersCnt = orders.bySku.get(sku) ?? 0;
      return {
        p,
        sku: p.sku,
        price: p.priceWB ?? null,                 // цена товара ВБ (кол.J)
        cost: p.purchasePrice || 0,               // себестоимость (кол.K через закупки)
        margin: p.marginWB,                       // маржа % (кол.L)
        roi: p.roiWbMarzha ?? 0,                  // ROI (кол.N)
        profitUnit: p.profitUnitWb ?? 0,          // прибыль/ед (кол.Q)
        // прибыль/нед (кол.R) — только если строка из АКТУАЛЬНОЙ недели; старую
        // недельную прибыль не показываем, чтобы не смешивать периоды.
        profitWeek: (currentWeek != null && p.marzhaWeekWb === currentWeek) ? (p.profitWeekWb ?? 0) : 0,
        ordersCnt,
        inStock: p.stockWB > 0,
        isCurrentWeek: currentWeek != null && p.marzhaWeekWb === currentWeek,
      };
    })
    // Показываем: строки АКТУАЛЬНОЙ недели «Маржи» (финансист занёс на этой неделе),
    // плюс товары в наличии на ВБ или с заказами за окно. Старые недели не тянем.
    .filter((x) => x.isCurrentWeek || x.inStock || x.ordersCnt > 0)
    .sort((a, b) => b.profitWeek - a.profitWeek),
  [sheets.items, orders.bySku, currentWeek]);

  const marzhaWeek = currentWeek;

  const totals = useMemo(() => {
    const profit = rows.reduce((s, x) => s + x.profitWeek, 0);
    const cogs = rows.reduce((s, x) => s + x.ordersCnt * x.cost, 0);
    const avgRoi = cogs > 0 ? (profit / cogs) * 100 : (rows.length ? rows.reduce((s, x) => s + x.roi, 0) / rows.length : 0);
    return { profit, avgRoi };
  }, [rows]);

  const alertsCount = rows.filter((x) => x.roi < roiThreshold).length;
  const loading = sheets.loading || orders.loading;

  const adviceContext = useMemo(() => ({
    площадка: 'Wildberries', период: `7 дней (${fmtRangeRu(from, to)})`,
    порог_ROI: roiThreshold, средний_ROI: +totals.avgRoi.toFixed(1),
    маржприбыль_нед: Math.round(totals.profit),
    строки: rows.slice(0, 20).map((x) => ({ sku: x.sku, roi: +x.roi.toFixed(1), приб_шт: Math.round(x.profitUnit), приб_нед: Math.round(x.profitWeek), заказов: x.ordersCnt })),
  }), [rows, roiThreshold, totals, from, to]);

  return (
    <div className="grid" style={{ gap: 20 }}>
      <div className="flex-between" style={{ flexWrap: 'wrap', gap: 12 }}>
        <div className="row gap-8" style={{ flexWrap: 'wrap' }}>
          {loading && rows.length === 0
            ? <span className="chip info"><SpinnerIcon size={11} weight="bold" className="spin" /> загрузка…</span>
            : <>
                <span className="chip good">{rows.length} товаров ВБ</span>
                <span className="chip info">заказы: 7 дней ({fmtRangeRu(from, to)})</span>
                <span className={`chip ${totals.avgRoi >= roiThreshold ? 'good' : 'bad'}`}>средний ROI: {totals.avgRoi.toFixed(1)}%</span>
                {marzhaWeek && <span className="chip" title="ROI и прибыль — из листа «Маржа». Финансист обновляет его раз в неделю.">данные листа «Маржа»: неделя {marzhaWeek}</span>}
              </>
          }
        </div>
        <button className="btn btn-sm" onClick={sheets.reload} disabled={sheets.loading}>
          {sheets.loading ? <SpinnerIcon size={13} weight="bold" className="spin" /> : <ArrowsClockwiseIcon size={13} weight="bold" />}
          Обновить
        </button>
      </div>

      <div className="card" style={{ background: 'var(--accent-soft)' }}>
        <div className="row gap-12" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
          <label className="field-label" style={{ margin: 0 }}>Порог алерта ROI · подсвечиваем всё, что ниже</label>
          <div className="row" style={{ gap: 10, flex: 1, minWidth: 240 }}>
            <input type="range" min={0} max={250} step={5} value={roiThreshold} onChange={(e) => setRoiThreshold(+e.target.value)} style={{ flex: 1 }} />
            <input className="input" type="number" value={roiThreshold} min={0} max={250} onChange={(e) => setRoiThreshold(+e.target.value)} style={{ width: 70 }} />
            <span className="muted">%</span>
          </div>
        </div>
      </div>

      {orders.error && (
        <div className="card" style={{ background: 'rgba(217,119,6,.06)', display: 'flex', gap: 10 }}>
          <WarningIcon size={18} weight="bold" style={{ color: 'var(--warn)' }} />
          <div className="muted" style={{ fontSize: 13 }}>Заказы ВБ временно недоступны ({orders.error}) — деньги из «Маржи» показываем, колонка «Заказов» будет по нулям.</div>
        </div>
      )}

      {rows.length > 0 && (
        <>
          <div className="grid grid-2">
            <div className="card kpi" style={{ background: totals.profit >= 0 ? 'rgba(22,163,74,.08)' : 'rgba(220,38,38,.08)' }}>
              <div className="card-title">Маржинальная прибыль · неделя</div>
              <div className="v" style={{ color: totals.profit >= 0 ? 'var(--good)' : 'var(--bad)' }}>{fmt(totals.profit)}</div>
              <div className="d">ROI: <b>{totals.avgRoi.toFixed(1)}%</b> · из листа «Маржа»</div>
            </div>
            <div className="card kpi">
              <div className="card-title">Ниже порога {roiThreshold}%</div>
              <div className="v" style={{ color: alertsCount ? 'var(--bad)' : 'var(--good)' }}>{alertsCount} SKU</div>
              <div className="d muted">подсвечены в таблице</div>
            </div>
          </div>

          <AiAdvice module="roi" context={adviceContext} disabled={rows.length === 0} />

          <div className="card">
            <div className="flex-between" style={{ marginBottom: 12 }}>
              <h2 style={{ margin: 0 }}>Все SKU ВБ · ROI и прибыль · 7 дней ({fmtRangeRu(from, to)})</h2>
              {alertsCount > 0
                ? <span className="chip bad"><BellIcon size={11} weight="bold" /> {alertsCount} ниже порога {roiThreshold}%</span>
                : <span className="chip good">все выше порога {roiThreshold}%</span>}
            </div>
            <div style={{ overflowX: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th>Артикул</th>
                  <th className="right" title="Цена товара ВБ — из листа «Маржа» (кол. J)">Цена</th>
                  <th className="right" title="Себестоимость — из листа «Маржа» (кол. K)">Себест.</th>
                  <th className="right" title="Маржа после вычета налога, % (кол. L)">Маржа %</th>
                  <th className="right" title="Маржинальная прибыль на единицу (кол. Q)">Марж. прибыль / шт</th>
                  <th className="right" title="Маржинальная прибыль по артикулу за неделю (кол. R)">Прибыль · всего</th>
                  <th className="right" title="Заказы ВБ за 7 полных суток по вчера (без отмен)">Заказов</th>
                  <th className="right" title="ROI из листа «Маржа», последняя неделя (кол. N)">ROI</th>
                  <th>Коридор</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((x) => {
                  const corridor = x.cost > 0 ? roiStatus(x.roi, x.cost) : null;
                  const corridorStyle = corridor ? ROI_STATUS_COLOR[corridor.status] : null;
                  const isAlert = x.roi < roiThreshold;
                  return (
                    <tr key={x.sku} style={isAlert ? { background: 'rgba(220,38,38,.06)' } : undefined}>
                      <td className="muted" style={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12 }}>
                        {isAlert && <BellIcon size={11} weight="fill" style={{ color: 'var(--bad)', marginRight: 4, verticalAlign: -1 }} />}{x.sku}
                      </td>
                      <td className="right">{x.price != null ? fmt(x.price) : '—'}</td>
                      <td className="right muted">{x.cost ? fmt(x.cost) : '—'}</td>
                      <td className="right muted">{x.margin != null ? `${x.margin.toFixed(1)}%` : '—'}</td>
                      <td className="right" style={{ color: x.profitUnit < 0 ? 'var(--bad)' : 'var(--text)' }}>{fmt(x.profitUnit)}</td>
                      <td className="right"><b style={{ color: x.profitWeek >= 0 ? 'var(--good)' : 'var(--bad)' }}>{fmt(x.profitWeek)}</b></td>
                      <td className="right">{x.ordersCnt}</td>
                      <td className="right" style={{ color: isAlert ? 'var(--bad)' : 'var(--text)', fontWeight: 600 }}>{x.roi.toFixed(1)}%</td>
                      <td>
                        {corridor && corridorStyle ? (
                          <span
                            title={`Коридор себест ${corridor.bucket?.min}–${corridor.bucket?.max} ₽: цель ${corridor.bucket?.target}% · стоп ${corridor.bucket?.stopBuy}% · выход ${corridor.bucket?.exit}%`}
                            style={{ background: corridorStyle.bg, color: corridorStyle.color, padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 600 }}
                          >
                            {corridor.label}
                          </span>
                        ) : <span className="muted" style={{ fontSize: 11 }}>—</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            </div>
            <div className="muted" style={{ fontSize: 11.5, marginTop: 10 }}>
              Деньги (цена, себестоимость, маржа, прибыль, ROI) — из листа «Маржа», последняя неделя. Заказы — из ВБ (кэш, без отмен).
            </div>
          </div>
        </>
      )}

      {!loading && rows.length === 0 && (
        <div className="card" style={{ textAlign: 'center', color: 'var(--muted)', padding: 40 }}>
          В листе «Маржа» пока нет данных по ВБ (колонки N/Q/R) или нет товаров в наличии на ВБ.
        </div>
      )}
    </div>
  );
}
