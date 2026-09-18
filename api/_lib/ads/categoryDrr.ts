/**
 * Фактический ДРР по КАТЕГОРИЯМ — из тех же данных, что мы и раньше доставали.
 *
 * Как считали ДРР исторически (см. src/api/googleSheets.ts): лист «ДРР и цены»,
 * расход ÷ заказы за 7 дней, отдельно Ozon (кол. B/C) и WB (кол. F/G). Категория
 * берётся из листа «Маржа» (кол. A=SKU, B=категория, H=SKU WB).
 *
 * Здесь агрегируем это по категориям: суммируем расход и заказы всех товаров
 * категории и делим — получается взвешенный фактический ДРР, а не среднее по
 * строкам (крупные товары весят больше, как и должно быть).
 *
 * ВАЖНО про смысл: это ФАКТ (сколько тратится сейчас), а не НОРМА (порог, который
 * задаёт бизнес). Норму из факта не вывести — но факт даёт клиенту отправную
 * точку и проверку: сходится ли норма специалиста с реальностью («их ДРР
 * совпадал с нашим»).
 */
import { fetchSheetRows } from '../sheets';

export type CategoryDrr = {
  category: string;
  drr: number;        // взвешенный фактический ДРР, %
  spend: number;      // суммарный расход за период, ₽
  orders: number;     // суммарно заказов
  skuCount: number;
};

const up = (v: any) => String(v ?? '').trim().toUpperCase();
const numOrNull = (x: any) => (x === '' || x == null || !Number.isFinite(Number(x))) ? null : Number(x);

/** SKU → категория из листа «Маржа» (A=SKU Ozon, B=категория, H=SKU WB). */
export async function skuToCategory(): Promise<Map<string, string>> {
  const rows = await fetchSheetRows('Маржа');
  const map = new Map<string, string>();
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i]; if (!r) continue;
    const cat = String(r[1] ?? '').trim();
    if (!cat) continue;
    const skuO = up(r[0]);
    const skuW = up(r[7]);
    if (skuO) map.set(skuO, cat);
    if (skuW) map.set(skuW, cat);   // WB-артикул той же карточки → та же категория
  }
  return map;
}

/**
 * Фактический ДРР по категориям.
 * @returns массив по убыванию расхода (сначала весомые категории)
 */
export async function getCategoryDrr(): Promise<CategoryDrr[]> {
  const [drrRows, catMap] = await Promise.all([
    fetchSheetRows('ДРР и цены'),
    skuToCategory(),
  ]);

  // категория → накопитель
  const acc = new Map<string, { spend: number; orders: number; skus: Set<string> }>();
  const bump = (cat: string, spend: number, orders: number, sku: string) => {
    const a = acc.get(cat) ?? { spend: 0, orders: 0, skus: new Set<string>() };
    a.spend += spend; a.orders += orders; a.skus.add(sku);
    acc.set(cat, a);
  };

  for (let i = 1; i < drrRows.length; i++) {
    const r = drrRows[i]; if (!r) continue;
    const sku = up(r[0]);
    if (!sku) continue;
    const cat = catMap.get(sku);
    if (!cat) continue;                       // нет категории — в «прочее» не сваливаем, пропускаем
    const adOz = numOrNull(r[1]) ?? 0, ordOz = numOrNull(r[2]) ?? 0;
    const adWb = numOrNull(r[5]) ?? 0, ordWb = numOrNull(r[6]) ?? 0;
    // Обе площадки в одну категорию: ДРР — это доля расхода в обороте, а он общий.
    bump(cat, adOz + adWb, ordOz + ordWb, sku);
  }

  const out: CategoryDrr[] = [];
  for (const [category, a] of acc) {
    if (a.orders <= 0) continue;              // без заказов ДРР не определён
    out.push({
      category,
      drr: Math.round(a.spend / a.orders * 1000) / 10,
      spend: Math.round(a.spend),
      orders: Math.round(a.orders),
      skuCount: a.skus.size,
    });
  }
  out.sort((x, y) => y.spend - x.spend);
  return out;
}

/** Готовые нормы-заготовки: category(lowercase) → фактический ДРР. Для getDrrNorms. */
export async function categoryDrrAsNorms(): Promise<Record<string, number>> {
  const list = await getCategoryDrr().catch(() => []);
  const out: Record<string, number> = {};
  for (const c of list) out[c.category.toLowerCase()] = c.drr;
  return out;
}
