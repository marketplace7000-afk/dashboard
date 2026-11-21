/**
 * Сценарий season_collect — «Закупки» → «Сезонность» (21.11.2026). Без LLM, только чтение.
 *
 * Что делает (план — в task.params, его собирает сервер: api/_lib/season.ts → seasonAgentParams):
 *   1. Кабинет Ozon → Аналитика → «Поисковые запросы» (/app/analytics/what-to-sell/all-queries).
 *      Для каждого месяца из плана выбирает «Период: <месяц>», затем для каждого запроса вписывает его
 *      в фильтр и читает «Популярность запроса» строки, совпадающей с запросом. Кабинет хранит 12 месяцев.
 *   2. Вордстат: wordstat.yandex.ru, «Динамика» по месяцам за 2 года; берём долю от всех запросов, %.
 * Ничего не нажимает, кроме фильтров периода и поиска. Капча / вход — стоп и сообщение (принцип I).
 * Работает кусками: не дольше task.params.budget_min минут; что не успел — сервер поставит следующим заданием.
 *
 * Этапы (shared/agents SCENARIO_STAGES.season_collect): open_cabinet → ozon_months → wordstat
 */
import type { Page } from 'playwright-core';
import { SCENARIO_STAGES, type AgentSettings, type AgentTask } from '../../../shared/agents';
import * as api from '../api';
import { newPage, sleep, randBetween, looksLikeChallenge } from '../chrome';

const STAGES = SCENARIO_STAGES.season_collect;
const OZON_URL = 'https://seller.ozon.ru/app/analytics/what-to-sell/all-queries';
const OZON_ALLOWED = /^https:\/\/seller\.ozon\.ru\/app\/analytics\//;
const WORDSTAT = (q: string) => `https://wordstat.yandex.ru/?region=all&view=graph&words=${encodeURIComponent(q)}`;
const MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
const MONTHS_TITLE = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];

type Item = { category: string; query: string };
type Row = { source: 'ozon' | 'wordstat'; category: string; query: string; month: string; value: number };
const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();

function stage(i: number, message: string, extra: Partial<{ items_done: number; items_total: number; current_item: string }> = {}) {
  return { stage: STAGES[i].stage, stage_index: i + 1, stages_total: STAGES.length, message, ...extra };
}

/** Выбрать «Период: <месяц>» в фильтре кабинета. Возвращает false, если месяца в списке нет. */
async function selectMonth(page: Page, month: string): Promise<boolean> {
  const value = `${month}-01T00:00:00.000Z`;
  const [y, m] = month.split('-').map(Number);
  await page.locator('button', { hasText: /^\s*Период/ }).first().click();
  await sleep(800);
  let radio = page.locator(`input[type="radio"][value="${value}"]`);
  if (!(await radio.count())) {
    // Год свёрнут — раскрыть.
    await page.locator('button', { hasText: `${y} год` }).first().click().catch(() => undefined);
    await sleep(600);
    radio = page.locator(`input[type="radio"][value="${value}"]`);
  }
  if (!(await radio.count())) { await page.keyboard.press('Escape'); return false; }
  const wait = page.waitForResponse(r => r.url().includes('/queries/search/'), { timeout: 25_000 }).catch(() => null);
  await radio.first().scrollIntoViewIfNeeded().catch(() => undefined);
  await radio.first().click({ force: true });
  await wait;
  await sleep(1200);
  const label = (await page.locator('button', { hasText: /^\s*Период/ }).first().innerText().catch(() => '')).trim();
  return label.includes(MONTHS_TITLE[m - 1]);
}

