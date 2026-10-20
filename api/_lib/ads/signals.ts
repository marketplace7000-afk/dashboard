/**
 * Сигналы и выпуски советника (этап А «Советник 2.0», 15.10.2026).
 *
 * Зачем. Три раздела считали «проблемы» тремя наборами правил (советник по дню,
 * узкие места «Рекламы», автопилот) и не знали друг о друге. Здесь — один слой:
 * сигнал = товар × код, с уровнем, адресатом (реклама / цены / контент / поставки /
 * карточка), «что случилось» с цифрами, «что сделать» и «сколько ₽ на кону».
 * Сигнал живёт, пока условие держится (менеджер видит «3-й день»), и имеет статус:
 * открыт / сделано / отложено. Пропавший из расчёта — закрывается сам.
 *
 * Выпуски. Четыре раза в рабочий день (08:00, 12:00, 15:30, 17:30 МСК, решение
 * владельца 15.10) сервер собирает «выпуск»: темп дня против того же часа в прошлые
 * дни, разбор вчера (advisor.ts) и свежие сигналы. Выпуски хранятся 14 дней.
 * Источники — только то, что уже есть на сервере: РНП, ads.sqlite, витрина
 * конкурентов (Агент 3). Новых запросов к площадкам не делает.
 */
import { adsDb, type AdMp } from './store';
import { getAdsOverview } from './overview';
import { getAdvisor, ADVISOR_LABEL } from './advisor';
import { hiddenCards, compCardSeries, cardHistory, refreshState } from './cabinet';
import { lastAdsSync } from './sync';
import { getAllLinks } from '../competitorWatch';
import { getRnp, collectRnp, rnpCollecting } from '../rnp';
import { mskDate } from '../mskDate';
import { getMargins, marginAt, priceFloor, type MarginReport } from '../margin';
import { marginThresholds } from '../repricer';
import type {
  Ads2AdvisorIssue, Ads2IssueSlot, Ads2Pace, Ads2Signal, Ads2SignalRole, Ads2SignalsResponse, Ads2Product,
} from '../../../shared/ads2';

const DAY = 86_400_000;
const MSK = 3 * 3600_000;
const addDays = (d: string, n: number) => new Date(Date.parse(d + 'T00:00:00Z') + n * DAY).toISOString().slice(0, 10);
const nf = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
const rub = (v: number) => `${nf.format(Math.round(v))} ₽`;
const up = (s: unknown) => String(s ?? '').trim().toUpperCase();
const hm = (ms: number) => new Date(ms + MSK).toISOString().slice(11, 16);
const dm = (ms: number) => { const s = new Date(ms + MSK).toISOString(); return `${s.slice(8, 10)}.${s.slice(5, 7)} ${s.slice(11, 16)}`; };

/** Расписание выпусков по МСК: за сколько до выпуска греть кэши площадок. */
export const ISSUE_SLOTS: { slot: Exclude<Ads2IssueSlot, 'manual'>; time: string; refresh: string; label: string }[] = [
  { slot: 'morning', time: '08:00', refresh: '07:20', label: 'Утро' },
  { slot: 'noon', time: '12:00', refresh: '11:35', label: 'Полдень' },
  { slot: 'day', time: '15:30', refresh: '15:05', label: 'День' },
  { slot: 'evening', time: '17:30', refresh: '17:05', label: 'Вечер' },
];
const KEEP_ISSUES_DAYS = 14;

let tablesReady = false;
function db(): any {
  const d = adsDb();
  if (!d) throw new Error('хранилище рекламы недоступно');
  if (!tablesReady) {
    d.exec(`CREATE TABLE IF NOT EXISTS signal (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        mp TEXT NOT NULL, sku TEXT NOT NULL, code TEXT NOT NULL,
        level TEXT NOT NULL, role TEXT NOT NULL, title TEXT NOT NULL, text TEXT NOT NULL, action TEXT NOT NULL,
        rub REAL, data TEXT,
        since INTEGER NOT NULL, last_seen INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'open', status_at INTEGER, status_by TEXT, snoozed_until INTEGER, note TEXT,
        UNIQUE (mp, sku, code));
      CREATE TABLE IF NOT EXISTS advisor_issue (
        id INTEGER PRIMARY KEY AUTOINCREMENT, mp TEXT NOT NULL, slot TEXT NOT NULL, date TEXT NOT NULL, at INTEGER NOT NULL, json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS advisor_issue_mp ON advisor_issue (mp, date, at);
      -- Снимки «к этому часу»: заказы, выручка, расход за сегодня на момент выпуска — база для темпа дня.
      CREATE TABLE IF NOT EXISTS rnp_intraday (
        mp TEXT NOT NULL, date TEXT NOT NULL, slot TEXT NOT NULL, at INTEGER NOT NULL,
        orders REAL NOT NULL, revenue REAL NOT NULL, spend REAL NOT NULL,
        PRIMARY KEY (mp, date, slot));`);
    tablesReady = true;
  }
  return d;
}

// ─── Сигналы ────────────────────────────────────────────────────────────────

type Draft = {
  sku: string; code: string; level: Ads2Signal['level']; role: Ads2SignalRole;
  title: string; text: string; action: string; rub: number | null;
  prod: { adSku: string | null; article: string; name: string; photo: string; link: string | null };
};

