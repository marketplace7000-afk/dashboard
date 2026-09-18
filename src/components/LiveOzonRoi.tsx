import { useMemo, useState } from 'react';
import { SpinnerIcon, ArrowsClockwiseIcon, WarningIcon, BellIcon } from '@phosphor-icons/react';
import { OzonPriceRow, OzonProductInfo } from '../api/marketplaces';
import { useLiveOzonBundle, productInfoIndex } from '../api/useLiveOzonCache';
import { PERIOD_LABEL, PeriodKey, ozonPeriodRange, fmtRangeRu, periodLabelRu } from '../api/useLiveOzon';
import { useProcurement } from '../api/useProcurement';
import { roiStatus, ROI_STATUS_COLOR } from '../utils/roiLogic';
import { AiAdvice } from './AiAdvice';

type Row = OzonPriceRow & {
  name?: string;
  primary_image?: string;
  orders?: number;
  revenue?: number;
  actualCost?: number; // реальная себестоимость из Google Sheets
  // ROI и прибыль ИЗ листа «Маржа» (последняя неделя) — источник истины.
  roiMarzha?: number | null;    // ROI %, из «Маржи»
  profitUnit?: number | null;   // маржинальная прибыль на единицу, ₽
  profitWeek?: number | null;   // маржинальная прибыль за неделю по артикулу, ₽
  costMarzha?: number | null;   // себестоимость из «Маржи», ₽
  marzhaWeek?: number | null;   // номер недели
  lkPriceSheet?: number | null; // цена ЛК из листа «ДРР и цены» (кол. E)
};

const num = (v: any) => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
const fmt = (v: any) => num(v).toLocaleString('ru-RU') + ' ₽';

function calcUnitEconomics(r: Row, costFactorPct: number, commissionPctOverride?: number | null) {
  // Цену берём ФАКТИЧЕСКУЮ среднюю продажи (выручка/заказы), а не прайс-листовую
  // r.price.price: из-за акций Ozon листовая цена бывает сильно выше реальной, и
  // прибыль/шт с ROI раздувались. Если продаж нет — fallback на листовую цену.
  // Базовая цена для самосчёта: лист «ДРР и цены» (кол. E) приоритетнее; при
  // пустой колонке — marketing_seller_price (реальная), а не мусорный r.price.price.
  const listPrice = (r.lkPriceSheet != null && r.lkPriceSheet > 0)
    ? r.lkPriceSheet
    : (num(r.price.marketing_seller_price) || num(r.price.price));
  const ordersForPrice = r.orders ?? 0;
  const price = ordersForPrice > 0 && (r.revenue ?? 0) > 0
    ? (r.revenue as number) / ordersForPrice
    : listPrice;
  // Клиент просил (20:46) иметь возможность вручную задать % комиссии, т.к. Ozon
  // API не всегда возвращает точный (обычно 41-42% в их категориях). Если задан
  // override — используем его, иначе значение из API.
  const commissionPct = commissionPctOverride != null && commissionPctOverride > 0
    ? commissionPctOverride
    : (r.commissions.sales_percent_fbo || 0);
  // acquiring и доставка — абсолютные суммы в рублях за единицу
  const acquiring = num(r.acquiring);
  const deliveryAmount = num(r.commissions.fbo_deliv_to_customer_amount);

  const commission = price * commissionPct / 100;
  const totalFees = commission + acquiring + deliveryAmount;

  // Если есть реальная себестоимость из Google Sheets — используем её,
  // иначе fallback на оценку как % от цены
  const cost = r.actualCost && r.actualCost > 0 ? r.actualCost : price * costFactorPct / 100;
  const costIsReal = !!(r.actualCost && r.actualCost > 0);

  const netRevenue = price - totalFees;
  const profit = netRevenue - cost;
  const margin = price > 0 ? (profit / price) * 100 : 0;
  const roi = cost > 0 ? (profit / cost) * 100 : 0;

  return { price, commission, acquiring, deliveryAmount, totalFees, cost, costIsReal, netRevenue, profit, margin, roi };
}