/** Вписать запрос в фильтр и прочитать «Популярность запроса» точного совпадения (0 — такого запроса в месяце нет). */
async function readQuery(page: Page, query: string): Promise<number | null> {
  const input = page.locator('input[placeholder="Поисковый запрос"]').first();
  await input.fill('');
  await input.fill(query);
  const wait = page.waitForResponse(r => r.url().includes('/queries/search/'), { timeout: 25_000 }).catch(() => null);
  await input.press('Enter');
  const resp = await wait;
  if (!resp) return null;
  await sleep(900);
  const rows = await page.evaluate(() => {
    const head = [...document.querySelectorAll('thead th, [role="columnheader"]')].map(h => (h as HTMLElement).innerText.replace(/\s+/g, ' ').trim());
    let col = head.findIndex(h => /Популярность/.test(h));
    if (col < 0) col = 1;
    return [...document.querySelectorAll('tbody tr')].map(tr => {
      const td = [...tr.querySelectorAll('td')].map(c => (c as HTMLElement).innerText.replace(/\s+/g, ' ').trim());
      return { q: td[0] ?? '', v: td[col] ?? '' };
    });
  });
  const want = norm(query);
  const hit = rows.find(r => norm(r.q) === want);
  if (!hit) return 0;
  const n = Number(hit.v.replace(/[^\d]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** Вордстат: { 'YYYY-MM': доля, % } из таблицы «Динамика». null — страница не та (вход, капча). */
async function readWordstat(page: Page, query: string): Promise<{ months: Record<string, number> } | { stop: string }> {
  await page.goto(WORDSTAT(query), { waitUntil: 'domcontentloaded', timeout: 60_000 });
  for (let i = 0; i < 10; i++) {
    await sleep(1500);
    const t = await page.evaluate(() => document.body?.innerText ?? '');
    const url = page.url();
    if (looksLikeChallenge(url, t)) return { stop: 'Вордстат показал проверку «не робот»' };
    if (/passport\.yandex|\/auth/.test(url)) return { stop: 'нет входа в Яндекс в профиле агента — войдите один раз на wordstat.yandex.ru в окне Chrome агента' };
    const months: Record<string, number> = {};
    const re = new RegExp(`(${MONTHS.join('|')})\\s+(\\d{4})\\t([\\d\\s\\u00a0]+)\\t([\\d.,]+)`, 'g');
    for (const m of t.matchAll(re)) {
      const share = Number(m[4].replace(',', '.'));
      if (Number.isFinite(share)) months[`${m[2]}-${String(MONTHS.indexOf(m[1]) + 1).padStart(2, '0')}`] = share;
    }
    if (Object.keys(months).length >= 6) return { months };
    if (/ничего не найдено|нет данных/i.test(t)) return { months: {} };
  }
  return { months: {} };
}

export async function runSeasonCollect(task: AgentTask, settings: AgentSettings): Promise<void> {
  const p = task.params as any;
  const ozon: { month: string; items: Item[] }[] = Array.isArray(p.ozon) ? p.ozon : [];
  const words: Item[] = Array.isArray(p.wordstat) ? p.wordstat : [];
  const deadline = Date.now() + Math.max(5, Number(p.budget_min) || 35) * 60_000;
  const totalOzon = ozon.reduce((a, m) => a + m.items.length, 0);
  let doneOzon = 0, doneWs = 0, buf: Row[] = [];
  const notes: string[] = [];
  const flush = async () => {
    if (!buf.length) return;
    const ok = await api.seasonIngest(buf);
    if (!ok) throw new Error('сервер не принял данные сезонности');
    buf = [];
  };
  const page = await newPage();
  try {
    // 1–2. Ozon
    if (ozon.length) {
      await api.progress(task.id, stage(0, 'Открываю «Поисковые запросы» в кабинете Ozon'), true);
      await page.goto(OZON_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await sleep(6000);
      const url = page.url();
      const body = await page.evaluate(() => document.body?.innerText ?? '');
      if (looksLikeChallenge(url, body)) {
        await api.fail(task.id, { error: 'Ozon показал проверку «не робот» — стоп', retryable: false, pause: { marketplace: 'ozon', reason: 'captcha' } });
        return;
      }
      if (!OZON_ALLOWED.test(url)) {
        await api.fail(task.id, { error: `Нет входа в кабинет Ozon в профиле агента (открылось ${url.slice(0, 80)})`, retryable: false, pause: { marketplace: 'ozon', reason: 'login_required' } });
        return;
      }
      outer: for (const m of ozon) {
        if (Date.now() > deadline) break;
        await api.progress(task.id, stage(1, `Ozon: ${m.month}`, { items_done: doneOzon, items_total: totalOzon, current_item: m.month }), true);
        if (!(await selectMonth(page, m.month))) {
          notes.push(`Ozon: месяца ${m.month} нет в кабинете`);
          // Месяц ушёл из кабинета — отметить нулями, чтобы сервер больше не просил.
          for (const it of m.items) buf.push({ source: 'ozon', category: it.category, query: it.query, month: m.month, value: 0 });
          doneOzon += m.items.length;
          continue;
        }
        for (const it of m.items) {
          if (Date.now() > deadline) { await flush(); break outer; }
          const v = await readQuery(page, it.query);
          if (v !== null) buf.push({ source: 'ozon', category: it.category, query: it.query, month: m.month, value: v });
          doneOzon++;
          const st = await api.progress(task.id, stage(1, `Ozon ${m.month}: «${it.query}» — ${v ?? 'нет ответа'}`, { items_done: doneOzon, items_total: totalOzon, current_item: it.query }));
          if (st === 'cancelled') { await flush(); return; }
          await sleep(randBetween([1500, 3500]));
        }
        await flush();
        const t = await page.evaluate(() => document.body?.innerText ?? '');
        if (looksLikeChallenge(page.url(), t)) {
          await api.fail(task.id, { error: 'Ozon показал проверку «не робот» — стоп', retryable: false, pause: { marketplace: 'ozon', reason: 'captcha' } });
          return;
        }
      }
    }
    // 3. Вордстат
    for (const it of words) {
      if (Date.now() > deadline) break;
      await api.progress(task.id, stage(2, `Вордстат: «${it.query}»`, { items_done: doneWs, items_total: words.length, current_item: it.query }), doneWs === 0);
      const r = await readWordstat(page, it.query);
      if ('stop' in r) { notes.push(`Вордстат: ${r.stop}`); await api.log(task.id, 'warn', r.stop); break; }
      for (const [month, value] of Object.entries(r.months)) buf.push({ source: 'wordstat', category: it.category, query: it.query, month, value });
      if (!Object.keys(r.months).length) {
        notes.push(`Вордстат: «${it.query}» — нет таблицы`);
        // Отметка «проверено в этом цикле», чтобы сервер не просил снова.
        buf.push({ source: 'wordstat', category: it.category, query: it.query, month: new Date().toISOString().slice(0, 7), value: 0 });
      }
      doneWs++;
      if (doneWs % 5 === 0) await flush();
      await sleep(randBetween(settings.page_pause_ms));
    }
    await flush();
    const left = (totalOzon - doneOzon) + (words.length - doneWs);
    await api.complete(task.id, `Ozon: ${doneOzon} из ${totalOzon}; Вордстат: ${doneWs} из ${words.length}${left ? `; осталось ${left} — следующим заданием` : ''}${notes.length ? '. ' + notes.slice(0, 4).join('; ') : ''}`,
      { ozon: doneOzon, wordstat: doneWs, left });
  } catch (e) {
    await flush().catch(() => undefined);
    await api.fail(task.id, { error: `сезонность: ${String((e as Error)?.message ?? e).slice(0, 250)}`, retryable: true });
  } finally {
    await page.close().catch(() => undefined);
  }
}