/** Код «узкого места» рекламы → сигнал. */
const ISSUE_MAP: Record<string, { role: Ads2SignalRole; title: string; action: string }> = {
  flagged_but_running: { role: 'ads', title: 'Реклама идёт у товара «Не рекламировать»', action: 'Остановить кампанию: «Реклама» → «Кампании»' },
  stock_critical: { role: 'supply', title: 'Нет остатка, а реклама идёт', action: 'Поставка; рекламу на паузу до прихода товара (предложение — в «Автопилоте»)' },
  stock_low: { role: 'supply', title: 'Остатка меньше 7 дней', action: 'Запланировать поставку; ставки не повышать' },
  spend_no_orders: { role: 'ads', title: 'Расход без заказов', action: 'Снизить ставку или поставить на паузу — предложение есть в «Автопилоте»' },
  drr_high: { role: 'ads', title: 'ДРР вдвое выше нормы', action: 'Снизить ставку («Автопилот»); проверить, не кончился ли остаток и не выросла ли цена' },
  card_to_cart: { role: 'content', title: 'Карточка не убеждает', action: 'Фото, цена против конкурентов, первые отзывы; рекламу не наращивать, пока конверсия не вернётся' },
  cart_to_order: { role: 'content', title: 'Бросают корзину', action: 'Проверить срок доставки, наличие на складах и цену в корзине (СПП, акции)' },
  low_margin: { role: 'price', title: 'Маржа ниже 10%', action: 'Проверить цену и себестоимость на листе «Цены»; рекламе почти не из чего платить' },
  no_ads_opportunity: { role: 'ads', title: 'Кандидат на рекламу', action: 'Продаётся без рекламы, запас большой — создать кампанию (решает менеджер)' },
};

/** Причина советника (вчера) → сигнал. Чего нет в карте — остаётся в разборе дня, сигналом не становится. */
const CAUSE_MAP: Record<string, { role: Ads2SignalRole; level: Ads2Signal['level'] }> = {
  card_hidden: { role: 'card', level: 'critical' },
  stock_out: { role: 'supply', level: 'critical' },
  ads_off: { role: 'ads', level: 'warn' },
  position_down: { role: 'ads', level: 'warn' },
  price_up: { role: 'price', level: 'warn' },
  spp_down: { role: 'price', level: 'warn' },
  comp_cheaper: { role: 'price', level: 'warn' },
};

function prodOf(p: Ads2Product): Draft['prod'] {
  return { adSku: p.adSku, article: p.article, name: p.name, photo: p.photo, link: p.link };
}

