/**
 * Автопилот рекламы — этап 2 «советник» (14.10.2026).
 *
 * Раз в проход цепочки обновлений сервера (после РНП) и по кнопке смотрит на
 * кампании и товары за последние 7 дней и готовит ПРЕДЛОЖЕНИЯ. Сам ничего не
 * меняет: решение владельца 13.10 — первые 2 недели только «с подтверждением».
 * Менеджер нажимает «Применить» (команда уходит через actions.ts, как ручная)
 * или «Отклонить» (пишется в журнал с причиной).
 *
 * Правила (docs/ads-system/ПРОЕКТ_РЕКЛАМА_2026-10-13.md, «Автопилот»; с 22.10.2026 —
 * по разбору менеджера, см. buildProposals и econ.ts):
 *   • бюджет площадки = 5% от заказов; если площадка тратит больше — снижаем товары,
 *     у которых ДРР выше и бюджета, и допустимого из маржи, начиная с худшего;
 *   • допустимая цена заказа = (маржа до рекламы − план прибыли) × выкуп;
 *     за клик — × конверсия клика в заказ;
 *   • шаг ставки — из расчёта (допустимая / фактическая цена заказа), −30…+20%;
 *     после изменения товара ждём 24 ч замера;
 *   • нет остатка или < 3 дн — задача «исключить товар до поставки»; < 14 дн — не поднимаем;
 *   • ноль заказов — только если он значим при обычной конверсии; товар в плюсе — тест, не пауза;
 *   • ставку вверх — когда заказ дешевле 60% допустимого, есть заказы, запас ≥ 14 дн,
 *     маржа не низкая и узкое место НЕ в карточке/корзине (иначе — задача команде);
 *   • товары «Не рекламировать» не трогаем; если реклама по ним идёт — предлагаем паузу;
 *   • новые кампании — только совет, решает менеджер.
 */
import { adsDb, adsMetaGet, adsMetaSet, getCampaign, logChange, type AdMp } from './store';
import { applyAdAction, type AdAction } from './actions';
import { getAdsOverview } from './overview';
import { mskDate } from '../mskDate';
import { cardHistory, getCompetitors } from './cabinet';
import { getAllLinks } from '../competitorWatch';
import { getMargins } from '../margin';
import { marginThresholds } from '../repricer';
import { campaignStats } from './store';
import { toStat } from './overview';
import {
  zeroOrdersChance, clicksForSignal, funnelBench, funnelCause, BASE_CR, P0_MAX, ANOMALY_X, type FunnelBench,
} from './econ';
import {
  ADS_BUDGET_SHARE,
  type Ads2Overview, type Ads2Campaign, type Ads2CampaignItem, type Ads2Stat, type Ads2Econ,
  type Ads2Proposal, type Ads2ProposalKind, type Ads2ProposalDetails, type Ads2AutopilotState, type Ads2AutopilotMode,
} from '../../../shared/ads2';

/** «Сначала худший ДРР»: при перерасходе площадки за проход предлагаем снизить не всё подряд, а столько товаров с худшим ДРР. */
const OVER_BUDGET_TOP = 5;

/**
 * Контекст этапа В (15.10.2026): конкуренты, маржа и нормы категорий. Без него правила
 * работают как раньше (проверки и старые вызовы).
 */
export type AutopilotCtx = {
  /** Край маржи, % (план месяца + запас): ниже — ставки не поднимаем. */
  marginFloorPct: number;
  /** Наш товар (ключ рекламы) → подтверждённые конкуренты с витрины и наша цена покупателя. */
  comps: Map<string, { ourBuyer: number | null; prices: number[]; outOfStock: number; total: number; median: number | null; min: number | null }>;
  /** Ozon: товар → медианный ДРР его категории по «Товарам на Ozon», %. */
  benchDrr: Map<string, number>;
  /** 22.10.2026: статистика «кампания|товар» за 28 дней — сравнение 7/28 и выборка для редких заказов. */
  stat28: Map<string, Ads2Stat>;
  /** Конверсия клика в заказ товара за 28 дней по всем кампаниям (≥ 50 кликов и ≥ 1 заказ), доля. */
  skuCr: Map<string, number>;
  /** Медианы рекламной воронки площадки за 28 дней, %. */
  bench: FunnelBench;
};
export const EMPTY_CTX: AutopilotCtx = {
  marginFloorPct: 15, comps: new Map(), benchDrr: new Map(), stat28: new Map(), skuCr: new Map(),
  bench: { ctr: null, cartRate: null, cartToOrder: null, cr: null },
};
const SETTLE_MS = 24 * 3600_000;
/** Открытое предложение, которое давно не подтверждалось пересчётом, не показываем. */
const EXPIRE_MS = 36 * 3600_000;
const REJECT_QUIET_MS = 3 * 86_400_000;
const ADVICE_QUIET_MS = 7 * 86_400_000;
/** Дата старта режима «с подтверждением» (решение владельца 13.10): 2 недели. */
const CONFIRM_WEEKS = 2;

const r2 = (v: number) => Math.round(v * 100) / 100;
const rub = (v: number) => `${r2(v).toLocaleString('ru-RU')} ₽`;

function db(): any {
  const d = adsDb();
  if (!d) throw new Error('хранилище рекламы недоступно');
  d.exec(`
    CREATE TABLE IF NOT EXISTS ad_proposal (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      mp TEXT NOT NULL, campaign_id TEXT, sku TEXT,
      kind TEXT NOT NULL,          -- bid | pause | daily_limit | weekly_budget | task | new_campaign
      placement TEXT,
      from_value REAL, to_value REAL,
      rule TEXT NOT NULL, level TEXT NOT NULL, title TEXT NOT NULL, reason TEXT NOT NULL,
      fp TEXT NOT NULL,            -- «отпечаток» предмета: одно открытое предложение на предмет
      status TEXT NOT NULL,        -- pending | applied | rejected | failed | expired | superseded
      decided_at INTEGER, decided_by TEXT, note TEXT, log_id INTEGER, result TEXT
    );
    CREATE INDEX IF NOT EXISTS ad_prop_status ON ad_proposal (status, mp);
  `);
  // 22.10.2026: что проверено, чего не хватает, уверенность, альтернатива, риск, откат — JSON.
  if (!(d.prepare('PRAGMA table_info(ad_proposal)').all() as any[]).some(c => c.name === 'details')) d.exec('ALTER TABLE ad_proposal ADD COLUMN details TEXT');
  return d;
}

// ─── Режим ──────────────────────────────────────────────────────────────────

export function getAutopilotMode(): { mode: Ads2AutopilotMode; since: number | null; confirmUntil: number | null } {
  const mode = (adsMetaGet('autopilot:mode') as Ads2AutopilotMode | null) ?? 'confirm';
  const since = Number(adsMetaGet('autopilot:since')) || null;
  return { mode, since, confirmUntil: since ? since + CONFIRM_WEEKS * 7 * 86_400_000 : null };
}

export function setAutopilotMode(mode: Ads2AutopilotMode): void {
  // Этап 3 («сам в пределах лимитов») ещё не построен: принимаем только off/confirm.
  if (mode !== 'off' && mode !== 'confirm') throw new Error('режим: off или confirm');
  adsMetaSet('autopilot:mode', mode);
  if (mode === 'confirm' && !adsMetaGet('autopilot:since')) adsMetaSet('autopilot:since', String(Date.now()));
}

