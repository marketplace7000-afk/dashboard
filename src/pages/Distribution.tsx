/**
 * Распределение — где и сколько отгружать.
 *
 * Перерисовано: вместо 3-колоночной стены — приоритетные группы и
 * компактная карточка-поток «откуда → куда» с цифрами и обоснованием.
 */
import { useMemo, useState } from 'react';
import {
  ArrowsClockwiseIcon, CloudArrowDownIcon, WarningIcon, ArchiveIcon, ArrowUUpLeftIcon,
  PackageIcon, BoatIcon, ArrowRightIcon, CaretDownIcon, CaretRightIcon,
  FireIcon, ClockIcon, CheckCircleIcon, MinusCircleIcon, MagnifyingGlassIcon,
} from '@phosphor-icons/react';
import { useProcurement } from '../api/useProcurement';
import { useOzonTransit, useWbTransit } from '../api/useOzonTransit';
import { calcDistribution, DistResult } from '../utils/distributionLogic';
import { archiveSKU, unarchiveSKU, getArchivedSKUs } from '../utils/procurementLogic';
import { ProcurementItem } from '../api/googleSheets';
import { AiAdvice } from '../components/AiAdvice';

type Prio = DistResult['priority'];

const PRIO_META: Record<Prio, { label: string; short: string; Icon: any; color: string; bg: string; hint: string }> = {
  high:   { label: 'Срочно отгрузить', short: 'Срочно', Icon: FireIcon,        color: '#dc2626', bg: 'rgba(220,38,38,.10)', hint: 'МП кончится до прибытия следующего транзита.' },
  medium: { label: 'Скоро отгрузить',  short: 'Скоро',  Icon: ClockIcon,       color: '#d97706', bg: 'rgba(217,119,6,.10)', hint: 'Запаса на МП мало, но есть время подготовить отгрузку.' },
  low:    { label: 'Плановая отгрузка', short: 'План',  Icon: CheckCircleIcon, color: '#16a34a', bg: 'rgba(22,163,74,.10)', hint: 'Обычная плановая отгрузка из склада/транзита.' },
  none:   { label: 'Без действий',     short: 'Нет',    Icon: MinusCircleIcon, color: '#6b7280', bg: 'var(--bg-3)',         hint: 'На МП хватает — везти ничего не нужно.' },
};

const RU = (n: number) => n.toLocaleString('ru-RU');
const fmtDate = (iso: string | null | undefined) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('ru', { day: 'numeric', month: 'short' });
};
const mColor = (m: number | null) => m === null ? 'var(--muted)' : m < 0 ? 'var(--bad)' : m < 13 ? 'var(--warn)' : 'var(--good)';

function nextTransitDate(p: ProcurementItem): string | null {
  if (p.tranzitItems && p.tranzitItems.length > 0) {
    const today = Date.now();
    const future = p.tranzitItems.filter(t => t.date && new Date(t.date).getTime() >= today)
      .sort((a, b) => new Date(a.date!).getTime() - new Date(b.date!).getTime());
    if (future.length) return future[0].date!;
  }
  return p.tranzitNext?.date ?? null;
}

