/**
 * Графики главной (21.10.2026). Вид взят из шаблона Capitalio (shadcn-блок
 * watermelon.sh): плавная линия с заливкой-градиентом, столбики с выделенным
 * последним, кольцо с отступами между долями, полоса со штриховкой и
 * одинаковая подсказка при наведении. Цвета — токены главной (.db в styles.css).
 */
import { useId, type ReactNode } from 'react';
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, ComposedChart, Line, Pie, PieChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';

export const fmtRub = (n: number) => Math.round(n).toLocaleString('ru-RU') + ' ₽';

/** 1 284 300 → «1,28 млн», 352 000 → «352 тыс». Для осей и подсказок. */
export function fmtShort(n: number): string {
  const a = Math.abs(n);
  if (a >= 1_000_000) return (n / 1_000_000).toLocaleString('ru-RU', { maximumFractionDigits: 2 }) + ' млн';
  if (a >= 10_000) return Math.round(n / 1000).toLocaleString('ru-RU') + ' тыс';
  return Math.round(n).toLocaleString('ru-RU');
}

/** Подпись оси: «2,3 млн», «750 тыс» — коротко, чтобы не переносилась. */
const fmtAxis = (n: number) => n >= 1_000_000 ? (n / 1_000_000).toLocaleString('ru-RU', { maximumFractionDigits: 1 }) + ' млн'
  : n >= 1000 ? Math.round(n / 1000).toLocaleString('ru-RU') + ' тыс' : String(Math.round(n));

/** «2026-10-21» → «21.10». */
export const fmtDay = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}`;

type TipItem = { name?: string | number; value?: number | string; color?: string; dataKey?: string | number; payload?: any };

/** Подсказка как у Capitalio: заголовок, цветной квадрат, подпись и значение. */
export function ChartTip({ active, payload, label, names, format, title }: {
  active?: boolean; payload?: TipItem[]; label?: string | number;
  names?: Record<string, string>; format?: (v: number, key: string) => ReactNode; title?: (label: any, p: any) => ReactNode;
}) {
  const items = (payload ?? []).filter(i => i.value !== undefined && i.value !== null);
  if (!active || !items.length) return null;
  const p0 = items[0]?.payload;
  return (
    <div className="db-tip">
      <div className="db-tip-h">{title ? title(label, p0) : (p0?.label ?? label)}</div>
      {items.map(i => {
        const key = String(i.dataKey ?? i.name ?? '');
        return (
          <div key={key} className="db-tip-row">
            <span className="db-mark" style={{ background: i.color ?? i.payload?.fill }} />
            <span>{names?.[key] ?? i.name ?? key}</span>
            <b>{format ? format(Number(i.value), key) : i.value}</b>
          </div>
        );
      })}
    </div>
  );
}

export type Point = { label: string; value: number | null };

/** Подписи под мини-графиком: первая, средняя, последняя дата. */
function AxisLabels({ points }: { points: Point[] }) {
  if (points.length < 2) return null;
  const mid = points[Math.floor((points.length - 1) / 2)];
  return (
    <div className="db-axis3">
      <span>{points[0].label}</span><span>{mid.label}</span><span>{points[points.length - 1].label}</span>
    </div>
  );
}

/** Плавная линия с градиентной заливкой — для плиток «Сумма заказов» и «Заказы». */
export function MiniArea({ points, color, name, format }: { points: Point[]; color: string; name: string; format: (v: number) => string }) {
  const id = useId().replace(/:/g, '');
  if (points.filter(p => p.value !== null).length < 2) return <div className="db-mini-empty">история по дням появится после сбора РНП</div>;
  return (
    <div className="db-mini">
      <div className="db-mini-area" style={{ color }}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={points} margin={{ top: 4, right: 2, bottom: 0, left: 2 }}>
            <defs>
              <linearGradient id={`a${id}`} x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stopColor="currentColor" stopOpacity={0.32} />
                <stop offset="100%" stopColor="currentColor" stopOpacity={0} />
              </linearGradient>
            </defs>
            <XAxis dataKey="label" hide />
            <YAxis hide domain={['dataMin', 'dataMax']} />
            <Tooltip cursor={false} content={<ChartTip names={{ value: name }} format={v => format(v)} />} />
            <Area dataKey="value" type="monotone" stroke="currentColor" strokeWidth={2} fill={`url(#a${id})`} dot={false} connectNulls isAnimationActive />
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <AxisLabels points={points} />
    </div>
  );
}

/** Столбики, последний — ярким цветом, остальные бледнее (как «Portfolio Return»). */
export function MiniBars({ points, color, name, format }: { points: Point[]; color: string; name: string; format: (v: number) => string }) {
  if (points.filter(p => p.value !== null).length < 2) return <div className="db-mini-empty">история по дням появится после сбора РНП</div>;
  const last = points.length - 1;
  const shape = (active: boolean) => (props: any) => (
    <rect x={props.x} y={props.y} width={props.width} height={Math.max(0, props.height)} rx={3}
      fill={props.index === last || active ? color : `color-mix(in srgb, ${color} 35%, transparent)`} />
  );
  return (
    <div className="db-mini">
      <div className="db-mini-bars">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={points} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
            <XAxis dataKey="label" hide />
            <YAxis hide domain={[0, 'dataMax']} />
            <Tooltip cursor={false} content={<ChartTip names={{ value: name }} format={v => format(v)} />} />
            <Bar dataKey="value" shape={shape(false)} activeBar={shape(true)} isAnimationActive />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <AxisLabels points={points} />
    </div>
  );
}