// ─── Правила ────────────────────────────────────────────────────────────────

type Draft = Omit<Ads2Proposal, 'id' | 'createdAt' | 'status' | 'decidedAt' | 'decidedBy' | 'note' | 'result' | 'effect' | 'campaignName' | 'productName' | 'article' | 'photo'>;

/** Чем меньше, тем выше в списке. */
const LEVEL_ORDER: Record<string, number> = { critical: 0, warn: 1, growth: 2, info: 3 };

function recentlyChanged(mp: AdMp, campaignId: string, sku: string | null): boolean {
  const d = adsDb();
  if (!d) return false;
  const since = Date.now() - SETTLE_MS;
  const row = sku
    ? d.prepare(`SELECT 1 FROM ad_change_log WHERE mp = ? AND campaign_id = ? AND (sku = ? OR sku IS NULL) AND status = 'applied' AND at >= ? LIMIT 1`).get(mp, campaignId, sku, since)
    : d.prepare(`SELECT 1 FROM ad_change_log WHERE mp = ? AND campaign_id = ? AND status = 'applied' AND at >= ? LIMIT 1`).get(mp, campaignId, since);
  return !!row;
}

function sumItemStats(c: Ads2Campaign): { spend: number; orders: number; clicks: number } | null {
  const ss = c.items.map(i => i.stat).filter(Boolean) as NonNullable<Ads2CampaignItem['stat']>[];
  if (!ss.length) return null;
  return ss.reduce((a, s) => ({ spend: a.spend + s.spend, orders: a.orders + s.orders, clicks: a.clicks + s.clicks }), { spend: 0, orders: 0, clicks: 0 });
}

const isActive = (c: Ads2Campaign) => (c.mp === 'wb' ? c.statusCode === 9 : c.status === 'active');

/** Текущие ставки товара по местам, которые можно менять. Рубли. */
function bidSlots(c: Ads2Campaign, it: Ads2CampaignItem): { placement: 'search' | 'recommendations' | 'combined' | null; bid: number }[] {
  if (!c.can.bid) return [];
  if (c.mp === 'ozon') return it.bid != null && it.bid > 0 ? [{ placement: null, bid: it.bid }] : [];
  if (c.bidType === 'unified') {
    const b = it.bidSearch ?? it.bidReco;
    return b != null && b > 0 ? [{ placement: 'combined', bid: b }] : [];
  }
  const out: { placement: 'search' | 'recommendations'; bid: number }[] = [];
  if (it.bidSearch != null && it.bidSearch > 0) out.push({ placement: 'search', bid: it.bidSearch });
  if (it.bidReco != null && it.bidReco > 0) out.push({ placement: 'recommendations', bid: it.bidReco });
  return out;
}

/** Самый большой шаг за проход: вниз −30 %, вверх +20 %. Сам шаг — из расчёта экономики, а не фиксированные 15 %. */
const MAX_DOWN = 0.3;
const MAX_UP = 0.2;
const clampDown = (f: number) => Math.min(0.95, Math.max(1 - MAX_DOWN, f));
const clampUp = (f: number) => Math.max(1.05, Math.min(1 + MAX_UP, f));
const pctS = (v: number) => `${Math.round(v * 1000) / 10}%`.replace('.', ',');
const num0 = (v: number) => Math.round(v).toLocaleString('ru-RU');

/**
 * Конверсия клика в заказ у товара в кампании: 7 дней, если хватает выборки,
 * иначе 28 дней. Нужны ≥ 50 кликов и ≥ 1 заказ — иначе конверсия — гадание.
 */
function crOf(s: Ads2Stat | null, s28: Ads2Stat | null): { cr: number; days: 7 | 28 } | null {
  if (s && s.clicks >= 50 && s.orders >= 1) return { cr: s.orders / s.clicks, days: 7 };
  if (s28 && s28.clicks >= 50 && s28.orders >= 1) return { cr: s28.orders / s28.clicks, days: 28 };
  return null;
}

/** Цена рекламного заказа: 7 дней при ≥ 2 заказах, иначе 28 дней при ≥ 2 заказах. */
function cpoOf(s: Ads2Stat | null, s28: Ads2Stat | null): { cpo: number; orders: number; days: 7 | 28 } | null {
  if (s && s.orders >= 2) return { cpo: r2(s.spend / s.orders), orders: s.orders, days: 7 };
  if (s28 && s28.orders >= 2) return { cpo: r2(s28.spend / s28.orders), orders: s28.orders, days: 28 };
  return null;
}

/**
 * Потолок ставки из экономики товара: допустимая цена заказа × конверсия клика =
 * допустимая цена клика; для оплаты за 1000 показов — ещё × CTR × 1000.
 */
function bidCeiling(c: Ads2Campaign, e: Ads2Econ | null, s: Ads2Stat | null, s28: Ads2Stat | null): { max: number; how: string } | null {
  if (!e || e.allowedCpo <= 0) return null;
  const cr = crOf(s, s28);
  if (!cr) return null;
  const maxCpc = e.allowedCpo * cr.cr;
  if (c.payment === 'cpc' || c.mp === 'ozon') return { max: r2(maxCpc), how: `допустимый заказ ${rub(e.allowedCpo)} × конверсия клика ${r2(cr.cr * 100)}% за ${cr.days} дн` };
  const v = cr.days === 7 ? s : s28;
  if (c.payment === 'cpm' && v && v.views >= 1000) {
    const ctr = v.clicks / v.views;
    return { max: Math.round(maxCpc * ctr * 1000), how: `допустимый заказ ${rub(e.allowedCpo)} × конверсия ${r2(cr.cr * 100)}% × CTR ${r2(ctr * 100)}% × 1000` };
  }
  return null;
}

const det = (d: Partial<Ads2ProposalDetails> & { checks: string[]; missing: string[] }): Ads2ProposalDetails => ({
  confidence: 'medium', alternative: null, risk: null, controlDays: 3, rollback: null, ...d,
  checks: [...d.checks], missing: [...d.missing],
});

/**
 * Правила (22.10.2026, по разбору менеджера «Аудит алгоритма рекомендаций»):
 * перед изменением кампании — пять проверок с остановкой:
 *   1. данные достоверны? — цена заказа в 10+ раз выше допустимой → «проверить данные», без команды;
 *   2. товар доступен? — нет остатка или < 3 дней → «исключить товар до поставки», а не −15 % бюджета;
 *   3. статистики достаточно? — ноль заказов значим, только если P(0) при обычной конверсии < 5 %;
 *   4. экономика подтверждена? — допустимая цена заказа из маржи ДО рекламы и все заказы товара;
 *      товар в плюсе — не пауза, а ограниченный тест; маржи нет — совет, а не снижение по порогу 5 %;
 *   5. причина найдена? — слабое звено воронки (CTR → корзины → заказы) против медиан площадки.
 * Шаг ставки — из расчёта (допустимая цена заказа / фактическая), в пределах −30 %…+20 %.
 * Кампанию с прибыльными и убыточными товарами целиком не ухудшаем.
 * У каждого предложения — что проверено, чего не хватает, уверенность, альтернатива,
 * риск, срок замера и условие отката (поле details).
 */
