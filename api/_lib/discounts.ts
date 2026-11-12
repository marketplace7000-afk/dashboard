/**
 * «Заявки на скидку» (08.11.2026) — агент, который сам отвечает на заявки покупателей Ozon.
 *
 * Покупатель в карточке Ozon просит скидку. Заявка приходит в «Цены и акции → Заявки на скидку»
 * и в Seller API: v1/actions/discounts-task/list (статусы NEW / SEEN / APPROVED / DECLINED),
 * ответ — v1/actions/discounts-task/approve (своя цена) и …/decline. Проверено на живом
 * кабинете 08.11: за 4 дня ~500 одобренных вручную заявок.
 *
 * Правило задаётся по товару: «одобрять» (до N % и/или пока маржа не ниже X %) или «отклонять».
 * Режим не выбран — агент заявку не трогает, её обрабатывают вручную (решение владельца 08.11).
 * Процент скидки — от цены, которую покупатель видит на витрине сейчас (original_price
 * заявки: наша цена минус скидки Ozon). Можно добавить «маржа не ниже X %» — тогда
 * агент не опустит цену ниже точки, где маржа падает под порог.
 *
 * ВАЖНО (08.11, ошибка стоила одной заявки): в ОТВЕТ approve цену шлём В МАСШТАБЕ ЛК, как
 * requested_price, — Ozon сам переводит её в цену покупателя (× витрина / ЛК). Отправили цену
 * покупателя 112 984 → Ozon записал 67 816 (−40 %). Пересчёт — apiPrice(), с защитой.
 *
 * Как считаем маржу. Цены заявки (base_price − discount, approved_price в списке) — это цены
 * ПОКУПАТЕЛЯ, а requested_price — наша цена ЛК, уменьшенная на ту же долю. Сверено на
 * живой заявке 08.11: ЛК 181 725, витрина 113 024, просят 107 373 (−5 %) → requested_price
 * 172 639 = 181 725 × 0,95 до рубля. Значит, соинвест Ozon сохраняется, и скидка N % от
 * витрины уменьшает нашу цену ЛК тоже на N %. Маржа после скидки = маржа при цене ЛК × (1 − N).
 *
 * Решение:
 *   можно дать = min(N %, скидка, при которой маржа ещё не ниже X %)
 *   просят не больше         → одобряем как просили;
 *   просят больше            → одобряем по своей цене (витрина × (1 − можно));
 *   дать нельзя (0 % или маржа уже ниже порога) → отклоняем.
 *
 * Пока владелец не включил автоответ, агент только показывает, что бы сделал.
 * Номера заявок — 18 цифр, больше точности чисел JS: из ответа Ozon берём их строкой.
 */
import { adsDb, adsMetaGet, adsMetaSet } from './ads/store';
import { getMargins, type MarginRow } from './margin';
import { rnpItems } from './rnp';
import { normSku } from './costs';
import { gate, note } from './gateway';
import { calcOzonProfit, type OzonCalcInput } from '../../src/utils/ozonProfit';

export type DiscountMode = 'approve' | 'decline' | 'manual';
export type DiscountRule = { article: string; mode: DiscountMode; maxPct: number | null; minMargin: number | null; updatedAt: number; updatedBy: string };
export type Decision = { action: 'approve' | 'decline' | 'skip'; price: number | null; pct: number | null; marginPct: number | null; reason: string };

/** Заявка в нашем виде. Цены — в рублях. */
export type DiscountTask = {
  id: string; article: string; sku: string; status: string; createdAt: string; customer: string; comment: string;
  /** Наша цена ЛК на момент заявки. */
  base: number;
  /** Цена на витрине на момент заявки (что покупатель видел). */
  showcase: number;
  /** Сколько просит покупатель (в тех же единицах, что одобренная цена). */
  requested: number;
  /** Сколько это в % от витрины. */
  requestedPct: number;
  qtyMin: number; qtyMax: number;
  approvedPrice: number | null;
  moderatedAt: string | null;
  /** Ozon: покупатель купил по одобренной цене (is_purchased). */
  purchased: boolean;
  /** Что решил агент (для NEW/SEEN — что сделает сейчас). */
  decision: Decision | null;
  /** Ответ отправлен нашим агентом/кнопкой. */
  by: 'agent' | 'user' | null; byName: string | null; appliedAt: number | null; error: string | null;
};

const MP = 'ozon';
const POLL_MS = 2 * 60_000;
const HISTORY_EVERY_MS = 15 * 60_000;
/** Раз в час — глубже по одобренным: у старых заявок меняется is_purchased (покупка). */
const DEEP_EVERY_MS = 60 * 60_000;
const DEEP_PAGES = 10;
/**
 * ЖЁСТКИЙ ПОТОЛОК (решение владельца 08.11 после убыточного заказа): скидка по любой заявке —
 * не больше 10 % от нашей цены в ЛК. Проверяется в правилах, в решении агента и последней
 * проверкой прямо перед отправкой в Ozon (apiPrice) — для агента и для кнопки на сайте.
 */
export const MAX_DISCOUNT_PCT = 10;

// ─── Хранилище ──────────────────────────────────────────────────────────────

let ready = false;
function db(): any {
  const d = adsDb();
  if (!d) throw new Error('хранилище недоступно');
  if (!ready) {
    d.exec(`CREATE TABLE IF NOT EXISTS discount_rule (
      mp TEXT NOT NULL, article TEXT NOT NULL, mode TEXT NOT NULL, max_pct REAL, min_margin REAL,
      updated_at INTEGER NOT NULL, updated_by TEXT, PRIMARY KEY (mp, article));
    CREATE TABLE IF NOT EXISTS discount_task (
      mp TEXT NOT NULL, id TEXT NOT NULL, article TEXT, sku TEXT, status TEXT, created_at TEXT,
      raw TEXT NOT NULL, seen_at INTEGER NOT NULL,
      by TEXT, by_name TEXT, decision TEXT, applied_at INTEGER, error TEXT,
      PRIMARY KEY (mp, id));
    CREATE INDEX IF NOT EXISTS discount_task_created ON discount_task (mp, created_at);`);
    ready = true;
  }
  return d;
}

const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const up = (s: unknown) => normSku(String(s ?? ''));

