/**
 * Telegram: наши товары в продаже без конкурентов (07.11.2026, просьба владельца).
 * Конкурентов привязывают только менеджеры, поэтому подсвечиваем, где привязки нет:
 *  1) новинка — товар появился в продаже за последние 14 дней и конкурентов нет: сообщение в течение
 *     ~15 минут, днём 09:00–20:00 МСК (ночью копим до утра), по каждому товару один раз;
 *  2) по понедельникам в 10:00 МСК — сводка по WB и Ozon со списком артикулов.
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
export function bareProducts(mp: Ads2Mp): Ads2WatchProduct[] {
  return getCompetitors(mp).watch
    .filter(p => !p.archived && p.inStock && !p.links.some(l => l.status === 'active'))
    .sort((a, b) => (b.stockSince ?? 0) - (a.stockSince ?? 0) || a.key.localeCompare(b.key, 'ru'));
}

/** Название не длиннее n символов, обрезка по целому слову. */
const cut = (t: string, n: number) => (t.length <= n ? t : t.slice(0, n).replace(/\s+\S*$/, '') + '…');
const ddmm = (ms: number) => new Date(ms + MSK).toISOString().slice(5, 10).split('-').reverse().join('.');
/** Товар отдельным блоком: артикул, название, с какого дня в продаже — каждое с новой строки (08.11: владелец — «слишком скомкано»). */
const block = (p: Ads2WatchProduct, i: number) => [
  `${i + 1}. <b>${esc(p.key)}</b>`,
  p.name && p.name !== p.key ? `    ${esc(cut(p.name, 70))}` : '',
  p.stockSince ? `    в продаже с ${ddmm(p.stockSince)}` : '',
].filter(Boolean).join('\n');
const howTo = (mp: Ads2Mp) => `👉 Привяжите конкурентов: <a href="${SITE(mp)}">«Конкуренты» → ${MP_NAME[mp]} → «Без конкурентов»</a>, кнопка «+ Конкурент» у товара.`;
const plural = (n: number) => (n % 10 === 1 && n % 100 !== 11 ? 'товар' : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? 'товара' : 'товаров');

/** Текст про новинки без конкурентов. Пусто — нечего слать. */
export function newBareText(mp: Ads2Mp, list: Ads2WatchProduct[]): string {
  if (!list.length) return '';
  const n = list.length;
  return [
    `🆕 <b>${MP_NAME[mp]}: ${n === 1 ? 'новый товар в продаже без конкурентов' : `новые товары в продаже без конкурентов — ${n}`}</b>`,
    list.slice(0, 15).map(block).join('\n\n') + (n > 15 ? `\n\n…и ещё ${n - 15}` : ''),
    howTo(mp),
  ].join('\n\n');
}

/** Недельная сводка по площадке — в её чат. Каждый товар с новой строки. */
export function weeklyBareText(mp: Ads2Mp, l: Ads2WatchProduct[]): string {
  if (!l.length) return `✅ <b>${MP_NAME[mp]}: все наши товары в продаже — с конкурентами</b>`;
  const rows = l.slice(0, 30).map(p => `• <b>${esc(p.key)}</b>${p.name && p.name !== p.key ? `\n    ${esc(cut(p.name, 60))}` : ''}`);
  return [
    `📋 <b>${MP_NAME[mp]}: в продаже без конкурентов — ${l.length} ${plural(l.length)}</b>`,
    rows.join('\n\n') + (l.length > 30 ? `\n\n…и ещё ${l.length - 30}` : ''),
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
    // Понедельник 10:00–13:00: сводка раз в неделю.
    const day = m.toISOString().slice(0, 10);
    if (m.getUTCDay() === 1 && hm >= 10 * 60 && hm < 13 * 60) {
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
  console.log('[bare-notify] товары без конкурентов: новинки 09:00–20:00, сводка по понедельникам 10:00 МСК' + (tgConfigured() ? '' : ' — токен Telegram не задан'));
}
