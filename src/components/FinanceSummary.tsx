import { useState } from 'react';
import {
  CurrencyRubIcon, MegaphoneIcon,
  SpinnerIcon, ArrowsClockwiseIcon, WarningIcon,
  CoinsIcon, CaretDownIcon, CaretRightIcon,
} from '@phosphor-icons/react';
import { useFinanceSummary, FinancePeriod } from '../api/useFinanceSummary';

const PERIOD_LABEL: Record<FinancePeriod, string> = {
  day: 'Сегодня',
  week: '7 дней',
  month: '30 дней',
};

const fmt = (n: number) => Math.round(n).toLocaleString('ru-RU') + ' ₽';
const colorForDrr = (pct: number) => pct < 10 ? 'var(--good)' : pct < 20 ? 'var(--warn)' : 'var(--bad)';

export function FinanceSummary() {
  const [period, setPeriod] = useState<FinancePeriod>('week');
  const fin = useFinanceSummary(period);
  const [expanded, setExpanded] = useState(false);

  const s = fin.summary;

  // ДРР отдельно по площадкам (реклама / выручка нетто).
  // null — «не знаем», рисуем прочерк. Раньше здесь стоял `: 0`, и при
  // недоступной рекламе показывался бодрый «0.0%» рядом с подписью, что рекламы
  // нет — противоречие, на которое жаловался клиент (телемост 11.08, п. 3).
  // Отличить «расхода не было» от «источник не ответил» позволяет флаг adsKnown.
  const drrOzon = s && s.ozon.adsKnown && s.ozon.netRevenue > 0
    ? (s.ozon.ads / s.ozon.netRevenue) * 100 : null;
  const drrWb = s && s.wb.adsKnown && s.wb.netRevenue > 0
    ? (s.wb.ads / s.wb.netRevenue) * 100 : null;
  // Почему прочерк — чтобы подсказка объясняла, а не молчала.
  const drrWhy = (mp: 'ozon' | 'wb'): string => {
    if (!s) return 'Данные ещё загружаются.';
    const m = s[mp];
    if (!m.adsKnown) {
      return mp === 'wb'
        ? 'Расход на рекламу WB за этот период недоступен: статистика кампаний прогревается сборщиком только для окон 7 и 30 дней.'
        : 'Расход Ozon Performance (Трафареты, Поиск) не получен — без него ДРР был бы занижен, поэтому не показываем.';
    }
    if (!(m.netRevenue > 0)) return 'Нет выручки за период — делить не на что.';
    return '';
  };
  const roasOzon = s && s.ozon.ads > 0 ? s.ozon.netRevenue / s.ozon.ads : null;
  const roasWb = s && s.wb.ads > 0 ? s.wb.netRevenue / s.wb.ads : null;
  // Себестоимость больше не показываем в KPI → её предупреждение скрываем.
  const shownWarnings = fin.warnings.filter(w => !/Себестоимости нет/.test(w));

  // Числа периода (окно now−N..now, как в хуке). Клиент просил показывать даты.
  const periodDates = (() => {
    const days = period === 'day' ? 1 : period === 'week' ? 7 : 30;
    const d = (dt: Date) => dt.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
    const now = new Date(); const from = new Date(now); from.setDate(from.getDate() - days);
    return period === 'day' ? d(now) : `${d(from)}–${d(now)}`;
  })();

  return (
    <div className="card" style={{ background: 'var(--bg-3)' }}>
      <div className="flex-between" style={{ marginBottom: 14, flexWrap: 'wrap', gap: 8 }}>
        <h2 style={{ margin: 0, display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <CoinsIcon size={18} weight="fill" style={{ color: 'var(--accent)' }} />
          Финансовая сводка · рубль в рубль
          <span className="chip info" style={{ fontSize: 11, marginLeft: 6 }}>{PERIOD_LABEL[period]} ({periodDates})</span>
        </h2>
        <div className="row gap-8">
          <div className="period-switch">
            {(['day', 'week', 'month'] as FinancePeriod[]).map(p => (
              <button
                key={p}
                className={`period-btn ${period === p ? 'active' : ''}`}
                onClick={() => setPeriod(p)}
              >
                {PERIOD_LABEL[p]}
              </button>
            ))}
          </div>
          <button className="btn btn-sm" onClick={fin.refresh} disabled={fin.loading}>
            {fin.loading ? <SpinnerIcon size={13} weight="bold" className="spin" /> : <ArrowsClockwiseIcon size={13} weight="bold" />}
            Обновить
          </button>
        </div>
      </div>

      {fin.loading && !s && (
        <div className="muted" style={{ padding: 20, textAlign: 'center' }}>
          <SpinnerIcon size={18} weight="bold" className="spin" /> Тянем финансовые отчёты Ozon и WB…
        </div>
      )}

      {s && (
        <>
          <div className="grid grid-3" style={{ gap: 12 }}>
            {/* Выручка нетто */}
            <div className="kpi">
              <div className="card-title">
                <CurrencyRubIcon size={11} weight="bold" /> Выручка нетто
              </div>
              <div className="v">{fmt(s.totalNetRevenue)}</div>
              <div className="d muted">
                после возвратов · брутто: {fmt(s.totalGrossRevenue)}
              </div>
            </div>

            {/* ДРР Ozon — прочерк, если полного расхода не знаем (см. drrWhy) */}
            <div className="kpi" title={drrWhy('ozon')}>
              <div className="card-title">
                <MegaphoneIcon size={11} weight="bold" /> ДРР Ozon
              </div>
              {drrOzon !== null ? (
                <>
                  <div className="v" style={{ color: colorForDrr(drrOzon) }}>{drrOzon.toFixed(1)}%</div>
                  <div className="d muted">
                    реклама: {fmt(s.ozon.ads)}
                    {roasOzon !== null && <> · ROAS ×{roasOzon.toFixed(1)}</>}
                  </div>
                </>
              ) : (
                <>
                  <div className="v muted">—</div>
                  <div className="d muted">{s.ozon.adsKnown ? 'нет выручки за период' : 'расход на рекламу не получен'}</div>
                </>
              )}
            </div>

            {/* ДРР WB */}
            <div className="kpi" title={drrWhy('wb')}>
              <div className="card-title">
                <MegaphoneIcon size={11} weight="bold" /> ДРР WB
              </div>
              {drrWb !== null ? (
                <>
                  <div className="v" style={{ color: colorForDrr(drrWb) }}>{drrWb.toFixed(1)}%</div>
                  <div className="d muted">
                    реклама: {fmt(s.wb.ads)}
                    {roasWb !== null && <> · ROAS ×{roasWb.toFixed(1)}</>}
                  </div>
                </>
              ) : (
                <>
                  <div className="v muted">—</div>
                  <div className="d muted">{s.wb.adsKnown ? 'нет выручки за период' : 'расход на рекламу не получен'}</div>
                </>
              )}
            </div>
          </div>

          {/* Развёрнутая разбивка */}
          <div
            onClick={() => setExpanded(e => !e)}
            style={{ marginTop: 12, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--accent-2)' }}
          >
            {expanded ? <CaretDownIcon size={12} weight="bold" /> : <CaretRightIcon size={12} weight="bold" />}
            {expanded ? 'Свернуть' : 'Показать полную разбивку расходов'}
          </div>

          {expanded && (
            <div className="grid grid-2" style={{ gap: 12, marginTop: 10 }}>
              {(['ozon', 'wb'] as const).map(mp => {
                const m = s[mp];
                const dot = mp === 'ozon' ? '#005bff' : '#cb11ab';
                const label = mp === 'ozon' ? 'Ozon' : 'Wildberries';
                return (
                  <div key={mp} className="card" style={{ background: 'var(--bg)' }}>
                    <div className="row gap-8" style={{ marginBottom: 10 }}>
                      <span className="mp-tab-dot" style={{ background: dot, width: 8, height: 8 }} />
                      <strong style={{ fontSize: 13 }}>{label}</strong>
                    </div>
                    <table style={{ fontSize: 12, width: '100%' }}>
                      <tbody>
                        <tr><td className="muted">Выручка брутто</td><td className="right"><b>{fmt(m.grossRevenue)}</b></td></tr>
                        <tr><td className="muted">Выручка нетто</td><td className="right"><b>{fmt(m.netRevenue)}</b></td></tr>
                        <tr><td className="muted">Штук продано (за вычетом возвратов)</td><td className="right">{m.unitsSold}</td></tr>
                        <tr style={{ color: 'var(--bad)' }}><td>− Комиссия МП</td><td className="right">{fmt(m.commission)}</td></tr>
                        <tr style={{ color: 'var(--bad)' }}><td>− Логистика</td><td className="right">{fmt(m.logistics)}</td></tr>
                        <tr style={{ color: 'var(--bad)' }}><td>− Хранение FBO</td><td className="right">{fmt(m.storage)}</td></tr>
                        <tr style={{ color: 'var(--bad)' }}><td>− Реклама</td><td className="right">{fmt(m.ads)}</td></tr>
                        <tr style={{ color: 'var(--bad)' }}><td>− Прочее (штрафы, услуги)</td><td className="right">{fmt(m.other)}</td></tr>
                      </tbody>
                    </table>
                  </div>
                );
              })}
            </div>
          )}

          {shownWarnings.length > 0 && (
            <div className="card" style={{ marginTop: 12, background: 'rgba(217,119,6,.08)' }}>
              <div className="row gap-8" style={{ alignItems: 'flex-start' }}>
                <WarningIcon size={16} weight="bold" style={{ color: 'var(--warn)', flexShrink: 0, marginTop: 2 }} />
                <div style={{ fontSize: 12, lineHeight: 1.55 }}>
                  {shownWarnings.map((w, i) => <div key={i}>{w}</div>)}
                </div>
              </div>
            </div>
          )}

          {fin.fetchedAt && (
            <div className="muted" style={{ fontSize: 11, marginTop: 10, textAlign: 'right' }}>
              Источник: Ozon Finance API + WB finance-api (отчёт о реализации).
              Обновлено: {new Date(fin.fetchedAt).toLocaleTimeString('ru-RU')}.
            </div>
          )}
        </>
      )}
    </div>
  );
}
