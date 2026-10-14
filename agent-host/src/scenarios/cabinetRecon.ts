/**
 * Сценарий cabinet_recon — «разведка кабинета» для Агента 3 «Реклама» (14.10.2026).
 *
 * Зачем. Сравнение с конкурентами, воронка против рынка, поисковые позиции
 * есть только в кабинетах продавца (WB «Аналитика», «Джем»; Ozon «Аналитика»,
 * «Товары на Ozon»), в открытом API их нет. Чтобы написать постоянный сбор,
 * надо знать, какими запросами кабинет сам берёт эти данные. Этот сценарий
 * открывает разделы аналитики в профиле агента и записывает, какие JSON-запросы
 * делает страница и как устроены ответы (ключи, типы, короткие примеры значений).
 *
 * Только чтение (конституция, принцип II):
 *   • переходы — только на страницы из allow-list, никаких кликов по кнопкам;
 *   • меню разделов читаем из ссылок страницы, идём только по ссылкам с
 *     «аналитическими» словами и не идём по запрещённым (финансы, настройки, выход…);
 *   • из ответов сохраняем СТРУКТУРУ, а не данные: числа и строки до 40 символов
 *     как примеры, массивы — длина и первый элемент.
 *
 * Этапы (shared/agents SCENARIO_STAGES.cabinet_recon): open_cabinet → discover → ingest
 */
import type { Page, Response } from 'playwright-core';
import { SCENARIO_STAGES, type AgentSettings, type AgentTask } from '../../../shared/agents';
import * as api from '../api';
import { newPage, sleep, randBetween, looksLikeChallenge } from '../chrome';

const STAGES = SCENARIO_STAGES.cabinet_recon;

/** Только для проверочного стенда: локальный «кабинет» вместо настоящего. */
const TEST_ORIGIN = (process.env.AGENT_RECON_TEST_ORIGIN || '').replace(/\/+$/, '');
const testRe = TEST_ORIGIN ? new RegExp(`^${TEST_ORIGIN.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}/`) : null;

const START: Record<'wb' | 'ozon', string[]> = testRe ? { wb: [`${TEST_ORIGIN}/`], ozon: [`${TEST_ORIGIN}/`] } : {
  wb: ['https://seller.wildberries.ru/'],
  ozon: ['https://seller.ozon.ru/app/analytics'],
};
const ALLOWED: Record<'wb' | 'ozon', RegExp> = testRe ? { wb: testRe, ozon: testRe } : {
  wb: /^https:\/\/(seller|cmp)\.wildberries\.ru\//,
  ozon: /^https:\/\/seller\.ozon\.ru\/app\//,
};
const API_HOST = testRe ?? /wildberries\.ru|wb\.ru|ozon\.ru/;
/** Что ищем в меню кабинета. */
const WANT = /аналитик|воронк|сравнен|конкурент|товары на ozon|рын|поиск|позици|джем|запрос|продвижен|реклам|analytics|funnel|compar|search|promo|adv/i;
/** Куда не ходим никогда. */
const DENY = /logout|exit|signout|sign-out|выход|delete|remove|удал|settings|настройк|финанс|finance|payment|оплат|баланс|balance|bank|банк|документ|document|договор|сотрудник|employee|api-?key|токен|token|поддержк|support|chat|чат/i;
const MAX_PAGES = 12;
const MAX_CALLS_PER_PAGE = 40;

type Skeleton = unknown;

/** Структура JSON: ключи и типы, примеры коротких значений, массивы — длина + первый элемент. */
export function skeleton(v: unknown, depth = 0): Skeleton {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'string') return v.length <= 40 ? v : `str(${v.length})`;
  if (depth > 6) return Array.isArray(v) ? `array(${v.length})` : 'object';
  if (Array.isArray(v)) return v.length ? { __array: v.length, first: skeleton(v[0], depth + 1) } : { __array: 0 };
  const out: Record<string, Skeleton> = {};
  const keys = Object.keys(v as object);
  for (const k of keys.slice(0, 60)) out[k] = skeleton((v as any)[k], depth + 1);
  if (keys.length > 60) out.__more_keys = keys.length - 60;
  return out;
}

type Call = { url: string; method: string; status: number; post: string | null; body: Skeleton };
type PageReport = { url: string; title: string; headings: string[]; text: string; calls: Call[]; links: { text: string; href: string }[] };

function capture(sink: Call[]): (r: Response) => void {
  return (r: Response) => {
    void (async () => {
      try {
        if (sink.length >= MAX_CALLS_PER_PAGE) return;
        const req = r.request();
        if (!['xhr', 'fetch'].includes(req.resourceType())) return;
        const u = r.url();
        if (!API_HOST.test(u)) return;
        if (!/json/i.test(r.headers()['content-type'] ?? '')) return;
        const json = await r.json().catch(() => undefined);
        if (json === undefined) return;
        const post = req.postData();
        sink.push({
          url: u.slice(0, 400), method: req.method(), status: r.status(),
          post: post ? post.slice(0, 1500) : null, body: skeleton(json),
        });
      } catch { /* ответ мог уже уйти — не важно */ }
    })();
  };
}

