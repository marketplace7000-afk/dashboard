/**
 * «РНП действия» (12.11.2026) — что и когда меняли в каждой карточке WB и Ozon.
 *
 * Площадки не отдают журнал правок карточки, поэтому сервер сам раз в несколько
 * часов снимает «слепок» каждой карточки (название, описание, характеристики,
 * фото, видео, участие в акциях) и сравнивает с прошлым. Отличие = событие с датой.
 * История по этим полям начинается со дня первого слепка — задним числом её взять
 * неоткуда.
 *
 * Цена, реклама и остатки отдельно не собираются: по ним события выводятся при
 * чтении из фактов РНП (rnp_fact), поэтому у них история глубже — с осени 2026.
 *
 * Фото WB: адрес картинки привязан к номеру карточки и при замене не меняется,
 * поэтому сравниваем содержимое (sha1 маленькой копии) и храним эти копии у себя —
 * иначе «как было» показать нечем. У Ozon адрес у каждой картинки свой.
 *
 * Только настоящие товары: есть себестоимость в «Складе», а если её нет — цена
 * покупателя от 300 ₽ (решение владельца 12.11: дешевле — техкарточки для выкупов).
 *
 * Только чтение у площадок. Ручные заметки к дню — act_note.
 */
import { join } from 'node:path';
import { mkdirSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fetchWithRetry } from './fetchRetry';
import { fetchAllWbCards } from './wbCards';
import { wbUpstream } from '../_proxy';
import { getCosts, resolveCost } from './costs';
import { rnpItems, rnpInStockSkus, rnpFactRows, rnpLatestBuyerPrices } from './rnp';
import { adsDb } from './ads/store';
import type { RnpMp } from '../../shared/rnp';
import type { ActEvent, ActItem, ActKind, ActNote, ActResponse } from '../../shared/rnpActions';

let DatabaseSync: any = null;
try { DatabaseSync = require('node:sqlite').DatabaseSync; } catch { DatabaseSync = null; }

const DB_DIR = process.env.CACHE_DIR || join(process.cwd(), '.av-cache');
const DB_PATH = join(DB_DIR, 'actions.sqlite');
const PHOTO_DIR = join(DB_DIR, 'act-photos');
const DAY_MS = 86_400_000;
const MSK_MS = 3 * 3_600_000;
/** Чаще сверять незачем: точность события — день. */
const PASS_EVERY_MS = 3 * 3_600_000;
const MAX_DAYS = 120;
/** Дешевле — техкарточка для выкупов (если нет себестоимости в «Складе»). */
const MIN_REAL_PRICE = 300;
const WB_PHOTO = 'wbph:';

let db: any = null;
let initFailed = false;

function getDb(): any | null {
  if (db) return db;
  if (initFailed || !DatabaseSync) return null;
  try {
    mkdirSync(DB_DIR, { recursive: true });
    db = new DatabaseSync(DB_PATH);
    db.exec(`
      CREATE TABLE IF NOT EXISTS act_state (
        mp TEXT NOT NULL, sku TEXT NOT NULL, field TEXT NOT NULL, value TEXT NOT NULL, at INTEGER NOT NULL,
        PRIMARY KEY (mp, sku, field)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS act_event (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        mp TEXT NOT NULL, sku TEXT NOT NULL, date TEXT NOT NULL, at INTEGER NOT NULL,
        kind TEXT NOT NULL, text TEXT NOT NULL, before TEXT, after TEXT, view TEXT
      );
      CREATE INDEX IF NOT EXISTS act_event_date ON act_event (mp, date);
      CREATE TABLE IF NOT EXISTS act_note (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        mp TEXT NOT NULL, sku TEXT NOT NULL, date TEXT NOT NULL, text TEXT NOT NULL, author TEXT NOT NULL, at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS act_note_date ON act_note (mp, date);
      CREATE TABLE IF NOT EXISTS act_meta (key TEXT PRIMARY KEY, value TEXT);
    `);
    return db;
  } catch (e) {
    console.warn('[actions] sqlite init failed:', (e as Error).message);
    initFailed = true;
    return null;
  }
}