export function buildProposals(ov: Ads2Overview, ctx: AutopilotCtx = EMPTY_CTX): Draft[] {
  const mp = ov.mp;
  const out: Draft[] = [];
  const target = ADS_BUDGET_SHARE * 100;
  const overBudget = ov.budget.drrPct != null && ov.budget.drrPct > target * 1.1;
  const prodByAd = new Map(ov.products.filter(p => p.adSku).map(p => [p.adSku!, p]));
  /** ДРР товара для правила «сначала худший»: fp предложения → ДРР. */
  const overBudgetDrr = new Map<string, number>();
  const baseCr = ctx.bench.cr != null ? ctx.bench.cr / 100 : BASE_CR;

  for (const c of ov.campaigns) {
    if (!isActive(c) || !c.items.length) continue;
    const prods = c.items.map(it => prodByAd.get(it.sku));
    const campFp = `${mp}|${c.id}`;
    const settledCamp = !recentlyChanged(mp, c.id, null);

    // 1. Пауза всей кампании: все её товары «Не рекламировать», кончаются или кампания «горит»
    //    — ноль заказов значим И ни у одного её товара экономика не в плюсе.
    const allFlagged = c.items.every(it => it.noAds);
    const allOut = prods.every(p => p && (p.stock === 0 || (p.daysOfStock != null && p.daysOfStock < 3)));
    const cs = c.stat ?? sumItemStats(c);
    const p0Camp = cs ? zeroOrdersChance(cs.clicks, baseCr) : 1;
    const anyProfitable = prods.some(p => p && p.orders > 0 && p.econ && p.econ.profit > 0);
    const burning = !!cs && cs.spend >= 1500 && cs.orders === 0 && cs.clicks >= 50 && p0Camp <= P0_MAX && !anyProfitable;
    if (c.can.pause && settledCamp && (allFlagged || allOut || burning)) {
      const checks = cs ? [`кампания за 7 дн: ${num0(cs.clicks)} кликов, ${rub(cs.spend)}, заказов ${cs.orders}`] : [];
      if (burning) {
        checks.push(`ноль заказов при обычной конверсии ${r2(baseCr * 100)}% — вероятность ${pctS(p0Camp)}: сигнал значимый`);
        for (const p of prods) if (p) checks.push(`${p.article}: всего заказов ${p.orders}${p.econ ? `, прибыль после рекламы ${rub(p.econ.profit)}` : ', маржа неизвестна'}`);
      }
      out.push({
        mp, campaignId: c.id, sku: null, kind: 'pause', placement: null, fromValue: null, toValue: null,
        rule: allFlagged ? 'flagged' : allOut ? 'stock_out' : 'spend_no_orders', level: 'critical',
        title: 'Поставить кампанию на паузу',
        reason: allFlagged ? 'Все товары кампании отмечены «Не рекламировать», а реклама идёт'
          : allOut ? 'У всех товаров кампании нет остатка или его меньше чем на 3 дня — реклама разгонит спрос, которого нечем закрыть'
            : `За 7 дней расход ${rub(cs!.spend)} и ${cs!.clicks} кликов — ни одного заказа, и ни один товар кампании не в плюсе`,
        fp: `${campFp}|pause`,
        details: det({
          checks, missing: prods.some(p => !p?.econ) && burning ? ['маржа части товаров кампании'] : [],
          confidence: allFlagged || allOut ? 'high' : prods.every(p => p?.econ) ? 'high' : 'medium',
          alternative: allOut ? 'исключить товары до поставки и оставить кампанию' : burning ? 'снизить ставки на 30 % и проверить поисковые запросы и карточку' : null,
          risk: allFlagged ? null : 'при возобновлении кампании позиции и ставки придётся набирать заново',
          rollback: allOut ? 'запустить в день поступления товара на склад' : burning ? 'запустить, если все заказы товаров за 3 дня упали больше чем на 20 %' : null,
        }),
      });
      continue;
    }

    // 2. Дневной лимит WB для кампаний с оплатой за клик — защита от перерасхода.
    if (mp === 'wb' && c.can.dailyLimit && !c.dailyLimitOn && cs && cs.spend > 0 && settledCamp) {
      const days = 7;
      const lim = Math.max(10, Math.ceil((cs.spend / days) * 1.3 / 10) * 10);
      out.push({
        mp, campaignId: c.id, sku: null, kind: 'daily_limit', placement: null, fromValue: null, toValue: lim,
        rule: 'no_daily_limit', level: 'warn', title: `Включить дневной лимит ${rub(lim)}`,
        reason: `Лимита нет — кампания может съесть любой бюджет за день. Средний расход ${rub(cs.spend / days)}/день, лимит с запасом 30%`,
        fp: `${campFp}|daily_limit`,
        details: det({ checks: [`расход за 7 дн ${rub(cs.spend)}`], missing: [], confidence: 'high', risk: 'в дни повышенного спроса кампания остановится раньше вечера', rollback: 'поднять лимит, если кампания упирается в него 3 дня подряд' }),
      });
    }

    // 3. Товары кампании.
    /** Ozon без ручной ставки: снижения копим и решаем по кампании целиком (не режем бюджет ради одного товара). */
    const budgetDown: { sku: string; article: string; spend: number; factor: number; why: string; rule: string; level: Draft['level'] }[] = [];
    c.items.forEach((it, i) => {
      const p = prods[i];
      if (it.noAds) {
        out.push({
          mp, campaignId: c.id, sku: it.sku, kind: 'task', placement: null, fromValue: null, toValue: null,
          rule: 'flagged', level: 'warn', title: 'Убрать товар из кампании',
          reason: 'Товар отмечен «Не рекламировать», а кампания активна — уберите его из кампании в кабинете', fp: `${campFp}|${it.sku}|flagged`,
          details: det({ checks: [`отметка «Не рекламировать»: ${p?.flag?.reason ?? 'есть'}`], missing: [], confidence: 'high' }),
        });
        return;
      }
      if (recentlyChanged(mp, c.id, it.sku)) return;
      const slots = bidSlots(c, it);
      const s = it.stat;
      const s28 = ctx.stat28.get(`${c.id}|${it.sku}`) ?? null;
      const e = p?.econ ?? null;
      const dos = p?.daysOfStock ?? null;
      const cause = funnelCause(s && s.clicks >= 100 ? s : (s28 ?? s), ctx.bench);
      const cpo = cpoOf(s, s28);
      const ceil = bidCeiling(c, e, s, s28);
      const lowMargin = p?.marginPct != null && p.marginPct < ctx.marginFloorPct;
      const cm = ctx.comps.get(it.sku);
      const compCheaper = !!cm && cm.ourBuyer != null && cm.median != null && cm.ourBuyer >= cm.median * 1.08;
      const compOut = !!cm && cm.total > 0 && cm.outOfStock === cm.total;
      const bench = ctx.benchDrr.get(it.sku) ?? null;
      const benchText = bench != null ? ` (медиана категории ${Math.round(bench * 10) / 10}%)` : '';

      // Что проверено и чего не хватает — в карточку предложения.
      const checks: string[] = [];
      const missing: string[] = [];
      if (p) checks.push(`все заказы товара за 7 дн: ${num0(p.orders)} шт на ${rub(p.revenue)}, из них из рекламы ${num0(p.advOrders)}`);
      else missing.push('все заказы товара (товара нет в РНП)');
      if (e) checks.push(`допустимая цена заказа ${rub(e.allowedCpo)} = ${e.how}; прибыль товара за 7 дн после всей рекламы ${rub(e.profit)}`);
      else missing.push('маржа товара — нет себестоимости или цены (лист «Цены», «Склад»)');
      if (s) checks.push(`реклама в кампании за 7 дн: ${num0(s.views)} показов, ${num0(s.clicks)} кликов, ${num0(s.carts)} корзин, ${s.orders} заказов, ${rub(s.spend)}${s.cpo != null ? `, заказ ${rub(s.cpo)}` : ''}`);
      if (s28 && s28.clicks > (s?.clicks ?? 0)) checks.push(`за 28 дн: ${num0(s28.clicks)} кликов, ${s28.orders} заказов${s28.cpo != null ? `, заказ ${rub(s28.cpo)}` : ''}`);
      if (dos != null) checks.push(`запас на складах ${dos} дн`);
      if (cause) checks.push(`слабое звено: ${cause.text}`);
      const task = (rule: string, level: Draft['level'], title: string, reason: string, d: Partial<Ads2ProposalDetails> = {}) => out.push({
        mp, campaignId: c.id, sku: it.sku, kind: 'task', placement: null, fromValue: null, toValue: null,
        rule, level, title, reason, fp: `${campFp}|${it.sku}|task`, details: det({ checks, missing, ...d }),
      });

      // Проверка 1. Данные достоверны?
      if (e && e.allowedCpo > 0 && cpo && cpo.cpo > e.allowedCpo * ANOMALY_X) {
        task('data_check', 'warn', 'Сначала проверить данные — расчёт похож на ошибку',
          `Рекламный заказ ${rub(cpo.cpo)} в ${Math.round(cpo.cpo / e.allowedCpo)} раз дороже допустимого ${rub(e.allowedCpo)} (${e.how}). Такой разрыв чаще бывает от ошибки в себестоимости, цене или привязке заказа к товару, чем от рекламы. Ставку автоматически не меняем, пока расчёт не проверен`,
          { confidence: 'low', alternative: 'если данные верны — снижать ставку шагами с замером через 3 дня', risk: 'решение на ошибочной марже срежет прибыльную рекламу' });
        return;
      }
      // Проверка 2. Товар доступен?
      if (p && s && s.spend > 0 && (p.stock === 0 || (dos != null && dos < 3))) {
        task('stock_out', 'critical', 'Исключить товар из кампании до поставки',
          `${p.stock === 0 ? 'Остатка к продаже нет' : `Остатка на ${dos} дн`} (FBO ${p.stockFbo ?? 0}, FBS ${p.stockFbs ?? 0}) — реклама тратит деньги на спрос, которого нечем закрыть. Снижение ставки или бюджета причину не решает: исключите товар из кампании в кабинете и верните после поставки`,
          { confidence: 'high', alternative: 'если поставка придёт за 1–2 дня — оставить, но ставку не повышать', risk: 'вернуть товар в кампанию сразу после поставки, иначе он потеряет позиции', rollback: 'вернуть в кампанию в день поступления на склад' });
        return;
      }
      const noRaise = dos != null && dos < 14;

      let dir: 'down' | 'up' | null = null;
      let factor = 1;
      let rule = '';
      let level: Draft['level'] = 'warn';
      let why = '';
      let confidence: Ads2ProposalDetails['confidence'] = 'medium';
      let alternative: string | null = null;
      let risk: string | null = null;
      let rollback: string | null = 'вернуть прежнюю ставку, если прибыль товара (все заказы) за 3 дня упала';

      if (s && s.spend >= 500 && s.orders === 0) {
        // Проверка 3. Статистики достаточно?
        const cr0 = ctx.skuCr.get(it.sku) ?? baseCr;
        const p0 = zeroOrdersChance(s.clicks, cr0);
        checks.push(`ноль заказов при ${num0(s.clicks)} кликах: при обычной конверсии ${r2(cr0 * 100)}% вероятность такого нуля ${pctS(p0)}`);
        if (p0 > P0_MAX) {
          task('too_early', 'info', 'Пауза и снижение пока не обоснованы',
            `За 7 дней ${rub(s.spend)} и ${num0(s.clicks)} кликов без рекламных заказов, но при обычной конверсии ${r2(cr0 * 100)}% такой ноль бывает в ${pctS(p0)} случаев — выборка мала. Сохранить настройки до ~${clicksForSignal(cr0)} кликов${cause ? `; уже сейчас проверить ${cause.text}` : ''}`,
            { confidence: 'low', alternative: 'ограниченный тест: дневной лимит вместо паузы', risk: 'пауза сейчас может срезать продажи, которые реклама ещё не успела показать', controlDays: 7 });
          return;
        }
        // Проверка 4. Экономика подтверждена?
        if (p && p.orders > 0 && e && e.profit > 0) {
          dir = 'down'; factor = 0.8; rule = 'no_direct_orders'; level = 'warn'; confidence = 'medium';
          why = `Реклама дала ${num0(s.clicks)} кликов без своих заказов (это уже значимо), но товар в плюсе: ${num0(p.orders)} заказов за 7 дн, прибыль после рекламы ${rub(e.profit)} — вклад рекламы в продажи не доказан. Ограниченный тест: ставка −20% на 3 дня, затем сравнить ВСЕ заказы товара`;
          alternative = cause ? `сначала исправить слабое звено: ${cause.text}` : 'оставить ставку и проверить поисковые запросы, по которым идут клики';
          risk = 'если реклама приводила покупателей в органику, все заказы товара упадут';
          rollback = 'вернуть ставку, если все заказы товара за 3 дня упали больше чем на 20%';
        } else {
          dir = 'down'; factor = 1 - MAX_DOWN; rule = 'spend_no_orders'; level = 'critical'; confidence = e ? 'high' : 'medium';
          why = `За 7 дней ${rub(s.spend)} и ${num0(s.clicks)} кликов без единого заказа${p ? (p.orders ? `; всего у товара ${num0(p.orders)} заказов${e ? `, прибыль после рекламы ${rub(e.profit)}` : ', маржа неизвестна'}` : ' — товар не продаётся и без рекламы') : ''}${cause ? `. Слабое звено: ${cause.text}` : ''}`;
          alternative = c.items.length === 1 && c.can.pause ? 'поставить кампанию на паузу' : 'убрать товар из кампании в кабинете';
          risk = 'потеря показов; вернуть позиции потом дороже';
        }
      } else if (e && e.allowedCpo <= 0 && s && s.spend > 0) {
        task('unprofitable', 'warn', 'Товару не из чего платить за рекламу',
          `Маржа до рекламы ${rub(e.marginBeforeAds)} не покрывает план прибыли ${e.planPct}% — любая реклама уводит товар ниже плана. Сначала цена или себестоимость; ставку не повышать`,
          { confidence: 'medium', alternative: 'если товар нужен для оборота или позиций — держать минимальную ставку осознанно', risk: 'резкое отключение рекламы роняет позиции и органические продажи' });
        return;
      } else if (e && cpo && cpo.cpo > e.allowedCpo * 1.05 && p && p.drr != null && e.allowedDrr != null && p.drr <= e.allowedDrr && e.profit > 0) {
        // Общий ДРР — полезная проверка (разбор менеджера): дорогой рекламный заказ, но по товару в целом реклама
        // в пределах экономики и товар в плюсе — реклама, вероятно, тянет и органические заказы. Не режем.
        task('cpo_high_total_ok', 'info', 'Рекламный заказ дорогой, но товар в целом в плюсе — ставку не снижаем',
          `Заказ из рекламы ${rub(cpo.cpo)} дороже допустимого ${rub(e.allowedCpo)}, но общий ДРР товара ${p.drr}% при допустимом ${e.allowedDrr}%, прибыль после всей рекламы ${rub(e.profit)}. Реклама, вероятно, приводит и органические заказы — снижение может их срезать${cause ? `. Слабое звено: ${cause.text}` : ''}`,
          { confidence: 'medium', alternative: 'ограниченный тест: ставка −15% на 3 дня и сравнить все заказы товара', risk: 'если органика не связана с рекламой, переплачиваем за рекламные заказы', controlDays: 7 });
        return;
      } else if (e && cpo && cpo.cpo > e.allowedCpo * 1.05) {
        dir = 'down'; rule = 'above_allowed_cpo'; factor = clampDown(e.allowedCpo / cpo.cpo);
        confidence = cpo.orders >= 5 ? 'high' : 'medium';
        why = `Рекламный заказ стоит ${rub(cpo.cpo)} (${cpo.days} дн, ${cpo.orders} заказов) — дороже допустимого ${rub(e.allowedCpo)}: ${e.how}. Ставку снижаем пропорционально разрыву${cause ? `; слабое звено: ${cause.text}` : ''}`;
        alternative = cause ? `исправить слабое звено воронки и оставить ставку` : null;
        risk = 'меньше показов — часть заказов уйдёт к конкурентам';
      } else if (!e && s && s.drr != null && s.drr > Math.max(target * 2, bench != null ? bench * 1.5 : 0) && s.spend >= 300) {
        task('drr_no_margin', 'info', 'ДРР выше ориентира — нужна экономика товара',
          `ДРР по рекламе ${s.drr}% при ориентире ${target}%${benchText}, но маржи товара нет — снижать ставку только по общему порогу не будем. Заполните себестоимость, и автопилот посчитает допустимую цену заказа`,
          { confidence: 'low' });
        return;
      } else if (overBudget && e?.allowedDrr != null && s && s.drr != null && s.drr > Math.max(target, e.allowedDrr) && s.spend >= 300) {
        dir = 'down'; rule = 'over_budget'; factor = clampDown(Math.max(target, e.allowedDrr) / s.drr);
        why = `Площадка тратит ${ov.budget.drrPct}% от заказов при бюджете ${target}%; у товара ДРР ${s.drr}% — выше и бюджета, и допустимого для него ${e.allowedDrr}%`;
        risk = 'меньше показов — часть заказов уйдёт к конкурентам';
      } else if (ceil && slots.some(sl => sl.bid > ceil.max * 1.15)) {
        dir = 'down'; rule = 'above_bid_ceiling'; factor = 1 - MAX_DOWN;
        why = `Ставка выше потолка ${rub(ceil.max)}: ${ceil.how}`;
        risk = 'меньше показов в верхних позициях';
      } else if (!overBudget && e && cpo && cpo.orders >= 3 && cpo.cpo < e.allowedCpo * 0.6 && !noRaise && !lowMargin) {
        if (cause) {
          task(cause.stage, 'info', 'Сначала поправить карточку, потом поднимать рекламу',
            `Реклама окупается (заказ ${rub(cpo.cpo)} при допустимом ${rub(e.allowedCpo)}), но ${cause.text}`, { confidence: 'medium' });
          return;
        }
        if (compCheaper && cm) {
          task('comp_cheaper', 'info', 'Сначала цена: конкуренты дешевле, ставку не поднимаем',
            `Реклама окупается (заказ ${rub(cpo.cpo)}), но наша цена покупателю ${rub(cm.ourBuyer!)} против медианы ${cm.total} конкурентов ${rub(cm.median!)} (+${Math.round((cm.ourBuyer! / cm.median! - 1) * 100)}%) — поднятая ставка оплатит клики, которые уйдут к ним; рекомендация по цене — в «Советнике»`,
            { confidence: 'medium' });
          return;
        }
        dir = 'up'; rule = 'scale'; level = 'growth'; factor = clampUp(e.allowedCpo * 0.8 / cpo.cpo);
        confidence = cpo.orders >= 5 ? 'high' : 'medium';
        why = `Рекламный заказ ${rub(cpo.cpo)} при допустимом ${rub(e.allowedCpo)}, ${cpo.orders} заказов за ${cpo.days} дн, запас ${dos ?? '—'} дн — есть куда расти`;
        risk = 'цена заказа вырастет; следить, чтобы осталась в пределах допустимой';
        rollback = 'вернуть ставку, если цена заказа превысит допустимую или прибыль товара упадёт';
      } else if (compOut && cm && !overBudget && e && cpo && cpo.cpo <= e.allowedCpo && !noRaise && !lowMargin && !compCheaper) {
        dir = 'up'; rule = 'comp_out'; level = 'growth'; factor = 1.15;
        why = `У всех ${cm.total} подтверждённых конкурентов нет в наличии — окно: заказ ${rub(cpo.cpo)} в пределах допустимого, запас ${dos ?? '—'} дн`;
        risk = 'конкуренты могут вернуться в наличие в любой день';
        rollback = 'вернуть ставку, когда конкуренты вернутся в наличие';
      }

      if (!dir) return;
      if (rule === 'over_budget' && s?.drr != null) overBudgetDrr.set(`${campFp}|${it.sku}`, s.drr);
      const details = det({ checks, missing, confidence, alternative, risk, rollback });

      if (!slots.length) {
        // Ставку менять нельзя (стратегия Ozon, кампания за заказ) — снижения копим, решаем по кампании ниже.
        if (mp === 'ozon' && dir === 'down') budgetDown.push({ sku: it.sku, article: p?.article ?? it.article ?? it.sku, spend: s?.spend ?? 0, factor, why, rule, level });
        return;
      }
      for (const sl of slots) {
        if (rule === 'above_bid_ceiling' && ceil && sl.bid <= ceil.max * 1.15) continue;
        let next = sl.bid * factor;
        // К потолку ставки спускаемся, но не ниже самого потолка.
        if (rule === 'above_bid_ceiling' && ceil) next = Math.max(next, ceil.max);
        next = mp === 'wb' && c.payment === 'cpm' ? Math.round(next) : r2(next);
        if (dir === 'up' && next <= sl.bid) continue;
        if (dir === 'down' && next >= sl.bid) continue;
        const where = sl.placement === 'search' ? ' (поиск)' : sl.placement === 'recommendations' ? ' (рекомендации)' : '';
        const ch = Math.round((next / sl.bid - 1) * 100);
        out.push({
          mp, campaignId: c.id, sku: it.sku, kind: 'bid', placement: sl.placement, fromValue: sl.bid, toValue: next,
          rule, level, title: `${dir === 'up' ? 'Поднять' : 'Снизить'} ставку${where} ${rub(sl.bid)} → ${rub(next)} (${ch > 0 ? '+' : '−'}${Math.abs(ch)}%)`,
          reason: why, fp: `${campFp}|${it.sku}|bid|${sl.placement ?? ''}`, details,
        });
      }
    });

    // Ozon без ручной ставки: недельный бюджет режем, только если проблемные товары — большая часть расхода
    // кампании (≥ 60 %); иначе кампания с прибыльными товарами пострадает ради одного — даём задачу по товарам.
    if (budgetDown.length && c.can.weeklyBudget && c.weeklyBudget && c.weeklyBudget > 0 && settledCamp) {
      const total = cs?.spend ?? 0;
      const bad = budgetDown.reduce((t, b) => t + b.spend, 0);
      const share = total > 0 ? bad / total : 0;
      const checks = budgetDown.map(b => `${b.article}: ${b.why}`);
      if (share >= 0.6) {
        const f = clampDown(budgetDown.reduce((t, b) => t + b.factor * b.spend, 0) / (bad || 1));
        const next = r2(c.weeklyBudget * f);
        out.push({
          mp, campaignId: c.id, sku: null, kind: 'weekly_budget', placement: null, fromValue: c.weeklyBudget, toValue: next,
          rule: budgetDown[0].rule, level: budgetDown.some(b => b.level === 'critical') ? 'critical' : 'warn',
          title: `Снизить недельный бюджет ${rub(c.weeklyBudget)} → ${rub(next)} (−${Math.round((1 - f) * 100)}%)`,
          reason: `${budgetDown.length === 1 ? budgetDown[0].why : `У ${budgetDown.length} товаров кампании реклама выходит за экономику`} — это ${Math.round(share * 100)}% расхода кампании. Ставку ведёт Ozon (${c.bidType ?? 'стратегия'}), поэтому сдерживаем бюджетом`,
          fp: `${campFp}|weekly_budget`,
          details: det({ checks, missing: [], confidence: 'medium', alternative: 'вынести проблемные товары в отдельную кампанию', risk: 'бюджет ограничит и нормальные товары кампании', rollback: 'вернуть бюджет, если прибыль товаров кампании за 3 дня упала' }),
        });
      } else {
        out.push({
          mp, campaignId: c.id, sku: null, kind: 'task', placement: null, fromValue: null, toValue: null,
          rule: 'mixed_campaign', level: 'warn', title: 'Убыточные товары в прибыльной кампании — разделить',
          reason: `В кампании ${budgetDown.map(b => b.article).join(', ')} выходят за экономику, но это только ${Math.round(share * 100)}% её расхода — урезать бюджет всей кампании ради них не будем. Уберите эти товары из кампании или вынесите в отдельную`,
          fp: `${campFp}|mixed`,
          details: det({ checks, missing: [], confidence: 'medium', risk: 'без разделения убыточные товары продолжат тратить общий бюджет' }),
        });
      }
    }
  }

  // 4. Кандидаты на новую кампанию — только совет.
  for (const p of ov.products) {
    if (p.issues.some(x => x.code === 'no_ads_opportunity') && p.adSku) {
      out.push({
        mp, campaignId: null, sku: p.adSku, kind: 'new_campaign', placement: null, fromValue: null, toValue: null,
        rule: 'no_ads_opportunity', level: 'info', title: 'Кандидат на рекламную кампанию',
        reason: `${p.orders} заказов за 7 дней без рекламы, запас ${p.daysOfStock ?? '—'} дн${p.marginPct != null ? `, маржа ${p.marginPct}%` : ''} — решает менеджер`,
        fp: `${mp}||${p.adSku}|new_campaign`,
        details: det({ checks: [`заказов за 7 дн ${p.orders}, запас ${p.daysOfStock ?? '—'} дн`, ...(p.econ ? [`допустимая цена заказа ${rub(p.econ.allowedCpo)}`] : [])],
          missing: p.econ ? [] : ['маржа товара'], confidence: 'medium', risk: 'реклама может забрать часть органических заказов' }),
      });
    }
  }
  // «Сначала худший ДРР»: при перерасходе площадки снижаем за проход только OVER_BUDGET_TOP товаров с худшим ДРР —
  // остальные дойдут в следующие проходы, когда замерим эффект (а не всё подряд одним махом).
  if (overBudgetDrr.size > OVER_BUDGET_TOP) {
    const keep = new Set([...overBudgetDrr.entries()].sort((a, b) => b[1] - a[1]).slice(0, OVER_BUDGET_TOP).map(([k]) => k));
    for (let i = out.length - 1; i >= 0; i--) {
      const p = out[i];
      if (p.rule === 'over_budget' && p.sku && !keep.has(`${mp}|${p.campaignId}|${p.sku}`)) out.splice(i, 1);
    }
  }
  return out.sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]);
}

