/**
 * Команды площадкам — «Реклама 2.0», этап 1 (14.10.2026): ручное управление
 * кампаниями из раздела «Реклама». Позже этими же функциями пойдёт автопилот.
 *
 * Каждая команда:
 *   1. проверяется по снимку кампании в ads.sqlite (кампания есть, статус
 *      допускает действие, ставка не прыгает больше чем в BIG_JUMP раз без
 *      явного подтверждения);
 *   2. уходит в площадку через шлюз с приоритетом 0 (вперёд сбора статистики);
 *   3. пишется в журнал ad_change_log — и успех, и отказ площадки;
 *   4. после успеха правит снимок, чтобы экран сразу видел новое.
 *
 * Единицы:
 *   WB   ставки и дневные лимиты — копейки (bid_kopecks, dailyLimit), см. 08-promotion.yaml;
 *        после смены лимита перечитываем его и сверяем — ошибку единиц видно сразу.
 *   Ozon ставки и бюджеты — миллионные доли рубля строкой ("8000000" = 8 ₽).
 */
import { fetchWithRetry } from '../fetchRetry';
import { wbUpstream } from '../../_proxy';
import { getOzonPerfToken, PERF_HOST } from '../ozonPerfAuth';
import {
  getCampaign, patchCampaign, patchItemBid, upsertDailyLimits, logChange,
  type AdMp, type ChangeEntry,
} from './store';
import { parseWbDailyLimits, readOzonCampaignProducts } from './sync';

export type AdActionKind = 'pause' | 'start' | 'bid' | 'daily_limit' | 'weekly_budget';

export type AdAction = {
  mp: AdMp;
  campaignId: string;
  kind: AdActionKind;
  /** Товар — для ставки. */
  sku?: string;
  /** WB ручная ставка: где менять. Для единой ставки WB — combined. */
  placement?: 'search' | 'recommendations' | 'combined';
  /** Ставка, лимит или бюджет в рублях. */
  valueRub?: number;
  /** Дневной лимит WB: включить/выключить. */
  enabled?: boolean;
  /** Подтверждение большого скачка ставки (интерфейс спрашивает отдельно). */
  confirmBig?: boolean;
  reason?: string | null;
};

export type AdActionResult = { ok: boolean; message: string; logId: number | null; needConfirm?: boolean };

/** Во сколько раз ставка может вырасти без отдельного подтверждения. */
export const BIG_JUMP = 2;

class ActionError extends Error {
  needConfirm?: boolean;
  constructor(msg: string, needConfirm = false) { super(msg); this.needConfirm = needConfirm; }
}

const rub = (v: number) => `${Math.round(v * 100) / 100} ₽`;
const kop = (v: number) => Math.round(v * 100);

async function bodyText(r: Response): Promise<string> {
  return (await r.text().catch(() => '')).slice(0, 300);
}

// ─── WB ──────────────────────────────────────────────────────────────────────

async function wbCall(path: string, init: RequestInit): Promise<Response> {
  const up = wbUpstream('promotion');
  if (!up.headers.Authorization) throw new ActionError('нет ключа WB Продвижения');
  return fetchWithRetry(`${up.base}${path}`, { ...init, headers: { ...up.headers, 'Content-Type': 'application/json', ...(init.headers as any) } },
    { maxRetries: 1, priority: 0, timeoutMs: 30_000 });
}

async function wbLifecycle(a: AdAction, c: NonNullable<ReturnType<typeof getCampaign>>): Promise<{ before: unknown; after: unknown; message: string }> {
  const start = a.kind === 'start';
  // WB: запуск — из «готова» (4) или «пауза» (11); пауза — из «активна» (9).
  if (start && c.status_code !== 4 && c.status_code !== 11) throw new ActionError(`кампанию в статусе «${c.status}» запустить нельзя`);
  if (!start && c.status_code !== 9) throw new ActionError(`кампания не активна (статус «${c.status}»)`);
  const r = await wbCall(`/adv/v0/${start ? 'start' : 'pause'}?id=${encodeURIComponent(c.id)}`, { method: 'GET' });
  if (!r.ok) {
    const t = await bodyText(r);
    throw new ActionError(r.status === 400 && /budget/i.test(t) ? 'не хватает бюджета кампании — пополните в кабинете WB' : `WB ответил ${r.status}: ${t}`);
  }
  patchCampaign('wb', c.id, start ? { status: 'active', status_code: 9 } : { status: 'paused', status_code: 11 });
  return { before: { status: c.status }, after: { status: start ? 'active' : 'paused' }, message: start ? 'кампания запущена' : 'кампания на паузе' };
}

