/**
 * Автопилот рекламы — этап 2 «советник» (14.10.2026).
 *
 * Раз в проход цепочки обновлений сервера (после РНП) и по кнопке смотрит на
 * кампании и товары за последние 7 дней и готовит ПРЕДЛОЖЕНИЯ. Сам ничего не
 * меняет: решение владельца 13.10 — первые 2 недели только «с подтверждением».
 * Менеджер нажимает «Применить» (команда уходит через actions.ts, как ручная)
 * или «Отклонить» (пишется в журнал с причиной).
 *
 * Правила (docs/ads-system/ПРОЕКТ_РЕКЛАМА_2026-10-13.md, «Автопилот»):
 *   • бюджет площадки = 5% от заказов; если площадка тратит больше — ставки
 *     только снижаем, начиная с худшего ДРР;
 *   • потолок цены заказа maxCPO = 40% маржи товара в рублях;
 *     для оплаты за клик maxCPC = maxCPO × конверсия клика в заказ;
 *   • шаг изменения ±15%, после изменения товара ждём 24 ч замера;
 *   • остаток < 7 дн — ставку вниз, < 3 дн — кампанию на паузу (если в ней
 *     все товары такие), ставки не поднимаем;
 *   • расход без заказов, ДРР > 2× нормы — ставку вниз;
 *   • ставку вверх — только когда ДРР ниже 60% нормы, есть заказы, запас ≥ 14 дн,
 *     маржа не низкая и узкое место НЕ в карточке/корзине (иначе — задача команде);
 *   • товары «Не рекламировать» не трогаем; если реклама по ним идёт — предлагаем паузу;
 *   • новые кампании — только совет, решает менеджер.
 */
import { adsDb, adsMetaGet, adsMetaSet, getCampaign, logChange, type AdMp } from './store';
import { applyAdAction, type AdAction } from './actions';
import { getAdsOverview } from './overview';
import { mskDate } from '../mskDate';
import {
  ADS_BUDGET_SHARE,
  type Ads2Overview, type Ads2Campaign, type Ads2CampaignItem, type Ads2Product,
  type Ads2Proposal, type Ads2ProposalKind, type Ads2AutopilotState, type Ads2AutopilotMode,
} from '../../../shared/ads2';

export const STEP = 0.15;
const MARGIN_SHARE = 0.4;
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

/**
 * Потолок цены заказа из маржи. Сравниваем с ФАКТИЧЕСКОЙ ценой рекламного заказа
 * (расход / заказы) — она уже учитывает и CTR, и конверсию, и то, сколько
 * площадка реально списала, а не только ставку. Нужно хотя бы 2 заказа.
 */
function cpoCheck(it: Ads2CampaignItem, p: Ads2Product | undefined): { cpo: number; max: number } | null {
  const s = it.stat;
  if (!p?.marginRub || p.marginRub <= 0 || !s || s.orders < 2) return null;
  return { cpo: r2(s.spend / s.orders), max: r2(p.marginRub * MARGIN_SHARE) };
}

