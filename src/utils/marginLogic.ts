import { ProcurementItem } from '../api/googleSheets';

export type Trend = {
  first: number;
  last: number;
  prev: number;
  delta: number;
  periodDelta: number;
  downStreak: number;
  vals: number[];
  lastWeekDelta: number;
};

export type Severity = 'danger' | 'warning' | 'ok' | 'none';

export function calcTrend(
  history: ProcurementItem['marginHistory'],
  field: 'o' | 'wb',
): Trend | null {
  if (!history || history.length < 2) return null;
  const vals = history.map(h => h[field]).filter((v): v is number => v !== null && v !== undefined);
  if (vals.length < 2) return null;
  const first = vals[0];
  const last = vals[vals.length - 1];
  const prev = vals[vals.length - 2];
  const delta = Math.round((last - prev) * 10) / 10;
  const periodDelta = Math.round((last - first) * 10) / 10;
  let downStreak = 0;
  let maxStreak = 0;
  for (let i = 1; i < vals.length; i++) {
    if (vals[i] < vals[i - 1]) { downStreak++; maxStreak = Math.max(maxStreak, downStreak); }
    else downStreak = 0;
  }
  return { first, last, prev, delta, periodDelta, downStreak: maxStreak, vals, lastWeekDelta: delta };
}

export function getSeverity(p: ProcurementItem): Severity {
  if (!p.marginHistory) return 'none';
  const tO = calcTrend(p.marginHistory, 'o');
  const tWB = calcTrend(p.marginHistory, 'wb');
  let sev: Severity = 'ok';
  [tO, tWB].forEach(t => {
    if (!t) return;
    const cur = t.last;
    if (t.downStreak >= 2 || cur < 0) sev = 'danger';
    else if (sev !== 'danger' && (t.lastWeekDelta <= -5 || (cur < 10 && t.delta < 0))) sev = 'warning';
  });
  return sev;
}

export function getChipClass(val: number | null | undefined): 'neutral' | 'neg' | 'warn' | 'pos' {
  if (val === null || val === undefined) return 'neutral';
  if (val < 0) return 'neg';
  if (val < 10) return 'warn';
  return 'pos';
}

export function getDeltaStr(delta: number | null | undefined): string | null {
  if (delta === null || delta === undefined) return null;
  const d = Math.round(delta * 10) / 10;
  return d > 0 ? `+${d}%` : d < 0 ? `${d}%` : '0%';
}
