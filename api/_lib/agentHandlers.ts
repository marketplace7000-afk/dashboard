/**
 * HTTP-слой сети агентов (ТЗ раздел 6).
 *
 *   /api/agent/*   — для хоста на ПК. Авторизация: Bearer AGENT_API_KEY.
 *                    Вызывается ДО requireAuth (у хоста нет cookie-сессии),
 *                    по образцу anthropic-relay.
 *   /api/agents/*  — для панели. Вызывается ПОСЛЕ requireAuth: единственный
 *                    пользователь кабинета и есть admin (ролей в дашборде нет,
 *                    зафиксировано как отступление от ТЗ в docs/agents/).
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  agentKeyOk, heartbeat, claimTask, startTask, setProgress, completeTask, failTask,
  cancelTask, addRun, maintainQueue, getSettings, patchSettings, liveState,
  taskTimeline, taskRuns, listTasks, createTask, getTask, listSchedules,
  upsertSchedule, setAgentPaused, clearPause, startDevTask,
} from './agentQueue';
import type { AgentTaskType, Marketplace } from '../../shared/agents';

function body(req: VercelRequest): any {
  try { return typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body ?? {}); }
  catch { return {}; }
}

/** Наши артикулы для задания showcase_prices: WB — nmId+серая цена (якорь), Ozon — из кэша цен. */
async function fillShowcaseParams(marketplace: Marketplace): Promise<Record<string, unknown>> {
  const params: Record<string, unknown> = { marketplace };
  try {
    if (marketplace === 'wb') {
      const { cacheGet, makeUpstreamCacheKey } = await import('./cache');
      const key = makeUpstreamCacheKey('wb:discounts', 'GET', 'api/v2/list/goods/filter', '?limit=1000', undefined);
      const c = await cacheGet<{ text: string }>(key);
      const anchors: Record<string, number> = {};
      if (c?.data?.text) {
        for (const g of (JSON.parse(c.data.text)?.data?.listGoods ?? [])) {
          const nm = Number(g?.nmID ?? g?.nmId) || 0;
          if (nm) anchors[String(nm)] = Number(g?.sizes?.[0]?.discountedPrice) || 0;
        }
      }
      params.skus = Object.keys(anchors);
      params.anchors = anchors;
    } else {
      // sku витрины (число из ссылки ozon.ru/product/<sku>) — из карты
      // sku→offer_id, которую уже строит ozonShowcase для ingest.
      const { getSkuMap } = await import('./ozonShowcase');
      const map = await getSkuMap().catch(() => ({} as Record<string, string>));
      const skus = Object.keys(map);
      if (skus.length) params.skus = skus;
    }
  } catch { /* пустые skus = агент снимет всё, что найдёт на витрине */ }
  return params;
}

// ─── /api/agent/* (хост) ────────────────────────────────────────────────────

export async function handleAgentApi(req: VercelRequest, res: VercelResponse, rest: string[]): Promise<void> {
  if (!agentKeyOk(req)) { res.status(401).json({ error: 'agent_unauthorized' }); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'method_not_allowed' }); return; }
  const b = body(req);
  const [what, idStr, action] = rest;

  if (what === 'heartbeat') {
    maintainQueue();
    const r = heartbeat(String(b?.name || 'unknown'), String(b?.version || ''), !!b?.chrome_ok);
    res.status(200).json({ ok: true, paused: r.paused });
    return;
  }

  if (what === 'tasks' && idStr === 'claim') {
    maintainQueue();
    const name = String(b?.name || 'unknown');
    const types = (Array.isArray(b?.types) ? b.types : []) as AgentTaskType[];
    const task = claimTask(name, types);
    if (!task) { res.status(204).end(); return; }
    // Дозаполнить параметры showcase_prices списком наших товаров на момент выдачи.
    if (task.type === 'showcase_prices' && !(task.params.skus?.length)) {
      const filled = await fillShowcaseParams(task.params.marketplace);
      task.params = { ...task.params, ...filled };
    }
    res.status(200).json({ task, settings: getSettings() });
    return;
  }

  if (what === 'tasks' && idStr && action) {
    const id = Number(idStr);
    const t = getTask(id);
    if (!t) { res.status(404).json({ error: 'task_not_found' }); return; }
    if (action === 'start') {
      const u = startTask(id, t.claimed_by ?? undefined);
      res.status(200).json({ ok: true, status: u?.status ?? 'running' });
      return;
    }
    if (action === 'log') {
      addRun(id, (b?.level === 'warn' || b?.level === 'error') ? b.level : 'info', String(b?.message ?? ''), b?.data, t.claimed_by ?? undefined);
      res.status(200).json({ ok: true, status: getTask(id)?.status });
      return;
    }
    if (action === 'progress') {
      const status = setProgress(id, b);
      res.status(200).json({ ok: true, status: status ?? t.status });
      return;
    }
    if (action === 'complete') {
      const u = completeTask(id, String(b?.summary ?? ''), b?.stats);
      res.status(200).json({ ok: true, status: u?.status });
      return;
    }
    if (action === 'fail') {
      const u = failTask(id, String(b?.error ?? 'unknown'), !!b?.retryable, b?.pause);
      res.status(200).json({ ok: true, status: u?.status });
      return;
    }
  }

  res.status(404).json({ error: 'unknown_agent_endpoint' });
}

