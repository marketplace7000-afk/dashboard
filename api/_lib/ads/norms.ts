/**
 * Нормы ДРР по категориям — хранение и чтение.
 *
 * Клиент считает эффективность рекламы именно в ДРР, и норма у него зависит от
 * категории: «автотовары до 5%, косметология до 20%» (слова Дмитрия 31.07).
 * Поэтому нормы должны задаваться людьми из интерфейса, а не лежать в переменных
 * окружения: менять их будет специалист по рекламе, а не разработчик.
 *
 * Хранилище — дисковый кэш с очень долгим сроком жизни: это настройка, а не
 * кэшированные данные, но заводить ради неё отдельную базу незачем.
 */
import { cacheGet, cacheSet } from '../cache';
import { categoryDrrAsNorms } from './categoryDrr';

const KEY = 'ads-drr-norms:v1';
const TTL_MS = 365 * 24 * 60 * 60_000;
// Заготовки норм из фактического ДРР по категориям кэшируем: чтение листов дорогое.
const DERIVED_KEY = 'ads-drr-norms-derived:v1';
const DERIVED_TTL_MS = 6 * 60 * 60_000;
/** Ключ «*» — значение для категорий, которых нет в списке. */
export const DEFAULT_KEY = '*';

export type DrrNorms = Record<string, number>;

/** Значение по умолчанию, пока нормы не заданы: автотовары, со слов клиента. */
const FALLBACK: DrrNorms = { [DEFAULT_KEY]: 5 };

export async function getDrrNorms(): Promise<DrrNorms> {
  const c = await cacheGet<DrrNorms>(KEY);
  const stored = c?.data;
  if (stored && Object.keys(stored).length) return stored;

  // Пока никто ничего не сохранял — можно задать стартовые значения через env,
  // формат «автотовары:5,косметика:20,*:7».
  const raw = (process.env.AGENT_ADS_DRR_NORMS || '').trim();
  if (raw) {
    const out: DrrNorms = {};
    for (const part of raw.split(',')) {
      const [k, v] = part.split(':').map(s => (s ?? '').trim());
      const n = Number(v);
      if (k && Number.isFinite(n)) out[k.toLowerCase()] = n;
    }
    if (Object.keys(out).length) return out;
  }

  // Клиент норм не задал — вместо плоских 5% берём ФАКТИЧЕСКИЙ ДРР по каждой
  // категории (из листов «ДРР и цены» + «Маржа»). Это отправная точка: у магнитол
  // и у брюк экономика рекламы разная, единый порог не подходит. Кэшируем —
  // чтение листов дорогое.
  const derivedCached = await cacheGet<DrrNorms>(DERIVED_KEY);
  if (derivedCached?.data && Object.keys(derivedCached.data).length) {
    return { ...derivedCached.data, [DEFAULT_KEY]: derivedCached.data[DEFAULT_KEY] ?? 5 };
  }
  const derived = await categoryDrrAsNorms().catch(() => ({}));
  if (Object.keys(derived).length) {
    await cacheSet(DERIVED_KEY, derived, DERIVED_TTL_MS);
    return { ...derived, [DEFAULT_KEY]: 5 };
  }
  return FALLBACK;
}

/** Сохранить нормы. Пустые и отрицательные значения отбрасываем. */
export async function saveDrrNorms(input: Record<string, unknown>): Promise<DrrNorms> {
  const out: DrrNorms = {};
  for (const [k, v] of Object.entries(input ?? {})) {
    const key = String(k).trim().toLowerCase();
    const n = Number(v);
    if (key && Number.isFinite(n) && n > 0 && n <= 100) out[key] = Math.round(n * 10) / 10;
  }
  if (!out[DEFAULT_KEY]) out[DEFAULT_KEY] = FALLBACK[DEFAULT_KEY];
  await cacheSet(KEY, out, TTL_MS);
  return out;
}
