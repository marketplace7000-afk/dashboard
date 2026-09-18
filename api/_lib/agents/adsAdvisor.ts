/**
 * Агенты 15 и 16 — «Реклама WB» и «Реклама Ozon».
 *
 * Реализуют документы специалистов по рекламе (Сони и Эльвиры): собирают воронку
 * по каждому товару за текущую неделю и предыдущую, прогоняют сценарии из
 * api/_lib/ads/rules.ts и сообщают, что требует внимания.
 *
 * Принципиально: решение принимают ПРАВИЛА, а не модель. Оба документа требуют
 * подтверждать рекомендацию цифрами и честно говорить, когда данных мало. Модель
 * такого не гарантирует, поэтому её здесь нет вовсе — только факты и пороги.
 *
 * Режим работы, как договаривались с клиентом: сначала агент КОНСУЛЬТИРУЕТ.
 * Ставки и бюджеты сам не меняет.
 */
import { getOzonSkuAdsCached } from '../ozonSkuAds';
import { getWbAdsByNm, wbAdsMissReason } from '../ads/wbSource';
import { AdFunnel, AdItem, buildItem, emptyFunnel } from '../ads/metrics';
import { Finding, SEVERITY_ORDER, evaluate } from '../ads/rules';
import { getDrrNorms } from '../ads/norms';
import { getCategoryDrr, skuToCategory } from '../ads/categoryDrr';
import { getTotalRevenue } from '../ads/totalRevenue';
import { Agent, AgentMessage, mskDay } from './types';

// Окно сравнения: неделя против предыдущей недели (вариант из документа).
const WINDOW_DAYS = Number(process.env.AGENT_ADS_WINDOW_DAYS) || 7;
// Сколько находок показываем в одном сообщении, чтобы не превратить его в простыню.
const MAX_FINDINGS = 12;

function fmtFinding(f: Finding): string {
  const mark = f.severity === 'critical' ? '🔴' : f.severity === 'warning' ? '🟠' : f.severity === 'growth' ? '🟢' : '⚪';
  return `${mark} <b>${f.sku}</b> · ${f.scenario}\n` +
         `   ${f.facts}\n` +
         `   ${f.meaning}\n` +
         `   <i>${f.action}</i>`;
}

function pack(platform: 'WB' | 'Ozon', findings: Finding[], keyPrefix: string): AgentMessage[] {
  if (!findings.length) return [];
  findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  const shown = findings.slice(0, MAX_FINDINGS);
  const tail = findings.length > MAX_FINDINGS
    ? `\n\n…и ещё ${findings.length - MAX_FINDINGS} — весь список в разделе «Реклама».`
    : '';
  const crit = findings.filter(f => f.severity === 'critical').length;
  const grow = findings.filter(f => f.severity === 'growth').length;
  const head = `📣 <b>Реклама ${platform}: ${findings.length} наблюдений</b>\n` +
               `<i>неделя против предыдущей` +
               (crit ? ` · критичных ${crit}` : '') +
               (grow ? ` · точек роста ${grow}` : '') + `</i>`;
  return [{
    key: `${keyPrefix}:${mskDay()}`,
    text: `${head}\n\n${shown.map(fmtFinding).join('\n\n')}${tail}`,
  }];
}

// ─── Ozon ────────────────────────────────────────────────────────────────────
async function runOzon(): Promise<AgentMessage[]> {
  const norms = await getDrrNorms();
  const cats = await skuToCategory().catch(() => new Map<string, string>());
  // Два окна: текущее и предыдущее такой же длины.
  // Только из кэша: сборка отчётов Ozon занимает минуты, и команда в боте всё
  // это время молча висела бы (замечено 03.08). Чего нет — прогреется в фоне и
  // подхватится следующим запуском.
  const [cur, prev] = await Promise.all([
    getOzonSkuAdsCached(WINDOW_DAYS - 1, 0).catch(() => null),
    getOzonSkuAdsCached(2 * WINDOW_DAYS - 1, WINDOW_DAYS).catch(() => null),
  ]);
  if (!cur || !Object.keys(cur.items).length) return [];

  const toFunnel = (r: any): AdFunnel => ({
    views: r?.views ?? 0, clicks: r?.clicks ?? 0, carts: r?.carts ?? 0,
    orders: r?.orders ?? 0, spend: r?.spend ?? 0, revenue: r?.revenue ?? 0,
  });

  const findings: Finding[] = [];
  for (const [sku, row] of Object.entries(cur.items)) {
    const item: AdItem = buildItem(
      'ozon', sku,
      toFunnel(row),
      toFunnel(prev?.items?.[sku]) ?? emptyFunnel(),
      { category: cats.get(sku.toUpperCase()) },   // категория → норма ДРР этой категории
    );
    findings.push(...evaluate(item, norms));
  }
  return pack('Ozon', findings, 'agent16:ads-ozon');
}