async function wbBid(a: AdAction, c: NonNullable<ReturnType<typeof getCampaign>>) {
  const it = c.items.find(i => i.sku === a.sku);
  if (!it) throw new ActionError('товара нет в кампании');
  if (![4, 9, 11].includes(c.status_code ?? -1)) throw new ActionError(`ставку в кампании со статусом «${c.status}» менять нельзя`);
  const unified = c.bid_type === 'unified';
  const placement = unified ? 'combined' : (a.placement === 'recommendations' ? 'recommendations' : 'search');
  const curKop = placement === 'recommendations' ? it.bid_reco_kop : it.bid_search_kop;
  const newKop = kop(a.valueRub!);
  if (curKop && newKop > curKop * BIG_JUMP && !a.confirmBig) {
    throw new ActionError(`ставка вырастет в ${(newKop / curKop).toFixed(1)} раза (${rub(curKop / 100)} → ${rub(newKop / 100)}) — подтвердите`, true);
  }
  const r = await wbCall('/api/advert/v1/bids', {
    method: 'PATCH',
    body: JSON.stringify({ bids: [{ advert_id: Number(c.id), nm_bids: [{ nm_id: Number(it.sku), bid_kopecks: newKop, placement }] }] }),
  });
  if (!r.ok) throw new ActionError(`WB ответил ${r.status}: ${await bodyText(r)}`);
  // Единая ставка WB одна на поиск и рекомендации.
  patchItemBid('wb', c.id, it.sku, placement === 'recommendations' ? { bid_reco_kop: newKop }
    : unified ? { bid_search_kop: newKop, bid_reco_kop: newKop } : { bid_search_kop: newKop });
  return {
    before: { placement, bid_rub: curKop == null ? null : curKop / 100 },
    after: { placement, bid_rub: newKop / 100 },
    message: `ставка ${curKop == null ? '' : `${rub(curKop / 100)} → `}${rub(newKop / 100)}`,
  };
}

async function wbDailyLimit(a: AdAction, c: NonNullable<ReturnType<typeof getCampaign>>) {
  if (c.payment !== 'cpc') throw new ActionError('дневной лимит WB бывает только у кампаний с оплатой за клик');
  const enabled = a.enabled !== false;
  if (enabled && !(a.valueRub! >= 10)) throw new ActionError('дневной лимит WB — не меньше 10 ₽');
  const body = enabled
    ? { advertIds: [Number(c.id)], enabled: true, dailyLimit: kop(a.valueRub!), carryOverEnabled: false }
    : { advertIds: [Number(c.id)], enabled: false };
  const r = await wbCall('/api/advert/v0/daily-limits', { method: 'PUT', body: JSON.stringify(body) });
  if (!r.ok) throw new ActionError(`WB ответил ${r.status}: ${await bodyText(r)}`);
  const put: any = await r.json().catch(() => null);
  const below = (put?.adverts ?? []).find((x: any) => String(x?.advertId) === c.id && x?.belowMinLimit);

  // Сверка: перечитываем лимит. Если WB записал не то, что просили (например,
  // не те единицы), об этом скажет журнал и ответ на экран.
  let check = '';
  const g = await wbCall(`/api/advert/v0/daily-limits?advertIds=${c.id}`, { method: 'GET' });
  if (g.ok) {
    const rows = parseWbDailyLimits(await g.json().catch(() => null));
    upsertDailyLimits('wb', rows);
    const row = rows.find(x => x.id === c.id);
    if (enabled && row && row.limitRub != null && Math.abs(row.limitRub - a.valueRub!) > 0.01) {
      check = ` · ВНИМАНИЕ: WB показывает лимит ${rub(row.limitRub)} вместо ${rub(a.valueRub!)}`;
    }
  }
  return {
    before: { enabled: c.daily_limit_on, limit_rub: c.daily_limit },
    after: { enabled, limit_rub: enabled ? a.valueRub : null },
    message: (enabled ? `дневной лимит ${rub(a.valueRub!)}` : 'дневной лимит выключен')
      + (below ? ` · WB: лимит ниже нужного для текущих ставок, рекомендует от ${rub(Number(below.requiredLimit) / 100)}` : '')
      + check,
  };
}

