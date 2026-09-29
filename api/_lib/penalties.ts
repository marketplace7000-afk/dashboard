/**
 * ШТРАФЫ И УДЕРЖАНИЯ по обеим площадкам.
 *
 * Просьба клиента 05.08 (пункт про идеи чужих дашбордов): «а штрафы WB,
 * подозрительные удержания и провал выкупа — нет. Данные о них лежат в отчёте
 * реализации, надо только взять операции типа штраф и удержание».
 *
 * Ozon: /v3/finance/transaction/list — там каждая операция названа своим типом.
 * Проверено на живом кабинете 10.08 (30 дней): помимо ожидаемых расходов
 * (эквайринг, логистика, возвраты, упаковка, реклама) там лежат DefectFine*
 * («Превышение индекса ошибок»), декомпенсации, страхование, бейджи, подписки,
 * утилизация — то, что клиент и называет «подозрительными удержаниями».
 *
 * WB: финансовый отчёт (finance-api sales-reports/detailed) — поля penalty,
 * deduction, acceptance. Читаем ПРОГРЕТЫЙ кэш, живьём в WB не ходим: у отчёта
 * лимит 1 запрос в минуту.
 */
import { fetchWithRetry } from './fetchRetry';
import { cacheGet, cacheSet, isFresh, cacheGetNewestByPrefix, makeUpstreamCachePrefix } from './cache';

const RESULT_KEY = 'penalties:v1';
const TTL_MS = 3 * 60 * 60_000;   // 3 ч

export type PenaltyRow = {
  platform: 'wb' | 'ozon';
  /** 'fine' — штраф площадки, 'deduction' — прочее удержание сверх обычных расходов. */
  kind: 'fine' | 'deduction';
  /** Человеческое название операции, как его показывает площадка. */
  title: string;
  /** Технический тип (Ozon) — по нему удобно искать в кабинете. */
  code?: string;
  amount: number;   // положительное число — сколько удержали, ₽
  count: number;    // сколько операций
};

export type Penalties = {
  rows: PenaltyRow[];
  totalFines: number;
  totalDeductions: number;
  /** Сколько удержали за предыдущий такой же период — чтобы видеть рост. */
  prevTotal: number;
  days: number;
  fetchedAt: number;
  diagnostics: string;
};

const abs = (v: any) => Math.abs(Number(v) || 0);

// ─── Ozon ────────────────────────────────────────────────────────────────────

/**
 * Ожидаемые расходы: они и должны быть, это не «удержание», а себестоимость
 * продажи. Всё остальное отрицательное считаем удержанием и показываем.
 * Список консервативный: лучше показать лишнее, чем спрятать реальный штраф.
 */
const OZON_EXPECTED = new Set([
  'OperationAgentDeliveredToCustomer',
  'OperationAgentStornoDeliveredToCustomer',
  'MarketplaceRedistributionOfAcquiringOperation',   // эквайринг
  'OperationItemReturn',                             // возвраты и невыкуп
  'ClientReturnAgentOperation',                      // возврат денег покупателю
  'OperationMarketplaceCostPerClick',                // реклама «оплата за клик»
  'OperationMarketplaceServiceStorage',              // хранение
  'OperationMarketplacePackageRedistribution',       // упаковка
  'OperationMarketplacePackageMaterialsProvision',
  'OperationMarketplaceItemTemporaryStorageRedistribution',
  'OperationPromotionWithCostPerOrder',              // реклама (учтена в ДРР)
  'MarketplaceServiceItemCrossdocking',              // кросс-докинг поставки
  'OperationMarketplaceSupplyAdditional',            // обработка грузоместа
]);

/** Штрафы: превышение индекса ошибок и декомпенсации. Остальное — удержания. */
const isOzonFine = (type: string) =>
  type.startsWith('DefectFine') || type.includes('Decompensation') || type.includes('Fine');

