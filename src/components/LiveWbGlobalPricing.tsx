/**
 * Лист «WB Global» в «Ценах» (03.11.2026): второй кабинет WB (китайская
 * компания), те же товары, что в таблице «Склад». Цена в кабинете — в юанях,
 * себестоимость — в рублях, расчёт ведём в рублях по курсу.
 *
 * Формула — src/utils/wbGlobalProfit.ts (как в калькуляторе клиента 5.1 +
 * округление логистики по оферте №29). Данные — /api/wb-global.
 */
import { useState, Fragment } from 'react';
import { CaretDownIcon, CaretUpIcon, SpinnerIcon, ImageIcon, ArchiveIcon, ArrowCounterClockwiseIcon, KeyIcon } from '@phosphor-icons/react';
import { wbGlobalRes, LIVE_POLL_MS, type WbGlobalRow } from '../api/pricingResources';
import { fmtDateClock } from '../api/sideResource';
import { wbImageUrl } from '../utils/wbBasket';
import { usePricingPrefs, fmt } from './usePricingPrefs';
import { PricingGlobalParams, type GParamField } from './PricingGlobalParams';
import { PriceToolbar, PriceKpis } from './PriceToolbar';
import { calcWbGlobal, WBG_DEFAULTS, type WbgInput } from '../utils/wbGlobalProfit';
import { roiStatus, ROI_STATUS_COLOR } from '../utils/roiLogic';

const COLOR = '#8a2be2';

const GPARAMS: GParamField[] = [
  { key: 'rate', label: 'Курс ₽ за ¥ (пусто — ЦБ)' },
  { key: 'spp', label: 'СПП', suffix: '%' },
  { key: 'buyout', label: '% выкупа', suffix: '%' },
  { key: 'fulfillment', label: 'Фулфилмент', suffix: '₽' },
  { key: 'drr', label: 'ДРР', suffix: '%' },
  { key: 'acquiring', label: 'Эквайринг', suffix: '%' },
  { key: 'tax', label: 'Налог от цены покупателя', suffix: '%' },
  { key: 'payful', label: 'Payful', suffix: '%' },
];

type KnobKey = 'priceCny' | 'cost' | 'spp' | 'drr' | 'buyout' | 'commission' | 'extra';

const fmtCny = (v: number) => `${(Math.round(v * 10) / 10).toLocaleString('ru-RU')} ¥`;