/** Контекст этапа В по площадке: край маржи, конкуренты с витрины, нормы ДРР категорий Ozon. */
export async function buildCtx(mp: AdMp, ov: Ads2Overview): Promise<AutopilotCtx> {
  const ctx: AutopilotCtx = { ...EMPTY_CTX, marginFloorPct: marginThresholds(mp).floor, comps: new Map(), benchDrr: new Map(), stat28: new Map(), skuCr: new Map() };
  // 28 дней «кампания × товар»: сравнение с 7 днями, конверсия для редких заказов, медианы воронки.
  try {
    const rows = campaignStats(mp, mskDate(27), mskDate(0), true);
    const bySku = new Map<string, { clicks: number; orders: number }>();
    for (const r of rows) {
      if (!r.sku) continue;
      const st = toStat(r);
      if (st) ctx.stat28.set(`${r.campaign_id}|${r.sku}`, st);
      const a = bySku.get(r.sku) ?? { clicks: 0, orders: 0 };
      a.clicks += r.clicks; a.orders += r.orders; bySku.set(r.sku, a);
    }
    for (const [sku, a] of bySku) if (a.clicks >= 50 && a.orders >= 1) ctx.skuCr.set(sku, a.orders / a.clicks);
    ctx.bench = funnelBench([...ctx.stat28.values()]);
  } catch { /* без 28 дней правила работают по 7 дням */ }
  const up = (s: unknown) => String(s ?? '').trim().toUpperCase();
  try {
    const margins = await getMargins(mp).catch(() => null);
    const links = getAllLinks(mp);
    const ids = new Set<string>();
    for (const ls of Object.values(links)) for (const l of ls) if (l.status === 'active') ids.add(String(l.nmId));
    const hist = cardHistory(mp, [...ids]);
    const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
    for (const p of ov.products) {
      if (!p.adSku) continue;
      const art = up(mp === 'wb' ? p.article : p.key);
      const comps = (links[art] ?? []).filter(l => l.status === 'active').map(l => hist.get(String(l.nmId))).filter(Boolean) as { price: number | null; stock: number | null }[];
      if (!comps.length) continue;
      const prices = comps.filter(c => c.price != null && c.price > 0 && c.stock !== 0).map(c => c.price!);
      const mr = margins?.items[art];
      ctx.comps.set(p.adSku, {
        ourBuyer: mr?.buyer ?? p.price ?? null, prices, total: comps.length, outOfStock: comps.filter(c => c.stock === 0).length,
        median: prices.length ? median(prices) : null, min: prices.length ? Math.min(...prices) : null,
      });
    }
  } catch { /* без конкурентов правила работают как раньше */ }
  if (mp === 'ozon') {
    try {
      for (const cat of getCompetitors('ozon').ozon?.categories ?? []) {
        if (cat.benchmark.drr == null) continue;
        for (const o of cat.ours) if (o.sku) ctx.benchDrr.set(String(o.sku), cat.benchmark.drr);
      }
    } catch { /* снимка рынка нет */ }
  }
  return ctx;
}