// ─── Wildberries ─────────────────────────────────────────────────────────────
async function runWb(): Promise<AgentMessage[]> {
  const norms = await getDrrNorms();
  const data = getWbAdsByNm(WINDOW_DAYS);
  if (!data) return [];

  const findings: Finding[] = [];
  for (const [nmId, current] of data.current) {
    // Товар зовём по названию из статистики, иначе по номеру карточки —
    // читать «nm123456» неудобно, но лучше, чем ничего.
    const label = data.names.get(nmId) ?? `nm${nmId}`;
    const item = buildItem('wb', label, current, data.previous.get(nmId) ?? emptyFunnel());
    findings.push(...evaluate(item, norms));
  }
  return pack('WB', findings, 'agent15:ads-wb');
}

/**
 * Что видит агент прямо сейчас. Нужно, чтобы отличать «всё в норме» от «данных
 * нет»: раньше оба случая давали одинаковое «замечаний нет» и понять, работает
 * ли анализ вообще, было невозможно.
 */
export async function diagnoseAds(): Promise<string> {
  const L: string[] = ['🔍 <b>Что видит анализ рекламы</b>'];

  const wb = getWbAdsByNm(WINDOW_DAYS);
  if (!wb) {
    L.push('• <b>WB:</b> статистики кампаний в кэше нет. Прогрев идёт кроном раз в 2 часа.');
  } else {
    L.push(`• <b>WB:</b> товаров за неделю ${wb.current.size}, за прошлую ${wb.previous.size}, дней в выгрузке ${wb.daysCovered}`);
  }

  const cur = await getOzonSkuAdsCached(WINDOW_DAYS - 1, 0).catch(() => null);
  const prev = await getOzonSkuAdsCached(2 * WINDOW_DAYS - 1, WINDOW_DAYS).catch(() => null);
  L.push(`• <b>Ozon, текущая неделя:</b> ${cur ? `товаров ${cur.count}` : 'нет в кэше, запустил сборку в фоне'}`);
  L.push(`• <b>Ozon, прошлая неделя:</b> ${prev ? `товаров ${prev.count}` : 'нет в кэше, запустил сборку в фоне'}`);

  const norms = await getDrrNorms();
  L.push(Object.keys(norms).length
    ? `• <b>Нормы ДРР:</b> ${Object.entries(norms).map(([k, v]) => `${k} ${v}%`).join(', ')}`
    : '• <b>Нормы ДРР:</b> не заданы, используется значение по умолчанию 5%');
  L.push('\n<i>Сборка отчётов Ozon занимает несколько минут. Если данных нет — повторите через 10 минут.</i>');
  return L.join('\n');
}

/**
 * Честный ручной отчёт для команды /реклама-анализ.
 *
 * Раньше команда звала общий runAgentById, и при ПУСТОМ результате он слал
 * «замечаний нет» — зелёную галочку, которая читается как «всё хорошо». Но пусто
 * бывает и когда данных не было вовсе (жалоба 03.08: WB-статистика не прогрета,
 * Ozon ещё собирался). Здесь три исхода различаются явно: нет данных / проверено
 * и чисто / список находок.
 */