/** Полоса-прогресс с подписями по краям (как «цель» в Capitalio). */
export function ProgressBar({ pct, color, left, right }: { pct: number; color: string; left: ReactNode; right: ReactNode }) {
  return (
    <div className="db-progress">
      <div className="db-progress-track"><div className="db-progress-fill" style={{ width: `${Math.max(0, Math.min(100, pct))}%`, background: color }} /></div>
      <div className="db-progress-labels"><span>{left}</span><span>{right}</span></div>
    </div>
  );
}

export type DayRow = { label: string; date: string; wb: number | null; oz: number | null; prev: number | null; today?: boolean };

/** Размер подписей на осях: главная набрана крупно (замечание владельца 21.10 — «шрифт вдвое больше»). */
const TICK = 22;

/**
 * Большой график «Заказы по дням»: WB и Ozon — заливка друг над другом,
 * пунктир — такое же окно до этого. Фон в точку, как в «Performance» у Capitalio.
 */
export function OrdersChart({ rows, showWb, showOz, prevName }: { rows: DayRow[]; showWb: boolean; showOz: boolean; prevName: string }) {
  const id = useId().replace(/:/g, '');
  const names = { wb: 'Wildberries', oz: 'Ozon', prev: prevName };
  // Крупные подписи: не больше ~7 дат по оси, иначе налезают друг на друга.
  const every = Math.max(1, Math.ceil(rows.length / 7));
  return (
    <div className="db-big">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={rows} margin={{ top: 8, right: 36, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id={`wb${id}`} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="var(--db-wb)" stopOpacity={0.42} />
              <stop offset="100%" stopColor="var(--db-wb)" stopOpacity={0.04} />
            </linearGradient>
            <linearGradient id={`oz${id}`} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="var(--db-oz)" stopOpacity={0.42} />
              <stop offset="100%" stopColor="var(--db-oz)" stopOpacity={0.04} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} stroke="var(--db-line)" strokeDasharray="3 5" />
          <XAxis dataKey="label" axisLine={false} tickLine={false} interval={every - 1}
            tick={{ fill: 'var(--db-muted)', fontSize: TICK }} dy={10} height={44} />
          <YAxis axisLine={false} tickLine={false} width={124} tickFormatter={v => fmtAxis(Number(v))}
            tick={{ fill: 'var(--db-muted)', fontSize: TICK }} />
          <Tooltip cursor={{ stroke: 'var(--db-line)', strokeWidth: 1 }}
            content={<ChartTip names={names} format={v => fmtRub(v)} title={(_l, p) => p?.date ? `${fmtDay(p.date)}${p.today ? ' · сегодня, день не закрыт' : ''}` : _l} />} />
          {showWb && <Area dataKey="wb" stackId="mp" type="monotone" stroke="var(--db-wb)" strokeWidth={2.5} fill={`url(#wb${id})`} dot={false} connectNulls isAnimationActive />}
          {showOz && <Area dataKey="oz" stackId="mp" type="monotone" stroke="var(--db-oz)" strokeWidth={2.5} fill={`url(#oz${id})`} dot={false} connectNulls isAnimationActive />}
          <Line dataKey="prev" type="monotone" stroke="var(--db-text)" strokeOpacity={0.45} strokeWidth={2} strokeDasharray="6 6" dot={false} isAnimationActive />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

export type Slice = { label: string; value: number; color: string; hint?: string };

/** Кольцо долей с отступами и скруглёнными краями, в центре — главная цифра. */
export function Donut({ slices, center, sub }: { slices: Slice[]; center: ReactNode; sub: ReactNode }) {
  const data = slices.filter(s => s.value > 0).map(s => ({ name: s.label, value: s.value, fill: s.color }));
  return (
    <div className="db-donut">
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie data={data} dataKey="value" innerRadius="70%" outerRadius="92%" paddingAngle={data.length > 1 ? 5 : 0}
            cornerRadius={5} startAngle={90} endAngle={-270} stroke="none" isAnimationActive />
          <Tooltip cursor={false} wrapperStyle={{ zIndex: 20 }} content={<ChartTip format={v => fmtRub(v)} title={(_l, p) => p?.name} />} />
        </PieChart>
      </ResponsiveContainer>
      <div className="db-donut-c"><b>{center}</b><span>{sub}</span></div>
    </div>
  );
}

/** Горизонтальная полоса долей со штриховкой (как «Asset Classes»). */
export function StripeBar({ slices }: { slices: Slice[] }) {
  const total = slices.reduce((s, x) => s + Math.max(0, x.value), 0);
  if (!(total > 0)) return null;
  return (
    <div className="db-stripe" role="img" aria-label={slices.map(s => `${s.label} ${Math.round(s.value / total * 100)} %`).join(', ')}>
      {slices.filter(s => s.value > 0).map(s => (
        <i key={s.label} title={`${s.label}: ${Math.round(s.value / total * 1000) / 10} %`}
          style={{ flexGrow: s.value, background: `repeating-linear-gradient(45deg, color-mix(in srgb, ${s.color} 86%, black) 0 7px, ${s.color} 7px 17px)` }} />
      ))}
    </div>
  );
}
