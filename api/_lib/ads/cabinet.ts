/**
 * Конкуренты и позиции из аналитики кабинетов — Агент 3 «Реклама», сценарий
 * competitor_watch на ПК (14.10.2026). Форматы — docs/ads-system/КАБИНЕТЫ_ДАННЫЕ_2026-10-14.md.
 *
 * Хост присылает сырые ответы кабинета; здесь храним снимок (ads.sqlite,
 * последние 30 на площадку) и разбираем последний для вкладки «Конкуренты».
 */
import { adsDb, listFlags, type AdMp } from './store';
import { DEFAULT_AGENT_SETTINGS } from '../../../shared/agents';
import type { Ads2CompRefresh, Ads2Competitors, Ads2OzMarketItem, Ads2WatchLink, Ads2WatchProduct, Ads2WbPosItem } from '../../../shared/ads2';
import { createTask, listSchedules, listTasks, nextCronRun } from '../agentQueue';
import {
  getAllLinks, suggestLinks, watchedIds, addLink, setLinkStatus, removeLink, parseNmId, parseOzonSku, getLatestPrices,
  type CompetitorLink, type WatchStatus,
} from '../competitorWatch';
import { rnpInStockSkus, rnpItems } from '../rnp';
import { wbImageUrl } from '../wbBasket';

const KEEP = 30;

let tablesReady = false;
function db(): any {
  const d = adsDb();
  if (!d) throw new Error('хранилище рекламы недоступно');
  if (!tablesReady) {
    d.exec(`CREATE TABLE IF NOT EXISTS ad_cabinet_snapshot (
      id INTEGER PRIMARY KEY AUTOINCREMENT, mp TEXT NOT NULL, at INTEGER NOT NULL, json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS ad_cab_mp ON ad_cabinet_snapshot (mp, at);
      -- 15.10: история карточек на витрине (конкуренты и наши) — строка на товар в день, последний замер дня.
      -- Из неё: свежая цена между ночными проходами и «конкурент снизил цену» для советника.
      CREATE TABLE IF NOT EXISTS ad_comp_card (
        mp TEXT NOT NULL, id TEXT NOT NULL, date TEXT NOT NULL, at INTEGER NOT NULL,
        price REAL, rating REAL, feedbacks INTEGER, stock INTEGER, name TEXT, seller TEXT, photo TEXT, price_at INTEGER,
        PRIMARY KEY (mp, id, date));
      -- 15.10: проходы агента по витрине — когда сняты цены (для «цены сняты сегодня в 11:42»).
      CREATE TABLE IF NOT EXISTS ad_comp_pass (
        mp TEXT NOT NULL, at INTEGER NOT NULL, light INTEGER NOT NULL, cards INTEGER NOT NULL, priced INTEGER NOT NULL, errors INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS ad_comp_pass_mp ON ad_comp_pass (mp, at);
      -- 15.10: позиция наших карточек WB в поиске за вчера (отчёт «Поисковые запросы» за один день).
      CREATE TABLE IF NOT EXISTS ad_pos_daily (
        mp TEXT NOT NULL, date TEXT NOT NULL, id TEXT NOT NULL,
        pos REAL, views INTEGER, open_card INTEGER, carts INTEGER, orders INTEGER,
        PRIMARY KEY (mp, date, id));`);
    // price_at появился позже самой таблицы — у баз, созданных до него, добавить колонку.
    if (!(d.prepare('PRAGMA table_info(ad_comp_card)').all() as any[]).some(c => c.name === 'price_at')) d.exec('ALTER TABLE ad_comp_card ADD COLUMN price_at INTEGER');
    tablesReady = true;
  }
  return d;
}

const mskDay = (ms: number) => new Date(ms + 3 * 3600_000).toISOString().slice(0, 10);

/** Карточки витрины из прохода агента → история (строка на товар в день). */
function saveCards(mp: AdMp, cards: any[], at: number): { n: number; priced: number } {
  const d = db();
  const date = mskDay(at);
  // price_at — когда снята именно цена: если в этот проход цену не отдали, остаётся время прошлого замера
  // (менеджер видит «цена от 05:43», а не выдаём утреннюю цену за дневную).
  const st = d.prepare(`INSERT INTO ad_comp_card (mp, id, date, at, price, rating, feedbacks, stock, name, seller, photo, price_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(mp, id, date) DO UPDATE SET at = excluded.at,
      price_at = CASE WHEN excluded.price IS NOT NULL OR excluded.stock = 0 THEN excluded.at ELSE ad_comp_card.price_at END,
      price = CASE WHEN excluded.price IS NULL AND excluded.stock = 0 THEN NULL ELSE COALESCE(excluded.price, ad_comp_card.price) END, rating = COALESCE(excluded.rating, ad_comp_card.rating),
      feedbacks = COALESCE(excluded.feedbacks, ad_comp_card.feedbacks), stock = excluded.stock,
      name = COALESCE(NULLIF(excluded.name, ''), ad_comp_card.name), seller = COALESCE(NULLIF(excluded.seller, ''), ad_comp_card.seller),
      photo = COALESCE(NULLIF(excluded.photo, ''), ad_comp_card.photo)`);
  let n = 0, priced = 0;
  d.exec('BEGIN');
  try {
    for (const c of cards) {
      const id = String(c?.id ?? c?.sku ?? '').trim();
      if (!/^\d+$/.test(id)) continue;
      // Ozon не отдаёт остаток — только «можно купить»: false → 0, иначе неизвестно.
      const stock = num(c.qty) ?? (c.available === false ? 0 : null);
      const price = num(c.price);
      st.run(mp, id, date, at, price, num(c.rating), num(c.feedbacks ?? c.reviews), stock,
        String(c.name ?? ''), String(c.seller ?? c.supplier ?? ''), String(c.photo ?? ''), price != null || stock === 0 ? at : null);
      n++;
      if (price != null || stock === 0) priced++;
    }
    d.exec('COMMIT');
  } catch (e) { d.exec('ROLLBACK'); throw e; }
  d.prepare(`DELETE FROM ad_comp_card WHERE mp = ? AND date < ?`).run(mp, mskDay(at - 120 * 86_400_000));
  return { n, priced };
}

