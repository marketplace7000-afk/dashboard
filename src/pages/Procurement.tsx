/**
 * Прогноз закупок — action-first редизайн.
 *
 * Главное отличие от прошлой версии:
 *  - группировка по urgency (привязана к циклу leadTime+packaging),
 *    а не по «status» с хардкодными 14/30 дн.
 *  - в одну строку — ровно ответ «что делать»: сколько заказать, к какой дате,
 *    runway-бар (хватит на N дн при цикле M).
 *  - детали по Ozon/WB убраны со страницы — это работа Распределения,
 *    не закупок (тут считаем totals across MPs).
 */
import { useState, useMemo } from 'react';
import {
  ArrowsClockwiseIcon, WarningIcon, CloudArrowDownIcon, PackageIcon,
  TruckIcon, TargetIcon, ArchiveIcon, ArrowUUpLeftIcon,
  CaretDownIcon, CaretRightIcon, MagnifyingGlassIcon, DownloadSimpleIcon,
  GearIcon, SnowflakeIcon, CheckCircleIcon, ClockIcon, FireIcon, MinusCircleIcon,
} from '@phosphor-icons/react';
import {
  GlobalSettings, getGlobalSettings, saveGlobalSettings,
  getArchivedSKUs, archiveSKU, unarchiveSKU,
  setCustomLeadTime, setCustomPackaging, setCustomTargetDays,
} from '../utils/procurementLogic';
import { useProcurement } from '../api/useProcurement';
import { useOzonTransit, useWbTransit } from '../api/useOzonTransit';
import { ProcurementItem } from '../api/googleSheets';
import { AiAdvice } from '../components/AiAdvice';

type Urgency = NonNullable<ProcurementItem['urgency']>;
type FilterKey = 'all' | Urgency;

const URGENCY_META: Record<Urgency, {
  label: string; short: string; Icon: any; color: string; bg: string; hint: string;
}> = {
  order_now:   { label: 'Заказать сейчас',  short: 'Сейчас',    Icon: FireIcon,        color: '#dc2626', bg: 'rgba(220,38,38,.10)', hint: 'Запас закончится раньше, чем приедет следующая поставка.' },
  order_soon:  { label: 'Скоро заказывать', short: 'Скоро',     Icon: ClockIcon,       color: '#d97706', bg: 'rgba(217,119,6,.10)', hint: 'Запас в пределах буфера безопасности — пора готовить заказ.' },
  healthy:     { label: 'Запас в норме',    short: 'Норма',     Icon: CheckCircleIcon, color: '#16a34a', bg: 'rgba(22,163,74,.10)', hint: 'Запаса хватает с запасом — заказывать пока не нужно.' },
  excess:      { label: 'Избыток (>90 дн)', short: 'Избыток',   Icon: SnowflakeIcon,   color: '#2563eb', bg: 'rgba(37,99,235,.10)', hint: 'Запасов >90 дней — замороженный капитал. Промо или пауза закупки.' },
  no_movement: { label: 'Без движения',     short: 'Без движ.', Icon: MinusCircleIcon, color: '#6b7280', bg: 'var(--bg-3)',         hint: 'Продаж нет за период. В архив или плановое решение.' },
};

const RU = (n: number) => n.toLocaleString('ru-RU');

function fmtDate(iso: string | null | undefined) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('ru', { day: 'numeric', month: 'short' });
}

