/**
 * ИИ-аналитик и юнит-экономика в Telegram.
 *
 * Клиент 05.08: «AI-аналитик словами — у нас есть ИИ-чат в дашборде, но не в
 * боте. Можем в бота продублировать» и «Юнитка-бот — у нас есть модуль Цены со
 * сценариями, но не в боте».
 *
 * Данные берём из того же серверного снапшота, что и остальной бот: ходить в
 * WB/Ozon из чата нельзя — сожжём лимиты площадок.
 */
import { callAnthropic } from './anthropic';
import { buildSnapshot, formatContextForPrompt } from './aiContext';

const SYSTEM = [
  'Ты — аналитик маркетплейсов для селлера (Wildberries и Ozon), отвечаешь в Telegram.',
  'Отвечай коротко и по делу: 3-6 предложений или компактный список, без вступлений.',
  'Опирайся ТОЛЬКО на цифры из контекста. Если данных для ответа нет — так и скажи,',
  'не придумывай. Числа приводи с единицами (₽, %, шт).',
  'Форматирование — HTML для Telegram: <b>жирный</b>, <i>курсив</i>. Markdown не используй.',
].join(' ');

/** Свободный вопрос к ИИ-аналитику (любое сообщение боту, не являющееся командой). */
export async function botAsk(question: string): Promise<string> {
  const snap = await buildSnapshot().catch(() => null);
  const context = snap ? formatContextForPrompt(snap) : 'Данные ещё не прогреты.';
  const { text } = await callAnthropic({
    system: SYSTEM,
    messages: [{
      role: 'user',
      content: `# Данные бизнеса\n${context}\n\n# Вопрос\n${question}`,
    }],
    max_tokens: 700,
    agent: 'bot-chat',
  });
  return text.trim() || 'Не удалось сформулировать ответ.';
}

// ─── Юнит-экономика по артикулу ──────────────────────────────────────────────

const rub = (n: number) => Math.round(n).toLocaleString('ru-RU') + ' ₽';

/**
 * Юнитка по одному артикулу Ozon.
 *
 * Складываем из того, что уже считает платформа:
 *  • цена покупателя и цена продавца — из отправлений (ozonBuyerPrices);
 *  • комиссия, логистика, выплата на единицу — из фактических транзакций
 *    (ozonFactProfit), а не из тарифной таблицы: это то, что реально удержали;
 *  • реклама на единицу — расход по SKU ÷ заказы (ozonSkuAds);
 *  • себестоимость — из закупочной таблицы, если она там есть.
 */
export async function unitEconomics(query: string): Promise<string> {
  const needle = query.trim().toUpperCase();
  if (!needle) {
    return 'Укажите артикул: <code>/юнитка POLFAR</code>';
  }

  const [prices, fact, ads] = await Promise.all([
    import('./ozonBuyerPrices').then(m => m.getOzonBuyerPrices()).catch(() => null),
    import('./ozonFactProfit').then(m => m.getOzonFactProfit()).catch(() => null),
    // Только из кэша: сборка отчёта Ozon занимает минуты, в чате столько не ждут.
    import('./ozonSkuAds').then(m => m.getOzonSkuAdsCached(29, 0)).catch(() => null),
  ]);

  // Ищем артикул по точному совпадению, иначе по вхождению — клиент печатает
  // в чате и полный артикул набирать не станет.
  const pool = new Set<string>([
    ...Object.keys(prices?.items ?? {}),
    ...Object.keys(fact?.items ?? {}),
  ]);
  const offer = pool.has(needle)
    ? needle
    : [...pool].find(o => o.includes(needle));
  if (!offer) {
    return `Артикул <b>${needle}</b> не найден среди ${pool.size} товаров с данными.\n` +
      '<i>Возможно, по нему не было продаж — юнитку считать не из чего.</i>';
  }

  const p = prices?.items?.[offer];
  const f = fact?.items?.[offer];
  const a = ads?.items?.[offer];

  const buyer = p?.buyer ?? 0;
  const seller = p?.price ?? f?.revenue ?? 0;
  const commission = f?.commission ?? 0;
  const logistic = f?.logistic ?? 0;
  const adPerUnit = a && a.orders > 0 ? a.spend / a.orders : 0;

  const L: string[] = [`🧮 <b>Юнит-экономика · ${offer}</b>`];
  if (!f && !p) return `По <b>${offer}</b> нет ни цен, ни транзакций — считать нечего.`;

  if (p) {
    L.push(`Цена продавца: <b>${rub(seller)}</b>`);
    L.push(`Цена покупателя: <b>${rub(buyer)}</b> <i>(СПП ${p.spp}%${p.date ? `, ${p.date}` : ''})</i>`);
  }
  if (f) {
    L.push('');
    L.push(`Комиссия МП: −${rub(commission)}`);
    L.push(`Логистика и услуги: −${rub(logistic)}`);
    if (adPerUnit > 0) L.push(`Реклама на единицу: −${rub(adPerUnit)}`);
    L.push(`Выплата от Ozon: <b>${rub(f.payout)}</b> <i>(по ${f.units} продажам за 30 дн.)</i>`);
    const afterAds = f.payout - adPerUnit;
    L.push('');
    L.push(`<b>На руки до себестоимости: ${rub(afterAds)}</b>`);
    if (seller > 0) {
      L.push(`<i>Это ${Math.round((afterAds / seller) * 100)}% от цены продавца.</i>`);
    }
    L.push('<i>Себестоимость не в API — подставьте свою, чтобы получить прибыль и ROI.</i>');
  } else {
    L.push('');
    L.push('<i>Транзакций по товару за 30 дней нет — комиссию и логистику показать не могу.</i>');
  }
  if (a) {
    L.push('');
    L.push(`Реклама за 30 дн.: расход ${rub(a.spend)} · заказов ${a.orders}` +
      (a.drr != null ? ` · ДРР ${a.drr}%` : ''));
  }
  return L.join('\n');
}