export function listRules(): Record<string, DiscountRule> {
  const out: Record<string, DiscountRule> = {};
  for (const r of db().prepare('SELECT * FROM discount_rule WHERE mp = ?').all(MP) as any[]) {
    out[r.article] = { article: r.article, mode: r.mode, maxPct: r.max_pct, minMargin: r.min_margin, updatedAt: r.updated_at, updatedBy: r.updated_by ?? '' };
  }
  return out;
}

function limitPct(v: unknown, name: string, max: number): number | null {
  if (v === null || v === undefined || String(v).trim() === '') return null;
  const n = Number(String(v).replace(',', '.'));
  if (!Number.isFinite(n) || n < 0 || n > max) throw new Error(`${name}: число от 0 до ${max}`);
  return Math.round(n * 10) / 10;
}

/** Сохранить правило для одного или нескольких товаров. Поле, которого нет в запросе, не меняется. */
export function saveRules(input: any, who: string): number {
  const articles: string[] = (Array.isArray(input?.articles) ? input.articles : [input?.article]).map(up).filter(Boolean);
  if (!articles.length) throw new Error('не выбран товар');
  const cur = listRules();
  const mode = input?.mode;
  if (mode !== undefined && !['approve', 'decline', 'manual'].includes(mode)) throw new Error('неизвестный режим');
  let maxPct = 'maxPct' in (input ?? {}) ? limitPct(input.maxPct, 'Скидка', MAX_DISCOUNT_PCT) : undefined;
  let minMargin = 'minMargin' in (input ?? {}) ? limitPct(input.minMargin, 'Маржа', 90) : undefined;
  // Либо макс. скидка, либо мин. маржа (решение владельца 08.11): одно стирает другое.
  if (maxPct != null) minMargin = null;
  else if (minMargin != null) maxPct = null;
  const st = db().prepare(`INSERT INTO discount_rule (mp, article, mode, max_pct, min_margin, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(mp, article) DO UPDATE SET mode = excluded.mode, max_pct = excluded.max_pct, min_margin = excluded.min_margin,
      updated_at = excluded.updated_at, updated_by = excluded.updated_by`);
  for (const a of articles) {
    const c = cur[a];
    st.run(MP, a, mode ?? c?.mode ?? 'manual', maxPct !== undefined ? maxPct : c?.maxPct ?? null,
      minMargin !== undefined ? minMargin : c?.minMargin ?? null, Date.now(), who);
  }
  return articles.length;
}

export type DiscountSettings = { auto: boolean; defaultMode: 'manual' | 'decline' };
export function getDiscountSettings(): DiscountSettings {
  // 08.11: «по умолчанию отклонять» убрано по решению владельца — товар без режима всегда обрабатывают вручную.
  return { auto: adsMetaGet('discounts:ozon:auto') === '1', defaultMode: 'manual' };
}
export function setDiscountSettings(p: any): DiscountSettings {
  if (p?.auto !== undefined) adsMetaSet('discounts:ozon:auto', p.auto ? '1' : '0');
  if (p?.defaultMode !== undefined) {
    if (p.defaultMode !== 'manual' && p.defaultMode !== 'decline') throw new Error('неизвестный режим');
    adsMetaSet('discounts:ozon:default', p.defaultMode);
  }
  if (p?.auto) void runPass('включён автоответ').catch(() => {});
  return getDiscountSettings();
}

// ─── Расчёт ─────────────────────────────────────────────────────────────────

/**
 * Маржа, % при скидке pct % от витрины: наша цена ЛК падает на ту же долю, соинвест Ozon
 * (spp) прежний. Эквайринг — в той же доле от цены.
 */
export function marginAtDiscount(input: OzonCalcInput | null | undefined, pct: number): number | null {
  if (!input || !(input.price > 0) || !(input.cost > 0)) return null;
  const price = input.price * (1 - pct / 100);
  const acq = input.acquiring / input.price;
  const r = calcOzonProfit({ ...input, price, acquiring: Math.round(acq * price) });
  return r ? Math.round(r.margin * 10) / 10 : null;
}

/** Наибольшая скидка (% от витрины, шаг 0,1), при которой маржа не ниже порога. null — посчитать не от чего; 0 — уже без скидки ниже. */
export function maxPctForMargin(input: OzonCalcInput | null | undefined, minMargin: number): number | null {
  if (marginAtDiscount(input, 0) == null) return null;
  if ((marginAtDiscount(input, 0) ?? -Infinity) < minMargin) return 0;
  let lo = 0, hi = 90;
  if ((marginAtDiscount(input, hi) ?? -Infinity) >= minMargin) return hi;
  for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if ((marginAtDiscount(input, mid) ?? -Infinity) >= minMargin) lo = mid; else hi = mid; }
  return Math.floor(lo * 10) / 10;
}

const pctOff = (from: number, to: number) => (from > 0 ? Math.round((1 - to / from) * 1000) / 10 : 0);
const fmtPct = (v: number) => String(v).replace('.', ',');

/**
 * Минимальная скидка, которую принимает Ozon (12.11, по 151 отказу за 09–12.11): для покупателя
 * не меньше 300 ₽, у дешёвых товаров — 5 % витрины. Меньше — Ozon отвечает «Одобренная скидка
 * меньше минимально возможной» (или «…цена больше или равна цене товара»), и заявку доделывал менеджер
 * ровно на 300 ₽. Покупатели чаще всего так и просят: −300 ₽ или −5 %.
 */
export const OZON_MIN_DISCOUNT_RUB = 300;
export const ozonMinDiscount = (showcase: number) => Math.min(OZON_MIN_DISCOUNT_RUB, Math.floor(showcase * 0.05));
const OZON_MIN_ERR = /меньше минимально возможной|больше или равна цене товара/i;

