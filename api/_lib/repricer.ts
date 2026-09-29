/**
 * Репрайсер, этап 2: пороги и режим «предложить».
 *
 * Этап 1 (мониторинг конкурентов) уже собирает цены и считает наше положение на
 * рынке — competitorWatch.ts и competitorPrices.ts. Здесь мы делаем следующий
 * шаг: считаем, какую цену имело бы смысл поставить, и объясняем почему.
 *
 * ГЛАВНОЕ ОГРАНИЧЕНИЕ, СНЯТЬ КОТОРОЕ МОЖЕТ ТОЛЬКО КЛИЕНТ.
 * Цены НИКОГДА не отправляются в WB. Модуль умеет ровно один режим — `suggest`,
 * то есть «предложить». Автоматической простановки нет и не появится, пока
 * клиент не согласует пороги (минимальная маржа, шаг, частота, стоп-лист) и не
 * скажет отдельно, что готов отдать цены агенту. Значения по умолчанию ниже
 * взяты из калькулятора клиента и здравого смысла, но НЕ СОГЛАСОВАНЫ: пока
 * `settings.confirmedByClient` не станет true, интерфейс обязан говорить, что
 * пороги предварительные.
 *
 * Пол цены считается НЕ своей формулой, а тем же калькулятором, по которому
 * клиент считает маржу вручную (src/utils/wbProfit.ts). Отдельная копия формулы
 * тут была бы худшим из возможных дублей: разъехавшись, она молча начала бы
 * рекомендовать убыточные цены. Поэтому импорт через границу папок — осознанный,
 * и он односторонний: сервер читает расчёт фронта, обратной зависимости нет.
 */
import { join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { calcWbProfit, WB_DEFAULTS, type WbCalcInput } from '../../src/utils/wbProfit';
import { cacheGet, makeUpstreamCacheKey } from './cache';
import { getCost, normSku } from './costs';
import { getWbCardEcon } from './wbCardEcon';
import { getWbBoxTariffs } from './wbBoxTariffs';
import { getMarketPosition, type MarketPosition } from './competitorPrices';
import { getWatchList } from './competitorWatch';
import { noteSwallowed } from './log';

// ─── Настройки ──────────────────────────────────────────────────────────────

/** Как целиться относительно конкурентов. */
export type Strategy =
  | 'match-min'      // встать вровень с самым дешёвым конкурентом
  | 'undercut-min'   // подрезать самого дешёвого на шаг
  | 'match-avg';     // держаться среднего по рынку

export type RepricerSettings = {
  /** Единственный поддерживаемый режим. Поле есть, чтобы намерение было явным. */
  mode: 'suggest';
  strategy: Strategy;
  /** Ниже этой маржи не опускаемся ни при каких конкурентах, %. */
  minMarginPct: number;
  /** На сколько подрезать конкурента при strategy='undercut-min', ₽. */
  undercutRub: number;
  /** Максимальное изменение цены за один раз, % от текущей. Защита от скачков. */
  maxStepPct: number;
  /** Не предлагать новую цену чаще, чем раз в столько часов. */
  minIntervalHours: number;
  /** Артикулы, которые агент не трогает вообще. */
  stopList: string[];
  /**
   * Согласованы ли пороги с клиентом. Пока false — цифры предварительные, и
   * интерфейс обязан это показывать. Ставится вручную после разговора.
   */
  confirmedByClient: boolean;
  updatedAt: number;
};

/**
 * Значения по умолчанию. Осознанно осторожные: лучше не предложить снижение,
 * чем предложить убыточное. Маржа 15% — не цифра клиента, а нижняя граница, при
 * которой сделка вообще имеет смысл; шаг 5% не даёт агенту двигать цену рывками.
 */
export const DEFAULT_SETTINGS: RepricerSettings = {
  mode: 'suggest',
  strategy: 'undercut-min',
  minMarginPct: 15,
  undercutRub: 10,
  maxStepPct: 5,
  minIntervalHours: 24,
  stopList: [],
  confirmedByClient: false,
  updatedAt: 0,
};

const FILE = process.env.REPRICER_FILE || join(process.cwd(), 'av-data', 'repricer.json');
let cache: RepricerSettings | null = null;

export function getSettings(): RepricerSettings {
  if (cache) return cache;
  try {
    const raw = JSON.parse(readFileSync(FILE, 'utf8')) as Partial<RepricerSettings>;
    // Разворачиваем поверх умолчаний: файл может быть от прошлой версии и не
    // знать новых полей, и это не повод терять остальные настройки.
    cache = { ...DEFAULT_SETTINGS, ...raw, mode: 'suggest' };
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      noteSwallowed('repricer', 'настройки не прочитаны, работаем на умолчаниях', e);
    }
    cache = { ...DEFAULT_SETTINGS };
  }
  return cache!;
}