async function ozonPenalties(days: number): Promise<{ rows: PenaltyRow[]; total: number }> {
  const from = new Date(Date.now() - days * 86_400_000).toISOString();
  const to = new Date().toISOString();
  const acc = new Map<string, PenaltyRow>();
  let total = 0;
  let page = 1, pageCount = 1;
  do {
    const res = await fetchWithRetry('https://api-seller.ozon.ru/v3/finance/transaction/list', {
      method: 'POST',
      headers: {
        'Client-Id': process.env.OZON_CLIENT_ID ?? '',
        'Api-Key': process.env.OZON_API_KEY ?? '',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        filter: { date: { from, to }, operation_type: [], transaction_type: 'all' },
        page, page_size: 1000,
      }),
    }, { maxRetries: 2, timeoutMs: 60_000 });
    if (!res.ok) break;
    const j: any = await res.json().catch(() => null);
    const result = j?.result ?? {};
    pageCount = result.page_count ?? 1;
    for (const o of (result.operations ?? [])) {
      const amount = Number(o?.amount) || 0;
      if (amount >= 0) continue;                       // начисления нас тут не интересуют
      const code = String(o?.operation_type ?? '');
      if (OZON_EXPECTED.has(code)) continue;
      const kind: PenaltyRow['kind'] = isOzonFine(code) ? 'fine' : 'deduction';
      const key = `${kind}:${code}`;
      const row = acc.get(key) ?? {
        platform: 'ozon' as const, kind, code,
        title: String(o?.operation_type_name ?? code),
        amount: 0, count: 0,
      };
      row.amount = Math.round(row.amount + abs(amount));
      row.count += 1;
      acc.set(key, row);
      total += abs(amount);
    }
    page += 1;
  } while (page <= pageCount && page <= 25);
  return { rows: [...acc.values()], total: Math.round(total) };
}

// ─── Wildberries ─────────────────────────────────────────────────────────────

