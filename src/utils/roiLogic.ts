// Коридоры ROI по диапазонам себестоимости из таблицы "Новая таблица ROI со снижением"
export type RoiBucket = {
  min: number;
  max: number;
  target: number;   // Цель на входе
  stopBuy: number;  // Стоп-докуп ниже
  exit: number;     // Выход ниже
};

export const ROI_TABLE: RoiBucket[] = [
  { min: 100,  max: 200,   target: 250, stopBuy: 188, exit: 130 },
  { min: 200,  max: 300,   target: 200, stopBuy: 150, exit: 101 },
  { min: 300,  max: 400,   target: 140, stopBuy: 105, exit: 80 },
  { min: 400,  max: 500,   target: 118, stopBuy: 95,  exit: 77 },
  { min: 500,  max: 600,   target: 116, stopBuy: 87,  exit: 74 },
  { min: 600,  max: 700,   target: 114, stopBuy: 85,  exit: 72 },
  { min: 700,  max: 800,   target: 112, stopBuy: 83,  exit: 71 },
  { min: 800,  max: 900,   target: 109, stopBuy: 81,  exit: 69 },
  { min: 900,  max: 1000,  target: 106, stopBuy: 80,  exit: 67 },
  { min: 1000, max: 1500,  target: 104, stopBuy: 78,  exit: 66 },
  { min: 1500, max: 2000,  target: 101, stopBuy: 76,  exit: 64 },
  { min: 2000, max: 2500,  target: 98,  stopBuy: 74,  exit: 62 },
  { min: 2500, max: 3000,  target: 96,  stopBuy: 72,  exit: 61 },
  { min: 3000, max: 3500,  target: 93,  stopBuy: 70,  exit: 59 },
  { min: 3500, max: 4000,  target: 90,  stopBuy: 68,  exit: 57 },
  { min: 4000, max: 4500,  target: 88,  stopBuy: 66,  exit: 56 },
  { min: 4500, max: 5000,  target: 85,  stopBuy: 65,  exit: 54 },
  { min: 5000, max: 5500,  target: 82,  stopBuy: 63,  exit: 52 },
  { min: 5500, max: 6000,  target: 79,  stopBuy: 61,  exit: 50 },
  { min: 6000, max: 6500,  target: 77,  stopBuy: 59,  exit: 49 },
  { min: 6500, max: 7000,  target: 74,  stopBuy: 57,  exit: 47 },
  { min: 7000, max: 7500,  target: 71,  stopBuy: 55,  exit: 45 },
  { min: 7500, max: 8000,  target: 69,  stopBuy: 53,  exit: 44 },
  { min: 8000, max: 8500,  target: 66,  stopBuy: 52,  exit: 42 },
  { min: 8500, max: 9000,  target: 63,  stopBuy: 50,  exit: 40 },
  { min: 9000, max: 9500,  target: 61,  stopBuy: 48,  exit: 39 },
  { min: 9500, max: 10000, target: 58,  stopBuy: 46,  exit: 37 },
];

export type RoiStatus = 'ok' | 'warn' | 'danger' | 'stop' | 'none';

export type RoiResult = {
  roi: number | null;
  bucket: RoiBucket | null;
  status: RoiStatus;
  label: string;
  hint: string;
};

export function lookupBucket(cost: number): RoiBucket | null {
  if (!cost || cost <= 0) return null;
  for (const b of ROI_TABLE) {
    if (cost >= b.min && cost < b.max) return b;
  }
  // экстраполяция за пределами таблицы — берём ближайший край
  if (cost < ROI_TABLE[0].min) return ROI_TABLE[0];
  return ROI_TABLE[ROI_TABLE.length - 1];
}

// ROI = profit / cost × 100 = price × margin% / cost
export function calcROI(price: number | null, marginPct: number | null, cost: number): number | null {
  if (!price || marginPct === null || marginPct === undefined || !cost) return null;
  return Math.round((price * marginPct) / cost * 10) / 10;
}

const STATUS_LABEL: Record<RoiStatus, string> = {
  ok:     'норма',
  warn:   'внимание',
  danger: 'стоп-докуп',
  stop:   'выход',
  none:   '—',
};

const STATUS_HINT: Record<RoiStatus, string> = {
  ok:     'ROI выше цели — продолжаем закупать',
  warn:   'ROI ниже цели, но выше стоп-докупа',
  danger: 'Новую партию не заказывать',
  stop:   'Распродавать остаток и выводить SKU',
  none:   'Недостаточно данных',
};

export function roiStatus(roi: number | null, cost: number): RoiResult {
  const bucket = lookupBucket(cost);
  if (roi === null || !bucket) {
    return { roi, bucket, status: 'none', label: STATUS_LABEL.none, hint: STATUS_HINT.none };
  }
  let status: RoiStatus;
  if (roi >= bucket.target) status = 'ok';
  else if (roi >= bucket.stopBuy) status = 'warn';
  else if (roi >= bucket.exit) status = 'danger';
  else status = 'stop';
  return { roi, bucket, status, label: STATUS_LABEL[status], hint: STATUS_HINT[status] };
}

export const ROI_STATUS_COLOR: Record<RoiStatus, { bg: string; color: string }> = {
  ok:     { bg: 'rgba(22,163,74,.10)',  color: 'var(--good)' },
  warn:   { bg: 'rgba(217,119,6,.10)',  color: 'var(--warn)' },
  danger: { bg: 'rgba(220,38,38,.10)',  color: 'var(--bad)' },
  stop:   { bg: 'rgba(220,38,38,.15)',  color: 'var(--bad)' },
  none:   { bg: 'var(--bg-3)',          color: 'var(--muted)' },
};