export async function runAdsAnalysisManual(send: (t: string) => Promise<void>): Promise<void> {
  const norms = await getDrrNorms();

  // ── WB ──
  const wb = getWbAdsByNm(WINDOW_DAYS);
  if (!wb) {
    await send('⏳ <b>Агент 15 · Реклама WB:</b> данных пока нет. Статистика кампаний ещё не прогрета (обновляется кроном раз в 2 часа, после перезапуска — минуты).');
  } else {
    const f: Finding[] = [];
    for (const [nmId, current] of wb.current) {
      const label = wb.names.get(nmId) ?? `nm${nmId}`;
      f.push(...evaluate(buildItem('wb', label, current, wb.previous.get(nmId) ?? emptyFunnel()), norms));
    }
    const msgs = pack('WB', f, 'agent15:ads-wb');
    if (msgs.length) await send(msgs[0].text);
    else await send(`✅ <b>Агент 15 · Реклама WB:</b> проверено товаров ${wb.current.size}, отклонений по сценариям нет.`);
  }

  // ── Ozon ──
  const [cur, prev] = await Promise.all([
    getOzonSkuAdsCached(WINDOW_DAYS - 1, 0).catch(() => null),
    getOzonSkuAdsCached(2 * WINDOW_DAYS - 1, WINDOW_DAYS).catch(() => null),
  ]);
  if (!cur || !Object.keys(cur.items).length) {
    await send('⏳ <b>Агент 16 · Реклама Ozon:</b> данных пока нет — отчёты собираются в фоне (несколько минут). Повторите позже.');
  } else {
    const toFunnel = (r: any): AdFunnel => ({
      views: r?.views ?? 0, clicks: r?.clicks ?? 0, carts: r?.carts ?? 0,
      orders: r?.orders ?? 0, spend: r?.spend ?? 0, revenue: r?.revenue ?? 0,
    });
    const f: Finding[] = [];
    for (const [sku, row] of Object.entries(cur.items)) {
      f.push(...evaluate(buildItem('ozon', sku, toFunnel(row), toFunnel(prev?.items?.[sku])), norms));
    }
    const msgs = pack('Ozon', f, 'agent16:ads-ozon');
    if (msgs.length) await send(msgs[0].text);
    else await send(`✅ <b>Агент 16 · Реклама Ozon:</b> проверено товаров ${cur.count}, отклонений по сценариям нет.`);
  }

  // Заглушку по нормам показываем, только если клиент ещё не задал свои.
  if (Object.keys(norms).length <= 1) {
    await send('ℹ️ Нормы ДРР по категориям пока не заданы — используется 5% для всех. Задайте свои в разделе «Реклама».');
  }
}

/**
 * Фактический ДРР по категориям — текстом для бота (команда /нормы).
 * Показывает, из чего складывается норма-заготовка: реальный ДРР по каждой
 * категории из данных, а не выдуманный порог.
 */
export async function categoryDrrReport(): Promise<string> {
  const list = await getCategoryDrr().catch(() => []);
  if (!list.length) {
    return '📊 <b>Фактический ДРР по категориям</b>\n\nДанных нет — не удалось прочитать листы «ДРР и цены» / «Маржа».';
  }
  const rows = list.map(c =>
    `• <b>${c.category}</b>: ${c.drr}% <i>(расход ${Math.round(c.spend).toLocaleString('ru-RU')} ₽ · ${c.skuCount} SKU)</i>`,
  );
  return '📊 <b>Фактический ДРР по категориям</b>\n' +
    '<i>расход ÷ заказы за 7 дней, из листов «ДРР и цены» и «Маржа»</i>\n\n' +
    rows.join('\n') +
    '\n\nЭто ФАКТ, а не норма. Норму (порог) задаёт бизнес — можно взять это за отправную точку.';
}

/** Все находки списком — для раздела «Реклама» в интерфейсе. */
export async function collectAdsFindings(): Promise<{ findings: Finding[]; diagnostics: string }> {
  const norms = await getDrrNorms();
  const findings: Finding[] = [];

  const wb = getWbAdsByNm(WINDOW_DAYS);
  if (wb) {
    for (const [nmId, current] of wb.current) {
      const label = wb.names.get(nmId) ?? `nm${nmId}`;
      findings.push(...evaluate(buildItem('wb', label, current, wb.previous.get(nmId) ?? emptyFunnel()), norms));
    }
  }

  const cats = await skuToCategory().catch(() => new Map<string, string>());
  const [cur, prev] = await Promise.all([
    getOzonSkuAdsCached(WINDOW_DAYS - 1, 0).catch(() => null),
    getOzonSkuAdsCached(2 * WINDOW_DAYS - 1, WINDOW_DAYS).catch(() => null),
  ]);
  if (cur) {
    const toFunnel = (r: any): AdFunnel => ({
      views: r?.views ?? 0, clicks: r?.clicks ?? 0, carts: r?.carts ?? 0,
      orders: r?.orders ?? 0, spend: r?.spend ?? 0, revenue: r?.revenue ?? 0,
    });
    for (const [sku, row] of Object.entries(cur.items)) {
      const item = buildItem('ozon', sku, toFunnel(row), toFunnel(prev?.items?.[sku]), { category: cats.get(sku.toUpperCase()) });
      findings.push(...evaluate(item, norms));
    }
  }

  findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  return {
    findings,
    diagnostics: [
      wb ? `WB: товаров ${wb.current.size}` : 'WB: статистики нет',
      cur ? `Ozon: товаров ${cur.count}` : 'Ozon: данные собираются',
    ].join(' · '),
  };
}

