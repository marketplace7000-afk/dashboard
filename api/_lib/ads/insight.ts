/**
 * Claude-анализ рекламы («Управление рекламой», этап 2, 17.09.2026).
 *
 * Вход — товарная модель из manage.ts (реклама + все заказы + остатки FBS + маржа),
 * выход — рекомендации по каждому артикулу (усилить / держать / сбавить / остановить /
 * запустить) с конкретным шагом и оценкой эффекта в рублях за неделю, плюс 3–5
 * действий по магазину. Ответ строго JSON, кэш сутки, журнал запусков для
 * сравнения «что советовали → что стало» (этап 3).
 *
 * Запуск: кнопкой на странице (refresh) или автоматически раз в сутки после 06:00 МСК
 * из цепочки warm-extras (cron.ts → runAdsInsightIfDue).
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { cacheGet, cacheSet, isFresh } from '../cache';
import type { ManageReport, ManageRow, Platform } from './manage';

export type InsightAction = 'усилить' | 'держать' | 'сбавить' | 'остановить' | 'запустить';
export type InsightItem = {
  article: string;
  action: InsightAction;
  why: string;
  step: string;
  effectRub: number;
  risk?: string;
};
export type AdsInsight = {
  platform: Platform;
  generatedAt: number;
  model: string;
  summary: string;
  storeActions: { priority: 'high' | 'medium' | 'low'; text: string }[];
  items: InsightItem[];
  warnings: string[];
  /** Слепок метрик на момент совета — для журнала. */
  basis: Record<string, { spend7: number; orders7: number; revenue7: number; drr7: number | null; stockDays: number | null }>;
  /** Что изменилось у артикулов из прошлого запуска (заполняется при следующем прогоне). */
  followUp?: { prevAt: number; lines: string[] };
  error?: string;
};

const TTL_MS = 24 * 3600_000;
const JOURNAL = '.av-cache/ads-insight-journal.json';
const MAX_JOURNAL = 60;
const cacheKey = (p: Platform) => `ads-insight:v1:${p}`;

const ROLE = `Ты — руководитель отдела рекламы селлера на Wildberries и Ozon (автотовары, электроника, гаджеты). ` +
  `Цель бизнеса: продавать больше и эффективнее, держать хорошую оборачиваемость при нормальной марже. ` +
  `Бизнес полностью на FBS: товар лежит на своём складе в Уфе и на фулфилментах (Подольск, СПБ, Краснодар, Уфа); ` +
  `«остаток» в данных — это то, что реально доступно площадке, «в пути» — едет на склад. ` +
  `Ты даёшь короткие практичные решения, как опытный менеджер, а не общие слова.`;

