/**
 * Telegram: наши товары в продаже без конкурентов (07.11.2026, просьба владельца).
 * Конкурентов привязывают только менеджеры, поэтому подсвечиваем, где привязки нет:
 *  1) новинка — товар появился в продаже за последние 14 дней и конкурентов нет: сообщение в течение
 *     ~15 минут, днём 09:00–20:00 МСК (ночью копим до утра), по каждому товару один раз;
 *  2) по понедельникам в 10:00 МСК — сводка по WB и Ozon со списком артикулов.
 * «Без конкурентов» — как фильтр в разделе: в продаже, не в архиве, ни одного привязанного конкурента.
 * Тот же бот и чат, что напоминания о сравнениях WB (../telegram.ts), отметки — в ad_tg_sent.
 */
import { adsDb } from './store';
import { getCompetitors } from './cabinet';
import { tgSend, tgEscape as esc, tgConfigured } from '../telegram';
import type { Ads2Mp, Ads2WatchProduct } from '../../../shared/ads2';

const MSK = 3 * 3_600_000;
const NEW_DAYS = 14;
const SITE = (mp: Ads2Mp) => `https://e-avtovibe.ru/#competitors-${mp}-bare`;
const MP_NAME: Record<Ads2Mp, string> = { wb: 'WB', ozon: 'Ozon' };

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

const ddmm = (ms: number) => new Date(ms + MSK).toISOString().slice(5, 10).split('-').reverse().join('.');
const line = (p: Ads2WatchProduct) => `• <b>${esc(p.key)}</b>${p.name && p.name !== p.key ? ` — ${esc(p.name.slice(0, 60))}` : ''}${p.stockSince ? ` (в продаже с ${ddmm(p.stockSince)})` : ''}`;

/** Текст про новинки без конкурентов. Пусто — нечего слать. */
export function newBareText(mp: Ads2Mp, list: Ads2WatchProduct[]): string {
  if (!list.length) return '';
  const n = list.length;
  return [`🆕 <b>${MP_NAME[mp]}: ${n === 1 ? 'новый товар в продаже' : `новые товары в продаже (${n})`} без конкурентов</b>`,
    ...list.slice(0, 20).map(line), n > 20 ? `…и ещё ${n - 20}` : '',
    `Привяжите конкурентов: <a href="${SITE(mp)}">«Конкуренты» → ${MP_NAME[mp]} → «Без конкурентов»</a>, кнопка «+ Конкурент» у товара.`].filter(Boolean).join('\n');
}

/** Недельная сводка по обеим площадкам. */
export function weeklyBareText(by: Record<Ads2Mp, Ads2WatchProduct[]>): string {
  const total = by.wb.length + by.ozon.length;
  if (!total) return '✅ <b>Все наши товары в продаже — с конкурентами</b> (WB и Ozon).';
  const part = (mp: Ads2Mp) => {
    const l = by[mp];
    if (!l.length) return `<b>${MP_NAME[mp]}</b>: все с конкурентами`;
    const keys = l.slice(0, 40).map(p => esc(p.key)).join(', ');
    return `<b>${MP_NAME[mp]}: ${l.length}</b> — <a href="${SITE(mp)}">открыть список</a>\n${keys}${l.length > 40 ? ` …и ещё ${l.length - 40}` : ''}`;
  };
  return [`📋 <b>Товары в продаже без конкурентов: WB ${by.wb.length}, Ozon ${by.ozon.length}</b>`, part('wb'), part('ozon'),
    'Карточки под вывод и старые уберите «В архив» — тогда они перестанут попадать в список.'].join('\n\n');
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
    if (m.getUTCDay() === 1 && hm >= 10 * 60 && hm < 13 * 60 && !sent(`bare-week:${day}`)) {
      if (await tgSend(weeklyBareText(by))) mark(`bare-week:${day}`);
    }
    // Новинки: по каждому товару один раз. Отметку ставим, только если сообщение ушло.
    for (const mp of ['wb', 'ozon'] as Ads2Mp[]) {
      const fresh = by[mp].filter(p => p.stockSince && Date.now() - p.stockSince < NEW_DAYS * 86_400_000 && !sent(`bare-new:${mp}:${p.key}`));
      if (!fresh.length) continue;
      if (await tgSend(newBareText(mp, fresh))) for (const p of fresh) mark(`bare-new:${mp}:${p.key}`);
    }
  } catch (e) { console.warn('[bare-notify]', (e as Error).message); }
  finally { busy = false; }
}

export function scheduleBareNotify(): void {
  // Раз в 15 минут; первый раз — через 5 минут после старта (сервер успевает прогреть справочники).
  setTimeout(() => { void tick(); setInterval(() => { void tick(); }, 15 * 60_000).unref(); }, 5 * 60_000).unref();
  console.log('[bare-notify] товары без конкурентов: новинки 09:00–20:00, сводка по понедельникам 10:00 МСК' + (tgConfigured() ? '' : ' — токен Telegram не задан'));
}
