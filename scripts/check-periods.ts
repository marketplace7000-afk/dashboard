/**
 * Сверка окон периода между фронтом и сервером.
 *
 * Зачем отдельная проверка. Ключ серверного кэша строится из дат запроса: сборщик
 * греет данные под ключом из своих дат, браузер читает по своим. Разойдутся на
 * один день — и страница молча покажет пустоту или цифры чужого периода. В логах
 * этого не видно, а по экрану неотличимо от «данных нет». Так уже терялись и
 * воронка WB, и аналитика Ozon.
 *
 * Правило окна теперь живёт в двух зеркальных модулях (src/utils/period.ts и
 * api/_lib/period.ts), и эта проверка следит, чтобы они не разъехались, а заодно
 * фиксирует, что окно — ровно N суток, включая сегодня.
 *
 * Запуск: npm run check
 */
import { periodRange, prevPeriodRange, PERIOD_DAYS, type PeriodKey } from '../src/utils/period';
import { windowRange, prevWindowRange, wbFunnelBody, ozAnalyticsBody } from '../api/_lib/period';
import { makeUpstreamCacheKey } from '../api/_lib/cache';
import { readFileSync } from 'node:fs';

const DAY_MS = 86_400_000;
let failed = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n      получили ${JSON.stringify(actual)}\n      ждали    ${JSON.stringify(expected)}`}`);
}

console.log('Окна периода: фронт против сервера');
for (const p of Object.keys(PERIOD_DAYS) as PeriodKey[]) {
  const days = PERIOD_DAYS[p];
  check(`${p}: текущее окно`, periodRange(p), windowRange(days));
  check(`${p}: предыдущее окно`, prevPeriodRange(p), prevWindowRange(days));

  // Длина ровно N суток, включая сегодня. Раньше окно строилось как today − N,
  // то есть было на сутки длиннее: «неделя» охватывала 8 дней.
  const cur = windowRange(days);
  const len = Math.round((Date.parse(cur.to) - Date.parse(cur.from)) / DAY_MS) + 1;
  check(`${p}: длина ${days} сут`, len, days);

  // Предыдущее окно примыкает вплотную: без нахлёста (задвоит продажи) и без
  // дырки (потеряет день при сравнении период к периоду).
  const prev = prevWindowRange(days);
  check(`${p}: стык с предыдущим`, Math.round((Date.parse(cur.from) - Date.parse(prev.to)) / DAY_MS), 1);
  check(`${p}: длина предыдущего`, Math.round((Date.parse(prev.to) - Date.parse(prev.from)) / DAY_MS) + 1, days);
}


// ── Тела запросов строятся в ОДНОМ месте ──────────────────────────────────
// Ключ кэша строится из тела запроса. Пока тела были описаны у сборщика и у
// читателя по отдельности, они разошлись на сутки: ключ сборщика оканчивался на
// s6, ключ читателя на s7, и точное попадание не случалось НИ РАЗУ. Спасал
// запасной поиск ближайшего окна — то есть штатным режимом работы был промах.
//
// Сравнивать здесь builder сам с собой бессмысленно. Защищает другое: чтобы у
// кого-то снова не завелась своя копия тела. Поэтому смотрим в исходники.
console.log('\nТела запросов: ни одной своей копии');
const OWN_BODY = [
  { file: 'api/_lib/cron.ts', pattern: /period:\s*\{\s*start:/ },
  { file: 'api/_lib/ads/totalRevenue.ts', pattern: /period:\s*\{\s*start:/ },
  { file: 'api/_lib/ads/totalRevenue.ts', pattern: /date_from:\s*mskDate/ },
];
for (const { file, pattern } of OWN_BODY) {
  const src = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
  // Комментарии не считаем: в них эти строки как раз объясняются.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*$/gm, '');
  check(`${file}: тело строится через _lib/period`, pattern.test(code), false);
}

// Разные окна обязаны давать РАЗНЫЕ ключи, иначе месячные данные подменят дневные.
const funnelKey = (days: number) => makeUpstreamCacheKey(
  'wb:analytics', 'POST', 'api/analytics/v3/sales-funnel/products', '', JSON.stringify(wbFunnelBody(days)));
const ozKey = (days: number, limit: number) => makeUpstreamCacheKey(
  'ozon-seller', 'POST', 'v1/analytics/data', '', JSON.stringify(ozAnalyticsBody(days, ['ordered_units', 'revenue'], ['sku'], limit)));
console.log('\nОкна не схлопываются в один ключ');
check('воронка WB: 7д ≠ 30д', funnelKey(7) === funnelKey(30), false);
check('воронка WB: 7д ≠ 14д', funnelKey(7) === funnelKey(14), false);
check('аналитика Ozon: 7д ≠ 30д', ozKey(7, 200) === ozKey(30, 300), false);

console.log(failed ? `\nРАСХОЖДЕНИЙ: ${failed}. Ключи кэша разъедутся — чинить до выкатки.` : '\nВсё сходится.');
process.exit(failed ? 1 : 0);