const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const up = (v: unknown) => String(v ?? '').trim().toUpperCase();
const mskDay = (at: number = Date.now()) => new Date(at + MSK_MS).toISOString().slice(0, 10);
const addDays = (d: string, n: number) => new Date(Date.parse(d + 'T00:00:00Z') + n * DAY_MS).toISOString().slice(0, 10);
const rub = (n: number) => Math.round(n).toLocaleString('ru-RU').replace(/ /g, ' ');
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function metaGet(key: string): string | null {
  try { return (getDb()?.prepare('SELECT value FROM act_meta WHERE key = ?').get(key) as any)?.value ?? null; } catch { return null; }
}
function metaSet(key: string, value: string): void {
  try { getDb()?.prepare('INSERT INTO act_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value); } catch { /* не критично */ }
}

// ─── Какие карточки настоящие ───────────────────────────────────────────────

type Item = { sku: string; article: string; name: string; photo: string; extId: string };

/** Настоящие товары площадки: себестоимость в «Складе» или цена покупателя от 300 ₽. */
function realItems(mp: RnpMp): Item[] {
  const costs = getCosts();
  const prices = rnpLatestBuyerPrices(mp);
  return rnpItems(mp).filter(it => {
    if (resolveCost(it.article || it.sku, costs)) return true;
    return (prices.get(it.sku) ?? 0) >= MIN_REAL_PRICE;
  });
}

// ─── Слепок карточки ────────────────────────────────────────────────────────

type Snap = {
  title: string;
  description: string;
  attrs: [string, string][];
  /** null — фото в этот проход проверить не удалось, поля фото не трогаем. */
  main: string | null;
  photos: string[] | null;
  video: string;
  /** Когда площадка сама отметила правку карточки (только WB) — точнее дня обнаружения. */
  updatedAt?: number;
};

async function pool<T, R>(list: T[], size: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(list.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(size, list.length) }, async () => {
    while (i < list.length) { const k = i++; out[k] = await fn(list[k]); }
  }));
  return out;
}

/** Скачать маленькую копию фото WB, сохранить под её sha1 и вернуть метку. null — не скачалось. */
async function wbPhotoMark(url: string): Promise<string | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (!r.ok) { if (r.status === 404) return null; continue; }
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length < 200) continue;
      const hash = createHash('sha1').update(buf).digest('hex');
      const file = join(PHOTO_DIR, `${hash}.webp`);
      if (!existsSync(file)) writeFileSync(file, buf);
      return WB_PHOTO + hash;
    } catch { /* повторим */ }
  }
  return null;
}

async function snapWb(real: Map<string, Item>, inStock: Set<string>, state: Map<string, Map<string, string>>): Promise<Map<string, Snap>> {
  mkdirSync(PHOTO_DIR, { recursive: true });
  const { cards } = await fetchAllWbCards(wbUpstream('content'));
  const out = new Map<string, Snap>();
  const mine = cards.filter(c => real.has(String(c?.nmID)));
  await pool(mine, 3, async card => {
    const sku = String(card.nmID);
    const updatedAt = Date.parse(String(card.updatedAt ?? '')) || undefined;
    const prev = state.get(sku);
    // Фото качаем, если товар в продаже, карточку правили или слепка ещё нет: у архивных
    // карточек без правок картинки не меняются, а их в каталоге большинство.
    const need = !prev?.has('photo_main') || inStock.has(sku) || String(updatedAt ?? '') !== (prev.get('wb_updated') ?? '');
    let main: string | null = null;
    let photos: string[] | null = null;
    const urls: string[] = (card.photos ?? []).map((p: any) => String(p?.c246x328 || p?.tm || p?.big || '')).filter(Boolean);
    if (need) {
      const marks = await pool(urls, 4, wbPhotoMark);
      if (marks.every(Boolean)) { main = marks[0] ?? ''; photos = (marks.slice(1) as string[]); }
    }
    out.set(sku, {
      title: String(card.title ?? ''),
      description: String(card.description ?? ''),
      attrs: (card.characteristics ?? []).map((c: any) => [String(c?.name ?? c?.id ?? ''), Array.isArray(c?.value) ? c.value.join(', ') : String(c?.value ?? '')] as [string, string]),
      main, photos,
      video: String(card.video ?? ''),
      updatedAt,
    });
  });
  return out;
}

const OZ_HEADERS = () => ({ 'Client-Id': process.env.OZON_CLIENT_ID ?? '', 'Api-Key': process.env.OZON_API_KEY ?? '', 'Content-Type': 'application/json' });

async function ozPost(path: string, body: unknown): Promise<any> {
  const r = await fetchWithRetry(`https://api-seller.ozon.ru${path}`, { method: 'POST', headers: OZ_HEADERS(), body: JSON.stringify(body) }, { maxRetries: 2, priority: 2, timeoutMs: 40_000 });
  if (!r.ok) throw new Error(`Ozon ${path} → ${r.status}`);
  return r.json();
}