// ─── Ozon ────────────────────────────────────────────────────────────────────

async function ozCall(path: string, init: RequestInit): Promise<Response> {
  if (!process.env.OZON_PERF_CLIENT_ID || !process.env.OZON_PERF_CLIENT_SECRET) throw new ActionError('нет ключей Ozon Performance');
  const token = await getOzonPerfToken();
  return fetchWithRetry(`${PERF_HOST}/${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json' },
  }, { maxRetries: 1, priority: 0, timeoutMs: 30_000 });
}

const OZ_MICRO = 1_000_000;

async function ozLifecycle(a: AdAction, c: NonNullable<ReturnType<typeof getCampaign>>) {
  const start = a.kind === 'start';
  if (start && c.status === 'active') throw new ActionError('кампания уже активна');
  if (!start && c.status !== 'active' && c.status !== 'out_of_budget') throw new ActionError(`кампания не активна (статус «${c.status}»)`);
  const r = await ozCall(`api/client/campaign/${encodeURIComponent(c.id)}/${start ? 'activate' : 'deactivate'}`, { method: 'POST', body: JSON.stringify({ campaignId: c.id }) });
  if (!r.ok) throw new ActionError(`Ozon ответил ${r.status}: ${await bodyText(r)}`);
  patchCampaign('ozon', c.id, { status: start ? 'active' : 'paused' });
  return { before: { status: c.status }, after: { status: start ? 'active' : 'paused' }, message: start ? 'кампания запущена' : 'кампания на паузе' };
}

async function ozBid(a: AdAction, c: NonNullable<ReturnType<typeof getCampaign>>) {
  const it = c.items.find(i => i.sku === a.sku);
  if (!it) throw new ActionError('товара нет в кампании');
  // По спецификации bid учитывается только у стратегии «Средняя стоимость клика»
  // (TARGET_BIDS). У MAX_CLICKS / TOP_MAX_CLICKS ставку ведёт Ozon, у TARGET_CIR —
  // целевой ДРР, у TOP_PROMOTION — позиция.
  if (c.bid_type !== 'TARGET_BIDS') {
    throw new ActionError(`у кампании стратегия ${c.bid_type ?? '—'}: ставку ведёт Ozon, вручную меняется только при «Средней стоимости клика»`);
  }
  // Полный список товаров — прямо у Ozon, а не из снимка: PUT ниже перезаписывает
  // товары кампании, и всё, чего нет в списке, из неё выпадет.
  const live = await readOzonCampaignProducts(c.id, p => ozCall(p, { method: 'GET' }));
  if (!live) throw new ActionError('не удалось прочитать товары кампании у Ozon — ставку не меняем, попробуйте позже');
  const liveMine = live.find(p => String(p?.sku) === it.sku);
  if (!liveMine) throw new ActionError('Ozon не показывает этот товар в кампании — обновите данные рекламы');
  const liveBid = liveMine.bid != null && Number(liveMine.bid) > 0 ? Number(liveMine.bid) : (it.bid_raw != null ? Number(it.bid_raw) : null);
  const cur = liveBid != null ? liveBid / OZ_MICRO : null;
  const next = a.valueRub!;
  if (cur && next > cur * BIG_JUMP && !a.confirmBig) {
    throw new ActionError(`ставка вырастет в ${(next / cur).toFixed(1)} раза (${rub(cur)} → ${rub(next)}) — подтвердите`, true);
  }
  const raw = String(Math.round(next * OZ_MICRO));
  // PUT products по описанию «перезаписывает» настройки — шлём все товары кампании
  // с их текущими ставками, меняя только нужный, чтобы не обнулить соседей.
  const bids = live
    .filter(p => p?.sku != null && (String(p.sku) === it.sku || (p.bid != null && Number(p.bid) > 0)))
    .map(p => ({ sku: String(p.sku), bid: String(p.sku) === it.sku ? raw : String(p.bid) }));
  const r = await ozCall(`api/client/campaign/${encodeURIComponent(c.id)}/products`, { method: 'PUT', body: JSON.stringify({ bids }) });
  if (!r.ok) throw new ActionError(`Ozon ответил ${r.status}: ${await bodyText(r)}`);
  patchItemBid('ozon', c.id, it.sku, { bid_raw: raw });

  // Сверка: перечитываем товары кампании.
  let check = '';
  const prods = await readOzonCampaignProducts(c.id, p => ozCall(p, { method: 'GET' }));
  if (prods) {
    const mine = prods.find(p => String(p?.sku) === it.sku);
    if (!mine) check = ' · ВНИМАНИЕ: Ozon не вернул товар в кампании';
    else if (String(mine.bid) !== raw) check = ` · ВНИМАНИЕ: Ozon показывает ставку ${rub(Number(mine.bid) / OZ_MICRO)}`;
    const lost = bids.filter(x => !prods.some(p => String(p?.sku) === x.sku)).length;
    if (prods.length && lost) check += ` · ВНИМАНИЕ: из кампании пропало товаров: ${lost}`;
  }
  return { before: { bid_rub: cur }, after: { bid_rub: next }, message: `ставка ${cur == null ? '' : `${rub(cur)} → `}${rub(next)}${check}` };
}

async function ozWeeklyBudget(a: AdAction, c: NonNullable<ReturnType<typeof getCampaign>>) {
  const next = a.valueRub!;
  if (!(next > 0)) throw new ActionError('укажите недельный бюджет');
  const cur = c.weekly_budget;
  if (cur && next > cur * BIG_JUMP && !a.confirmBig) {
    throw new ActionError(`бюджет вырастет в ${(next / cur).toFixed(1)} раза (${rub(cur)} → ${rub(next)}) — подтвердите`, true);
  }
  const r = await ozCall(`api/client/campaign/${encodeURIComponent(c.id)}`, {
    method: 'PATCH', body: JSON.stringify({ weeklyBudget: String(Math.round(next * OZ_MICRO)) }),
  });
  if (!r.ok) throw new ActionError(`Ozon ответил ${r.status}: ${await bodyText(r)}`);
  patchCampaign('ozon', c.id, { weekly_budget: next });
  return { before: { weekly_budget_rub: cur }, after: { weekly_budget_rub: next }, message: `недельный бюджет ${cur == null ? '' : `${rub(cur)} → `}${rub(next)}` };
}

// ─── Точка входа ─────────────────────────────────────────────────────────────

export async function applyAdAction(a: AdAction, actor: ChangeEntry['actor'] = 'manager'): Promise<AdActionResult> {
  const base = { mp: a.mp, campaign_id: a.campaignId, sku: a.sku ?? null, actor, action: a.kind, reason: a.reason ?? null };
  const fail = (message: string, needConfirm = false, after?: unknown): AdActionResult => {
    // Неподтверждённый скачок ставки — не отказ площадки, в журнал не пишем.
    const logId = needConfirm ? null : logChange({ ...base, after, status: 'failed', result: { error: message } });
    return { ok: false, message, logId, needConfirm };
  };
  if (a.mp !== 'wb' && a.mp !== 'ozon') return fail('mp: wb или ozon');
  const c = getCampaign(a.mp, String(a.campaignId));
  if (!c) return fail('кампания не найдена — обновите данные');
  if ((a.kind === 'bid' || a.kind === 'weekly_budget' || (a.kind === 'daily_limit' && a.enabled !== false))
      && !(typeof a.valueRub === 'number' && Number.isFinite(a.valueRub) && a.valueRub > 0)) {
    return fail('укажите сумму больше нуля');
  }
  if (a.kind === 'bid' && !a.sku) return fail('укажите товар');

  try {
    let res: { before: unknown; after: unknown; message: string };
    if (a.mp === 'wb') {
      if (a.kind === 'pause' || a.kind === 'start') res = await wbLifecycle(a, c);
      else if (a.kind === 'bid') res = await wbBid(a, c);
      else if (a.kind === 'daily_limit') res = await wbDailyLimit(a, c);
      else return fail('у WB нет недельного бюджета — используйте дневной лимит');
    } else {
      if (a.kind === 'pause' || a.kind === 'start') res = await ozLifecycle(a, c);
      else if (a.kind === 'bid') res = await ozBid(a, c);
      else if (a.kind === 'weekly_budget') res = await ozWeeklyBudget(a, c);
      else return fail('у Ozon дневного лимита нет — используйте недельный бюджет');
    }
    const logId = logChange({ ...base, before: res.before, after: res.after, status: 'applied', result: { message: res.message } });
    return { ok: true, message: res.message, logId };
  } catch (e) {
    const err = e as ActionError;
    return fail(err.message || String(e), !!err.needConfirm, a.valueRub != null ? { value_rub: a.valueRub } : undefined);
  }
}
