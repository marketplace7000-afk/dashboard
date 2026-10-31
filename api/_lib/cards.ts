/**
 * «Ведение карточек» (31.10.2026): закреплённые за агентом карточки WB и Ozon и их рамки.
 * Раздел только для владельца: сервер закрывает /api/cards всем остальным (permissions.ts).
 *
 * Первая версия ничего не меняет на площадках: хранит закрепления и рамки и показывает
 * цифры из РНП. Сбор запросов и план действий добавятся следующими этапами.
 * Разбор — Заметки\Агенты и боты\Агент ведения карточек — анализ и варианты.md.
 */
import { adsDb } from './ads/store';
import { mskDate } from './mskDate';
import { rnpItems, rnpSkuTotals } from './rnp';
import type { RnpMp } from '../../shared/rnp';

export type CardGoal = 'growth' | 'hold' | 'sell_out';
const GOALS: CardGoal[] = ['growth', 'hold', 'sell_out'];

export type CardSettings = {
  goal: CardGoal;
  /** Минимальная маржа, %. null — не задана. */
  minMarginPct: number | null;
  /** Предельный ДРР, %. null — не задан. */
  maxDrrPct: number | null;
  /** Минимальный запас товара, дней. null — не задан. */
  minStockDays: number | null;
};

export type CardPeriod = { orders: number; amount: number; ads: number; drrPct: number | null };

export type CardPin = CardSettings & {
  mp: RnpMp; sku: string; article: string; name: string; photo: string; pinnedAt: number;
  cur: CardPeriod | null; prev: CardPeriod | null; stock: number | null; price: number | null;
  /** Последний день, за который в РНП есть данные по карточке. */
  dataDate: string | null;
};

let ready = false;
function db(): any {
  const d = adsDb();
  if (!d) throw new Error('хранилище недоступно');
  if (!ready) {
    d.exec(`CREATE TABLE IF NOT EXISTS card_pin (
      mp TEXT NOT NULL, sku TEXT NOT NULL, goal TEXT NOT NULL, min_margin REAL, max_drr REAL, min_stock_days REAL,
      pinned_at INTEGER NOT NULL, PRIMARY KEY (mp, sku));`);
    ready = true;
  }
  return d;
}

const isMp = (v: unknown): v is RnpMp => v === 'wb' || v === 'ozon';

/** Необязательное число в пределах; пусто — null, иначе ошибка с понятным текстом. */
function limit(v: unknown, name: string, max: number): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > max) throw new Error(`${name}: нужно число от 0 до ${max}`);
  return n;
}

const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

function period(t: { orders: number; amount: number; ads: number } | null): CardPeriod | null {
  if (!t) return null;
  return { ...t, drrPct: t.amount > 0 ? Math.round((t.ads / t.amount) * 1000) / 10 : null };
}

export function listPins(): CardPin[] {
  const rows = db().prepare('SELECT * FROM card_pin ORDER BY pinned_at DESC').all() as any[];
  // Сравниваем закрытые дни: неполное «сегодня» занизило бы последнюю неделю.
  const to = mskDate(1), from = addDays(to, -6), prevTo = addDays(from, -1), prevFrom = addDays(prevTo, -6);
  const items = new Map<string, ReturnType<typeof rnpItems>[number]>();
  for (const mp of ['wb', 'ozon'] as RnpMp[]) for (const it of rnpItems(mp)) items.set(`${mp}:${it.sku}`, it);
  return rows.map(r => {
    const mp = r.mp as RnpMp, sku = String(r.sku);
    const it = items.get(`${mp}:${sku}`);
    const cur = rnpSkuTotals(mp, sku, from, to), prev = rnpSkuTotals(mp, sku, prevFrom, prevTo);
    return {
      mp, sku, article: it?.article ?? '', name: it?.name ?? '', photo: it?.photo ?? '', pinnedAt: Number(r.pinned_at),
      goal: r.goal as CardGoal, minMarginPct: r.min_margin ?? null, maxDrrPct: r.max_drr ?? null, minStockDays: r.min_stock_days ?? null,
      cur: period(cur), prev: period(prev), stock: cur?.stock ?? null, price: cur?.price ?? null, dataDate: cur?.lastDate ?? null,
    };
  });
}

/** Товары площадки, которые ещё можно закрепить. */
export function catalog(mp: unknown) {
  if (!isMp(mp)) throw new Error('площадка: wb или ozon');
  const pinned = new Set((db().prepare('SELECT sku FROM card_pin WHERE mp = ?').all(mp) as any[]).map(r => String(r.sku)));
  return rnpItems(mp).filter(i => !pinned.has(i.sku)).map(i => ({ sku: i.sku, article: i.article, name: i.name, photo: i.photo }));
}

/** Закрепить карточку или изменить её рамки. */
export function savePin(input: any): void {
  if (!isMp(input?.mp)) throw new Error('площадка: wb или ozon');
  const sku = String(input?.sku ?? '').trim();
  if (!sku || !rnpItems(input.mp).some(i => i.sku === sku)) throw new Error('такого товара нет в РНП');
  const goal: CardGoal = input?.goal === undefined ? 'growth' : input.goal;
  if (!GOALS.includes(goal)) throw new Error('неизвестная цель');
  const minMargin = limit(input?.minMarginPct, 'Минимальная маржа', 100);
  const maxDrr = limit(input?.maxDrrPct, 'Предельный ДРР', 100);
  const minStock = limit(input?.minStockDays, 'Минимальный запас', 365);
  db().prepare(`INSERT INTO card_pin (mp, sku, goal, min_margin, max_drr, min_stock_days, pinned_at) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(mp, sku) DO UPDATE SET goal = excluded.goal, min_margin = excluded.min_margin,
      max_drr = excluded.max_drr, min_stock_days = excluded.min_stock_days`)
    .run(input.mp, sku, goal, minMargin, maxDrr, minStock, Date.now());
}

export function removePin(input: any): void {
  if (!isMp(input?.mp)) throw new Error('площадка: wb или ozon');
  db().prepare('DELETE FROM card_pin WHERE mp = ? AND sku = ?').run(input.mp, String(input?.sku ?? ''));
}
