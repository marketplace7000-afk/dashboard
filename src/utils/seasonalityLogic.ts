import { ProcurementItem } from '../api/googleSheets';

export const MONTHS = ['Янв', 'Фев', 'Мар', 'Апр', 'Май', 'Июн', 'Июл', 'Авг', 'Сен', 'Окт', 'Ноя', 'Дек'];

export type CategorySeasonality = {
  category: string;
  skus: number;
  ozon: (number | null)[];
  wb: (number | null)[];
  peakMonth: string | null;
  peakValue: number | null;
  insight: string;
};

// Editorial insights keyed by category — fallback inferred from peak month if not listed
const INSIGHTS: Record<string, string> = {
  'Наборы для полировки автомобиля':
    'Пик — летне-осенний сезон (июль–сентябрь): автомобилисты готовят ЛКП перед зимой. Провал — февраль. Планируй закупку под апрель–май.',
  'Магнитолы автомобильные':
    'Рост с июля по декабрь. Декабрь — абсолютный пик на WB. Февраль — минимум. Подготовь запас к сентябрю–октябрю.',
  'Квадрокоптер':
    'Ярко выраженный пик — апрель: сезон дачи и путешествий. Февраль–март — мёртвый сезон.',
};

function computeCoefs(values: number[][]): (number | null)[] {
  // values: array of per-SKU 12-month plans
  if (!values.length) return Array(12).fill(null);
  const monthSums = Array(12).fill(0);
  for (const arr of values) {
    for (let i = 0; i < 12; i++) monthSums[i] += arr[i] || 0;
  }
  const total = monthSums.reduce((s, v) => s + v, 0);
  if (total <= 0) return Array(12).fill(null);
  const avg = total / 12;
  return monthSums.map(v => Math.round((v / avg) * 100) / 100);
}

export function buildSeasonality(items: ProcurementItem[]): CategorySeasonality[] {
  const byCat: Record<string, ProcurementItem[]> = {};
  for (const p of items) {
    const cat = p.category || '—';
    if (!byCat[cat]) byCat[cat] = [];
    byCat[cat].push(p);
  }

  return Object.entries(byCat)
    .filter(([cat]) => cat !== '—')
    .map(([category, group]) => {
      const planOzons = group.map(p => p.planOzon).filter((a): a is number[] => Array.isArray(a) && a.length === 12);
      const planWBs = group.map(p => p.planWB).filter((a): a is number[] => Array.isArray(a) && a.length === 12);

      const ozon = planOzons.length ? computeCoefs(planOzons) : Array(12).fill(null);
      const wb = planWBs.length ? computeCoefs(planWBs) : Array(12).fill(null);

      const allVals = [...ozon, ...wb].filter((v): v is number => v !== null && v > 0);
      const peakValue = allVals.length ? Math.max(...allVals) : null;
      let peakMonth: string | null = null;
      if (peakValue !== null) {
        const idxO = ozon.findIndex(v => v === peakValue);
        const idxW = wb.findIndex(v => v === peakValue);
        const idx = idxO >= 0 ? idxO : idxW;
        if (idx >= 0) peakMonth = MONTHS[idx];
      }

      const insight = INSIGHTS[category] ||
        (peakMonth ? `Пик спроса — ${peakMonth} (×${peakValue?.toFixed(2)}). Планируй закупку заранее.` :
          'Нет данных в листе «План» для расчёта сезонности. Добавь плановые продажи по месяцам в Google Таблицу.');

      return { category, skus: group.length, ozon, wb, peakMonth, peakValue, insight };
    })
    .sort((a, b) => b.skus - a.skus);
}

export function coefColor(v: number | null): string {
  if (v === null) return 'var(--muted)';
  if (v >= 1.25) return 'var(--good)';
  if (v >= 1.05) return 'var(--text)';
  if (v >= 0.85) return 'var(--text)';
  if (v >= 0.6) return 'var(--warn)';
  return 'var(--bad)';
}
