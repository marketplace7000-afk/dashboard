/**
 * Push-алерты в Telegram (ROI/ДРР/критичные остатки/всплеск неотвеченных отзывов).
 *
 * Принцип: НЕ ходим в WB/Ozon — читаем то, что cron уже прогрел в кэше + снимок
 * buildSnapshot(). Пороги настраиваются через env (значения по умолчанию ниже).
 * Дедуп через alert_sent (SQLite): один и тот же алерт не шлём чаще раза в сутки.
 *
 * Вызывается из handleCron после прогрева (fire-and-forget).
 */
// cacheSet нужен дедупу alreadySent(). Его тут не хватало: функция падала
// ReferenceError на каждой проверке, поэтому дедуп не работал и алерты
// повторялись (жалоба 31.07 — считалось, что починено, но импорт не добавили).
import { cacheGet, cacheSet, cacheGetNearestWindow, makeUpstreamCacheKey, makeUpstreamCachePrefix, windowKeyFor } from './cache';
import { buildSnapshot } from './aiContext';

const TG_DEDUP_MS = 20 * 60 * 60_000; // один и тот же алерт не чаще ~раза в сутки

// ── Пороги (env переопределяет) ──
const TH_STOCK_CRIT   = num(process.env.ALERT_STOCK_CRITICAL, 5);    // остаток ≤ N шт → критично
const TH_REVIEWS_MANY = num(process.env.ALERT_REVIEWS_UNANSWERED, 10); // неотвеченных ≥ N → напомнить
const ENABLED = () => (process.env.ALERTS_ENABLED ?? '1') !== '0';

function num(v: string | undefined, def: number): number {
  const n = Number(v); return Number.isFinite(n) && v != null && v !== '' ? n : def;
}

/** Тихо читает JSON из кэша прокси (точный ключ → ближайшее окно ТОЙ ЖЕ длины).
 *  Раньше fallback брал свежайший снимок по префиксу — то есть алерт про неделю
 *  мог посчитаться по месячному датасету (все окна лежат под одним префиксом).
 *  Алерт с чужим периодом хуже отсутствующего, поэтому длину окна не меняем. */
async function readCache<T>(ns: string, method: 'GET' | 'POST', path: string, qs = '', body?: any): Promise<T | null> {
  const bodyStr = body ? JSON.stringify(body) : undefined;
  let cached = await cacheGet<{ status: number; text: string }>(makeUpstreamCacheKey(ns, method, path, qs, bodyStr));
  if (!cached || cached.data.status >= 400) {
    const near = cacheGetNearestWindow<{ status: number; text: string }>(
      makeUpstreamCachePrefix(ns, method, path, qs, bodyStr),
      windowKeyFor(qs, bodyStr),
    );
    if (near && near.entry.data.status < 400) cached = near.entry;
  }
  if (!cached || cached.data.status >= 400) return null;
  try { return JSON.parse(cached.data.text) as T; } catch { return null; }
}

export type AlertLine = { key: string; text: string };

/** Собирает список алертов по текущим данным кэша. Каждый — со стабильным ключом
 *  для дедупа (ключ включает дату, чтобы назавтра алерт мог прийти снова). */
export async function collectAlerts(): Promise<AlertLine[]> {
  const out: AlertLine[] = [];
  const day = new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10); // МСК-дата

  // 1) Критичные остатки Ozon (present - reserved ≤ порог)
  const stocksRaw = await readCache<any>('ozon-seller', 'POST', 'v4/product/info/stocks', '', { filter: { visibility: 'ALL' }, limit: 100 });
  const items = stocksRaw?.items as Array<{ offer_id: string; stocks?: Array<{ present: number; reserved: number }> }> | undefined;
  if (items?.length) {
    const low: string[] = [];
    for (const it of items) {
      const available = (it.stocks ?? []).reduce((s, x) => s + ((x.present ?? 0) - (x.reserved ?? 0)), 0);
      if (available <= TH_STOCK_CRIT) low.push(`${it.offer_id} (${available} шт)`);
    }
    if (low.length) {
      out.push({
        key: `stock:${day}`,
        // Перечисляем ВСЕ позиции: обрезка до 15 строк («…и ещё N») скрывала
        // половину списка и заставляла лезть в кабинет (правка 30.07).
        // Длинные сообщения бьются на части в sendMessage.
        text: `🔴 <b>Критичные остатки Ozon</b> (≤ ${TH_STOCK_CRIT} шт): ${low.length} SKU\n` +
              low.map(s => `• ${s}`).join('\n'),
      });
    }
  }

  // 2) Снимок: неотвеченные отзывы / падение выручки
  const snap = await buildSnapshot().catch(() => null);
  if (snap?.reviews && snap.reviews.unanswered >= TH_REVIEWS_MANY) {
    out.push({
      key: `reviews:${day}`,
      text: `📝 <b>Неотвеченных отзывов WB: ${snap.reviews.unanswered}</b> (порог ${TH_REVIEWS_MANY}). Ответьте, чтобы не терять рейтинг.`,
    });
  }

  return out;
}

/**
 * Дедуп на ДИСКОВОМ кэше. В памяти он не переживал бы рестарт, а SQLite на
 * сервере оказался недоступен — из-за этого после каждого деплоя прилетали
 * повторы одних и тех же алертов (жалоба 31.07).
 */
async function alreadySent(key: string): Promise<boolean> {
  const cacheKey = `alert-sent:${key}`;
  const prev = await cacheGet<{ at: number }>(cacheKey);
  if (prev?.data?.at && Date.now() - prev.data.at < TG_DEDUP_MS) return true;
  await cacheSet(cacheKey, { at: Date.now() }, TG_DEDUP_MS);
  return false;
}

/**
 * Пометить алерты отправленными, не отправляя их.
 * Нужно, когда список показали вручную (команда /alerts): без этого авто-проверка
 * пришлёт то же самое повторно, потому что дедуп ведётся только при отправке.
 */
export async function markAlertsSent(alerts: AlertLine[]): Promise<void> {
  for (const a of alerts) await alreadySent(a.key);
}

/** Проверяет пороги и шлёт новые алерты в Telegram. Возвращает число отправленных. */
export async function runAlertsAndNotify(
  sendMessage: (text: string) => Promise<void>,
): Promise<number> {
  if (!ENABLED()) return 0;
  let sent = 0;
  try {
    const alerts = await collectAlerts();
    for (const a of alerts) {
      if (await alreadySent(a.key)) continue;   // уже слали сегодня
      await sendMessage(a.text);
      sent++;
    }
  } catch (e) {
    console.warn('[alerts] сбой проверки порогов:', (e as Error).message);
  }
  return sent;
}
