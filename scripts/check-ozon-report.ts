import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Главный сценарий аварии 26.08: пачка заказала отчёт и НЕ ДОЖДАЛАСЬ его.
 * Слот у Ozon остался занят, и все следующие заказы падали с 429 — реклама
 * Ozon обнулялась на весь проход. Проверяем, что второй проход ПОДБИРАЕТ
 * начатый отчёт по сохранённому UUID, а не заказывает новый.
 */
// Кэш проверки — во временную папку: настоящий трогать нельзя.
process.env.CACHE_DIR = mkdtempSync(join(tmpdir(), 'av-check-ozon-'));
process.env.OZON_REPORT_POLL_BUDGET_MS = '400';
process.env.OZON_REPORT_POLL_DELAY_MS = '50';
process.env.OZON_REPORT_SLOT_BUDGET_MS = '400';
process.env.OZON_REPORT_RETRY_MS = '100';
process.env.OZON_REPORT_WINDOW_BUDGET_MS = '20000';
process.env.OZON_CLIENT_ID = 'x';
process.env.OZON_API_KEY = 'x';
process.env.OZON_PERF_CLIENT_ID = 'x';
process.env.OZON_PERF_CLIENT_SECRET = 'x';

let created = 0, downloads = 0, reportReady = false, slotTaken = false;
const realFetch = globalThis.fetch;

(globalThis as any).fetch = async (url: any, init: any) => {
  const u = String(url);
  if (u.includes('/api/client/token')) return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }), { status: 200 });
  if (u.includes('/statistics/campaign/product/json')) return new Response(JSON.stringify({ rows: [{ id: '1', objectType: 'SKU', status: 'CAMPAIGN_STATE_RUNNING', moneySpent: '10,00' }] }), { status: 200 });
  if (u.includes('/api/client/campaign')) return new Response(JSON.stringify({ list: [{ id: '1', state: 'CAMPAIGN_STATE_RUNNING', advObjectType: 'SKU' }] }), { status: 200 });
  if (u.endsWith('/api/client/statistics') && init?.method === 'POST') {
    created++;
    // Ozon держит один слот: пока отчёт активен, новый заказ отбивается.
    if (slotTaken) return new Response('{"error":"Превышен лимит активных запросов (максимум 1)"}', { status: 429 });
    slotTaken = true;
    return new Response(JSON.stringify({ UUID: 'uuid-1' }), { status: 200 });
  }
  if (u.includes('/api/client/statistics/report')) { downloads++; slotTaken = false; return new Response(new TextEncoder().encode('sku;Расход, руб.\n123;100\n'), { status: 200 }); }
  if (u.includes('/api/client/statistics/')) return new Response(JSON.stringify({ state: reportReady ? 'OK' : 'PROCESSING' }), { status: 200 });
  if (u.includes('/v3/product/')) return new Response(JSON.stringify({ result: { items: [] } }), { status: 200 });
  return realFetch(url, init);
};

async function main() {
  const m = await import('../api/_lib/ozonSkuAds');
  let bad = 0;
  const ok = (n: string, c: boolean, extra = '') => { if (!c) bad++; console.log(`  ${c ? '✓' : '✗'} ${n}${extra ? ' · ' + extra : ''}`); };

  // Проход 1: отчёт заказан, но готовности не дождались — слот остался занят.
  await m.getOzonSkuAdsRange(6, 0, true).catch(() => null);
  ok('проход 1: отчёт заказан один раз', created === 1, `заказов ${created}`);
  ok('проход 1: слот остался занят', slotTaken === true);
  ok('проход 1: ничего не скачано', downloads === 0);

  // Проход 2: отчёт у Ozon доготовился. Мы обязаны ПОДОБРАТЬ его, а не заказать новый.
  reportReady = true;
  const r = await m.getOzonSkuAdsRange(6, 0, true).catch((e: any) => { console.log('  упало:', e.message); return null; });
  ok('проход 2: новый отчёт НЕ заказан', created === 1, `заказов всего ${created}`);
  ok('проход 2: начатый отчёт забран', downloads === 1);
  ok('проход 2: слот освобождён', slotTaken === false);
  ok('проход 2: данные получены', r != null);

  console.log(bad ? `\nПРОВАЛОВ: ${bad}` : '\nПодбор брошенного отчёта работает — каскад 429 разорван.');
  process.exit(bad ? 1 : 0);
}
void main();