export function buildProposals(ov: Ads2Overview): Draft[] {
  const mp = ov.mp;
  const out: Draft[] = [];
  const target = ADS_BUDGET_SHARE * 100;
  const overBudget = ov.budget.drrPct != null && ov.budget.drrPct > target * 1.1;
  const prodByAd = new Map(ov.products.filter(p => p.adSku).map(p => [p.adSku!, p]));

  for (const c of ov.campaigns) {
    if (!isActive(c) || !c.items.length) continue;
    const prods = c.items.map(it => prodByAd.get(it.sku));
    const campFp = `${mp}|${c.id}`;
    const settledCamp = !recentlyChanged(mp, c.id, null);

    // 1. Пауза всей кампании: все её товары «Не рекламировать» или кончаются.
    const allFlagged = c.items.every(it => it.noAds);
    const allOut = prods.every(p => p && p.daysOfStock != null && p.daysOfStock < 3);
    const cs = c.stat ?? sumItemStats(c);
    const burning = cs && cs.spend >= 1500 && cs.orders === 0 && cs.clicks >= 50;
    if (c.can.pause && settledCamp && (allFlagged || allOut || burning)) {
      out.push({
        mp, campaignId: c.id, sku: null, kind: 'pause', placement: null, fromValue: null, toValue: null,
        rule: allFlagged ? 'flagged' : allOut ? 'stock_out' : 'spend_no_orders', level: 'critical',
        title: 'Поставить кампанию на паузу',
        reason: allFlagged ? 'Все товары кампании отмечены «Не рекламировать», а реклама идёт'
          : allOut ? 'У всех товаров кампании остатка меньше чем на 3 дня — реклама разгонит спрос, которого нечем закрыть'
            : `За 7 дней расход ${rub(cs!.spend)} и ${cs!.clicks} кликов — ни одного заказа`,
        fp: `${campFp}|pause`,
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
      });
    }

    // 3. Ставки по товарам.
    c.items.forEach((it, i) => {
      const p = prods[i];
      if (it.noAds) {
        out.push({
          mp, campaignId: c.id, sku: it.sku, kind: 'task', placement: null, fromValue: null, toValue: null,
          rule: 'flagged', level: 'warn', title: 'Убрать товар из кампании',
          reason: 'Товар отмечен «Не рекламировать», а кампания активна — уберите его из кампании в кабинете', fp: `${campFp}|${it.sku}|flagged`,
        });
        return;
      }
      if (recentlyChanged(mp, c.id, it.sku)) return;
      const slots = bidSlots(c, it);
      const s = it.stat;
      const cpo = cpoCheck(it, p);
      const funnelIssue = p?.issues.find(x => x.code === 'card_to_cart' || x.code === 'cart_to_order');
      const lowMargin = p?.marginPct != null && p.marginPct < 15;
      const dos = p?.daysOfStock ?? null;

      let dir: 'down' | 'up' | null = null;
      let rule = '';
      let level: Draft['level'] = 'warn';
      let why = '';
      if (dos != null && dos < 7 && s && s.spend > 0) {
        dir = 'down'; rule = 'stock_low'; level = dos < 3 ? 'critical' : 'warn';
        why = `Остатка на ${dos} дн — сдерживаем рекламу до поставки`;
      } else if (s && s.spend >= 500 && s.orders === 0) {
        dir = 'down'; rule = 'spend_no_orders'; level = 'critical';
        why = `За 7 дней расход ${rub(s.spend)} без заказов`;
      } else if (s && s.drr != null && s.drr > target * 2 && s.spend >= 300) {
        dir = 'down'; rule = 'drr_high';
        why = `ДРР по рекламе ${s.drr}% — больше чем вдвое выше нормы ${target}%`;
      } else if (overBudget && s && s.drr != null && s.drr > target && s.spend >= 300) {
        dir = 'down'; rule = 'over_budget';
        why = `Площадка тратит ${ov.budget.drrPct}% от заказов при норме ${target}%; у товара ДРР ${s.drr}%`;
      } else if (cpo && cpo.cpo > cpo.max * 1.05) {
        dir = 'down'; rule = 'above_ceiling';
        why = `Рекламный заказ стоит ${rub(cpo.cpo)} — дороже потолка ${rub(cpo.max)} (40% маржи)`;
      } else if (!overBudget && s && s.orders >= 3 && s.drr != null && s.drr < target * 0.6
                 && (dos == null || dos >= 14) && !lowMargin && (!cpo || cpo.cpo * (1 + STEP) <= cpo.max)) {
        if (funnelIssue) {
          out.push({
            mp, campaignId: c.id, sku: it.sku, kind: 'task', placement: null, fromValue: null, toValue: null,
            rule: funnelIssue.code, level: 'info', title: 'Сначала поправить карточку, потом поднимать рекламу',
            reason: `Реклама окупается (ДРР ${s.drr}%), но: ${funnelIssue.text}`, fp: `${campFp}|${it.sku}|task`,
          });
          return;
        }
        dir = 'up'; rule = 'scale'; level = 'growth';
        why = `ДРР ${s.drr}% при норме ${target}%, ${s.orders} заказов за 7 дней, запас ${dos ?? '—'} дн — есть куда расти`;
      }

      if (!dir) return;

      if (!slots.length) {
        // Ставку менять нельзя (стратегия Ozon, кампания за заказ) — Ozon: недельный бюджет.
        if (mp === 'ozon' && dir === 'down' && c.can.weeklyBudget && c.weeklyBudget && c.weeklyBudget > 0 && settledCamp) {
          const next = r2(c.weeklyBudget * (1 - STEP));
          out.push({
            mp, campaignId: c.id, sku: null, kind: 'weekly_budget', placement: null, fromValue: c.weeklyBudget, toValue: next,
            rule, level, title: `Снизить недельный бюджет ${rub(c.weeklyBudget)} → ${rub(next)}`,
            reason: `${why}. Ставку в этой кампании ведёт Ozon (${c.bidType ?? 'стратегия'}), поэтому сдерживаем бюджетом`,
            fp: `${campFp}|weekly_budget`,
          });
        }
        return;
      }
      for (const sl of slots) {
        let next = dir === 'down' ? sl.bid * (1 - STEP) : sl.bid * (1 + STEP);
        next =mp === 'wb' && c.payment === 'cpm' ? Math.round(next) : r2(next);
        if (dir === 'up' && next <= sl.bid) continue;
        if (dir === 'down' && next >= sl.bid) continue;
        const where = sl.placement === 'search' ? ' (поиск)' : sl.placement === 'recommendations' ? ' (рекомендации)' : '';
        out.push({
          mp, campaignId: c.id, sku: it.sku, kind: 'bid', placement: sl.placement, fromValue: sl.bid, toValue: next,
          rule, level, title: `${dir === 'up' ? 'Поднять' : 'Снизить'} ставку${where} ${rub(sl.bid)} → ${rub(next)}`,
          reason: why, fp: `${campFp}|${it.sku}|bid|${sl.placement ?? ''}`,
        });
      }
    });
  }

  // 4. Кандидаты на новую кампанию — только совет.
  for (const p of ov.products) {
    if (p.issues.some(x => x.code === 'no_ads_opportunity') && p.adSku) {
      out.push({
        mp, campaignId: null, sku: p.adSku, kind: 'new_campaign', placement: null, fromValue: null, toValue: null,
        rule: 'no_ads_opportunity', level: 'info', title: 'Кандидат на рекламную кампанию',
        reason: `${p.orders} заказов за 7 дней без рекламы, запас ${p.daysOfStock ?? '—'} дн${p.marginPct != null ? `, маржа ${p.marginPct}%` : ''} — решает менеджер`,
        fp: `${mp}||${p.adSku}|new_campaign`,
      });
    }
  }
  return out.sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]);
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
  const ins = d.prepare(`INSERT INTO ad_proposal (created_at, updated_at, mp, campaign_id, sku, kind, placement, from_value, to_value, rule, level, title, reason, fp, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`);
  const touch = d.prepare(`UPDATE ad_proposal SET updated_at = ?, from_value = ?, title = ?, reason = ?, rule = ?, level = ? WHERE id = ?`);
  const close = d.prepare(`UPDATE ad_proposal SET status = ?, decided_at = ?, decided_by = 'autopilot' WHERE id = ?`);
  let added = 0, kept = 0, closed = 0;
  d.exec('BEGIN');
  try {
    for (const p of drafts) {
      if (seen.has(p.fp) || quiet.has(p.fp)) continue;
      seen.add(p.fp);
      const cur = byFp.get(p.fp);
      if (cur && (cur.to_value ?? null) === (p.toValue ?? null)) {
        touch.run(now, p.fromValue, p.title, p.reason, p.rule, p.level, cur.id);
        kept++;
        continue;
      }
      if (cur) { close.run('superseded', now, cur.id); closed++; }
      ins.run(now, now, mp, p.campaignId, p.sku, p.kind, p.placement, p.fromValue, p.toValue, p.rule, p.level, p.title, p.reason, p.fp);
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
        const r = saveProposals(mp, buildProposals(ov));
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
  if (afterFrom >= today) return { days: 0, before: null, after: null };
  const afterTo = [addDays(day, 3), addDays(today, -1)].sort()[0];
  const q = (from: string, to: string) => d.prepare(`SELECT ROUND(SUM(spend), 2) AS spend, ROUND(SUM(orders), 1) AS orders, ROUND(SUM(revenue), 2) AS revenue, COUNT(DISTINCT date) AS days
      FROM ad_stat_day WHERE mp = ? AND campaign_id = ? ${r.sku ? 'AND sku = ?' : ''} AND date >= ? AND date <= ?`)
    .get(...[r.mp, r.campaign_id, ...(r.sku ? [r.sku] : []), from, to]) as any;
  const norm = (x: any) => (x && x.days ? { spend: x.spend ?? 0, orders: x.orders ?? 0, drr: x.revenue > 0 ? r2((x.spend / x.revenue) * 100) : null, perDay: r2((x.spend ?? 0) / x.days) } : null);
  const after = q(afterFrom, afterTo);
  return { days: after?.days ?? 0, before: norm(q(addDays(day, -3), addDays(day, -1))), after: norm(after) };
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
    effect: history ? effectOf(r) : null,
  }));
  if (!history) list.sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] || b.createdAt - a.createdAt);
  return list;
}

const ACTIONABLE: Ads2ProposalKind[] = ['bid', 'pause', 'daily_limit', 'weekly_budget'];

export async function decideProposal(id: number, decision: 'apply' | 'reject', by: string, note: string | null, confirmBig = false)
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
