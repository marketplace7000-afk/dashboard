import { useState } from 'react';

const fmt = (n: number) => n.toLocaleString('ru-RU') + ' ₽';

// Столбчатый график «по дням» — общий для Ozon и WB. Цвет столбиков задаётся
// пропом (Ozon — синий #005bff, WB — малиновый #cb11ab). data — выручка по дням
// в хронологическом порядке, endDate — реальный последний день окна (обычно
// «вчера», т.к. отчёты МП отдают данные по вчера включительно).
export function DailyBarsChart({
  data, days, endDate, color = '#005bff', colorHover = '#0047cc',
}: {
  data: number[]; days: number; endDate: string; color?: string; colorHover?: string;
}) {
  const w = 720;
  const h = 220;
  const pad = { l: 60, r: 20, t: 16, b: 32 };
  const innerW = w - pad.l - pad.r;
  const innerH = h - pad.t - pad.b;
  // Мгновенный hover: подсветка столбика + свой тултип (нативный <title> был
  // с секундной задержкой — его никто не замечал).
  const [hover, setHover] = useState<number | null>(null);
  if (data.length === 0) return null;

  const max = Math.max(...data, 1);
  const barW = innerW / data.length;
  // Даты подписей привязаны к РЕАЛЬНОМУ концу окна данных (endDate = вчера), а не
  // к «сегодня». Иначе подписи съезжали на +1 день: окно грузится «по вчера», а
  // подписи считались от today (жалоба клиента 03.07 — «3.07 это 2.07»).
  const lastDay = new Date(endDate + 'T00:00:00');

  const yTicks = 4;
  const tickStep = max / yTicks;

  const xLabelEvery = days <= 7 ? 1 : days <= 14 ? 2 : days <= 31 ? 5 : 7;
  const dayFor = (i: number) => new Date(lastDay.getTime() - (data.length - 1 - i) * 24 * 3600 * 1000);
  const dLabel = (i: number) => { const d = dayFor(i); return `${d.getDate()}.${String(d.getMonth() + 1).padStart(2, '0')}`; };

  return (
    <svg width="100%" viewBox={`0 0 ${w} ${h}`} style={{ display: 'block' }} onMouseLeave={() => setHover(null)}>
      {/* y grid + labels */}
      {Array.from({ length: yTicks + 1 }).map((_, i) => {
        const v = tickStep * i;
        const y = pad.t + innerH - (v / max) * innerH;
        return (
          <g key={i}>
            <line x1={pad.l} y1={y} x2={w - pad.r} y2={y} stroke="var(--border)" strokeWidth="1" />
            <text x={pad.l - 8} y={y + 4} textAnchor="end" fill="var(--muted)" fontSize="11">
              {v >= 1_000_000 ? `${(v / 1_000_000).toFixed(1)} млн` : v >= 1000 ? `${Math.round(v / 1000)} тыс` : Math.round(v)}
            </text>
          </g>
        );
      })}

      {/* bars */}
      {data.map((v, i) => {
        const x = pad.l + i * barW + 2;
        const bw = Math.max(2, barW - 4);
        const bh = (v / max) * innerH;
        const y = pad.t + innerH - bh;
        const showLabel = (data.length - 1 - i) % xLabelEvery === 0;
        const isHover = hover === i;
        return (
          <g key={i}>
            <rect
              x={x} y={y} width={bw} height={bh}
              fill={isHover ? colorHover : color} rx="3"
              opacity={isHover ? 1 : i === data.length - 1 ? 1 : 0.78}
              stroke={isHover ? 'var(--text)' : 'none'} strokeWidth={isHover ? 1.5 : 0}
            />
            {/* невидимая hit-зона на всю высоту — легко навестись даже на короткий столбик */}
            <rect
              x={pad.l + i * barW} y={pad.t} width={barW} height={innerH}
              fill="transparent" style={{ cursor: 'pointer' }}
              onMouseEnter={() => setHover(i)}
            />
            {showLabel && v > 0 && !isHover && (
              <text
                x={x + barW / 2 - 2} y={y - 4}
                textAnchor="middle" fill="var(--muted)" fontSize="10"
              >
                {v >= 1_000_000 ? `${(v / 1_000_000).toFixed(1)}M` : v >= 1000 ? `${Math.round(v / 1000)}т` : Math.round(v)}
              </text>
            )}
            {showLabel && (
              <text
                x={x + barW / 2 - 2} y={h - pad.b + 16}
                textAnchor="middle" fill={isHover ? 'var(--text)' : 'var(--muted)'} fontSize="11" fontWeight={isHover ? 700 : 400}
              >
                {dLabel(i)}
              </text>
            )}
          </g>
        );
      })}

      {/* тултип поверх всего */}
      {hover != null && (() => {
        const tipText = `${dLabel(hover)}: ${fmt(data[hover])}`;
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