function SourceBlock({ p, d, source }: { p: ProcurementItem; d: DistResult; source: 'warehouse' | 'transit' }) {
  const isWh = source === 'warehouse';
  const Icon = isWh ? PackageIcon : BoatIcon;
  const total = isWh ? p.warehouseStock : p.tranzitTotal;
  const qtyO = isWh ? d.sendFromWarehouseOzon : d.sendFromTransitOzon;
  const qtyWB = isWh ? d.sendFromWarehouseWB : d.sendFromTransitWB;
  const noStock = total === 0;
  const noAction = qtyO === 0 && qtyWB === 0;
  const transitDate = !isWh ? nextTransitDate(p) : null;
  const hasAction = !noStock && !noAction;

  return (
    <div style={{
      flex: '1 1 280px',
      padding: '10px 12px',
      borderRadius: 8,
      background: hasAction ? 'rgba(37,99,235,.05)' : 'var(--bg-3)',
      border: hasAction ? '1px solid rgba(37,99,235,.18)' : '1px solid var(--border)',
      opacity: noStock ? 0.55 : 1,
    }}>
      <div className="row gap-6" style={{ marginBottom: 10, alignItems: 'baseline' }}>
        <Icon size={14} weight="bold" style={{ color: 'var(--muted)' }} />
        <strong style={{ fontSize: 13.5 }}>{isWh ? 'Наш склад' : 'Транзит из Китая'}</strong>
        <span className="muted" style={{ fontSize: 12.5 }}>· {RU(total)} шт{transitDate ? ` · ближ. ${fmtDate(transitDate)}` : ''}</span>
      </div>

      {noStock ? (
        <div className="muted" style={{ fontSize: 13, fontStyle: 'italic' }}>{isWh ? 'Склад пуст' : 'Нет транзита'}</div>
      ) : noAction ? (
        <div className="muted" style={{ fontSize: 13, fontStyle: 'italic' }}>{isWh ? 'На МП хватает — везти не нужно' : 'Когда придёт — раскладка не требуется'}</div>
      ) : (
        <div className="row gap-12" style={{ flexWrap: 'wrap' }}>
          {qtyO > 0 && (
            <div className="row gap-6" style={{ alignItems: 'center' }}>
              <ArrowRightIcon size={14} weight="bold" style={{ color: 'var(--muted)' }} />
              <span style={{ background: '#005bff', color: '#fff', fontSize: 11, fontWeight: 700, padding: '2px 9px', borderRadius: 999 }}>Ozon</span>
              <strong style={{ color: '#005bff', fontSize: 17 }}>{RU(qtyO)} шт</strong>
              <span className="muted" style={{ fontSize: 12 }}>≈{Math.round(qtyO / (p.dailyOzon || 1))} дн</span>
            </div>
          )}
          {qtyWB > 0 && (
            <div className="row gap-6" style={{ alignItems: 'center' }}>
              <ArrowRightIcon size={14} weight="bold" style={{ color: 'var(--muted)' }} />
              <span style={{ background: '#cb11ab', color: '#fff', fontSize: 11, fontWeight: 700, padding: '2px 9px', borderRadius: 999 }}>WB</span>
              <strong style={{ color: '#cb11ab', fontSize: 17 }}>{RU(qtyWB)} шт</strong>
              <span className="muted" style={{ fontSize: 12 }}>≈{Math.round(qtyWB / (p.dailyWB || 1))} дн</span>
            </div>
          )}
        </div>
      )}
      {hasAction && isWh && (
        <div className="muted" style={{ fontSize: 12, marginTop: 8, paddingTop: 8, borderTop: '1px dashed var(--border)' }}>
          После отгрузки на складе: <strong>{d.warehouseAfter}</strong> шт
        </div>
      )}
      {hasAction && !isWh && transitDate && (
        <div className="muted" style={{ fontSize: 12, marginTop: 8, paddingTop: 8, borderTop: '1px dashed var(--border)' }}>
          К отгрузке после прибытия {fmtDate(transitDate)}{d.daysToNextTransit !== null ? ` (через ${d.daysToNextTransit} дн)` : ''}
        </div>
      )}
    </div>
  );
}