/** Собрать черновики сигналов по площадке из всех источников. */
async function draftSignals(mp: AdMp, now: number): Promise<{ drafts: Draft[]; notes: string[]; overviewProducts: Ads2Product[]; monthMargin: Ads2AdvisorIssue['monthMargin'] }> {
  const notes: string[] = [];
  const ov = await getAdsOverview(mp, 7);
  const byKey = new Map(ov.products.map(p => [p.key, p]));
  const byAd = new Map(ov.products.filter(p => p.adSku).map(p => [p.adSku!, p]));
  const drafts: Draft[] = [];
  const has = (sku: string, code: string) => drafts.some(d => d.sku === sku && d.code === code);
  const target = 5;
  // Маржа на сервере (этап Б): пол цены и сигналы по ценам.
  let margins: MarginReport | null = null;
  try { margins = await getMargins(mp); } catch (e) { notes.push(`Маржа: ${(e as Error).message}`); }
  const artOf = (p: Ads2Product) => up(mp === 'wb' ? p.article : p.key);
  const marginOf = (p: Ads2Product) => margins?.items[artOf(p)] ?? null;

  // 1. Узкие места «Рекламы» за 7 дней.
  for (const p of ov.products) {
    if (p.archived && !p.issues.some(i => i.code === 'flagged_but_running')) continue;
    for (const i of p.issues) {
      const m = ISSUE_MAP[i.code];
      if (!m) continue;
      if (i.code === 'low_margin' && marginOf(p)?.marginPct != null) continue; // точнее скажет сигнал по марже (п. 6)
      let money: number | null = null;
      if (i.code === 'flagged_but_running' || i.code === 'spend_no_orders') money = p.spend;
      else if (i.code === 'stock_critical') money = p.stock === 0 ? p.spendSinceOut : null;
      else if (i.code === 'drr_high') money = Math.max(0, p.spend - p.revenue * target / 100);
      const title = i.code === 'stock_critical' && p.stock !== 0 ? 'Остатка меньше 3 дней, а реклама идёт' : m.title;
      drafts.push({ sku: p.key, code: i.code, level: i.level, role: m.role, title, text: i.text, action: m.action, rub: money == null || money <= 0 ? null : Math.round(money), prod: prodOf(p) });
    }
  }

  // 2. Разбор вчера: причины просадки по товарам (жёсткие — остаток, реклама, позиция, цена, конкурент, карточка).
  const adv = await getAdvisor(mp);
  for (const p of adv.down) {
    const prod = byKey.get(p.key);
    for (const c of p.causes) {
      const m = CAUSE_MAP[c.code];
      if (!m) continue;
      if (c.code === 'stock_out' && has(p.key, 'stock_critical')) continue; // уже есть по 7 дням
      if (c.code === 'card_hidden' && has(p.key, 'card_hidden')) continue;
      // Реклама «остановилась», потому что все кампании товара на паузе (сами поставили) — это не тревога,
      // а напоминание: без рекламы товар продаёт меньше. Деньги «на кону» тут не считаем.
      const pausedByUs = c.code === 'ads_off' && !!prod && prod.campaigns.length > 0 && prod.campaigns.every(x => x.status !== 'active');
      const noCamps = c.code === 'ads_off' && !!prod && prod.campaigns.length === 0;
      drafts.push({
        sku: p.key, code: c.code, level: pausedByUs || noCamps ? 'info' : m.level, role: m.role,
        title: pausedByUs ? 'Реклама на паузе — продажи ниже обычного' : noCamps ? 'Товар без кампаний — продажи ниже обычного' : ADVISOR_LABEL[c.code]?.label ?? c.code,
        text: `Вчера (${adv.date.slice(8, 10)}.${adv.date.slice(5, 7)}): ${c.text}`,
        action: pausedByUs ? 'Если пауза не плановая — запустить кампанию («Реклама» → «Кампании»)' : noCamps ? 'Кандидат на кампанию, если запас и маржа позволяют' : c.action ?? ADVISOR_LABEL[c.code]?.action ?? '',
        rub: p.primary === c.code && !pausedByUs && !noCamps ? Math.round(Math.abs(p.delta)) : null,
        prod: prod ? prodOf(prod) : { adSku: p.adSku, article: p.article, name: p.name, photo: p.photo, link: p.link },
      });
    }
  }

  // 3. Карточки, которых витрина не показывает сейчас (последний проход агента), при остатке на складе.
  try {
    for (const [adSku, since] of hiddenCards(mp)) {
      const p = byAd.get(adSku);
      if (!p || !(p.stock != null && p.stock > 0) || p.archived) continue;
      const i = drafts.findIndex(d => d.sku === p.key && d.code === 'card_hidden');
      const text = `Витрина ${mp === 'wb' ? 'WB' : 'Ozon'} не показывает карточку покупателям с ${dm(since)} (проход Агента 3), хотя на складе ${nf.format(p.stock)} шт`;
      if (i >= 0) { drafts[i].text = text; continue; }
      drafts.push({ sku: p.key, code: 'card_hidden', level: 'critical', role: 'card', title: ADVISOR_LABEL.card_hidden.label, text, action: ADVISOR_LABEL.card_hidden.action, rub: Math.round(p.revenue / 7), prod: prodOf(p) });
    }
  } catch (e) { notes.push(`Витрина: ${(e as Error).message}`); }

  // 3а. Рейтинг карточки упал (18.10.2026, просьба владельца): последний замер витрины против
  //     замера 7 дней назад (или самого раннего в окне). Рейтинг — из РНП (замеры Агента 3).
  try {
    const today = mskDate(0);
    const rnp = await getRnp(mp, mskDate(7), today);
    const f2 = (v: number) => String(Math.round(v * 100) / 100).replace('.', ',');
    for (const p of ov.products) {
      if (p.archived || !(p.stock != null && p.stock > 0)) continue;
      const arr = rnp.facts[p.key]?.rating ?? [];
      const idx = arr.map((v, i) => (v != null ? i : -1)).filter(i => i >= 0);
      if (idx.length < 2) continue;
      const was = arr[idx[0]]!, now = arr[idx[idx.length - 1]]!;
      if (now > was - 0.05) continue;
      const fb = rnp.facts[p.key]?.feedbacks ?? [];
      const fbWas = fb[idx[0]], fbNow = fb[idx[idx.length - 1]];
      const fbText = fbWas != null && fbNow != null && fbNow > fbWas ? `, за это время новых отзывов ${nf.format(fbNow - fbWas)}` : '';
      drafts.push({
        sku: p.key, code: 'rating_drop', level: now < 4.5 || was - now >= 0.2 ? 'critical' : 'warn', role: 'card',
        title: 'Упал рейтинг карточки',
        text: `Рейтинг на витрине ${f2(was)} → ${f2(now)} (с ${rnp.dates[idx[0]].slice(8, 10)}.${rnp.dates[idx[0]].slice(5, 7)})${fbText}`,
        action: 'Открыть свежие отзывы с низкой оценкой («Отзывы и вопросы»), ответить на них и проверить, нет ли общей причины: брак, описание, комплектация',
        rub: null, prod: prodOf(p),
      });
    }
  } catch (e) { notes.push(`Рейтинг: ${(e as Error).message}`); }

  // 4. Конкурент снизил цену сегодня (подтверждённые привязки; против вчерашней цены).
  try {
    const links = getAllLinks(mp);
    const ids = new Set<string>();
    for (const ls of Object.values(links)) for (const l of ls) if (l.status === 'active') ids.add(String(l.nmId));
    const today = mskDate(0), yday = mskDate(1);
    const series = compCardSeries(mp, [...ids], yday, today);
    for (const p of ov.products) {
      if (p.archived) continue;
      const art = up(mp === 'wb' ? p.article : p.key);
      for (const l of links[art] ?? []) {
        if (l.status !== 'active') continue;
        const m = series.get(String(l.nmId));
        const a = m?.get(yday)?.price, b = m?.get(today)?.price;
        if (a == null || b == null || a <= 0 || b >= a * 0.95) continue;
        if (has(p.key, 'comp_cheaper')) continue; // вчерашняя причина уже стоит
        const ch = Math.round((b / a - 1) * 100);
        drafts.push({
          sku: p.key, code: 'comp_cheaper', level: 'warn', role: 'price', title: 'Конкурент снизил цену',
          text: `Сегодня конкурент «${(l.title || String(l.nmId)).slice(0, 40)}» снизил цену: ${rub(a)} → ${rub(b)} (${ch}%)${p.price ? `; наша ${rub(p.price)}` : ''}`,
          action: ADVISOR_LABEL.comp_cheaper.action, rub: null, prod: prodOf(p),
        });
      }
    }
  } catch (e) { notes.push(`Конкуренты: ${(e as Error).message}`); }

  // 6. Цены (этап Б): маржа ниже порога и цена против подтверждённых конкурентов — с рекомендованной
  //    ценой ЛК, не ниже пола по марже (порог — настройка репрайсера, по умолчанию 15%).
  if (margins) {
    // План маржи месяца (владелец 15.10): ниже плана — KPI под угрозой; край = план + запас; цель — 20%+.
    const th = marginThresholds(mp);
    const minMargin = th.floor;
    const f1 = (v: number) => String(Math.round(v * 10) / 10).replace('.', ',');
    const planText = `план ${th.month.slice(5)}.${th.month.slice(0, 4)} ${f1(th.plan)}%, держим ≥ ${f1(th.floor)}%, цель ${f1(th.target)}%`;
    const links = getAllLinks(mp);
    const compIds = new Set<string>();
    for (const ls of Object.values(links)) for (const l of ls) if (l.status === 'active') compIds.add(String(l.nmId));
    let hist = new Map<string, { price: number | null; stock: number | null; name: string }>();
    try { hist = cardHistory(mp, [...compIds]) as any; } catch (e) { notes.push(`Витрина конкурентов: ${(e as Error).message}`); }
    const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
    const pctOf = (a: number, b: number) => Math.round((a / b - 1) * 100);
    for (const p of ov.products) {
      if (p.archived || !(p.stock != null && p.stock > 0)) continue;
      const mr = marginOf(p);
      if (!mr || mr.retail == null) continue;
      const art = artOf(p);
      const floor = priceFloor(mr, minMargin);
      const toBuyer = (retail: number) => Math.round(retail * (1 - mr.spp / 100));
      const fromBuyer = (b: number) => Math.round(mr.spp > 0 ? b / (1 - mr.spp / 100) : b);
      const mAt = (retail: number) => { const v = marginAt(mr, retail); return v == null ? '–' : `${Math.round(v)}%`; };
      // 6a. Маржа ниже порога / в минус — только у товаров, которые продаются или рекламируются
      //     (мёртвые карточки без заказов и расхода ленту не засоряют). Уровень: минус — срочно,
      //     меньше 5% — внимание, ниже порога — к сведению.
      if (mr.marginPct != null && mr.marginPct < th.target && (p.orders > 0 || p.spend > 0)) {
        const neg = mr.marginPct < 0;
        const belowPlan = mr.marginPct < th.plan, onEdge = !belowPlan && mr.marginPct < th.floor;
        const inp: any = mr.input ?? {};
        // Что съедает маржу — чтобы было ясно, цена ли решает или расходы.
        const eats = [`комиссия ${Math.round(inp.commission ?? 0)}%`, `реклама ${Math.round(inp.drr ?? 0)}% (ДРР)`,
          `логистика и возвраты ${rub((inp.logistic ?? 0) + (inp.storage ?? 0) + (inp.returnCostPerSale ?? 0))}`].join(', ');
        // Пол дальше чем в полутора ценах — ценой не вытянуть, это про расходы.
        const reachable = floor != null && floor <= mr.retail * 1.5;
        drafts.push({
          sku: p.key, code: 'margin_below_floor', level: neg || belowPlan ? 'critical' : onEdge ? 'warn' : 'info', role: 'price',
          title: neg ? 'Товар продаётся в минус' : belowPlan ? 'Маржа ниже плана месяца' : onEdge ? 'Маржа на грани плана' : `Маржа ниже цели ${f1(th.target)}%`,
          text: `Маржа ${mr.marginPct}% (${rub(mr.marginRub ?? 0)} с штуки) при цене ЛК ${rub(mr.retail)}${mr.buyer ? ` и цене покупателя ${rub(mr.buyer)}` : ''}; ${planText}. Съедают: ${eats}. ${reachable ? `Цена ЛК для края — ${rub(floor!)} (маржа ${mAt(floor!)})` : 'Ценой не вытянуть — нужно снижать расходы или пересматривать закупку'}`,
          action: reachable ? 'Поднять цену ЛК до края в «Ценах» или снизить ДРР (ставки в «Автопилоте»)' : 'Снизить ДРР (пауза или ставка вниз в «Автопилоте»), проверить себестоимость и логистику; при верных цифрах — выводить товар',
          rub: neg && mr.marginRub != null ? Math.round(Math.abs(mr.marginRub) * p.orders / 7) : null, prod: prodOf(p),
        });
      }
      // 6b. Против подтверждённых конкурентов (цены с витрины, последний замер).
      const comps = (links[art] ?? []).filter(l => l.status === 'active').map(l => ({ l, h: hist.get(String(l.nmId)) })).filter(x => x.h && x.h.price != null && x.h.price > 0 && x.h.stock !== 0);
      if (!comps.length || mr.buyer == null) continue;
      const prices = comps.map(x => x.h!.price!);
      const med = median(prices), min = Math.min(...prices);
      const medConv = ov.medians.pdpToCart;
      const convLow = p.pdpToCart != null && medConv != null && (p.cardViews ?? 0) >= 50 && p.pdpToCart < medConv * 0.8;
      const convOk = p.pdpToCart != null && medConv != null && p.pdpToCart >= medConv;
      if (mr.buyer >= med * 1.08 && (convLow || (p.orders === 0 && (p.cardViews ?? 0) >= 50))) {
        const targetRetail = fromBuyer(Math.round(med * 0.99));
        const stepMin = Math.round(mr.retail * 0.85);
        let rec = Math.max(targetRetail, floor ?? 0, stepMin);
        const limited = floor != null && targetRetail < floor;
        rec = Math.min(rec, mr.retail); // рекомендация — снижение, выше текущей не предлагаем
        if (rec >= mr.retail) continue; // пол не пускает ниже — скажет сигнал по марже
        drafts.push({
          sku: p.key, code: 'price_above_market', level: 'warn', role: 'price', title: 'Цена выше рынка',
          text: `Наша цена покупателю ${rub(mr.buyer)} против медианы ${comps.length} конкурентов ${rub(med)} (${pctOf(mr.buyer, med) > 0 ? '+' : ''}${pctOf(mr.buyer, med)}%)${convLow ? `; в корзину кладут ${p.pdpToCart}% при ${medConv}% по магазину` : '; заказов за 7 дней нет'}. Рекомендованная цена ЛК ${rub(rec)} (покупателю ≈ ${rub(toBuyer(rec))}), маржа станет ${mAt(rec)}${limited ? ' — ниже не пускает пол по марже' : rec === stepMin ? ' — за раз не больше 15%' : ''}`,
          action: 'Поставить цену в «Ценах» (или акцию / промо); ставку рекламы до этого не поднимать', rub: null, prod: prodOf(p),
        });
      } else if (mr.buyer <= min * 0.90 && convOk && p.orders >= 3) {
        const targetRetail = Math.min(fromBuyer(Math.round(min * 0.98)), Math.round(mr.retail * 1.10));
        if (targetRetail <= mr.retail) continue;
        const gain = Math.round((targetRetail - mr.retail) * p.orders / 7);
        drafts.push({
          sku: p.key, code: 'price_room', level: 'info', role: 'price', title: 'Есть запас по цене',
          text: `Мы дешевле самого дешёвого из ${comps.length} конкурентов на ${Math.abs(pctOf(mr.buyer, min))}% (${rub(mr.buyer)} против ${rub(min)}), конверсия в корзину ${p.pdpToCart}% не ниже средней ${medConv}%. Можно поднять цену ЛК до ${rub(targetRetail)} (покупателю ≈ ${rub(toBuyer(targetRetail))}), маржа ${mAt(mr.retail)} → ${mAt(targetRetail)}${gain > 0 ? `, ≈ +${rub(gain)} в день` : ''}`,
          action: 'Поднять цену в «Ценах» шагом до 10% и посмотреть конверсию 3 дня', rub: gain > 0 ? gain : null, prod: prodOf(p),
        });
      }
    }
  }

  // 7. Маржа месяца по площадке: средневзвешенная по выручке с начала месяца при текущей марже товаров.
  //    Ниже плана — KPI менеджеров под угрозой; ниже края — предупреждение.
  let monthMargin: Ads2AdvisorIssue['monthMargin'] = null;
  if (margins) {
    try {
      const th = marginThresholds(mp);
      const today = mskDate(0);
      const start = `${today.slice(0, 7)}-01`;
      const rnp = await getRnp(mp, start, today);
      let revAll = 0, revCov = 0, profit = 0;
      for (const p of ov.products) {
        if (p.archived) continue;
        const arr = rnp.facts[p.key]?.ordered_amount;
        if (!arr) continue;
        const rev = arr.reduce<number>((s, v) => s + (v ?? 0), 0);
        if (rev <= 0) continue;
        revAll += rev;
        const mr = marginOf(p);
        if (mr?.marginPct == null) continue;
        revCov += rev; profit += rev * mr.marginPct / 100;
      }
      const pct = revCov > 0 ? Math.round(profit / revCov * 1000) / 10 : null;
      monthMargin = { month: today.slice(0, 7), pct, plan: th.plan, floor: th.floor, target: th.target, revenue: Math.round(revAll), covered: revAll > 0 ? Math.round(revCov / revAll * 100) / 100 : 0 };
      if (pct != null && revCov > 0 && pct < th.floor && monthMargin.covered >= 0.5) {
        const f1 = (v: number) => String(Math.round(v * 10) / 10).replace('.', ',');
        const below = pct < th.plan;
        drafts.push({
          sku: 'mp:plan', code: 'plan_margin', level: below ? 'critical' : 'warn', role: 'price',
          title: below ? `Маржа месяца ниже плана ${f1(th.plan)}%` : `Маржа месяца на грани плана`,
          text: `Средняя маржа ${mp === 'wb' ? 'WB' : 'Ozon'} с начала месяца ${f1(pct)}% (по ${Math.round(monthMargin.covered * 100)}% выручки с известной маржой); план ${f1(th.plan)}%, край ${f1(th.floor)}%, цель ${f1(th.target)}%${below ? ' — KPI менеджеров под угрозой' : ''}`,
          action: 'Разобрать товары с маржой ниже плана ниже в ленте: цена, ДРР, акции; сначала те, где выручка больше',
          rub: null, prod: { adSku: null, article: 'Вся площадка', name: `${mp === 'wb' ? 'Wildberries' : 'Ozon'} · маржа месяца`, photo: '', link: null },
        });
      }
    } catch (e) { notes.push(`Маржа месяца: ${(e as Error).message}`); }
  }

  // 5. Кампании: кончился бюджет / упёрлись в дневной лимит — пока товар в наличии.
  for (const c of ov.campaigns) {
    const prods = c.items.map(it => byAd.get(it.sku)).filter((p): p is Ads2Product => !!p && !p.archived && !p.flag);
    if (!prods.length) continue;
    const inStock = prods.filter(p => (p.stock ?? 0) > 0);
    if (!inStock.length) continue;
    const first = inStock[0];
    const nm = (c.name || `кампания ${c.id}`).slice(0, 70);
    if (c.status === 'out_of_budget') {
      drafts.push({ sku: `camp:${c.id}`, code: 'camp_out_of_budget', level: 'warn', role: 'ads', title: 'У кампании кончился бюджет',
        text: `«${nm}» остановлена площадкой: кончился бюджет, товар в наличии (${inStock.map(p => p.article).slice(0, 3).join(', ')})`,
        action: 'Пополнить бюджет или оставить остановленной — по ДРР товара («Реклама» → «Кампании»)', rub: null, prod: prodOf(first) });
    } else if (c.status === 'active' && c.dailyLimitOn && c.dailyLimit && c.spentToday != null && c.spentToday >= c.dailyLimit * 0.98) {
      drafts.push({ sku: `camp:${c.id}`, code: 'camp_limit_hit', level: 'info', role: 'ads', title: 'Кампания упёрлась в дневной лимит',
        text: `«${nm}»: потрачено ${rub(c.spentToday)} из лимита ${rub(c.dailyLimit)} — до конца дня показов не будет`,
        action: 'Если ДРР в норме и товар в наличии — поднять лимит; иначе так и оставить', rub: null, prod: prodOf(first) });
    }
  }
  return { drafts, notes: [...notes, ...ov.notes.filter(n => !/раз в 2 часа/.test(n))], overviewProducts: ov.products, monthMargin };
}

