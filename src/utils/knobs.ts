/**
 * Ручные значения («крутилки») в раскрытой строке листов цен WB/Ozon (05.10.2026).
 *
 * Жалоба клиента: после автоматического сбора цен маржа у части товаров не
 * менялась — помогало только поменять любое поле в расчёте и нажать «Сбросить».
 * Причина: введённое вручную значение (цена, СПП, ДРР, себестоимость…) хранилось
 * бессрочно, общее для всех пользователей, и перекрывало свежие данные. На 05.10
 * так «замёрзли» 8 товаров WB и 1 товар Ozon.
 *
 * Теперь вместе с ручным значением запоминается, какое значение было «по
 * данным» в момент ввода (база). Пока данные те же — действует ручное значение
 * (сценарий «что если»). Как только данные по этому полю обновились (новая цена
 * с витрины, себестоимость из «Склада», СПП…), ручное значение снимается и
 * расчёт идёт по свежим цифрам. Значения без базы (старые, до 05.10) снимаются.
 * Проверки — scripts/check-knobs.ts.
 */

/** id товара → поле → сырая строка из поля ввода. */
export type KnobMap = Record<string, Record<string, string>>;
/** id товара → поле → значение «по данным» в момент ввода. */
export type KnobBase = Record<string, Record<string, number>>;
/** Значения «по данным» (без ручных правок) для одного товара. */
export type AutoValues = Record<string, number | undefined>;

/** Данные не изменились: разница в пределах округления (½ п.п. или 0.2% суммы). */
export function sameAuto(now: number, base: number): boolean {
  return Math.abs(now - base) <= Math.max(0.5, Math.abs(base) * 0.002);
}

function keepKnob(value: string | undefined, base: number | undefined, auto: number | undefined): boolean {
  if (value === undefined) return false;
  if (base === undefined || !Number.isFinite(base)) return false;            // старое значение без базы
  if (auto === undefined || !Number.isFinite(auto)) return true;             // данных пока нет — судить не по чему
  return sameAuto(auto, base);
}

/** Ручные значения товара, которые ещё действуют (данные под ними не менялись). */
export function activeKnobs(id: string | number, knobs: KnobMap, base: KnobBase, auto: AutoValues): Record<string, string> {
  const k = knobs[String(id)];
  if (!k) return {};
  const b = base[String(id)] ?? {};
  const out: Record<string, string> = {};
  for (const [key, v] of Object.entries(k)) if (keepKnob(v, b[key], auto[key])) out[key] = v;
  return out;
}

/**
 * Убрать устаревшие ручные значения по всем товарам. autoById — значения «по
 * данным» по товарам; товар, которого там нет (данные не загружены), не трогаем.
 */
export function pruneKnobs(knobs: KnobMap, base: KnobBase, autoById: Record<string, AutoValues>):
  { knobs: KnobMap; base: KnobBase; dropped: string[] } {
  const nk: KnobMap = {};
  const nb: KnobBase = {};
  const dropped: string[] = [];
  for (const [id, k] of Object.entries(knobs)) {
    const auto = autoById[id];
    const b = base[id] ?? {};
    const keepK: Record<string, string> = {};
    const keepB: Record<string, number> = {};
    for (const [key, v] of Object.entries(k ?? {})) {
      if (!auto || keepKnob(v, b[key], auto[key])) {
        keepK[key] = v;
        if (b[key] !== undefined) keepB[key] = b[key];
      } else dropped.push(`${id}:${key}`);
    }
    if (Object.keys(keepK).length) { nk[id] = keepK; if (Object.keys(keepB).length) nb[id] = keepB; }
  }
  return { knobs: nk, base: nb, dropped };
}