/** Что делать с заявкой. Чистая функция — проверяется в scripts/check-discounts.ts. */
export function decide(t: Pick<DiscountTask, 'showcase' | 'requested'>, rule: DiscountRule | undefined, defaultMode: 'manual' | 'decline', input: OzonCalcInput | null | undefined): Decision {
  const skip = (reason: string): Decision => ({ action: 'skip', price: null, pct: null, marginPct: null, reason });
  const mode = rule ? rule.mode : defaultMode;
  if (mode === 'manual') return skip('режим не выбран — обработать вручную');
  if (mode === 'decline') return { action: 'decline', price: null, pct: null, marginPct: null, reason: rule ? 'товар в списке «отклонять»' : 'для товара нет правила — по умолчанию отклоняем' };

  const show = t.showcase;
  if (!(show > 0) || !(t.requested > 0)) return skip('в заявке нет цены — обработать вручную');
  if (rule!.maxPct == null && rule!.minMargin == null) return skip('не задана ни скидка, ни мин. маржа — обработать вручную');
  let allowed = Math.min(rule!.maxPct ?? MAX_DISCOUNT_PCT, MAX_DISCOUNT_PCT);
  let byMargin = false;
  if (rule!.minMargin != null) {
    const m = maxPctForMargin(input, rule!.minMargin);
    if (m == null) return skip('нет себестоимости, маржу не посчитать — обработать вручную');
    if (m < allowed) { allowed = m; byMargin = true; }
  }
  const askExact = (1 - t.requested / show) * 100;
  const ask = pctOff(show, t.requested);
  if (!(allowed > 0)) {
    return { action: 'decline', price: null, pct: null, marginPct: marginAtDiscount(input, 0),
      reason: byMargin ? `скидку дать нельзя: маржа уже ниже ${fmtPct(rule!.minMargin!)} %` : 'скидка для товара — 0 %' };
  }
  if (askExact <= allowed + 1e-9) {
    return { action: 'approve', price: Math.round(t.requested), pct: ask, marginPct: marginAtDiscount(input, Math.max(0, askExact)), reason: `одобряем как просили: −${fmtPct(ask)} %` };
  }
  let price = Math.ceil(show * (1 - allowed / 100));
  // Встречная скидка меньше минимума Ozon — Ozon её не примет. Поднимаем до минимума (но не больше,
  // чем просил покупатель, и не больше потолка 10 %); при правиле по марже — только если маржа держится.
  const minDisc = ozonMinDiscount(show);
  if (show - price < minDisc) {
    const p2 = Math.max(Math.round(t.requested), show - minDisc);
    const pct2 = (1 - p2 / show) * 100;
    const m2 = marginAtDiscount(input, pct2);
    if (pct2 <= MAX_DISCOUNT_PCT + 1e-9 && (rule!.minMargin == null || (m2 != null && m2 >= rule!.minMargin))) {
      const pr = pctOff(show, p2);
      return { action: 'approve', price: p2, pct: pr, marginPct: m2,
        reason: p2 <= Math.round(t.requested) ? `одобряем как просили: −${fmtPct(pr)} % (меньше Ozon не принимает)` : `просили −${fmtPct(ask)} %, даём минимум Ozon −${show - p2} ₽ (−${fmtPct(pr)} %)` };
    }
    if (byMargin) return { action: 'decline', price: null, pct: null, marginPct: marginAtDiscount(input, 0),
      reason: `минимальная скидка Ozon ${minDisc} ₽ опускает маржу ниже ${fmtPct(rule!.minMargin!)} %` };
  }
  const pct = pctOff(show, price);
  return { action: 'approve', price, pct, marginPct: marginAtDiscount(input, (1 - price / show) * 100),
    reason: `просили −${fmtPct(ask)} %, даём −${fmtPct(pct)} %${byMargin ? ` (ограничила маржа ${fmtPct(rule!.minMargin!)} %)` : ''}` };
}

// ─── Ozon ───────────────────────────────────────────────────────────────────

const ozHeaders = () => ({ 'Client-Id': process.env.OZON_CLIENT_ID ?? '', 'Api-Key': process.env.OZON_API_KEY ?? '', 'Content-Type': 'application/json' });
/** Большие номера (id, prev_task_id) — строкой, иначе JSON.parse их округлит. */
const bigIds = (text: string) => text.replace(/"(id|prev_task_id|task_id)"\s*:\s*(\d{15,})/g, '"$1":"$2"');

async function ozPost(path: string, body: unknown): Promise<any> {
  const raw = JSON.stringify(body).replace(/"(id)":"(\d+)"/g, '"$1":$2');
  // Общая очередь Ozon (gateway): опрос заявок не должен выстреливать одновременно с прогревом. Повторов нет — тут есть действия.
  const url = `https://api-seller.ozon.ru/${path}`;
  await gate(url, 0);
  const r = await fetch(url, { method: 'POST', headers: ozHeaders(), body: raw, signal: AbortSignal.timeout(30_000) });
  note(url, r.status, Number(r.headers.get('retry-after')) || undefined);
  const text = await r.text();
  if (!r.ok) throw new Error(`Ozon ${r.status}: ${text.slice(0, 300)}`);
  return JSON.parse(bigIds(text));
}

async function fetchStatus(status: string, maxPages: number): Promise<any[]> {
  const out: any[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const r = await ozPost('v1/actions/discounts-task/list', { status, page, limit: 50 });
    const items: any[] = r?.result ?? [];
    out.push(...items);
    if (items.length < 50) break;
  }
  return out;
}

/** Заявка Ozon → наш вид. Запрошенная цена = наша цена − запрошенная скидка (так сходится с approved_* в ответе). */
export function toTask(x: any): Omit<DiscountTask, 'decision' | 'by' | 'byName' | 'appliedAt' | 'error'> {
  const base = num(x.base_price), show = num(x.original_price);
  let requested = base > 0 && num(x.discount) > 0 ? base - num(x.discount) : 0;
  if (!(requested > 0)) requested = num(x.requested_price_with_fee) || num(x.requested_price);
  return {
    id: String(x.id), article: up(x.offer_id), sku: String(x.sku ?? ''), status: String(x.status ?? ''),
    createdAt: String(x.created_at ?? ''), customer: String(x.customer_name ?? ''), comment: String(x.user_comment ?? ''),
    base, showcase: show, requested, requestedPct: pctOff(show, requested),
    qtyMin: num(x.requested_quantity_min) || 1, qtyMax: num(x.requested_quantity_max) || num(x.requested_quantity_min) || 1,
    approvedPrice: num(x.approved_price) || null, moderatedAt: x.moderated_at ? String(x.moderated_at) : null,
    purchased: x.is_purchased === true,
  };
}

function saveRaw(items: any[]): void {
  const st = db().prepare(`INSERT INTO discount_task (mp, id, article, sku, status, created_at, raw, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(mp, id) DO UPDATE SET status = excluded.status, raw = excluded.raw, seen_at = excluded.seen_at`);
  const now = Date.now();
  for (const x of items) st.run(MP, String(x.id), up(x.offer_id), String(x.sku ?? ''), String(x.status ?? ''), String(x.created_at ?? ''), JSON.stringify(x), now);
}