export function LiveWbGlobalPricing() {
  const res = wbGlobalRes.use(LIVE_POLL_MS);
  const data = res.data;
  const { knobs, setKnob, resetKnobs, showArchive, inStockOnly, listMode, setListMode,
    gpDraft, gpChange, gpApply, gpReset, gp, archivedSet, onArchive, onUnarchive } = usePricingPrefs('prices-wbg');
  const [expanded, setExpanded] = useState<number | null>(null);
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState<'price' | 'margin' | 'roi' | 'name'>('price');

  const cbr = data?.cnyRate?.value ?? null;
  const rate = gp('rate', cbr ?? WBG_DEFAULTS.rate);
  const rateFromCbr = gp('rate', -1) === -1 && cbr != null;

  const compute = (r: WbGlobalRow, k: Record<string, string>) => {
    const kn = (key: KnobKey): number | undefined => {
      const s = k[key];
      if (s === undefined || s.trim() === '') return undefined;
      const n = parseFloat(s.replace(',', '.'));
      return isNaN(n) ? undefined : n;
    };
    const inp: WbgInput = {
      priceCny: kn('priceCny') ?? r.discountedCny,
      rate,
      cost: kn('cost') ?? r.cost ?? 0,
      extra: kn('extra') ?? 0,
      commission: kn('commission') ?? r.commission ?? WBG_DEFAULTS.commission,
      spp: kn('spp') ?? gp('spp', WBG_DEFAULTS.spp),
      buyout: kn('buyout') ?? gp('buyout', WBG_DEFAULTS.buyout),
      fulfillment: gp('fulfillment', WBG_DEFAULTS.fulfillment),
      drr: kn('drr') ?? gp('drr', WBG_DEFAULTS.drr),
      acquiring: gp('acquiring', WBG_DEFAULTS.acquiring),
      tax: gp('tax', WBG_DEFAULTS.tax),
      payful: gp('payful', WBG_DEFAULTS.payful),
      volumeL: r.volumeL,
      logFirst: WBG_DEFAULTS.logFirst,
      logExtra: WBG_DEFAULTS.logExtra,
    };
    const calc = inp.cost > 0 ? calcWbGlobal(inp) : null;
    const roi = calc?.roi != null ? Math.round(calc.roi) : null;
    return { inp, calc, roi, roiInfo: roi != null && inp.cost > 0 ? roiStatus(roi, inp.cost) : null };
  };

  if (!data && res.loading) {
    return <div className="card" style={{ textAlign: 'center', padding: 40 }}>
      <SpinnerIcon size={24} weight="bold" className="spin" />
      <div className="muted" style={{ marginTop: 8 }}>Загрузка цен WB Global…</div>
    </div>;
  }
  if (!data) {
    return <div className="card" style={{ padding: 20 }}>
      <div style={{ fontWeight: 600, color: 'var(--bad)' }}>Не удалось загрузить данные WB Global</div>
      <div className="muted" style={{ fontSize: 17, marginTop: 6 }}>{res.error}</div>
      <button className="btn btn-sm" style={{ marginTop: 10 }} onClick={() => wbGlobalRes.refresh(true)}>Повторить</button>
    </div>;
  }
  if (!data.configured) {
    return <div className="card" style={{ padding: 20 }}>
      <div className="card-title" style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
        <KeyIcon size={18} weight="bold" style={{ color: COLOR }} /> Токен кабинета WB Global не задан
      </div>
      <div className="muted" style={{ fontSize: 17, marginTop: 8, lineHeight: 1.45 }}>
        Лист заработает, когда на сервере появится токен второго кабинета (строка <code>WB_GLOBAL_TOKEN</code> в настройках сервера).
        Нужны категории «Цены и скидки», «Контент», «Маркетплейс» и «Тарифы», только чтение.
        Курс юаня ЦБ на сегодня: {cbr != null ? `${cbr.toLocaleString('ru-RU')} ₽` : 'не получен'}.
      </div>
    </div>;
  }

  const all = data.rows;
  const key = (r: WbGlobalRow) => r.vendorCode.toUpperCase();
  const stockKnown = all.some(r => r.stock != null);
  const isInSale = (r: WbGlobalRow) => !stockKnown || (r.stock ?? 0) > 0;
  const archivedCount = all.filter(r => archivedSet.has(key(r))).length;
  const saleCount = all.filter(r => !archivedSet.has(key(r)) && isInSale(r)).length;
  const q = search.trim().toLowerCase();
  const filtered = all.filter(r => {
    if (q && !(r.vendorCode.toLowerCase().includes(q) || String(r.nmId).includes(q) || r.title.toLowerCase().includes(q))) return false;
    if (showArchive) return archivedSet.has(key(r));
    if (archivedSet.has(key(r))) return false;
    return inStockOnly ? isInSale(r) : true;
  });
  const sk = (r: WbGlobalRow) => { const m = compute(r, {}); return {
    price: m.calc?.price ?? r.discountedCny * rate, margin: m.calc?.margin ?? -Infinity, roi: m.calc?.roi ?? -Infinity,
    name: (r.title || r.vendorCode).toLowerCase() }; };
  const rows = [...filtered].sort((a, b) => {
    const ka = sk(a), kb = sk(b);
    return sortBy === 'name' ? ka.name.localeCompare(kb.name) : (kb[sortBy] as number) - (ka[sortBy] as number);
  });
  const margins = rows.map(r => compute(r, {}).calc?.margin).filter((v): v is number => v != null);
  const avgMargin = margins.length ? Math.round(margins.reduce((a, b) => a + b, 0) / margins.length * 10) / 10 : null;
  const noCost = rows.filter(r => !(r.cost && r.cost > 0)).length;

  return (
    <div className="grid" style={{ gap: 16 }}>
      <PricingGlobalParams fields={GPARAMS} draft={gpDraft} onChange={gpChange} onApply={gpApply} onReset={gpReset} color={COLOR} />
      <PriceToolbar
        mode={listMode} onMode={setListMode}
        counts={{ sale: saleCount, all: all.length - archivedCount, archive: archivedCount }}
        saleHint={stockKnown ? 'Только товары с остатком на складах продавца (FBS) в кабинете WB Global' : 'Остатки кабинета не получены — показаны все товары'}
        search={search} onSearch={setSearch} searchPlaceholder="Артикул, название или nmID"
        sortBy={sortBy} onSort={setSortBy}
        checkedLabel="данные кабинета на"
        checkedAt={fmtDateClock(data.fetchedAt)}
        checkedHint="Цены, комиссии и остатки кабинета WB Global обновляются раз в 10 минут"
        loading={res.loading}
      />
      <PriceKpis items={[
        { label: 'Товаров в списке', value: rows.length },
        { label: 'Курс ₽ за ¥', value: rate.toLocaleString('ru-RU'),
          hint: rateFromCbr ? `Курс ЦБ на ${data.cnyRate?.date ?? '—'}. Покупателю WB показывает цену по своему курсу — не выше курса ЦБ более чем на 10 % (оферта, п. 5.1.1)` : 'Курс задан вручную в глобальных параметрах' },
        { label: 'Средняя маржа', value: avgMargin == null ? '—' : `${avgMargin}%`, hint: 'Средняя маржа по видимым товарам с себестоимостью' },
        ...(noCost ? [{ label: 'Без себестоимости', value: noCost, hint: 'Артикул не найден в таблице «Склад» — маржу не считаем. Себестоимость можно вписать вручную в раскрытой строке' }] : []),
      ]} />
      {data.errors.length > 0 && (
        <div className="card" style={{ padding: 12, color: 'var(--warn)', fontSize: 16 }}>
          Часть данных кабинета не пришла: {data.errors.join('; ')}
        </div>
      )}

      <div className="card pr-table-card">
        <div className="tbl-scroll">
          <table className="mp-table" style={{ fontSize: 17 }}>
            <thead className="mp-head">
              <tr>
                <th style={{ width: '6%' }}></th>
                <th style={{ width: '23%' }}>Артикул</th>
                <th className="right" style={{ width: '14%' }} title="Цена продавца со скидкой в кабинете WB Global, в юанях, и в рублях по курсу">Цена продавца</th>
                <th className="right" style={{ width: '15%' }} title="Цена для покупателя: цена в рублях × (1 − СПП)">Цена покупателя</th>
                <th className="right" style={{ width: '11%' }} title="Себестоимость из таблицы «Склад», ₽">Себест.</th>
                <th className="right" style={{ width: '13%' }} title="Чистая прибыль на единицу, % и ₽">Маржа</th>
                <th className="right" style={{ width: '9%' }}>ROI</th>
                <th style={{ width: '7%' }}></th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => {
                const k = knobs[r.nmId] ?? {};
                const { inp, calc, roi, roiInfo } = compute(r, k);
                const open = expanded === r.nmId;
                const arch = archivedSet.has(key(r));
                const photo = r.photo || wbImageUrl(r.nmId);
                const edited = Object.values(k).some(v => v != null && String(v).trim() !== '');
                const m = calc ? Math.round(calc.margin) : null;
                return (
                  <Fragment key={r.nmId}>
                    <tr style={{ cursor: 'pointer', ...(arch ? { opacity: 0.55 } : {}) }} onClick={() => setExpanded(open ? null : r.nmId)}>
                      <td>{photo
                        ? <img src={photo} alt="" style={{ width: 54, height: 72, objectFit: 'cover', borderRadius: 6 }} />
                        : <div style={{ width: 36, height: 48, borderRadius: 6, background: 'var(--bg-subtle)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><ImageIcon size={16} /></div>}</td>
                      <td>
                        <div style={{ fontWeight: 600, lineHeight: 1.3, wordBreak: 'break-word' }} title={`${r.title} · nm${r.nmId}`}>{r.vendorCode}</div>
                        {stockKnown && <div className="muted" style={{ fontSize: 15 }}>остаток FBS: {r.stock ?? 0} шт</div>}
                      </td>
                      <td className="right" style={{ whiteSpace: 'nowrap' }}>
                        <b>{inp.priceCny > 0 ? fmtCny(inp.priceCny) : '—'}</b>
                        <div className="muted" style={{ fontSize: 16 }}>{inp.priceCny > 0 ? fmt(Math.round(inp.priceCny * rate)) : ''}</div>
                        {r.currency && r.currency !== 'CNY' && <div style={{ fontSize: 15, color: 'var(--warn)' }} title="WB вернул цену не в юанях — проверьте кабинет">валюта {r.currency}</div>}
                      </td>
                      <td className="right" style={{ whiteSpace: 'nowrap' }}>
                        <b style={{ color: 'var(--good)' }}>{calc ? fmt(Math.round(calc.buyer)) : inp.priceCny > 0 ? fmt(Math.round(inp.priceCny * rate * (1 - inp.spp / 100))) : '—'}</b>
                        <div className="muted" style={{ fontSize: 16 }}>СПП {inp.spp}%</div>
                      </td>
                      <td className="right" style={{ whiteSpace: 'nowrap' }}>
                        {inp.cost > 0 ? `${Math.round(inp.cost).toLocaleString('ru-RU')} ₽`
                          : <span className="muted" title="Артикул не найден в таблице «Склад»">нет</span>}
                      </td>
                      <td className="right" style={{ whiteSpace: 'nowrap' }}>
                        {calc ? <>
                          <b style={{ fontSize: 19, color: m! >= 30 ? 'var(--good)' : m! >= 15 ? 'var(--warn)' : 'var(--bad)' }}>{m}%</b>
                          <div className="muted" style={{ fontSize: 16 }}>{Math.round(calc.profit).toLocaleString('ru-RU')} ₽</div>
                          {edited && <div style={{ fontSize: 15, color: 'var(--accent)' }}>✎ ручной расчёт</div>}
                          {r.commission == null && k.commission == null && <div style={{ fontSize: 15, color: 'var(--warn)' }} title="WB не дал комиссию по предмету — взято 20 %">⚠ ком. {WBG_DEFAULTS.commission}%</div>}
                        </> : <span className="muted">—</span>}
                      </td>
                      <td className="right" style={{ whiteSpace: 'nowrap' }}>
                        {roi != null && roiInfo
                          ? <span style={{ background: ROI_STATUS_COLOR[roiInfo.status].bg, color: ROI_STATUS_COLOR[roiInfo.status].color, padding: '2px 8px', borderRadius: 999, fontWeight: 600 }}>{roi}%</span>
                          : <span className="muted">—</span>}
                      </td>
                      <td style={{ textAlign: 'center' }}>
                        <div className="row" style={{ gap: 4, justifyContent: 'center' }} onClick={e => e.stopPropagation()}>
                          {arch
                            ? <button className="btn btn-sm" title="Вернуть из архива" onClick={() => onUnarchive(r.vendorCode)}><ArrowCounterClockwiseIcon size={12} weight="bold" /></button>
                            : <button className="btn btn-sm" title="В архив" onClick={() => onArchive(r.vendorCode)}><ArchiveIcon size={12} weight="bold" /></button>}
                          {open ? <CaretUpIcon size={14} weight="bold" /> : <CaretDownIcon size={14} weight="bold" />}
                        </div>
                      </td>
                    </tr>
                    {open && (
                      <tr>
                        <td colSpan={8} style={{ padding: 0 }}>
                          <div style={{ background: 'var(--bg-subtle)', padding: '16px 24px', borderBottom: '1px solid var(--border)' }} onClick={e => e.stopPropagation()}>
                            <Details r={r} k={k} inp={inp} calc={calc} edited={edited}
                              onKnob={(f, v) => setKnob(r.nmId, f, v)} onReset={() => resetKnobs(r.nmId)} />
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="muted" style={{ fontSize: 16, marginTop: 8, textAlign: 'right' }}>
          Кабинет WB Global · FBS · данные на {fmtDateClock(data.fetchedAt)}
        </div>
      </div>
    </div>
  );
}

function Details({ r, k, inp, calc, edited, onKnob, onReset }: {
  r: WbGlobalRow; k: Record<string, string>; inp: WbgInput; calc: ReturnType<typeof calcWbGlobal>; edited: boolean;
  onKnob: (f: KnobKey, v: string) => void; onReset: () => void;
}) {
  const shown = (f: KnobKey, def: number, digits = 0) => k[f] !== undefined ? k[f] : String(Math.round(def * 10 ** digits) / 10 ** digits);
  const fields: { key: KnobKey; label: string; val: string }[] = [
    { key: 'priceCny', label: 'Цена продавца, ¥', val: shown('priceCny', inp.priceCny, 1) },
    { key: 'cost', label: 'Себестоимость, ₽', val: shown('cost', inp.cost) },
    { key: 'spp', label: 'СПП, %', val: shown('spp', inp.spp) },
    { key: 'drr', label: 'ДРР (реклама), %', val: shown('drr', inp.drr) },
    { key: 'buyout', label: '% выкупа', val: shown('buyout', inp.buyout) },
    { key: 'commission', label: 'Комиссия WB, %', val: shown('commission', inp.commission, 1) },
    { key: 'extra', label: 'Доп. расходы, ₽', val: shown('extra', inp.extra) },
  ];
  const vol = Math.max(r.volumeL, 1);
  const lines: { l: string; v: number }[] = calc ? [
    { l: `Комиссия WB (${inp.commission}%) · FBS${r.commission != null && k.commission === undefined ? ' · API' : ''}`, v: -calc.commission },
    { l: r.dims
        ? `Логистика · ${r.dims.length}×${r.dims.width}×${r.dims.height} см = ${r.volumeL.toFixed(2)} л → ${inp.logFirst} ¥ + ${inp.logExtra} ¥ × ${(vol - 1).toFixed(2)} = ${calc.logisticsCny} ¥ · ÷ выкуп ${inp.buyout}%`
        : `Логистика · габаритов в карточке нет, взят 1 л = ${calc.logisticsCny} ¥ · ÷ выкуп ${inp.buyout}%`, v: -calc.logistics },
    { l: `Фулфилмент (${inp.fulfillment} ₽ ÷ выкуп)`, v: -calc.fulfillment },
    { l: `Реклама ДРР (${inp.drr}%)`, v: -calc.advertising },
    { l: `Эквайринг (${inp.acquiring}%)`, v: -calc.acquiring },
    { l: `Payful — вывод средств (${inp.payful}%)`, v: -calc.payful },
    { l: `Налог (${inp.tax}% от цены покупателя)`, v: -calc.tax },
    { l: 'Себестоимость', v: -calc.cost },
    ...(calc.extra ? [{ l: 'Доп. расходы', v: -calc.extra }] : []),
  ] : [];
  return (
    <div className="grid grid-2" style={{ gap: 20 }}>
      <div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          {fields.map(f => (
            <label key={f.key} style={{ fontSize: 17 }}>
              <div className="muted" style={{ marginBottom: 3 }}>{f.label}</div>
              <input className="input" type="number" value={f.val} onChange={e => onKnob(f.key, e.target.value)}
                style={{ width: '100%', ...(k[f.key] !== undefined ? { borderColor: 'var(--accent)', fontWeight: 700 } : {}) }} />
            </label>
          ))}
        </div>
        {edited && <button className="btn btn-sm" style={{ marginTop: 10 }} onClick={onReset}>Сбросить к данным кабинета</button>}
        <div className="muted" style={{ fontSize: 15, marginTop: 10, lineHeight: 1.4 }}>
          {r.title}{r.subject ? ` · ${r.subject}` : ''} · nm {r.nmId}
          {r.discount > 0 ? ` · в кабинете ${fmtCny(r.priceCny)} со скидкой ${r.discount}%` : ''}
          {r.clubCny > 0 && r.clubCny < r.discountedCny ? ` · WB Клуб ${fmtCny(r.clubCny)}` : ''}
          {r.dims?.weightKg ? ` · вес ${r.dims.weightKg} кг` : ''}
        </div>
      </div>
      <div>
        <div className="card-title" style={{ marginBottom: 8 }}>Расчёт на 1 продажу</div>
        {!calc ? <div className="muted">Нужны цена и себестоимость</div> : (
          <div style={{ display: 'grid', gap: 3 }}>
            <div className="flex-between" style={{ fontSize: 17, fontWeight: 600 }}>
              <span>Цена в кабинете ({fmtCny(inp.priceCny)} × {inp.rate})</span><span style={{ color: 'var(--good)' }}>{fmt(Math.round(calc.price))}</span>
            </div>
            <div className="flex-between muted" style={{ fontSize: 17 }}>
              <span>↳ цена покупателя (СПП {inp.spp}%) — справочно</span><span>{fmt(Math.round(calc.buyer))}</span>
            </div>
            {lines.map((x, i) => (
              <div key={i} className="flex-between muted" style={{ fontSize: 17, gap: 12 }}>
                <span>{x.l}</span><span style={{ color: 'var(--bad)', whiteSpace: 'nowrap' }}>{fmt(Math.round(x.v))}</span>
              </div>
            ))}
            <div className="flex-between muted" style={{ fontSize: 17, borderTop: '1px dashed var(--border)', paddingTop: 4 }}>
              <span>На расчётный счёт</span><span>{fmt(Math.round(calc.cash))} · {fmtCny(calc.cash / inp.rate)}</span>
            </div>
            <div className="flex-between" style={{ fontSize: 19, fontWeight: 700, borderTop: '1px solid var(--border)', marginTop: 6, paddingTop: 6 }}>
              <span>Чистая прибыль</span>
              <span style={{ color: calc.profit >= 0 ? 'var(--good)' : 'var(--bad)' }}>
                {fmt(Math.round(calc.profit))}
                <span style={{ fontSize: 17, fontWeight: 600 }}> · {calc.margin.toFixed(1)}%{calc.roi != null ? ` · ROI ${calc.roi.toFixed(0)}%` : ''}</span>
              </span>
            </div>
            {calc.breakevenCny != null && (
              <div className="flex-between muted" style={{ fontSize: 17 }}>
                <span>Цена безубыточности</span><span>{fmtCny(calc.breakevenCny)} · {fmt(Math.round(calc.breakevenCny * inp.rate))}</span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
