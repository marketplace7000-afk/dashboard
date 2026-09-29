/**
 * Сценарии из документов специалистов по рекламе (WB и Ozon) — в виде правил.
 *
 * Почему кодом, а не запросом к ИИ: оба документа задают ТОЧНЫЕ пороги (CTR ниже
 * 3%, рост CPC свыше 20%, минимум 1000 показов для вывода) и прямо требуют, чтобы
 * рекомендация подтверждалась цифрами, а при нехватке данных агент честно говорил
 * об этом вместо категоричных выводов. Детерминированные правила это гарантируют,
 * модель — нет. ИИ подключается позже и только для формулировки, не для решения.
 *
 * Пороги вынесены в THRESHOLDS: у клиента они меняются по категориям, и правило
 * не должно требовать правки кода.
 */
import { AdItem, changePct } from './metrics';

export const THRESHOLDS = {
  // Минимумы для вывода (раздел «Минимум для анализа» документа WB).
  minViews: 1000,
  minClicks: 100,
  minCarts: 10,
  minOrders: 5,
  minSpend: 3000,
  // Пороги сценариев.
  ctrLow: 3,            // ниже — требуется анализ
  ctrCritical: 2,       // ниже — критично
  ctrDropPct: 5,        // падение CTR более чем на столько процентов
  cpcGrowthPct: 20,     // рост CPC
  cpmGrowthPct: 20,     // рост CPM
  orderRateLow: 3,      // конверсия в заказ ниже — анализ
  cartToOrderLow: 30,   // из корзины в заказ ниже — анализ
  drrDefault: 5,        // норма ДРР по умолчанию (автотовары, со слов клиента)
};

export type Severity = 'critical' | 'warning' | 'growth' | 'info';

export type Finding = {
  sku: string;
  platform: 'wb' | 'ozon';
  scenario: string;     // короткое имя сценария из документа
  severity: Severity;
  /** Что видим в цифрах — только факты, без интерпретации. */
  facts: string;
  /** Что это может означать. Формулировка предположительная, как требует документ. */
  meaning: string;
  /** Что проверить или сделать. */
  action: string;
};

/** Норма ДРР для товара: по категории, иначе общая. */
export function drrNorm(category: string | undefined, norms: Record<string, number>): number {
  if (category) {
    const key = Object.keys(norms).find(k => k.toLowerCase() === category.toLowerCase());
    if (key) return norms[key];
  }
  return norms['*'] ?? THRESHOLDS.drrDefault;
}

/**
 * Достаточно ли данных для выводов.
 * Документ прямо требует: при нехватке данных не оценивать эффективность, а
 * сказать, чего именно не хватает.
 */
function dataGate(it: AdItem): Finding | null {
  const c = it.current;
  const missing: string[] = [];
  if (c.views < THRESHOLDS.minViews) missing.push(`показов ${Math.round(c.views)} из ${THRESHOLDS.minViews}`);
  if (c.clicks < THRESHOLDS.minClicks) missing.push(`кликов ${Math.round(c.clicks)} из ${THRESHOLDS.minClicks}`);
  if (c.spend < THRESHOLDS.minSpend) missing.push(`расход ${Math.round(c.spend)} ₽ из ${THRESHOLDS.minSpend}`);
  // Сценарий «нет показов» разбираем отдельно — там как раз нулевые данные и есть суть.
  if (c.views > 0 && missing.length >= 2) {
    return {
      sku: it.sku, platform: it.platform, scenario: 'Данных недостаточно', severity: 'info',
      facts: missing.join(', '),
      meaning: 'Любая оценка на таком объёме будет нестабильной.',
      action: 'Подождать накопления статистики. Выводы по эффективности пока не делать.',
    };
  }
  return null;
}