export function setSettings(patch: Partial<RepricerSettings>): RepricerSettings {
  const next: RepricerSettings = {
    ...getSettings(),
    ...patch,
    mode: 'suggest',                       // режим не меняется через API
    stopList: (patch.stopList ?? getSettings().stopList).map(normSku).filter(Boolean),
    updatedAt: Date.now(),
  };
  cache = next;
  try {
    mkdirSync(join(FILE, '..'), { recursive: true });
    const tmp = `${FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
    renameSync(tmp, FILE);      // атомарно: убитый на записи процесс не побьёт файл
  } catch (e) {
    noteSwallowed('repricer', 'настройки не сохранены', e);
  }
  return next;
}

// ─── Пол цены ───────────────────────────────────────────────────────────────

/**
 * Минимальная цена, при которой маржа не ниже `targetMarginPct`.
 *
 * Считаем подбором по тому же калькулятору, которым считается маржа на экране, а
 * не выведенной вручную формулой. Формулу можно вывести аналитически, но тогда
 * она станет второй копией: поправят калькулятор — репрайсер молча начнёт
 * рекомендовать убыточные цены. Подбор стоит сорок вызовов чистой арифметики.
 *
 * Маржа монотонно растёт по цене (постоянные издержки размазываются на больший
 * чек), поэтому двоичный поиск корректен.
 */
export function priceForMargin(input: WbCalcInput, targetMarginPct: number): number | null {
  const marginAt = (retail: number) => calcWbProfit({ ...input, retail })?.margin ?? -Infinity;

  let lo = Math.max(1, input.cost);
  let hi = Math.max(lo * 2, input.cost * 50, 1000);
  // Если даже на потолке маржа не дотягивает, цели не существует: значит при
  // такой себестоимости и таких комиссиях товар не вытянуть ценой.
  if (marginAt(hi) < targetMarginPct) return null;

  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (marginAt(mid) < targetMarginPct) lo = mid; else hi = mid;
  }
  return Math.ceil(hi);
}

// ─── Предложения ────────────────────────────────────────────────────────────

export type Suggestion = {
  sku: string;
  nmId?: number;
  currentPrice: number | null;
  /** Что предлагаем поставить. null — предложения нет, причина в `reason`. */
  suggestedPrice: number | null;
  /** Ниже этой цены маржа падает под порог. */
  floorPrice: number | null;
  marginNow: number | null;
  marginSuggested: number | null;
  market: Pick<MarketPosition, 'min' | 'avg' | 'max' | 'rank' | 'total' | 'vsMinPct'>;
  /** Человеческое объяснение — его читает менеджер, а не разработчик. */
  reason: string;
  /** Что помешало посчитать: нет себестоимости, нет конкурентов и т.п. */
  blocker?: string;
};

export type RepricerReport = {
  settings: RepricerSettings;
  suggestions: Suggestion[];
  /** Сколько товаров пропущено и почему — чтобы пустой список был объясним. */
  skipped: { sku: string; why: string }[];
  generatedAt: number;
};

/** Цены из прогретого кэша WB. Ключ строит сборщик, тут только читаем. */
async function readWbPrices(): Promise<Map<string, { nmId: number; retail: number }>> {
  const key = makeUpstreamCacheKey('wb:discounts', 'GET', 'api/v2/list/goods/filter', '?limit=1000', undefined);
  const out = new Map<string, { nmId: number; retail: number }>();
  const cached = await cacheGet<{ text: string }>(key);
  if (!cached?.data?.text) return out;
  try {
    const rows: any[] = JSON.parse(cached.data.text)?.data?.listGoods ?? [];
    for (const g of rows) {
      const sku = normSku(g?.vendorCode);
      const nmId = Number(g?.nmID ?? g?.nmId) || 0;
      // Серая цена — та, что после скидки продавца: именно она база расчёта в
      // калькуляторе клиента, а не «приманочный» ценник до скидки.
      const retail = Number(g?.sizes?.[0]?.discountedPrice) || 0;
      if (sku && retail > 0) out.set(sku, { nmId, retail });
    }
  } catch (e) {
    noteSwallowed('repricer', 'кэш цен WB не разобран', e);
  }
  return out;
}

/**
 * Посчитать предложения по всем товарам, за которыми закреплены конкуренты.
 * Ничего не меняет и никуда не отправляет — только считает и объясняет.
 */
export async function buildSuggestions(): Promise<RepricerReport> {
  const settings = getSettings();
  const [prices, econ, tariffs] = await Promise.all([
    readWbPrices(),
    getWbCardEcon().catch(() => null),
    getWbBoxTariffs().catch(() => null),
  ]);

  const suggestions: Suggestion[] = [];
  const skipped: { sku: string; why: string }[] = [];
  const stop = new Set(settings.stopList);

  for (const sku of Object.keys(getWatchList().items)) {
    if (stop.has(normSku(sku))) { skipped.push({ sku, why: 'в стоп-листе' }); continue; }

    const price = prices.get(normSku(sku));
    if (!price) { skipped.push({ sku, why: 'нет цены в прогретом кэше WB' }); continue; }

    const market = getMarketPosition(sku, price.retail);
    if (!market.total) { skipped.push({ sku, why: market.reason ?? 'нет цен конкурентов' }); continue; }

    const cost = getCost(sku);
    const row = econ?.items?.[String(price.nmId)];
    // Логистика по объёму карточки: первый литр по базовой ставке, остальные по
    // литровой. Коэффициент склада — проценты, поэтому делим на 100.
    const volumeL = row?.volumeL ?? 0;
    const logistic = tariffs
      ? Math.round((tariffs.deliveryBase + Math.max(0, volumeL - 1) * tariffs.deliveryLiter)
          * (tariffs.deliveryCoef || 100) / 100)
      : WB_DEFAULTS.logistic;
    const storage = tariffs && volumeL > 0
      ? Math.round((tariffs.storageBase + Math.max(0, volumeL - 1) * tariffs.storageLiter) * 30)
      : WB_DEFAULTS.storage;

    const base: Suggestion = {
      sku,
      nmId: price.nmId || undefined,
      currentPrice: price.retail,
      suggestedPrice: null,
      floorPrice: null,
      marginNow: null,
      marginSuggested: null,
      market: { min: market.min, avg: market.avg, max: market.max, rank: market.rank, total: market.total, vsMinPct: market.vsMinPct },
      reason: '',
    };

    if (cost == null || !(cost > 0)) {
      // Без себестоимости пол цены не существует. Предлагать снижение вслепую
      // нельзя: именно так агент и уводит товар в минус.
      suggestions.push({ ...base, blocker: 'нет себестоимости', reason: 'Себестоимость не заведена — считать нижнюю границу не от чего. Заполните её в справочнике, и предложение появится.' });
      continue;
    }

    const input: WbCalcInput = {
      ...WB_DEFAULTS,
      retail: price.retail,
      cost,
      commission: row?.commission || WB_DEFAULTS.commission,
      logistic,
      storage,
    };

    const floorPrice = priceForMargin(input, settings.minMarginPct);
    const marginNow = calcWbProfit(input)?.margin ?? null;
    base.floorPrice = floorPrice;
    base.marginNow = marginNow == null ? null : Math.round(marginNow * 10) / 10;

    if (floorPrice == null) {
      suggestions.push({ ...base, blocker: 'порог недостижим', reason: `Маржа ${settings.minMarginPct}% недостижима ни при какой цене: себестоимость и комиссии съедают весь чек. Это вопрос закупки, а не цены.` });
      continue;
    }

    // Куда целимся по рынку.
    const target = settings.strategy === 'match-avg' ? market.avg
      : settings.strategy === 'match-min' ? market.min
      : (market.min != null ? market.min - settings.undercutRub : null);
    if (target == null || !(target > 0)) {
      suggestions.push({ ...base, blocker: 'нет ориентира', reason: 'Цены конкурентов есть, но ориентир по выбранной стратегии не посчитался.' });
      continue;
    }

    // Шаг: не двигаем цену рывком даже если рынок далеко.
    const maxDelta = Math.round(price.retail * settings.maxStepPct / 100);
    const stepped = target > price.retail
      ? Math.min(target, price.retail + maxDelta)
      : Math.max(target, price.retail - maxDelta);
    const suggested = Math.max(Math.round(stepped), floorPrice);
    const marginSuggested = calcWbProfit({ ...input, retail: suggested })?.margin ?? null;

    const parts: string[] = [];
    if (suggested === price.retail) {
      parts.push('Цена уже там, где нужно: менять нечего.');
    } else if (suggested === floorPrice && target < floorPrice) {
      parts.push(`Конкуренты стоят ${market.min} ₽, но опускаться туда нельзя: ниже ${floorPrice} ₽ маржа падает под ${settings.minMarginPct}%. Предлагаем остановиться на границе.`);
    } else if (suggested < price.retail) {
      parts.push(`Снизить с ${price.retail} до ${suggested} ₽: самый дешёвый конкурент — ${market.min} ₽.`);
    } else {
      parts.push(`Поднять с ${price.retail} до ${suggested} ₽: рынок выше, мы недозарабатываем.`);
    }
    if (Math.abs(target - stepped) >= 1) {
      parts.push(`Шаг ограничен ${settings.maxStepPct}% за раз, полный ход до ${Math.round(target)} ₽ займёт несколько проходов.`);
    }

    suggestions.push({
      ...base,
      suggestedPrice: suggested,
      marginSuggested: marginSuggested == null ? null : Math.round(marginSuggested * 10) / 10,
      reason: parts.join(' '),
    });
  }

  // Сначала то, где расхождение с рынком больше — там и денег больше.
  suggestions.sort((a, b) => {
    const d = (s: Suggestion) => (s.suggestedPrice != null && s.currentPrice ? Math.abs(s.suggestedPrice - s.currentPrice) : -1);
    return d(b) - d(a);
  });

  return { settings, suggestions, skipped, generatedAt: Date.now() };
}