function markApplied(id: string, by: 'agent' | 'user', byName: string, d: Decision, error: string | null): void {
  db().prepare('UPDATE discount_task SET by = ?, by_name = ?, decision = ?, applied_at = ?, error = ? WHERE mp = ? AND id = ?')
    .run(by, byName, JSON.stringify(d), Date.now(), error, MP, id);
  // Ozon принял ответ — статус меняем сразу, не дожидаясь, пока заявка придёт в истории (08.11:
  // одобренная с сайта заявка ещё 15 минут висела «Новой»).
  if (!error && (d.action === 'approve' || d.action === 'decline')) {
    const row = db().prepare('SELECT raw FROM discount_task WHERE mp = ? AND id = ?').get(MP, id) as any;
    if (row) {
      const x = JSON.parse(row.raw);
      x.status = d.action === 'approve' ? 'APPROVED' : 'DECLINED';
      if (d.action === 'approve') x.approved_price = d.price;
      db().prepare('UPDATE discount_task SET status = ?, raw = ? WHERE mp = ? AND id = ?').run(x.status, JSON.stringify(x), MP, id);
    }
  }
}

/** Заявки, которые у нас «ждут», а в ответе Ozon их уже нет: на них ответили в кабинете. */
function staleIds(pending: any[]): number {
  const live = new Set(pending.map(x => String(x.id)));
  const ours = db().prepare("SELECT id FROM discount_task WHERE mp = ? AND status IN ('NEW', 'SEEN')").all(MP) as any[];
  return ours.filter(r => !live.has(String(r.id))).length;
}

/**
 * Цена для approve: из цены покупателя (наш масштаб) — в масштаб ЛК, как ждёт Ozon.
 * Округляем вниз (12.11): иначе скидка выходила на доли рубля меньше и Ozon отказывал по минимуму.
 * Бросает ошибку, если цену не проверить или скидка подозрительно большая.
 */
export function apiPrice(t: Pick<DiscountTask, 'base' | 'showcase'>, buyerPrice: number): number {
  if (!(t.base > 0) || !(t.showcase > 0) || !(buyerPrice > 0)) throw new Error('в заявке нет цены ЛК или витрины — ответить вручную в кабинете');
  // 12.11: округляем ВНИЗ. Вверх скидка выходила на доли рубля меньше задуманной (просили −300 ₽ —
  // уходило −299,7 ₽), и Ozon отказывал «меньше минимально возможной». Разница — меньше 1 ₽.
  // (requested_price из заявки не берём: у части заявок он не сходится с discount.)
  const lk = Math.min(Math.round(t.base) - 1, Math.floor(buyerPrice * t.base / t.showcase));
  // Последняя проверка — по самой цене, которая уйдёт в Ozon: не ниже ЛК × 0,9.
  if (lk < Math.ceil(t.base * (1 - MAX_DISCOUNT_PCT / 100))) {
    const pct = Math.round((1 - lk / t.base) * 1000) / 10;
    throw new Error(`скидка ${String(pct).replace('.', ',')} % от цены ЛК — больше ${MAX_DISCOUNT_PCT} %, не отправлено`);
  }
  return lk;
}

/** Повтор после отказа Ozon «скидка меньше минимальной»: как просил покупатель, если в потолке 10 % и (при правиле по марже) маржа держится. */
export function asAskedRetry(t: ReturnType<typeof toTask>, rule: DiscountRule | undefined, input: OzonCalcInput | null | undefined): Decision | null {
  if (!rule || rule.mode !== 'approve' || !(t.showcase > 0) || !(t.requested > 0)) return null;
  const pct = (1 - t.requested / t.showcase) * 100;
  if (pct > MAX_DISCOUNT_PCT + 1e-9) return null;
  const m = marginAtDiscount(input, Math.max(0, pct));
  if (rule.minMargin != null && (m == null || m < rule.minMargin)) return null;
  return { action: 'approve', price: Math.round(t.requested), pct: pctOff(t.showcase, t.requested), marginPct: m,
    reason: `Ozon не принял меньшую скидку — одобряем как просили: −${fmtPct(pctOff(t.showcase, t.requested))} %` };
}

/** Ответить Ozon пачкой. Возвращает ошибки по номерам заявок. */
async function send(kind: 'approve' | 'decline', tasks: { t: ReturnType<typeof toTask>; d: Decision }[]): Promise<Map<string, string>> {
  const errs = new Map<string, string>();
  for (let i = 0; i < tasks.length; i += 50) {
    const part: typeof tasks = [];
    const prices = new Map<string, number>();
    for (const x of tasks.slice(i, i + 50)) {
      if (kind !== 'approve') { part.push(x); continue; }
      try { prices.set(x.t.id, apiPrice(x.t, x.d.price ?? 0)); part.push(x); } catch (e) { errs.set(x.t.id, (e as Error).message); }
    }
    if (!part.length) continue;
    const body = kind === 'approve'
      ? { tasks: part.map(({ t }) => ({ id: t.id, approved_price: prices.get(t.id), seller_comment: '', approved_quantity_min: t.qtyMin, approved_quantity_max: t.qtyMax })) }
      : { tasks: part.map(({ t }) => ({ id: t.id, seller_comment: '' })) };
    try {
      const r = await ozPost(`v1/actions/discounts-task/${kind}`, body);
      const res = r?.result ?? r;
      for (const f of (res?.fail_details ?? res?.errors ?? [])) {
        const id = String(f?.task_id ?? f?.id ?? '');
        errs.set(id, String(f?.error_for_user ?? f?.message ?? f?.error ?? JSON.stringify(f)).slice(0, 300));
      }
    } catch (e) {
      for (const { t } of part) errs.set(t.id, (e as Error).message.slice(0, 300));
    }
  }
  return errs;
}

// ─── Проход ─────────────────────────────────────────────────────────────────

// Состояние прохода — в базе, не в памяти (08.11): server.ts и route.ts получают РАЗНЫЕ копии
// модуля, и экран видел «ещё не было», хотя таймер работал. Там же замок: кнопка «Забрать
// заявки сейчас» не должна идти параллельно с таймером и ответить на заявку дважды.
let lastHistory = 0;
let lastDeep = 0;
type PassState = { lastRun: number; lastError: string | null; lastSummary: string };
function passState(): PassState {
  try { return { lastRun: 0, lastError: null, lastSummary: '', ...JSON.parse(adsMetaGet('discounts:ozon:pass') || '{}') }; }
  catch { return { lastRun: 0, lastError: null, lastSummary: '' }; }
}
const LOCK_MS = 3 * 60_000;
function lock(): boolean {
  const at = Number(adsMetaGet('discounts:ozon:lock') || 0);
  if (at && Date.now() - at < LOCK_MS) return false;
  adsMetaSet('discounts:ozon:lock', String(Date.now()));
  return true;
}
const unlock = () => adsMetaSet('discounts:ozon:lock', '0');

