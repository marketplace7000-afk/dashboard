/**
 * Маржинальность — динамика по неделям, группировка по severity.
 *
 * Компактная строка-сводка (SKU + sparkline по Ozon и WB + Δ-неделя) с
 * разворотом в полную таблицу недель.
 */
import { useMemo, useState } from 'react';
import {
  ArrowsClockwiseIcon, CloudArrowDownIcon, WarningIcon, ArchiveIcon, ArrowUUpLeftIcon,
  TrendUpIcon, TrendDownIcon, MinusIcon, CaretDownIcon, CaretRightIcon, MagnifyingGlassIcon,
  FireIcon, ClockIcon, CheckCircleIcon,
} from '@phosphor-icons/react';
import { useProcurement } from '../api/useProcurement';
import { calcTrend, getSeverity, getChipClass, Severity } from '../utils/marginLogic';
import { archiveSKU, unarchiveSKU, getArchivedSKUs } from '../utils/procurementLogic';
import { roiStatus, ROI_STATUS_COLOR } from '../utils/roiLogic';
import { ProcurementItem } from '../api/googleSheets';

type GroupKey = Exclude<Severity, 'none'>;

const SEV_META: Record<GroupKey, { label: string; short: string; Icon: any; color: string; bg: string; hint: string }> = {
  danger:  { label: 'Маржа падает / в минусе', short: 'Падает',   Icon: FireIcon,        color: '#dc2626', bg: 'rgba(220,38,38,.10)', hint: '2+ недели подряд снижение или маржа ушла в минус.' },
  warning: { label: 'Требует внимания',         short: 'Внимание', Icon: ClockIcon,       color: '#d97706', bg: 'rgba(217,119,6,.10)', hint: 'Резкое снижение на последней неделе или маржа < 10%.' },
  ok:      { label: 'В норме',                  short: 'Норма',    Icon: CheckCircleIcon, color: '#16a34a', bg: 'rgba(22,163,74,.10)', hint: 'Маржа стабильна или растёт.' },
};

const CHIP: Record<string, { bg: string; color: string }> = {
  pos: { bg: 'rgba(22,163,74,.10)', color: 'var(--good)' },
  warn: { bg: 'rgba(217,119,6,.10)', color: 'var(--warn)' },
  neg: { bg: 'rgba(220,38,38,.10)', color: 'var(--bad)' },
  neutral: { bg: 'var(--bg-3)', color: 'var(--muted)' },
};

function deltaArrow(d: number) {
  if (d > 2) return <TrendUpIcon size={13} weight="bold" style={{ color: 'var(--good)' }} />;
  if (d < -2) return <TrendDownIcon size={13} weight="bold" style={{ color: 'var(--bad)' }} />;
  return <MinusIcon size={13} weight="bold" style={{ color: 'var(--muted)' }} />;
}

/** SVG-sparkline по значениям маржи. */
function Sparkline({ values, color, width = 90, height = 28 }: { values: (number | null)[]; color: string; width?: number; height?: number }) {
  const pts = values.map((v, i) => ({ i, v })).filter(p => p.v !== null) as { i: number; v: number }[];
  if (pts.length < 2) return <div style={{ width, height, fontSize: 10, color: 'var(--muted)' }}>—</div>;
  const min = Math.min(0, ...pts.map(p => p.v));
  const max = Math.max(...pts.map(p => p.v));
  const range = (max - min) || 1;
  const stepX = width / Math.max(1, values.length - 1);
  const toY = (v: number) => height - 2 - ((v - min) / range) * (height - 4);
  const path = pts.map((p, idx) => `${idx === 0 ? 'M' : 'L'} ${p.i * stepX} ${toY(p.v)}`).join(' ');
  const zeroLineY = min < 0 ? toY(0) : null;
  const last = pts[pts.length - 1];
  return (
    <svg width={width} height={height} style={{ flexShrink: 0 }}>
      {zeroLineY !== null && (
        <line x1={0} y1={zeroLineY} x2={width} y2={zeroLineY} stroke="rgba(220,38,38,.35)" strokeDasharray="2 2" strokeWidth={0.8} />
      )}
      <path d={path} stroke={color} strokeWidth={1.6} fill="none" />
      <circle cx={last.i * stepX} cy={toY(last.v)} r={2.4} fill={color} />
    </svg>
  );
}