function MpSummary({ label, color, stock, daily, turn, margin, blocked, transit }: {
  label: string; color: string; stock: number; daily: number; turn: number | null; margin: number | null; blocked: boolean; transit?: number;
}) {
  const turnColor = turn === null || turn <= 0 ? 'var(--bad)'
                  : turn <= 14 ? 'var(--bad)'
                  : turn <= 30 ? 'var(--warn)' : 'var(--good)';
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      <div className="row gap-8" style={{ alignItems: 'baseline', flexWrap: 'wrap' }}>
        <span style={{ background: color, color: '#fff', fontSize: 11, fontWeight: 700, padding: '2px 9px', borderRadius: 999 }}>{label}</span>
        <strong style={{ fontSize: 17 }}>{RU(stock)} шт</strong>
        <span className="muted" style={{ fontSize: 12.5 }}>{daily} шт/день</span>
        {blocked && margin !== null && margin < 0 && <span style={{ fontSize: 12, color: 'var(--bad)' }} title="Площадка убыточна — не отгружаем">🚫</span>}
      </div>
      <div className="row gap-10" style={{ fontSize: 13, alignItems: 'center', flexWrap: 'wrap' }}>
        <span>хватит на <strong style={{ color: turnColor }}>{turn !== null ? `${turn} дн` : '—'}</strong></span>
        {margin !== null && (
          <span style={{ color: mColor(margin), fontWeight: 600 }}>маржа {margin}%</span>
        )}
        {transit !== undefined && transit > 0 && (
          <span className="row gap-4" style={{ alignItems: 'center', color }} title="Едет на склад МП / на приёмке (заявки на поставку FBO)">
            <BoatIcon size={12} weight="bold" /> +{RU(transit)} едет
          </span>
        )}
      </div>
    </div>
  );
}

/** Наглядная полоса раскладки Ozon/WB — считывается быстрее, чем два процента текстом. */
function SplitBar({ ozonPct }: { ozonPct: number }) {
  const wbPct = 100 - ozonPct;
  return (
    <div style={{ display: 'grid', gap: 4, minWidth: 180 }}>
      <div style={{ display: 'flex', height: 10, borderRadius: 999, overflow: 'hidden', background: 'var(--bg-3)' }}>
        {ozonPct > 0 && <div style={{ width: `${ozonPct}%`, background: '#005bff' }} />}
        {wbPct > 0 && <div style={{ width: `${wbPct}%`, background: '#cb11ab' }} />}
      </div>
      <div className="row" style={{ justifyContent: 'space-between', fontSize: 12.5, fontWeight: 600 }}>
        <span style={{ color: '#005bff' }}>Ozon {ozonPct}%</span>
        <span style={{ color: '#cb11ab' }}>WB {wbPct}%</span>
      </div>
    </div>
  );
}

