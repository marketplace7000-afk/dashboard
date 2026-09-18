import { useEffect, useMemo, useState } from 'react';
import {
  ArrowsClockwiseIcon, CurrencyRubIcon, WarningIcon, InfoIcon, TrendUpIcon, TrendDownIcon,
} from '@phosphor-icons/react';
import {
  ozonFinanceTotalsCached, ozonFinanceListCached, clearFinCache,
  groupOperationsByType, groupOperationsByTxnType,
  dateToIsoStart, dateToIsoEnd, readFinCache, OzonFinTotals, OzonFinList,
} from '../api/ozonFinance';
import { ozonGetDailyExpenses, parseRu } from '../api/ozonAds';
import { AiAdvice } from '../components/AiAdvice';
import { mskDateOf } from '../utils/mskDate';

const fmtRub = (n: number) => {
  const v = Number.isFinite(n) ? Math.round(n) : 0;
  return v.toLocaleString('ru-RU') + ' ₽';
};
const fmtSigned = (n: number) => {
  const v = Number.isFinite(n) ? Math.round(n) : 0;
  const s = Math.abs(v).toLocaleString('ru-RU');
  return v < 0 ? `−${s} ₽` : v > 0 ? `+${s} ₽` : `0 ₽`;
};

function fmtDateRu(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: 'short' });
}

// По МОСКВЕ (см. utils/mskDate) — иначе кнопки «7/30 дней» ночью давали окно,
// сдвинутое на сутки относительно кабинета.
function isoDate(d: Date): string {
  return mskDateOf(d);
}
function daysAgo(n: number): string {
  const d = new Date(); d.setDate(d.getDate() - n);
  return isoDate(d);
}

function DailyChart({ data }: { data: { date: string; revenue: number; count?: number }[] }) {
  const w = 720;
  const h = 180;
  const pad = { l: 60, r: 20, t: 16, b: 32 };
  const innerW = w - pad.l - pad.r;
  const innerH = h - pad.t - pad.b;
  // Мгновенный hover: подсветка столбика + свой тултип (нативный <title> был
  // незаметным и с секундной задержкой — клиент его не видел).
  const [hover, setHover] = useState<number | null>(null);
  if (data.length === 0) return null;

  const max = Math.max(...data.map(d => d.revenue), 1);
  const barW = innerW / data.length;

  const yTicks = 4;
  const tickStep = max / yTicks;
  const xLabelEvery = data.length <= 7 ? 1 : data.length <= 14 ? 2 : Math.ceil(data.length / 7);
  const dLabel = (iso: string) => { const d = new Date(iso); return `${d.getDate()}.${String(d.getMonth() + 1).padStart(2, '0')}`; };

  return (
    <svg width="100%" viewBox={`0 0 ${w} ${h}`} style={{ display: 'block' }} onMouseLeave={() => setHover(null)}>
      {Array.from({ length: yTicks + 1 }).map((_, i) => {
        const v = tickStep * i;
        const y = pad.t + innerH - (v / max) * innerH;
        return (
          <g key={i}>
            <line x1={pad.l} y1={y} x2={w - pad.r} y2={y} stroke="var(--border)" strokeWidth="1" />
            <text x={pad.l - 8} y={y + 4} textAnchor="end" fill="var(--muted)" fontSize="11">
              {v >= 1_000_000 ? `${(v / 1_000_000).toFixed(1)}M` : v >= 1000 ? `${Math.round(v / 1000)}k` : Math.round(v)}
            </text>
          </g>
        );
      })}
      {data.map((v, i) => {
        const x = pad.l + i * barW + 2;
        const bw = Math.max(2, barW - 4);
        const bh = (v.revenue / max) * innerH;
        const y = pad.t + innerH - bh;
        const showLabel = (data.length - 1 - i) % xLabelEvery === 0;
        const isHover = hover === i;
        return (
          <g key={i}>
            <rect
              x={x} y={y} width={bw} height={bh}
              fill={isHover ? '#0047cc' : '#005bff'} rx="3"
              opacity={isHover ? 1 : i === data.length - 1 ? 1 : 0.78}
              stroke={isHover ? 'var(--text)' : 'none'} strokeWidth={isHover ? 1.5 : 0}
            />
            {/* невидимая hit-зона на всю высоту — легко навестись даже на короткий столбик */}
            <rect
              x={pad.l + i * barW} y={pad.t} width={barW} height={innerH}
              fill="transparent" style={{ cursor: 'pointer' }}
              onMouseEnter={() => setHover(i)}
            />
            {v.revenue > 0 && !isHover && (
              <text x={x + bw / 2} y={y - 4} textAnchor="middle" fill="var(--muted)" fontSize="9.5">
                {v.revenue >= 1_000_000 ? `${(v.revenue / 1_000_000).toFixed(1)}M` : v.revenue >= 1000 ? `${Math.round(v.revenue / 1000)}k` : Math.round(v.revenue)}
              </text>
            )}
            {showLabel && (
              <text
                x={x + barW / 2 - 2} y={h - pad.b + 16}
                textAnchor="middle" fill={isHover ? 'var(--text)' : 'var(--muted)'} fontSize="11" fontWeight={isHover ? 700 : 400}
              >
                {dLabel(v.date)}
              </text>
            )}
          </g>
        );
      })}
      {/* тултип поверх всего */}
      {hover != null && data[hover] && (() => {
        const v = data[hover];
        const tipText = `${dLabel(v.date)}: ${fmtRub(v.revenue)}${v.count != null ? ` · ${v.count} шт` : ''}`;
        const tw = Math.max(120, tipText.length * 6.6 + 16);
        const cx = pad.l + hover * barW + barW / 2;
        const tx = Math.min(Math.max(cx - tw / 2, pad.l), w - pad.r - tw);
        return (
          <g style={{ pointerEvents: 'none' }}>
            <rect x={tx} y={2} width={tw} height={24} rx="6" fill="var(--text)" opacity="0.92" />
            <text x={tx + tw / 2} y={18} textAnchor="middle" fill="var(--bg)" fontSize="12" fontWeight="600">{tipText}</text>
          </g>
        );
      })()}
    </svg>
  );
}

