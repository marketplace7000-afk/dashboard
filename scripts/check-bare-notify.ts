/**
 * Telegram «товары без конкурентов» (07.11.2026): кто попадает в список, тексты новинок и сводки (пн/ср/пт).
 * Запуск: node node_modules/tsx/dist/cli.mjs scripts/check-bare-notify.ts
 */
import './_ads-check-env';
import { newBareText, weeklyBareText, isBare } from '../api/_lib/ads/bareNotify';

let failed = 0;
const check = (name: string, ok: boolean, got?: unknown) => { if (!ok) failed++; console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : ` — ${JSON.stringify(got)}`}`); };
const p = (key: string, name: string, since: number | null, extra: Record<string, unknown> = {}) =>
  ({ key, name, ourId: '1', photo: '', our: null, links: [], inStock: true, stockSince: since, ...extra }) as any;

check('в продаже без конкурентов — в списке', isBare(p('A', '', null)));
check('в архиве — не в списке', !isBare(p('A', '', null, { archived: true })));
check('без остатка — не в списке', !isBare(p('A', '', null, { inStock: false })));
check('с привязанным конкурентом — не в списке', !isBare(p('A', '', null, { links: [{ status: 'active' }] })));

const one = newBareText('ozon', [p('AFERIY-X', 'Электростанция AFERIY', Date.UTC(2026, 10, 7, 10))]);
check('новинка: заголовок в единственном числе, части через пустую строку', one.includes('Ozon: новый товар в продаже без конкурентов') && one.includes('\n\n'), one);
check('новинка: артикул и дата, без названия', one.includes('<b>AFERIY-X</b> — в продаже с 07.11') && !one.includes('Электростанция'), one);
check('ссылка сразу на фильтр', one.includes('#competitors-ozon-bare'), one);
check('пусто — ничего не шлём', newBareText('wb', []) === '');
const many = newBareText('wb', Array.from({ length: 33 }, (_, i) => p(`K${i}`, '', null)));
check('много новинок — первые 30 и «ещё 3»', many.includes('— 33') && many.includes('…и ещё 3') && !many.includes('K30'), many);
const w = weeklyBareText('wb', [p('A<1>', 'Название', null), p('B', 'Другое', null)]);
check('сводка: счётчик, только артикулы по строке, ссылка своей площадки',
  w.includes('WB: в продаже без конкурентов — 2 товара') && w.includes('1. <b>A&lt;1&gt;</b>\n2. <b>B</b>') && !w.includes('Название') && w.includes('#competitors-wb-bare'), w);
check('сводка: всё привязано', weeklyBareText('ozon', []).startsWith('✅ <b>Ozon'));
console.log(failed ? `\nПРОВАЛЕНО: ${failed}` : '\nВсе проверки прошли');
process.exit(failed ? 1 : 0);
