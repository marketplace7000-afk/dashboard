import { Fragment, useMemo, useState } from 'react';
import { SpinnerIcon, ArrowsClockwiseIcon, WarningIcon, PercentIcon, InfoIcon, CaretDownIcon } from '@phosphor-icons/react';
import { CompetitorFinder } from './CompetitorFinder';
import { OzonPriceRow, OzonProductInfo } from '../api/marketplaces';
import { useLiveOzonBundle, productInfoIndex } from '../api/useLiveOzonCache';
import { useProcurement } from '../api/useProcurement';
import { AiAdvice } from './AiAdvice';

type Row = OzonPriceRow & {
  name?: string; primary_image?: string;
  lk?: number | null;      // цена ЛК из «ДРР и цены»
  buyer?: number | null;   // цена покупателя с СПП из «ДРР и цены»
  stock?: number;          // остаток Ozon
};

const num = (v: any) => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
const fmt = (v: any) => num(v).toLocaleString('ru-RU') + ' ₽';

// Реальная цена, которую платит покупатель (зелёная по Ozon-кошельку → серая со
// скидкой площадки → прайс-листовая). Прайс-листовая r.price.price из-за акций
// Ozon бывает сильно выше реальной — нельзя брать её как «нашу цену» в сравнении.
const buyerPrice = (r: OzonPriceRow) =>
  num(r.price.marketing_seller_price) || num((r.price as any).marketing_price) || num(r.price.price);

