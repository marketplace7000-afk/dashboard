/**
 * /api/reviews/* — раздел «Отзывы и вопросы» (агент 4). Только после requireAuth.
 * Плюс собственный таймер сервера: сбор каждые 30 мин, черновики после сбора,
 * Яндекс.Диск — раз в сутки ночью (раздел 15 ТЗ).
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  getDb, getSettings, saveSettings, readCollectState, readLog, rowToItem, patchItem, getItem, spendThisMonth, usageByDay,
} from './db';
import { collectAll } from './collect';
import { draftOne, draftPending } from './drafts';
import { publishAnswer } from './publish';
import {
  getKbTexts, setKbText, listFolders, confirmFolder, folderText, indexYandexDisk, indexProgress,
  importTgPairs, tgStats, offersWithoutMaterials,
} from './kb';
import { DIRECTIONS, KB_TEXT_TITLES, type ReviewCounters, type ReviewView, type KbTextKey } from '../../../shared/reviews';

function body(req: VercelRequest): any {
  if (typeof req.body === 'string') { try { return JSON.parse(req.body || '{}'); } catch { return {}; } }
  return req.body || {};
}

function err(res: VercelResponse, e: unknown, code = 500) {
  return res.status(code).json({ ok: false, error: String((e as Error)?.message ?? e).slice(0, 300) });
}

function counters(): ReviewCounters {
  const out = {} as ReviewCounters;
  for (const d of DIRECTIONS) out[d.key] = { unanswered: 0, pending: 0 };
  const rows = getDb().prepare(`SELECT marketplace, kind,
      SUM(CASE WHEN status NOT IN ('published','skipped') THEN 1 ELSE 0 END) AS un,
      SUM(CASE WHEN status IN ('drafted','escalated') THEN 1 ELSE 0 END) AS pe
    FROM items WHERE answered_on_mp = 0 GROUP BY marketplace, kind`).all() as any[];
  for (const r of rows) {
    const key = `${r.marketplace}_${r.kind === 'review' ? 'reviews' : 'questions'}` as keyof ReviewCounters;
    if (out[key]) out[key] = { unanswered: r.un || 0, pending: r.pe || 0 };
  }
  return out;
}

function listItems(q: Record<string, any>) {
  const where: string[] = [];
  const args: any[] = [];
  const view = (q.view || 'unanswered') as ReviewView;
  if (view === 'unanswered') where.push("answered_on_mp = 0 AND status NOT IN ('published','skipped')");
  else if (view === 'pending') where.push("answered_on_mp = 0 AND status IN ('drafted','escalated')");
  else if (view === 'answered') where.push("(answered_on_mp = 1 OR status = 'published')");
  if (q.mp === 'wb' || q.mp === 'ozon') { where.push('marketplace = ?'); args.push(q.mp); }
  if (q.kind === 'review' || q.kind === 'question') { where.push('kind = ?'); args.push(q.kind); }
  if (q.rating) {
    const rs = String(q.rating).split(',').map(Number).filter(n => n >= 1 && n <= 5);
    if (rs.length) { where.push(`rating IN (${rs.map(() => '?').join(',')})`); args.push(...rs); }
  }
  if (q.q) {
    where.push('(offer_id LIKE ? OR product_name LIKE ? OR text LIKE ? OR sku = ?)');
    const like = `%${String(q.q).slice(0, 80)}%`;
    args.push(like, like, like, String(q.q));
  }
  if (q.from) { where.push('created_at >= ?'); args.push(Number(q.from)); }
  if (q.to) { where.push('created_at <= ?'); args.push(Number(q.to)); }
  const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 200);
  const offset = Math.max(Number(q.offset) || 0, 0);
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (getDb().prepare(`SELECT COUNT(*) AS n FROM items ${w}`).get(...args) as any).n;
  const rows = getDb().prepare(`SELECT * FROM items ${w} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...args, limit, offset) as any[];
  return { total, items: rows.map(rowToItem) };
}

export async function handleReviews(req: VercelRequest, res: VercelResponse, rest: string[]) {
  const [a, b, c] = rest;
  try {
    if (a === 'overview' && req.method === 'GET') {
      return res.status(200).json({ ok: true, counters: counters(), collect: readCollectState(), spendMonthUsd: spendThisMonth(), settings: getSettings() });
    }
    if (a === 'items' && !b && req.method === 'GET') {
      return res.status(200).json({ ok: true, ...listItems(req.query as any) });
    }
    if (a === 'items' && b && c) {
      const id = Number(b);
      if (!getItem(id)) return res.status(404).json({ ok: false, error: 'not_found' });
      if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
      const p = body(req);
      if (c === 'draft') return res.status(200).json({ ok: true, item: await draftOne(id, { force: true }) });
      if (c === 'save') {
        const text = String(p.text ?? '').slice(0, 1000);
        const it = getItem(id)!;
        patchItem(id, { draft_answer: text, status: it.status === 'new' ? 'drafted' : it.status });
        return res.status(200).json({ ok: true, item: getItem(id) });
      }
      if (c === 'publish') {
        const r = await publishAnswer(id, String(p.text ?? getItem(id)!.draftAnswer ?? ''), 'owner');
        return res.status(r.ok ? 200 : 400).json(r);
      }
      if (c === 'skip') { patchItem(id, { status: 'skipped' }); return res.status(200).json({ ok: true, item: getItem(id) }); }
      if (c === 'unskip') {
        const it = getItem(id)!;
        patchItem(id, { status: it.draftAnswer ? (it.escalationReason ? 'escalated' : 'drafted') : 'new' });
        return res.status(200).json({ ok: true, item: getItem(id) });
      }
      return res.status(404).json({ ok: false, error: 'unknown_action' });
    }
    if (a === 'publish-bulk' && req.method === 'POST') {
      const ids: number[] = (body(req).ids || []).map(Number).filter(Boolean).slice(0, 100);
      const results: any[] = [];
      for (const id of ids) {
        const it = getItem(id);
        if (!it || it.status !== 'drafted' || !it.draftAnswer) { results.push({ id, ok: false, error: 'Только черновики без эскалации' }); continue; }
        const r = await publishAnswer(id, it.draftAnswer, 'owner');
        results.push({ id, ok: r.ok, error: r.error });
        await new Promise(r2 => setTimeout(r2, 1200));
      }
      return res.status(200).json({ ok: true, results });
    }
    if (a === 'collect' && req.method === 'POST') {
      const collected = await collectAll();
      const drafts = await draftPending().catch(e => ({ error: String((e as Error).message) }));
      return res.status(200).json({ ok: true, collected, drafts });
    }
    if (a === 'settings') {
      if (req.method === 'GET') return res.status(200).json({ ok: true, settings: getSettings() });
      if (req.method === 'PATCH' || req.method === 'POST') return res.status(200).json({ ok: true, settings: saveSettings(body(req)) });
    }
    if (a === 'kb') {
      if (!b && req.method === 'GET') {
        return res.status(200).json({
          ok: true, texts: getKbTexts(), titles: KB_TEXT_TITLES, folders: listFolders(), telegram: tgStats(),
          index: indexProgress(), withoutMaterials: offersWithoutMaterials(),
        });
      }
      if (b === 'text' && req.method === 'POST') {
        const p = body(req);
        if (!(p.key in KB_TEXT_TITLES)) return res.status(400).json({ ok: false, error: 'bad_key' });
        setKbText(p.key as KbTextKey, String(p.text ?? ''));
        return res.status(200).json({ ok: true });
      }
      if (b === 'folder' && req.method === 'GET') return res.status(200).json({ ok: true, text: folderText(String(req.query.path || '')) });
      if (b === 'folder' && req.method === 'POST') {
        const p = body(req);
        confirmFolder(String(p.path || ''), Array.isArray(p.offerIds) ? p.offerIds : []);
        return res.status(200).json({ ok: true, folders: listFolders() });
      }
      if (b === 'index' && req.method === 'POST') {
        indexYandexDisk().catch(() => { /* ошибка видна в indexProgress и журнале */ });
        return res.status(202).json({ ok: true, index: indexProgress() });
      }
      if (b === 'tg' && req.method === 'POST') {
        const pairs = body(req).pairs;
        if (!Array.isArray(pairs)) return res.status(400).json({ ok: false, error: 'pairs_required' });
        return res.status(200).json({ ok: true, ...importTgPairs(pairs) });
      }
    }
    if (a === 'log' && req.method === 'GET') return res.status(200).json({ ok: true, log: readLog(300), usage: usageByDay(31) });
    return res.status(404).json({ ok: false, error: 'not_found' });
  } catch (e) {
    return err(res, e);
  }
}

// ─── Таймер сервера ────────────────────────────────────────────────────────
const EVERY_MS = 30 * 60_000;
let lastDiskDay = '';

export function scheduleReviews(): void {
  const tick = async () => {
    try {
      await collectAll();
      await draftPending();
    } catch (e) {
      console.warn('[reviews] проход не удался:', (e as Error).message);
    }
    // Яндекс.Диск — раз в сутки, в 03:00–04:00 МСК.
    const msk = new Date(Date.now() + 3 * 3600_000);
    const day = msk.toISOString().slice(0, 10);
    if (msk.getUTCHours() === 3 && day !== lastDiskDay && getSettings().yandexDiskUrl) {
      lastDiskDay = day;
      indexYandexDisk().catch(() => { /* в журнале */ });
    }
  };
  setTimeout(tick, 60_000);
  setInterval(tick, EVERY_MS).unref();
}
