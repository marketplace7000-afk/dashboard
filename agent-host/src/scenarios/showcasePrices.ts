/**
 * Сценарий showcase_prices — цена покупателя по нашим товарам (ТЗ 9.1). Без LLM.
 *
 * Эталон цены: то, что видит залогиненный покупатель БЕЗ платёжной карты
 * площадки (без WB Кошелька / Ozon Карты). Цена «с картой» в расчёт СПП не идёт.
 *
 * WB: та же механика, что у серверного wbShowcase, — публичный card.wb.ru
 * (sizes[0].price.product = витрина рубль в рубль, проверено 04.09), батчами по
 * 100 nmId. С сервера card.wb.ru забанен по IP, с домашнего IP через вкладку
 * агента — работает. Итог: 166 товаров = 2 запроса вместо скролла витрины.
 * Якорь единиц (рубли/копейки) — серая цена ЛК из params.anchors (даёт сервер).
 *
 * Ozon: публичного API цен нет — проход по витрине ozon.ru/seller/avto-vibe
 * (?page=N) с чтением карточек из DOM, затем прямые карточки по недостающим sku.
 * Ключ ingest — sku из ссылки /product/...-<sku>/: сервер сам мапит в offer_id
 * и отбрасывает чужие товары (рекомендательные карусели).
 *
 * Этапы (shared/agents SCENARIO_STAGES.showcase_prices):
 *   1 open_showcase → 2 collect_prices → 3 direct_cards → 4 ingest
 */
import type { Page } from 'playwright-core';
import {
  SCENARIO_STAGES, type AgentSettings, type AgentTask, type Marketplace,
} from '../../../shared/agents';
import * as api from '../api';
import { newPage, sleep, randBetween, looksLikeChallenge } from '../chrome';

const STAGES = SCENARIO_STAGES.showcase_prices;
type Items = Record<string, { price: number; oldPrice?: number }>;

class Cancelled extends Error { constructor() { super('cancelled'); } }
class Challenge extends Error { constructor(public mp: Marketplace, public kind: 'captcha' | 'blocked') { super(`${kind} on ${mp}`); } }
class LoginRequired extends Error { constructor(public mp: Marketplace) { super(`login required on ${mp}`); } }

/** Счётчик страниц в час (принцип I: не более pages_per_hour на площадку). */
const pageLog: number[] = [];
async function pacedGoto(page: Page, url: string, settings: AgentSettings, taskId: number, pause: [number, number]): Promise<void> {
  const hourAgo = Date.now() - 3600_000;
  while (pageLog.filter(t => t > hourAgo).length >= settings.pages_per_hour) {
    const oldest = pageLog.find(t => t > hourAgo)!;
    const waitMs = oldest + 3600_000 - Date.now() + 1000;
    const until = new Date(Date.now() + waitMs).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    // Ожидание — тот же этап; progress продолжает идти, чтобы не попасть под stale.
    await api.log(taskId, 'info', `часовой лимит ${settings.pages_per_hour} страниц исчерпан, продолжение в ${until}`);
    await sleep(Math.min(waitMs, 60_000));
  }
  await sleep(randBetween(pause));
  pageLog.push(Date.now());
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
}

function checkCancelled(status: string | null): void {
  if (status === 'cancelled') throw new Cancelled();
}

// ─── WB: card.wb.ru батчами ─────────────────────────────────────────────────

function toRub(raw: unknown, anchorRub?: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (anchorRub && anchorRub > 0) {
    if (n > anchorRub * 20 && n / 100 <= anchorRub * 1.05) return Math.round(n / 100);
    return Math.round(n);
  }
  return n >= 5_000_000 ? Math.round(n / 100) : Math.round(n);
}