async function inputs(): Promise<Record<string, MarginRow>> {
  try { return (await getMargins('ozon')).items; } catch { return {}; }
}

export async function runPass(why = 'по таймеру'): Promise<string> {
  if (!process.env.OZON_CLIENT_ID || !process.env.OZON_API_KEY) return 'нет ключа Ozon';
  if (!lock()) return 'проверка уже идёт'; // замок снимается в finally
  try {
    const pending = [...await fetchStatus('NEW', 20), ...await fetchStatus('SEEN', 20)];
    saveRaw(pending);
    // История — раз в 15 минут или сразу, если заявка пропала из ожидающих (ответили в кабинете).
    if (Date.now() - lastHistory > HISTORY_EVERY_MS || staleIds(pending) > 0) {
      saveRaw([...await fetchStatus('APPROVED', 2), ...await fetchStatus('DECLINED', 2)]);
      lastHistory = Date.now();
      if (Date.now() - lastDeep > DEEP_EVERY_MS) { saveRaw(await fetchStatus('APPROVED', DEEP_PAGES)); lastDeep = Date.now(); }
      // Не нашлась и в истории (истекла и т. п.) — закрываем, иначе история запрашивалась бы каждый проход.
      const live = new Set(pending.map(x => String(x.id)));
      for (const r of db().prepare("SELECT id, raw FROM discount_task WHERE mp = ? AND status IN ('NEW', 'SEEN')").all(MP) as any[]) {
        if (live.has(String(r.id))) continue;
        const x = JSON.parse(r.raw); x.status = 'CLOSED';
        db().prepare('UPDATE discount_task SET status = ?, raw = ? WHERE mp = ? AND id = ?').run('CLOSED', JSON.stringify(x), MP, r.id);
      }
    }
    const s = getDiscountSettings();
    let summary = `заявок в ожидании: ${pending.length}`;
    if (s.auto && pending.length) {
      const rules = listRules();
      const margins = await inputs();
      const approve: { t: ReturnType<typeof toTask>; d: Decision }[] = [], decline: typeof approve = [];
      for (const x of pending) {
        const t = toTask(x);
        const d = decide(t, rules[t.article], s.defaultMode, margins[t.article]?.input as OzonCalcInput | null);
        if (d.action === 'approve') approve.push({ t, d });
        else if (d.action === 'decline') decline.push({ t, d });
      }
      const e1 = await send('approve', approve), e2 = await send('decline', decline);
      const retry: typeof approve = [];
      for (const a of approve) {
        if (!OZON_MIN_ERR.test(e1.get(a.t.id) ?? '')) continue;
        const r = asAskedRetry(a.t, rules[a.t.article], margins[a.t.article]?.input as OzonCalcInput | null);
        if (r) retry.push({ t: a.t, d: r });
      }
      if (retry.length) {
        const e3 = await send('approve', retry);
        for (const x of retry) {
          const i = approve.findIndex(a => a.t.id === x.t.id);
          approve[i] = x;
          if (e3.has(x.t.id)) e1.set(x.t.id, e3.get(x.t.id)!); else e1.delete(x.t.id);
        }
      }
      for (const { t, d } of approve) markApplied(t.id, 'agent', 'агент', d, e1.get(t.id) ?? null);
      for (const { t, d } of decline) markApplied(t.id, 'agent', 'агент', d, e2.get(t.id) ?? null);
      const failed = e1.size + e2.size;
      summary += `; одобрено ${approve.length - e1.size}, отклонено ${decline.length - e2.size}${failed ? `, ошибок ${failed}` : ''}`;
      if (approve.length || decline.length) console.log(`[discounts] ${why}: ${summary}`);
      // Статусы обработанных — сразу, чтобы на экране они не висели «в ожидании».
      if (approve.length || decline.length) saveRaw([...await fetchStatus('NEW', 20), ...await fetchStatus('SEEN', 20)]);
    }
    adsMetaSet('discounts:ozon:pass', JSON.stringify({ lastRun: Date.now(), lastError: null, lastSummary: summary }));
    return summary;
  } catch (e) {
    const msg = (e as Error).message.slice(0, 300);
    adsMetaSet('discounts:ozon:pass', JSON.stringify({ ...passState(), lastError: msg }));
    console.warn('[discounts]', msg);
    return msg;
  } finally { unlock(); }
}

/** Ручной ответ из дашборда — кнопками у заявки. */
export async function applyManual(input: any, who: string): Promise<void> {
  const id = String(input?.id ?? '');
  if (!/^\d+$/.test(id)) throw new Error('нет номера заявки');
  const row = db().prepare('SELECT raw FROM discount_task WHERE mp = ? AND id = ?').get(MP, id) as any;
  if (!row) throw new Error('заявка не найдена — обновите страницу');
  const x = JSON.parse(row.raw);
  if (x.status !== 'NEW' && x.status !== 'SEEN') throw new Error('на заявку уже ответили');
  const t = toTask(x);
  const margins = await inputs();
  const inp = margins[t.article]?.input as OzonCalcInput | null;
  let d: Decision;
  if (input?.action === 'decline') d = { action: 'decline', price: null, pct: null, marginPct: null, reason: 'отклонено вручную' };
  else if (input?.action === 'approve') {
    const price = Math.round(Number(input?.price));
    if (!(price > 0)) throw new Error('укажите цену');
    if (price < t.requested) throw new Error('цена ниже, чем просит покупатель — так скидку не дать');
    d = { action: 'approve', price, pct: pctOff(t.showcase, price), marginPct: t.showcase > 0 ? marginAtDiscount(inp, Math.max(0, (1 - price / t.showcase) * 100)) : null, reason: 'одобрено вручную' };
  } else throw new Error('неизвестное действие');
  const errs = await send(d.action as 'approve' | 'decline', [{ t, d }]);
  markApplied(t.id, 'user', who, d, errs.get(t.id) ?? null);
  if (errs.size) throw new Error(`Ozon не принял ответ: ${errs.get(t.id)}`);
  saveRaw([...await fetchStatus('NEW', 20), ...await fetchStatus('SEEN', 20)]);
}

