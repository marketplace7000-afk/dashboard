/**
 * Сбор отзывов и вопросов (раздел 2 ТЗ).
 *   WB: отзывы и вопросы — Seller API (feedbacks-api), сервер.
 *   Ozon: вопросы — Seller API (v1/question/*), сервер — проверено 04.10.2026.
 *   Ozon: отзывы — API отвечает PermissionDenied «not available with existing
 *         subscription» при Premium Plus (проверка 04.10.2026) → ветка Б,
 *         браузерный агент на ПК (отдельный этап).
 */
import { wbUpstream, ozonUpstream } from '../../_proxy';
import { fetchWithRetry } from '../fetchRetry';
import { upsertItem, markAnsweredExcept, setCollectState, rlog, getDb, kvGet, kvSet } from './db';

const OZON_REVIEWS_NOTE = 'Ozon не отдаёт отзывы по API на текущей подписке (Premium Plus, проверено 04.10). Сбор — через агента на ПК, этап в разработке.';

function ts(s: unknown): number {
  const t = Date.parse(String(s || ''));
  return Number.isFinite(t) ? t : Date.now();
}

async function wbGet(path: string): Promise<any> {
  const up = wbUpstream('feedbacks');
  const r = await fetchWithRetry(`${up.base}${path}`, { headers: up.headers as any }, { maxRetries: 2, timeoutMs: 60_000 });
  const t = await r.text();
  if (!r.ok) throw new Error(`WB ${r.status}: ${t.slice(0, 200)}`);
  const j = JSON.parse(t);
  if (j?.error) throw new Error(`WB: ${j.errorText || 'error'}`);
  return j?.data ?? {};
}