// Категории операций — группировка для P&L по аналогии с CSV Культуры
const CATEGORY_RULES: Array<{ key: string; label: string; match: (t: string) => boolean; color: string }> = [
  { key: 'sales',       label: 'Выручка (выкуплено)',          match: t => t.includes('AgentDeliveredToCustomer') || t.includes('DeliveredToCustomer'), color: 'var(--good)' },
  { key: 'returns',     label: 'Возвраты',                     match: t => t.includes('Return') || t.includes('Cancel'), color: 'var(--bad)' },
  { key: 'commission',  label: 'Комиссия маркетплейса',        match: t => t.includes('SaleCommission') || t.includes('MarketplaceServiceItemSaleCommission'), color: 'var(--bad)' },
  { key: 'fulfillment', label: 'Логистика и фулфилмент',       match: t => t.includes('Delivery') || t.includes('Pickup') || t.includes('CrossDocking') || t.includes('Sorting'), color: 'var(--bad)' },
  { key: 'storage',     label: 'Хранение и утилизация',        match: t => t.includes('Storage') || t.includes('Disposal') || t.includes('Stocking'), color: 'var(--bad)' },
  { key: 'packaging',   label: 'Упаковка и обработка',         match: t => t.includes('Packaging') || t.includes('Pack') || t.includes('Processing'), color: 'var(--bad)' },
  { key: 'acquiring',   label: 'Эквайринг',                    match: t => t.includes('Acquiring'), color: 'var(--bad)' },
  { key: 'advertising', label: 'Реклама',                      match: t => t.includes('Advertising') || t.includes('Promo'), color: 'var(--bad)' },
  { key: 'services',    label: 'Сервисы (бейджи и пр.)',       match: t => t.includes('Service') || t.includes('Badge') || t.includes('Premium'), color: 'var(--bad)' },
  { key: 'compensation',label: 'Компенсации',                  match: t => t.includes('Compensation'), color: 'var(--good)' },
];

function categorize(operationType: string): string {
  for (const r of CATEGORY_RULES) if (r.match(operationType)) return r.key;
  return 'other';
}