// ─── Хранение предложений ───────────────────────────────────────────────────

/**
 * Записать свежие предложения площадки. На один предмет (fp) — одно открытое
 * предложение: то же самое — обновляем текст, другое значение — старое
 * «устарело», новое пишем. Открытые, которых в свежем наборе нет, — закрываем.
 */
export function saveProposals(mp: AdMp, drafts: Draft[]): { added: number; kept: number; closed: number } {
  const d = db();
  const now = Date.now();
  const open = d.prepare(`SELECT id, fp, to_value FROM ad_proposal WHERE mp = ? AND status = 'pending'`).all(mp) as any[];
  const byFp = new Map(open.map(r => [r.fp, r]));
  // Отклонённое не предлагаем снова 3 дня; принятый совет без команды — 7 дней.
  const quiet = new Set((d.prepare(`SELECT fp FROM ad_proposal WHERE mp = ? AND (
      (status = 'rejected' AND decided_at >= ?) OR (status = 'applied' AND kind IN ('task', 'new_campaign') AND decided_at >= ?))`)
    .all(mp, now - REJECT_QUIET_MS, now - ADVICE_QUIET_MS) as any[]).map(r => r.fp));
  const seen = new Set<string>();
  const ins = d.prepare(`INSERT INTO ad_proposal (created_at, updated_at, mp, campaign_id, sku, kind, placement, from_value, to_value, rule, level, title, reason, fp, status, details)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`);
  const touch = d.prepare(`UPDATE ad_proposal SET updated_at = ?, from_value = ?, title = ?, reason = ?, rule = ?, level = ?, details = ? WHERE id = ?`);
  const close = d.prepare(`UPDATE ad_proposal SET status = ?, decided_at = ?, decided_by = 'autopilot' WHERE id = ?`);
  let added = 0, kept = 0, closed = 0;
  d.exec('BEGIN');
  try {
    for (const p of drafts) {
      if (seen.has(p.fp) || quiet.has(p.fp)) continue;
      seen.add(p.fp);
      const cur = byFp.get(p.fp);
      if (cur && (cur.to_value ?? null) === (p.toValue ?? null)) {
        touch.run(now, p.fromValue, p.title, p.reason, p.rule, p.level, p.details ? JSON.stringify(p.details) : null, cur.id);
        kept++;
        continue;
      }
      if (cur) { close.run('superseded', now, cur.id); closed++; }
      ins.run(now, now, mp, p.campaignId, p.sku, p.kind, p.placement, p.fromValue, p.toValue, p.rule, p.level, p.title, p.reason, p.fp, p.details ? JSON.stringify(p.details) : null);
      added++;
    }
    for (const r of open) if (!seen.has(r.fp)) { close.run('expired', now, r.id); closed++; }
    d.exec('COMMIT');
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
  return { added, kept, closed };
}

let running: Promise<string> | null = null;

/** Пересчитать предложения по обеим площадкам. */
export function runAutopilot(): Promise<string> {
  if (running) return running;
  running = (async () => {
    const { mode } = getAutopilotMode();
    if (mode === 'off') return 'выключен';
    const out: string[] = [];
    for (const mp of ['wb', 'ozon'] as AdMp[]) {
      try {
        const ov = await getAdsOverview(mp, 7);
        const r = saveProposals(mp, buildProposals(ov, await buildCtx(mp, ov)));
        out.push(`${mp}: новых ${r.added}, без изменений ${r.kept}, закрыто ${r.closed}`);
      } catch (e) {
        out.push(`${mp}: ошибка ${(e as Error).message}`);
      }
    }
    adsMetaSet('autopilot:last_run', JSON.stringify({ at: Date.now(), result: out }));
    return out.join(' · ');
  })().finally(() => { running = null; });
  return running;
}

// ─── Список, решение, замер ─────────────────────────────────────────────────

const addDays = (d: string, n: number) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86_400_000).toISOString().slice(0, 10);