/** Названия характеристик Ozon по категории и типу: в самой карточке только номера. */
async function ozAttrNames(pairs: Map<string, { cat: number; type: number }>): Promise<Map<number, string>> {
  const names = new Map<number, string>();
  let cache: Record<string, Record<string, string>> = {};
  try { cache = JSON.parse(metaGet('oz:attr-names') ?? '{}'); } catch { cache = {}; }
  let changed = false;
  for (const [key, p] of pairs) {
    if (!cache[key]) {
      try {
        const j = await ozPost('/v1/description-category/attribute', { description_category_id: p.cat, type_id: p.type, language: 'DEFAULT' });
        cache[key] = Object.fromEntries((j?.result ?? []).map((a: any) => [String(a.id), String(a.name ?? '')]));
        changed = true;
      } catch { continue; }
    }
    for (const [id, name] of Object.entries(cache[key])) if (name) names.set(Number(id), name);
  }
  if (changed) metaSet('oz:attr-names', JSON.stringify(cache));
  return names;
}

/** Слепки карточек Ozon и заодно product_id → артикул (нужен акциям). */
async function snapOzon(real: Map<string, Item>): Promise<{ snaps: Map<string, Snap>; byProductId: Map<string, string> }> {
  const byOffer = new Map([...real.values()].map(it => [up(it.sku), it.sku]));
  const raw: any[] = [];
  let lastId = '';
  for (let page = 0; page < 30; page++) {
    const j = await ozPost('/v4/product/info/attributes', { filter: { visibility: 'ALL' }, limit: 200, last_id: lastId });
    const list: any[] = j?.result ?? [];
    raw.push(...list);
    lastId = String(j?.last_id ?? '');
    if (list.length < 200 || !lastId) break;
  }
  const byProductId = new Map<string, string>();
  const mine: { sku: string; it: any }[] = [];
  const pairs = new Map<string, { cat: number; type: number }>();
  for (const it of raw) {
    const sku = byOffer.get(up(it?.offer_id));
    if (!sku) continue;
    byProductId.set(String(it.id), sku);
    mine.push({ sku, it });
    if (it.description_category_id && it.type_id) pairs.set(`${it.description_category_id}:${it.type_id}`, { cat: it.description_category_id, type: it.type_id });
  }
  const names = await ozAttrNames(pairs);
  const snaps = new Map<string, Snap>();
  for (const { sku, it } of mine) {
    const attrs = (it.attributes ?? []) as any[];
    const val = (a: any) => (a?.values ?? []).map((v: any) => String(v?.value ?? '')).join(', ');
    const images: string[] = (it.images ?? []).map(String).filter(Boolean);
    const primary = String(it.primary_image || '');
    const main = primary || images[0] || '';
    snaps.set(sku, {
      title: String(it.name ?? ''),
      // 4191 — описание товара в справочнике атрибутов Ozon.
      description: val(attrs.find(a => a.id === 4191)),
      attrs: attrs.filter(a => a.id !== 4191).map(a => [names.get(a.id) || `Характеристика ${a.id}`, val(a)] as [string, string]),
      main,
      photos: images.filter(u => u !== main),
      // 21841 — ссылка на видео в комплексном атрибуте.
      video: ((it.complex_attributes ?? []) as any[]).filter(a => a.id === 21841).map(val).join(', '),
    });
  }
  return { snaps, byProductId };
}

// ─── Акции ──────────────────────────────────────────────────────────────────

/** Акции Ozon, в которых участвует товар. Бросает ошибку, если список неполный. */
async function promoOzon(byProductId: Map<string, string>): Promise<{ bySku: Map<string, string[]>; active: Set<string> }> {
  const r = await fetchWithRetry('https://api-seller.ozon.ru/v1/actions', { headers: OZ_HEADERS() }, { maxRetries: 2, priority: 2, timeoutMs: 40_000 });
  if (!r.ok) throw new Error(`Ozon actions → ${r.status}`);
  const actions: any[] = ((await r.json()) as any)?.result ?? [];
  const bySku = new Map<string, string[]>();
  const active = new Set<string>();
  for (const a of actions) {
    const title = String(a.title ?? a.id).trim();
    active.add(title);
    if (!(num(a.participating_products_count) > 0)) continue;
    let lastId = '';
    for (let page = 0; page < 50; page++) {
      const j = await ozPost('/v1/actions/products', { action_id: a.id, limit: 100, last_id: lastId });
      const list: any[] = j?.result?.products ?? [];
      for (const p of list) {
        const sku = byProductId.get(String(p.id));
        if (!sku) continue;
        bySku.set(sku, [...(bySku.get(sku) ?? []), title]);
      }
      lastId = String(j?.result?.last_id ?? '');
      if (list.length < 100 || !lastId) break;
    }
  }
  return { bySku, active };
}