/** WB: позиции наших карточек за вчера и позавчера (отчёт за один день) → история по дням. */
function savePosDaily(mp: AdMp, daily: any): number {
  if (!daily || typeof daily !== 'object') return 0;
  const d = db();
  const st = d.prepare(`INSERT OR REPLACE INTO ad_pos_daily (mp, date, id, pos, views, open_card, carts, orders) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  let n = 0;
  for (const day of Array.isArray(daily) ? daily : [daily]) {
    const date = String(day?.date ?? '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    for (const g of day?.report?.groups ?? []) for (const it of g.items ?? []) {
      if (!it?.nmId) continue;
      st.run(mp, date, String(it.nmId), cur(it.avgPosition), cur(it.views), cur(it.openCard), cur(it.addToCart), cur(it.orders));
      n++;
    }
  }
  return n;
}

/** Последняя карточка по каждому номеру + цена сутки и неделю назад (для «−8% за сутки»). */
export function cardHistory(mp: AdMp, ids: string[]): Map<string, { at: number; date: string; price: number | null; rating: number | null; feedbacks: number | null; stock: number | null; name: string; seller: string; photo: string; price1d: number | null; price7d: number | null }> {
  const out = new Map<string, any>();
  if (!ids.length) return out;
  const d = db();
  const rows = d.prepare(`SELECT * FROM ad_comp_card WHERE mp = ? AND date >= ? ORDER BY id, date`).all(mp, mskDay(Date.now() - 10 * 86_400_000)) as any[];
  const want = new Set(ids);
  const by = new Map<string, any[]>();
  for (const r of rows) if (want.has(r.id)) { const a = by.get(r.id) ?? []; a.push(r); by.set(r.id, a); }
  for (const [id, a] of by) {
    const last = a[a.length - 1];
    const before = (days: number) => {
      const lim = mskDay(Date.parse(last.date + 'T12:00:00Z') - days * 86_400_000);
      for (let i = a.length - 2; i >= 0; i--) if (a[i].date <= lim && a[i].price != null) return Number(a[i].price);
      return null;
    };
    // Цена — из последнего замера, где её действительно сняли (сегодня или раньше), со своим временем.
    let pr = last;
    for (let i = a.length - 1; i >= 0; i--) if (a[i].price_at != null) { pr = a[i]; break; }
    out.set(id, { at: Number(pr.price_at ?? pr.at), date: last.date, price: pr.price, rating: last.rating, feedbacks: last.feedbacks, stock: last.stock,
      name: last.name ?? '', seller: last.seller ?? '', photo: last.photo ?? '', price1d: before(1), price7d: before(7) });
  }
  return out;
}

/** Ряды витрины по дням: номер → дата → цена/остаток (для советника). */
export function compCardSeries(mp: AdMp, ids: string[], from: string, to: string): Map<string, Map<string, { price: number | null; stock: number | null }>> {
  const out = new Map<string, Map<string, { price: number | null; stock: number | null }>>();
  if (!ids.length) return out;
  const want = new Set(ids);
  for (const r of db().prepare('SELECT id, date, price, stock FROM ad_comp_card WHERE mp = ? AND date >= ? AND date <= ? ORDER BY date').all(mp, from, to) as any[]) {
    if (!want.has(r.id)) continue;
    const m = out.get(r.id) ?? new Map();
    m.set(r.date, { price: r.price == null ? null : Number(r.price), stock: r.stock == null ? null : Number(r.stock) });
    out.set(r.id, m);
  }
  return out;
}

/** WB: позиция наших карточек по дням: nm → дата → позиция. */
export function posSeries(mp: AdMp, from: string, to: string): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>();
  for (const r of db().prepare('SELECT id, date, pos FROM ad_pos_daily WHERE mp = ? AND date >= ? AND date <= ? AND pos IS NOT NULL').all(mp, from, to) as any[]) {
    const m = out.get(r.id) ?? new Map();
    m.set(r.date, Number(r.pos));
    out.set(r.id, m);
  }
  return out;
}

/** Записать снимок; вернуть короткую сводку для «Сборщиков». */
export function saveCabinetSnapshot(mp: AdMp, data: any): string {
  if (!data || typeof data !== 'object') throw new Error('пустой снимок');
  const d = db();
  const at = Date.now();
  const saved = Array.isArray(data.cards) ? saveCards(mp, data.cards, at) : { n: 0, priced: 0 };
  const cardsN = saved.n;
  const errN = Array.isArray(data.errors) ? data.errors.length : 0;
  if (cardsN) d.prepare('INSERT INTO ad_comp_pass (mp, at, light, cards, priced, errors) VALUES (?, ?, ?, ?, ?, ?)').run(mp, at, data.light ? 1 : 0, cardsN, saved.priced, errN);
  d.prepare('DELETE FROM ad_comp_pass WHERE mp = ? AND at < ?').run(mp, at - 60 * 86_400_000);
  // Быстрый проход днём (только карточки витрины) — в историю карточек, полный снимок кабинета не трогаем.
  if (data.light) return `${mp === 'wb' ? 'WB' : 'Ozon'}: быстрое обновление — карточек на витрине ${cardsN}, с ценой ${saved.priced}${errN ? `, ошибок ${errN}` : ''}`;
  const posN = savePosDaily(mp, data.daily);
  d.prepare('INSERT INTO ad_cabinet_snapshot (mp, at, json) VALUES (?, ?, ?)').run(mp, at, JSON.stringify(data));
  d.prepare(`DELETE FROM ad_cabinet_snapshot WHERE mp = ? AND id NOT IN (SELECT id FROM ad_cabinet_snapshot WHERE mp = ? ORDER BY at DESC LIMIT ?)`).run(mp, mp, KEEP);
  let suggested = 0;
  try { suggested = autoSuggest(mp, data); } catch (e) { console.warn('[competitors] предложения не собраны:', (e as Error).message); }
  const sug = suggested ? `, предложено конкурентов ${suggested}` : '';
  const cards = Array.isArray(data.cards) ? `, карточек конкурентов ${data.cards.length}` : '';
  if (mp === 'wb') {
    const items = (data.report?.groups ?? []).reduce((s: number, g: any) => s + (g.items?.length ?? 0), 0);
    const pos = data.report?.positionInfo?.average?.current;
    const opened = Array.isArray(data.compDetails) ? `, отчётов сравнения ${data.compDetails.length}` : '';
    return `WB: карточек с позициями ${items}${pos != null ? `, средняя позиция ${pos}` : ''}${posN ? `, позиций по дням ${posN}` : ''}, наборов сравнения ${data.comparisons?.history?.length ?? 0}${opened}${cards}${sug}`;
  }
  const items = (data.markets ?? []).reduce((s: number, m: any) => s + (m.items?.length ?? 0), 0);
  const p = data.positions?.[0]?.days?.at?.(-1);
  return `Ozon: категорий ${data.markets?.length ?? 0}, товаров рынка ${items}${p ? `, наше место ${p.my_position} из ${p.all_sellers}` : ''}${cards}${sug}`;
}

// ─── Привязка конкурентов к нашим товарам ───────────────────────────────────
// Хранилище — общее с карточкой товара (../competitorWatch.ts, файл av-data/competitors.json):
// ключ — наш артикул продавца, у каждой привязки источник (manual/auto) и статус
// (active — подтверждён, suggested — предложен системой, ignored — «не мой конкурент»).

const up = (s: unknown) => String(s ?? '').trim().toUpperCase();

const WORD_STOP = new Set(['подар', 'набор', 'компл', 'новый', 'новин', 'качес', 'лучши', 'товар', 'black', 'white', 'черны', 'белый']);
/** Значимые слова названия: от 4 букв, без цифр, по первым 5 буквам (грубая основа: «адаптер/адаптера»). */
export function titleWords(s: string): Set<string> {
  const out = new Set<string>();
  for (const w of s.toLowerCase().replace(/ё/g, 'е').split(/[^a-zа-я0-9]+/)) {
    if (w.length < 4 || /\d/.test(w)) continue;
    const st = w.slice(0, 5);
    if (!WORD_STOP.has(st)) out.add(st);
  }
  return out;
}

/** Наш справочник: артикул продавца ↔ номер на площадке (WB nmID, Ozon SKU). */
function ourCatalog(mp: AdMp): { byKey: Map<string, { id: string; name: string; photo: string; active?: boolean }>; byId: Map<string, string> } {
  const byKey = new Map<string, { id: string; name: string; photo: string; active?: boolean }>();
  const byId = new Map<string, string>();
  const active = rnpInStockSkus(mp);
  for (const r of rnpItems(mp)) {
    const key = up(mp === 'wb' ? r.article : (r.article || r.sku));
    const id = mp === 'wb' ? r.sku : r.extId;
    if (!key) continue;
    if (!byKey.has(key)) byKey.set(key, { id: id || '', name: r.name, photo: r.photo, active: active.has(r.sku) });
    else if (active.has(r.sku)) byKey.get(key)!.active = true;
    if (id) byId.set(String(id), key);
  }
  return { byKey, byId };
}

/**
 * Предложить конкурентов из того, что агент снял в кабинете:
 *  WB  — товары из наборов «Сравнение карточек» (их собирают менеджеры) к нашему товару того же набора;
 *  Ozon — 5 лидеров по выручке в категории нашего товара («Товары на Ozon»).
 * Только «предложены»: в расчёты не идут, пока менеджер не подтвердит.
 */
export function autoSuggest(mp: AdMp, data: any): number {
  const { byId } = ourCatalog(mp);
  let n = 0;
  if (mp === 'wb') {
    for (const it of data?.report?.groups?.flatMap((g: any) => g.items ?? []) ?? []) if (it.nmId && it.vendorCode) byId.set(String(it.nmId), up(it.vendorCode));
    for (const h of data?.comparisons?.history ?? []) {
      const nms = (h.nms ?? []).filter((x: any) => x?.nmID && !x.isDeleted);
      const ours = nms.filter((x: any) => byId.has(String(x.nmID)));
      const others = nms.filter((x: any) => !byId.has(String(x.nmID)));
      for (const o of ours) n += suggestLinks('wb', byId.get(String(o.nmID))!, others.map((x: any) => ({ id: Number(x.nmID), title: String(x.nmName ?? ''), note: `из сравнения WB ${String(h.date ?? '')}`.trim() })));
    }
    return n;
  }
  const ourSeller = String(process.env.OZON_CLIENT_ID || '').trim();
  for (const m of data?.markets ?? []) {
    const items = m.items ?? [];
    const isOurs = (x: any) => (!!ourSeller && String(x.sellerId) === ourSeller) || !!x.blockedAsYourGood || byId.has(String(x.sku));
    const others = items.filter((x: any) => !isOurs(x));
    for (const o of items.filter(isOurs)) {
      const key = byId.get(String(o.sku)) ?? up(o.article);
      if (!key) continue;
      // Категория широкая (в «Устройство головное» и адаптер за 1,5 тыс., и бокс за 20 тыс.),
      // поэтому конкурент — лидер по выручке в коридоре цены нашего товара: от половины до двух цен.
      // Плюс хотя бы одно общее значимое слово в названии: иначе к адаптеру CarPlay попадают магнитолы.
      const our = num(o.avgPrice);
      const ourWords = titleWords(String(o.name ?? o.skuName ?? ''));
      const leaders = others
        .filter((x: any) => { const p = num(x.avgPrice); return !our || (p != null && p >= our / 2 && p <= our * 2); })
        .map((x: any, i: number) => ({ x, i, common: Math.min(3, [...titleWords(String(x.name ?? x.skuName ?? ''))].filter(w => ourWords.has(w)).length) }))
        .filter(c => !ourWords.size || c.common > 0)
        .sort((a, b) => b.common - a.common || a.i - b.i)
        .slice(0, 5).map(c => c.x);
      n += suggestLinks('ozon', key, leaders.map((x: any) => ({ id: Number(x.sku), title: String(x.name ?? x.skuName ?? ''), brand: String(x.brand ?? ''), note: `лидер Ozon «${String(x.category3 ?? '')}», цена и название близки к нашим` })), 5, true);
    }
  }
  return n;
}

/** Параметры задания competitor_watch: кого снимать на витрине (конкуренты + наши товары с привязками). */
export function watchParams(mp: AdMp): { watch: number[]; ours: number[] } {
  const { byKey } = ourCatalog(mp);
  const ours: number[] = [];
  for (const key of Object.keys(getAllLinks(mp))) {
    const id = Number(byKey.get(key)?.id);
    if (Number.isFinite(id) && id > 0) ours.push(id);
  }
  return { watch: watchedIds(mp, 80), ours: ours.slice(0, 40) };
}

/**
 * Правка привязок менеджером: add (ссылка или артикул конкурента), approve (взять в расчёт),
 * ignore («не мой конкурент» — система больше не предложит), restore, remove.
 */
export function editWatch(b: any): { ok: true } | { ok: false; error: string } {
  const mp: AdMp = b?.mp === 'ozon' ? 'ozon' : 'wb';
  const sku = up(b?.sku);
  if (!sku) return { ok: false, error: 'Выберите наш товар' };
  const action = String(b?.action ?? 'add');
  if (action === 'add') {
    const raw = String(b?.link ?? '').trim();
    const id = mp === 'wb' ? parseNmId(raw) : parseOzonSku(raw);
    if (!id) return { ok: false, error: mp === 'wb' ? 'Не разобрал артикул: нужна ссылка wildberries.ru/catalog/… или номер' : 'Не разобрал SKU: нужна ссылка ozon.ru/product/… или номер SKU' };
    if (mp === 'wb' && /ozon\./i.test(raw)) return { ok: false, error: 'Это ссылка Ozon — переключитесь на Ozon' };
    if (mp === 'ozon' && /wildberries|wb\.ru/i.test(raw)) return { ok: false, error: 'Это ссылка WB — переключитесь на WB' };
    const { byId } = ourCatalog(mp);
    if (byId.has(String(id))) return { ok: false, error: `Это наш товар (${byId.get(String(id))}), а не конкурент` };
    addLink(sku, id, { mp, source: 'manual', note: b?.note ? String(b.note).slice(0, 120) : undefined });
    // Цифры по новому конкуренту — быстрым проходом через пару минут, не ждать ночи
    // (задержка — чтобы привязки пачкой ушли одним заданием).
    try { requestRefresh(mp, 'manager', 2); } catch (e) { console.warn('[competitors] обновление не поставлено:', (e as Error).message); }
    return { ok: true };
  }
  const id = Number(b?.id);
  if (!Number.isFinite(id) || id <= 0) return { ok: false, error: 'нет номера конкурента' };
  if (action === 'remove') { removeLink(sku, id, mp); return { ok: true }; }
  const st: Record<string, WatchStatus> = { approve: 'active', ignore: 'ignored', restore: 'suggested' };
  if (!st[action]) return { ok: false, error: `неизвестное действие ${action}` };
  setLinkStatus(sku, id, st[action], mp);
  return { ok: true };
}

const num = (v: unknown): number | null => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const cur = (v: any): number | null => num(v?.current ?? v);
const dyn = (v: any): number | null => num(v?.dynamics);

/** Факторы ранжирования WB → подписи. Ключи — как в ответе table/recommendations. */
export const WB_FACTOR_LABEL: Record<string, string> = {
  conversion: 'низкая конверсия', moneyAmount: 'мало продаж в деньгах', action: 'нет акции', logistic: 'логистика/срок доставки',
  boostNmRating: 'рейтинг карточки', boostSellerRating: 'рейтинг продавца', disturbing: 'тревожный контент', marketingOnImage: 'реклама на фото',
  blur: 'размытые фото', marketingCharc: 'реклама в характеристиках', aiText: 'текст похож на ИИ', sameBg: 'одинаковый фон фото',
  badPkg: 'упаковка на фото', untidy: 'неопрятные фото',
};

export function parseWb(data: any): NonNullable<Ads2Competitors['wb']> {
  const rep = data?.report ?? {};
  const bad = new Map<string, string[]>();
  for (const r of data?.recommendations ?? []) {
    bad.set(String(r.nmID), Object.entries(WB_FACTOR_LABEL).filter(([k]) => r?.[k] === 'bad').map(([, l]) => l));
  }
  const items: Ads2WbPosItem[] = [];
  for (const g of rep.groups ?? []) for (const it of g.items ?? []) {
    items.push({
      nmId: String(it.nmId), name: String(it.name ?? ''), vendorCode: String(it.vendorCode ?? ''), photo: String(it.mainPhoto ?? ''),
      subject: String(it.subjectName ?? ''), isAdvertised: !!it.isAdvertised,
      price: num(it.price?.minPrice), rating: num(it.rating), feedbackRating: num(it.feedbackRating),
      avgPos: cur(it.avgPosition), avgPosDyn: dyn(it.avgPosition), views: cur(it.views), viewsDyn: dyn(it.views),
      ctr: cur(it.ctr), openCard: cur(it.openCard), orders: cur(it.orders), ordersDyn: dyn(it.orders), visibility: cur(it.visibility),
      bad: bad.get(String(it.nmId)) ?? [],
    });
  }
  const ours = new Set(items.map(i => i.nmId));
  const free = new Set((data?.comparisons?.limits?.availableWithoutCharge ?? []).map((s: number[]) => [...s].map(String).sort().join(',')));
  const opened = new Set((data?.compDetails ?? []).map((c: any) => String(c.id)));
  const lim = data?.comparisons?.limits ?? {};
  return {
    period: data?.period ?? null,
    summary: {
      avgPos: cur(rep.positionInfo?.average), avgPosDyn: dyn(rep.positionInfo?.average), medianPos: cur(rep.positionInfo?.median),
      visibility: cur(rep.visibilityInfo?.visibility), advertised: cur(rep.commonInfo?.advertisedProducts), total: num(rep.commonInfo?.totalProducts),
    },
    items,
    comparisons: {
      thisMonth: num(lim.comparisonsThisMonth), remaining: num(lim.remainingComparisonsThisMonth),
      agentLimit: DEFAULT_AGENT_SETTINGS.wb_comparisons_month_limit,
      sets: (data?.comparisons?.history ?? []).map((h: any) => {
        const nms = (h.nms ?? []).map((n: any) => ({ nmId: String(n.nmID), name: String(n.nmName ?? ''), photo: String(n.mainPhoto ?? ''), ours: ours.has(String(n.nmID)) }));
        return { date: String(h.date ?? ''), free: free.has(nms.map((n: any) => n.nmId).sort().join(',')), opened: opened.has(String(h.ID)), nms };
      }),
    },
  };
}

export function parseOzon(data: any, ourSellerId: string): NonNullable<Ads2Competitors['ozon']> {
  const toItem = (x: any, i: number): Ads2OzMarketItem => ({
    rank: i + 1, sku: String(x.sku ?? ''), name: String(x.name ?? x.skuName ?? ''), link: String(x.link ?? ''), photo: String(x.photo ?? ''),
    seller: String(x.sellerName ?? ''), ours: (!!ourSellerId && String(x.sellerId) === ourSellerId) || !!x.blockedAsYourGood,
    price: num(x.avgPrice), gmv: num(x.gmvSum ?? x.soldSum), sold: num(x.soldCount), salesDyn: num(x.salesDynamics),
    convSearch: num(x.convToCartSearch), convPdp: num(x.pdpToCartConversion ?? x.convToCartPdp), drr: num(x.drr),
    daysInPromo: num(x.daysInPromo), daysWithTrafarets: num(x.daysWithTrafarets),
  });
  const categories = (data?.markets ?? []).map((m: any) => {
    const all: Ads2OzMarketItem[] = (m.items ?? []).map(toItem);
    const b = m.benchmark ?? {};
    return {
      category3Id: String(m.category3Id), name: String(m.items?.[0]?.category3 ?? m.category3Id), updateDate: m.updateDate ?? null,
      ours: all.filter(x => x.ours), top: all.slice(0, 10),
      benchmark: { price: num(b.avgGmv), convSearch: num(b.convToCartSearch), convPdp: num(b.pdpToCartConversion), drr: num(b.drr) },
    };
  });
  const positions = (data?.positions ?? []).map((p: any) => {
    // В последний день место бывает 0 (продаж ещё нет) — берём последний день с местом.
    const days = p.days ?? [];
    const last = [...days].reverse().find((d: any) => Number(d?.my_position) > 0) ?? days.at(-1) ?? {};
    const ch = p.chart ?? {};
    const byDate = new Map<string, { my: number | null; competitor: number | null; best: number | null }>();
    const put = (arr: any[], k: 'my' | 'competitor' | 'best') => {
      for (const x of arr ?? []) {
        const e = byDate.get(x.start_date) ?? { my: null, competitor: null, best: null };
        e[k] = num(x.value);
        byDate.set(x.start_date, e);
      }
    };
    put(ch.my_index, 'my'); put(ch.closest_competitor, 'competitor'); put(ch.best_seller, 'best');
    // Имени категории 2-го уровня в ответах нет — называем по типам наших рынков внутри неё.
    const inside = (data?.markets ?? []).filter((m: any) => (m.items ?? []).some((x: any) => String(x.category2Id) === String(p.category2Id)))
      .map((m: any) => String(m.items?.[0]?.category3 ?? '')).filter(Boolean);
    return {
      category2Id: String(p.category2Id), name: inside.join(', ') || `категория ${p.category2Id}`, myPosition: num(last.my_position), myPositionDyn: num(last.my_position_dynamics),
      sellers: num(last.all_sellers), competitor: ch.competitor_name ?? null, percentDiff: num(ch.percent_diff),
      series: [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, v]) => ({ date, ...v })),
    };
  });
  return { categories, positions };
}

const blankLink = (id: string, mp: AdMp): Ads2WatchLink => ({
  id, url: mp === 'wb' ? `https://www.wildberries.ru/catalog/${id}/detail.aspx` : `https://www.ozon.ru/product/${id}/`,
  source: 'manual', status: 'active', title: '', brand: '', seller: '', note: '', photo: '',
  price: null, rating: null, feedbacks: null, stock: null, orders: null, ordersDyn: null, avgPos: null, ctr: null, openCard: null,
  inAds: null, inPromo: null, gmv: null, drr: null, ordersDays: null, convPdp: null, priceAt: null, price1d: null, price7d: null,
});

