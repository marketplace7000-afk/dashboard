/**
 * Агенты 6 и 7 — «Изменения на Ozon / Wildberries».
 *
 * Следят за тем, что реально бьёт по деньгам: КОМИССИИ и ТАРИФЫ логистики/хранения.
 * Берём их из ОФИЦИАЛЬНЫХ API (а не парсим новости — те ломаются при смене вёрстки),
 * сравниваем со снимком прошлой проверки и, если что-то поменялось, просим Claude
 * объяснить последствия и предложить план: что делать, что придержать.
 *
 * Первый запуск только сохраняет снимок (сравнивать не с чем) — это нормально.
 */
import { cacheGet, cacheSet, makeUpstreamCacheKey } from '../cache';
import { getWbCommissions } from '../wbCommissions';
import { getWbBoxTariffs } from '../wbBoxTariffs';
import { callAnthropic, extractJson } from '../anthropic';
import { addTheses, Marketplace, Thesis, ThesisCategory } from './knowledgeBase';
import { Agent, AgentMessage, mskDay } from './types';

const SNAP_TTL = 400 * 24 * 60 * 60_000;   // снимки храним долго — сравниваем во времени
const WB_SNAP_KEY = 'agent:mp-changes:wb:v1';
const OZ_SNAP_KEY = 'agent:mp-changes:ozon:v1';
// Порог, ниже которого изменение считаем шумом округления, а не реальной правкой.
const EPS = 0.009;

type WbSnapshot = { commissions: Record<string, number>; tariffs: Record<string, number> };
type OzSnapshot = { commissions: Record<string, number> };

/** Человекочитаемый разбор изменений: что было → что стало. */
type Diff = { label: string; before: number; after: number };

function diffMaps(before: Record<string, number>, after: Record<string, number>, fmtLabel: (k: string) => string): Diff[] {
  const out: Diff[] = [];
  for (const [k, v] of Object.entries(after)) {
    const prev = before[k];
    if (prev == null) continue;                     // новая позиция — не считаем «изменением»
    if (Math.abs(v - prev) > EPS) out.push({ label: fmtLabel(k), before: prev, after: v });
  }
  return out;
}

/**
 * Просим Claude превратить сырые изменения в ТЕЗИСЫ для базы знаний.
 * Возвращаем структуру, а не свободный текст: тезисы копятся в разделе
 * «База знаний», а в Telegram уходит только уведомление.
 */
async function toTheses(mpName: 'Wildberries' | 'Ozon', mp: Marketplace, diffs: Diff[]): Promise<Thesis[]> {
  const list = diffs
    .slice(0, 30)
    .map(d => `- ${d.label}: было ${d.before} → стало ${d.after}`)
    .join('\n');
  const { text } = await callAnthropic({
    system: [
      'Ты — аналитик маркетплейсов для ИП (автотовары, CarPlay-адаптеры, WB и Ozon).',
      'Тебе дают список изменений комиссий/тарифов площадки. Сформулируй ТЕЗИСЫ.',
      'Верни СТРОГО JSON без текста вокруг:',
      '{"theses":[{"category":"тарифы|комиссии","text":"что изменилось, 1-2 предложения",' +
      '"impact":"что это значит для нас (маржа, расходы)","action":"что сделать, коротко"}]}',
      'Максимум 5 тезисов, только по существу. Не выдумывай цифр сверх данных.',
    ].join('\n'),
    messages: [{ role: 'user', content: `Площадка: ${mpName}\nИзменения:\n${list}` }],
    max_tokens: 900,
    agent: 'mp-changes',
  });
  const parsed = extractJson<{ theses?: any[] }>(text);
  const day = mskDay();
  return (parsed?.theses ?? [])
    .filter(t => t?.text)
    .map(t => ({
      mp,
      date: day,
      category: (['тарифы', 'комиссии'].includes(t.category) ? t.category : 'тарифы') as ThesisCategory,
      text: String(t.text).slice(0, 600),
      impact: t.impact ? String(t.impact).slice(0, 400) : null,
      action: t.action ? String(t.action).slice(0, 400) : null,
      source: 'официальный API площадки',
    }));
}