function ValueChip({ value, delta }: { value: number | null; delta: number | null }) {
  const cls = getChipClass(value);
  const style = CHIP[cls];
  if (value === null) return <span style={{ ...style, padding: '2px 7px', borderRadius: 5, fontSize: 11.5 }}>—</span>;
  return (
    <span style={{ background: style.bg, color: style.color, padding: '2px 7px', borderRadius: 5, fontSize: 11.5, fontWeight: 600 }}>
      {value}%{delta !== null && <span style={{ fontSize: 10, opacity: 0.75, marginLeft: 3 }}>{delta > 0 ? '+' : ''}{delta}%</span>}
    </span>
  );
}

function MpInline({ label, color, current, delta, sparklineVals }: {
  label: string; color: string; current: number | null; delta: number | null; sparklineVals: (number | null)[];
}) {
  return (
    <div className="row gap-6" style={{ alignItems: 'center', flex: '1 1 auto', minWidth: 200 }}>
      <span style={{ background: color, color: '#fff', fontSize: 10.5, fontWeight: 700, padding: '2px 8px', borderRadius: 999 }}>{label}</span>
      <strong style={{ fontSize: 14, color: current !== null && current < 0 ? 'var(--bad)' : 'var(--text)' }}>
        {current !== null ? `${current}%` : '—'}
      </strong>
      {delta !== null && (
        <span className="row gap-2" style={{ fontSize: 11.5 }}>
          {deltaArrow(delta)}
          <span style={{ color: delta < 0 ? 'var(--bad)' : delta > 0 ? 'var(--good)' : 'var(--muted)' }}>{delta > 0 ? '+' : ''}{delta}%</span>
        </span>
      )}
      <Sparkline values={sparklineVals} color={color} />
    </div>
  );
}

