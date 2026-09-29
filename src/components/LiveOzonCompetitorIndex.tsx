import { useMemo, useState } from 'react';
import { SpinnerIcon, ArrowsClockwiseIcon, WarningIcon, InfoIcon } from '@phosphor-icons/react';
import { OzonPriceRow, OzonProductInfo } from '../api/marketplaces';
import { useLiveOzonBundle, productInfoIndex } from '../api/useLiveOzonCache';

type Row = OzonPriceRow & { name?: string; primary_image?: string };

const num = (v: any) => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
const fmt = (v: any) => num(v).toLocaleString('ru-RU') + ' ₽';

type BucketKey = 'SUPER' | 'GREEN' | 'YELLOW' | 'RED' | 'WITHOUT_INDEX';

const BUCKETS: { key: BucketKey; label: string; desc: string; color: string; cls: 'good' | 'warn' | 'bad' | '' }[] = [
  { key: 'SUPER',         label: 'Хит цены',         desc: 'мы существенно дешевле рынка', color: '#16a34a', cls: 'good' },
  { key: 'GREEN',         label: 'Дешевле рынка',    desc: 'наша цена ниже среднего',      color: '#22c55e', cls: 'good' },
  { key: 'YELLOW',        label: 'На уровне рынка',  desc: 'мы рядом с конкурентами',      color: '#d97706', cls: 'warn' },
  { key: 'RED',           label: 'Дороже рынка',     desc: 'снижает конкурентоспособность', color: '#dc2626', cls: 'bad'  },
  { key: 'WITHOUT_INDEX', label: 'Без данных рынка', desc: 'Ozon не подобрал аналоги',     color: '#94a3b8', cls: ''     },
];

function priceIndex(r: Row): number {
  return num((r as any).price_indexes.external_index_data?.price_index_value)
      || num((r as any).price_indexes.self_marketplaces_index_data?.price_index_value);
}

