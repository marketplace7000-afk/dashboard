/**
 * Сезонность — коэффициенты по месяцам, спотлайт текущего месяца сверху.
 */
import { useMemo } from 'react';
import {
  ArrowsClockwiseIcon, CloudArrowDownIcon, CalendarBlankIcon, LightbulbIcon, WarningIcon,
  TrendUpIcon, TrendDownIcon, MinusIcon,
} from '@phosphor-icons/react';
import { useProcurement } from '../api/useProcurement';
import { buildSeasonality, MONTHS, coefColor } from '../utils/seasonalityLogic';

const CAT_COLORS: Record<string, string> = {
  'Наборы для полировки автомобиля': '#16a34a',
  'Магнитолы автомобильные': '#2563eb',
  'Квадрокоптер': '#d97706',
  'Лампы автомобильные': '#6b7280',
  'Пленки защитные для авто': '#0891b2',
  'Геймпады': '#7c3aed',
};

function combinedCoef(o: number | null, wb: number | null): number | null {
  if (o === null && wb === null) return null;
  if (o === null) return wb;
  if (wb === null) return o;
  return Math.round(((o + wb) / 2) * 100) / 100;
}

function trendIcon(c: number | null) {
  if (c === null) return null;
  if (c >= 1.15) return <TrendUpIcon size={12} weight="bold" style={{ color: 'var(--good)' }} />;
  if (c <= 0.85) return <TrendDownIcon size={12} weight="bold" style={{ color: 'var(--bad)' }} />;
  return <MinusIcon size={12} weight="bold" style={{ color: 'var(--muted)' }} />;
}