const LEVEL_ORDER: Record<string, number> = { critical: 0, warn: 1, info: 2 };
const ROLE_ORDER: Record<Ads2SignalRole, number> = { card: 0, supply: 1, ads: 2, price: 3, content: 4 };

function rowToSignal(r: any, now: number): Ads2Signal {
  const prod = r.data ? JSON.parse(r.data) : {};
  return {
    id: Number(r.id), mp: r.mp, sku: r.sku, adSku: prod.adSku ?? null,
    article: prod.article ?? r.sku, name: prod.name ?? '', photo: prod.photo ?? '', link: prod.link ?? null,
    code: r.code, level: r.level, role: r.role, title: r.title, text: r.text, action: r.action,
    rub: r.rub == null ? null : Number(r.rub),
    since: Number(r.since), lastSeen: Number(r.last_seen), days: Math.floor((Math.max(now, Number(r.last_seen)) + MSK) / DAY) - Math.floor((Number(r.since) + MSK) / DAY) + 1,
    status: r.status, statusAt: r.status_at == null ? null : Number(r.status_at), statusBy: r.status_by ?? null,
    snoozedUntil: r.snoozed_until == null ? null : Number(r.snoozed_until), note: r.note ?? null,
  };
}

export function sortSignals(xs: Ads2Signal[]): Ads2Signal[] {
  return [...xs].sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] || (b.rub ?? 0) - (a.rub ?? 0) || a.article.localeCompare(b.article));
}

