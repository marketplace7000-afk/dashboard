// Комиссия WB по предметам (категориям) — живьём из API вместо ручного ввода.
//   GET https://common-api.wildberries.ru/api/v1/tariffs/commission?locale=ru
//   → report[]: { subjectID, subjectName, parentName, kgvpMarketplace,
//                 kgvpSupplier, kgvpSupplierExpress, paidStorageKgvp, ... }
//
// ВАЖНО ПРО МОДЕЛИ РАБОТЫ. У WB комиссия зависит от схемы: со склада WB (FBO) и
// со склада продавца (FBS) ставки РАЗНЫЕ, у FBS обычно выше на несколько пунктов.
// Клиент перешёл на FBS 29.08 и справедливо заметил, что кабинет продолжает
// показывать ставки другой схемы.
//
// Раньше мы забирали одно поле `kgvpMarketplace` и подписывали его «FBW/FBS» —
// то есть сами не различали схемы. Теперь сохраняем ВСЕ ставки предмета как
// есть, а выбор поля под схему делается явно (см. `commissionFor`). Соответствие
// имён полей схемам вынесено в одну константу: если оно окажется другим, правка
// в одном месте, а не по всему расчёту.
//
// 07.11.2026 (просьба владельца: «поменяли комиссию — сразу видно в ценах»):
// кэш 1 час вместо суток, и каждая смена ставки пишется в историю
// (`wb-commission-history:v1`). По истории факт продаж сравнивается с тарифом,
// действовавшим В ДЕНЬ продажи, а экран показывает, что и когда поменялось.

import { fetchWithRetry } from './fetchRetry';
import { cacheGet, cacheSet, isFresh } from './cache';
import { mskDate } from './mskDate';
import type { Fulfilment } from './settings';

const URL = 'https://common-api.wildberries.ru/api/v1/tariffs/commission?locale=ru';
// v2: раньше хранили одно число на предмет, теперь все ставки — старый кэш не подходит.
const CACHE_KEY = 'wb-commissions:v2';
const TTL_MS = 60 * 60_000; // час: смена ставки WB попадает в «Цены» в течение часа

const HISTORY_KEY = 'wb-commission-history:v1';
const HISTORY_TTL_MS = 400 * 24 * 60 * 60_000; // фактически навсегда (кэш вытесняет только просроченное)

/** Ставки предмета с даты `since` (по Москве). Новая запись — только когда ставка изменилась. */
export type RateStep = { since: string; fbo: number | null; fbs: number | null };
/** subjectName → ступеньки по возрастанию даты. */
export type WbCommissionHistory = Record<string, RateStep[]>;

/** Все ставки предмета, как их отдаёт WB. Поля могут отсутствовать. */
export type WbSubjectRates = {
  /** Склад WB (FBO/FBW). */
  paidStorageKgvp?: number;
  /** Маркетплейс — склад продавца (FBS). */
  kgvpMarketplace?: number;
  /** Склад продавца с доставкой продавцом (DBS). */
  kgvpSupplier?: number;
  /** Экспресс-доставка. */
  kgvpSupplierExpress?: number;
  subjectName?: string;
};

export type WbCommissions = {
  items: Record<string, WbSubjectRates>;   // subjectID → ставки
  count: number;
  fetchedAt: number;
};

/**
 * Какое поле ответа соответствует какой схеме работы.
 *
 * ПРОВЕРИТЬ НА ЖИВОМ КЛЮЧЕ. Сопоставление взято по названиям полей WB и не
 * подтверждено официальной документацией — она закрыта для внешнего чтения.
 * Ошибиться тут значит показать неверную прибыль по всему каталогу, поэтому
 * при первом успешном запросе в журнал печатается образец записи: по нему
 * сверяется, что ставка FBS действительно выше ставки FBO (так у WB почти всегда).
 */
const FIELD_BY_FULFILMENT: Record<Fulfilment, keyof WbSubjectRates> = {
  fbo: 'paidStorageKgvp',
  fbs: 'kgvpMarketplace',
};

/**
 * Ставка предмета под нужную схему.
 * Возвращает null, если WB не дал именно этого поля: подставлять ставку СОСЕДНЕЙ
 * схемы нельзя — это молча покажет неверную прибыль. Пусть лучше будет «нет
 * данных», это видно.
 */
export function commissionFor(rates: WbSubjectRates | undefined, model: Fulfilment): number | null {
  const v = rates?.[FIELD_BY_FULFILMENT[model]];
  return typeof v === 'number' && v > 0 ? v : null;
}

