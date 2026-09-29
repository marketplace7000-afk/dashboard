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
// Данные меняются редко (WB правит тарифы раз в недели) — кэш 24ч.

import { fetchWithRetry } from './fetchRetry';
import { cacheGet, cacheSet, isFresh } from './cache';
import type { Fulfilment } from './settings';

const URL = 'https://common-api.wildberries.ru/api/v1/tariffs/commission?locale=ru';
// v2: раньше хранили одно число на предмет, теперь все ставки — старый кэш не подходит.
const CACHE_KEY = 'wb-commissions:v2';
const TTL_MS = 24 * 60 * 60_000; // сутки

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

export async function getWbCommissions(noCache = false): Promise<WbCommissions> {
  const cached = await cacheGet<WbCommissions>(CACHE_KEY);
  if (!noCache && isFresh(cached)) return cached.data;
  try {
    const fresh = await compute();
    await cacheSet(CACHE_KEY, fresh, TTL_MS);
    return fresh;
  } catch (e) {
    if (cached?.data) return cached.data; // на сбой отдаём последнее удачное
    throw e;
  }
}
