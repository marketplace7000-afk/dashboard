/**
 * Остатки Ozon для фильтра «В продаже»: доступно = present − reserved, FBO + FBS/rFBS.
 * Запуск: npm run check
 */
import { aggregateOzonStocks } from '../api/_lib/ozonStock';

let failed = 0;
function check(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n      получили ${JSON.stringify(actual)}\n      ждали    ${JSON.stringify(expected)}`}`);
}
const st = (type: string, present: number, reserved = 0) => ({ type, present, reserved });
const r = aggregateOzonStocks([
  { offer_id: 'POLFAR', stocks: [st('fbo', 0), st('fbs', 15), st('rfbs', 0)] },
  { offer_id: 'carlinkit-ultra4-krug', stocks: [st('fbo', 0), st('fbs', 0)] },
  { offer_id: 'RESERVED-ONLY', stocks: [st('fbo', 2, 2), st('fbs', 0)] },
  { offer_id: 'MIX', stocks: [st('fbo', 3, 1), st('rfbs', 4)] },
]);
check('FBS-остаток считается', r.byOffer['POLFAR'], 15);
check('нет нигде — 0 (не в продаже)', r.byOffer['CARLINKIT-ULTRA4-KRUG'], 0);
check('всё под резервом — 0', r.byOffer['RESERVED-ONLY'], 0);
check('FBO + rFBS суммируются', [r.fboByOffer['MIX'], r.fbsByOffer['MIX'], r.byOffer['MIX']], [2, 4, 6]);
console.log(failed ? `\nРАСХОЖДЕНИЙ: ${failed}` : '\nВсё сходится.');
process.exit(failed ? 1 : 0);