export function LiveOzonRoi() {
  const bundle = useLiveOzonBundle();
  const sheets = useProcurement();
  const [period, setPeriod] = useState<PeriodKey>('week');
  // Себестоимость клиент просил убрать из UI (ROI/прибыль берём из «Маржи»).
  // Оставляем фикс. оценку как запасной вариант ТОЛЬКО для SKU, которых нет в «Марже».
  const costFactor = 45;
  const [roiThreshold, setRoiThreshold] = useState(20);
  // Ручной override % комиссии (клиент 20:46). Пусто = берём из Ozon API.
  const [commissionPct, setCommissionPct] = useState<string>('');
  const commissionOverride = commissionPct.trim() !== '' && Number.isFinite(+commissionPct) ? +commissionPct : null;

  // Карта offer_id (UPPER) → purchasePrice из Google Sheets
  const costByOffer = useMemo(() => {
    const m = new Map<string, number>();
    for (const it of sheets.items) {
      if (it.purchasePrice > 0) m.set(it.sku.toUpperCase(), it.purchasePrice);
    }
    return m;
  }, [sheets.items]);

  // Карта offer_id (UPPER) → цена ЛК из листа «ДРР и цены» (кол. E). Ozon API
  // отдаёт по этой цене мусор (напр. 150 000 ₽ вместо 28 325 ₽) — источник истины
  // только таблица клиента, как уже сделано в разделах «Цены» и «Акции».
  const lkPriceByOffer = useMemo(() => {
    const m = new Map<string, number>();
    for (const it of sheets.items) {
      if (it.lkPriceOzon != null && it.lkPriceOzon > 0) m.set(it.sku.toUpperCase(), it.lkPriceOzon);
    }
    return m;
  }, [sheets.items]);

  // Карта offer_id (UPPER) → ROI/прибыль из листа «Маржа» (последняя неделя).
  // Это источник истины: финансист считает точнее (обратная логистика, налог и т.д.).
  const marzhaByOffer = useMemo(() => {
    const m = new Map<string, { roi: number | null; profitUnit: number | null; profitWeek: number | null; cost: number | null; week: number | null }>();
    for (const it of sheets.items) {
      if (it.roiOzonMarzha != null || it.profitUnitOzon != null) {
        m.set(it.sku.toUpperCase(), {
          roi: it.roiOzonMarzha ?? null,
          profitUnit: it.profitUnitOzon ?? null,
          profitWeek: it.profitWeekOzon ?? null,
          cost: it.purchasePrice || null,
          week: it.marzhaWeekOzon ?? null,
        });
      }
    }
    return m;
  }, [sheets.items]);

  // Остаток Ozon по SKU (из закупок). Клиент (25:25/30:20/06:38): показывать
  // ТОЛЬКО товары в наличии (~21 актуальный), а не все 84 из кабинета (там куча
  // архивных/без остатка). Если данных об остатках нет вовсе — не фильтруем.
  const stockByOffer = useMemo(() => {
    const m = new Map<string, number>();
    for (const it of sheets.items) m.set(it.sku.toUpperCase(), it.stockOzon || 0);
    return m;
  }, [sheets.items]);
  const haveStockData = useMemo(() => [...stockByOffer.values()].some((v) => v > 0), [stockByOffer]);

  const rows: Row[] = useMemo(() => {
    const byId = productInfoIndex(bundle);
    const top = period === 'month' ? bundle.topByMonth : bundle.topByWeek;
    const ordersByPid = new Map<number, { orders: number; revenue: number }>();
    for (const r of top) {
      const pid = bundle.skuToPid.get(r.sku);
      if (!pid) continue;
      const cur = ordersByPid.get(pid) ?? { orders: 0, revenue: 0 };
      cur.orders += r.orders;
      cur.revenue += r.revenue;
      ordersByPid.set(pid, cur);
    }
    const inStock = (p: typeof bundle.prices[number]) =>
      !haveStockData || (stockByOffer.get(String(p.offer_id || '').trim().toUpperCase()) ?? 0) > 0;
    return bundle.prices.filter(inStock).map((p) => {
      const meta = byId.get(p.product_id);
      const ord = ordersByPid.get(p.product_id);
      const offerUp = String(p.offer_id || '').trim().toUpperCase();
      const mz = marzhaByOffer.get(offerUp);
      return {
        ...p,
        name: (meta as OzonProductInfo | undefined)?.name,
        primary_image: (meta as OzonProductInfo | undefined)?.primary_image,
        orders: ord?.orders ?? 0,
        revenue: ord?.revenue ?? 0,
        actualCost: costByOffer.get(offerUp),
        roiMarzha: mz?.roi ?? null,
        profitUnit: mz?.profitUnit ?? null,
        profitWeek: mz?.profitWeek ?? null,
        costMarzha: mz?.cost ?? null,
        marzhaWeek: mz?.week ?? null,
        lkPriceSheet: lkPriceByOffer.get(offerUp) ?? null,
      };
    });
  }, [bundle, period, costByOffer, marzhaByOffer, lkPriceByOffer, stockByOffer, haveStockData]);

  // Свежесть листа «Маржа»: максимальный номер недели среди SKU. Клиент обновляет
  // лист раз в неделю — показываем, за какую неделю цифры (10.6).
  const marzhaWeek = useMemo(() => {
    let mx = 0;
    for (const v of marzhaByOffer.values()) if (v.week && v.week > mx) mx = v.week;
    return mx || null;
  }, [marzhaByOffer]);

  const enriched = useMemo(() => rows.map((r) => {
    const e = calcUnitEconomics(r, costFactor, commissionOverride);
    // Источник истины — лист «Маржа». Если по SKU есть данные из листа — берём их
    // (финансист считает точнее: обратная логистика, налог и т.д.), иначе fallback
    // на самосчёт (для SKU, которых нет в «Марже»).
    const hasSheet = r.roiMarzha != null;
    // Цена ЛК: приоритет — лист «ДРР и цены» (кол. E). Запасной вариант, если
    // колонка листа пуста — marketing_seller_price (реальная цена Ozon), а НЕ
    // r.price.price: тот из-за акций отдаёт мусор (150 000 ₽ вместо 28 325 ₽).
    const lkPrice = (r.lkPriceSheet != null && r.lkPriceSheet > 0)
      ? r.lkPriceSheet
      : (num(r.price.marketing_seller_price) || num(r.price.price));
    const roi = hasSheet ? (r.roiMarzha as number) : e.roi;
    const profitUnit = r.profitUnit != null ? r.profitUnit : e.profit;
    const profitTotal = r.profitWeek != null ? r.profitWeek : e.profit * (r.orders ?? 0);
    const cost = (r.costMarzha ?? r.actualCost ?? e.cost) || e.cost;
    const d = { hasSheet, lkPrice, roi, profitUnit, profitTotal, cost };
    return { r, e, d };
  }), [rows, costFactor, commissionOverride]);
  const withSales = enriched.filter((x) => (x.r.orders ?? 0) > 0);

  const aggregate = useMemo(() => {
    const totalRevenue = withSales.reduce((s, x) => s + (x.r.revenue ?? 0), 0);

    // Сборы считаем от фактической средней цены продажи (revenue/orders),
    // а не от прайс-листовой цены — та может быть сильно выше из-за акций Ozon.
    const totalFees = withSales.reduce((s, x) => {
      const orders = x.r.orders ?? 0;
      if (orders === 0) return s;
      const avgSellPrice = (x.r.revenue ?? 0) / orders;
      const commPct = commissionOverride != null && commissionOverride > 0 ? commissionOverride : (x.r.commissions?.sales_percent_fbo || 0);
      const commission = avgSellPrice * commPct / 100;
      const acq = num(x.r.acquiring);
      const delivery = num(x.r.commissions?.fbo_deliv_to_customer_amount);
      return s + (commission + acq + delivery) * orders;
    }, 0);

    // Себестоимость: для SKU с реальной — orders × actualCost,
    // для остальных — оценкой % от их revenue
    let totalCost = 0;
    let revenueByReal = 0;
    let revenueByEstimate = 0;
    for (const x of withSales) {
      const orders = x.r.orders ?? 0;
      const rev = x.r.revenue ?? 0;
      if (x.r.actualCost && x.r.actualCost > 0) {
        totalCost += orders * x.r.actualCost;
        revenueByReal += rev;
      } else {
        totalCost += rev * costFactor / 100;
        revenueByEstimate += rev;
      }
    }
    const totalProfit = totalRevenue - totalFees - totalCost;
    const avgMargin = totalRevenue > 0 ? (totalProfit / totalRevenue) * 100 : 0;

    // Прибыль и ROI из листа «Маржа» (источник истины). Суммируем маржинальную
    // прибыль за неделю по артикулу; средний ROI = прибыль ÷ себестоимость×заказы.
    let sheetProfit = 0;
    let sheetCogs = 0;
    for (const x of withSales) {
      sheetProfit += x.d.profitTotal;
      sheetCogs += (x.r.orders ?? 0) * x.d.cost;
    }
    const avgRoi = sheetCogs > 0 ? (sheetProfit / sheetCogs) * 100 : (totalCost > 0 ? (totalProfit / totalCost) * 100 : 0);
    return { totalRevenue, totalFees, totalCost, totalProfit, sheetProfit, avgRoi, avgMargin, revenueByReal, revenueByEstimate };
  }, [withSales, costFactor, commissionOverride]);

  // Алерты по ROI из «Маржи». Показываем ВСЕ активные SKU (с продажами за период),
  // без обрезки до 10 — клиент просил видеть все товары в списке.
  const alertsAll = enriched
    .filter((x) => (x.r.orders ?? 0) > 0 && x.d.roi < roiThreshold)
    .sort((a, b) => a.d.roi - b.d.roi);

  // Клиент (26:17): «подрезается, добавим чтобы ВСЕ товары отражались». Показываем
  // ВСЕ товары в наличии (не только с продажами, не топ-10), отсортированные по прибыли.
  const topByProfit = [...enriched]
    .sort((a, b) => b.d.profitTotal - a.d.profitTotal);

  // Компактный контекст для ИИ-советника — только то, что уже на экране.
  const adviceContext = useMemo(() => ({
    period: periodLabelRu(period),
    диапазон: fmtRangeRu(ozonPeriodRange(period).from, ozonPeriodRange(period).to),
    порог_ROI: roiThreshold,
    средний_ROI: +aggregate.avgRoi.toFixed(1),
    выручка: Math.round(aggregate.totalRevenue),
    маржприбыль: Math.round(aggregate.sheetProfit),
    ниже_порога: alertsAll.slice(0, 15).map((x) => ({ sku: x.r.offer_id, roi: +x.d.roi.toFixed(1), приб_шт: Math.round(x.d.profitUnit), заказов: x.r.orders })),
    топ_прибыль: topByProfit.slice(0, 8).map((x) => ({ sku: x.r.offer_id, приб_нед: Math.round(x.d.profitTotal), roi: +x.d.roi.toFixed(1), заказов: x.r.orders })),
  }), [period, roiThreshold, aggregate, alertsAll, topByProfit]);

  return (
    <div className="grid" style={{ gap: 20 }}>
      <div className="flex-between" style={{ flexWrap: 'wrap', gap: 12 }}>
        <div className="row gap-8">
          {bundle.loading && bundle.fetchedAt == null
            ? <span className="chip info"><SpinnerIcon size={11} weight="bold" className="spin" /> загрузка…</span>
            : <>
                {haveStockData && <span className="chip good" title="Показываем только товары с остатком на Ozon (актуальные)">{rows.length} товаров в наличии</span>}
                <span className="chip info">{withSales.length} с продажами · {PERIOD_LABEL[period]} ({fmtRangeRu(ozonPeriodRange(period).from, ozonPeriodRange(period).to)})</span>
                <span className={`chip ${aggregate.avgRoi >= roiThreshold ? 'good' : 'bad'}`}>
                  средний ROI: {aggregate.avgRoi.toFixed(1)}%
                </span>
                {marzhaWeek && (
                  <span className="chip" title="ROI и прибыль — из листа «Маржа». Финансист обновляет его раз в неделю.">
                    данные листа «Маржа»: неделя {marzhaWeek}
                  </span>
                )}
                {alertsAll.length > 0 && (
                  <span className="chip bad" title="Считается только по SKU с продажами за период">
                    <BellIcon size={11} weight="bold" /> {alertsAll.length} SKU ниже порога {roiThreshold}%
                  </span>
                )}
              </>
          }
        </div>
        <div className="row gap-8">
          <div className="period-switch">
            {(['day', 'week', 'month'] as PeriodKey[]).map((p) => (
              <button
                key={p}
                className={`period-btn ${period === p ? 'active' : ''}`}
                onClick={() => setPeriod(p)}
                disabled={p === 'day'}
                title={p === 'day' ? 'Используем кэш недели/месяца' : ''}
                style={{ opacity: p === 'day' ? 0.4 : 1 }}
              >
                {PERIOD_LABEL[p]}
              </button>
            ))}
          </div>
          <button className="btn btn-sm" onClick={bundle.refresh} disabled={bundle.loading}>
            {bundle.loading
              ? <SpinnerIcon size={13} weight="bold" className="spin" />
              : <ArrowsClockwiseIcon size={13} weight="bold" />}
            Обновить
          </button>
        </div>
      </div>

      <div className="card" style={{ background: 'var(--accent-soft)' }}>
        <div className="row gap-12" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
          <label className="field-label" style={{ margin: 0 }}>Порог алерта ROI · подсвечиваем всё, что ниже</label>
          <div className="row" style={{ gap: 10, flex: 1, minWidth: 240 }}>
            <input type="range" min={0} max={250} step={5} value={roiThreshold} onChange={(e) => setRoiThreshold(+e.target.value)} style={{ flex: 1 }} />
            <input className="input" type="number" value={roiThreshold} min={0} max={250} onChange={(e) => setRoiThreshold(+e.target.value)} style={{ width: 70 }} />
            <span className="muted">%</span>
          </div>
          <div className="row gap-8" style={{ alignItems: 'center' }}>
            <label className="field-label" style={{ margin: 0 }} title="Обычно 41-42% в категориях автотоваров. Пусто = берём из Ozon API.">% комиссии (вручную)</label>
            <input className="input" type="number" value={commissionPct} min={0} max={99} placeholder="из API"
                   onChange={(e) => setCommissionPct(e.target.value)} style={{ width: 90 }} />
            {commissionOverride != null && (
              <button className="btn btn-sm" onClick={() => setCommissionPct('')} title="Вернуть из API">сброс</button>
            )}
          </div>
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
          <div className="grid grid-3">
            <div className="card kpi">
              <div className="card-title">Сумма заказов</div>
              <div className="v">{fmt(aggregate.totalRevenue)}</div>
              <div className="d muted">{periodLabelRu(period)}</div>
            </div>
            <div className="card kpi">
              <div className="card-title">Сборы Ozon · комиссия + эквайринг + доставка</div>
              <div className="v">{fmt(aggregate.totalFees)}</div>
              <div className="d muted">{aggregate.totalRevenue > 0 ? ((aggregate.totalFees / aggregate.totalRevenue) * 100).toFixed(1) : 0}% от суммы заказов</div>
            </div>
            <div
              className="card kpi"
              style={{ background: aggregate.sheetProfit >= 0 ? 'rgba(22,163,74,.08)' : 'rgba(220,38,38,.08)' }}
            >
              <div className="card-title">Маржинальная прибыль</div>
              <div className="v" style={{ color: aggregate.sheetProfit >= 0 ? 'var(--good)' : 'var(--bad)' }}>{fmt(aggregate.sheetProfit)}</div>
              <div className="d">ROI: <b>{aggregate.avgRoi.toFixed(1)}%</b> · из листа «Маржа»</div>
            </div>
          </div>

          <AiAdvice module="roi" context={adviceContext} disabled={withSales.length === 0} />

          {/* Единая таблица: ВСЕ товары в наличии по прибыли. Проблемные (ROI ниже
              порога) подсвечены красным — отдельной таблицы «Алерты» больше нет,
              чтобы не дублировать. Счётчик проблемных — в чипе сверху страницы. */}
          <div className="card">
            <div className="flex-between" style={{ marginBottom: 12 }}>
              <h2 style={{ margin: 0 }}>Все SKU · ROI и прибыль · {periodLabelRu(period)}</h2>
              {alertsAll.length > 0
                ? <span className="chip bad"><BellIcon size={11} weight="bold" /> {alertsAll.length} ниже порога {roiThreshold}%</span>
                : <span className="chip good">все выше порога {roiThreshold}%</span>}
            </div>
            <div style={{ overflowX: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th></th>
                  <th>Артикул</th>
                  <th>Товар</th>
                  <th className="right" title="Цена из личного кабинета (ЛК)">Цена ЛК</th>
                  <th className="right" title="Комиссия Ozon за единицу">Комиссия</th>
                  <th className="right" title="Эквайринг за единицу">Эквайринг</th>
                  <th className="right" title="Логистика (доставка до покупателя) за единицу">Логистика</th>
                  <th className="right" title="Маржинальная прибыль на единицу — из листа «Маржа»">Марж. прибыль / шт</th>
                  <th className="right" title="Маржинальная прибыль за неделю — из листа «Маржа»">Прибыль · всего</th>
                  <th className="right">Заказов</th>
                  <th className="right" title="ROI из листа «Маржа» (последняя неделя)">ROI</th>
                  <th>Коридор</th>
                </tr>
              </thead>
              <tbody>
                {topByProfit.map(({ r, e, d }) => {
                  const corridor = d.cost > 0 ? roiStatus(d.roi, d.cost) : null;
                  const corridorStyle = corridor ? ROI_STATUS_COLOR[corridor.status] : null;
                  const isAlert = (r.orders ?? 0) > 0 && d.roi < roiThreshold;
                  return (
                    <tr key={r.product_id} style={isAlert ? { background: 'rgba(220,38,38,.06)' } : undefined}>
                      <td style={{ width: 36 }}>
                        {r.primary_image
                          ? <img src={r.primary_image} alt="" style={{ width: 28, height: 28, borderRadius: 6, objectFit: 'cover' }} />
                          : <div style={{ width: 28, height: 28, borderRadius: 6, background: 'var(--bg-2)' }} />}
                      </td>
                      <td className="muted" style={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12 }}>
                        {isAlert && <BellIcon size={11} weight="fill" style={{ color: 'var(--bad)', marginRight: 4, verticalAlign: -1 }} />}{r.offer_id}
                      </td>
                      <td style={{ maxWidth: 300, fontSize: 13 }}>
                        <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>{r.name ?? '—'}</div>
                      </td>
                      <td className="right">{fmt(d.lkPrice)}</td>
                      <td className="right muted">{fmt(e.commission)}</td>
                      <td className="right muted">{fmt(e.acquiring)}</td>
                      <td className="right muted">{fmt(e.deliveryAmount)}</td>
                      <td className="right" style={{ color: d.profitUnit < 0 ? 'var(--bad)' : 'var(--text)' }}>{fmt(d.profitUnit)}</td>
                      <td className="right"><b style={{ color: d.profitTotal >= 0 ? 'var(--good)' : 'var(--bad)' }}>{fmt(d.profitTotal)}</b></td>
                      <td className="right">{r.orders}</td>
                      <td className="right" style={{ color: isAlert ? 'var(--bad)' : 'var(--text)', fontWeight: 600 }}>{d.roi.toFixed(1)}%</td>
                      <td>
                        {corridor && corridorStyle ? (
                          <span
                            title={`Коридор себест ${corridor.bucket?.min}–${corridor.bucket?.max} ₽: цель ${corridor.bucket?.target}% · стоп ${corridor.bucket?.stopBuy}% · выход ${corridor.bucket?.exit}%`}
                            style={{ background: corridorStyle.bg, color: corridorStyle.color, padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 600 }}
                          >
                            {corridor.label}
                          </span>
                        ) : (
                          <span className="muted" style={{ fontSize: 11 }}>~оценка</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