/** Пересчитать сигналы площадки: открытые обновить, пропавшие закрыть, отложенные с истёкшим сроком вернуть. */
async function recomputeSignals(mp: AdMp, now: number): Promise<{ signals: Ads2Signal[]; notes: string[]; products: Ads2Product[]; monthMargin: Ads2AdvisorIssue['monthMargin'] }> {
  const { drafts, notes, overviewProducts, monthMargin } = await draftSignals(mp, now);
  const d = db();
  const seen = new Set<string>();
  const ins = d.prepare(`INSERT INTO signal (mp, sku, code, level, role, title, text, action, rub, data, since, last_seen, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')
    ON CONFLICT(mp, sku, code) DO UPDATE SET level = excluded.level, role = excluded.role, title = excluded.title, text = excluded.text,
      action = excluded.action, rub = excluded.rub, data = excluded.data, last_seen = excluded.last_seen,
      -- пропадал и вернулся — отсчёт дней заново и снова открыт
      since = CASE WHEN signal.status = 'gone' THEN excluded.since ELSE signal.since END,
      status = CASE WHEN signal.status = 'gone' THEN 'open'
                    WHEN signal.status = 'snoozed' AND COALESCE(signal.snoozed_until, 0) <= excluded.last_seen THEN 'open'
                    ELSE signal.status END`);
  d.exec('BEGIN');
  try {
    for (const x of drafts) {
      const k = `${x.sku}|${x.code}`;
      if (seen.has(k)) continue;
      seen.add(k);
      ins.run(mp, x.sku, x.code, x.level, x.role, x.title, x.text, x.action, x.rub, JSON.stringify(x.prod), now, now);
    }
    // Чего больше нет в расчёте — закрыть (и «сделано» тоже: условие ушло, запись больше не нужна в ленте).
    d.prepare(`UPDATE signal SET status = 'gone', status_at = ? WHERE mp = ? AND status != 'gone' AND last_seen < ?`).run(now, mp, now);
    d.prepare(`DELETE FROM signal WHERE status = 'gone' AND COALESCE(status_at, last_seen) < ?`).run(now - 30 * DAY);
    d.exec('COMMIT');
  } catch (e) { d.exec('ROLLBACK'); throw e; }
  return { signals: listSignals(mp, now), notes, products: overviewProducts, monthMargin };
}