function wbToken(): string {
  return (process.env.WB_TOKEN_COMMON || process.env.WB_TOKEN || '').trim();
}

const num = (v: unknown): number | undefined => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

async function compute(): Promise<WbCommissions> {
  const res = await fetchWithRetry(
    URL,
    { method: 'GET', headers: { Authorization: wbToken() } },
    { maxRetries: 2, timeoutMs: 30_000 },
  );
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`wb tariffs/commission → ${res.status} ${txt.slice(0, 200)}`);
  }
  const data = await res.json();
  const rows: any[] = data?.report ?? data?.data ?? [];
  const items: Record<string, WbSubjectRates> = {};
  for (const r of rows) {
    const id = r?.subjectID;
    if (id == null) continue;
    items[String(id)] = {
      paidStorageKgvp: num(r?.paidStorageKgvp),
      kgvpMarketplace: num(r?.kgvpMarketplace),
      kgvpSupplier: num(r?.kgvpSupplier),
      kgvpSupplierExpress: num(r?.kgvpSupplierExpress),
      subjectName: r?.subjectName ? String(r.subjectName) : undefined,
    };
  }
  // Образец в журнал — по нему сверяется соответствие полей схемам (см. выше).
  const sample = rows[0];
  if (sample) {
    console.warn('[wb-commissions] образец ставок предмета:', JSON.stringify({
      subjectName: sample.subjectName,
      paidStorageKgvp: sample.paidStorageKgvp,
      kgvpMarketplace: sample.kgvpMarketplace,
      kgvpSupplier: sample.kgvpSupplier,
      kgvpSupplierExpress: sample.kgvpSupplierExpress,
    }));
  }
  return { items, count: Object.keys(items).length, fetchedAt: Date.now() };
}

export async function getWbCommissionHistory(): Promise<WbCommissionHistory> {
  return (await cacheGet<WbCommissionHistory>(HISTORY_KEY))?.data ?? {};
}

/** Дописать в историю ставки, которые изменились (или появились впервые). */
async function recordHistory(c: WbCommissions): Promise<void> {
  const hist = await getWbCommissionHistory();
  const today = mskDate(0);
  let changed = false;
  for (const r of Object.values(c.items)) {
    const name = r.subjectName;
    if (!name) continue;
    const fbo = commissionFor(r, 'fbo'), fbs = commissionFor(r, 'fbs');
    const steps = hist[name] ?? (hist[name] = []);
    const last = steps[steps.length - 1];
    if (last && last.fbo === fbo && last.fbs === fbs) continue;
    if (last && last.since === today) { last.fbo = fbo; last.fbs = fbs; }
    else steps.push({ since: today, fbo, fbs });
    changed = true;
  }
  if (changed) await cacheSet(HISTORY_KEY, hist, HISTORY_TTL_MS);
}

/**
 * Ставка предмета на дату. Раньше первой записи истории — берём первую
 * (история ведётся с 07.11.2026; считаем, что до этого ставка была та же).
 */
export function tariffAt(hist: WbCommissionHistory, subjectName: string, date: string, model: Fulfilment): number | null {
  const steps = hist[subjectName];
  if (!steps?.length) return null;
  let pick = steps[0];
  for (const s of steps) { if (s.since <= date) pick = s; else break; }
  return pick[model];
}

/** Последняя смена ставки предмета за `days` дней: с какой даты, было → стало. */
export function recentChange(hist: WbCommissionHistory, subjectName: string, model: Fulfilment, days = 14):
  { since: string; from: number | null; to: number | null } | null {
  const steps = hist[subjectName];
  if (!steps || steps.length < 2) return null;
  const cutoff = mskDate(days);
  for (let i = steps.length - 1; i >= 1; i--) {
    if (steps[i].since < cutoff) break;
    if (steps[i][model] !== steps[i - 1][model]) return { since: steps[i].since, from: steps[i - 1][model], to: steps[i][model] };
  }
  return null;
}

export async function getWbCommissions(noCache = false): Promise<WbCommissions> {
  const cached = await cacheGet<WbCommissions>(CACHE_KEY);
  if (!noCache && isFresh(cached)) return cached.data;
  try {
    const fresh = await compute();
    await cacheSet(CACHE_KEY, fresh, TTL_MS);
    await recordHistory(fresh).catch(e => console.warn('[wb-commissions] история ставок не записана:', (e as Error).message));
    return fresh;
  } catch (e) {
    if (cached?.data) return cached.data; // на сбой отдаём последнее удачное
    throw e;
  }
}
