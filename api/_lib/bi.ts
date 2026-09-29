/**
 * BI-сводка: ОПиУ, разложение рубля выручки, ДДС по неделям, воронка.
 *
 * Клиент 05.08 попросил перетянуть визуал из чужого BI-дашборда («из BI дашборда
 * можем их визуал перетянуть к нам»). Считаем всё из ОДНОГО прохода по
 * транзакциям Ozon — это те же операции, что площадка кладёт в финотчёт, поэтому
 * цифры сходятся с кабинетом, а не «примерно похожи».
 *
 * Честные ограничения, они же подписаны в интерфейсе:
 *  • Себестоимости в API нет — валовую прибыль считаем без неё и говорим об этом.
 *  • Воронка есть только по рекламному трафику (Performance API). Общих показов
 *    карточек Ozon в API продавца нет.
 *  • WB здесь пока не участвует: его финотчёт недельный и приходит с задержкой.
 */
import { fetchWithRetry } from './fetchRetry';
import { cacheGet, cacheSet, isFresh } from './cache';
import { noteSwallowed } from './log';

const RESULT_KEY = 'bi-summary';
const TTL_MS = 60 * 60_000;

export type PnlLine = { label: string; amount: number; hint?: string };

export type BiSummary = {
  days: number;
  /** Отчёт о прибылях и убытках, сверху вниз. */
  pnl: PnlLine[];
  /** Разложение выручки: на что уходит каждый рубль. */
  breakdown: { label: string; amount: number; share: number }[];
  /** Движение денег по неделям: приход / расход. */
  cashflow: { week: string; income: number; outcome: number }[];
  /** Воронка рекламного трафика. */
  funnel: { stage: string; value: number; ofPrev: number | null }[];
  funnelAvailable: boolean;
  revenue: number;
  netProfit: number;
  fetchedAt: number;
  diagnostics: string;
};

const R = (n: number) => Math.round(n);

/** Начало ISO-недели (понедельник) в формате YYYY-MM-DD — ключ группировки ДДС. */
function weekKey(iso: string): string {
  const d = new Date(iso);
  const day = (d.getUTCDay() + 6) % 7;                 // пн = 0
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
}

/** Куда отнести операцию в разложении рубля. */
function classify(type: string): 'commission' | 'logistics' | 'ads' | 'acquiring' | 'storage' | 'returns' | 'other' {
  if (type === 'MarketplaceRedistributionOfAcquiringOperation') return 'acquiring';
  if (type === 'OperationMarketplaceCostPerClick' || type === 'OperationPromotionWithCostPerOrder') return 'ads';
  if (type === 'OperationMarketplaceServiceStorage') return 'storage';
  if (type === 'OperationItemReturn' || type === 'ClientReturnAgentOperation') return 'returns';
  if (type.includes('Delivery') || type.includes('Supply') || type.includes('Package') || type.includes('Crossdocking')) return 'logistics';
  return 'other';
}