/** Фото карточки WB по номеру (basket-CDN, как на витрине). */
function wbPhoto(nm: string): string {
  const n = Number(nm);
  return Number.isFinite(n) && n > 0 ? wbImageUrl(n, 1, 'c246x328') : '';
}

/** Цифры по номеру товара из всего, что агент снял этой ночью. */
function metricsIndex(mp: AdMp, data: any): Map<string, Partial<Ads2WatchLink>> {
  const m = new Map<string, Partial<Ads2WatchLink>>();
  const put = (id: string, v: Partial<Ads2WatchLink>) => {
    const cur = m.get(id) ?? {};
    for (const [k, x] of Object.entries(v)) if (x != null && x !== '' && (cur as any)[k] == null) (cur as any)[k] = x;
    m.set(id, cur);
  };
  for (const c of data?.cards ?? []) {
    const id = String(c.id ?? c.sku ?? '');
    if (!id) continue;
    put(id, {
      title: c.name ? String(c.name) : undefined, brand: c.brand ? String(c.brand) : undefined,
      seller: c.seller ?? c.supplier ? String(c.seller ?? c.supplier) : undefined, photo: c.photo ? String(c.photo) : undefined,
      price: num(c.price), rating: num(c.rating), feedbacks: num(c.feedbacks ?? c.reviews), stock: num(c.qty),
    });
  }
  if (mp === 'wb') {
    for (const set of data?.compDetails ?? []) for (const x of set.nms ?? []) {
      put(String(x.nmId), {
        title: x.name || undefined, brand: x.brand || undefined, photo: x.photo || undefined,
        price: num(x.medianPrice) || num(x.minPrice), rating: num(x.rating), feedbacks: num(x.feedbacks),
        orders: num(x.orders), ordersDyn: num(x.ordersDyn), ordersDays: num(x.orders) != null ? 30 : undefined, avgPos: num(x.avgPos), ctr: num(x.ctr), openCard: num(x.openCard),
        inAds: typeof x.inAds === 'boolean' ? x.inAds : null, inPromo: typeof x.inPromo === 'boolean' ? x.inPromo : null,
      });
    }
    for (const g of data?.report?.groups ?? []) for (const it of g.items ?? []) {
      put(String(it.nmId), { title: it.name || undefined, photo: it.mainPhoto || undefined, price: num(it.price?.minPrice), rating: num(it.feedbackRating),
        orders: cur(it.orders), ordersDyn: dyn(it.orders), ordersDays: cur(it.orders) != null ? 7 : undefined, avgPos: cur(it.avgPosition), ctr: cur(it.ctr), openCard: cur(it.openCard), inAds: !!it.isAdvertised });
    }
  } else {
    for (const mk of data?.markets ?? []) for (const x of mk.items ?? []) {
      put(String(x.sku), { title: x.name || undefined, brand: x.brand || undefined, seller: x.sellerName || undefined, photo: x.photo || undefined,
        price: num(x.avgPrice), gmv: num(x.gmvSum ?? x.soldSum), orders: num(x.soldCount), ordersDyn: num(x.salesDynamics),
        ordersDays: num(x.soldCount) != null ? 7 : undefined, drr: num(x.drr), convPdp: num(x.pdpToCartConversion ?? x.convToCartPdp),
        inPromo: num(x.daysInPromo) != null ? Number(x.daysInPromo) > 0 : null, inAds: num(x.daysWithTrafarets) != null ? Number(x.daysWithTrafarets) > 0 : null });
    }
  }
  return m;
}