async function collectWb(page: Page, task: AgentTask, settings: AgentSettings): Promise<{ items: Items; missing: string[] }> {
  const skus = (task.params.skus ?? []).map(String).filter(Boolean);
  const anchors = task.params.anchors ?? {};
  const items: Items = {};
  if (!skus.length) {
    await api.log(task.id, 'warn', 'сервер не передал список nmId (кэш цен WB пуст) — снимать нечего');
    return { items, missing: [] };
  }
  // Открываем сам wildberries.ru (проверка антибота + origin для fetch), а
  // card.wb.ru запрашиваем через fetch изнутри страницы — так делает фронт WB.
  // Открывать JSON как страницу нельзя: Chrome показывает его своим
  // просмотрщиком и innerText теряет часть данных (25.09: 30 из 167).
  await pacedGoto(page, 'https://www.wildberries.ru/', settings, task.id, settings.page_pause_ms);
  {
    const body = await page.evaluate(() => document.body?.innerText ?? '');
    if (looksLikeChallenge(page.url(), body)) throw new Challenge('wb', 'captcha');
  }
  const CHUNK = 100;
  const total = skus.length;
  let doneCount = 0;
  for (let i = 0; i < skus.length; i += CHUNK) {
    const chunk = skus.slice(i, i + CHUNK);
    const url = `https://card.wb.ru/cards/v4/detail?appType=1&curr=rub&dest=-1257786&nm=${chunk.join(';')}`;
    await sleep(randBetween(settings.page_pause_ms));
    pageLog.push(Date.now());
    const res = await page.evaluate(async (u: string) => {
      try {
        const r = await fetch(u, { credentials: 'include' });
        return { status: r.status, text: await r.text() };
      } catch (e) { return { status: 0, text: String((e as Error)?.message ?? e) }; }
    }, url);
    if (res.status === 403 || res.status === 429 || looksLikeChallenge('', res.text)) throw new Challenge('wb', res.status === 429 ? 'blocked' : 'captcha');
    let parsed: any = null;
    try { parsed = JSON.parse(res.text); } catch { /* не JSON */ }
    const products: any[] = parsed?.data?.products ?? parsed?.products ?? [];
    await api.log(task.id, products.length ? 'info' : 'warn',
      `card.wb.ru: батч ${Math.floor(i / CHUNK) + 1} — запрошено ${chunk.length}, получено ${products.length} (HTTP ${res.status})`,
      products.length ? undefined : { sample: res.text.slice(0, 300) });
    if (!products.length && !parsed) throw new Challenge('wb', 'blocked');
    for (const p of products) {
      const nm = String(p?.id ?? '');
      if (!nm) continue;
      const anchor = Number(anchors[nm]) || undefined;
      const s = p?.sizes?.[0]?.price ?? {};
      const price = toRub(s.product ?? s.total ?? p?.salePriceU ?? 0, anchor);
      const old = toRub(s.basic ?? p?.priceU ?? 0, anchor);
      if (price > 0) items[nm] = { price, oldPrice: old > price ? old : undefined };
    }
    doneCount = Math.min(i + CHUNK, total);
    checkCancelled(await api.progress(task.id, {
      stage: 'collect_prices', stage_index: 2, stages_total: STAGES.length,
      items_done: Object.keys(items).length, items_total: total,
      current_item: chunk[chunk.length - 1] ?? null,
      message: `WB: снято ${Object.keys(items).length} из ${total} (батч ${Math.ceil(doneCount / CHUNK)} из ${Math.ceil(total / CHUNK)})`,
      eta_sec: Math.round(((total - doneCount) / CHUNK) * (settings.page_pause_ms[1] / 1000 + 2)),
    }));
  }
  const missing = skus.filter(s => !items[s]);
  return { items, missing };
}

/** Недостающие WB — прямые карточки (детальная страница, DOM). */
async function wbDirectCards(page: Page, task: AgentTask, settings: AgentSettings, missing: string[], items: Items): Promise<number> {
  let got = 0;
  for (let i = 0; i < missing.length; i++) {
    const nm = missing[i];
    await pacedGoto(page, `https://www.wildberries.ru/catalog/${nm}/detail.aspx`, settings, task.id, settings.card_pause_ms);
    const body = await page.evaluate(() => document.body?.innerText ?? '');
    if (looksLikeChallenge(page.url(), body)) throw new Challenge('wb', 'captcha');
    const price = await page.evaluate(() => {
      // «Цена без WB Кошелька»: у WB красная цена — с кошельком, обычная — без.
      // ins.price-block__final-price — цена без кошелька на текущей вёрстке.
      const el = document.querySelector('ins.price-block__final-price, .price-block__final-price');
      const txt = el?.textContent ?? '';
      const n = Number(txt.replace(/[^\d]/g, ''));
      return Number.isFinite(n) && n > 0 ? n : 0;
    }).catch(() => 0);
    if (price > 0) { items[nm] = { price }; got++; }
    else await api.log(task.id, 'warn', `WB ${nm}: цена на карточке не найдена (селектор устарел или товара нет)`);
    checkCancelled(await api.progress(task.id, {
      stage: 'direct_cards', stage_index: 3, stages_total: STAGES.length,
      items_done: i + 1, items_total: missing.length, current_item: nm,
      message: `WB, прямые карточки: ${i + 1} из ${missing.length}`,
    }, i === 0));
  }
  return got;
}