/** Замер эффекта: 3 дня до решения против дней после (не больше 3), по статистике кампании × товара. */
function effectOf(r: any): Ads2Proposal['effect'] {
  if (r.status !== 'applied' || !r.decided_at || !r.campaign_id) return null;
  const d = adsDb();
  if (!d) return null;
  const day = new Date(r.decided_at + 3 * 3600_000).toISOString().slice(0, 10);
  const today = mskDate(0);
  const afterFrom = addDays(day, 1);
  if (afterFrom >= today) return { days: 0, before: null, after: null, verdict: null, verdictText: null };
  const afterTo = [addDays(day, 3), addDays(today, -1)].sort()[0];
  const q = (from: string, to: string) => d.prepare(`SELECT ROUND(SUM(spend), 2) AS spend, ROUND(SUM(orders), 1) AS orders, ROUND(SUM(revenue), 2) AS revenue, COUNT(DISTINCT date) AS days
      FROM ad_stat_day WHERE mp = ? AND campaign_id = ? ${r.sku ? 'AND sku = ?' : ''} AND date >= ? AND date <= ?`)
    .get(...[r.mp, r.campaign_id, ...(r.sku ? [r.sku] : []), from, to]) as any;
  const norm = (x: any) => (x && x.days ? { spend: x.spend ?? 0, orders: x.orders ?? 0, drr: x.revenue > 0 ? r2((x.spend / x.revenue) * 100) : null, perDay: r2((x.spend ?? 0) / x.days), ordersPerDay: r2((x.orders ?? 0) / x.days), days: x.days as number } : null);
  const after = norm(q(afterFrom, afterTo));
  const before = norm(q(addDays(day, -3), addDays(day, -1)));
  // Вывод (22.10.2026, «контроль и откат»): хуже — заказов в день меньше на 40%+ при расходе не ниже 80%
  // прежнего, или ДРР вырос на 25%+. Лучше — ДРР снизился на 15%+ без потери заказов.
  let verdict: 'better' | 'worse' | 'neutral' | null = null;
  let verdictText: string | null = null;
  if (before && after && (after.days ?? 0) >= 2) {
    const lostOrders = before.ordersPerDay > 0 && after.ordersPerDay < before.ordersPerDay * 0.6 && after.perDay >= before.perDay * 0.8;
    const drrUp = before.drr != null && after.drr != null && after.drr > before.drr * 1.25;
    const drrDown = before.drr != null && after.drr != null && after.drr < before.drr * 0.85 && after.ordersPerDay >= before.ordersPerDay * 0.9;
    if (lostOrders || drrUp) { verdict = 'worse'; verdictText = `Стало хуже (${lostOrders ? 'заказов в день меньше при том же расходе' : `ДРР ${before.drr}% → ${after.drr}%`}) — рекомендуем откатить${r.from_value != null ? ` к ${rub(r.from_value)}` : ''}`; }
    else if (drrDown) { verdict = 'better'; verdictText = 'Стало лучше: ДРР ниже без потери заказов'; }
    else { verdict = 'neutral'; verdictText = 'Заметной разницы нет'; }
  }
  return { days: after?.days ?? 0, before, after, verdict, verdictText };
}