/** Товары с конкурентами для вкладки: сначала те, у кого есть привязки, затем наши товары из снимка. */
export function buildWatch(mp: AdMp, data: any): { watch: Ads2WatchProduct[]; catalog: { key: string; name: string }[] } {
  const { byKey } = ourCatalog(mp);
  const links = getAllLinks(mp);
  const idx = metricsIndex(mp, data);
  const wbPrices = mp === 'wb' ? getLatestPrices(Object.values(links).flat().map(l => l.nmId)) : {};
  // Свежая витрина (в т.ч. дневные быстрые проходы) главнее ночного снимка: цена, рейтинг, отзывы, остаток.
  const ids = new Set<string>(Object.values(links).flat().map(l => String(l.nmId)));
  for (const v of byKey.values()) if (v.id) ids.add(String(v.id));
  const hist = cardHistory(mp, [...ids]);
  const fresh = (r: Ads2WatchLink): Ads2WatchLink => {
    const h = hist.get(r.id);
    if (!h) return r;
    return { ...r, price: h.price ?? r.price, rating: h.rating ?? r.rating, feedbacks: h.feedbacks ?? r.feedbacks, stock: h.stock ?? r.stock,
      title: r.title || h.name, seller: r.seller || h.seller, photo: r.photo || h.photo, priceAt: h.at, price1d: h.price1d, price7d: h.price7d };
  };
  const toLink = (l: CompetitorLink): Ads2WatchLink => {
    const id = String(l.nmId);
    const x = idx.get(id) ?? {};
    const r = fresh({ ...blankLink(id, mp), ...x, source: l.source, status: l.status, note: l.note ?? '' });
    if (!r.title) r.title = l.title ?? '';
    if (!r.brand) r.brand = l.brand ?? '';
    if (r.price == null && (wbPrices as any)[l.nmId]) r.price = (wbPrices as any)[l.nmId].price;
    if (!r.photo && mp === 'wb') r.photo = wbPhoto(id);
    return r;
  };
  const keys = new Set(Object.keys(links));
  // Наши товары из снимка — чтобы было к чему привязать конкурента прямо из списка
  // (и номер/название/фото, если справочник РНП товар ещё не знает).
  const fromSnap = new Map<string, { id: string; name: string; photo: string }>();
  if (mp === 'wb') for (const g of data?.report?.groups ?? []) for (const it of g.items ?? []) {
    if (it.vendorCode) fromSnap.set(up(it.vendorCode), { id: String(it.nmId ?? ''), name: String(it.name ?? ''), photo: String(it.mainPhoto ?? '') });
  }
  else for (const mk of data?.markets ?? []) for (const x of mk.items ?? []) {
    const ourSeller = String(process.env.OZON_CLIENT_ID || '').trim();
    if ((ourSeller && String(x.sellerId) === ourSeller) || x.blockedAsYourGood) fromSnap.set(up(x.article), { id: String(x.sku ?? ''), name: String(x.name ?? ''), photo: String(x.photo ?? '') });
  }
  for (const k of fromSnap.keys()) keys.add(k);
  // и все наши товары в наличии (остаток FBO+FBS > 0, как «В продаже» в «Ценах»), а не только попавшие в снимок кабинета;
  // архив без остатка и продаж не показываем — привязать к нему всё равно можно через поле «Наш товар»
  for (const [k, v] of byKey) if (v.id && v.active) keys.add(k);
  keys.delete('');
  // архив «Рекламы» (самовыкуп, дубли) здесь не показываем — по номеру товара на площадке
  const archived = new Set(listFlags().filter(f => f.mp === mp && f.archived).map(f => f.sku));
  for (const k of [...keys]) { const id = byKey.get(k)?.id || fromSnap.get(k)?.id; if (id && archived.has(String(id))) keys.delete(k); }
  const watch: Ads2WatchProduct[] = [...keys].map(key => {
    const cat = byKey.get(key)?.id ? byKey.get(key) : fromSnap.get(key) ?? byKey.get(key);
    const ourId = cat?.id ?? '';
    const ourM = ourId ? idx.get(ourId) : undefined;
    const our = ourId ? fresh({ ...blankLink(ourId, mp), ...(ourM ?? {}), title: cat?.name || ourM?.title || '', photo: cat?.photo || ourM?.photo || (mp === 'wb' ? wbPhoto(ourId) : '') }) : null;
    // Порядок — как привязаны (15.10, просьба владельца): «Подтвердить» и «Не наш» строку не двигают.
    const ls = (links[key] ?? []).map(toLink);
    return { key, ourId, name: cat?.name || our?.title || key, photo: our?.photo ?? '', our, links: ls };
  });
  // Порядок товаров не зависит от решений менеджера: сначала с привязками, внутри — по нашим заказам (самые продаваемые выше).
  watch.sort((a, b) => Number(b.links.length > 0) - Number(a.links.length > 0) || (b.our?.orders ?? -1) - (a.our?.orders ?? -1) || a.key.localeCompare(b.key, 'ru'));
  for (const [k, v] of fromSnap) if (!byKey.has(k)) byKey.set(k, v);
  const catalog = [...byKey.entries()].map(([key, v]) => ({ key, name: v.name })).sort((a, b) => a.key.localeCompare(b.key)).slice(0, 2000);
  return { watch, catalog };
}