/** Акции WB с ручным участием. По автоакциям WB список товаров не отдаёт. */
async function promoWb(): Promise<{ bySku: Map<string, string[]>; active: Set<string> }> {
  const up_ = wbUpstream('discounts');
  const iso = (at: number) => new Date(at).toISOString().slice(0, 19) + 'Z';
  const base = 'https://dp-calendar-api.wildberries.ru/api/v1/calendar/promotions';
  const now = Date.now();
  const r = await fetchWithRetry(`${base}?startDateTime=${iso(now - 60 * DAY_MS)}&endDateTime=${iso(now + DAY_MS)}&allPromo=false&limit=1000`, { headers: up_.headers }, { maxRetries: 2, priority: 2, timeoutMs: 40_000 });
  if (!r.ok) throw new Error(`WB promotions → ${r.status}`);
  const promos: any[] = ((await r.json()) as any)?.data?.promotions ?? [];
  const bySku = new Map<string, string[]>();
  const active = new Set<string>();
  for (const p of promos) {
    const start = Date.parse(p.startDateTime), end = Date.parse(p.endDateTime);
    if (!(start <= now && now <= end)) continue;
    const name = String(p.name ?? p.id).trim();
    active.add(name);
    if (p.type === 'auto') continue;
    await sleep(700); // лимит календаря акций — 10 запросов за 6 секунд
    for (let offset = 0; offset < 20_000; offset += 1000) {
      const rr = await fetchWithRetry(`${base}/nomenclatures?promotionID=${p.id}&inAction=true&limit=1000&offset=${offset}`, { headers: up_.headers }, { maxRetries: 2, priority: 2, timeoutMs: 40_000 });
      if (rr.status === 422) break; // для этой акции список не предусмотрен
      if (!rr.ok) throw new Error(`WB promo ${p.id} → ${rr.status}`);
      const list: any[] = ((await rr.json()) as any)?.data?.nomenclatures ?? [];
      for (const n of list) {
        if (n?.inAction === false) continue;
        const sku = String(n?.id ?? n?.nmID ?? '');
        if (sku) bySku.set(sku, [...(bySku.get(sku) ?? []), name]);
      }
      if (list.length < 1000) break;
      await sleep(700);
    }
  }
  return { bySku, active };
}

// ─── Сравнение со старым слепком ────────────────────────────────────────────

type NewEvent = { sku: string; date: string; kind: ActKind; text: string; before?: string; after?: string; view?: 'text' | 'images' };

const plural = (n: number, one: string, few: string, many: string) => {
  const a = Math.abs(n) % 100, b = a % 10;
  return a > 10 && a < 20 ? many : b === 1 ? one : b >= 2 && b <= 4 ? few : many;
};