/** Текущие сигналы площадки (кроме закрытых). */
export function listSignals(mp: AdMp, now = Date.now()): Ads2Signal[] {
  const rows = db().prepare(`SELECT * FROM signal WHERE mp = ? AND status != 'gone'`).all(mp) as any[];
  return sortSignals(rows.map(r => rowToSignal(r, now)));
}

export function decideSignal(id: number, action: 'done' | 'snooze' | 'reopen', by: string, note?: string | null): { ok: boolean; error?: string; signal?: Ads2Signal } {
  const d = db();
  const r = d.prepare('SELECT * FROM signal WHERE id = ?').get(id) as any;
  if (!r) return { ok: false, error: 'сигнал не найден' };
  const now = Date.now();
  if (action === 'done') d.prepare(`UPDATE signal SET status = 'done', status_at = ?, status_by = ?, note = COALESCE(?, note) WHERE id = ?`).run(now, by, note ?? null, id);
  else if (action === 'snooze') {
    // до завтрашнего утреннего выпуска (08:00 МСК)
    const until = Date.parse(mskDate(-1) + 'T08:00:00+03:00');
    d.prepare(`UPDATE signal SET status = 'snoozed', status_at = ?, status_by = ?, snoozed_until = ?, note = COALESCE(?, note) WHERE id = ?`).run(now, by, until, note ?? null, id);
  } else d.prepare(`UPDATE signal SET status = 'open', status_at = ?, status_by = ?, snoozed_until = NULL WHERE id = ?`).run(now, by, id);
  return { ok: true, signal: rowToSignal(d.prepare('SELECT * FROM signal WHERE id = ?').get(id), now) };
}