// ─── Экран ──────────────────────────────────────────────────────────────────

export type DiscountProduct = {
  article: string; name: string; photo: string; sku: string;
  /** Цена ЛК и цена на витрине сейчас. */
  price: number | null; showcase: number | null; showcaseSource: string;
  cost: number | null; marginPct: number | null; marginRub: number | null;
  /** Вход калькулятора — экран пересчитывает маржу при любой скидке. */
  input: OzonCalcInput | null;
  rule: DiscountRule | null;
  /** Заявок за 7 дней и сколько из них ждут ответа. */
  req7: number; pending: number;
};

export async function overview(isOwner = false): Promise<any> {
  const rules = listRules();
  const s = getDiscountSettings();
  const margins = await inputs();
  const names = new Map(rnpItems('ozon').map(i => [up(i.article || i.sku), i]));
  const since = new Date(Date.now() - 7 * 864e5).toISOString();
  const rows = db().prepare('SELECT * FROM discount_task WHERE mp = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 2000').all(MP, since) as any[];

  const tasks: DiscountTask[] = rows.map(r => {
    const t = toTask(JSON.parse(r.raw));
    const isPending = t.status === 'NEW' || t.status === 'SEEN';
    const decision: Decision | null = r.decision ? JSON.parse(r.decision)
      : isPending ? decide(t, rules[t.article], s.defaultMode, margins[t.article]?.input as OzonCalcInput | null) : null;
    return { ...t, decision, by: r.by ?? null, byName: r.by_name ?? null, appliedAt: r.applied_at ?? null, error: r.error ?? null };
  });
  const cnt = new Map<string, { all: number; pending: number }>();
  for (const t of tasks) {
    const c = cnt.get(t.article) ?? { all: 0, pending: 0 };
    c.all++; if (t.status === 'NEW' || t.status === 'SEEN') c.pending++;
    cnt.set(t.article, c);
  }
  // Последняя витрина из заявок свежее нашего обхода — берём её, если ей меньше 6 часов.
  const lastShow = new Map<string, { at: string; v: number }>();
  for (const t of tasks) if (t.showcase > 0 && !lastShow.has(t.article) && Date.now() - Date.parse(t.createdAt) < 6 * 3600_000) lastShow.set(t.article, { at: t.createdAt, v: t.showcase });

  const products: DiscountProduct[] = [];
  for (const [art, m] of Object.entries(margins)) {
    const it = names.get(art);
    const ls = lastShow.get(art);
    products.push({
      article: art, name: it?.name ?? '', photo: it?.photo ?? '', sku: m.id || it?.extId || '',
      price: m.retail, showcase: ls?.v ?? m.buyer, showcaseSource: ls ? 'request' : m.buyerSource,
      cost: m.cost, marginPct: m.marginPct, marginRub: m.marginRub, input: (m.input as OzonCalcInput) ?? null,
      rule: rules[art] ?? null, req7: cnt.get(art)?.all ?? 0, pending: cnt.get(art)?.pending ?? 0,
    });
  }
  return { settings: s, canToggle: isOwner, ...passState(), products, tasks, stats: purchaseStats(names, margins) };
}

// ─── Заказы по заявкам на скидку ────────────────────────────────────────────
//
// 08.11: отметка Ozon is_purchased у заявки не работает (0 из 566 одобренных, даже у заявки,
// по которой точно есть заказ). Надёжный признак — в самом заказе: в financial_data.products[].actions
// Ozon пишет акцию «WANNADISCOUNT-ГГГГММДД». Раз в час забираем заказы FBS (v4) и FBO (v3) за 10 дней
// (первый раз — за 30) и сохраняем строки с этой меткой; статус (отмена) обновляется при повторе.
const ORDERS_EVERY_MS = 60 * 60_000;
const ORDERS_KEY = 'discounts:ozon:ordersAt';
const WANNA = /WANNADISCOUNT/i;

function ordersDb(): any {
  const d = db();
  d.exec(`CREATE TABLE IF NOT EXISTS discount_order (
    mp TEXT NOT NULL, posting TEXT NOT NULL, article TEXT NOT NULL, scheme TEXT, status TEXT, created_at TEXT,
    qty INTEGER, price REAL, customer_price REAL, action TEXT, seen_at INTEGER NOT NULL,
    PRIMARY KEY (mp, posting, article));
  CREATE INDEX IF NOT EXISTS discount_order_created ON discount_order (mp, created_at);`);
  return d;
}

export type DiscountOrderRow = { posting: string; article: string; scheme: 'FBS' | 'FBO'; status: string; createdAt: string; qty: number; price: number; customerPrice: number | null; action: string };

/** Строки отправления с меткой заявки на скидку. Деньги v4 — { amount }, v3 — строка. */
export function discountOrderRows(p: any, scheme: 'FBS' | 'FBO'): DiscountOrderRow[] {
  const money = (v: any) => num(v && typeof v === 'object' && 'amount' in v ? v.amount : v);
  const fin: any[] = p?.financial_data?.products ?? [];
  const prods: any[] = p?.products ?? [];
  const out: DiscountOrderRow[] = [];
  fin.forEach((f, i) => {
    const action = (f?.actions ?? []).find((a: unknown) => WANNA.test(String(a)));
    if (!action) return;
    const pr = prods.find(x => String(x.sku) === String(f.product_id)) ?? prods[i] ?? {};
    out.push({
      posting: String(p.posting_number), article: up(pr.offer_id), scheme, status: String(p.status ?? ''),
      createdAt: String(p.in_process_at || p.created_at || ''), qty: num(pr.quantity ?? f.quantity) || 1,
      price: money(pr.price), customerPrice: money(f.customer_price) || null, action: String(action),
    });
  });
  return out;
}