/** Прогон всех сценариев по одному товару. */
export function evaluate(it: AdItem, norms: Record<string, number>): Finding[] {
  const out: Finding[] = [];
  const c = it.current;
  const n = it.derivedNow;
  const p = it.derivedPrev;
  const base = { sku: it.sku, platform: it.platform };

  // 1. Кампания не получает показы (WB сц.1 / Ozon сц.1)
  if (c.views < THRESHOLDS.minViews * 0.1 && c.spend < 100) {
    out.push({
      ...base, scenario: 'Нет показов', severity: 'warning',
      facts: `показов ${Math.round(c.views)}, расход ${Math.round(c.spend)} ₽`,
      meaning: 'Кампания почти не участвует в аукционе. Возможные причины: низкая ставка, маленький бюджет, нет остатка или кампания остановлена.',
      action: 'Проверить статус кампании, ставку, дневной бюджет, остатки и доступность товара. Об эффективности не судить, пока нет трафика.',
    });
    return out;   // без трафика остальные сценарии бессмысленны
  }

  const gate = dataGate(it);
  if (gate) { out.push(gate); return out; }

  // 2. Показы есть, кликов мало (WB сц.2 / Ozon сц.2)
  if (n.ctr !== null && n.ctr < THRESHOLDS.ctrLow) {
    out.push({
      ...base, scenario: 'Низкий CTR',
      severity: n.ctr < THRESHOLDS.ctrCritical ? 'critical' : 'warning',
      facts: `CTR ${n.ctr}% при ${Math.round(c.views)} показах`,
      meaning: 'Товар видят, но предложение проигрывает конкурентам в выдаче.',
      action: 'Проверить главное фото, цену, скидку, рейтинг, отзывы и релевантность показов.',
    });
  }

  // 3. CTR резко снизился (WB сц.3)
  const ctrChange = changePct(n.ctr, p.ctr);
  if (ctrChange !== null && ctrChange <= -THRESHOLDS.ctrDropPct) {
    out.push({
      ...base, scenario: 'CTR снизился', severity: 'warning',
      facts: `CTR ${p.ctr}% → ${n.ctr}% (${ctrChange}%)`,
      meaning: 'Могли измениться позиции, усилиться конкуренция или ухудшиться привлекательность карточки.',
      action: 'Сравнить цену, скидку, позиции и ставки с прошлым периодом. Посмотреть конкурентов.',
    });
  }

  // 4. CPC вырос без роста заказов (WB сц.4 / Ozon сц.11)
  const cpcChange = changePct(n.cpc, p.cpc);
  const ordersChange = changePct(c.orders, it.previous.orders);
  if (cpcChange !== null && cpcChange >= THRESHOLDS.cpcGrowthPct && (ordersChange === null || ordersChange <= 0)) {
    out.push({
      ...base, scenario: 'CPC вырос, результат нет', severity: 'warning',
      facts: `CPC ${p.cpc} ₽ → ${n.cpc} ₽ (+${cpcChange}%), заказы ${it.previous.orders} → ${c.orders}`,
      meaning: 'Дополнительные расходы не дают сопоставимого прироста результата.',
      action: 'Сравнить периоды до и после роста ставки. Без подтверждённого прироста прибыли ставку не повышать, рассмотреть снижение.',
    });
  }

  // 5. CPM резко вырос (WB сц.5)
  const cpmChange = changePct(n.cpm, p.cpm);
  if (cpmChange !== null && cpmChange >= THRESHOLDS.cpmGrowthPct) {
    out.push({
      ...base, scenario: 'CPM вырос', severity: 'info',
      facts: `CPM ${p.cpm} ₽ → ${n.cpm} ₽ (+${cpmChange}%)`,
      meaning: 'Реклама стала дороже без гарантии роста продаж.',
      action: 'Проверить конкурентность категории и оправданность текущей ставки.',
    });
  }

  // 6. Клики есть, корзин почти нет (WB сц.6 / Ozon сц.3)
  if (n.cartRate !== null && c.carts >= 0 && c.clicks >= THRESHOLDS.minClicks && n.cartRate < 5) {
    out.push({
      ...base, scenario: 'Мало добавлений в корзину', severity: 'warning',
      facts: `конверсия в корзину ${n.cartRate}% при ${Math.round(c.clicks)} кликах`,
      meaning: 'Реклама привлекает, но карточка не убеждает купить.',
      action: 'Проверить фото, видео, характеристики, описание, цену, отзывы и соответствие ожиданиям после перехода.',
    });
  }

  // 7. Корзины есть, заказов мало (WB сц.7 / Ozon сц.4)
  if (n.cartToOrder !== null && c.carts >= THRESHOLDS.minCarts && n.cartToOrder < THRESHOLDS.cartToOrderLow) {
    out.push({
      ...base, scenario: 'Корзины не превращаются в заказы', severity: 'warning',
      facts: `из корзины в заказ ${n.cartToOrder}% при ${Math.round(c.carts)} корзинах`,
      meaning: 'Покупатель откладывает товар, но не завершает покупку.',
      action: 'Проверить итоговую цену, сроки доставки, наличие нужных вариантов и отзывы.',
    });
  }

  // 8. Низкая конверсия в заказ (WB — «менее 3%»)
  if (n.orderRate !== null && c.orders >= THRESHOLDS.minOrders && n.orderRate < THRESHOLDS.orderRateLow) {
    out.push({
      ...base, scenario: 'Низкая конверсия в заказ', severity: 'warning',
      facts: `конверсия в заказ ${n.orderRate}%`,
      meaning: 'Трафик приходит, но плохо превращается в покупки.',
      action: 'Проверить релевантность ключей и запросов, цену и карточку.',
    });
  }

  // 9. ДРР выше нормы (WB сц.9 / Ozon сц.6) — главная метрика клиента.
  const norm = drrNorm(it.category, norms);
  if (n.drr !== null && c.orders >= THRESHOLDS.minOrders && n.drr > norm) {
    out.push({
      ...base, scenario: 'ДРР выше нормы',
      severity: n.drr > norm * 2 ? 'critical' : 'warning',
      facts: `ДРР ${n.drr}% при норме ${norm}% для категории «${it.category ?? 'без категории'}»`,
      meaning: 'Реклама забирает слишком большую долю выручки.',
      action: 'Проверить CPC, конверсию в заказ, цену и маржу. Рост продаж не равен росту прибыли.',
    });
  }

  // 10. Точка роста: ДРР ниже нормы и заказы идут (WB сц.9 наоборот / Ozon сц.9)
  if (n.drr !== null && c.orders >= THRESHOLDS.minOrders && n.drr < norm * 0.6) {
    out.push({
      ...base, scenario: 'Есть запас для роста', severity: 'growth',
      facts: `ДРР ${n.drr}% при норме ${norm}%, заказов ${Math.round(c.orders)}`,
      meaning: 'Кампания укладывается в норму с запасом и может иметь потенциал.',
      action: 'Осторожно увеличивать бюджет или ставку небольшими шагами, после каждого изменения контролировать ДРР и стоимость заказа.',
    });
  }

  return out;
}

/** Порядок вывода: сначала то, что горит. */
export const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 0, warning: 1, growth: 2, info: 3,
};