// ─── Темп дня ───────────────────────────────────────────────────────────────

async function pace(mp: AdMp, slot: Ads2IssueSlot, now: number, products: Ads2Product[]): Promise<Ads2Pace | null> {
  const today = mskDate(0);
  const rnp = await getRnp(mp, addDays(today, -7), today);
  const i = rnp.dates.indexOf(today);
  const archived = new Set(products.filter(p => p.archived).map(p => p.key));
  const sum = (metric: string, idx: number) => {
    let s = 0;
    for (const [k, m] of Object.entries(rnp.facts)) { if (archived.has(k)) continue; s += m[metric]?.[idx] ?? 0; }
    return s;
  };
  if (i < 0) return null;
  const orders = sum('ordered_cnt', i), revenue = sum('ordered_amount', i), spend = sum('adv_expenses', i);
  // Полные дни: средний день за 7 до сегодня.
  const full = { orders: 0, revenue: 0, spend: 0, n: 0 };
  for (let j = 0; j < i; j++) { full.orders += sum('ordered_cnt', j); full.revenue += sum('ordered_amount', j); full.spend += sum('adv_expenses', j); full.n++; }
  const fullDay = full.n ? { orders: Math.round(full.orders / full.n * 10) / 10, revenue: Math.round(full.revenue / full.n), spend: Math.round(full.spend / full.n) } : null;
  const d = db();
  let note: string | null = null;
  if (slot !== 'manual') {
    // Снимок к этому выпуску — только если по площадке уже есть хоть что-то за сегодня (иначе это задержка источника, а не ноль продаж).
    if (revenue > 0 || orders > 0 || spend > 0) d.prepare('INSERT OR REPLACE INTO rnp_intraday (mp, date, slot, at, orders, revenue, spend) VALUES (?, ?, ?, ?, ?, ?, ?)').run(mp, today, slot, now, orders, revenue, spend);
    d.prepare('DELETE FROM rnp_intraday WHERE mp = ? AND date < ?').run(mp, addDays(today, -30));
  }
  const rows = d.prepare('SELECT orders, revenue, spend FROM rnp_intraday WHERE mp = ? AND slot = ? AND date < ? AND date >= ? ORDER BY date DESC LIMIT 7').all(mp, slot, today, addDays(today, -10)) as any[];
  const base = rows.length >= 2 ? {
    orders: Math.round(rows.reduce((s, r) => s + Number(r.orders), 0) / rows.length * 10) / 10,
    revenue: Math.round(rows.reduce((s, r) => s + Number(r.revenue), 0) / rows.length),
    spend: Math.round(rows.reduce((s, r) => s + Number(r.spend), 0) / rows.length), days: rows.length,
  } : null;
  if (!revenue && !orders && fullDay && fullDay.orders > 0) note = `Данных за сегодня по ${mp === 'wb' ? 'WB' : 'Ozon'} ещё нет — источник отдаёт день с задержкой.`;
  else if (!base && slot !== 'manual') note = `База «к этому часу» копится по выпускам: через ${Math.max(0, 2 - rows.length)} дн появится сравнение с тем же временем прошлых дней.`;
  return { at: now, orders: Math.round(orders * 10) / 10, revenue: Math.round(revenue), spend: Math.round(spend), drr: revenue > 0 ? Math.round(spend / revenue * 1000) / 10 : null, base, fullDay, note };
}

// ─── Выпуск ─────────────────────────────────────────────────────────────────

// На process — одна на обе копии модуля под tsx (см. cache.ts): иначе ручной и
// плановый выпуск собирались параллельно и задваивали запись.
const B: { building: Promise<Ads2AdvisorIssue> | null } = ((process as any).__AV_ISSUE_BUILD__ ??= { building: null });
export function issueBuilding(): boolean { return B.building != null; }

/** Собрать выпуск по площадке. `collect` — обновить РНП перед сборкой, если она старше 25 минут. */
export function buildIssue(mp: AdMp, slot: Ads2IssueSlot, opts: { collect?: boolean } = {}): Promise<Ads2AdvisorIssue> {
  // Ждём текущую сборку, даже если она упала: иначе её ошибка доставалась чужому выпуску.
  if (B.building) return B.building.catch(() => undefined).then(() => buildIssue(mp, slot, opts));
  B.building = (async () => {
    const notes: string[] = [];
    if (opts.collect && !rnpCollecting()) {
      const probe = await getRnp(mp, mskDate(0), mskDate(0));
      const last = Math.max(0, ...Object.values(probe.collectedAt));
      if (Date.now() - last > 25 * 60_000) {
        try { await collectRnp(mp); } catch (e) { notes.push(`РНП не обновилась: ${(e as Error).message}`); }
      }
    }
    const now = Date.now();
    const { signals, notes: n2, products, monthMargin } = await recomputeSignals(mp, now);
    const p = await pace(mp, slot, now, products).catch(e => { notes.push(`Темп дня: ${(e as Error).message}`); return null; });
    const adv = await getAdvisor(mp);
    const rnpAt = (await getRnp(mp, mskDate(0), mskDate(0))).collectedAt;
    let compAt: number | null = null;
    try { compAt = refreshState(mp).pass?.at ?? null; } catch { /* без витрины */ }
    const issue: Omit<Ads2AdvisorIssue, 'id'> = {
      mp, slot, date: mskDate(0), at: now, pace: p,
      yesterday: { date: adv.date, baseFrom: adv.baseFrom, baseTo: adv.baseTo, summary: adv.summary, drivers: adv.drivers, day: adv.day, base: adv.base, weekAgo: adv.weekAgo, down: adv.down.slice(0, 15), up: adv.up.slice(0, 8) },
      signals: signals.filter(s => s.status !== 'done'),
      monthMargin,
      dataAt: { rnp: Math.max(0, ...Object.values(rnpAt)) || null, ads: lastAdsSync()?.at ?? null, comp: compAt },
      notes: [...new Set([...notes, ...n2, ...adv.notes])],
    };
    const d = db();
    const r = d.prepare('INSERT INTO advisor_issue (mp, slot, date, at, json) VALUES (?, ?, ?, ?, ?)').run(mp, slot, issue.date, now, JSON.stringify(issue));
    d.prepare('DELETE FROM advisor_issue WHERE date < ?').run(addDays(mskDate(0), -KEEP_ISSUES_DAYS));
    return { id: Number(r.lastInsertRowid), ...issue };
  })().finally(() => { B.building = null; });
  return B.building;
}