function MarginRow({ p, expanded, onToggle, onArchive }: {
  p: ProcurementItem; expanded: boolean; onToggle: () => void; onArchive: () => void;
}) {
  const weeks = p.marginHistory || [];
  const tO = calcTrend(weeks, 'o');
  const tWB = calcTrend(weeks, 'wb');
  const valsO = weeks.map(w => w.o);
  const valsWB = weeks.map(w => w.wb);

  const sev = getSeverity(p) as GroupKey;
  const alertMsg =
    sev === 'danger' && tO && tO.downStreak >= 2 ? `Ozon: падение ${tO.downStreak} нед. подряд`
    : sev === 'danger' && tWB && tWB.downStreak >= 2 ? `WB: падение ${tWB.downStreak} нед. подряд`
    : sev === 'danger' && (p.marginOzon ?? 1) < 0 ? `Ozon: маржа ушла в минус`
    : sev === 'danger' && (p.marginWB ?? 1) < 0 ? `WB: маржа ушла в минус`
    : sev === 'warning' ? `Резкое снижение на последней неделе`
    : '';

  return (
    <div className="card" style={{ padding: 0, marginBottom: 8 }}>
      <div className="row gap-12" style={{ padding: '12px 14px', cursor: 'pointer', alignItems: 'center', flexWrap: 'wrap' }} onClick={onToggle}>
        <div style={{ minWidth: 200, flex: '1 1 220px' }}>
          <div style={{ fontSize: 13, fontWeight: 700 }}>{p.sku}</div>
          <div className="muted" style={{ fontSize: 12, marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 260 }}>{p.name}</div>
          {alertMsg && (
            <div style={{ fontSize: 11, color: SEV_META[sev].color, marginTop: 4 }}>⚠ {alertMsg}</div>
          )}
        </div>

        <MpInline label="Ozon" color="#005bff" current={p.marginOzon ?? null} delta={tO ? tO.delta : null} sparklineVals={valsO} />
        <MpInline label="WB"   color="#cb11ab" current={p.marginWB ?? null}   delta={tWB ? tWB.delta : null} sparklineVals={valsWB} />

        <div style={{ flex: '0 0 18px', color: 'var(--muted)' }}>
          {expanded ? <CaretDownIcon size={14} weight="bold" /> : <CaretRightIcon size={14} weight="bold" />}
        </div>
      </div>

      {expanded && (
        <div style={{ padding: '12px 14px', borderTop: '1px solid var(--border)', background: 'var(--bg-2)', display: 'grid', gap: 12 }}>
          {p.purchasePrice > 0 && (() => {
            const ro = roiStatus(p.roiOzon ?? null, p.purchasePrice);
            const rw = roiStatus(p.roiWB ?? null, p.purchasePrice);
            const show = ro.status !== 'none' || rw.status !== 'none';
            if (!show) return null;
            const render = (label: string, color: string, r: typeof ro) => {
              const st = ROI_STATUS_COLOR[r.status];
              if (r.status === 'none') return null;
              return (
                <div key={label} className="row gap-8" style={{ fontSize: 12, flexWrap: 'wrap' }}>
                  <span style={{ color, fontWeight: 600, minWidth: 32 }}>{label}</span>
                  <strong>ROI {r.roi}%</strong>
                  {r.bucket && <span className="muted" style={{ fontSize: 11 }}>цель {r.bucket.target}% · стоп {r.bucket.stopBuy}% · выход {r.bucket.exit}%</span>}
                  <span style={{ background: st.bg, color: st.color, padding: '2px 8px', borderRadius: 999, fontWeight: 600 }} title={r.hint}>{r.label}</span>
                </div>
              );
            };
            return (
              <div style={{ background: 'var(--bg-3)', borderRadius: 6, padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 4 }}>
                {render('Ozon', '#005bff', ro)}
                {render('WB', '#cb11ab', rw)}
              </div>
            );
          })()}

          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left', fontSize: 10, color: 'var(--muted)', padding: '4px 6px', borderBottom: '1px solid var(--border)' }}>Неделя</th>
                  <th style={{ textAlign: 'center', fontSize: 10, color: '#005bff', padding: '4px 6px', borderBottom: '1px solid var(--border)' }}>Ozon</th>
                  <th style={{ textAlign: 'center', fontSize: 10, color: '#cb11ab', padding: '4px 6px', borderBottom: '1px solid var(--border)' }}>WB</th>
                </tr>
              </thead>
              <tbody>
                {weeks.map((w, i) => {
                  const isLast = i === weeks.length - 1;
                  const prevO = i > 0 ? weeks[i - 1].o : null;
                  const prevW = i > 0 ? weeks[i - 1].wb : null;
                  const dO = w.o !== null && prevO !== null ? Math.round((w.o - prevO) * 10) / 10 : null;
                  const dW = w.wb !== null && prevW !== null ? Math.round((w.wb - prevW) * 10) / 10 : null;
                  return (
                    <tr key={w.w} style={{ fontWeight: isLast ? 700 : 400 }}>
                      <td style={{ textAlign: 'left', fontSize: 11, color: 'var(--muted)', padding: '4px 6px' }}>
                        {isLast ? '▶ ' : ''}{w.w}
                      </td>
                      <td style={{ textAlign: 'center', padding: '4px 6px' }}><ValueChip value={w.o} delta={dO} /></td>
                      <td style={{ textAlign: 'center', padding: '4px 6px' }}><ValueChip value={w.wb} delta={dW} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
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

export function MarginAnalytics() {
  const { items, loading, error, reload } = useProcurement();
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | GroupKey>('all');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [showArchive, setShowArchive] = useState(false);
  const [archiveTick, setArchiveTick] = useState(0);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<GroupKey>>(new Set(['ok']));

  const archived = useMemo(() => getArchivedSKUs('margins'), [archiveTick]);
  const withHistory = useMemo(() => items.filter(p => p.marginHistory && p.marginHistory.length > 0), [items]);
  const active = withHistory.filter(p => !archived.includes(p.sku));
  const archivedList = withHistory.filter(p => archived.includes(p.sku));

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return active.filter(p => {
      const matchQ = !q || p.sku.toLowerCase().includes(q) || p.name.toLowerCase().includes(q);
      const sev = getSeverity(p) as GroupKey;
      const matchF = filter === 'all' || sev === filter;
      return matchQ && matchF;
    });
  }, [active, search, filter]);

  const groups = useMemo(() => {
    const m: Record<GroupKey, ProcurementItem[]> = { danger: [], warning: [], ok: [] };
    for (const p of filtered) {
      const sev = getSeverity(p) as GroupKey;
      m[sev].push(p);
    }
    return m;
  }, [filtered]);

  const counts = useMemo(() => {
    const c: Record<GroupKey, number> = { danger: 0, warning: 0, ok: 0 };
    for (const p of active) {
      const sev = getSeverity(p) as GroupKey;
      c[sev]++;
    }
    return c;
  }, [active]);

  const avgMargin = useMemo(() => {
    const vO: number[] = [], vW: number[] = [];
    for (const p of active) {
      if (p.marginOzon !== null && p.marginOzon !== undefined) vO.push(p.marginOzon);
      if (p.marginWB !== null && p.marginWB !== undefined) vW.push(p.marginWB);
    }
    const avg = (arr: number[]) => arr.length ? Math.round((arr.reduce((s, x) => s + x, 0) / arr.length) * 10) / 10 : null;
    return { ozon: avg(vO), wb: avg(vW) };
  }, [active]);

  const toggleExpand = (sku: string) => {
    setExpanded(prev => { const next = new Set(prev); if (next.has(sku)) next.delete(sku); else next.add(sku); return next; });
  };
  const toggleGroup = (g: GroupKey) => {
    setCollapsedGroups(prev => { const next = new Set(prev); if (next.has(g)) next.delete(g); else next.add(g); return next; });
  };
  const onArchive = (sku: string) => {
    // Хранилище браузера могло переполниться — раньше запись падала молча.
    if (!archiveSKU(sku, 'margins')) {
      alert('Не удалось сохранить: в браузере кончилось место. Обновите страницу и попробуйте снова.');
      return;
    }
    setArchiveTick(t => t + 1);
  };
  const onUnarchive = (sku: string) => { unarchiveSKU(sku, 'margins'); setArchiveTick(t => t + 1); };

  return (
    <div className="grid" style={{ gap: 18 }}>
      <div className="flex-between" style={{ flexWrap: 'wrap', gap: 10 }}>
        <div className="muted" style={{ fontSize: 13 }}>
          История маржи по неделям · группировка по уровню сигнала
        </div>
        <button className="btn btn-primary" onClick={reload} disabled={loading}>
          {loading ? <ArrowsClockwiseIcon className="spin" size={14} weight="bold" /> : <CloudArrowDownIcon size={14} weight="bold" />}
          {loading ? 'Загрузка…' : 'Обновить'}
        </button>
      </div>

      {error && (
        <div className="card" style={{ background: 'rgba(220,38,38,.08)', color: 'var(--bad)', display: 'flex', gap: 10, alignItems: 'center' }}>
          <WarningIcon size={18} weight="bold" />
          <span style={{ fontSize: 13 }}>{error}</span>
        </div>
      )}

      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10 }}>
        {(['danger', 'warning', 'ok'] as GroupKey[]).map(g => {
          const m = SEV_META[g];
          return (
            <button key={g} className="card kpi" style={{ textAlign: 'left', cursor: 'pointer', font: 'inherit', color: 'inherit', border: filter === g ? `1px solid ${m.color}` : '1px solid transparent' }}
                    onClick={() => setFilter(filter === g ? 'all' : g)}>
              <span className="d muted"><m.Icon size={11} weight="bold" style={{ color: m.color }} /> {m.short}</span>
              <span className="v" style={{ color: m.color }}>{counts[g]}</span>
            </button>
          );
        })}
        <div className="card kpi">
          <span className="d muted">Ср. маржа Ozon</span>
          <span className="v" style={{ color: '#005bff' }}>{avgMargin.ozon !== null ? `${avgMargin.ozon}%` : '—'}</span>
        </div>
        <div className="card kpi">
          <span className="d muted">Ср. маржа WB</span>
          <span className="v" style={{ color: '#cb11ab' }}>{avgMargin.wb !== null ? `${avgMargin.wb}%` : '—'}</span>
        </div>
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
            Сбросить «{SEV_META[filter as GroupKey].short}»
          </button>
        )}
      </div>

      <div>
        {(['danger', 'warning', 'ok'] as GroupKey[]).map(g => {
          const items = groups[g];
          if (items.length === 0) return null;
          const m = SEV_META[g];
          const isCollapsed = collapsedGroups.has(g);
          return (
            <div key={g} style={{ marginBottom: 18 }}>
              <div className="row" style={{ gap: 10, padding: '10px 14px', background: m.bg, borderRadius: 8, cursor: 'pointer', marginBottom: 8 }}
                   onClick={() => toggleGroup(g)}>
                {isCollapsed ? <CaretRightIcon size={14} weight="bold" /> : <CaretDownIcon size={14} weight="bold" />}
                <m.Icon size={15} weight="fill" style={{ color: m.color }} />
                <strong style={{ fontSize: 14, color: m.color }}>{m.label}</strong>
                <span className="muted" style={{ fontSize: 12 }}>· {items.length} SKU</span>
                <span className="muted" style={{ fontSize: 11.5, marginLeft: 'auto', maxWidth: 360, textAlign: 'right' }}>{m.hint}</span>
              </div>
              {!isCollapsed && items.map(p => (
                <MarginRow key={p.sku} p={p}
                           expanded={expanded.has(p.sku)}
                           onToggle={() => toggleExpand(p.sku)}
                           onArchive={() => onArchive(p.sku)} />
              ))}
            </div>
          );
        })}

        {filtered.length === 0 && !loading && (
          <div className="card" style={{ textAlign: 'center', color: 'var(--muted)', padding: 40 }}>
            Нет товаров с историей маржи
          </div>
        )}
      </div>

      <div>
        <button className="btn btn-sm" onClick={() => setShowArchive(s => !s)}
                style={{ background: 'transparent', border: 'none', color: 'var(--muted)', padding: '6px 0' }}>
          {showArchive ? <CaretDownIcon size={12} weight="bold" /> : <CaretRightIcon size={12} weight="bold" />}
          Архив ({archivedList.length})
        </button>
        {showArchive && archivedList.length > 0 && (
          <div className="card" style={{ padding: 0, marginTop: 8 }}>
            <table>
              <thead>
                <tr>
                  <th style={{ paddingLeft: 18 }}>SKU / Товар</th>
                  <th style={{ textAlign: 'center' }}>Ozon</th>
                  <th style={{ textAlign: 'center' }}>WB</th>
                  <th style={{ textAlign: 'center', paddingRight: 18 }}>Действия</th>
                </tr>
              </thead>
              <tbody>
                {archivedList.map(p => (
                  <tr key={p.sku} style={{ opacity: 0.7 }}>
                    <td style={{ paddingLeft: 18 }}>
                      <div style={{ fontWeight: 600 }}>{p.sku}</div>
                      <div className="muted" style={{ fontSize: 12 }}>{p.name}</div>
                    </td>
                    <td style={{ textAlign: 'center' }}>{p.marginOzon !== null ? `${p.marginOzon}%` : '—'}</td>
                    <td style={{ textAlign: 'center' }}>{p.marginWB !== null ? `${p.marginWB}%` : '—'}</td>
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