// ─── Обновление в течение дня ───────────────────────────────────────────────
// Ночью (05:40 WB / 05:50 Ozon) — полный проход: аналитика кабинета + витрина.
// Днём (11:40, 16:40) и по кнопке / после привязки нового конкурента — быстрый проход
// (light): только карточки витрины привязанных конкурентов и наших товаров, 1–3 минуты.

const isMine = (t: { params: Record<string, unknown> }, mp: AdMp) => (t.params?.marketplace === 'ozon' ? 'ozon' : 'wb') === mp;

/** Слоты расписания «m h1,h2 * * *» (МСК) → «05:40», «11:40»… и последний наступивший слот (мс). */
function cronSlots(cron: string): string[] {
  const m = String(cron).trim().match(/^(\d{1,2})\s+([\d,]+)\s+\*\s+\*\s+\*$/);
  if (!m) return [];
  return m[2].split(',').map(h => `${h.padStart(2, '0')}:${m[1].padStart(2, '0')}`);
}
function lastCronSlot(cron: string, upTo: number): number | null {
  let t = nextCronRun(cron, upTo - 26 * 3600_000), last: number | null = null;
  for (let i = 0; t != null && t <= upTo && i < 30; i++) { last = t; t = nextCronRun(cron, t); }
  return last;
}