// ─── Ozon: витрина продавца + прямые карточки ───────────────────────────────

/** Снять {sku → цена} с открытой страницы витрины/поиска Ozon. */
async function scrapeOzonTiles(page: Page): Promise<Items> {
  return page.evaluate(() => {
    const out: Record<string, { price: number; oldPrice?: number }> = {};
    const parse = (t: string) => { const n = Number(t.replace(/[^\d]/g, '')); return Number.isFinite(n) && n > 0 && n < 10_000_000 ? n : 0; };
    for (const a of Array.from(document.querySelectorAll('a[href*="/product/"]'))) {
      const m = (a.getAttribute('href') ?? '').match(/\/product\/[^/]*?-?(\d{6,})\/?(\?|$)/);
      if (!m) continue;
      const sku = m[1];
      if (out[sku]) continue;
      // Плитка: ближайший контейнер со знаком ₽. Первая цена — актуальная,
      // вторая (зачёркнутая) — старая. Цену «с Ozon Картой» помечают отдельной
      // подписью — берём цены без подписи «с Ozon Картой».
      let node: Element | null = a;
      for (let up = 0; up < 4 && node; up++) node = node.parentElement;
      const scope = node ?? a;
      const prices: number[] = [];
      for (const el of Array.from(scope.querySelectorAll('span'))) {
        const txt = el.textContent ?? '';
        if (!txt.includes('₽') || txt.length > 24) continue;
        if (/картой/i.test((el.parentElement?.textContent ?? '').slice(0, 60))) continue;
        const n = parse(txt);
        if (n) prices.push(n);
        if (prices.length >= 2) break;
      }
      if (prices.length) out[sku] = { price: prices[0], oldPrice: prices[1] > prices[0] ? prices[1] : undefined };
    }
    return out;
  });
}

async function collectOzon(page: Page, task: AgentTask, settings: AgentSettings): Promise<{ items: Items; missing: string[] }> {
  const wanted = new Set((task.params.skus ?? []).map(String));
  const items: Items = {};
  const MAX_PAGES = 30;
  for (let n = 1; n <= MAX_PAGES; n++) {
    const url = `https://www.ozon.ru/seller/avto-vibe/?page=${n}`;
    await pacedGoto(page, url, settings, task.id, settings.page_pause_ms);
    // Ленивая отрисовка: прокрутить страницу порциями, не мгновенно в конец.
    for (let s = 0; s < 6; s++) {
      await page.mouse.wheel(0, 900).catch(() => {});
      await sleep(400 + Math.random() * 500);
    }
    const body = await page.evaluate(() => document.body?.innerText ?? '');
    if (looksLikeChallenge(page.url(), body)) throw new Challenge('ozon', 'captcha');
    const found = await scrapeOzonTiles(page);
    const before = Object.keys(items).length;
    for (const [sku, v] of Object.entries(found)) if (!items[sku]) items[sku] = v;
    const added = Object.keys(items).length - before;
    checkCancelled(await api.progress(task.id, {
      stage: 'collect_prices', stage_index: 2, stages_total: STAGES.length,
      items_done: Object.keys(items).length, items_total: wanted.size || undefined,
      current_item: `страница ${n}`,
      message: `Ozon: витрина, страница ${n}, собрано ${Object.keys(items).length}${wanted.size ? ` из ${wanted.size}` : ''}`,
    }, n === 1));
    if (added === 0) break; // конец пагинации
  }
  const missing = wanted.size ? [...wanted].filter(s => !items[s]) : [];
  return { items, missing };
}

async function ozonDirectCards(page: Page, task: AgentTask, settings: AgentSettings, missing: string[], items: Items): Promise<number> {
  let got = 0;
  for (let i = 0; i < missing.length; i++) {
    const sku = missing[i];
    await pacedGoto(page, `https://www.ozon.ru/product/${sku}/`, settings, task.id, settings.card_pause_ms);
    const body = await page.evaluate(() => document.body?.innerText ?? '');
    if (looksLikeChallenge(page.url(), body)) throw new Challenge('ozon', 'captcha');
    const price = await page.evaluate(() => {
      // Веб-цена без Ozon Карты: в webPrice-стейте это price (cardPrice — с картой).
      for (const sc of Array.from(document.querySelectorAll('script[type="application/json"]'))) {
        const t = sc.textContent ?? '';
        if (!t.includes('cardPrice') && !t.includes('"price"')) continue;
        const m = t.match(/"price"\s*:\s*"([\d\s ]+)\s*₽"/) ?? t.match(/"price"\s*:\s*(\d+)/);
        if (m) { const n = Number(String(m[1]).replace(/[^\d]/g, '')); if (n > 0) return n; }
      }
      return 0;
    }).catch(() => 0);
    if (price > 0) { items[sku] = { price }; got++; }
    else await api.log(task.id, 'warn', `Ozon ${sku}: цена на карточке не найдена`);
    checkCancelled(await api.progress(task.id, {
      stage: 'direct_cards', stage_index: 3, stages_total: STAGES.length,
      items_done: i + 1, items_total: missing.length, current_item: sku,
      message: `Ozon, прямые карточки: ${i + 1} из ${missing.length}`,
    }, i === 0));
  }
  return got;
}

