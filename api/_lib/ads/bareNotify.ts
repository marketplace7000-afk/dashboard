/**
 * Telegram: наши товары в продаже без конкурентов (07.11.2026, просьба владельца).
 * Конкурентов привязывают только менеджеры, поэтому подсвечиваем, где привязки нет.
 * Одно сообщение одного вида (07.11: владелец — «если товары есть в обоих списках, смысла присылать дважды нет»):
 * полный список артикулов площадки без конкурентов; у новинок (в продаже ≤14 дней) — «🆕 в продаже с дд.мм».
 * Когда шлём:
 *  1) пн, ср, пт в 10:00 МСК — сводка, чтобы менеджеры не забывали;
 *  2) появилась новинка без конкурентов — тот же список с заголовком про новинку, в течение ~15 минут,
 *     днём 09:00–20:00 (ночью копим до утра; в день сводки утренние новинки ждут сводку в 10:00). По товару — один раз.
 * «Без конкурентов» — как фильтр в разделе: в продаже, не в архиве, ни одного привязанного конкурента.
 * Тот же бот, что напоминания о сравнениях WB (../telegram.ts): WB — в чат «AV | Wildberris», Ozon — в «AV | OZON».
 * Отметки — в ad_tg_sent.
 */
import { adsDb } from './store';
import { getCompetitors } from './cabinet';
import { tgSend, tgEscape as esc, tgConfigured, OZON_CHAT_ID } from '../telegram';
import type { Ads2Mp, Ads2WatchProduct } from '../../../shared/ads2';

const MSK = 3 * 3_600_000;
const NEW_DAYS = 14;
const MAX_ROWS = 80;
const SITE = (mp: Ads2Mp) => `https://e-avtovibe.ru/#competitors-${mp}-bare`;
const MP_NAME: Record<Ads2Mp, string> = { wb: 'WB', ozon: 'Ozon' };
/** Чат площадки: WB — рабочий чат бота по умолчанию, Ozon — «AV | OZON». */
const chatOf = (mp: Ads2Mp): number | undefined => (mp === 'ozon' ? OZON_CHAT_ID : undefined);

function db(): any {
  const d = adsDb();
  if (!d) throw new Error('хранилище недоступно');
  d.exec('CREATE TABLE IF NOT EXISTS ad_tg_sent (key TEXT PRIMARY KEY, at INTEGER NOT NULL);');
  return d;
}

/** Без конкурентов: в продаже, не в архиве, ни одного привязанного конкурента. */
export const isBare = (p: Ads2WatchProduct): boolean => !p.archived && !!p.inStock && !p.links.some(l => l.status === 'active');
/** Новинка: в продаже не больше 14 дней. */
export const isFresh = (p: Ads2WatchProduct, now = Date.now()): boolean => !!p.stockSince && now - p.stockSince < NEW_DAYS * 86_400_000;

/** Товары площадки без конкурентов, новинки сверху. */
export function bareProducts(mp: Ads2Mp): Ads2WatchProduct[] {
  return getCompetitors(mp).watch
    .filter(isBare)
    .sort((a, b) => (b.stockSince ?? 0) - (a.stockSince ?? 0) || a.key.localeCompare(b.key, 'ru'));
}

const ddmm = (ms: number) => new Date(ms + MSK).toISOString().slice(5, 10).split('-').reverse().join('.');
const plural = (n: number) => (n % 10 === 1 && n % 100 !== 11 ? 'товар' : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? 'товара' : 'товаров');

/**
 * Единое сообщение: список всех артикулов площадки без конкурентов, у новинок — дата поступления.
 * added > 0 — повод «появились новинки» (заголовок про них), иначе — сводка пн/ср/пт.
 */
export function bareText(mp: Ads2Mp, l: Ads2WatchProduct[], now = Date.now(), added = 0): string {
  if (!l.length) return `✅ <b>${MP_NAME[mp]}: все наши товары в продаже — с конкурентами</b>`;
  const total = `${l.length} ${plural(l.length)}`;
  const head = added
    ? `🆕 <b>${MP_NAME[mp]}: ${added === 1 ? 'новый товар' : `новые товары (${added})`} в продаже без конкурентов</b>\nВсего без конкурентов — ${total}:`
    : `📋 <b>${MP_NAME[mp]}: в продаже без конкурентов — ${total}</b>`;
  const rows = l.slice(0, MAX_ROWS)
    .map((p, i) => `${i + 1}. <b>${esc(p.key)}</b>${isFresh(p, now) ? ` — 🆕 в продаже с ${ddmm(p.stockSince!)}` : ''}`);
  return [
    head,
    rows.join('\n') + (l.length > MAX_ROWS ? `\n…и ещё ${l.length - MAX_ROWS}` : ''),
    `👉 Привяжите конкурентов: <a href="${SITE(mp)}">«Конкуренты» → ${MP_NAME[mp]} → «Без конкурентов»</a>, кнопка «+ Конкурент» у товара.`,
    '🗄 Карточки под вывод и старые уберите «В архив» — тогда они перестанут попадать в список.',
  ].join('\n\n');
}

let busy = false;
async function tick(): Promise<void> {
  if (busy || !tgConfigured()) return;
  busy = true;
  try {
    const d = db();
    const sent = (k: string) => !!d.prepare('SELECT 1 FROM ad_tg_sent WHERE key = ?').get(k);
    const mark = (k: string) => d.prepare('INSERT OR IGNORE INTO ad_tg_sent (key, at) VALUES (?, ?)').run(k, Date.now());
    const now = Date.now();
    const m = new Date(now + MSK);
    const hm = m.getUTCHours() * 60 + m.getUTCMinutes();
    if (hm < 9 * 60 || hm >= 20 * 60) return;
    const day = m.toISOString().slice(0, 10);
    // Пн, ср, пт — сводка (07.11: владелец — 3 раза в неделю, чтобы менеджеры не забывали).
    const summaryDay = [1, 3, 5].includes(m.getUTCDay());
    const summaryTime = summaryDay && hm >= 10 * 60 && hm < 13 * 60;
    for (const mp of ['wb', 'ozon'] as Ads2Mp[]) {
      const list = bareProducts(mp);
      const fresh = list.filter(p => isFresh(p, now) && !sent(`bare-new:${mp}:${p.key}`));
      const markFresh = () => { for (const p of fresh) mark(`bare-new:${mp}:${p.key}`); };
      const weekKey = `bare-week:${mp}:${day}`;
      if (summaryTime && !sent(weekKey)) {
        // В сводке новинки уже есть (с датой) — отдельным сообщением их не дублируем.
        if (await tgSend(bareText(mp, list, now), chatOf(mp))) { mark(weekKey); markFresh(); }
        continue;
      }
      if (summaryDay && hm < 10 * 60) continue; // утренние новинки дождутся сводки в 10:00
      if (fresh.length && await tgSend(bareText(mp, list, now, fresh.length), chatOf(mp))) markFresh();
    }
  } catch (e) { console.warn('[bare-notify]', (e as Error).message); }
  finally { busy = false; }
}

export function scheduleBareNotify(): void {
  // Раз в 15 минут; первый раз — через 5 минут после старта (сервер успевает прогреть справочники).
  setTimeout(() => { void tick(); setInterval(() => { void tick(); }, 15 * 60_000).unref(); }, 5 * 60_000).unref();
  console.log('[bare-notify] товары без конкурентов: одно сообщение-список, сводка пн/ср/пт 10:00, новинки 09:00–20:00 МСК' + (tgConfigured() ? '' : ' — токен Telegram не задан'));
}