async function ozonPost(path: string, body: unknown): Promise<any> {
  const up = ozonUpstream();
  const r = await fetchWithRetry(`${up.base}${path}`, {
    method: 'POST',
    headers: { ...(up.headers as any), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, { maxRetries: 2, timeoutMs: 30_000 });
  const t = await r.text();
  if (!r.ok) throw new Error(`Ozon ${r.status}: ${t.slice(0, 200)}`);
  return JSON.parse(t);
}

// ─── WB ────────────────────────────────────────────────────────────────────
function wbProduct(p: any) {
  const d = p?.productDetails || {};
  return {
    sku: d.nmId ? String(d.nmId) : null,
    offerId: d.supplierArticle ? String(d.supplierArticle).trim() : null,
    productName: d.productName || null,
    productUrl: d.nmId ? `https://www.wildberries.ru/catalog/${d.nmId}/detail.aspx` : null,
  };
}

async function collectWbFeedbacks(withHistory: boolean): Promise<{ total: number; added: number }> {
  // take до 5000 — все неотвеченные одним запросом, значит список полный.
  const open = await wbGet('/api/v1/feedbacks?isAnswered=false&take=5000&skip=0&order=dateDesc');
  const list: any[] = open.feedbacks || [];
  let added = 0;
  const ids = new Set<string>();
  for (const f of list) {
    ids.add(String(f.id));
    const r = upsertItem({
      marketplace: 'wb', kind: 'review', externalId: String(f.id), ...wbProduct(f),
      rating: Number(f.productValuation) || null, text: f.text || '', pros: f.pros || null, cons: f.cons || null,
      author: f.userName || null, createdAt: ts(f.createdDate), answered: false,
    });
    if (r.inserted) added++;
  }
  const closed = markAnsweredExcept('wb', 'review', ids);
  const saveAnswered = (f: any) => upsertItem({
    marketplace: 'wb', kind: 'review', externalId: String(f.id), ...wbProduct(f),
    rating: Number(f.productValuation) || null, text: f.text || '', pros: f.pros || null, cons: f.cons || null,
    author: f.userName || null, createdAt: ts(f.createdDate), answered: true, mpAnswer: f.answer?.text || null,
  });
  if (withHistory) {
    const hist = await wbGet('/api/v1/feedbacks?isAnswered=true&take=500&skip=0&order=dateDesc');
    for (const f of (hist.feedbacks || [])) saveAnswered(f);
  }
  // Догрузка всей истории ответов (обработанные + архив) — по странице за проход,
  // пока не дойдём до конца. Нужна, чтобы ИИ учился на нашей реальной работе.
  await backfillWb('hist:wb_reviews', '/api/v1/feedbacks?isAnswered=true', 'feedbacks', 2000, saveAnswered);
  await backfillWb('hist:wb_reviews_archive', '/api/v1/feedbacks/archive?', 'feedbacks', 2000, saveAnswered);
  void closed;
  return { total: list.length, added };
}

async function collectWbQuestions(withHistory: boolean): Promise<{ total: number; added: number }> {
  const open = await wbGet('/api/v1/questions?isAnswered=false&take=10000&skip=0&order=dateDesc');
  const list: any[] = open.questions || [];
  let added = 0;
  const ids = new Set<string>();
  for (const q of list) {
    ids.add(String(q.id));
    const r = upsertItem({
      marketplace: 'wb', kind: 'question', externalId: String(q.id), ...wbProduct(q),
      text: q.text || '', author: q.userName || null, createdAt: ts(q.createdDate), answered: false,
    });
    if (r.inserted) added++;
  }
  markAnsweredExcept('wb', 'question', ids);
  const saveAnswered = (q: any) => upsertItem({
    marketplace: 'wb', kind: 'question', externalId: String(q.id), ...wbProduct(q),
    text: q.text || '', author: q.userName || null, createdAt: ts(q.createdDate), answered: true,
    mpAnswer: q.answer?.text || null,
  });
  if (withHistory) {
    const hist = await wbGet('/api/v1/questions?isAnswered=true&take=500&skip=0&order=dateDesc');
    for (const q of (hist.questions || [])) saveAnswered(q);
  }
  await backfillWb('hist:wb_questions', '/api/v1/questions?isAnswered=true', 'questions', 2000, saveAnswered);
  return { total: list.length, added };
}

/** Одна страница догрузки истории WB; курсор (skip) хранится в kv. */
async function backfillWb(key: string, base: string, field: string, take: number, save: (x: any) => void): Promise<void> {
  const st = kvGet<{ skip: number; done: boolean }>(key, { skip: 0, done: false });
  if (st.done) return;
  try {
    const sep = base.endsWith('?') ? '' : '&';
    const page = await wbGet(`${base}${sep}take=${take}&skip=${st.skip}&order=dateDesc`);
    const list: any[] = page?.[field] || [];
    for (const x of list) save(x);
    const next = { skip: st.skip + list.length, done: list.length < take || st.skip + list.length >= 199_000 };
    kvSet(key, next);
    if (next.done) rlog('info', `История загружена: ${key}`, { total: next.skip });
  } catch (e) {
    rlog('warn', `Догрузка истории ${key} не удалась`, { error: String((e as Error)?.message ?? e).slice(0, 200) });
  }
}

// ─── Ozon: вопросы ─────────────────────────────────────────────────────────
async function ozonQuestionsPage(status: string, lastId: string): Promise<{ questions: any[]; last_id: string; has_next: boolean }> {
  return ozonPost('/v1/question/list', { filter: { status }, last_id: lastId });
}

async function collectOzonQuestions(withHistory: boolean): Promise<{ total: number; added: number }> {
  let skuMap: Record<string, string> = {};
  try { skuMap = await (await import('../ozonShowcase')).getSkuMap(); } catch { /* без артикулов */ }

  const ids = new Set<string>();
  let added = 0;
  let lastId = '';
  let complete = false;
  for (let page = 0; page < 100; page++) {
    const r = await ozonQuestionsPage('UNPROCESSED', lastId);
    for (const q of r.questions || []) {
      ids.add(String(q.id));
      const sku = q.sku ? String(q.sku) : null;
      const ins = upsertItem({
        marketplace: 'ozon', kind: 'question', externalId: String(q.id),
        sku, offerId: sku ? (skuMap[sku] || null) : null, productName: null,
        productUrl: q.question_link || q.product_url || null,
        text: q.text || '', author: q.author_name || null, createdAt: ts(q.published_at), answered: false,
      });
      if (ins.inserted) added++;
    }
    if (!r.has_next || !r.last_id) { complete = true; break; }
    lastId = r.last_id;
  }
  if (complete) markAnsweredExcept('ozon', 'question', ids);

  await collectOzonQuestionHistory(skuMap, withHistory);
  return { total: ids.size, added };
}

/**
 * Отвеченные вопросы + текст ответа магазина — примеры нашей работы.
 * Свежие 10 страниц раз в 6 часов; вся история — догрузкой по 20 страниц за проход;
 * тексты ответов — до 100 за проход (отдельный запрос на каждый вопрос).
 */
async function collectOzonQuestionHistory(skuMap: Record<string, string>, recent: boolean): Promise<void> {
  const save = (q: any) => {
    const sku = q.sku ? String(q.sku) : null;
    upsertItem({
      marketplace: 'ozon', kind: 'question', externalId: String(q.id),
      sku, offerId: sku ? (skuMap[sku] || null) : null, productUrl: q.question_link || q.product_url || null,
      text: q.text || '', author: q.author_name || null, createdAt: ts(q.published_at), answered: true,
    });
  };
  if (recent) {
    let lastId = '';
    for (let page = 0; page < 10; page++) {
      const r = await ozonQuestionsPage('PROCESSED', lastId);
      for (const q of r.questions || []) save(q);
      if (!r.has_next || !r.last_id) break;
      lastId = r.last_id;
    }
  }
  const st = kvGet<{ lastId: string; done: boolean; n: number }>('hist:ozon_questions', { lastId: '', done: false, n: 0 });
  if (!st.done) {
    try {
      for (let page = 0; page < 20; page++) {
        const r = await ozonQuestionsPage('PROCESSED', st.lastId);
        for (const q of r.questions || []) save(q);
        st.n += (r.questions || []).length;
        if (!r.has_next || !r.last_id) { st.done = true; break; }
        st.lastId = r.last_id;
      }
    } catch (e) {
      rlog('warn', 'Ozon: догрузка истории вопросов прервалась', { error: String((e as Error).message).slice(0, 200) });
    }
    kvSet('hist:ozon_questions', st);
    if (st.done) rlog('info', 'Ozon: история вопросов загружена', { total: st.n });
  }
  const need = getDb().prepare(`SELECT id, external_id, sku FROM items WHERE marketplace = 'ozon' AND kind = 'question'
    AND answered_on_mp = 1 AND mp_answer IS NULL AND sku IS NOT NULL ORDER BY created_at DESC LIMIT 100`).all() as any[];
  for (const row of need) {
    try {
      const a = await ozonPost('/v1/question/answer/list', { question_id: row.external_id, sku: Number(row.sku), last_id: '' });
      const text = (a.answers || []).map((x: any) => x.text).filter(Boolean).join('\n');
      getDb().prepare('UPDATE items SET mp_answer = ? WHERE id = ?').run(text || '', row.id);
      await new Promise(res => setTimeout(res, 300));
    } catch (e) {
      rlog('warn', 'Ozon: не удалось получить ответ на вопрос', { id: row.external_id, error: String((e as Error).message) });
      break;
    }
  }
}

// ─── Общий проход ──────────────────────────────────────────────────────────
let running: Promise<CollectSummary> | null = null;
let lastHistoryAt = 0;
const HISTORY_EVERY_MS = 6 * 3600_000;

export type CollectSummary = Record<string, { ok: boolean; total?: number; added?: number; error?: string }>;

export function collectAll(): Promise<CollectSummary> {
  if (running) return running;
  running = (async () => {
    const withHistory = Date.now() - lastHistoryAt > HISTORY_EVERY_MS;
    const out: CollectSummary = {};
    const steps: [string, () => Promise<{ total: number; added: number }>][] = [
      ['wb_reviews', () => collectWbFeedbacks(withHistory)],
      ['wb_questions', () => collectWbQuestions(withHistory)],
      ['ozon_questions', () => collectOzonQuestions(withHistory)],
    ];
    for (const [dir, fn] of steps) {
      try {
        const r = await fn();
        out[dir] = { ok: true, ...r };
        setCollectState(dir as any, true, null);
      } catch (e) {
        const msg = String((e as Error)?.message ?? e).slice(0, 300);
        out[dir] = { ok: false, error: msg };
        setCollectState(dir as any, false, msg);
        rlog('error', `Сбор ${dir} не удался`, { error: msg });
      }
    }
    setCollectState('ozon_reviews', false, null, OZON_REVIEWS_NOTE);
    if (withHistory) lastHistoryAt = Date.now();
    const added = Object.values(out).reduce((s, x) => s + (x.added || 0), 0);
    if (added) rlog('info', `Сбор: новых ${added}`, out);
    return out;
  })().finally(() => { running = null; });
  return running;
}
