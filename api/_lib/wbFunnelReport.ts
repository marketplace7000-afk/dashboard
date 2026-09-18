// Прогрев воронки продаж WB.
//
// Историческая справка, без которой код выглядит странно. Задумывался
// АСИНХРОННЫЙ CSV-отчёт (POST /api/v2/nm-report/downloads → poll → ZIP): один
// отчёт за 60 дней покрывал все окна дашборда и давал разбивку по дням. Но
// движок отчётов у WB стабильно отвечает FAILED — проверено 23.07 на диапазонах
// 62/31/8 дней, create=200, генерация падает. Дело не в нашем запросе.
//
// Поэтому греем СИНХРОННЫМ /api/analytics/v3/sales-funnel/products: тот же
// ответ по сути (statistics.selectedPeriod.ordersSumRub — «Заказы·Сумма» в ЛК),
// те же ключи кэша, что читает фронт. Медленнее (лимит WB ~1 запрос в 2 минуты),
// зато сходится с кабинетом клиента.
//
// Что при этом потеряно: разбивки по дням у синхронной воронки нет, поэтому
// дневной ряд (WB_DAILY_KEY) не наполняется и график «Заказано по дням» пуст.
// Эндпоинт /api/history/wb-daily говорит об этом прямо, а не отдаёт молча ноль.
//
// Код разбора CSV, создания и скачивания отчёта удалён 26.08: он больше года
// не вызывался и только притворялся рабочим путём.

import { fetchWithRetry } from './fetchRetry';
// unzipSingle переехал в ./zip (там же unzipAll); ре-экспорт для прежних импортов.
export { unzipSingle } from './zip';
import { cacheSet, makeUpstreamCacheKey } from './cache';
import { windowRange, prevWindowRange } from './period';

const HOST = 'https://seller-analytics-api.wildberries.ru';

// Дневной ряд выручки WB (для графика «Заказано по дням» на фронте, как у Ozon).
// Фронт читает его через /api/history/wb-daily.
export const WB_DAILY_KEY = 'wb-daily-series:v1';

function wbHeaders(): Record<string, string> {
  return {
    Authorization: (process.env.WB_TOKEN_ANALYTICS || process.env.WB_TOKEN || '').trim(),
    'Content-Type': 'application/json',
  };
}

// ── Мини-распаковка ZIP (один файл, без внешних зависимостей) ────────────────
// WB отдаёт ZIP с единственным CSV. Идём через End Of Central Directory →
// central directory entry → local file header → deflate-поток.
/** Распаковка ZIP с одним файлом внутри. Используется и отчётами Ozon (ozonSkuAds). */

/**
 * Главная точка: один отчёт (~62 дня) → три кэш-записи в формате ответа
 * sales-funnel v3 под ключами funnel(1) / funnel(7) / funnel(30).
 * @param iso        — тот же helper дат, что в route.ts (iso(N) = N дней назад)
 * @param funnelBody — тот же билдер тела, что в route.ts (для идентичных ключей)
 * @param ttlMs      — TTL кэш-записей
 */
// WB v3 sales-funnel сменил форму ответа (23.07): data.products[].statistic.selected
// с полями orderSum/orderCount/openCount/... Приводим к СТАРОЙ форме
// data.cards[].statistics.selectedPeriod.ordersSumRub, которую читает фронт
// (marketplaces.ts WbNmReportCard), — фронт не меняем.
function mapV3Period(x: any) {
  return {
    ordersCount: x?.orderCount ?? 0,
    ordersSumRub: x?.orderSum ?? 0,
    buyoutsCount: x?.buyoutCount ?? 0,
    buyoutsSumRub: x?.buyoutSum ?? 0,
    cancelCount: x?.cancelCount ?? 0,
    cancelSumRub: x?.cancelSum ?? 0,
    avgPriceRub: x?.avgPrice ?? 0,
    openCardCount: x?.openCount ?? 0,
    addToCartCount: x?.cartCount ?? 0,
  };
}
function mapV3Product(p: any) {
  const prod = p?.product ?? {};
  const st = p?.statistic ?? {};
  return {
    nmID: prod.nmId ?? 0,
    vendorCode: prod.vendorCode ?? String(prod.nmId ?? ''),
    brandName: prod.brandName,
    object: prod.subjectName ? { id: prod.subjectId ?? 0, name: prod.subjectName } : undefined,
    statistics: {
      selectedPeriod: mapV3Period(st.selected),
      previousPeriod: mapV3Period(st.previous),
    },
  };
}