// ─── Wildberries: комиссии по предметам + тарифы короба ──────────────────────
async function runWb(): Promise<AgentMessage[]> {
  const [comm, tar] = await Promise.all([
    getWbCommissions().catch(() => null),
    getWbBoxTariffs().catch(() => null),
  ]);
  if (!comm && !tar) return [];

  // Ставки теперь приходят по каждой схеме отдельно (FBO/FBS). Разворачиваем в
  // плоские ключи, чтобы агент замечал изменение в ЛЮБОЙ из них: клиент может
  // работать по одной схеме, а планировать переход на другую.
  const commissions: Record<string, number> = {};
  for (const [sid, rates] of Object.entries(comm?.items ?? {})) {
    const name = rates.subjectName || sid;
    if (rates.paidStorageKgvp) commissions[`${name} · FBO`] = rates.paidStorageKgvp;
    if (rates.kgvpMarketplace) commissions[`${name} · FBS`] = rates.kgvpMarketplace;
  }

  const fresh: WbSnapshot = {
    commissions,
    tariffs: tar ? {
      'логистика · первый литр': tar.deliveryBase,
      'логистика · доп. литр': tar.deliveryLiter,
      'коэффициент склада': tar.deliveryCoef,
      'хранение · первый литр': tar.storageBase,
      'хранение · доп. литр': tar.storageLiter,
    } : {},
  };

  const prev = (await cacheGet<WbSnapshot>(WB_SNAP_KEY))?.data;
  await cacheSet(WB_SNAP_KEY, fresh, SNAP_TTL);
  if (!prev) return [];                              // первый запуск — только запомнили

  const diffs = [
    ...diffMaps(prev.tariffs, fresh.tariffs, k => `Тариф: ${k}`),
    ...diffMaps(prev.commissions, fresh.commissions, k => `Комиссия: ${k}`),
  ];
  if (!diffs.length) return [];

  const theses = await toTheses('Wildberries', 'wb', diffs).catch(() => [] as Thesis[]);
  addTheses(theses);                                 // копим в разделе «База знаний»
  const head = `<b>Wildberries: изменились тарифы/комиссии</b> (${diffs.length})\n\n` +
    diffs.slice(0, 10).map(d => `• ${d.label}: <b>${d.before} → ${d.after}</b>`).join('\n') +
    (diffs.length > 10 ? `\n…и ещё ${diffs.length - 10}` : '');
  const body = theses.map(t => `• ${t.text}${t.action ? `\n  Что делать: ${t.action}` : ''}`).join('\n');
  return [{
    key: `agent7:wb:${mskDay()}`,
    text: `${head}${body ? `\n\n${body}` : ''}\n\n<i>Тезисы сохранены в разделе «База знаний».</i>`,
  }];
}

// ─── Ozon: комиссии из прогретого кэша цен (v5/product/info/prices) ──────────
async function runOzon(): Promise<AgentMessage[]> {
  const key = makeUpstreamCacheKey('ozon-seller', 'POST', 'v5/product/info/prices', '', JSON.stringify({
    filter: { visibility: 'ALL' }, limit: 1000, cursor: '',
  }));
  const cached = await cacheGet<{ status: number; text: string }>(key);
  if (!cached || cached.data.status >= 400) return [];

  let rows: any[] = [];
  try { rows = JSON.parse(cached.data.text)?.items ?? []; } catch { return []; }
  if (!rows.length) return [];

  // Комиссия FBO по каждому SKU — то, что напрямую влияет на нашу маржу.
  const commissions: Record<string, number> = {};
  for (const r of rows) {
    const offer = String(r?.offer_id ?? '').trim();
    const pct = Number(r?.commissions?.sales_percent_fbo);
    if (offer && Number.isFinite(pct) && pct > 0) commissions[offer] = pct;
  }
  if (!Object.keys(commissions).length) return [];

  const fresh: OzSnapshot = { commissions };
  const prev = (await cacheGet<OzSnapshot>(OZ_SNAP_KEY))?.data;
  await cacheSet(OZ_SNAP_KEY, fresh, SNAP_TTL);
  if (!prev) return [];

  const diffs = diffMaps(prev.commissions, fresh.commissions, k => `Комиссия FBO · ${k}`);
  if (!diffs.length) return [];

  const theses = await toTheses('Ozon', 'ozon', diffs).catch(() => [] as Thesis[]);
  addTheses(theses);
  const head = `<b>Ozon: изменились комиссии</b> (${diffs.length} SKU)\n\n` +
    diffs.slice(0, 10).map(d => `• ${d.label}: <b>${d.before}% → ${d.after}%</b>`).join('\n') +
    (diffs.length > 10 ? `\n…и ещё ${diffs.length - 10}` : '');
  const body = theses.map(t => `• ${t.text}${t.action ? `\n  Что делать: ${t.action}` : ''}`).join('\n');
  return [{
    key: `agent6:ozon:${mskDay()}`,
    text: `${head}${body ? `\n\n${body}` : ''}\n\n<i>Тезисы сохранены в разделе «База знаний».</i>`,
  }];
}

export const ozonChangesAgent: Agent = {
  id: 'ozon-changes',
  name: 'Агент 6 · Изменения Ozon',
  role: 'Следит за комиссиями Ozon и объясняет последствия для маржи',
  schedule: 'daily',
  run: runOzon,
};

export const wbChangesAgent: Agent = {
  id: 'wb-changes',
  name: 'Агент 7 · Изменения Wildberries',
  role: 'Следит за тарифами и комиссиями WB и объясняет последствия для маржи',
  schedule: 'daily',
  run: runWb,
};
