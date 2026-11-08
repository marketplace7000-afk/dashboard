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
 * Как считаем маржу. Цены заявки (base_price − discount, approved_price) — это цены
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
  /** Что решил агент (для NEW/SEEN — что сделает сейчас). */
  decision: Decision | null;
  /** Ответ отправлен нашим агентом/кнопкой. */
  by: 'agent' | 'user' | null; byName: string | null; appliedAt: number | null; error: string | null;
};

const MP = 'ozon';
const POLL_MS = 2 * 60_000;
const HISTORY_EVERY_MS = 15 * 60_000;

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
  const maxPct = 'maxPct' in (input ?? {}) ? limitPct(input.maxPct, 'Скидка', 90) : undefined;
  const minMargin = 'minMargin' in (input ?? {}) ? limitPct(input.minMargin, 'Маржа', 90) : undefined;
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

/** Что делать с заявкой. Чистая функция — проверяется в scripts/check-discounts.ts. */
export function decide(t: Pick<DiscountTask, 'showcase' | 'requested'>, rule: DiscountRule | undefined, defaultMode: 'manual' | 'decline', input: OzonCalcInput | null | undefined): Decision {
  const skip = (reason: string): Decision => ({ action: 'skip', price: null, pct: null, marginPct: null, reason });
  const mode = rule ? rule.mode : defaultMode;
  if (mode === 'manual') return skip('режим не выбран — обработать вручную');
  if (mode === 'decline') return { action: 'decline', price: null, pct: null, marginPct: null, reason: rule ? 'товар в списке «отклонять»' : 'для товара нет правила — по умолчанию отклоняем' };

  const show = t.showcase;
  if (!(show > 0) || !(t.requested > 0)) return skip('в заявке нет цены — обработать вручную');
  if (rule!.maxPct == null && rule!.minMargin == null) return skip('не задана ни скидка, ни мин. маржа — обработать вручную');
  let allowed = rule!.maxPct ?? 90;
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
  const price = Math.ceil(show * (1 - allowed / 100));
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
  const r = await fetch(`https://api-seller.ozon.ru/${path}`, { method: 'POST', headers: ozHeaders(), body: raw, signal: AbortSignal.timeout(30_000) });
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
}

/** Ответить Ozon пачкой. Возвращает ошибки по номерам заявок. */
async function send(kind: 'approve' | 'decline', tasks: { t: ReturnType<typeof toTask>; d: Decision }[]): Promise<Map<string, string>> {
  const errs = new Map<string, string>();
  for (let i = 0; i < tasks.length; i += 50) {
    const part = tasks.slice(i, i + 50);
    const body = kind === 'approve'
      ? { tasks: part.map(({ t, d }) => ({ id: t.id, approved_price: d.price, seller_comment: '', approved_quantity_min: t.qtyMin, approved_quantity_max: t.qtyMax })) }
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

let busy = false;
let lastRun = 0, lastHistory = 0;
let lastError: string | null = null;
let lastSummary = '';

async function inputs(): Promise<Record<string, MarginRow>> {
  try { return (await getMargins('ozon')).items; } catch { return {}; }
}

export async function runPass(why = 'по таймеру'): Promise<string> {
  if (busy) return 'уже идёт';
  if (!process.env.OZON_CLIENT_ID || !process.env.OZON_API_KEY) return 'нет ключа Ozon';
  busy = true;
  try {
    const pending = [...await fetchStatus('NEW', 20), ...await fetchStatus('SEEN', 20)];
    saveRaw(pending);
    if (Date.now() - lastHistory > HISTORY_EVERY_MS) {
      saveRaw([...await fetchStatus('APPROVED', 2), ...await fetchStatus('DECLINED', 2)]);
      lastHistory = Date.now();
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
      for (const { t, d } of approve) markApplied(t.id, 'agent', 'агент', d, e1.get(t.id) ?? null);
      for (const { t, d } of decline) markApplied(t.id, 'agent', 'агент', d, e2.get(t.id) ?? null);
      const failed = e1.size + e2.size;
      summary += `; одобрено ${approve.length - e1.size}, отклонено ${decline.length - e2.size}${failed ? `, ошибок ${failed}` : ''}`;
      if (approve.length || decline.length) console.log(`[discounts] ${why}: ${summary}`);
      // Статусы обработанных — сразу, чтобы на экране они не висели «в ожидании».
      if (approve.length || decline.length) saveRaw([...await fetchStatus('NEW', 20), ...await fetchStatus('SEEN', 20)]);
    }
    lastRun = Date.now(); lastError = null; lastSummary = summary;
    return summary;
  } catch (e) {
    lastError = (e as Error).message.slice(0, 300);
    console.warn('[discounts]', lastError);
    return lastError;
  } finally { busy = false; }
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
  return { settings: s, canToggle: isOwner, lastRun, lastError, lastSummary, products, tasks };
}

export function scheduleDiscounts(): void {
  setTimeout(() => { void runPass('старт'); setInterval(() => { void runPass(); }, POLL_MS).unref(); }, 90_000).unref();
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