export async function warmWbFunnelViaReport(
  funnelBody: (days: number) => any,
  ttlMs: number,
): Promise<{ ok: boolean; cards: number; detail?: string }> {
  // Асинхронный отчёт WB (nm-report/downloads) стабильно возвращает FAILED (23.07 —
  // проверено на 62/31/8 днях, дело НЕ в диапазоне: сломан сам движок отчётов WB,
  // create=200, но генерация FAILED). Греем воронку СИНХРОННЫМ эндпоинтом
  // sales-funnel/products: тот же ответ (data.cards[].statistics.selectedPeriod
  // .ordersSumRub = «Заказы·Сумма» в ЛК) и те же ключи funnelBody(1/7/30), что читает
  // фронт. Медленнее (лимит WB ~1 req/2мин), но надёжно и совпадает с кабинетом.
  // Границы окна берём из общей точки (_lib/period): раньше на каждое окно
  // держалась пара чисел — keyBack для ключа кэша и startBack для запроса, —
  // потому что тело считалось по одному правилу, а ключ по другому. Числа
  // отличались на единицу, и любая правка одного из них разводила ключ сборщика
  // с ключом браузера. Теперь и то и другое выражено через дни окна.
  // NB: дневной график «по дням» так не строится — у синхронного эндпоинта нет
  // разбивки по дням (WB_DAILY_KEY не наполняется, график пока пуст).
  // 14 добавлено потому, что таблица «Реклама по артикулам» предлагает окна
  // 7/14/30, а грелись только 7 и 30: на 14 днях знаменатель ДРР брать было
  // неоткуда, и в диагностике честно писалось «воронка продаж не прогрета».
  const windows = [7, 1, 30, 14];   // неделя первой — ключевое число клиента (2 158 384)
  let total = 0;
  let okAny = false;
  for (const days of windows) {
    const cur = windowRange(days);
    const prev = prevWindowRange(days);
    // WB v3 требует именно selectedPeriod (+ previousPeriod для %), НЕ period —
    // проверено по 400: "invalid: selectedPeriod (field required)" (23.07).
    // orderBy убрали: v3 не знает field=ordersSumRub, а сортировка нам не нужна
    // (суммируем все карточки). Если WB потребует orderBy — вернём с валидным полем.
    const queryBody = JSON.stringify({
      selectedPeriod: { start: cur.from, end: cur.to },
      previousPeriod: { start: prev.from, end: prev.to },
      timezone: 'Europe/Moscow', limit: 200, offset: 0,
      brandNames: [], subjectIDs: [], tagIDs: [], nmIDs: [],
    });
    try {
      const r = await fetchWithRetry(`${HOST}/api/analytics/v3/sales-funnel/products`, {
        method: 'POST', headers: wbHeaders(), body: queryBody,
      }, { maxRetries: 3, timeoutMs: 45_000 });
      if (!r.ok) {
        const errText = await r.text().catch(() => '');
        console.warn(`[wb-funnel] sync окно=${days}д → ${r.status} BODY_ERR: ${errText.slice(0, 400)}`);
        continue;
      }
      const text = await r.text();
      let mapped: ReturnType<typeof mapV3Product>[] = [];
      try {
        const products: any[] = JSON.parse(text)?.data?.products ?? [];
        mapped = products.map(mapV3Product);
      } catch (e) { console.warn(`[wb-funnel] parse окно=${days}д: ${(e as Error)?.message}`); }
      const key = makeUpstreamCacheKey('wb:analytics', 'POST', 'api/analytics/v3/sales-funnel/products', '', JSON.stringify(funnelBody(days)));
      const cacheText = JSON.stringify({ data: { cards: mapped, isNextPage: false } });
      await cacheSet(key, { status: 200, ct: 'application/json', text: cacheText }, ttlMs);
      const sum = mapped.reduce((s, c) => s + (c.statistics.selectedPeriod.ordersSumRub || 0), 0);
      total += mapped.length; okAny = true;
      console.log(`[wb-funnel] sync окно=${days}д ok: ${mapped.length} cards, ordersSum=${Math.round(sum)}`);
    } catch (e) {
      console.warn(`[wb-funnel] sync окно=${days}д failed: ${(e as Error)?.message}`);
    }
  }
  return { ok: okAny, cards: total, detail: 'sync-funnel' };
}