export function Finance() {
  const today = isoDate(new Date());
  const week = daysAgo(6); // -6 чтобы получить 7 дней включая сегодня (например 15-21)
  const [from, setFrom] = useState(week);
  const [to, setTo] = useState(today);

  const [totals, setTotals] = useState<OzonFinTotals['result'] | null>(null);
  const [list, setList] = useState<OzonFinList['result'] | null>(null);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const [fromCache, setFromCache] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Реальный расход на рекламу из Ozon Performance API за период. В финотчёт Ozon
  // (transaction/list) Performance НЕ попадает — биллится отдельно, поэтому
  // карточка «Реклама» из финопераций была 0. Тянем фактический расход отдельно.
  const [adSpendPerf, setAdSpendPerf] = useState<number | null>(null);

  // Чтение кэша на mount/смену периода
  useEffect(() => {
    const fromISO = dateToIsoStart(from);
    const toISO = dateToIsoEnd(to);
    const tBody = { date: { from: fromISO, to: toISO }, posting_number: '', transaction_type: 'all' };
    const lBody = { filter: { date: { from: fromISO, to: toISO }, operation_type: [], posting_number: '', transaction_type: 'all' }, page_size: 1000 };
    const tC = readFinCache<OzonFinTotals>('/v3/finance/transaction/totals', tBody);
    const lC = readFinCache<OzonFinList>('/v3/finance/transaction/list:all', lBody);
    if (tC) setTotals(tC.data.result);
    if (lC) setList(lC.data.result);
    const ts = [tC, lC].filter(Boolean).map(c => c!.fetchedAt);
    if (ts.length) {
      setFetchedAt(Math.max(...ts));
      setFromCache(true);
    } else {
      setTotals(null); setList(null); setFetchedAt(null);
    }
  }, [from, to]);

  // Фактический расход Ozon Performance за период (отдельно от финотчёта).
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await ozonGetDailyExpenses(from, to);
        const rows = r?.data?.rows ?? [];
        const sum = rows.reduce((s, row) => s + parseRu(row.moneySpent), 0);
        if (alive) setAdSpendPerf(sum);
      } catch { if (alive) setAdSpendPerf(null); }
    })();
    return () => { alive = false; };
  }, [from, to]);

  const load = async (force: boolean) => {
    setLoading(true);
    setError(null);
    try {
      const fromISO = dateToIsoStart(from);
      const toISO = dateToIsoEnd(to);
      const [tR, lR] = await Promise.all([
        ozonFinanceTotalsCached(fromISO, toISO, force),
        ozonFinanceListCached(fromISO, toISO, { pageSize: 1000 }, force),
      ]);
      setTotals(tR.data.result);
      setList(lR.data.result);
      setFromCache(tR.fromCache && lR.fromCache);
      setFetchedAt(Date.now());
    } catch (e: any) {
      setError(e?.message || 'Ошибка');
    } finally {
      setLoading(false);
    }
  };

  // Категоризация операций → разбивка как в CSV Культуры.
  // ВАЖНО: считаем по полю accruals_for_sale (валовая выручка позиции),
  // а не amount (там уже вычтены комиссии/логистика).
  const byCategory = useMemo(() => {
    if (!list?.operations) return new Map<string, { sum: number; count: number }>();
    const m = new Map<string, { sum: number; count: number }>();
    for (const r of CATEGORY_RULES) m.set(r.key, { sum: 0, count: 0 });
    m.set('other', { sum: 0, count: 0 });
    for (const op of list.operations) {
      const cat = categorize(op.operation_type);
      const cur = m.get(cat)!;
      cur.sum += op.amount || 0;
      cur.count += 1;
    }
    return m;
  }, [list]);

  // Точные суммы для KPI считаем напрямую из operations по типу транзакции:
  // type=orders → продажи (выкуплено), type=returns → возвраты выручки.
  // Это совпадает с финотчётом Ozon: «Выкуплено» и «Возвраты».
  const fromOps = useMemo(() => {
    const r = {
      revenueGross: 0,    // выкуплено (по accruals_for_sale положительные)
      returns: 0,         // возвраты выручки (отрицательные accruals)
      commission: 0,      // комиссия мп
      fulfillment: 0,     // обработка и доставка
      services: 0,        // реклама + сервисы
      advertising: 0,     // отдельно реклама
      acquiring: 0,       // эквайринг
      storage: 0,
      compensation: 0,
      other: 0,
      total: 0,
      countOrders: 0,
      countReturns: 0,
      buyoutQty: 0,
      returnQty: 0,
    };
    if (!list?.operations) return r;
    for (const op of list.operations) {
      r.total += op.amount || 0;
      const acc = op.accruals_for_sale || 0;
      const com = op.sale_commission || 0;
      const delivery = (op.delivery_charge || 0) + (op.return_delivery_charge || 0);

      if (op.type === 'orders') {
        r.revenueGross += acc;
        r.commission += com;
        r.fulfillment += delivery;
        r.countOrders += 1;
        if (op.items?.length) r.buyoutQty += op.items.length;
      } else if (op.type === 'returns') {
        r.returns += acc;
        r.commission += com;
        r.fulfillment += delivery;
        r.countReturns += 1;
        if (op.items?.length) r.returnQty += op.items.length;
      } else if (op.type === 'services') {
        r.services += op.amount || 0;
        if (/Advert|Promo/i.test(op.operation_type)) r.advertising += op.amount || 0;
        if (/Storage|Disposal/i.test(op.operation_type)) r.storage += op.amount || 0;
        if (/Acquiring/i.test(op.operation_type)) r.acquiring += op.amount || 0;
      } else if (op.type === 'compensation') {
        r.compensation += op.amount || 0;
      } else {
        r.other += op.amount || 0;
      }
    }
    return r;
  }, [list]);

  const txnTypes = useMemo(() => list ? groupOperationsByTxnType(list.operations) : {}, [list]);
  const detailGroups = useMemo(() => list ? groupOperationsByType(list.operations) : [], [list]);

  const dailyRev = useMemo(() => {
    if (!list?.operations) return [];
    const map = new Map<string, { revenue: number; count: number }>();
    const start = new Date(from);
    const end = new Date(to);
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      map.set(isoDate(d), { revenue: 0, count: 0 });
    }
    for (const op of list.operations) {
      if (op.type === 'orders') {
        const d = op.operation_date.slice(0, 10);
        const cell = map.get(d);
        if (cell) {
          cell.revenue += op.accruals_for_sale || 0;
          cell.count += op.items?.length || 1;   // штук в заказе (для тултипа)
        }
      }
    }
    return Array.from(map.entries()).map(([date, v]) => ({ date, revenue: v.revenue, count: v.count })).sort((a, b) => a.date.localeCompare(b.date));
  }, [list, from, to]);

  // P&L: ключевые цифры — из ops (точные), totals оставляем как fallback
  const revenue = fromOps.revenueGross || (totals?.accruals_for_sale ?? 0);
  const refunds = fromOps.returns || (totals?.refunds_and_cancellations ?? 0);
  const revenueNet = revenue + refunds; // выкуплено − возвраты
  const commission = fromOps.commission || (totals?.sale_commission ?? 0);
  const fulfillment = fromOps.fulfillment || (totals?.processing_and_delivery ?? 0);
  const services = fromOps.services || (totals?.services_amount ?? 0);
  const compensation = fromOps.compensation || (totals?.compensation_amount ?? 0);
  const acquiring = fromOps.acquiring;
  const storage = fromOps.storage;
  const advertising = fromOps.advertising;
  const netIncome = fromOps.total;

  const advFromList = advertising;

  const periodDays = Math.round((new Date(to).getTime() - new Date(from).getTime()) / 86400000) + 1;
  const agoLabel = fetchedAt ? fmtDateRu(new Date(fetchedAt).toISOString()) : '—';

  const adviceContext = {
    период: `${from} … ${to}`, дней: periodDays,
    выручка_выкуплено: Math.round(revenue), возвраты: Math.round(refunds), выручка_нетто: Math.round(revenueNet),
    комиссия_мп: Math.round(commission), логистика: Math.round(fulfillment), реклама: Math.round(advertising),
    эквайринг: Math.round(acquiring), хранение: Math.round(storage), итог_к_перечислению: Math.round(netIncome),
    заказов: fromOps.countOrders, возвратов_шт: fromOps.returnQty, расход_рекламы_perf: adSpendPerf != null ? Math.round(adSpendPerf) : null,
    по_дням: dailyRev.map((d) => ({ дата: d.date, выручка: Math.round(d.revenue), шт: d.count })),
    примечание: 'Финотчёт Ozon отстаёт на 1-3 дня — последние дни могут быть неполными',
  };

  return (
    <div className="grid" style={{ gap: 20 }}>
      <AiAdvice module="finance" context={adviceContext} disabled={!list} />
      <div className="row gap-8" style={{ alignItems: 'flex-start' }}>
        <CurrencyRubIcon size={16} weight="bold" style={{ color: 'var(--muted)', marginTop: 2 }} />
        <div className="muted" style={{ fontSize: 13 }}>
          Полный P&L по Ozon Finance API: выручка после возвратов, комиссии, логистика, реклама, эквайринг — те же транзакции что Ozon отдаёт в финотчёт.
        </div>
      </div>

      {/* Дата-пикер + статус */}
      <div className="card" style={{ background: 'var(--bg-3)' }}>
        <div className="flex-between" style={{ flexWrap: 'wrap', gap: 12 }}>
          <div className="row gap-12" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.3 }}>Период</span>
            <input
              type="date"
              className="input"
              value={from}
              onChange={e => setFrom(e.target.value)}
              max={to}
              style={{ width: 150, padding: '6px 8px' }}
            />
            <span className="muted">→</span>
            <input
              type="date"
              className="input"
              value={to}
              onChange={e => setTo(e.target.value)}
              min={from}
              max={today}
              style={{ width: 150, padding: '6px 8px' }}
            />
            <div className="row gap-4">
              <button className="btn btn-sm" onClick={() => { setFrom(daysAgo(6)); setTo(today); }}>7 дней</button>
              <button className="btn btn-sm" onClick={() => { setFrom(daysAgo(29)); setTo(today); }}>30 дней</button>
              <button className="btn btn-sm" onClick={() => {
                const d = new Date(); d.setDate(1);
                setFrom(isoDate(d)); setTo(today);
              }}>с начала месяца</button>
            </div>
          </div>
          <div className="row gap-8" style={{ flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <button className="btn" onClick={() => { clearFinCache(); setTotals(null); setList(null); setFetchedAt(null); }} disabled={loading}>
              Сбросить кэш
            </button>
            <button className="btn btn-primary" onClick={() => load(true)} disabled={loading}>
              <ArrowsClockwiseIcon size={14} weight="bold" className={loading ? 'spin' : ''} />
              {loading ? 'Загрузка…' : 'Обновить из API'}
            </button>
          </div>
        </div>
        <div className="muted" style={{ fontSize: 11.5, marginTop: 10 }}>
          Период <b>{fmtDateRu(dateToIsoStart(from))} — {fmtDateRu(dateToIsoEnd(to))}</b> ({periodDays} дн).
          {fetchedAt && <> · {fromCache ? '📦 из кэша' : '🟢 свежие'} · {agoLabel}</>} · кэш 30 мин.
        </div>
      </div>

      {error && (
        <div className="card" style={{ background: 'rgba(220,38,38,.08)', color: 'var(--bad)', display: 'flex', gap: 10 }}>
          <WarningIcon size={18} weight="bold" />
          <span style={{ fontSize: 13 }}>{error}</span>
        </div>
      )}

      {!fetchedAt && !loading && (
        <div className="card" style={{ background: 'var(--accent-soft)', textAlign: 'center', padding: '24px 18px' }}>
          <div style={{ fontWeight: 600, color: 'var(--accent-2)', marginBottom: 6 }}>Данных нет</div>
          <div className="muted" style={{ fontSize: 13, color: 'var(--accent-2)' }}>
            Нажми <b>«Обновить из API»</b> — подтянем транзакции из Ozon Finance API.
          </div>
        </div>
      )}

      {/* Сводка как в CSV Культуры */}
      {list && (
        <>
          <div className="card">
            <div className="flex-between" style={{ marginBottom: 16 }}>
              <h3 style={{ margin: 0 }}>Выкуп по дням (Ozon)</h3>
              <span className="muted" style={{ fontSize: 12 }}>по дате операции (operation_date)</span>
            </div>
            <DailyChart data={dailyRev} />
          </div>

          <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 12 }}>
            <div className="card kpi">
              <span className="d muted">Выкуплено</span>
              <span className="v" style={{ color: 'var(--good)' }}>{fmtRub(revenue)}</span>
              <span className="d muted" style={{ fontSize: 11 }}>{fromOps.buyoutQty} шт · {fromOps.countOrders} операций</span>
            </div>
            <div className="card kpi">
              <span className="d muted">Возвраты</span>
              <span className="v" style={{ color: 'var(--bad)' }}>{fmtRub(refunds)}</span>
              <span className="d muted" style={{ fontSize: 11 }}>{fromOps.returnQty} шт · {fromOps.countReturns} операций</span>
            </div>
            <div className="card kpi">
              <span className="d muted">Выручка (нетто)</span>
              <span className="v">{fmtRub(revenueNet)}</span>
              <span className="d muted" style={{ fontSize: 11 }}>выкуплено − возвраты</span>
            </div>
            <div className="card kpi">
              <span className="d muted">Комиссия МП</span>
              <span className="v" style={{ color: 'var(--bad)' }}>{fmtRub(commission)}</span>
            </div>
            <div className="card kpi">
              <span className="d muted">Фулфилмент</span>
              <span className="v" style={{ color: 'var(--bad)' }}>{fmtRub(fulfillment)}</span>
              <span className="d muted" style={{ fontSize: 11 }}>логистика</span>
            </div>
            <div className="card kpi">
              <span className="d muted">Реклама</span>
              <span className="v" style={{ color: 'var(--bad)' }}>
                {adSpendPerf != null ? fmtRub(-adSpendPerf) : fmtRub(advertising)}
              </span>
              <span className="d muted" style={{ fontSize: 11 }}>
                {adSpendPerf != null
                  ? <>Ozon Performance · вне финотчёта{services - advertising !== 0 ? <> · сервисы {fmtRub(services - advertising)}</> : null}</>
                  : (services - advertising !== 0 && <>+ сервисы {fmtRub(services - advertising)}</>)}
              </span>
            </div>
            <div className="card kpi">
              <span className="d muted">Эквайринг</span>
              <span className="v" style={{ color: 'var(--bad)' }}>{fmtRub(acquiring)}</span>
            </div>
            <div className="card kpi" style={{ background: netIncome >= 0 ? 'rgba(22,163,74,.08)' : 'rgba(220,38,38,.08)' }}>
              <span className="d muted">Выплата продавцу</span>
              <span className="v" style={{ color: netIncome >= 0 ? 'var(--good)' : 'var(--bad)' }}>{fmtRub(netIncome)}</span>
              <span className="d muted" style={{ fontSize: 11 }}>
                {revenue !== 0 && `${((netIncome / revenue) * 100).toFixed(1)}% от выкупленного`}
              </span>
            </div>
          </div>

          {/* P&L таблица */}
          <div className="card" style={{ padding: 0 }}>
            <div className="flex-between" style={{ padding: '14px 18px', borderBottom: '1px solid var(--border)' }}>
              <h3 style={{ margin: 0 }}>P&L · {periodDays} дн</h3>
              <span className="muted" style={{ fontSize: 12 }}>группировка по типам операций</span>
            </div>
            <table>
              <thead>
                <tr>
                  <th style={{ paddingLeft: 18 }}>Категория</th>
                  <th style={{ textAlign: 'right' }}>Сумма</th>
                  <th style={{ textAlign: 'right', paddingRight: 18 }}>Операций</th>
                </tr>
              </thead>
              <tbody>
                {CATEGORY_RULES.map(r => {
                  const v = byCategory.get(r.key);
                  if (!v || v.count === 0) return null;
                  return (
                    <tr key={r.key}>
                      <td style={{ paddingLeft: 18 }}>{r.label}</td>
                      <td style={{ textAlign: 'right', fontWeight: 600, color: v.sum < 0 ? 'var(--bad)' : v.sum > 0 ? 'var(--good)' : 'var(--text)' }}>
                        {fmtSigned(v.sum)}
                      </td>
                      <td style={{ textAlign: 'right', paddingRight: 18, color: 'var(--muted)', fontSize: 12 }}>{v.count}</td>
                    </tr>
                  );
                })}
                {byCategory.get('other')!.count > 0 && (
                  <tr>
                    <td style={{ paddingLeft: 18 }}>Прочее</td>
                    <td style={{ textAlign: 'right', fontWeight: 600, color: 'var(--muted)' }}>{fmtSigned(byCategory.get('other')!.sum)}</td>
                    <td style={{ textAlign: 'right', paddingRight: 18, color: 'var(--muted)', fontSize: 12 }}>{byCategory.get('other')!.count}</td>
                  </tr>
                )}
                <tr style={{ background: 'var(--bg-3)', fontWeight: 700 }}>
                  <td style={{ paddingLeft: 18 }}>ИТОГО (всё что прислал Ozon)</td>
                  <td style={{ textAlign: 'right', color: netIncome < 0 ? 'var(--bad)' : 'var(--good)' }}>{fmtSigned(netIncome)}</td>
                  <td style={{ textAlign: 'right', paddingRight: 18 }}>{list?.row_count ?? 0}</td>
                </tr>
              </tbody>
            </table>
          </div>

          {/* Сводка по транзакционным типам */}
          <div className="card" style={{ padding: 0 }}>
            <div className="flex-between" style={{ padding: '14px 18px', borderBottom: '1px solid var(--border)' }}>
              <h3 style={{ margin: 0 }}>По типам транзакций (Ozon)</h3>
            </div>
            <table>
              <thead>
                <tr>
                  <th style={{ paddingLeft: 18 }}>Тип</th>
                  <th style={{ textAlign: 'right' }}>Сумма</th>
                  <th style={{ textAlign: 'right', paddingRight: 18 }}>Кол-во</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(txnTypes).sort(([,a], [,b]) => a.sum - b.sum).map(([k, v]) => (
                  <tr key={k}>
                    <td style={{ paddingLeft: 18 }}>{k}</td>
                    <td style={{ textAlign: 'right', fontWeight: 600, color: v.sum < 0 ? 'var(--bad)' : v.sum > 0 ? 'var(--good)' : 'var(--text)' }}>{fmtSigned(v.sum)}</td>
                    <td style={{ textAlign: 'right', paddingRight: 18, color: 'var(--muted)', fontSize: 12 }}>{v.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Детальный список operation_type — раскрываем что внутри категорий */}
          {detailGroups.length > 0 && (
            <div className="card" style={{ padding: 0 }}>
              <div className="flex-between" style={{ padding: '14px 18px', borderBottom: '1px solid var(--border)' }}>
                <h3 style={{ margin: 0 }}>Детальная разбивка по operation_type</h3>
                <span className="muted" style={{ fontSize: 12 }}>{detailGroups.length} типов</span>
              </div>
              <div style={{ maxHeight: 480, overflowY: 'auto' }}>
                <table>
                  <thead>
                    <tr>
                      <th style={{ paddingLeft: 18 }}>Operation type</th>
                      <th style={{ textAlign: 'right' }}>Сумма</th>
                      <th style={{ textAlign: 'right', paddingRight: 18 }}>Опер.</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detailGroups.map(g => (
                      <tr key={g.type}>
                        <td style={{ paddingLeft: 18 }}>
                          <div style={{ fontWeight: 500, fontSize: 13 }}>{g.name}</div>
                          <div className="muted" style={{ fontSize: 11, fontFamily: 'ui-monospace, Menlo, monospace' }}>{g.type}</div>
                        </td>
                        <td style={{ textAlign: 'right', fontWeight: 600, color: g.sum < 0 ? 'var(--bad)' : g.sum > 0 ? 'var(--good)' : 'var(--text)' }}>{fmtSigned(g.sum)}</td>
                        <td style={{ textAlign: 'right', paddingRight: 18, color: 'var(--muted)', fontSize: 12 }}>{g.count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div className="muted" style={{ fontSize: 11.5, display: 'flex', gap: 6 }}>
            <InfoIcon size={13} weight="bold" />
            Выручка, комиссии, логистика, эквайринг, выплата — из Ozon Finance API (финотчёт).
            «Реклама» — фактический расход Ozon Performance за период (биллится отдельно от финотчёта, поэтому в «Выплату продавцу» не входит); та же цифра в разделе «Реклама».
          </div>
        </>
      )}
    </div>
  );
}