function diffCard(sku: string, date: string, prev: Map<string, string> | undefined, s: Snap): { events: NewEvent[]; next: [string, string][] } {
  const events: NewEvent[] = [];
  const next: [string, string][] = [];
  const had = (f: string) => prev?.has(f) ?? false;
  const old = (f: string) => prev?.get(f) ?? '';
  const put = (f: string, v: string) => { if (!had(f) || old(f) !== v) next.push([f, v]); };

  if (had('title') && old('title') !== s.title && s.title) events.push({ sku, date, kind: 'title', text: 'Изменили название', before: old('title'), after: s.title, view: 'text' });
  if (s.title) put('title', s.title);

  if (had('description') && old('description') !== s.description) {
    events.push({ sku, date, kind: 'description', text: `Изменили описание: было ${old('description').length} знаков, стало ${s.description.length}`, before: old('description'), after: s.description, view: 'text' });
  }
  put('description', s.description);

  const attrsJson = JSON.stringify(s.attrs);
  if (had('attrs') && old('attrs') !== attrsJson) {
    let before: [string, string][] = [];
    try { before = JSON.parse(old('attrs')); } catch { before = []; }
    const a = new Map(before), b = new Map(s.attrs);
    const lines = { before: [] as string[], after: [] as string[] };
    for (const name of new Set([...a.keys(), ...b.keys()])) {
      if ((a.get(name) ?? '') === (b.get(name) ?? '')) continue;
      lines.before.push(`${name}: ${a.get(name) ?? '—'}`);
      lines.after.push(`${name}: ${b.get(name) ?? '—'}`);
    }
    // Тот же набор в другом порядке — не правка.
    if (lines.after.length) {
      const n = lines.after.length;
      events.push({ sku, date, kind: 'attrs', text: `Изменили ${n} ${plural(n, 'характеристику', 'характеристики', 'характеристик')}`, before: lines.before.join('\n'), after: lines.after.join('\n'), view: 'text' });
    }
  }
  put('attrs', attrsJson);

  if (s.main !== null && s.photos !== null) {
    const oldMain = old('photo_main');
    let oldRest: string[] = [];
    try { oldRest = JSON.parse(old('photos') || '[]'); } catch { oldRest = []; }
    const mainChanged = had('photo_main') && oldMain !== s.main;
    if (mainChanged) {
      events.push({ sku, date, kind: 'photo_main', text: s.main ? (oldMain ? 'Сменили главное фото' : 'Добавили главное фото') : 'Убрали главное фото', before: JSON.stringify(oldMain ? [oldMain] : []), after: JSON.stringify(s.main ? [s.main] : []), view: 'images' });
    }
    if (had('photos')) {
      const was = [oldMain, ...oldRest].filter(Boolean), now = [s.main, ...s.photos].filter(Boolean);
      const added = now.filter(x => !was.includes(x)), removed = was.filter(x => !now.includes(x));
      // Новое главное фото уже учтено событием выше — здесь считаем только остальные.
      const addedRest = added.filter(x => x !== s.main), removedRest = removed.filter(x => x !== oldMain);
      if (addedRest.length || removedRest.length) {
        const parts = [addedRest.length ? `добавили ${addedRest.length}` : '', removedRest.length ? `убрали ${removedRest.length}` : ''].filter(Boolean).join(', ');
        events.push({ sku, date, kind: 'photos', text: `Фото: ${parts} (было ${was.length}, стало ${now.length})`, before: JSON.stringify(removedRest), after: JSON.stringify(addedRest), view: 'images' });
      } else if (!mainChanged && JSON.stringify(oldRest) !== JSON.stringify(s.photos)) {
        events.push({ sku, date, kind: 'photos', text: 'Поменяли порядок фото', before: JSON.stringify(oldRest), after: JSON.stringify(s.photos), view: 'images' });
      }
    }
    put('photo_main', s.main);
    put('photos', JSON.stringify(s.photos));
  }

  if (had('video') && old('video') !== s.video) {
    events.push({ sku, date, kind: 'photos', text: !old('video') ? 'Добавили видео' : !s.video ? 'Убрали видео' : 'Заменили видео' });
  }
  put('video', s.video);
  // Отметку правки запоминаем только вместе с проверенными фото: не скачались — в следующий проход повторим.
  if (s.updatedAt && s.main !== null) put('wb_updated', String(s.updatedAt));
  return { events, next };
}

// ─── Проход ─────────────────────────────────────────────────────────────────

let collecting: Promise<string> | null = null;