// Строкой, а не функцией: tsx/esbuild оборачивает вложенные функции в __name(),
// которой нет в странице, и evaluate падает с ReferenceError.
const READ_PAGE = `(() => {
  const t = s => String(s || '').replace(/\\s+/g, ' ').trim();
  const links = [...document.querySelectorAll('a[href]')].map(a => ({ text: t(a.textContent).slice(0, 80), href: a.href }))
    .filter(l => /^https?:\\/\\//.test(l.href));
  const headings = [...document.querySelectorAll('h1,h2,h3,[class*="title" i]')].map(h => t(h.textContent).slice(0, 80)).filter(Boolean);
  return { url: location.href, title: document.title, headings: [...new Set(headings)].slice(0, 40),
    text: t(document.body && document.body.innerText).slice(0, 2500), links: links.slice(0, 400) };
})()`;

async function readPage(page: Page): Promise<Omit<PageReport, 'calls'>> {
  return page.evaluate(READ_PAGE) as Promise<Omit<PageReport, 'calls'>>;
}

export async function runCabinetRecon(task: AgentTask, settings: AgentSettings): Promise<void> {
  const mp = task.params.marketplace === 'ozon' ? 'ozon' : 'wb';
  const allow = ALLOWED[mp];
  const extra = (Array.isArray(task.params.urls) ? task.params.urls : []).map(String).filter(u => allow.test(u) && !DENY.test(u));
  const queue: string[] = [...START[mp], ...extra];
  const seen = new Set<string>();
  const pages: PageReport[] = [];
  const page = await newPage();
  try {
    await api.progress(task.id, stage(0, `Открываю кабинет ${mp === 'wb' ? 'WB' : 'Ozon'}`), true);
    for (let i = 0; queue.length && pages.length < MAX_PAGES; i++) {
      const target = queue.shift()!;
      const key = target.split('#')[0].replace(/\?.*$/, '');
      if (seen.has(key)) continue;
      seen.add(key);

      const calls: Call[] = [];
      const onResp = capture(calls);
      page.on('response', onResp);
      try {
        await sleep(randBetween(settings.page_pause_ms));
        await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        await sleep(7000);
        // Прокрутка вниз — чтобы подгрузились ленивые блоки. Клики не делаем.
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
        await sleep(3000);
      } catch (e) {
        await api.log(task.id, 'warn', `не открылась ${target.slice(0, 120)}: ${(e as Error).message.slice(0, 120)}`);
      } finally {
        page.off('response', onResp);
      }

      const url = page.url();
      const info = await readPage(page).catch(async e => {
        await api.log(task.id, 'warn', `не прочиталась страница ${url.slice(0, 120)}: ${(e as Error).message.slice(0, 160)}`);
        return null;
      });
      if (looksLikeChallenge(url, info?.text ?? '')) {
        await api.fail(task.id, { error: `${mp === 'wb' ? 'WB' : 'Ozon'} показал проверку «не робот» — стоп`, retryable: false, pause: { marketplace: mp, reason: 'captcha' } });
        return;
      }
      if (!allow.test(url)) {
        if (!pages.length) {
          await api.fail(task.id, {
            error: `Нет входа в кабинет ${mp === 'wb' ? 'seller.wildberries.ru' : 'seller.ozon.ru'} в профиле агента (открылось ${url.slice(0, 80)}). Войдите один раз в окне Chrome агента.`,
            retryable: false, pause: { marketplace: mp, reason: 'login_required' },
          });
          return;
        }
        await api.log(task.id, 'warn', `увело за пределы кабинета: ${url.slice(0, 120)} — пропускаю`);
        continue;
      }
      if (!info) continue;
      pages.push({ ...info, calls });
      await api.progress(task.id, stage(1, `Раздел ${pages.length}: ${info.title.slice(0, 60)} · запросов ${calls.length}`,
        { items_done: pages.length, items_total: Math.min(MAX_PAGES, pages.length + queue.length) }), true);

      // Новые разделы из меню: только «аналитические» ссылки в пределах кабинета.
      for (const l of info.links) {
        const k = l.href.split('#')[0].replace(/\?.*$/, '');
        if (!allow.test(l.href) || DENY.test(l.href) || DENY.test(l.text) || seen.has(k) || queue.includes(l.href)) continue;
        if (WANT.test(l.text) || WANT.test(l.href)) queue.push(l.href);
      }
    }

    if (!pages.length) { await api.fail(task.id, { error: 'ни одной страницы кабинета прочитать не удалось', retryable: true }); return; }
    await api.progress(task.id, stage(2, 'Отправляю отчёт в дашборд'), true);
    // Сервер принимает до 5 МБ: если отчёт больше — у самых тяжёлых ответов оставляем только адрес.
    const size = (c: Call) => JSON.stringify(c.body).length;
    const all = pages.flatMap(p => p.calls).sort((a, b) => size(b) - size(a));
    for (const c of all) {
      if (JSON.stringify(pages).length < 4_000_000) break;
      c.body = `обрезано (${size(c)} симв.)`;
    }
    const ok = await api.reconIngest(mp, pages);
    if (!ok) { await api.fail(task.id, { error: 'дашборд не принял отчёт разведки', retryable: true }); return; }
    const callsTotal = pages.reduce((s, p) => s + p.calls.length, 0);
    await api.complete(task.id, `Разделов ${pages.length}, запросов кабинета ${callsTotal}`, { pages: pages.length, calls: callsTotal });
  } finally {
    await page.close().catch(() => {});
  }
}

function stage(i: number, message: string, extra: Partial<{ items_done: number; items_total: number }> = {}) {
  return { stage: STAGES[i].stage, stage_index: i + 1, stages_total: STAGES.length, message, ...extra };
}