export function LiveOzonCompetitorIndex() {
  const bundle = useLiveOzonBundle();
  const [filter, setFilter] = useState<BucketKey | 'WITH_DATA'>('WITH_DATA');

  const rows: Row[] = useMemo(() => {
    const byId = productInfoIndex(bundle);
    return bundle.prices.map((p) => {
      const meta = byId.get(p.product_id) as OzonProductInfo | undefined;
      return { ...p, name: meta?.name, primary_image: meta?.primary_image };
    });
  }, [bundle]);

  const loading = bundle.loading && bundle.fetchedAt == null;
  const error = bundle.error;
  const load = bundle.refresh;

  const buckets = BUCKETS.map((b) => ({
    ...b,
    count: rows.filter((r) => (r.price_indexes.color_index || 'WITHOUT_INDEX') === b.key).length,
  }));
  const withIndexCount = rows.length - buckets.find((b) => b.key === 'WITHOUT_INDEX')!.count;

  const visibleRows = useMemo(() => {
    const filtered = filter === 'WITH_DATA'
      ? rows.filter((r) => r.price_indexes.color_index && r.price_indexes.color_index !== 'WITHOUT_INDEX')
      : rows.filter((r) => (r.price_indexes.color_index || 'WITHOUT_INDEX') === filter);
    // сортировка: от самых дешёвых относительно рынка к самым дорогим
    return filtered.slice().sort((a, b) => priceIndex(a) - priceIndex(b));
  }, [rows, filter]);

  const avgIndex = useMemo(() => {
    const withData = rows.filter((r) => priceIndex(r) > 0);
    if (!withData.length) return 0;
    return withData.reduce((s, r) => s + priceIndex(r), 0) / withData.length;
  }, [rows]);

  return (
    <div className="grid" style={{ gap: 20 }}>
      <div className="flex-between">
        <div className="row gap-8">
          {!loading && (
            <span className="chip info">
              {rows.length} SKU всего · {withIndexCount} с данными рынка ({Math.round((withIndexCount / Math.max(1, rows.length)) * 100)}%)
            </span>
          )}
          {!loading && avgIndex > 0 && (
            <span className={`chip ${avgIndex > 1.05 ? 'bad' : avgIndex < 0.95 ? 'good' : 'warn'}`}>
              средний индекс: {avgIndex.toFixed(2)} ({avgIndex > 1 ? `+${((avgIndex - 1) * 100).toFixed(1)}% к рынку` : `−${((1 - avgIndex) * 100).toFixed(1)}% к рынку`})
            </span>
          )}
        </div>
        <button className="btn btn-sm" onClick={load} disabled={loading}>
          {loading
            ? <SpinnerIcon size={13} weight="bold" className="spin" />
            : <ArrowsClockwiseIcon size={13} weight="bold" />}
          Обновить
        </button>
      </div>

      {error && (
        <div className="card" style={{ display: 'flex', gap: 10, background: 'rgba(220,38,38,.08)' }}>
          <WarningIcon size={18} weight="bold" style={{ color: 'var(--bad)' }} />
          <div className="muted">{error}</div>
        </div>
      )}

      {loading && rows.length === 0 && (
        <div className="card muted" style={{ padding: 30, textAlign: 'center' }}>
          <SpinnerIcon size={20} weight="bold" className="spin" /> Тянем индексы цен по всему ассортименту…
        </div>
      )}

      {rows.length > 0 && (
        <>
          <div className="grid grid-4">
            {buckets.filter((b) => b.key !== 'WITHOUT_INDEX').map((b) => (
              <div
                key={b.key}
                className="card kpi"
                onClick={() => setFilter(b.key)}
                style={{
                  cursor: 'pointer',
                  outline: filter === b.key ? `2px solid ${b.color}` : 'none',
                }}
              >
                <div className="card-title" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ width: 10, height: 10, borderRadius: 2, background: b.color }} />
                  {b.label}
                </div>
                <div className="v">{b.count}</div>
                <div className="d muted">{b.desc}</div>
              </div>
            ))}
          </div>

          <div className="card" style={{ display: 'flex', gap: 10, background: 'var(--accent-soft)' }}>
            <InfoIcon size={18} weight="bold" style={{ color: 'var(--accent)', flexShrink: 0, marginTop: 2 }} />
            <div style={{ fontSize: 13, color: 'var(--accent-2)' }}>
              <b>{buckets.find((b) => b.key === 'WITHOUT_INDEX')!.count} SKU из {rows.length}</b> Ozon
              не смог сопоставить с аналогами на других площадках (нет валидного матча по EAN/штрихкоду).
              Это нормально для нишевых автотоваров — индекс работает по точным дубликатам. Для полного
              покрытия конкурентного анализа нужен собственный парсер выдачи (выходит за MVP).
            </div>
          </div>

          <div className="card">
            <div className="flex-between" style={{ marginBottom: 12 }}>
              <h2 style={{ margin: 0 }}>Распределение по индексу цены Ozon</h2>
            </div>
            <div style={{ display: 'flex', height: 32, borderRadius: 8, overflow: 'hidden' }}>
              {buckets.filter((b) => b.count > 0).map((b) => (
                <div key={b.key} title={`${b.label} · ${b.count}`} style={{
                  flex: b.count,
                  background: b.color,
                  display: 'grid', placeItems: 'center',
                  color: '#fff', fontSize: 12, fontWeight: 600,
                }}>
                  {b.count}
                </div>
              ))}
            </div>
            <div className="row gap-12" style={{ marginTop: 10, flexWrap: 'wrap' }}>
              {buckets.filter((b) => b.count > 0).map((b) => (
                <div key={b.key} className="row" style={{ gap: 6, fontSize: 12 }}>
                  <span style={{ width: 10, height: 10, borderRadius: 2, background: b.color }} />
                  <span className="muted">{b.label} · {b.count}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="card">
            <div className="flex-between" style={{ marginBottom: 14 }}>
              <h2 style={{ margin: 0 }}>SKU с данными рынка</h2>
              <div className="row gap-8" style={{ flexWrap: 'wrap' }}>
                <button
                  className={`mp-tab ${filter === 'WITH_DATA' ? 'active' : ''}`}
                  onClick={() => setFilter('WITH_DATA')}
                >
                  Все с данными
                  <span className="muted" style={{ marginLeft: 6 }}>{withIndexCount}</span>
                </button>
                {BUCKETS.filter((b) => b.key !== 'WITHOUT_INDEX').map((b) => {
                  const cnt = buckets.find((x) => x.key === b.key)!.count;
                  return (
                    <button
                      key={b.key}
                      className={`mp-tab ${filter === b.key ? 'active' : ''}`}
                      onClick={() => setFilter(b.key)}
                      disabled={cnt === 0}
                      style={{ opacity: cnt === 0 ? 0.45 : 1, cursor: cnt === 0 ? 'not-allowed' : 'pointer' }}
                    >
                      <span className="mp-tab-dot" style={{ background: b.color }} />
                      {b.label}
                      <span className="muted" style={{ marginLeft: 6 }}>{cnt}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {visibleRows.length === 0 ? (
              <div className="muted" style={{ padding: 24, textAlign: 'center' }}>
                В этой категории нет товаров.
              </div>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th></th>
                    <th>Артикул</th>
                    <th>Товар</th>
                    <th className="right">Моя цена</th>
                    <th className="right">Реф. цена рынка</th>
                    <th className="right">Индекс</th>
                    <th className="right">К рынку</th>
                    <th>Категория</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleRows.map((r) => {
                    const idx = priceIndex(r);
                    const pctVsMarket = idx > 0 ? (idx - 1) * 100 : 0;
                    const colorKey = (r.price_indexes.color_index || 'WITHOUT_INDEX') as BucketKey;
                    const b = BUCKETS.find((x) => x.key === colorKey)!;
                    const isAbove = idx > 1;
                    const isBelow = idx > 0 && idx < 1;
                    const myPrice = num(r.price.price);
                    const refMarket = idx > 0 ? Math.round(myPrice / idx) : 0;
                    return (
                      <tr key={r.product_id}>
                        <td style={{ width: 44 }}>
                          {r.primary_image
                            ? <img src={r.primary_image} alt="" style={{ width: 32, height: 32, borderRadius: 6, objectFit: 'cover' }} />
                            : <div style={{ width: 32, height: 32, borderRadius: 6, background: 'var(--bg-2)' }} />}
                        </td>
                        <td className="muted" style={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12 }}>{r.offer_id}</td>
                        <td style={{ maxWidth: 360, fontSize: 13 }}>
                          <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
                            {r.name ?? '—'}
                          </div>
                        </td>
                        <td className="right"><b>{fmt(myPrice)}</b></td>
                        <td className="right muted" title="Рассчитано: моя цена / индекс Ozon. Это нормализованный рынок, не raw-минимум среди аналогов">
                          {refMarket > 0 ? fmt(refMarket) : '—'}
                        </td>
                        <td className="right" style={{ color: isAbove ? 'var(--bad)' : isBelow ? 'var(--good)' : 'var(--muted)' }}>
                          {idx > 0 ? idx.toFixed(2) : '—'}
                        </td>
                        <td className="right" style={{ color: isAbove ? 'var(--bad)' : isBelow ? 'var(--good)' : 'var(--muted)' }}>
                          {idx > 0
                            ? (isAbove ? `+${pctVsMarket.toFixed(1)}%` : isBelow ? `−${(-pctVsMarket).toFixed(1)}%` : '0%')
                            : '—'}
                        </td>
                        <td>
                          {b.cls
                            ? <span className={`chip ${b.cls}`}>{b.label}</span>
                            : <span className="muted">{b.label}</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}

            <div className="muted" style={{ fontSize: 11.5, marginTop: 12, lineHeight: 1.7 }}>
              <b>Индекс</b> — нормализованный показатель Ozon (1.0 = на уровне рынка, &gt;1.0 = дороже,
              &lt;1.0 = дешевле).<br />
              <b>Реф. цена рынка</b> — рассчитано как «моя цена / индекс». Это и есть калиброванная Ozon
              цена сопоставимых товаров. Карточки сверху кликабельны — фильтруют таблицу.
            </div>
          </div>
        </>
      )}
    </div>
  );
}