function DistRow({ p, d, expanded, onToggle, onArchive, transitOzon, transitWb }: {
  p: ProcurementItem; d: DistResult; expanded: boolean; onToggle: () => void; onArchive: () => void; transitOzon: number; transitWb: number;
}) {
  const m = PRIO_META[d.priority];
  const ozonPct = Math.round(d.splitOzon * 100);
  const sendWh = d.sendFromWarehouseOzon + d.sendFromWarehouseWB;
  const sendTr = d.sendFromTransitOzon + d.sendFromTransitWB;
  return (
    <div className="card" style={{ padding: 0, marginBottom: 10, borderLeft: `4px solid ${m.color}`, overflow: 'hidden' }}>
      <div className="row gap-14" style={{ padding: '14px 16px', cursor: 'pointer', alignItems: 'center', flexWrap: 'wrap' }} onClick={onToggle}>
        <div style={{ minWidth: 200, flex: '1 1 230px' }}>
          <div style={{ fontSize: 15, fontWeight: 700 }}>{p.sku}</div>
          <div className="muted" style={{ fontSize: 12.5, marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 280 }}>{p.name}</div>
        </div>

        <div style={{ flex: '1 1 200px', minWidth: 180, maxWidth: 280 }}>
          <SplitBar ozonPct={ozonPct} />
        </div>

        <div style={{ flex: '0 0 230px', textAlign: 'right' }}>
          {d.hasAction ? (
            <>
              <div style={{ fontSize: 16, fontWeight: 700 }}>
                Отгрузить {RU(sendWh + sendTr)} шт
              </div>
              <div className="muted" style={{ fontSize: 12.5, marginTop: 2 }}>
                {sendWh > 0 && `${RU(sendWh)} со склада`}
                {sendWh > 0 && sendTr > 0 && ' · '}
                {sendTr > 0 && `${RU(sendTr)} из транзита`}
              </div>
            </>
          ) : (
            <div className="muted" style={{ fontSize: 14 }}>
              <m.Icon size={13} weight="bold" style={{ color: m.color }} /> {m.short}
            </div>
          )}
          {d.stockoutBeforeTransit && (
            <div style={{ fontSize: 12, color: 'var(--bad)', marginTop: 3, fontWeight: 600 }}>⚠ кончится до транзита</div>
          )}
        </div>

        <div style={{ flex: '0 0 18px', color: 'var(--muted)' }}>
          {expanded ? <CaretDownIcon size={15} weight="bold" /> : <CaretRightIcon size={15} weight="bold" />}
        </div>
      </div>

      {expanded && (
        <div style={{ padding: '16px 18px', borderTop: '1px solid var(--border)', background: 'var(--bg-2)', display: 'grid', gap: 14 }}>
          <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: '.03em', color: 'var(--muted)', textTransform: 'uppercase' }}>
            📦 На складах маркетплейсов (в продаже)
          </div>
          {/* Две чётко разделённые колонки площадок: слева всё про Ozon, справа
              всё про WB — фирменная цветная полоса сверху, чтобы не путать. */}
          <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 12 }}>
            <div style={{ padding: '12px 14px', borderRadius: 10, background: 'var(--bg-3)', borderTop: '3px solid #005bff' }}>
              <MpSummary label="Ozon" color="#005bff" stock={p.stockOzon} daily={p.dailyOzon} turn={d.turnOzon} margin={p.marginOzon} blocked={d.ozonBlocked} transit={transitOzon} />
            </div>
            <div style={{ padding: '12px 14px', borderRadius: 10, background: 'var(--bg-3)', borderTop: '3px solid #cb11ab' }}>
              <MpSummary label="WB"   color="#cb11ab" stock={p.stockWB}   daily={p.dailyWB}   turn={d.turnWB}   margin={p.marginWB}   blocked={d.wbBlocked} transit={transitWb} />
            </div>
          </div>

          <div style={{ fontSize: 13, lineHeight: 1.55, padding: '10px 12px', borderRadius: 8, background: 'rgba(37,99,235,.05)', border: '1px solid rgba(37,99,235,.12)' }}>
            <strong>Почему так делим:</strong> <span className="muted" style={{ color: 'var(--text)' }}>{d.splitReasonText}</span>
          </div>

          {/* Свой склад и транзит из Китая — общие, не привязаны к площадке. */}
          <div>
            <div style={{ marginBottom: 8, fontSize: 12, fontWeight: 700, letterSpacing: '.03em', color: 'var(--muted)', textTransform: 'uppercase' }}>
              🏠 Откуда везём (общий запас)
            </div>
            <div className="row gap-12" style={{ flexWrap: 'wrap' }}>
              <SourceBlock p={p} d={d} source="warehouse" />
              <SourceBlock p={p} d={d} source="transit" />
            </div>
          </div>

          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button className="btn btn-sm" onClick={(e) => { e.stopPropagation(); onArchive(); }}>
              <ArchiveIcon size={11} weight="bold" /> В архив
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// Поставки на склад WB (FBW) — журнал отгрузок с датами и статусом приёмки.
// Источник — /api/wb-supplies (supplies-api; старый statistics/incomes удалён WB).
type WbSupplyRow = {
  supplyID: number; createDate: string; supplyDate: string; factDate: string | null;
  statusID: number; status: string; boxType: string; units: number | null; positions: number | null;
};
function WbSuppliesCard() {
  const [rows, setRows] = useState<WbSupplyRow[]>([]);
  const [total, setTotal] = useState({ units: 0, count: 0 });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const load = async (force = false) => {
    setLoading(true); setError(null);
    try {
      const r = await fetch('/api/wb-supplies', { credentials: 'include', headers: force ? { 'x-av-no-cache': '1' } : {} });
      const j = await r.json();
      if (!r.ok || j.error) throw new Error(j.detail || j.error || `HTTP ${r.status}`);
      setRows(Array.isArray(j.supplies) ? j.supplies : []);
      setTotal({ units: j.totalUnits || 0, count: j.count || 0 });
    } catch (e: any) { setError(e?.message || 'Ошибка'); }
    finally { setLoading(false); }
  };
  useMemo(() => { if (open && rows.length === 0) load(); /* eslint-disable-next-line */ }, [open]);

  return (
    <div className="card" style={{ background: 'var(--bg-2)' }}>
      <div className="flex-between" style={{ cursor: 'pointer', flexWrap: 'wrap', gap: 8 }} onClick={() => setOpen(o => !o)}>
        <div className="row gap-8">
          {open ? <CaretDownIcon size={14} weight="bold" /> : <CaretRightIcon size={14} weight="bold" />}
          <BoatIcon size={16} weight="bold" style={{ color: 'var(--accent)' }} />
          <strong style={{ fontSize: 14 }}>Поставки на склад WB (за 30 дней)</strong>
          {total.count > 0 && <span className="muted" style={{ fontSize: 12 }}>· {total.count} поставок · {RU(total.units)} шт</span>}
        </div>
        <button className="btn btn-sm" onClick={(e) => { e.stopPropagation(); setOpen(true); load(true); }} disabled={loading}>
          <ArrowsClockwiseIcon size={12} weight="bold" className={loading ? 'spin' : ''} /> {loading ? 'Загрузка…' : 'Обновить'}
        </button>
      </div>

      {open && (
        <div style={{ marginTop: 12 }}>
          {error && <div style={{ color: 'var(--bad)', fontSize: 13, marginBottom: 8 }}><WarningIcon size={14} weight="bold" /> {error}</div>}
          {!error && rows.length === 0 && (
            <div className="muted" style={{ fontSize: 13, padding: 12 }}>{loading ? 'Загружаем…' : 'Поставок за период нет (или данные прогреваются сборщиком).'}</div>
          )}
          {rows.length > 0 && (
            <div style={{ overflowX: 'auto' }}>
              <table className="table" style={{ fontSize: 12.5 }}>
                <thead><tr>
                  <th>Создана</th><th>Плановая дата</th><th className="right">Кол-во</th><th className="right">Позиций</th><th>Тип</th><th>Статус</th>
                </tr></thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.supplyID}>
                      <td>{fmtDate(r.createDate)}</td>
                      <td>{fmtDate(r.supplyDate)}{r.factDate ? <span className="muted"> · принято {fmtDate(r.factDate)}</span> : ''}</td>
                      <td className="right">{r.units != null ? <b>{RU(r.units)}</b> : <span className="muted">—</span>}</td>
                      <td className="right">{r.positions != null ? RU(r.positions) : '—'}</td>
                      <td className="muted">{r.boxType}</td>
                      <td>{r.status === 'Принято'
                        ? <span className="chip good"><CheckCircleIcon size={10} weight="bold" /> {r.status}</span>
                        : <span className="chip">{r.status || '—'}</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>
            Источник — WB Supplies API <code>/api/v1/supplies</code>. Количество показано по последним 25 поставкам · прогревается сборщиком.
          </div>
        </div>
      )}
    </div>
  );
}

export function Distribution() {
  const { items, loading, error, reload } = useProcurement();
  const { transitFor: transitOzonFor, data: transitData } = useOzonTransit();
  const { transitFor: transitWbFor, data: transitWbData } = useWbTransit();
  const [targetDays, setTargetDays] = useState(30);
  const [shipmentDays, setShipmentDays] = useState(8);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | Prio>('all');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [showArchive, setShowArchive] = useState(false);
  const [archiveTick, setArchiveTick] = useState(0);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<Prio>>(new Set(['low', 'none']));

  const archived = useMemo(() => getArchivedSKUs('distribution'), [archiveTick]);

  const data = useMemo(() => items
    // Показываем товар, если он где-то есть/движется: остаток на МП (Ozon/WB),
    // наш склад, транзит из Китая или продажи. Раньше остаток на самих МП не
    // учитывался — актуальные товары в наличии на Ozon/WB без продаж выпадали
    // («товары не все»). Клиент: показывать все, что в наличии.
    .filter(p => !archived.includes(p.sku) &&
      (p.dailyTotal > 0 || p.tranzitTotal > 0 || p.warehouseStock > 0 || p.stockOzon > 0 || p.stockWB > 0))
    .map(p => ({ p, d: calcDistribution(p, targetDays, shipmentDays) })),
    [items, archived, targetDays, shipmentDays]);

  const archivedData = useMemo(() => items.filter(p => archived.includes(p.sku)), [items, archived]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return data.filter(({ p, d }) => {
      const matchQ = !q || p.sku.toLowerCase().includes(q) || p.name.toLowerCase().includes(q);
      const matchF = filter === 'all' || d.priority === filter;
      return matchQ && matchF;
    });
  }, [data, search, filter]);

  const groups = useMemo(() => {
    const m: Record<Prio, typeof filtered> = { high: [], medium: [], low: [], none: [] };
    for (const it of filtered) m[it.d.priority].push(it);
    return m;
  }, [filtered]);

  const counts = useMemo(() => {
    const c: Record<Prio, number> = { high: 0, medium: 0, low: 0, none: 0 };
    for (const { d } of data) c[d.priority]++;
    return c;
  }, [data]);

  const totalSend = useMemo(() => ({
    ozon: data.reduce((s, x) => s + x.d.sendFromWarehouseOzon, 0),
    wb: data.reduce((s, x) => s + x.d.sendFromWarehouseWB, 0),
  }), [data]);

  const adviceContext = useMemo(() => ({
    срочно: counts.high, скоро: counts.medium,
    отгрузить_ozon_со_склада: totalSend.ozon, отгрузить_wb_со_склада: totalSend.wb,
    транзит_ozon_всего: transitData?.totalUnits ?? 0,
    транзит_wb_всего: transitWbData?.totalUnits ?? 0,
    строки: data.slice(0, 25).map(({ p, d }) => ({
      sku: p.sku, приоритет: d.priority,
      ozon_ост: p.stockOzon, ozon_дней: d.turnOzon, wb_ост: p.stockWB, wb_дней: d.turnWB,
      транзит_ozon: transitOzonFor(p.sku), транзит_wb: transitWbFor(p.sku), наш_склад: p.warehouseStock, транзит_китай: p.tranzitTotal,
      отгрузить_ozon: d.sendFromWarehouseOzon, отгрузить_wb: d.sendFromWarehouseWB,
      кончится_до_транзита: d.stockoutBeforeTransit,
    })),
  }), [data, counts, totalSend, transitData, transitWbData, transitOzonFor, transitWbFor]);

  const toggleExpand = (sku: string) => {
    setExpanded(prev => { const next = new Set(prev); if (next.has(sku)) next.delete(sku); else next.add(sku); return next; });
  };
  const toggleGroup = (p: Prio) => {
    setCollapsedGroups(prev => { const next = new Set(prev); if (next.has(p)) next.delete(p); else next.add(p); return next; });
  };
  const onArchive = (sku: string) => {
    // Хранилище браузера могло переполниться — раньше запись падала молча.
    if (!archiveSKU(sku, 'distribution')) {
      alert('Не удалось сохранить: в браузере кончилось место. Обновите страницу и попробуйте снова.');
      return;
    }
    setArchiveTick(t => t + 1);
  };
  const onUnarchive = (sku: string) => { unarchiveSKU(sku, 'distribution'); setArchiveTick(t => t + 1); };

  return (
    <div className="grid" style={{ gap: 18 }}>
      <div className="flex-between" style={{ flexWrap: 'wrap', gap: 10 }}>
        <div className="muted" style={{ fontSize: 13 }}>
          Куда и сколько везти со склада/транзита · группировка по срочности
        </div>
        <button className="btn btn-primary" onClick={reload} disabled={loading}>
          {loading ? <ArrowsClockwiseIcon className="spin" size={14} weight="bold" /> : <CloudArrowDownIcon size={14} weight="bold" />}
          {loading ? 'Загрузка…' : 'Обновить'}
        </button>
      </div>

      <WbSuppliesCard />

      <AiAdvice module="distribution" context={adviceContext} disabled={data.length === 0} />

      {error && (
        <div className="card" style={{ background: 'rgba(220,38,38,.08)', color: 'var(--bad)', display: 'flex', gap: 10, alignItems: 'center' }}>
          <WarningIcon size={18} weight="bold" />
          <span style={{ fontSize: 13 }}>{error}</span>
        </div>
      )}

      <div className="card" style={{ padding: '10px 14px' }}>
        <div className="row gap-16" style={{ flexWrap: 'wrap', alignItems: 'center', fontSize: 12.5 }}>
          <strong style={{ fontSize: 12, color: 'var(--muted)', textTransform: 'uppercase' }}>Параметры</strong>
          <label className="row gap-6">
            <span className="muted">Целевой запас на МП</span>
            <input type="number" className="input" style={{ width: 56, padding: '4px 6px', fontSize: 12, textAlign: 'center' }}
                   value={targetDays} onChange={e => setTargetDays(parseInt(e.target.value) || 30)} />
            <span className="muted" style={{ fontSize: 11 }}>дн</span>
          </label>
          <label className="row gap-6">
            <span className="muted">Окно отгрузок</span>
            <input type="number" className="input" style={{ width: 56, padding: '4px 6px', fontSize: 12, textAlign: 'center' }}
                   value={shipmentDays} onChange={e => setShipmentDays(parseInt(e.target.value) || 8)} />
            <span className="muted" style={{ fontSize: 11 }}>дн</span>
          </label>
        </div>
      </div>

      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10 }}>
        {(['high', 'medium', 'low', 'none'] as Prio[]).map(prio => {
          const m = PRIO_META[prio];
          return (
            <button key={prio} className="card kpi" style={{ textAlign: 'left', cursor: 'pointer', font: 'inherit', color: 'inherit', border: filter === prio ? `1px solid ${m.color}` : '1px solid transparent' }}
                    onClick={() => setFilter(filter === prio ? 'all' : prio)}>
              <span className="d muted"><m.Icon size={11} weight="bold" style={{ color: m.color }} /> {m.short}</span>
              <span className="v" style={{ color: m.color }}>{counts[prio]}</span>
            </button>
          );
        })}
        <div className="card kpi">
          <span className="d muted">→ Ozon (со склада)</span>
          <span className="v" style={{ color: '#005bff' }}>{RU(totalSend.ozon)} шт</span>
        </div>
        <div className="card kpi">
          <span className="d muted">→ WB (со склада)</span>
          <span className="v" style={{ color: '#cb11ab' }}>{RU(totalSend.wb)} шт</span>
        </div>
        {transitData && transitData.totalUnits > 0 && (
          <div className="card kpi" title="Товары в пути на склад Ozon и на приёмке (заявки FBO) — ещё не в продаже">
            <span className="d muted"><BoatIcon size={11} weight="bold" /> В транзите на Ozon</span>
            <span className="v" style={{ color: '#005bff' }}>{RU(transitData.totalUnits)} шт</span>
          </div>
        )}
        {transitWbData && transitWbData.totalUnits > 0 && (
          <div className="card kpi" title="Товары в пути на склад WB и на приёмке (поставки FBW) — ещё не в продаже">
            <span className="d muted"><BoatIcon size={11} weight="bold" /> В транзите на WB</span>
            <span className="v" style={{ color: '#cb11ab' }}>{RU(transitWbData.totalUnits)} шт</span>
          </div>
        )}
      </div>

      <div className="row gap-10" style={{ flexWrap: 'wrap' }}>
        <div style={{ position: 'relative', width: 280 }}>
          <MagnifyingGlassIcon size={14} weight="bold" style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted)' }} />
          <input type="text" className="input" placeholder="SKU, название…"
                 value={search} onChange={e => setSearch(e.target.value)}
                 style={{ width: '100%', paddingLeft: 30 }} />
        </div>
        {filter !== 'all' && (
          <button className="btn btn-sm" onClick={() => setFilter('all')}>
            Сбросить «{PRIO_META[filter as Prio].short}»
          </button>
        )}
      </div>

      <div>
        {(['high', 'medium', 'low', 'none'] as Prio[]).map(prio => {
          const items = groups[prio];
          if (items.length === 0) return null;
          const m = PRIO_META[prio];
          const isCollapsed = collapsedGroups.has(prio);
          return (
            <div key={prio} style={{ marginBottom: 18 }}>
              <div className="row" style={{ gap: 10, padding: '12px 16px', background: m.bg, borderRadius: 10, cursor: 'pointer', marginBottom: 10, alignItems: 'center' }}
                   onClick={() => toggleGroup(prio)}>
                {isCollapsed ? <CaretRightIcon size={15} weight="bold" /> : <CaretDownIcon size={15} weight="bold" />}
                <m.Icon size={17} weight="fill" style={{ color: m.color }} />
                <strong style={{ fontSize: 15.5, color: m.color }}>{m.label}</strong>
                <span className="muted" style={{ fontSize: 13 }}>· {items.length} SKU</span>
                <span className="muted" style={{ fontSize: 12.5, marginLeft: 'auto', maxWidth: 380, textAlign: 'right' }}>{m.hint}</span>
              </div>
              {!isCollapsed && items.map(({ p, d }) => (
                <DistRow key={p.sku} p={p} d={d}
                         transitOzon={transitOzonFor(p.sku)}
                         transitWb={transitWbFor(p.sku)}
                         expanded={expanded.has(p.sku)}
                         onToggle={() => toggleExpand(p.sku)}
                         onArchive={() => onArchive(p.sku)} />
              ))}
            </div>
          );
        })}

        {filtered.length === 0 && !loading && (
          <div className="card" style={{ textAlign: 'center', color: 'var(--muted)', padding: 40 }}>
            Нет позиций по выбранным фильтрам
          </div>
        )}
      </div>

      <div>
        <button className="btn btn-sm" onClick={() => setShowArchive(s => !s)}
                style={{ background: 'transparent', border: 'none', color: 'var(--muted)', padding: '6px 0' }}>
          {showArchive ? <CaretDownIcon size={12} weight="bold" /> : <CaretRightIcon size={12} weight="bold" />}
          Архив ({archivedData.length})
        </button>
        {showArchive && archivedData.length > 0 && (
          <div className="card" style={{ padding: 0, marginTop: 8 }}>
            <table>
              <thead>
                <tr>
                  <th style={{ paddingLeft: 18 }}>SKU / Товар</th>
                  <th>Склад</th>
                  <th style={{ textAlign: 'center', paddingRight: 18 }}>Действия</th>
                </tr>
              </thead>
              <tbody>
                {archivedData.map(p => (
                  <tr key={p.sku} style={{ opacity: 0.7 }}>
                    <td style={{ paddingLeft: 18 }}>
                      <div style={{ fontWeight: 600 }}>{p.sku}</div>
                      <div className="muted" style={{ fontSize: 12 }}>{p.name}</div>
                    </td>
                    <td>{p.warehouseStock} шт</td>
                    <td style={{ textAlign: 'center', paddingRight: 18 }}>
                      <button className="btn btn-sm" onClick={() => onUnarchive(p.sku)}>
                        <ArrowUUpLeftIcon size={12} weight="bold" /> Вернуть
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