/** Выпуски и сигналы для экрана. */
export function getSignals(mp: AdMp, date?: string, id?: number): Ads2SignalsResponse {
  const d = db();
  const now = Date.now();
  const today = mskDate(0);
  const dates: string[] = [];
  for (let i = 0; i < KEEP_ISSUES_DAYS; i++) dates.push(addDays(today, -i));
  const D = date && dates.includes(date) ? date : today;
  const issues = (d.prepare('SELECT id, slot, at FROM advisor_issue WHERE mp = ? AND date = ? ORDER BY at').all(mp, D) as any[])
    .map(r => ({ id: Number(r.id), slot: r.slot as Ads2IssueSlot, at: Number(r.at) }));
  const row = id ? d.prepare('SELECT * FROM advisor_issue WHERE id = ? AND mp = ?').get(id, mp) as any
    : d.prepare('SELECT * FROM advisor_issue WHERE mp = ? AND date = ? ORDER BY at DESC LIMIT 1').get(mp, D) as any;
  let issue: Ads2AdvisorIssue | null = null;
  if (row) {
    issue = { id: Number(row.id), ...JSON.parse(row.json) };
    // Статусы — свежие из таблицы (менеджер мог отметить «сделано» после выпуска); текст — на момент выпуска.
    const cur = new Map(listSignals(mp, now).map(s => [s.id, s]));
    issue!.signals = issue!.signals.map(s => { const c = cur.get(s.id); return c ? { ...s, status: c.status, statusAt: c.statusAt, statusBy: c.statusBy, snoozedUntil: c.snoozedUntil, note: c.note, days: c.days } : { ...s, status: 'gone' as const }; });
  }
  const doneToday = listSignals(mp, now).filter(s => s.status === 'done' && s.statusAt != null && mskDate(0) === new Date(s.statusAt + MSK).toISOString().slice(0, 10));
  return { ok: true, mp, date: D, dates, slots: ISSUE_SLOTS.map(s => ({ slot: s.slot, time: s.time, label: s.label })), issues, issue, doneToday, building: issueBuilding() };
}

// ─── Планировщик по МСК ─────────────────────────────────────────────────────

/** «HH:MM» по Москве. */
const mskHM = (ms: number) => hm(ms);
const minutesOf = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

/**
 * Раз в минуту: за 25–40 минут до выпуска — прогрев кэшей площадок (как цепочка крона),
 * в момент выпуска — сборка по обеим площадкам. Если сервер был выключен — выпуск
 * собирается при старте, но не позже чем через 2 часа после слота (потом он уже устарел).
 */
export function startIssueScheduler(warm: () => void): void {
  const fired = new Set<string>();
  const tick = async () => {
    try {
      const now = Date.now();
      const date = mskDate(0);
      const cur = minutesOf(mskHM(now));
      for (const s of ISSUE_SLOTS) {
        const rk = `warm:${date}:${s.slot}`;
        // Окно, а не точная минута: при задержке таймера или занятом сервере минута
        // проскакивала, и прогрев перед выпуском не случался.
        const sinceRefresh = cur - minutesOf(s.refresh);
        if (sinceRefresh >= 0 && sinceRefresh <= 10 && !fired.has(rk)) { fired.add(rk); warm(); }
        const diff = cur - minutesOf(s.time);
        if (diff < 0 || diff > 120) continue;
        const ik = `issue:${date}:${s.slot}`;
        if (fired.has(ik)) continue;
        const d = db();
        fired.add(ik);
        for (const mp of ['wb', 'ozon'] as AdMp[]) {
          // Проверка по площадке: если WB собрался, а Ozon упал, после рестарта
          // Ozon раньше не пересобирался — выпуск «уже есть».
          if (d.prepare('SELECT 1 FROM advisor_issue WHERE date = ? AND slot = ? AND mp = ? LIMIT 1').get(date, s.slot, mp)) continue;
          try {
            const r = await buildIssue(mp, s.slot, { collect: true });
            console.warn(`[advisor] выпуск ${s.label} ${mp}: сигналов ${r.signals.length}`);
          } catch (e) { console.warn(`[advisor] выпуск ${s.label} ${mp} не собран:`, (e as Error).message); }
        }
      }
      // не копить ключи прошлых дней
      for (const k of fired) if (!k.includes(date)) fired.delete(k);
    } catch (e) { console.warn('[advisor] планировщик:', (e as Error).message); }
  };
  setTimeout(tick, 90_000);
  setInterval(tick, 60_000).unref();
}