/** Строки финотчёта WB из прогретого кэша (живьём не ходим — лимит 1/мин). */
function readWbFinanceRows(): any[] {
  const prefix = makeUpstreamCachePrefix(
    'wb:finance', 'POST', 'api/finance/v1/sales-reports/detailed', '',
    JSON.stringify({ dateFrom: '', dateTo: '', limit: 100000, rrdId: 0, period: 'weekly' }),
  );
  const entry = cacheGetNewestByPrefix<{ text: string }>(prefix);
  if (!entry?.data?.text) return [];
  try {
    const arr = JSON.parse(entry.data.text);
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

/**
 * WB отдаёт удержания отдельными числовыми полями строки отчёта, а не типом
 * операции. Поэтому группируем не по названию операции, а по виду удержания.
 */
function wbPenalties(): { rows: PenaltyRow[]; total: number; found: boolean } {
  const rows = readWbFinanceRows();
  if (!rows.length) return { rows: [], total: 0, found: false };

  const buckets: Record<string, { title: string; kind: PenaltyRow['kind']; amount: number; count: number }> = {
    penalty:    { title: 'Штрафы', kind: 'fine', amount: 0, count: 0 },
    deduction:  { title: 'Удержания (прочее)', kind: 'deduction', amount: 0, count: 0 },
    acceptance: { title: 'Платная приёмка', kind: 'deduction', amount: 0, count: 0 },
  };

  const numS = (v: any) => {
    if (v == null || v === '') return 0;
    const n = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.'));
    return Number.isFinite(n) ? n : 0;
  };

  for (const r of rows) {
    // Отчёт приходит и в camelCase (finance-api), и в snake_case (старый v5).
    const pen = numS(r.penalty);
    const ded = numS(r.deduction);
    const acc = numS(r.paidAcceptance ?? r.acceptance);
    if (pen) { buckets.penalty.amount += Math.abs(pen); buckets.penalty.count += 1; }
    if (ded) { buckets.deduction.amount += Math.abs(ded); buckets.deduction.count += 1; }
    if (acc) { buckets.acceptance.amount += Math.abs(acc); buckets.acceptance.count += 1; }
  }

  const out: PenaltyRow[] = Object.values(buckets)
    .filter(b => b.amount > 0)
    .map(b => ({ platform: 'wb' as const, kind: b.kind, title: b.title, amount: Math.round(b.amount), count: b.count }));
  return { rows: out, total: out.reduce((s, r) => s + r.amount, 0), found: true };
}

// ─── Сборка ──────────────────────────────────────────────────────────────────

async function compute(days: number): Promise<Penalties> {
  const notes: string[] = [];

  let ozon = { rows: [] as PenaltyRow[], total: 0 };
  try { ozon = await ozonPenalties(days); }
  catch (e) { notes.push(`Ozon: ${String((e as Error)?.message ?? e).slice(0, 80)}`); }

  const wb = wbPenalties();
  if (!wb.found) notes.push('WB: финотчёт ещё не прогрет (обновляется кроном)');

  const rows = [...ozon.rows, ...wb.rows].sort((a, b) => b.amount - a.amount);
  // Предыдущий период — только по Ozon: у WB отчёт недельный и в кэше лежит
  // одно окно, честного «предыдущего» из него не собрать.
  let prevTotal = 0;
  try { prevTotal = (await ozonPenalties(days * 2)).total - ozon.total; }
  catch { prevTotal = 0; }

  return {
    rows,
    totalFines: rows.filter(r => r.kind === 'fine').reduce((s, r) => s + r.amount, 0),
    totalDeductions: rows.filter(r => r.kind === 'deduction').reduce((s, r) => s + r.amount, 0),
    prevTotal: Math.max(0, Math.round(prevTotal)),
    days,
    fetchedAt: Date.now(),
    diagnostics: notes.join(' · ') || `Ozon: операций ${ozon.rows.length}${wb.found ? ` · WB: видов удержаний ${wb.rows.length}` : ''}`,
  };
}

/** Кэш-первым, как и BI: страница не ждёт проход по транзакциям. */
let penBuilding = false;

export async function getPenaltiesCached(days = 30): Promise<Penalties | null> {
  const cached = await cacheGet<Penalties>(`${RESULT_KEY}:${days}`);
  if (cached?.data) return cached.data;
  if (!penBuilding) {
    penBuilding = true;
    void getPenalties(days, true).catch(() => {}).finally(() => { penBuilding = false; });
  }
  return null;
}

export async function getPenalties(days = 30, noCache = false): Promise<Penalties> {
  const key = `${RESULT_KEY}:${days}`;
  const cached = await cacheGet<Penalties>(key);
  if (!noCache && isFresh(cached)) return cached.data;
  try {
    const fresh = await compute(days);
    await cacheSet(key, fresh, TTL_MS);
    return fresh;
  } catch (e) {
    if (cached?.data) return cached.data;   // лучше вчерашние цифры, чем ошибка
    throw e;
  }
}

/** Короткая сводка для Telegram — используется алертами и командой /штрафы. */
export function formatPenalties(p: Penalties): string {
  if (!p.rows.length) {
    return `✅ <b>Штрафы и удержания за ${p.days} дн.</b>\n\nНичего не найдено.\n<i>${p.diagnostics}</i>`;
  }
  const delta = p.prevTotal > 0
    ? (() => {
        const now = p.totalFines + p.totalDeductions;
        const pct = Math.round(((now - p.prevTotal) / p.prevTotal) * 100);
        return `\n<i>Прошлый период: ${p.prevTotal.toLocaleString('ru-RU')} ₽ (${pct > 0 ? '+' : ''}${pct}%)</i>`;
      })()
    : '';
  const line = (r: PenaltyRow) =>
    `${r.kind === 'fine' ? '🔴' : '🟠'} <b>${r.amount.toLocaleString('ru-RU')} ₽</b> · ${r.title} <i>(${r.platform.toUpperCase()}, ${r.count} шт)</i>`;
  return `💸 <b>Штрафы и удержания за ${p.days} дн.</b>\n` +
    `Штрафы: ${p.totalFines.toLocaleString('ru-RU')} ₽ · прочие удержания: ${p.totalDeductions.toLocaleString('ru-RU')} ₽${delta}\n\n` +
    p.rows.slice(0, 15).map(line).join('\n');
}
