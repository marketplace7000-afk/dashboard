// Экономика карточки WB по nmId: комиссия категории + объём (литраж из габаритов).
// Нужно, потому что во фронте ценовые строки и карточки грузятся порциями по 100 и
// НЕ полностью джойнятся (каталог с дублями >100 → у части строк нет карточки, и
// комиссия/логистика падали в дефолт). Здесь сервер проходит ВСЕ карточки
// постранично (cursor) и отдаёт компактную карту { nmId: {commission, volumeL} },
// а фронт матчит по nmId (он есть у каждой ценовой строки). Кэш 12ч.

import { fetchAllWbCards } from './wbCards';
import { cacheGet, cacheSet, isFresh } from './cache';
import { getWbCommissions, commissionFor, type WbSubjectRates } from './wbCommissions';
import { getSettings, type Fulfilment } from './settings';
// 07.11.2026: таблица комиссий из калькулятора клиента (wbSubjectCommission.json,
// сентябрь 2026) убрана по решению владельца — комиссия только с WB. Главный
// источник теперь факт из финотчёта (productEcon), тариф здесь — запасной.

// v3: без таблицы клиента.
const CACHE_KEY = 'wb-card-econ:v3';
const TTL_MS = 12 * 60 * 60_000;

export type WbCardEconRow = {
  /** Тариф комиссии WB по ВЫБРАННОЙ схеме, %. null — WB не дал ставки для неё. */
  commission: number | null;
  /** Откуда она взята — это видно в интерфейсе, чтобы цифру можно было оспорить. */
  commissionSource: 'wb-api' | 'none';
  /** Все ставки предмета: чтобы переключение схемы не требовало нового запроса. */
  rates: WbSubjectRates;
  volumeL: number;
  subject: string;
};
export type WbCardEcon = {
  items: Record<string, WbCardEconRow>; // nmId → экономика
  /** Схема, под которую посчитаны комиссии в этом наборе. */
  fulfilment: Fulfilment;
  count: number;
  fetchedAt: number;
};

function wbToken(): string {
  return (process.env.WB_TOKEN_CONTENT || process.env.WB_TOKEN || '').trim();
}


async function compute(): Promise<WbCardEcon> {
  const upstream = { base: 'https://content-api.wildberries.ru', headers: { Authorization: wbToken() } };
  const model = getSettings().wbFulfilment;
  const [page, comm] = await Promise.all([fetchAllWbCards(upstream), getWbCommissions()]);
  const cards = page.cards;
  const items: Record<string, WbCardEconRow> = {};
  let fromApi = 0, missing = 0;

  for (const c of cards) {
    const nm = c?.nmID;
    if (nm == null) continue;
    const sid = c?.subjectID;
    const subjName = String(c?.subjectName ?? '');
    const rates = (sid != null ? comm.items[String(sid)] : undefined) ?? {};

    let commission: number | null = null;
    let commissionSource: WbCardEconRow['commissionSource'] = 'none';
    const apiPct = commissionFor(rates, model);
    if (apiPct != null) { commission = apiPct; commissionSource = 'wb-api'; fromApi++; }
    else missing++;

    const d = c?.dimensions ?? {};
    const volumeL = (Number(d.width) > 0 && Number(d.height) > 0 && Number(d.length) > 0)
      ? (Number(d.width) * Number(d.height) * Number(d.length)) / 1000
      : 0;
    items[String(nm)] = { commission, commissionSource, rates, volumeL: +volumeL.toFixed(3), subject: subjName };
  }

  console.warn(`[wb-card-econ] схема ${model.toUpperCase()}: карточек ${Object.keys(items).length}` +
    `, тариф комиссии из API WB ${fromApi}, без ставки ${missing}`);
  return { items, fulfilment: model, count: Object.keys(items).length, fetchedAt: Date.now() };
}

export async function getWbCardEcon(noCache = false): Promise<WbCardEcon> {
  const cached = await cacheGet<WbCardEcon>(CACHE_KEY);
  // Кэш живёт 12 часов, а схему работы могут переключить в настройках в любой
  // момент. Набор, посчитанный под другую схему, надо пересобрать сразу: иначе
  // переключатель как будто не работает — до вечера цифры остаются прежними.
  const modelChanged = !!cached?.data && cached.data.fulfilment !== getSettings().wbFulfilment;
  if (!noCache && !modelChanged && isFresh(cached)) return cached.data;
  try {
    const fresh = await compute();
    await cacheSet(CACHE_KEY, fresh, TTL_MS);
    return fresh;
  } catch (e) {
    if (cached?.data) return cached.data;
    throw e;
  }
}