// ─── /api/agents/* (панель, после requireAuth) ──────────────────────────────

export async function handleAgentsPanel(req: VercelRequest, res: VercelResponse, rest: string[]): Promise<void> {
  const [what, idStr, action] = rest;
  const b = body(req);

  if (!what || what === 'live') { res.status(200).json(liveState()); return; }

  if (what === 'tasks') {
    if (idStr === undefined) {
      if (req.method === 'POST') {
        // «Запустить сейчас»
        const type = String(b?.type || 'showcase_prices') as AgentTaskType;
        const mp = (b?.marketplace === 'ozon' ? 'ozon' : 'wb') as Marketplace;
        const params = type === 'showcase_prices'
          ? { ...(await fillShowcaseParams(mp)), ...(Array.isArray(b?.skus) && b.skus.length ? { skus: b.skus } : {}) }
          : { marketplace: mp, ...(b?.params ?? {}) };
        const t = createTask(type, params, 'panel');
        res.status(200).json({ ok: true, task: t });
        return;
      }
      res.status(200).json({ ok: true, tasks: listTasks({ limit: Number(req.query.limit) || 50 }) });
      return;
    }
    const id = Number(idStr);
    if (action === 'cancel' && req.method === 'POST') { res.status(200).json({ ok: true, task: cancelTask(id) }); return; }
    if (action === 'timeline') { res.status(200).json(taskTimeline(id)); return; }
    if (action === 'runs') { res.status(200).json({ ok: true, runs: taskRuns(id) }); return; }
    res.status(200).json({ ok: true, task: getTask(id) });
    return;
  }

  if (what === 'schedules') {
    if (req.method === 'POST' || req.method === 'PATCH') {
      res.status(200).json({ ok: true, schedules: upsertSchedule(b) });
      return;
    }
    res.status(200).json({ ok: true, schedules: listSchedules() });
    return;
  }

  if (what === 'hosts' && idStr && (action === 'pause' || action === 'resume') && req.method === 'POST') {
    res.status(200).json({ ok: setAgentPaused(idStr, action === 'pause') });
    return;
  }

  if (what === 'pauses' && idStr && action === 'clear' && req.method === 'POST') {
    res.status(200).json({ ok: clearPause(Number(idStr), 'panel') });
    return;
  }

  if (what === 'settings') {
    if (req.method === 'PATCH' || req.method === 'POST') { res.status(200).json({ ok: true, settings: patchSettings(b) }); return; }
    res.status(200).json({ ok: true, settings: getSettings() });
    return;
  }

  if (what === 'dev' && idStr === 'fake-task' && req.method === 'POST') {
    const t = startDevTask(b?.marketplace === 'ozon' ? 'ozon' : 'wb');
    res.status(200).json({ ok: !!t, task: t });
    return;
  }

  res.status(404).json({ error: 'unknown_agents_endpoint' });
}