// ─── Точка входа сценария ───────────────────────────────────────────────────

export async function runShowcasePrices(task: AgentTask, settings: AgentSettings): Promise<void> {
  const mp = task.params.marketplace === 'ozon' ? 'ozon' : 'wb';
  const page = await newPage();
  try {
    checkCancelled(await api.progress(task.id, {
      stage: 'open_showcase', stage_index: 1, stages_total: STAGES.length,
      message: mp === 'wb' ? 'WB: подготовка (card.wb.ru батчами)' : 'Ozon: открываю витрину продавца',
    }, true));

    const { items, missing } = mp === 'wb'
      ? await collectWb(page, task, settings)
      : await collectOzon(page, task, settings);
    const foundOnShowcase = Object.keys(items).length;

    checkCancelled(await api.progress(task.id, {
      stage: 'direct_cards', stage_index: 3, stages_total: STAGES.length,
      items_done: 0, items_total: missing.length,
      message: missing.length ? `Прямые карточки: ${missing.length} не найдено на витрине` : 'Все товары найдены, прямые карточки не нужны',
    }, true));
    // Прямые карточки — дорого (5–12 с на товар): за прогон не больше MAX_DIRECT,
    // остальное попадёт в stats.missing и в следующий прогон.
    const MAX_DIRECT = 40;
    const direct = missing.slice(0, MAX_DIRECT);
    if (missing.length > MAX_DIRECT) await api.log(task.id, 'warn', `не найдено на витрине ${missing.length}, прямыми карточками пройду только ${MAX_DIRECT}`);
    const foundDirect = direct.length
      ? (mp === 'wb' ? await wbDirectCards(page, task, settings, direct, items) : await ozonDirectCards(page, task, settings, direct, items))
      : 0;

    // Отправка батчами по 50.
    const entries = Object.entries(items);
    const batches = Math.max(1, Math.ceil(entries.length / 50));
    checkCancelled(await api.progress(task.id, {
      stage: 'ingest', stage_index: 4, stages_total: STAGES.length,
      items_done: 0, items_total: batches, message: `Отправка в дашборд: ${entries.length} цен, ${batches} батчей`,
    }, true));
    for (let b = 0; b < batches; b++) {
      const slice = Object.fromEntries(entries.slice(b * 50, (b + 1) * 50));
      const ok = await api.ingest(mp === 'wb' ? 'wb-showcase-ingest' : 'ozon-showcase-ingest', slice);
      if (!ok) throw new Error(`ingest батча ${b + 1}/${batches} не прошёл`);
      await api.progress(task.id, {
        stage: 'ingest', stage_index: 4, stages_total: STAGES.length,
        items_done: b + 1, items_total: batches, message: `Отправка в дашборд: батч ${b + 1} из ${batches}`,
      });
    }

    const total = (task.params.skus?.length ?? 0) || foundOnShowcase;
    const stillMissing = Math.max(0, total - foundOnShowcase - foundDirect);
    await api.complete(task.id,
      `${mp.toUpperCase()}: снято ${foundOnShowcase + foundDirect} из ${total}`,
      { found_on_showcase: foundOnShowcase, found_direct: foundDirect, missing: stillMissing, total });
  } catch (e) {
    if (e instanceof Cancelled) {
      await api.fail(task.id, { error: 'отменено пользователем', retryable: false });
    } else if (e instanceof Challenge) {
      await api.fail(task.id, { error: `антибот (${e.kind})`, retryable: false, pause: { marketplace: e.mp, reason: e.kind } });
    } else if (e instanceof LoginRequired) {
      await api.fail(task.id, { error: 'требуется вход в аккаунт', retryable: false, pause: { marketplace: e.mp, reason: 'login_required' } });
    } else {
      await api.fail(task.id, { error: String((e as Error)?.message ?? e).slice(0, 300), retryable: true });
    }
  } finally {
    await page.close().catch(() => {});
  }
}