/**
 * Плоская таблица «реклама по артикулам» для раздела «Реклама» (просьба клиента
 * 05.08: «мы не можем тянуть расход из кампаний поартикульно? у других сервисов
 * получается — в моей таблице тянется недельный расход по каждому артикулу»).
 *
 * Данные для этого уже собирались обеими площадками, но использовались только
 * сценариями-алертами. Здесь отдаём их как есть: расход, выручка, заказы, ДРР и
 * норма по категории — то же, что у клиента в таблице, только из API.
 */
export type AdsSkuRow = {
  platform: 'wb' | 'ozon';
  /** Человекочитаемое имя товара (WB) или артикул продавца (Ozon). */
  sku: string;
  /**
   * Идентификатор для сопоставления со строками кабинета: nmId у WB.
   * Без него калькулятор цен не мог связать рекламу с товаром — у WB в `sku`
   * лежит НАЗВАНИЕ карточки, а не артикул.
   */
  id?: string;
  category?: string;
  spend: number;
  revenue: number;
  orders: number;
  views: number;
  clicks: number;
  /**
   * ДРР по формуле КЛИЕНТА: расход ÷ выручка по ВСЕМ заказам товара × 100
   * (договорённость 14.08). Если общей выручки нет — считаем от выручки самой
   * рекламы и честно помечаем это в drrBase, чтобы цифру не приняли за сверяемую.
   */
  drr: number | null;
  /** Выручка по всем заказам артикула за период — знаменатель ДРР. */
  totalRevenue: number;
  /** 'all-orders' — как у клиента; 'ads-only' — запасной вариант. */
  drrBase: 'all-orders' | 'ads-only' | 'none';
  /** ROMI = выручка ÷ расход × 100. */
  romi: number | null;
  /** Норма ДРР для категории товара — чтобы сразу видеть отклонение. */
  norm: number;
  prevSpend: number;
  prevDrr: number | null;
};

type AdsBySkuResult = {
  items: AdsSkuRow[];
  days: number;
  diagnostics: string;
  /** Какие площадки реально дали статистику. Пусто у площадки → таблица неполная. */
  sources: { wb: boolean; ozon: boolean };
};

/** Кэш результата: собирать заново на каждый заход незачем, данные почасовые. */
const BY_SKU_TTL_MS = 10 * 60_000;
/**
 * Кэш неполного результата. Отдельный и короткий, потому что таблица собирается
 * из двух источников, которые прогреваются в разном темпе: статистика кампаний WB
 * приезжает через несколько минут после старта крона (рекламный API WB держит
 * ~1 запрос в минуту). Если в этот момент кто-то откроет страницу, таблица
 * соберётся без WB и с полным TTL залипнет на 10 минут — тот самый «WB 0 строк»
 * при живом расходе. С минутным TTL пустая половина пересобирается сама, как
 * только её источник прогреется.
 */
const BY_SKU_PARTIAL_TTL_MS = 60_000;

export async function collectAdsBySku(days = WINDOW_DAYS): Promise<AdsBySkuResult> {
  const { cacheGet, cacheSet, isFresh } = await import('../cache');
  const key = `ads-by-sku:v4:${days}`; // v2 16.09.2026: знаменатель Ozon теперь по offer_id
  const cached = await cacheGet<AdsBySkuResult>(key);
  if (isFresh(cached)) return cached.data;
  const fresh = await buildAdsBySku(days);
  const complete = fresh.sources.wb && fresh.sources.ozon;
  await cacheSet(key, fresh, complete ? BY_SKU_TTL_MS : BY_SKU_PARTIAL_TTL_MS);
  return fresh;
}