async function syncOrders(): Promise<void> {
  const last = Number(adsMetaGet(ORDERS_KEY) || 0);
  if (Date.now() - last < ORDERS_EVERY_MS) return;
  const days = last ? 10 : 30;
  const filter = { since: new Date(Date.now() - days * 864e5).toISOString(), to: new Date().toISOString() };
  const rows: DiscountOrderRow[] = [];
  for (const [scheme, path] of [['FBS', 'v4/posting/fbs/list'], ['FBO', 'v3/posting/fbo/list']] as const) {
    let cursor: string | undefined;
    for (let page = 0; page < 200; page++) {
      const j = await ozPost(path, { dir: 'ASC', filter, limit: 100, with: { financial_data: true }, ...(cursor ? { cursor } : {}) });
      const batch: any[] = j?.postings ?? j?.result?.postings ?? [];
      for (const p of batch) rows.push(...discountOrderRows(p, scheme));
      cursor = j?.cursor;
      if (!j?.has_next || !cursor || !batch.length) break;
      await new Promise(r => setTimeout(r, 300));
    }
  }
  const st = ordersDb().prepare(`INSERT INTO discount_order (mp, posting, article, scheme, status, created_at, qty, price, customer_price, action, seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (mp, posting, article) DO UPDATE SET status = excluded.status,
    qty = excluded.qty, price = excluded.price, customer_price = excluded.customer_price, seen_at = excluded.seen_at`);
  for (const r of rows) st.run(MP, r.posting, r.article, r.scheme, r.status, r.createdAt, r.qty, r.price, r.customerPrice, r.action, Date.now());
  adsMetaSet(ORDERS_KEY, String(Date.now()));
  console.log(`[discounts] заказы по заявкам: за ${days} дн. найдено ${rows.length}`);
}

/** Прибыль по заказу: экономика товара сейчас при цене ЛК из заказа (оценка). */
export function orderProfit(input: OzonCalcInput | null | undefined, unitPrice: number, qty: number): number | null {
  if (!input || !(input.price > 0) || !(input.cost > 0) || !(unitPrice > 0)) return null;
  const r = calcOzonProfit({ ...input, price: unitPrice, acquiring: Math.round(input.acquiring / input.price * unitPrice) });
  return r ? r.profit * qty : null;
}

/**
 * Эффективность скидок (08.11, переделано на настоящие заказы): одобренные заявки за окно →
 * заказы с меткой WANNADISCOUNT за то же окно. Отменённые считаются отдельно и в выручку не идут.
 * Кто одобрил (агент / вручную) — по последней одобренной заявке на этот товар до заказа (≤ 72 ч).
 */
function purchaseStats(names: Map<string, any>, margins: Record<string, MarginRow>): any {
  const since30 = new Date(Date.now() - 30 * 864e5).toISOString();
  const since7 = new Date(Date.now() - 7 * 864e5).toISOString();
  const tasks = (db().prepare("SELECT raw, by FROM discount_task WHERE mp = ? AND status = 'APPROVED' AND created_at >= ?").all(MP, since30) as any[])
    .map(r => { const x = JSON.parse(r.raw); return { t: toTask(x), price: num(x.approved_price), by: r.by === 'agent' ? 'agent' : 'hand' }; });
  const orders = ordersDb().prepare('SELECT * FROM discount_order WHERE mp = ? AND created_at >= ? ORDER BY created_at DESC').all(MP, since30) as any[];

  type Agg = { approved: number; orders: number; cancelled: number; units: number; revenue: number; profit: number; profitN: number; pctSum: number; pctN: number };
  const agg = (): Agg => ({ approved: 0, orders: 0, cancelled: 0, units: 0, revenue: 0, profit: 0, profitN: 0, pctSum: 0, pctN: 0 });
  const w7 = agg(), w30 = agg(), byAgent = agg(), byHand = agg();
  const per = new Map<string, Agg>();
  const pa = (art: string) => { if (!per.has(art)) per.set(art, agg()); return per.get(art)!; };
  let first = '';
  for (const { t, price, by } of tasks) {
    const pct = t.showcase > 0 && price > 0 ? (1 - price / t.showcase) * 100 : null;
    for (const a of [w30, t.createdAt >= since7 ? w7 : null, by === 'agent' ? byAgent : byHand, pa(t.article)]) {
      if (!a) continue; a.approved++; if (pct != null) { a.pctSum += pct; a.pctN++; }
    }
    if (!first || t.createdAt < first) first = t.createdAt;
  }
  const list: any[] = [];
  for (const o of orders) {
    const cancelled = /cancel/i.test(o.status);
    const at = Date.parse(o.created_at);
    const src = tasks.filter(x => x.t.article === o.article && Date.parse(x.t.createdAt) <= at && at - Date.parse(x.t.createdAt) <= 72 * 3600_000)
      .sort((a, b) => b.t.createdAt.localeCompare(a.t.createdAt))[0];
    const profit = cancelled ? null : orderProfit(margins[o.article]?.input as OzonCalcInput | null, o.price, o.qty);
    const base = src?.t.base || margins[o.article]?.retail || 0;
    list.push({ posting: o.posting, article: o.article, name: names.get(o.article)?.name ?? '', scheme: o.scheme, status: o.status, cancelled,
      createdAt: o.created_at, qty: o.qty, price: o.price, customerPrice: o.customer_price, base: base || null,
      pct: base > 0 && o.price > 0 ? Math.round((1 - o.price / base) * 1000) / 10 : null,
      profit: profit == null ? null : Math.round(profit), by: src ? src.by : null });
    for (const a of [w30, o.created_at >= since7 ? w7 : null, src?.by === 'agent' ? byAgent : byHand, pa(o.article)]) {
      if (!a) continue;
      if (cancelled) { a.cancelled++; continue; }
      a.orders++; a.units += o.qty; a.revenue += o.price * o.qty;
      if (profit != null) { a.profit += profit; a.profitN++; }
    }
    if (!first || o.created_at < first) first = o.created_at;
  }
  const out = (a: Agg) => ({ approved: a.approved, orders: a.orders, cancelled: a.cancelled, units: a.units,
    conv: a.approved ? Math.round(a.orders / a.approved * 1000) / 10 : null, revenue: Math.round(a.revenue),
    profit: a.profitN ? Math.round(a.profit) : null, marginPct: a.profitN && a.revenue > 0 ? Math.round(a.profit / a.revenue * 1000) / 10 : null,
    avgPct: a.pctN ? Math.round(a.pctSum / a.pctN * 10) / 10 : null });
  const products = [...per.entries()].map(([article, a]) => ({ article, name: names.get(article)?.name ?? '', photo: names.get(article)?.photo ?? '', ...out(a) }))
    .sort((a, b) => b.orders - a.orders || b.approved - a.approved);
  return { since: first || null, ordersAt: Number(adsMetaGet(ORDERS_KEY) || 0) || null, w7: out(w7), w30: out(w30), agent: out(byAgent), hand: out(byHand), products, orders: list.slice(0, 200) };
}