function exportCSV(rows: ProcurementItem[]) {
  const head = ['SKU','Название','Категория','Цикл (дн)','Хватит (дн)','Срочность',
                'Склад','Транзит','Ozon','WB','Скорость шт/д',
                'Закупить шт','Стоимость ₽','Заказать до'];
  const lines = rows.map(p => [
    p.sku, `"${(p.name || '').replace(/"/g, '""')}"`, p.category || '',
    p.urgencyCycleDays ?? '', p.daysSupplyTotal,
    p.urgency ? URGENCY_META[p.urgency].label : '',
    p.warehouseStock, p.tranzitTotal, p.stockOzon, p.stockWB, p.dailyTotal,
    p.suggestedQty || 0, p.totalPurchaseCost || 0, p.orderByDate || '',
  ].join(','));
  const csv = '﻿' + [head.join(','), ...lines].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `zakupki_${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

/** Полоса «runway»: визуализация запаса относительно цикла + буфера. */
function RunwayBar({ days, cycle, buffer }: { days: number; cycle: number; buffer: number }) {
  const total = Math.max(cycle + buffer, days, 30);
  const pctCycle = Math.min(100, (cycle / total) * 100);
  const pctBuffer = Math.min(100, ((cycle + buffer) / total) * 100);
  const pctDays = Math.min(100, (days / total) * 100);
  const overflow = days > total;
  const color = days < cycle ? '#dc2626'
              : days < cycle + buffer ? '#d97706'
              : overflow ? '#2563eb' : '#16a34a';
  return (
    <div title={`Запас ${days} дн · цикл поставки ${cycle} дн · буфер ${buffer} дн`}
         style={{ position: 'relative', width: '100%', height: 8, background: 'var(--bg-3)', borderRadius: 4, overflow: 'hidden' }}>
      <div style={{ position: 'absolute', left: 0, width: `${pctCycle}%`, height: '100%', background: 'rgba(220,38,38,.14)' }} />
      <div style={{ position: 'absolute', left: `${pctCycle}%`, width: `${pctBuffer - pctCycle}%`, height: '100%', background: 'rgba(217,119,6,.18)' }} />
      <div style={{ position: 'absolute', left: 0, width: `${pctDays}%`, height: '100%', background: color }} />
      <div style={{ position: 'absolute', left: `${pctCycle}%`, top: 0, bottom: 0, width: 1, background: 'rgba(0,0,0,.35)' }} />
    </div>
  );
}

type Row = ProcurementItem;

function ProcurementRow({
  p, expanded, onToggle, onArchive, settings,
}: {
  p: Row; expanded: boolean; onToggle: () => void; onArchive: () => void; settings: GlobalSettings;
}) {
  const u = (p.urgency || 'healthy') as Urgency;
  const meta = URGENCY_META[u];
  const cycle = p.urgencyCycleDays ?? settings.leadTime + settings.packaging;
  const buffer = p.urgencyBufferDays ?? Math.max(7, Math.round(cycle * 0.15));
  const onMP = p.stockOzon + p.stockWB;
  const suggested = p.suggestedQty || 0;
  // На сколько дней хватит рекомендуемой партии (для честности при округлении до 100).
  const batchDays = p.dailyTotal > 0 ? Math.round(suggested / p.dailyTotal) : null;
  // Сколько дней разойдётся минимальная партия 100 шт (для медленных SKU, где докуп не окупается).
  const minBatchDays = p.dailyTotal > 0 ? Math.round(100 / p.dailyTotal) : null;
  const runwayDays = p.daysSupplyTotal >= 999 ? cycle + buffer + 30 : p.daysSupplyTotal;

  return (
    <div className="card" style={{ padding: 0, marginBottom: 8, border: `1px solid ${expanded ? 'var(--border-2, var(--border))' : 'var(--border)'}` }}>
      <div className="row gap-12" style={{ padding: '12px 14px', cursor: 'pointer', alignItems: 'center', flexWrap: 'wrap' }} onClick={onToggle}>
        {/* SKU + name */}
        <div style={{ minWidth: 200, flex: '1 1 220px' }}>
          <div style={{ fontSize: 13, fontWeight: 700 }}>{p.sku}</div>
          <div className="muted" style={{ fontSize: 12, marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 260 }}>{p.name}</div>
          {p.category && <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>{p.category}</div>}
        </div>

        {/* Stock breakdown */}
        <div style={{ minWidth: 160, flex: '0 0 auto', fontSize: 12, lineHeight: 1.55 }}>
          <div><span className="muted">МП:</span> <strong>{RU(onMP)}</strong> шт</div>
          <div><span className="muted">Склад:</span> <strong>{RU(p.warehouseStock)}</strong> шт</div>
          <div><span className="muted">Из Китая:</span> <strong style={{ color: p.tranzitTotal > 0 ? 'var(--accent)' : 'var(--muted)' }}>{RU(p.tranzitTotal)}</strong> шт</div>
          {(p.mpTransit ?? 0) > 0 && (
            <div title="Едет на склад маркетплейса (FBO), уже учтено в покрытии">
              <span className="muted">На МП едет:</span> <strong style={{ color: '#005bff' }}>{RU(p.mpTransit ?? 0)}</strong> шт
            </div>
          )}
        </div>

        {/* Runway + velocity */}
        <div style={{ flex: '1 1 200px', minWidth: 200 }}>
          <div className="row" style={{ gap: 8, fontSize: 12, marginBottom: 5, alignItems: 'baseline' }}>
            <strong style={{ fontSize: 14 }}>{p.daysSupplyTotal >= 999 ? '∞' : p.daysSupplyTotal} дн</strong>
            <span className="muted">хватит · цикл {cycle} дн</span>
          </div>
          <RunwayBar days={runwayDays} cycle={cycle} buffer={buffer} />
          <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
            скорость {p.dailyTotal} шт/д{p.trendFactor && p.trendFactor !== 1 ? ` · тренд ×${p.trendFactor.toFixed(2)}` : ''}
          </div>
        </div>

        {/* Action */}
        <div style={{ flex: '0 0 210px', textAlign: 'right' }}>
          {suggested > 0 ? (
            <>
              <div style={{ fontSize: 16, fontWeight: 700 }}>Заказать {RU(suggested)} шт</div>
              <div style={{ fontSize: 12, color: meta.color, fontWeight: 600, marginTop: 2 }}>
                <meta.Icon size={11} weight="bold" /> к {fmtDate(p.orderByDate)} · {RU(p.totalPurchaseCost || 0)} ₽
              </div>
              {p.batchRoundedUp && (
                <div className="muted" style={{ fontSize: 11, marginTop: 2 }}
                     title={`Расчётный докуп ${RU(p.rawSuggestedQty || 0)} шт меньше минимальной партии 100 шт. Заказать меньше нельзя — берём партию.`}>
                  мин. партия{batchDays != null ? ` · запас ~${RU(batchDays)} дн` : ''}
                </div>
              )}
            </>
          ) : p.batchUneconomical ? (
            <div className="muted" style={{ fontSize: 13 }}
                 title={`Расчётный докуп ${RU(p.rawSuggestedQty || 0)} шт, но минимальная партия 100 шт = запас на ~${RU(minBatchDays || 0)} дн. Докуп из Китая не окупится — распродавать остаток или возить малыми партиями иначе.`}>
              <meta.Icon size={12} weight="bold" style={{ color: meta.color }} /> {meta.short}
              <div style={{ fontSize: 11, marginTop: 2 }}>
                расчёт {RU(p.rawSuggestedQty || 0)} шт · партия 100 = запас ~{RU(minBatchDays || 0)} дн
              </div>
            </div>
          ) : (
            <div className="muted" style={{ fontSize: 13 }}>
              <meta.Icon size={12} weight="bold" style={{ color: meta.color }} /> {meta.short}
            </div>
          )}
        </div>

        {/* Expand caret */}
        <div style={{ flex: '0 0 18px', color: 'var(--muted)' }}>
          {expanded ? <CaretDownIcon size={14} weight="bold" /> : <CaretRightIcon size={14} weight="bold" />}
        </div>
      </div>

      {/* Expanded details */}
      {expanded && (
        <div style={{ padding: '12px 14px', borderTop: '1px solid var(--border)', background: 'var(--bg-2)', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 16 }}>
          <div>
            <div className="muted" style={{ fontSize: 11, textTransform: 'uppercase', fontWeight: 600, marginBottom: 6 }}>Распределение</div>
            <div style={{ fontSize: 12.5, lineHeight: 1.7 }}>
              Ozon: <strong>{p.stockOzon}</strong> шт ({p.dailyOzon} шт/д)<br/>
              WB: <strong>{p.stockWB}</strong> шт ({p.dailyWB} шт/д)
              {p.tranzitItems && p.tranzitItems.length > 0 && (
                <div style={{ marginTop: 6 }}>
                  В пути:
                  {p.tranzitItems.map((t, i) => (
                    <div key={i} className="muted" style={{ fontSize: 12, marginLeft: 8 }}>
                      • {RU(t.qty)} шт{t.date ? ` → ${fmtDate(t.date)}` : ''}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div>
            <div className="muted" style={{ fontSize: 11, textTransform: 'uppercase', fontWeight: 600, marginBottom: 6 }}>
              <GearIcon size={11} weight="bold" /> Параметры SKU
            </div>
            <div className="row gap-8" style={{ flexWrap: 'wrap', fontSize: 12 }}>
              <label className="row gap-4">
                <TruckIcon size={11} weight="bold" /> срок
                <input type="number" className="input" style={{ width: 56, padding: '3px 5px', fontSize: 11 }}
                       placeholder={String(settings.leadTime)}
                       defaultValue={p.customLeadTime || ''}
                       onBlur={e => { const v = parseInt(e.target.value); setCustomLeadTime(p.sku, isNaN(v) ? null : v); }} />
              </label>
              <label className="row gap-4">
                <PackageIcon size={11} weight="bold" /> упак
                <input type="number" className="input" style={{ width: 56, padding: '3px 5px', fontSize: 11 }}
                       placeholder={String(settings.packaging)}
                       defaultValue={p.customPackaging || ''}
                       onBlur={e => { const v = parseInt(e.target.value); setCustomPackaging(p.sku, isNaN(v) ? null : v); }} />
              </label>
              <label className="row gap-4">
                <TargetIcon size={11} weight="bold" /> цель
                <input type="number" className="input" style={{ width: 56, padding: '3px 5px', fontSize: 11 }}
                       placeholder={String(settings.targetDays)}
                       defaultValue={p.customTargetDays || ''}
                       onBlur={e => { const v = parseInt(e.target.value); setCustomTargetDays(p.sku, isNaN(v) ? null : v); }} />
              </label>
            </div>
            <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
              цикл = срок + упак · буфер ≈ 15% цикла
            </div>
          </div>

          <div>
            <div className="muted" style={{ fontSize: 11, textTransform: 'uppercase', fontWeight: 600, marginBottom: 6 }}>Закупка</div>
            <div style={{ fontSize: 12.5, lineHeight: 1.7 }}>
              Цена: <strong>{RU(p.purchasePrice)} ₽/шт</strong><br/>
              {suggested > 0 ? (
                <>
                  Кол-во: <strong>{RU(suggested)} шт</strong>
                  {p.batchRoundedUp && (
                    <span className="muted" title="Заказать меньше минимальной партии из Китая нельзя — берём партию 100 шт.">
                      {' '}· расчёт {RU(p.rawSuggestedQty || 0)}, мин. партия 100
                    </span>
                  )}<br/>
                  Сумма: <strong>{RU(p.totalPurchaseCost || 0)} ₽</strong><br/>
                  {batchDays != null && (
                    <>Хватит на: <strong>{RU(batchDays)} дн</strong><br/></>
                  )}
                  Заказать до: <strong style={{ color: meta.color }}>{fmtDate(p.orderByDate)}</strong>
                </>
              ) : p.batchUneconomical ? (
                <span className="muted" title="Продаётся слишком медленно: минимальная партия 100 шт = запас на годы. Докуп из Китая не окупится — распродавать остаток или искать другой канал поставки.">
                  Расчёт: <strong>{RU(p.rawSuggestedQty || 0)} шт</strong> · партия 100 = запас ~{RU(minBatchDays || 0)} дн<br/>
                  Докуп из Китая не окупится
                </span>
              ) : (p.urgency === 'order_now' || p.urgency === 'order_soon') ? (
                // Статус срочный (остаток НА РУКАХ кончается), но докуп = 0. Причина
                // почти всегда — уже едет поставка, которая покрывает потребность.
                // Раньше писали «уточни скорость продаж» — это неправда (скорость
                // известна), путало клиента (жалоба 24.07). Теперь объясняем честно.
                ((p.tranzitTotal || 0) + (p.mpTransit || 0)) > 0 ? (
                  <span className="muted" title="Рекомендуемый докуп 0: едущие поставки (из Китая + на склады МП) уже покрывают потребность на цикл.">
                    Докуп не нужен — уже едет <strong>{RU((p.tranzitTotal || 0) + (p.mpTransit || 0))} шт</strong>, покрывает потребность
                  </span>
                ) : (p.dailyTotal || 0) > 0 ? (
                  <span className="muted">Докуп не требуется — запаса хватает на цель</span>
                ) : (
                  <span className="muted">Нет данных о скорости продаж — уточни продажи по SKU</span>
                )
              ) : <span className="muted">Закупка не требуется</span>}
            </div>
            <button className="btn btn-sm" style={{ marginTop: 10 }} onClick={onArchive}>
              <ArchiveIcon size={11} weight="bold" /> В архив
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function Procurement() {
  const [settings, setSettings] = useState<GlobalSettings>(getGlobalSettings());
  const { data: ozonTransit } = useOzonTransit();
  const { data: wbTransit } = useWbTransit();
  // Карта SKU→кол-во в транзите на МП (Ozon + WB суммарно). Учитывается в
  // покрытии/докупе, чтобы не заказывать то, что уже едет на склад маркетплейса.
  const transitBySku = useMemo(() => {
    const m: Record<string, number> = { ...(ozonTransit?.items ?? {}) };
    for (const [k, v] of Object.entries(wbTransit?.items ?? {})) m[k] = (m[k] ?? 0) + v;
    return m;
  }, [ozonTransit, wbTransit]);
  const { items: processed, loading, error, reload } = useProcurement(settings, transitBySku);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<FilterKey>('all');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [showArchive, setShowArchive] = useState(false);
  const [archiveTick, setArchiveTick] = useState(0);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<Urgency>>(new Set(['healthy', 'excess', 'no_movement']));

  const archived = useMemo(() => getArchivedSKUs('procurement'), [archiveTick]);
  // Пустышки (нет ни продаж, ни остатков, ни транзита) в закупках не нужны — это
  // скелеты из «Маржи» (исторические SKU) и мёртвые позиции, только раздувают «Без движ.»
  const hasAnything = (p: typeof processed[number]) =>
    p.dailyTotal > 0 || p.stockOzon > 0 || p.stockWB > 0 || p.warehouseStock > 0 || p.tranzitTotal > 0 || (p.mpTransit ?? 0) > 0;
  const active = processed.filter(p => !archived.includes(p.sku) && hasAnything(p));
  const archivedList = processed.filter(p => archived.includes(p.sku));

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return active.filter(p => {
      const matchQ = !q || p.sku.toLowerCase().includes(q) || p.name.toLowerCase().includes(q) || (p.category || '').toLowerCase().includes(q);
      const matchF = filter === 'all' || p.urgency === filter;
      return matchQ && matchF;
    });
  }, [active, search, filter]);

  const groups = useMemo(() => {
    const m: Record<Urgency, Row[]> = { order_now: [], order_soon: [], healthy: [], excess: [], no_movement: [] };
    for (const p of filtered) {
      const u = (p.urgency || 'healthy') as Urgency;
      m[u].push(p);
    }
    (Object.keys(m) as Urgency[]).forEach(k => {
      m[k].sort((a, b) => a.daysSupplyTotal - b.daysSupplyTotal);
    });
    return m;
  }, [filtered]);

  const counts = useMemo(() => {
    const c: Record<Urgency, number> = { order_now: 0, order_soon: 0, healthy: 0, excess: 0, no_movement: 0 };
    for (const p of active) {
      const u = (p.urgency || 'healthy') as Urgency;
      c[u]++;
    }
    return c;
  }, [active]);

  const budget = useMemo(() => active.filter(p => p.urgency === 'order_now' || p.urgency === 'order_soon')
    .reduce((s, p) => s + (p.totalPurchaseCost || 0), 0), [active]);

  const toggleExpand = (sku: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(sku)) next.delete(sku); else next.add(sku);
      return next;
    });
  };
  const toggleGroup = (u: Urgency) => {
    setCollapsedGroups(prev => {
      const next = new Set(prev);
      if (next.has(u)) next.delete(u); else next.add(u);
      return next;
    });
  };
  const onArchive = (sku: string) => {
    // См. LiveOzonPricing: при переполнении хранилища запись падала молча.
    if (!archiveSKU(sku, 'procurement')) {
      alert('Не удалось сохранить: в браузере кончилось место. Обновите страницу и попробуйте снова.');
      return;
    }
    setArchiveTick(t => t + 1);
  };
  const onUnarchive = (sku: string) => { unarchiveSKU(sku, 'procurement'); setArchiveTick(t => t + 1); };

  const updateSetting = (key: keyof GlobalSettings, val: number) => {
    const next = { ...settings, [key]: val };
    setSettings(next);
    saveGlobalSettings(next);
  };

  const settingsMeta: Record<keyof GlobalSettings, { label: string; Icon: any }> = {
    leadTime: { label: 'Срок поставки', Icon: TruckIcon },
    packaging: { label: 'Упаковка', Icon: PackageIcon },
    targetDays: { label: 'Целевой запас', Icon: TargetIcon },
  };

  const adviceContext = {
    заказать_сейчас: counts.order_now, заказать_скоро: counts.order_soon,
    бюджет_докупа: Math.round(budget),
    строки: active
      .filter((p) => p.urgency === 'order_now' || p.urgency === 'order_soon')
      .sort((a, b) => a.daysSupplyTotal - b.daysSupplyTotal)
      .slice(0, 25)
      .map((p) => ({ sku: p.sku, срочность: p.urgency, дней_запаса: p.daysSupplyTotal, докупить_шт: p.suggestedQty ?? 0, стоимость: Math.round(p.totalPurchaseCost || 0), продаж_день: p.dailyTotal, транзит_китай: p.tranzitTotal, транзит_на_МП: p.mpTransit ?? 0, наш_склад: p.warehouseStock })),
  };

  return (
    <div className="grid" style={{ gap: 18 }}>
      <AiAdvice module="procurement" context={adviceContext} disabled={active.length === 0} />
      <div className="flex-between" style={{ flexWrap: 'wrap', gap: 10 }}>
        <div className="muted" style={{ fontSize: 13 }}>
          Что заказать, сколько и к какой дате · группировка по срочности относительно цикла поставки
        </div>
        <div className="row gap-8">
          <button className="btn" onClick={() => exportCSV(filtered)} disabled={!filtered.length}>
            <DownloadSimpleIcon size={14} weight="bold" /> CSV
          </button>
          <button className="btn btn-primary" onClick={reload} disabled={loading}>
            {loading ? <ArrowsClockwiseIcon className="spin" size={14} weight="bold" /> : <CloudArrowDownIcon size={14} weight="bold" />}
            {loading ? 'Загрузка…' : 'Обновить'}
          </button>
        </div>
      </div>

      {error && (
        <div className="card" style={{ background: 'rgba(220,38,38,.08)', color: 'var(--bad)', display: 'flex', gap: 10, alignItems: 'center' }}>
          <WarningIcon size={18} weight="bold" />
          <span style={{ fontSize: 13 }}>{error}</span>
        </div>
      )}

      <div className="card" style={{ padding: '10px 14px' }}>
        <div className="row gap-16" style={{ flexWrap: 'wrap', alignItems: 'center', fontSize: 12.5 }}>
          <strong style={{ fontSize: 12, color: 'var(--muted)', textTransform: 'uppercase' }}>Параметры</strong>
          {(['leadTime', 'packaging', 'targetDays'] as (keyof GlobalSettings)[]).map(k => {
            const { label, Icon } = settingsMeta[k];
            return (
              <label key={k} className="row gap-6">
                <Icon size={13} weight="bold" style={{ color: 'var(--muted)' }} />
                <span className="muted">{label}</span>
                <input type="number" className="input" style={{ width: 56, padding: '4px 6px', fontSize: 12, textAlign: 'center' }}
                       value={settings[k]} onChange={e => updateSetting(k, parseInt(e.target.value) || 0)} />
                <span className="muted" style={{ fontSize: 11 }}>дн</span>
              </label>
            );
          })}
          <div className="muted" style={{ fontSize: 11.5, marginLeft: 'auto' }}>
            цикл = {settings.leadTime + settings.packaging} дн · буфер ~{Math.max(7, Math.round((settings.leadTime + settings.packaging) * 0.15))} дн
          </div>
        </div>
      </div>

      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10 }}>
        <div className="card kpi">
          <span className="d muted">Бюджет (сейчас+скоро)</span>
          <span className="v" style={{ fontSize: 18, color: 'var(--accent)' }}>{RU(budget)} ₽</span>
        </div>
        {(['order_now', 'order_soon', 'healthy', 'excess', 'no_movement'] as Urgency[]).map(u => {
          const m = URGENCY_META[u];
          return (
            <button key={u} className="card kpi" style={{ textAlign: 'left', cursor: 'pointer', font: 'inherit', color: 'inherit', border: filter === u ? `1px solid ${m.color}` : '1px solid transparent' }}
                    onClick={() => setFilter(filter === u ? 'all' : u)}>
              <span className="d muted"><m.Icon size={11} weight="bold" style={{ color: m.color }} /> {m.short}</span>
              <span className="v" style={{ color: m.color }}>{counts[u]}</span>
            </button>
          );
        })}
      </div>

      <div className="row gap-10" style={{ flexWrap: 'wrap' }}>
        <div style={{ position: 'relative', width: 280 }}>
          <MagnifyingGlassIcon size={14} weight="bold" style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted)' }} />
          <input type="text" className="input" placeholder="SKU, название, категория…"
                 value={search} onChange={e => setSearch(e.target.value)}
                 style={{ width: '100%', paddingLeft: 30 }} />
        </div>
        {filter !== 'all' && (
          <button className="btn btn-sm" onClick={() => setFilter('all')}>
            Сбросить фильтр «{URGENCY_META[filter as Urgency].short}»
          </button>
        )}
      </div>

      <div>
        {(['order_now', 'order_soon', 'healthy', 'excess', 'no_movement'] as Urgency[]).map(u => {
          const items = groups[u];
          if (items.length === 0) return null;
          const m = URGENCY_META[u];
          const isCollapsed = collapsedGroups.has(u);
          return (
            <div key={u} style={{ marginBottom: 18 }}>
              <div className="row" style={{ gap: 10, padding: '10px 14px', background: m.bg, borderRadius: 8, cursor: 'pointer', marginBottom: 8 }}
                   onClick={() => toggleGroup(u)}>
                {isCollapsed ? <CaretRightIcon size={14} weight="bold" /> : <CaretDownIcon size={14} weight="bold" />}
                <m.Icon size={15} weight="fill" style={{ color: m.color }} />
                <strong style={{ fontSize: 14, color: m.color }}>{m.label}</strong>
                <span className="muted" style={{ fontSize: 12 }}>· {items.length} SKU</span>
                <span className="muted" style={{ fontSize: 11.5, marginLeft: 'auto', maxWidth: 360, textAlign: 'right' }}>{m.hint}</span>
              </div>
              {!isCollapsed && items.map(p => (
                <ProcurementRow key={p.sku} p={p}
                                expanded={expanded.has(p.sku)}
                                onToggle={() => toggleExpand(p.sku)}
                                onArchive={() => onArchive(p.sku)}
                                settings={settings} />
              ))}
            </div>
          );
        })}

        {filtered.length === 0 && !loading && (
          <div className="card" style={{ textAlign: 'center', color: 'var(--muted)', padding: 40 }}>
            Нет данных или по фильтрам ничего не найдено
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
                  <th>Склад</th>
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
                    <td><div style={{ fontSize: 13 }}>{p.warehouseStock} шт</div></td>
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