/** Пропущенный плановый проход: слот наступил, а витрину после него так и не сняли (ПК выключен, нет входа…). */
const MISSED_AFTER_MIN = 40;

export function refreshState(mp: AdMp, now = Date.now()): Ads2CompRefresh {
  const d = db();
  const full = d.prepare('SELECT max(at) at FROM ad_cabinet_snapshot WHERE mp = ?').get(mp) as any;
  const pass = d.prepare('SELECT * FROM ad_comp_pass WHERE mp = ? ORDER BY at DESC LIMIT 1').get(mp) as any;
  const cards = pass ? { at: pass.at } : d.prepare('SELECT max(at) at FROM ad_comp_card WHERE mp = ?').get(mp) as any;
  const t = listTasks({ type: 'competitor_watch', limit: 30 }).find(x => isMine(x, mp)) ?? null;
  const scheds = listSchedules().filter((s: any) => s.type === 'competitor_watch' && s.enabled && isMine(s, mp));
  const nextRuns = scheds.filter((s: any) => s.next_run_at).map((s: any) => Number(s.next_run_at)).sort((a: number, b: number) => a - b);
  const slots = scheds.flatMap((s: any) => cronSlots(s.cron).map(time => ({ time, light: !!s.params?.light })))
    .sort((a: { time: string }, b: { time: string }) => a.time.localeCompare(b.time));
  const cardsAt = cards?.at ? Number(cards.at) : null;
  // последний слот, которому уже пора было отработать (40 минут на очередь и сам проход), — и после него цен нет
  const due = Math.max(0, ...scheds.map((s: any) => lastCronSlot(s.cron, now - MISSED_AFTER_MIN * 60_000) ?? 0));
  const missedAt = due && (cardsAt ?? 0) < due ? due : null;
  return {
    fullAt: full?.at ? Number(full.at) : null, cardsAt,
    pass: pass ? { at: Number(pass.at), light: !!pass.light, cards: Number(pass.cards), priced: Number(pass.priced), errors: Number(pass.errors) } : null,
    task: t ? { id: t.id, status: t.status, light: !!t.params?.light, createdAt: t.created_at, finishedAt: t.finished_at ?? null,
      message: t.summary ?? t.error ?? null } : null,
    nextRuns, slots, missedAt,
  };
}