export function Seasonality() {
  const { items, loading, error, reload } = useProcurement();
  const cats = useMemo(() => buildSeasonality(items), [items]);
  const curMonth = new Date().getMonth();

  // спотлайт «текущий месяц»: какие категории в пике, какие в провале СЕЙЧАС
  const currentMonthInsight = useMemo(() => {
    const rows = cats.map(c => {
      const o = c.ozon[curMonth];
      const wb = c.wb[curMonth];
      const combined = combinedCoef(o, wb);
      return { category: c.category, ozon: o, wb, combined };
    }).filter(r => r.combined !== null) as { category: string; ozon: number | null; wb: number | null; combined: number }[];
    rows.sort((a, b) => b.combined - a.combined);
    return rows;
  }, [cats, curMonth]);

  // ближайший пик каждой категории (3 мес вперёд)
  const nextPeaks = useMemo(() => cats.map(c => {
    const window = [...Array(3)].map((_, i) => (curMonth + 1 + i) % 12);
    let peakIdx = -1, peakVal = -Infinity;
    for (const i of window) {
      const v = combinedCoef(c.ozon[i], c.wb[i]);
      if (v !== null && v > peakVal) { peakVal = v; peakIdx = i; }
    }
    return { category: c.category, peakIdx, peakVal };
  }).filter(p => p.peakIdx >= 0 && p.peakVal >= 1.1), [cats, curMonth]);

  return (
    <div className="grid" style={{ gap: 18 }}>
      <div className="flex-between" style={{ flexWrap: 'wrap', gap: 10 }}>
        <div className="muted" style={{ fontSize: 13, maxWidth: 720 }}>
          Сезонные коэффициенты по месяцам. <strong>1.0</strong> = средний месяц; выше — пик, ниже — спад.
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

      {/* Спотлайт текущего месяца */}
      {currentMonthInsight.length > 0 && (
        <div className="card" style={{ padding: '12px 14px', background: 'var(--accent-soft, var(--bg-3))' }}>
          <div className="row gap-8" style={{ marginBottom: 8 }}>
            <CalendarBlankIcon size={14} weight="bold" style={{ color: 'var(--accent)' }} />
            <strong style={{ fontSize: 13 }}>{MONTHS[curMonth]} — что в спросе сейчас</strong>
          </div>
          <div className="row gap-8" style={{ flexWrap: 'wrap' }}>
            {currentMonthInsight.slice(0, 8).map(r => (
              <span key={r.category} style={{
                padding: '4px 10px', borderRadius: 999, fontSize: 12,
                background: r.combined >= 1.15 ? 'rgba(22,163,74,.10)'
                          : r.combined <= 0.85 ? 'rgba(220,38,38,.10)'
                          : 'var(--bg-3)',
                color: coefColor(r.combined),
                fontWeight: 600,
                display: 'inline-flex', gap: 5, alignItems: 'center',
              }}>
                {trendIcon(r.combined)} {r.category} ×{r.combined.toFixed(2)}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Ближайшие пики */}
      {nextPeaks.length > 0 && (
        <div className="card" style={{ padding: '10px 14px' }}>
          <div className="row gap-8" style={{ marginBottom: 6 }}>
            <LightbulbIcon size={14} weight="bold" style={{ color: 'var(--warn)' }} />
            <strong style={{ fontSize: 13 }}>Ближайшие пики (3 мес)</strong>
            <span className="muted" style={{ fontSize: 11.5 }}>— подумай о закупке сейчас, чтобы успеть к ним</span>
          </div>
          <div className="row gap-8" style={{ flexWrap: 'wrap' }}>
            {nextPeaks.map(p => (
              <span key={p.category} className="chip" style={{ fontSize: 12 }}>
                <strong>{p.category}</strong> · {MONTHS[p.peakIdx]} ×{p.peakVal.toFixed(2)}
              </span>
            ))}
          </div>
        </div>
      )}

      {!loading && cats.length === 0 && (
        <div className="card" style={{ textAlign: 'center', color: 'var(--muted)', padding: 32 }}>
          Нет данных. Нажми «Обновить».
        </div>
      )}

      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(460px, 1fr))', gap: 16 }}>
        {cats.map(c => {
          const color = CAT_COLORS[c.category] || 'var(--accent)';
          const curO = c.ozon[curMonth];
          const curW = c.wb[curMonth];
          const curCombined = combinedCoef(curO, curW);
          return (
            <div key={c.category} className="card" style={{ padding: 14 }}>
              <div className="flex-between" style={{ marginBottom: 4 }}>
                <div className="row gap-8">
                  <span style={{ width: 10, height: 10, borderRadius: '50%', background: color, flexShrink: 0 }} />
                  <strong style={{ fontSize: 13 }}>{c.category}</strong>
                </div>
                <span className="muted" style={{ fontSize: 11 }}>{c.skus} SKU</span>
              </div>
              <div className="muted" style={{ fontSize: 11.5, marginBottom: 10 }}>
                {curCombined !== null && (
                  <>сейчас ({MONTHS[curMonth]}): <strong style={{ color: coefColor(curCombined) }}>×{curCombined.toFixed(2)}</strong></>
                )}
                {c.peakValue !== null && c.peakMonth && (
                  <> · пик: <strong style={{ color: 'var(--text)' }}>{c.peakMonth} ×{c.peakValue.toFixed(2)}</strong></>
                )}
              </div>

              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'separate', borderSpacing: '2px 0' }}>
                  <thead>
                    <tr>
                      <th style={{ textAlign: 'left', fontSize: 10, color: 'var(--muted)', padding: '4px 4px' }}>МП</th>
                      {MONTHS.map((m, i) => (
                        <th key={m} style={{
                          textAlign: 'center', fontSize: 10, fontWeight: 700,
                          color: i === curMonth ? 'var(--accent)' : 'var(--muted)',
                          padding: '4px 2px',
                          background: i === curMonth ? 'var(--accent-soft, var(--bg-3))' : undefined,
                          borderRadius: 4,
                        }}>{m}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {(['ozon', 'wb'] as const).map(mp => {
                      const arr = mp === 'ozon' ? c.ozon : c.wb;
                      const label = mp === 'ozon' ? 'Ozon' : 'WB';
                      const labelColor = mp === 'ozon' ? '#005bff' : '#cb11ab';
                      const hasData = arr.some(v => v !== null);
                      if (!hasData) {
                        return (
                          <tr key={mp}>
                            <td style={{ fontSize: 11, fontWeight: 600, color: labelColor, padding: '6px 4px' }}>{label}</td>
                            <td colSpan={12} style={{ fontSize: 11, color: 'var(--muted)', padding: '6px 4px' }}>нет данных</td>
                          </tr>
                        );
                      }
                      return (
                        <tr key={mp}>
                          <td style={{ fontSize: 11, fontWeight: 600, color: labelColor, padding: '6px 4px' }}>{label}</td>
                          {arr.map((v, i) => {
                            const isCur = i === curMonth;
                            return (
                              <td key={i} style={{
                                textAlign: 'center',
                                padding: '4px 2px',
                                background: isCur ? 'var(--accent-soft, var(--bg-3))' : undefined,
                                borderRadius: 4,
                              }}>
                                {v === null ? (
                                  <span style={{ color: 'var(--muted)' }}>—</span>
                                ) : (
                                  <>
                                    <div style={{ fontSize: 12, fontWeight: 600, color: coefColor(v) }}>{v.toFixed(2)}</div>
                                    <div style={{
                                      height: 3,
                                      borderRadius: 2,
                                      background: coefColor(v),
                                      width: `${Math.min(100, Math.round(v * 50))}%`,
                                      margin: '2px auto 0',
                                    }} />
                                  </>
                                )}
                              </td>
                            );
                          })}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <div style={{ background: 'var(--bg-3)', borderRadius: 8, padding: '10px 12px', marginTop: 10, fontSize: 12, lineHeight: 1.5, color: 'var(--muted)', display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                <LightbulbIcon size={13} weight="bold" style={{ color: 'var(--warn)', flexShrink: 0, marginTop: 2 }} />
                <span>{c.insight}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