async function collectMp(mp: RnpMp): Promise<string> {
  const d = getDb();
  if (!d) return `${mp}: база недоступна`;
  const now = Date.now();
  const today = mskDay(now);
  const lastPass = num(metaGet(`pass:${mp}`));
  const real = new Map(realItems(mp).map(it => [it.sku, it]));
  if (!real.size) return `${mp}: нет товаров`;

  const state = new Map<string, Map<string, string>>();
  for (const r of d.prepare('SELECT sku, field, value FROM act_state WHERE mp = ?').all(mp) as any[]) {
    if (!state.has(r.sku)) state.set(r.sku, new Map());
    state.get(r.sku)!.set(r.field, r.value);
  }

  let snaps: Map<string, Snap>;
  let promo: { bySku: Map<string, string[]>; active: Set<string> } | null = null;
  let promoErr = '';
  if (mp === 'wb') {
    snaps = await snapWb(real, rnpInStockSkus('wb'), state);
    try { promo = await promoWb(); } catch (e) { promoErr = (e as Error).message; }
  } else {
    const oz = await snapOzon(real);
    snaps = oz.snaps;
    try { promo = await promoOzon(oz.byProductId); } catch (e) { promoErr = (e as Error).message; }
  }

  let events: NewEvent[] = [];
  const writes: [string, string, string][] = [];
  for (const [sku, s] of snaps) {
    // WB сам отмечает время правки карточки: если оно между проходами — дата события точнее.
    const date = s.updatedAt && lastPass && s.updatedAt > lastPass && s.updatedAt <= now ? mskDay(s.updatedAt) : today;
    const r = diffCard(sku, date, state.get(sku), s);
    events.push(...r.events);
    for (const [f, v] of r.next) writes.push([sku, f, v]);
  }

  // Если «сменилось» фото сразу у большой доли карточек — это площадка пережала картинки,
  // а не люди правили: слепок обновляем, событий не пишем.
  const photoSkus = new Set(events.filter(e => e.kind === 'photo_main' || (e.kind === 'photos' && e.view === 'images')).map(e => e.sku));
  let massNote = '';
  if (photoSkus.size >= 10 && photoSkus.size > snaps.size * 0.4) {
    events = events.filter(e => !(e.kind === 'photo_main' || (e.kind === 'photos' && e.view === 'images')));
    massNote = ` · фото «сменились» у ${photoSkus.size} карточек разом — принято за пережатие, не записано`;
  }

  if (promo) {
    for (const sku of snaps.keys()) {
      const list = [...new Set(promo.bySku.get(sku) ?? [])].sort();
      const prev = state.get(sku);
      const json = JSON.stringify(list);
      if (prev?.has('promo') && prev.get('promo') !== json) {
        let was: string[] = [];
        try { was = JSON.parse(prev.get('promo') || '[]'); } catch { was = []; }
        for (const p of list.filter(x => !was.includes(x))) events.push({ sku, date: today, kind: 'promo', text: `Вошёл в акцию «${p}»` });
        for (const p of was.filter(x => !list.includes(x))) events.push({ sku, date: today, kind: 'promo', text: promo.active.has(p) ? `Вышел из акции «${p}»` : `Акция «${p}» закончилась` });
      }
      if (!prev?.has('promo') || prev.get('promo') !== json) writes.push([sku, 'promo', json]);
    }
  }

  d.exec('BEGIN');
  try {
    const insE = d.prepare('INSERT INTO act_event (mp, sku, date, at, kind, text, before, after, view) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const e of events) insE.run(mp, e.sku, e.date, now, e.kind, e.text, e.before ?? null, e.after ?? null, e.view ?? null);
    const insS = d.prepare('INSERT INTO act_state (mp, sku, field, value, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(mp, sku, field) DO UPDATE SET value = excluded.value, at = excluded.at');
    for (const [sku, f, v] of writes) insS.run(mp, sku, f, v, now);
    d.exec('COMMIT');
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
  metaSet(`pass:${mp}`, String(now));
  if (!metaGet(`since:${mp}`)) metaSet(`since:${mp}`, today);
  return `${mp}: карточек ${snaps.size}, изменений ${events.length}${promoErr ? ` · акции не сверены (${promoErr.slice(0, 80)})` : ''}${massNote}`;
}

/** Сверить карточки обеих площадок с прошлым слепком. Не чаще раза в 3 часа, если не force. */
export function collectActions(force = false): Promise<string> {
  if (collecting) return collecting;
  collecting = (async () => {
    const out: string[] = [];
    for (const mp of ['wb', 'ozon'] as RnpMp[]) {
      if (!force && Date.now() - num(metaGet(`pass:${mp}`)) < PASS_EVERY_MS) { out.push(`${mp}: недавно сверяли`); continue; }
      try { out.push(await collectMp(mp)); } catch (e) { out.push(`${mp}: не сверено (${String((e as Error)?.message ?? e).slice(0, 120)})`); }
    }
    return out.join(' · ');
  })().finally(() => { collecting = null; });
  return collecting;
}

export const actionsCollecting = () => !!collecting;

// ─── Чтение для экрана ──────────────────────────────────────────────────────

/** Ссылка на сохранённое фото: метку WB превращаем в адрес нашего сервера. */
const photoSrc = (s: string) => (s.startsWith(WB_PHOTO) ? `/api/rnp-actions/photo/${s.slice(WB_PHOTO.length)}` : s);
function viewImages(json: string | null | undefined): string | undefined {
  if (!json) return undefined;
  try { return JSON.stringify((JSON.parse(json) as string[]).map(photoSrc)); } catch { return undefined; }
}

function adLogText(action: string, before: string | null, after: string | null): string {
  const j = (s: string | null) => { try { return JSON.parse(s ?? '{}') ?? {}; } catch { return {}; } };
  const b = j(before), a = j(after);
  if (action === 'bid' && (a.bid_rub != null || b.bid_rub != null)) return `Ставка ${b.bid_rub ?? '?'} → ${a.bid_rub ?? '?'} ₽ (через сайт)`;
  if (action === 'pause') return 'Кампанию поставили на паузу (через сайт)';
  if (action === 'start') return 'Кампанию запустили (через сайт)';
  if (action === 'daily_limit') return 'Изменили дневной лимит (через сайт)';
  return '';
}

export function getActions(mp: RnpMp, fromIn?: string, toIn?: string): ActResponse {
  const isDate = (s?: string) => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);
  let to = isDate(toIn) ? toIn! : mskDay();
  let from = isDate(fromIn) ? fromIn! : addDays(to, -29);
  if (from > to) [from, to] = [to, from];
  if ((Date.parse(to) - Date.parse(from)) / DAY_MS >= MAX_DAYS) from = addDays(to, -(MAX_DAYS - 1));
  const dates: string[] = [];
  for (let x = from; x <= to; x = addDays(x, 1)) dates.push(x);
  const idx = new Map(dates.map((x, i) => [x, i]));
  const notes: string[] = [];
  const since = metaGet(`since:${mp}`);
  const res: ActResponse = { ok: true, mp, from, to, dates, items: [], contentSince: since, checkedAt: num(metaGet(`pass:${mp}`)) || null, notes };

  const real = realItems(mp);
  const inStock = rnpInStockSkus(mp);
  const preFrom = addDays(from, -14);
  const rows = rnpFactRows(mp, ['price_seller', 'adv_expenses', 'stocks', 'ordered_cnt', 'wbf_order_cnt'], preFrom, to);
  const by = new Map<string, Map<string, Map<string, number>>>(); // sku → metric → date → value
  let adsFirst = '', adsLast = '';
  for (const r of rows) {
    if (!by.has(r.sku)) by.set(r.sku, new Map());
    const m = by.get(r.sku)!;
    if (!m.has(r.metric)) m.set(r.metric, new Map());
    m.get(r.metric)!.set(r.date, r.value);
    if (r.metric === 'adv_expenses') {
      if (!adsFirst || r.date < adsFirst) adsFirst = r.date;
      if (r.value > 0 && r.date > adsLast) adsLast = r.date;
    }
  }

  const d = getDb();
  const evBySku = new Map<string, ActEvent[]>();
  const push = (sku: string, e: ActEvent) => { if (idx.has(e.date)) { if (!evBySku.has(sku)) evBySku.set(sku, []); evBySku.get(sku)!.push(e); } };
  if (d) {
    for (const r of d.prepare('SELECT sku, date, kind, text, before, after, view FROM act_event WHERE mp = ? AND date >= ? AND date <= ? ORDER BY date, id').all(mp, from, to) as any[]) {
      const images = r.view === 'images';
      push(String(r.sku), {
        date: r.date, kind: r.kind, text: r.text,
        before: images ? viewImages(r.before) : r.before ?? undefined,
        after: images ? viewImages(r.after) : r.after ?? undefined,
        view: r.view ?? undefined,
      });
    }
  } else notes.push('База действий недоступна на сервере (нужен Node 22.5+).');

  // Правки рекламы, сделанные через сайт (журнал «Рекламы»): там SKU площадки.
  const byExt = new Map(real.map(it => [mp === 'wb' ? it.sku : it.extId, it.sku]));
  try {
    const a = adsDb();
    const fromMs = Date.parse(from + 'T00:00:00Z') - MSK_MS, toMs = Date.parse(to + 'T00:00:00Z') - MSK_MS + DAY_MS;
    const log = a ? a.prepare(`SELECT l.at, l.campaign_id, l.sku, l.action, l.before, l.after FROM ad_change_log l WHERE l.mp = ? AND l.status = 'applied' AND l.at >= ? AND l.at < ?`).all(mp, fromMs, toMs) as any[] : [];
    const items = log.some(l => !l.sku) && a ? a.prepare('SELECT campaign_id, sku FROM ad_campaign_item WHERE mp = ?').all(mp) as any[] : [];
    for (const l of log) {
      const text = adLogText(String(l.action), l.before, l.after);
      if (!text) continue;
      const exts: string[] = l.sku ? [String(l.sku)] : items.filter(i => String(i.campaign_id) === String(l.campaign_id)).map(i => String(i.sku));
      for (const ext of exts) { const sku = byExt.get(ext); if (sku) push(sku, { date: mskDay(num(l.at)), kind: 'ads', text }); }
    }
  } catch { /* журнала рекламы нет — покажем только включение и выключение */ }

  const noteBySku = new Map<string, ActNote[]>();
  if (d) {
    for (const r of d.prepare('SELECT id, sku, date, text, author, at FROM act_note WHERE mp = ? AND date >= ? AND date <= ? ORDER BY at').all(mp, from, to) as any[]) {
      if (!noteBySku.has(r.sku)) noteBySku.set(r.sku, []);
      noteBySku.get(r.sku)!.push({ id: r.id, date: r.date, text: r.text, author: r.author, at: r.at });
    }
  }

  const allDates: string[] = [];
  for (let x = preFrom; x <= to; x = addDays(x, 1)) allDates.push(x);

  for (const it of real) {
    const m = by.get(it.sku) ?? new Map<string, Map<string, number>>();

    // Цена: событие — когда отличается от прошлой известной на 1 % и на 5 ₽.
    const price = m.get('price_seller');
    if (price) {
      let prev = 0;
      for (const x of allDates) {
        const v = price.get(x);
        if (!v || v <= 0) continue;
        if (prev > 0 && Math.abs(v - prev) / prev >= 0.01 && Math.abs(v - prev) >= 5) {
          const pct = Math.round((v - prev) / prev * 1000) / 10;
          push(it.sku, { date: x, kind: 'price', text: `Цена ${rub(prev)} → ${rub(v)} ₽ (${pct > 0 ? '+' : '−'}${String(Math.abs(pct)).replace('.', ',')} %)` });
        }
        prev = v;
      }
    }

    // Реклама: день с расходом — «шла». Включили — после двух дней тишины; выключили — два дня тишины подряд.
    const adv = m.get('adv_expenses');
    const on = (x: string) => (adv?.get(x) ?? 0) > 0;
    const adsOn = dates.map(x => (on(x) ? 1 : 0));
    if (adv && adsFirst) {
      for (const x of dates) {
        const p1 = addDays(x, -1), p2 = addDays(x, -2), n1 = addDays(x, 1);
        if (on(x) && !on(p1) && !on(p2) && p2 >= adsFirst) push(it.sku, { date: x, kind: 'ads', text: 'Реклама включена (пошёл расход)' });
        if (!on(x) && on(p1) && !on(n1) && n1 <= adsLast) push(it.sku, { date: x, kind: 'ads', text: 'Реклама выключена (расхода нет)' });
      }
    }

    // Остатки: закончился / появился. Нулевой провал на один день — сбой сбора, пропускаем.
    const stock = m.get('stocks');
    if (stock) {
      const known = allDates.filter(x => stock.has(x)).map(x => [x, stock.get(x)!] as const);
      let prev: number | null = null;
      known.forEach(([x, v], i) => {
        const nextV = known[i + 1]?.[1];
        if (v <= 0 && prev !== null && prev > 0 && nextV !== undefined && nextV > 0) return;
        if (prev !== null) {
          if (v <= 0 && prev > 0) push(it.sku, { date: x, kind: 'stock', text: 'Товар закончился' });
          if (v > 0 && prev <= 0) push(it.sku, { date: x, kind: 'stock', text: `Товар снова в наличии: ${rub(v)} шт` });
        }
        prev = v;
      });
    }

    const funnel = m.get('wbf_order_cnt'), ord = m.get('ordered_cnt');
    const orders = dates.map(x => (mp === 'wb' && funnel?.has(x) ? funnel.get(x)! : ord?.has(x) ? ord.get(x)! : null));

    const item: ActItem = {
      sku: it.sku, article: it.article || it.sku, name: it.name, photo: it.photo,
      link: mp === 'wb' ? `https://www.wildberries.ru/catalog/${it.sku}/detail.aspx` : it.extId ? `https://www.ozon.ru/product/${it.extId}/` : '',
      inStock: inStock.has(it.sku),
      orders, adsOn,
      events: (evBySku.get(it.sku) ?? []).sort((a, b) => a.date.localeCompare(b.date)),
      notes: noteBySku.get(it.sku) ?? [],
    };
    res.items.push(item);
  }

  if (!since) notes.push('Первая сверка карточек ещё не прошла: изменения фото, названия, описания, характеристик и акций начнут появляться после неё. Цена, реклама и остатки уже видны по накопленной истории.');
  else if (since > from) notes.push(`За фото, названием, описанием, характеристиками и акциями следим с ${since.split('-').reverse().join('.')} — раньше этой даты по ним отметок нет. Цена, реклама и остатки — по накопленной истории РНП.`);
  return res;
}

// ─── Заметки ────────────────────────────────────────────────────────────────

export function addNote(mp: RnpMp, sku: string, date: string, text: string, author: string): ActNote | { error: string } {
  const d = getDb();
  if (!d) return { error: 'База действий недоступна' };
  const t = text.trim().slice(0, 1000);
  if (!t) return { error: 'Пустая заметка' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !sku) return { error: 'Не указаны товар или день' };
  const at = Date.now();
  const r = d.prepare('INSERT INTO act_note (mp, sku, date, text, author, at) VALUES (?, ?, ?, ?, ?, ?)').run(mp, sku, date, t, author.slice(0, 80), at);
  return { id: Number(r.lastInsertRowid), date, text: t, author, at };
}

export function deleteNote(id: number): boolean {
  const d = getDb();
  if (!d || !Number.isFinite(id)) return false;
  return Number(d.prepare('DELETE FROM act_note WHERE id = ?').run(id).changes) > 0;
}

/** Сохранённая копия фото WB по её sha1. */
export function readPhoto(hash: string): Buffer | null {
  if (!/^[a-f0-9]{40}$/.test(hash)) return null;
  try { return readFileSync(join(PHOTO_DIR, `${hash}.webp`)); } catch { return null; }
}