/**
 * Поставить быстрое обновление витрины. Если задание по площадке уже ждёт или идёт —
 * новое не ставим (менеджеры жмут несколько раз, привязывают пачкой).
 */
export function requestRefresh(mp: AdMp, by: string, delayMin = 0): { ok: true; taskId: number; already: boolean } | { ok: false; error: string } {
  const open = listTasks({ status: ['queued', 'claimed', 'running'], type: 'competitor_watch', limit: 20 }).find(x => isMine(x, mp));
  if (open) return { ok: true, taskId: open.id, already: true };
  const t = createTask('competitor_watch', { marketplace: mp, light: true }, by, { scheduledFor: Date.now() + delayMin * 60_000 });
  return t ? { ok: true, taskId: t.id, already: false } : { ok: false, error: 'очередь агентов недоступна' };
}

export function getCompetitors(mp: AdMp): Ads2Competitors {
  const d = db();
  const row = d.prepare('SELECT at, json FROM ad_cabinet_snapshot WHERE mp = ? ORDER BY at DESC LIMIT 1').get(mp) as any;
  const refresh = refreshState(mp);
  if (!row) return { ok: true, mp, at: null, empty: true, errors: [], refresh, ...buildWatch(mp, null) };
  const data = JSON.parse(row.json);
  const base = { ok: true as const, mp, at: Number(row.at), empty: false, refresh, errors: (data?.errors ?? []).map(String).slice(0, 10), ...buildWatch(mp, data) };
  return mp === 'wb' ? { ...base, wb: parseWb(data) } : { ...base, ozon: parseOzon(data, String(process.env.OZON_CLIENT_ID || '').trim()) };
}