export async function listProposals(mp: AdMp | null, history = false): Promise<Ads2Proposal[]> {
  const d = db();
  const rows = d.prepare(`SELECT * FROM ad_proposal WHERE ${history ? `status NOT IN ('pending', 'superseded', 'expired')` : `status = 'pending' AND updated_at >= ?`}
      ${mp ? 'AND mp = ?' : ''} ORDER BY ${history ? 'decided_at DESC' : 'created_at DESC'} LIMIT 300`)
    .all(...(history ? [] : [Date.now() - EXPIRE_MS]), ...(mp ? [mp] : [])) as any[];
  // Имена кампаний и товаров — из снимка кампаний.
  const names = new Map<string, string>();
  const items = new Map<string, any>();
  for (const r of rows) {
    if (!r.campaign_id) continue;
    const k = `${r.mp}|${r.campaign_id}`;
    if (names.has(k)) continue;
    const c = getCampaign(r.mp, r.campaign_id);
    names.set(k, c?.name || `Кампания ${r.campaign_id}`);
    for (const it of c?.items ?? []) items.set(`${k}|${it.sku}`, it);
  }
  const list = rows.map((r): Ads2Proposal => ({
    id: r.id, createdAt: r.created_at, mp: r.mp, campaignId: r.campaign_id, sku: r.sku,
    campaignName: r.campaign_id ? names.get(`${r.mp}|${r.campaign_id}`) ?? null : null,
    productName: r.campaign_id && r.sku ? items.get(`${r.mp}|${r.campaign_id}|${r.sku}`)?.title ?? null : null,
    article: null, photo: null,
    kind: r.kind, placement: r.placement, fromValue: r.from_value, toValue: r.to_value,
    rule: r.rule, level: r.level, title: r.title, reason: r.reason, fp: r.fp,
    status: r.status, decidedAt: r.decided_at, decidedBy: r.decided_by, note: r.note,
    result: r.result ? JSON.parse(r.result) : null,
    details: r.details ? JSON.parse(r.details) : null,
    effect: history ? effectOf(r) : null,
  }));
  if (!history) list.sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] || b.createdAt - a.createdAt);
  return list;
}

