/**
 * Telegram: наши товары в продаже без конкурентов (07.11.2026, просьба владельца).
 * Конкурентов привязывают только менеджеры, поэтому подсвечиваем, где привязки нет:
 *  1) новинка — товар появился в продаже за последние 14 дней и конкурентов нет: сообщение в течение
 *     ~15 минут, днём 09:00–20:00 МСК (ночью копим до утра), по каждому товару один раз;
 *  2) по понедельникам, средам и пятницам в 10:00 МСК — сводка по площадке со списком артикулов (без названий).
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

/** Товары площадки в продаже без конкурентов (как фильтр «Без конкурентов»), новинки сверху. */
/** Без конкурентов: в продаже, не в архиве, ни одного привязанного конкурента. */
export const isBare = (p: Ads2WatchProduct): boolean => !p.archived && !!p.inStock && !p.links.some(l => l.status === 'active');

export function bareProducts(mp: Ads2Mp): Ads2WatchProduct[] {
  return getCompetitors(mp).watch
    .filter(isBare)
    .sort((a, b) => (b.stockSince ?? 0) - (a.stockSince ?? 0) || a.key.localeCompare(b.key, 'ru'));
}

const ddmm = (ms: number) => new Date(ms + MSK).toISOString().slice(5, 10).split('-').reverse().join('.');
/** Товар — одной строкой, только артикул (07.11: владелец — названия не нужны); части сообщения разделены пустой строкой. */
const row = (p: Ads2WatchProduct, i: number) => `${i + 1}. <b>${esc(p.key)}</b>${p.stockSince ? ` — в продаже с ${ddmm(p.stockSince)}` : ''}`;
const howTo = (mp: Ads2Mp) => `👉 Привяжите конкурентов: <a href="${SITE(mp)}">«Конкуренты» → ${MP_NAME[mp]} → «Без конкурентов»</a>, кнопка «+ Конкурент» у товара.`;
const plural = (n: number) => (n % 10 === 1 && n % 100 !== 11 ? 'товар' : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? 'товара' : 'товаров');

/** Текст про новинки без конкурентов. Пусто — нечего слать. */
export function newBareText(mp: Ads2Mp, list: Ads2WatchProduct[]): string {
  if (!list.length) return '';
  const n = list.length;
  return [
    `🆕 <b>${MP_NAME[mp]}: ${n === 1 ? 'новый товар в продаже без конкурентов' : `новые товары в продаже без конкурентов — ${n}`}</b>`,
    list.slice(0, 30).map(row).join('\n') + (n > 30 ? `\n…и ещё ${n - 30}` : ''),
    howTo(mp),
  ].join('\n\n');
}

/** Сводка по площадке (пн, ср, пт) — в её чат. Только артикулы, каждый с новой строки; архив не входит (bareProducts). */
export function weeklyBareText(mp: Ads2Mp, l: Ads2WatchProduct[]): string {
  if (!l.length) return `✅ <b>${MP_NAME[mp]}: все наши товары в продаже — с конкурентами</b>`;
  const rows = l.slice(0, 80).map((p, i) => `${i + 1}. <b>${esc(p.key)}</b>`);
  return [
    `📋 <b>${MP_NAME[mp]}: в продаже без конкурентов — ${l.length} ${plural(l.length)}</b>`,
    rows.join('\n') + (l.length > 80 ? `\n…и ещё ${l.length - 80}` : ''),
    howTo(mp),
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
    const m = new Date(Date.now() + MSK);
    const hm = m.getUTCHours() * 60 + m.getUTCMinutes();
    if (hm < 9 * 60 || hm >= 20 * 60) return;
    const by = { wb: bareProducts('wb'), ozon: bareProducts('ozon') } as Record<Ads2Mp, Ads2WatchProduct[]>;
    // Понедельник, среда, пятница 10:00–13:00: сводка, чтобы менеджеры не забывали (07.11: владелец — 3 раза в неделю).
    const day = m.toISOString().slice(0, 10);
    if ([1, 3, 5].includes(m.getUTCDay()) && hm >= 10 * 60 && hm < 13 * 60) {
      for (const mp of ['wb', 'ozon'] as Ads2Mp[]) {
        if (!sent(`bare-week:${mp}:${day}`) && await tgSend(weeklyBareText(mp, by[mp]), chatOf(mp))) mark(`bare-week:${mp}:${day}`);
      }
    }
    // Новинки: по каждому товару один раз. Отметку ставим, только если сообщение ушло.
    for (const mp of ['wb', 'ozon'] as Ads2Mp[]) {
      const fresh = by[mp].filter(p => p.stockSince && Date.now() - p.stockSince < NEW_DAYS * 86_400_000 && !sent(`bare-new:${mp}:${p.key}`));
      if (!fresh.length) continue;
      if (await tgSend(newBareText(mp, fresh), chatOf(mp))) for (const p of fresh) mark(`bare-new:${mp}:${p.key}`);
    }
  } catch (e) { console.warn('[bare-notify]', (e as Error).message); }
  finally { busy = false; }
}

export function scheduleBareNotify(): void {
  // Раз в 15 минут; первый раз — через 5 минут после старта (сервер успевает прогреть справочники).
  setTimeout(() => { void tick(); setInterval(() => { void tick(); }, 15 * 60_000).unref(); }, 5 * 60_000).unref();
  console.log('[bare-notify] товары без конкурентов: новинки 09:00–20:00, сводка пн/ср/пт 10:00 МСК' + (tgConfigured() ? '' : ' — токен Telegram не задан'));
}