async function buildAdsBySku(days: number): Promise<AdsBySkuResult> {
  // Нормы, когда их не задавали руками, выводятся из листов таблицы — а это
  // снова медленный Apps Script. Норма это ПОРОГ, факт считается из API, так что
  // подождать её дольше пары секунд не стоит: возьмём 5% по умолчанию.
  // Оба медленных источника (нормы и категории) стартуют СРАЗУ и параллельно —
  // последовательные ожидания складывались в 10 секунд вместо 5.
  const normsP = Promise.race([
    getDrrNorms(),
    new Promise<Record<string, number>>(r => setTimeout(() => r({ '*': 5 }), 5_000)),
  ]);
  const catsP = Promise.race([
    skuToCategory().catch(() => new Map<string, string>()),
    new Promise<Map<string, string>>(r => setTimeout(() => r(new Map()), 5_000)),
  ]);
  // Общая выручка по артикулу — знаменатель ДРР в формуле клиента. Читается из
  // уже прогретых датасетов, в площадки не ходим.
  const totalsP = getTotalRevenue(days).catch(() => null);
  const norms = await normsP;
  const totals = await totalsP;
  const { drrNorm } = await import('../ads/rules');
  const items: AdsSkuRow[] = [];

  const toRow = (it: AdItem, id?: string, totalRevenue = 0): AdsSkuRow => ({
    platform: it.platform,
    sku: it.sku,
    ...(id ? { id } : {}),
    category: it.category,
    spend: Math.round(it.current.spend),
    revenue: Math.round(it.current.revenue),
    orders: it.current.orders,
    views: it.current.views,
    clicks: it.current.clicks,
    totalRevenue: Math.round(totalRevenue),
    drrBase: totalRevenue > 0 ? 'all-orders' : (it.current.revenue > 0 ? 'ads-only' : 'none'),
    drr: totalRevenue > 0
      ? Math.round((it.current.spend / totalRevenue) * 1000) / 10
      : it.derivedNow.drr,
    romi: it.current.spend > 0 ? Math.round((it.current.revenue / it.current.spend) * 1000) / 10 : null,
    norm: drrNorm(it.category, norms),
    prevSpend: Math.round(it.previous.spend),
    prevDrr: it.derivedPrev.drr,
  });

  const wb = getWbAdsByNm(days);
  if (wb) {
    for (const [nmId, current] of wb.current) {
      const label = wb.names.get(nmId) ?? `nm${nmId}`;
      items.push(toRow(
        buildItem('wb', label, current, wb.previous.get(nmId) ?? emptyFunnel()),
        String(nmId),
        totals?.wbByNm.get(String(nmId)) ?? 0,
      ));
    }
  }

  // Категории живут в Google-таблице, а Apps Script отвечает по 20 секунд
  // (замер на проде 10.08: весь эндпоинт занимал 21.4с именно из-за него).
  // Категория нужна только чтобы подобрать норму ДРР — без неё берётся норма по
  // умолчанию. Поэтому ждём её недолго и не даём задерживать всю таблицу.
  const cats = await catsP;
  const [cur, prev] = await Promise.all([
    getOzonSkuAdsCached(days - 1, 0).catch(() => null),
    getOzonSkuAdsCached(2 * days - 1, days).catch(() => null),
  ]);
  if (cur) {
    const toFunnel = (r: any): AdFunnel => ({
      views: r?.views ?? 0, clicks: r?.clicks ?? 0, carts: r?.carts ?? 0,
      orders: r?.orders ?? 0, spend: r?.spend ?? 0, revenue: r?.revenue ?? 0,
    });
    for (const [sku, row] of Object.entries(cur.items)) {
      items.push(toRow(buildItem('ozon', sku, toFunnel(row), toFunnel(prev?.items?.[sku]), {
        category: cats.get(sku.toUpperCase()),
      // Знаменатель: сначала «Заказано на сумму» из самого отчёта Ozon — это та
      // же величина, что и в аналитике, но по тому же окну и тем же SKU, что
      // расход, и именно её показывает другой сервис клиента. Аналитика — запас.
      }), sku, (row.orderedSum > 0 ? row.orderedSum : totals?.ozonBySku.get(sku.toUpperCase())) ?? 0));
    }
  }

  items.sort((a, b) => b.spend - a.spend);   // где больше денег — то и важнее
  return {
    items,
    days,
    sources: { wb: !!wb, ozon: !!cur },
    diagnostics: [
      wb ? `WB: товаров ${wb.current.size}` : ({
        'no-cache': 'WB: статистика кампаний не прогрета',
        'no-product-breakdown': 'WB: в статистике кампаний нет разбивки по товарам',
        'no-data-in-window': 'WB: за период по кампаниям нет данных по товарам',
      }[wbAdsMissReason() ?? 'no-cache']),
      cur ? `Ozon: товаров ${cur.count}` : 'Ozon: отчёт собирается',
      ...(totals?.missing ?? ['выручка по заказам недоступна — ДРР считается от выручки рекламы']),
    ].join(' · '),
  };
}

export const adsOzonAgent: Agent = {
  id: 'ads-ozon',
  name: 'Агент 16 · Реклама Ozon',
  role: 'Проверяет рекламу Ozon по сценариям специалиста и сообщает, что требует внимания',
  schedule: 'daily',
  run: runOzon,
};

export const adsWbAgent: Agent = {
  id: 'ads-wb',
  name: 'Агент 15 · Реклама Wildberries',
  role: 'Проверяет рекламу WB по сценариям специалиста и сообщает, что требует внимания',
  schedule: 'daily',
  run: runWb,
};