const ACTIONABLE: Ads2ProposalKind[] = ['bid', 'pause', 'daily_limit', 'weekly_budget'];

// Предложения, которые сейчас применяются. Статус «applied» ставится только после
// ответа площадки, и двойной клик «Применить» успевал отправить команду дважды
// (прожарка 20.10.2026). На process — из-за двух копий модуля под tsx.
const inFlight: Set<number> = ((process as any).__AV_PROPOSAL_INFLIGHT__ ??= new Set<number>());

export async function decideProposal(id: number, decision: 'apply' | 'reject', by: string, note: string | null, confirmBig = false)
  : Promise<{ ok: boolean; message: string; needConfirm?: boolean }> {
  if (inFlight.has(id)) return { ok: false, message: 'это предложение уже применяется — подождите несколько секунд' };
  inFlight.add(id);
  try { return await decideProposalOnce(id, decision, by, note, confirmBig); }
  finally { inFlight.delete(id); }
}

async function decideProposalOnce(id: number, decision: 'apply' | 'reject', by: string, note: string | null, confirmBig: boolean)
  : Promise<{ ok: boolean; message: string; needConfirm?: boolean }> {
  const d = db();
  const r = d.prepare('SELECT * FROM ad_proposal WHERE id = ?').get(id) as any;
  if (!r) return { ok: false, message: 'предложение не найдено' };
  if (r.status !== 'pending') return { ok: false, message: 'предложение уже закрыто — обновите список' };
  const now = Date.now();
  const set = (status: string, extra: { log_id?: number | null; result?: unknown } = {}) =>
    d.prepare('UPDATE ad_proposal SET status = ?, decided_at = ?, decided_by = ?, note = ?, log_id = ?, result = ? WHERE id = ?')
      .run(status, now, by, note, extra.log_id ?? null, extra.result === undefined ? null : JSON.stringify(extra.result), id);

  if (decision === 'reject' || !ACTIONABLE.includes(r.kind)) {
    // Советы без команды (задача команде, новая кампания) «принимаются» — фиксируем, что прочитано.
    const status = decision === 'reject' ? 'rejected' : 'applied';
    const logId = logChange({ mp: r.mp, campaign_id: r.campaign_id, sku: r.sku, actor: 'manager', action: `proposal_${r.kind}`,
      after: { proposal: id, title: r.title }, reason: note ?? r.reason, status: decision === 'reject' ? 'rejected' : 'applied' });
    set(status, { log_id: logId });
    return { ok: true, message: decision === 'reject' ? 'отклонено' : 'принято к сведению' };
  }

  // Предложение строилось по снимку — если ставка/бюджет с тех пор изменились, не применяем вслепую.
  const c = getCampaign(r.mp, r.campaign_id);
  if (!c) { set('failed', { result: { error: 'кампании нет' } }); return { ok: false, message: 'кампания не найдена' }; }
  if (r.kind === 'bid' && r.from_value != null) {
    const it = c.items.find(x => x.sku === r.sku);
    const cur = !it ? null : r.mp === 'ozon' ? (it.bid_raw == null ? null : Number(it.bid_raw) / 1_000_000)
      : (r.placement === 'recommendations' ? it.bid_reco_kop : it.bid_search_kop) == null ? null
        : (r.placement === 'recommendations' ? it.bid_reco_kop! : it.bid_search_kop!) / 100;
    if (cur == null || Math.abs(cur - r.from_value) > 0.01) {
      set('superseded', { result: { error: `ставка уже ${cur == null ? 'другая' : rub(cur)}` } });
      return { ok: false, message: `ставка уже изменилась (${cur == null ? '—' : rub(cur)}), предложение снято — дождитесь пересчёта` };
    }
  }

  const a: AdAction = {
    mp: r.mp, campaignId: r.campaign_id, kind: r.kind, sku: r.sku ?? undefined,
    placement: r.placement ?? undefined, valueRub: r.to_value ?? undefined, enabled: r.kind === 'daily_limit' ? true : undefined,
    confirmBig, reason: `Автопилот #${id}, подтвердил ${by}: ${r.reason}`,
  };
  const res = await applyAdAction(a, 'autopilot');
  if (res.needConfirm) return { ok: false, message: res.message, needConfirm: true };
  set(res.ok ? 'applied' : 'failed', { log_id: res.logId, result: { message: res.message } });
  return { ok: res.ok, message: res.message };
}

export async function autopilotState(): Promise<Ads2AutopilotState> {
  const m = getAutopilotMode();
  let last: Ads2AutopilotState['lastRun'] = null;
  try { last = JSON.parse(adsMetaGet('autopilot:last_run') ?? 'null'); } catch { last = null; }
  const d = db();
  const counts = d.prepare(`SELECT status, COUNT(*) AS n FROM ad_proposal WHERE created_at >= ? GROUP BY status`).all(Date.now() - 14 * 86_400_000) as any[];
  return { ...m, lastRun: last, counts14d: Object.fromEntries(counts.map(c => [c.status, c.n])), expireHours: EXPIRE_MS / 3600_000 };
}