// ─── Напоминание в чат «AV | OZON»: товары без правила ─────────────────────
//
// 08.11 (просьба владельца): у нового товара не выбран режим — каждые 6 часов писать в чат
// Ozon-команды, пока менеджер не задаст размер скидки (или мин. маржу) либо «Отклонять».
// «Без правила» — нет правила, режим снят, или «Одобрять» без скидки и без маржи
// (агент такие заявки не трогает). Первое сообщение — как только товар появился; ночью
// (22:00–09:00 МСК) не пишем — отправим в 09:00. Отметка последней отправки — в ad_meta.

const UNSET_EVERY_MS = 6 * 3600_000;
const UNSET_KEY = 'discounts:ozon:unsetNotifyAt';
const SITE_DISCOUNTS = 'https://e-avtovibe.ru/#prices-discounts';

export function unsetProducts(rules: Record<string, DiscountRule>, articles: string[]): { article: string; why: string }[] {
  const out: { article: string; why: string }[] = [];
  for (const a of articles) {
    const r = rules[a];
    if (!r || r.mode === 'manual') out.push({ article: a, why: 'режим не выбран' });
    else if (r.mode === 'approve' && r.maxPct == null && r.minMargin == null) out.push({ article: a, why: '«Одобрять», но не задан размер скидки' });
  }
  return out;
}

/**
 * Карточки для выкупов (решение владельца 08.11): наша цена в ЛК ниже 200 ₽ за штуку.
 * Решение по ним не нужно — товару без правила агент сам ставит «Отклонять» и не пишет
 * о нём в чат. Выбор менеджера не трогаем: только товары, где правила ещё нет.
 */
export const BUYOUT_PRICE_MAX = 200;
export function isBuyoutCard(price: number | null | undefined): boolean {
  return price != null && price > 0 && price < BUYOUT_PRICE_MAX;
}

async function notifyUnset(): Promise<void> {
  try {
    const margins = await inputs();
    const unset = unsetProducts(listRules(), Object.keys(margins));
    const buyouts = unset.filter(x => isBuyoutCard(margins[x.article]?.retail));
    if (buyouts.length) {
      saveRules({ articles: buyouts.map(x => x.article), mode: 'decline' }, `агент: цена ниже ${BUYOUT_PRICE_MAX} ₽ — карточка для выкупов`);
      console.log(`[discounts] «Отклонять» для карточек выкупов (цена < ${BUYOUT_PRICE_MAX} ₽): ${buyouts.map(x => x.article).join(', ')}`);
    }
    const skip = new Set(buyouts.map(x => x.article));
    const list = unset.filter(x => !skip.has(x.article)).sort((a, b) => a.article.localeCompare(b.article, 'ru'));
    if (!list.length) { adsMetaSet(UNSET_KEY, '0'); return; }
    const last = Number(adsMetaGet(UNSET_KEY) || 0);
    if (last && Date.now() - last < UNSET_EVERY_MS) return;
    const h = new Date(Date.now() + 3 * 3600_000).getUTCHours();
    if (h < 9 || h >= 22) return;
    const { tgSend, tgEscape: esc, OZON_CHAT_ID } = await import('./telegram');
    const names = new Map(rnpItems('ozon').map(i => [up(i.article || i.sku), i.name]));
    const rows = list.slice(0, 60).map((x, i) => `${i + 1}. <b>${esc(x.article)}</b>${names.get(x.article) ? ` — ${esc(String(names.get(x.article)).slice(0, 60))}` : ''} <i>(${esc(x.why)})</i>`);
    const text = [
      `⚠️ <b>Ozon, заявки на скидку: ${list.length === 1 ? 'у товара не выбрано правило' : `у ${list.length} товаров не выбрано правило`}</b>`,
      ...rows, list.length > 60 ? `…и ещё ${list.length - 60}` : '',
      '',
      `Заявки покупателей на эти товары агент не обрабатывает. Выберите «Одобрять» с размером скидки (или мин. маржой) либо «Отклонять»: <a href="${SITE_DISCOUNTS}">«Цены» → «Заявки на скидку»</a>.`,
      'Напоминание повторяется каждые 6 часов, пока правило не выбрано.',
    ].filter(s => s !== '').join('\n');
    if (await tgSend(text, OZON_CHAT_ID)) {
      adsMetaSet(UNSET_KEY, String(Date.now()));
      console.log(`[discounts] напоминание в чат Ozon: без правила ${list.length}`);
    }
  } catch (e) { console.warn('[discounts] напоминание не отправлено:', (e as Error).message); }
}

export function scheduleDiscounts(): void {
  setTimeout(() => { void runPass('старт'); setInterval(() => { void runPass(); }, POLL_MS).unref(); }, 90_000).unref();
  setTimeout(() => { void notifyUnset(); setInterval(() => { void notifyUnset(); }, 15 * 60_000).unref(); }, 120_000).unref();
  const orders = () => { if (process.env.OZON_CLIENT_ID && process.env.OZON_API_KEY) syncOrders().catch(e => console.warn("[discounts] заказы по заявкам:", (e as Error).message)); };
  setTimeout(() => { orders(); setInterval(orders, 10 * 60_000).unref(); }, 150_000).unref();
  const s = getDiscountSettings();
  console.log(`[discounts] заявки на скидку Ozon: опрос раз в 2 мин, автоответ ${s.auto ? 'ВКЛЮЧЁН' : 'выключен (только показ)'}`);
}

export async function handleDiscounts(req: any, res: any, sub: string, user: { name: string; role: string }): Promise<any> {
  try {
    if (req.method === 'GET') return res.status(200).json({ ok: true, ...(await overview(user.role === 'owner')) });
    const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body ?? {});
    switch (sub) {
      case 'rules': return res.status(200).json({ ok: true, saved: saveRules(b, user.name) });
      case 'settings':
        if (b?.auto !== undefined && user.role !== 'owner') return res.status(403).json({ ok: false, error: 'Включать и выключать агента может только владелец' });
        return res.status(200).json({ ok: true, settings: setDiscountSettings(b) });
      case 'apply': await applyManual(b, user.name); return res.status(200).json({ ok: true });
      case 'refresh': return res.status(200).json({ ok: true, summary: await runPass('кнопка «Обновить»') });
      default: return res.status(404).json({ ok: false, error: 'not_found' });
    }
  } catch (e) {
    return res.status(400).json({ ok: false, error: String((e as Error)?.message ?? e).slice(0, 300) });
  }
}