function compactRows(rows: ManageRow[]): any[] {
  return rows
    .filter((r) => r.spend7 > 0 || r.spend30 > 0 || r.orders7 > 0 || (r.stock ?? 0) > 0)
    .sort((a, b) => b.spend7 - a.spend7 || b.revenue7 - a.revenue7)
    .slice(0, 60)
    .map((r) => ({
      art: r.article, name: r.name.slice(0, 40), status: r.status,
      spend7: r.spend7, spend30: r.spend30, adsRev7: r.adsRevenue7, rev7: r.revenue7,
      ord7: r.orders7, adsOrd7: r.adsOrders7, drr7: r.drr7 ?? r.drrAds7, drr30: r.drr30, norm: r.norm,
      ctr: r.ctr7, cpc: r.cpc7, views7: r.views7,
      stock: r.stock, transit: r.transit, stockDays: r.stockDays, perDay: r.velocity,
      marginPct: r.marginPct, marginAfterAds: r.marginAfterAdsPct,
    }));
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Claude не ответил за ${Math.round(ms / 1000)} с`)), ms);
    (t as any).unref?.();
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

function readJournal(): any[] {
  try { return existsSync(JOURNAL) ? JSON.parse(readFileSync(JOURNAL, 'utf8')) : []; } catch { return []; }
}
function writeJournal(entries: any[]) {
  try { mkdirSync('.av-cache', { recursive: true }); writeFileSync(JOURNAL, JSON.stringify(entries.slice(-MAX_JOURNAL))); } catch { /* best effort */ }
}

/** Сравнение с прошлым советом по этой площадке: выполнено ли и что стало с ДРР/заказами. */
function buildFollowUp(prev: AdsInsight | null, rows: ManageRow[]): AdsInsight['followUp'] {
  if (!prev?.items?.length) return undefined;
  const byArt = new Map(rows.map((r) => [r.article, r]));
  const lines: string[] = [];
  for (const it of prev.items.slice(0, 15)) {
    const r = byArt.get(it.article); const b = prev.basis?.[it.article];
    if (!r || !b) continue;
    const dSpend = r.spend7 - b.spend7;
    const done = it.action === 'усилить' ? dSpend > b.spend7 * 0.15
      : it.action === 'сбавить' ? dSpend < -b.spend7 * 0.15
      : it.action === 'остановить' ? r.spend7 < Math.max(300, b.spend7 * 0.2)
      : it.action === 'запустить' ? r.spend7 > 300 : Math.abs(dSpend) <= Math.max(500, b.spend7 * 0.3);
    lines.push(`${it.article}: совет «${it.action}» — ${done ? 'выполнено' : 'не выполнено'}; расход ${b.spend7}→${r.spend7} ₽, ` +
      `заказы ${b.orders7}→${r.orders7}, ДРР ${b.drr7 ?? '—'}→${r.drr7 ?? r.drrAds7 ?? '—'}%`);
  }
  return lines.length ? { prevAt: prev.generatedAt, lines } : undefined;
}

export async function buildAdsInsight(platform: Platform, report: ManageReport): Promise<AdsInsight> {
  const { callAnthropic, extractJson, DEFAULT_MODEL } = await import('../anthropic') as any;
  const rows = report.rows.filter((r) => r.platform === platform);
  const sum = report.summary[platform];
  const prev = (await cacheGet<AdsInsight>(cacheKey(platform)))?.data ?? null;
  const followUp = buildFollowUp(prev, rows);
  const data = compactRows(rows);
  const mpName = platform === 'wb' ? 'Wildberries' : 'Ozon';
  const prompt =
    `Площадка ${mpName}. Сводка за 7 дней: расход ${sum.spend7} ₽ (30 дн: ${sum.spend30} ₽), выручка по всем заказам ${sum.revenue7} ₽, ` +
    `ДРР магазина ${sum.drr7 ?? '—'}% при норме ${sum.norm}% (30 дн: ${sum.drr30 ?? '—'}%), товаров в рекламе ${sum.withAds} из ${sum.items}, ` +
    `с остатком меньше 7 дней: ${sum.stockCritical}.\n\n` +
    `Правила, которых придерживается клиент:\n` +
    `- ДРР считаем как расход / выручка по ВСЕМ заказам товара (не только рекламным). Норма ДРР по категориям в поле norm.\n` +
    `- Не разгонять рекламу, если остатка меньше 14 дней (stockDays) и ничего не едет (transit) — товар кончится, реклама сгорит.\n` +
    `- Останавливать, если есть расход и нет заказов; сбавлять (ставки/бюджет), если ДРР сильно выше нормы или маржа после рекламы (marginAfterAds) ниже 10%.\n` +
    `- Усиливать, где ДРР ниже нормы, заказы идут, маржа после рекламы хорошая и остатка хватает — это точки роста.\n` +
    `- «Запустить» — товар с остатком и продажами, но без рекламы (spend7 = 0), если у него есть маржа.\n` +
    `- Эффект считай грубо, в рублях за неделю: для «сбавить/остановить» — экономия расхода минус потерянная маржа с рекламных заказов; ` +
    `для «усилить» — дополнительная маржа с ожидаемых заказов минус доп. расход (не более +50% к текущему расходу).\n\n` +
    (followUp ? `Что стало с прошлыми советами (${new Date(followUp.prevAt).toLocaleDateString('ru-RU')}, прошло ${Math.round((Date.now() - followUp.prevAt) / 3600_000)} ч; ` +
      `окна 7 дней отражают изменения с задержкой — если прошло меньше 48 ч, не считай советы проигнорированными и не пиши об этом):\n${followUp.lines.join('\n')}\n\n` : '') +
    `Товары (JSON, поля: art артикул, status статус по правилам, spend7/spend30 расход ₽, adsRev7 выручка с рекламы, rev7 выручка всех заказов, ` +
    `ord7/adsOrd7 заказы все/с рекламы, drr7/drr30 ДРР %, norm норма %, ctr %, cpc ₽, views7 показы, stock остаток шт, transit в пути, ` +
    `stockDays дней остатка, perDay шт/день, marginPct маржа %, marginAfterAds маржа после рекламы %):\n${JSON.stringify(data)}\n\n` +
    `Верни СТРОГО JSON без текста вне JSON и без markdown-обёртки:\n{\n` +
    ` "summary": "2–3 предложения: главное по рекламе площадки — где течёт бюджет, где точки роста",\n` +
    ` "storeActions": [{"priority":"high|medium|low","text":"действие по магазину в целом"}],\n` +
    ` "items": [{"article":"артикул как в данных","action":"усилить|держать|сбавить|остановить|запустить","why":"1 фраза с цифрами","step":"конкретный шаг: на сколько % изменить бюджет/ставку, что проверить","effectRub":число ₽ в неделю (плюс — прибыль, минус — потеря),"risk":"кратко, если есть"}],\n` +
    ` "warnings": ["риски/аномалии данных"]\n}\n` +
    `В items — до 12 самых важных артикулов, сначала остановить/сбавить с наибольшей экономией, потом усилить/запустить с наибольшим эффектом. ` +
    `«держать» включай только для 1–2 крупных по расходу товаров. why — до 12 слов, step — до 15 слов, summary — до 50 слов. ` +
    `Не выдумывай товары и цифры — только из данных. JSON выдай компактно, в одну строку, без переносов и отступов.`;

  const basis: AdsInsight['basis'] = {};
  for (const r of rows) basis[r.article] = { spend7: r.spend7, orders7: r.orders7, revenue7: r.revenue7, drr7: r.drr7 ?? r.drrAds7, stockDays: r.stockDays };
  const out: AdsInsight = {
    platform, generatedAt: Date.now(), model: String(DEFAULT_MODEL ?? process.env.ANTHROPIC_DEFAULT_MODEL ?? 'claude-sonnet-4-6'),
    summary: '', storeActions: [], items: [], warnings: [], basis, followUp,
  };
  if (!data.length) { out.error = 'нет данных по товарам'; return out; }
  try {
    // Релей (Vercel) режет длинные ответы — держим ответ компактным и не ждём дольше 100 с.
    const { text } = await withTimeout(callAnthropic({
      system: ROLE,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 2600,
      temperature: 0.2,
      agent: `ads-insight:${platform}`,
    }), 100_000);
    const parsed = extractJson(text) as Partial<AdsInsight> | null;
    if (!parsed) { out.error = 'Claude вернул не JSON'; out.summary = String(text).slice(0, 600); return out; }
    const known = new Set(rows.map((r) => r.article));
    out.summary = String(parsed.summary ?? '');
    out.storeActions = Array.isArray(parsed.storeActions) ? parsed.storeActions.slice(0, 6).map((a: any) => ({
      priority: (['high', 'medium', 'low'].includes(a?.priority) ? a.priority : 'medium'), text: String(a?.text ?? ''),
    })).filter((a) => a.text) : [];
    const ACTIONS: InsightAction[] = ['усилить', 'держать', 'сбавить', 'остановить', 'запустить'];
    out.items = Array.isArray(parsed.items) ? parsed.items.map((it: any) => ({
      article: String(it?.article ?? '').trim().toUpperCase(),
      action: (ACTIONS.includes(it?.action) ? it.action : 'держать') as InsightAction,
      why: String(it?.why ?? ''), step: String(it?.step ?? ''),
      effectRub: Math.round(Number(it?.effectRub) || 0),
      risk: it?.risk ? String(it.risk) : undefined,
    })).filter((it: InsightItem) => known.has(it.article)).slice(0, 30) : [];
    out.warnings = Array.isArray(parsed.warnings) ? parsed.warnings.map(String).slice(0, 8) : [];
  } catch (e) {
    out.error = (e as Error).message;
    if (prev && !prev.error) return { ...prev, error: `новый анализ не удался: ${out.error}`, followUp };
  }
  return out;
}

export async function getAdsInsight(platform: Platform, refresh = false): Promise<AdsInsight> {
  const cached = await cacheGet<AdsInsight>(cacheKey(platform));
  if (!refresh && isFresh(cached)) return cached.data;
  if (!refresh && cached?.data) return cached.data; // просрочен, но есть — отдаём, cron обновит
  const { getAdsManage } = await import('./manage');
  const report = await getAdsManage(refresh);
  const fresh = await buildAdsInsight(platform, report);
  if (!fresh.error) {
    await cacheSet(cacheKey(platform), fresh, TTL_MS);
    const j = readJournal();
    j.push({ at: fresh.generatedAt, platform, items: fresh.items, storeActions: fresh.storeActions, summary: fresh.summary, basis: fresh.basis });
    writeJournal(j);
  }
  return fresh;
}

export function getInsightJournal(platform?: Platform): any[] {
  const j = readJournal();
  return platform ? j.filter((e) => e.platform === platform) : j;
}

/** Раз в сутки после 06:00 МСК — из цепочки прогрева (cron.ts). */
export async function runAdsInsightIfDue(): Promise<string> {
  const msk = new Date(Date.now() + 3 * 3600_000);
  if (msk.getUTCHours() < 6) return 'рано (до 06:00 МСК)';
  const today = msk.toISOString().slice(0, 10);
  const out: string[] = [];
  for (const p of ['wb', 'ozon'] as Platform[]) {
    const cached = await cacheGet<AdsInsight>(cacheKey(p));
    const last = cached?.data?.generatedAt ? new Date(cached.data.generatedAt + 3 * 3600_000).toISOString().slice(0, 10) : '';
    if (last === today) { out.push(`${p}: уже есть за сегодня`); continue; }
    const r = await getAdsInsight(p, true).catch((e) => ({ error: (e as Error).message } as AdsInsight));
    out.push(`${p}: ${r.error ? 'ошибка ' + r.error : `${r.items.length} рекомендаций`}`);
  }
  return out.join('; ');
}