export function LiveOzonPromos() {
  const bundle = useLiveOzonBundle();
  const procurement = useProcurement();
  // Раскрытие «Найти конкурентов» по строке в блоке «Мы дороже минимума».
  const [compOpen, setCompOpen] = useState<Record<number, boolean>>({});

  const procByOffer = useMemo(() => {
    const m = new Map<string, typeof procurement.items[number]>();
    for (const p of procurement.items) m.set(p.sku.toUpperCase(), p);
    return m;
  }, [procurement.items]);

  const rows: Row[] = useMemo(() => {
    const byId = productInfoIndex(bundle);
    return bundle.prices.map((p) => {
      const meta = byId.get(p.product_id) as OzonProductInfo | undefined;
      const proc = procByOffer.get(String(p.offer_id || '').trim().toUpperCase());
      return {
        ...p, name: meta?.name, primary_image: meta?.primary_image,
        lk: proc?.lkPriceOzon ?? null,
        buyer: proc?.buyerPriceOzon ?? null,
        stock: proc?.stockOzon ?? 0,
      };
    });
  }, [bundle, procByOffer]);

  // Товары В НАЛИЧИИ с ценами из «ДРР и цены» + % СПП (насколько площадка снижает
  // цену покупателю относительно ЛК). Клиент: показывать только актуальные товары.
  const inStock = rows
    .filter((r) => (r.stock ?? 0) > 0)
    .map((r) => {
      const lk = num(r.lk) || num(r.price.price);
      const buyer = num(r.buyer) || lk;
      const sppPct = lk > 0 && buyer > 0 && buyer < lk ? ((lk - buyer) / lk) * 100 : 0;
      return { r, lk, buyer, sppPct };
    })
    .sort((a, b) => b.sppPct - a.sppPct);

  // Показываем ТОЛЬКО товары в наличии (как остальной раздел) и отсекаем мусор
  // индекса Ozon: он часто отдаёт абсурдный «внешн. min» (напр. 1 331 ₽ против
  // нашей 30 000 ₽). Требуем, чтобы внешняя цена была не ниже 40% нашей и разрыв
  // не больше 60% — иначе это почти наверняка артефакт индекса, а не реальная цена.
  const marketDiscounts = rows
    .filter((r) => (r.stock ?? 0) > 0)
    .map((r) => {
      const my = num(r.buyer) || buyerPrice(r);
      const extMin = num(r.price_indexes.external_index_data.min_price);
      return { r, my, extMin, gapPct: my > 0 ? ((my - extMin) / my) * 100 : 0 };
    })
    .filter(({ my, extMin, gapPct }) => extMin > 0 && my > 0 && extMin < my * 0.95 && extMin >= my * 0.4 && gapPct <= 60)
    .sort((a, b) => b.gapPct - a.gapPct)
    .slice(0, 15);

  const adviceContext = useMemo(() => ({
    товаров_в_наличии: inStock.length,
    со_скидкой_СПП: inStock.filter((x) => x.sppPct > 0).length,
    строки: inStock.slice(0, 20).map((x) => ({ sku: x.r.offer_id, цена_ЛК: Math.round(x.lk), цена_СПП: Math.round(x.buyer), спп_пр: +x.sppPct.toFixed(0) })),
    дешевле_у_конкурентов: marketDiscounts.slice(0, 10).map((x) => ({ sku: x.r.offer_id, наша: Math.round(x.my), внешн_мин: Math.round(x.extMin), разрыв_пр: +x.gapPct.toFixed(1) })),
  }), [inStock, marketDiscounts]);

  return (
    <div className="grid" style={{ gap: 20 }}>
      <div className="flex-between">
        <div className="row gap-8">
          {bundle.loading && bundle.fetchedAt == null
            ? <span className="chip info"><SpinnerIcon size={11} weight="bold" className="spin" /> загрузка…</span>
            : <>
                <span className="chip info">{inStock.length} товаров в наличии</span>
                <span className="chip good"><PercentIcon size={11} weight="bold" /> {inStock.filter(x => x.sppPct > 0).length} со скидкой площадки (СПП)</span>
                <span className="chip warn">{marketDiscounts.length} дешевле у конкурентов</span>
              </>
          }
        </div>
        <button className="btn btn-sm" onClick={bundle.refresh} disabled={bundle.loading}>
          {bundle.loading
            ? <SpinnerIcon size={13} weight="bold" className="spin" />
            : <ArrowsClockwiseIcon size={13} weight="bold" />}
          Обновить
        </button>
      </div>

      {bundle.error && (
        <div className="card" style={{ background: 'rgba(220,38,38,.08)', display: 'flex', gap: 10 }}>
          <WarningIcon size={18} weight="bold" style={{ color: 'var(--bad)' }} />
          <div className="muted">{bundle.error}</div>
        </div>
      )}

      {rows.length > 0 && (
        <>
          <div className="card" style={{ display: 'flex', gap: 10, background: 'var(--accent-soft)' }}>
            <InfoIcon size={18} weight="bold" style={{ color: 'var(--accent)', flexShrink: 0, marginTop: 2 }} />
            <div style={{ fontSize: 13, color: 'var(--accent-2)', lineHeight: 1.6 }}>
              Только товары <b>в наличии</b>. <b>Цена ЛК</b> — что стоит в кабинете, <b>Цена с СПП</b> —
              что реально платит покупатель (из «ДРР и цены»), <b>% СПП</b> — насколько Ozon снижает
              цену за свой счёт. Высокий % СПП = товар в акции площадки.
            </div>
          </div>

          <AiAdvice module="promos" context={adviceContext} disabled={inStock.length === 0} />

          {inStock.length > 0 && (
            <div className="card">
              <div className="flex-between" style={{ marginBottom: 12 }}>
                <h2 style={{ margin: 0 }}>Цены и СПП · товары в наличии</h2>
                <span className="chip good">{inStock.length} SKU</span>
              </div>
              <table>
                <thead>
                  <tr>
                    <th></th>
                    <th>Артикул</th>
                    <th>Товар</th>
                    <th className="right" title="Цена в личном кабинете">Цена ЛК</th>
                    <th className="right" title="Цена покупателя с учётом СПП (из «ДРР и цены»)">Цена с СПП</th>
                    <th className="right" title="Скидка за счёт площадки: (ЛК − цена с СПП) / ЛК">% СПП</th>
                  </tr>
                </thead>
                <tbody>
                  {inStock.map(({ r, lk, buyer, sppPct }) => (
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
                      <td className="right muted">{fmt(lk)}</td>
                      <td className="right"><b style={{ color: 'var(--good)' }}>{fmt(buyer)}</b></td>
                      <td className="right">{sppPct > 0 ? <span className="chip good">−{sppPct.toFixed(0)}%</span> : <span className="muted">—</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {marketDiscounts.length > 0 && (
            <div className="card" style={{ background: 'rgba(217,119,6,.04)' }}>
              <div className="flex-between" style={{ marginBottom: 12 }}>
                <div>
                  <h2 style={{ margin: 0 }}>Мы дороже минимума по рынку · &gt;5%</h2>
                  <div className="muted" style={{ fontSize: 11.5, marginTop: 2 }}>
                    По данным Ozon (агрегированный минимум по площадкам, без ссылок). Источник не всегда точен — проверяйте вручную.
                  </div>
                </div>
                <span className="chip warn">{marketDiscounts.length} SKU</span>
              </div>
              <table>
                <thead>
                  <tr>
                    <th></th>
                    <th>Артикул</th>
                    <th>Товар</th>
                    <th className="right" title="Реальная цена покупателя (с учётом акций/кошелька Ozon), а не прайс-листовая">Моя цена</th>
                    <th className="right">Внешн. min</th>
                    <th className="right">Разрыв</th>
                  </tr>
                </thead>
                <tbody>
                  {marketDiscounts.map(({ r, my, extMin, gapPct }) => (
                    <Fragment key={r.product_id}>
                    <tr style={{ cursor: 'pointer' }} onClick={() => setCompOpen((s) => ({ ...s, [r.product_id]: !s[r.product_id] }))}>
                      <td style={{ width: 36 }}>
                        {r.primary_image
                          ? <img src={r.primary_image} alt="" style={{ width: 28, height: 28, borderRadius: 6, objectFit: 'cover' }} />
                          : <div style={{ width: 28, height: 28, borderRadius: 6, background: 'var(--bg-2)' }} />}
                      </td>
                      <td className="muted" style={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12 }}>{r.offer_id}</td>
                      <td style={{ maxWidth: 360, fontSize: 13 }}>
                        <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>{r.name ?? '—'}</div>
                      </td>
                      <td className="right"><b>{fmt(my)}</b></td>
                      <td className="right muted">{fmt(extMin)}</td>
                      <td className="right" style={{ color: 'var(--warn)' }}>−{gapPct.toFixed(1)}% <CaretDownIcon size={11} weight="bold" style={{ verticalAlign: -1, transform: compOpen[r.product_id] ? 'rotate(180deg)' : 'none' }} /></td>
                    </tr>
                    {compOpen[r.product_id] && (
                      <tr>
                        <td colSpan={6} style={{ background: 'var(--bg-3)', padding: '10px 14px' }}>
                          <CompetitorFinder query={r.name || r.offer_id} myPrice={my} />
                        </td>
                      </tr>
                    )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