async function compute(days: number): Promise<BiSummary> {
  const from = new Date(Date.now() - days * 86_400_000).toISOString();
  const to = new Date().toISOString();

  let revenue = 0;          // начисления за проданный товар
  let commission = 0;       // комиссия площадки
  let payout = 0;           // сколько в итоге пришло/ушло по всем операциям
  const buckets: Record<string, number> = {
    logistics: 0, ads: 0, acquiring: 0, storage: 0, returns: 0, other: 0,
  };
  const weeks = new Map<string, { income: number; outcome: number }>();
  let ops = 0;

  let page = 1, pageCount = 1;
  do {
    const res = await fetchWithRetry('https://api-seller.ozon.ru/v3/finance/transaction/list', {
      method: 'POST',
      headers: {
        'Client-Id': process.env.OZON_CLIENT_ID ?? '',
        'Api-Key': process.env.OZON_API_KEY ?? '',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        filter: { date: { from, to }, operation_type: [], transaction_type: 'all' },
        page, page_size: 1000,
      }),
    }, { maxRetries: 2, timeoutMs: 60_000 });
    if (!res.ok) break;
    const j: any = await res.json().catch(() => null);
    const result = j?.result ?? {};
    pageCount = result.page_count ?? 1;

    for (const o of (result.operations ?? [])) {
      ops++;
      const amount = Number(o?.amount) || 0;
      const type = String(o?.operation_type ?? '');
      payout += amount;

      const wk = weekKey(String(o?.operation_date ?? o?.operation_date_time ?? to));
      const cell = weeks.get(wk) ?? { income: 0, outcome: 0 };
      if (amount >= 0) cell.income += amount; else cell.outcome += Math.abs(amount);
      weeks.set(wk, cell);

      if (type === 'OperationAgentDeliveredToCustomer') {
        revenue += Number(o?.accruals_for_sale) || 0;
        commission += Math.abs(Number(o?.sale_commission) || 0);
        // Услуги внутри операции продажи — это логистика и обработка.
        buckets.logistics += (o?.services ?? []).reduce((s: number, x: any) => s + Math.abs(Number(x?.price) || 0), 0);
        continue;
      }
      if (amount >= 0) continue;                        // прочие начисления не расход
      buckets[classify(type)] += Math.abs(amount);
    }
    page += 1;
  } while (page <= pageCount && page <= 25);

  const totalCosts = commission + buckets.logistics + buckets.ads + buckets.acquiring
    + buckets.storage + buckets.returns + buckets.other;
  const netProfit = revenue - totalCosts;

  const pnl: PnlLine[] = [
    { label: 'Выручка (доставлено покупателям)', amount: R(revenue) },
    { label: 'Возвраты, отмены, невыкуп', amount: -R(buckets.returns) },
    { label: 'Комиссия площадки', amount: -R(commission) },
    { label: 'Логистика и обработка', amount: -R(buckets.logistics) },
    { label: 'Реклама', amount: -R(buckets.ads) },
    { label: 'Эквайринг', amount: -R(buckets.acquiring) },
    { label: 'Хранение', amount: -R(buckets.storage) },
    { label: 'Прочие удержания', amount: -R(buckets.other), hint: 'штрафы, услуги, подписки' },
    { label: 'Прибыль до себестоимости', amount: R(netProfit), hint: 'себестоимости нет в API — вычтите свою' },
  ];

  const breakdown = [
    { label: 'Комиссия площадки', amount: R(commission) },
    { label: 'Логистика и обработка', amount: R(buckets.logistics) },
    { label: 'Возвраты и невыкуп', amount: R(buckets.returns) },
    { label: 'Реклама', amount: R(buckets.ads) },
    { label: 'Эквайринг', amount: R(buckets.acquiring) },
    { label: 'Хранение', amount: R(buckets.storage) },
    { label: 'Прочие удержания', amount: R(buckets.other) },
    { label: 'Остаётся до себестоимости', amount: R(netProfit) },
  ]
    .filter(x => x.amount !== 0)
    .map(x => ({ ...x, share: revenue > 0 ? Math.round((x.amount / revenue) * 1000) / 10 : 0 }));

  const cashflow = [...weeks.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([week, v]) => ({ week, income: R(v.income), outcome: R(v.outcome) }));

  // ── Воронка по рекламному трафику ──
  let funnel: BiSummary['funnel'] = [];
  let funnelAvailable = false;
  try {
    const { getOzonSkuAdsCached } = await import('./ozonSkuAds');
    const ads = await getOzonSkuAdsCached(days - 1, 0);
    if (ads && Object.keys(ads.items).length) {
      const sum = Object.values(ads.items).reduce((a, r: any) => ({
        views: a.views + (r.views ?? 0),
        clicks: a.clicks + (r.clicks ?? 0),
        carts: a.carts + (r.carts ?? 0),
        orders: a.orders + (r.orders ?? 0),
      }), { views: 0, clicks: 0, carts: 0, orders: 0 });
      const stages = [
        { stage: 'Показы', value: sum.views },
        { stage: 'Клики', value: sum.clicks },
        { stage: 'В корзину', value: sum.carts },
        { stage: 'Заказы', value: sum.orders },
      ];
      funnel = stages.map((s, i) => ({
        ...s,
        ofPrev: i === 0 || !stages[i - 1].value ? null : Math.round((s.value / stages[i - 1].value) * 1000) / 10,
      }));
      funnelAvailable = true;
    }
  } catch (e) {
    // Воронка необязательна: BI собирается и без неё. Но `funnelAvailable: false`
    // на экране должен иметь объяснение в журнале, иначе это выглядит как «данных нет».
    noteSwallowed('bi', 'воронка не собралась', e);
  }

  return {
    days, pnl, breakdown, cashflow, funnel, funnelAvailable,
    revenue: R(revenue), netProfit: R(netProfit),
    fetchedAt: Date.now(),
    diagnostics: `Ozon: операций ${ops}, недель ${cashflow.length}` +
      (funnelAvailable ? '' : ' · воронка: отчёт рекламы ещё собирается') +
      ` · итог по кассе ${R(payout).toLocaleString('ru-RU')} ₽`,
  };
}

/**
 * Кэш-первым: страница НИКОГДА не ждёт полный проход по транзакциям.
 * Если данных нет — запускаем сборку в фоне и честно отвечаем «собирается».
 * Так медленный или флапающий канал до Ozon не превращается в вечный спиннер
 * (жалоба 10.08: «уже двести лет обновляется, но ничего нет»).
 */
let biBuilding = false;

export async function getBiSummaryCached(days = 30): Promise<BiSummary | null> {
  const key = `${RESULT_KEY}:${days}`;
  const cached = await cacheGet<BiSummary>(key);
  if (cached?.data) return cached.data;           // даже протухший лучше пустоты
  if (!biBuilding) {
    biBuilding = true;
    void getBiSummary(days, true).catch(() => {}).finally(() => { biBuilding = false; });
  }
  return null;
}

export async function getBiSummary(days = 30, noCache = false): Promise<BiSummary> {
  const key = `${RESULT_KEY}:${days}`;
  const cached = await cacheGet<BiSummary>(key);
  if (!noCache && isFresh(cached)) return cached.data;
  try {
    const fresh = await compute(days);
    await cacheSet(key, fresh, TTL_MS);
    return fresh;
  } catch (e) {
    if (cached?.data) return cached.data;
    throw e;
  }
}
