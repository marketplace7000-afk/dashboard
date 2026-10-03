/**
 * Товары Ozon в наличии, которых нет на страницах магазина (03.10.2026).
 *
 * Жалоба клиента: ALLPOWERS-STAN1,5kWh-AP-S2000-PRO (46 шт. в наличии) в
 * дашборде 65 465 ₽ «факт», на витрине 76 000 ₽ по Ozon Карте; тот же товар,
 * R2500-V2 и SUNPANEL-200W-SE200 мигали в фильтре «В продаже». Причина: Ozon
 * выводит на страницах магазина (ozon.ru/seller/avto-vibe) не все товары —
 * обход находил 41 из ~44 в наличии, а всё ненайденное агент записывал в «не
 * продаётся» и карточку не открывал (правило 26.09 против пустых карточек).
 *
 * Теперь сервер передаёт в задании, какие offer_id в наличии и их sku витрины,
 * а агент открывает карточку только тех из них, кого не нашёл на страницах
 * магазина. Товары без остатка по-прежнему не открываются.
 * Модуль общий для сервера и agent-host; проверки — scripts/check-ozon-instock.ts.
 */

/** offer_id (UPPER) в наличии → его sku витрины. Только остаток > 0. */
export function inStockOffers(
  skuMap: Record<string, string>,
  byOffer: Record<string, number>,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [sku, offerRaw] of Object.entries(skuMap)) {
    const offer = String(offerRaw || '').toUpperCase();
    if (!offer || !sku || !((byOffer[offer] ?? 0) > 0)) continue;
    (out[offer] ??= []).includes(sku) || out[offer].push(sku);
  }
  return out;
}

/**
 * Какие карточки открыть: по товару в наличии, ни один sku которого не найден
 * на страницах магазина. Возвращает группы sku (по одной на товар) — агент
 * пробует их по очереди до первой цены. max — потолок карточек за проход
 * (человеческий темп, конституция: никакого массового обхода).
 */
export function pickDirectCards(
  found: Set<string>,
  offers: Record<string, string[]>,
  max: number,
): { offer: string; skus: string[] }[] {
  const out: { offer: string; skus: string[] }[] = [];
  for (const [offer, skus] of Object.entries(offers)) {
    if (!skus.length || skus.some((s) => found.has(s))) continue;
    out.push({ offer, skus: skus.slice(0, 2) });
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Цены с карточки Ozon по числам из виджета webPrice (в порядке появления).
 * На карточке три цифры: «с банками/Ozon Картой», «с другими банками»,
 * зачёркнутая. Берём цену С КАРТОЙ — её же Ozon показывает на плитках
 * магазина, так цена с карточки сопоставима с ценами с витрины.
 */
export function pickCardPrices(nums: number[]): { price: number; noCard?: number; oldPrice?: number } | null {
  const s = [...new Set(nums.filter((n) => n > 0))].sort((a, b) => a - b);
  if (!s.length) return null;
  if (s.length >= 3) return { price: s[0], noCard: s[1], oldPrice: s[s.length - 1] };
  // Две цифры: либо «с картой» + «без карты» (разница ~10%), либо цена +
  // зачёркнутая (разница в разы). Зачёркнутой считаем только заметно большую.
  if (s.length === 2) return s[1] > s[0] * 1.25 ? { price: s[0], oldPrice: s[1] } : { price: s[0], noCard: s[1] };
  return { price: s[0] };
}
