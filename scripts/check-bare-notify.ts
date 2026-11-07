/**
 * Telegram «товары без конкурентов» (07.11.2026): кто попадает в список и единый текст сообщения
 * (сводка пн/ср/пт и «появилась новинка» — один и тот же список, у новинок дата поступления).
 * Запуск: node node_modules/tsx/dist/cli.mjs scripts/check-bare-notify.ts
 */
import './_ads-check-env';
import { bareText, isBare, isFresh } from '../api/_lib/ads/bareNotify';

let failed = 0;
const check = (name: string, ok: boolean, got?: unknown) => { if (!ok) failed++; console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : ` — ${JSON.stringify(got)}`}`); };
const p = (key: string, name: string, since: number | null, extra: Record<string, unknown> = {}) =>
  ({ key, name, ourId: '1', photo: '', our: null, links: [], inStock: true, stockSince: since, ...extra }) as any;
const NOW = Date.UTC(2026, 10, 9, 8);

check('в продаже без конкурентов — в списке', isBare(p('A', '', null)));
check('в архиве — не в списке', !isBare(p('A', '', null, { archived: true })));
check('без остатка — не в списке', !isBare(p('A', '', null, { inStock: false })));
check('с привязанным конкурентом — не в списке', !isBare(p('A', '', null, { links: [{ status: 'active' }] })));
check('новинка — до 14 дней', isFresh(p('A', '', Date.UTC(2026, 10, 7, 10)), NOW) && !isFresh(p('A', '', Date.UTC(2026, 9, 1)), NOW) && !isFresh(p('A', '', null), NOW));

const list = [p('AFERIY-X', 'Электростанция AFERIY', Date.UTC(2026, 10, 7, 10)), p('A<1>', 'Название', Date.UTC(2026, 8, 1)), p('B', 'Другое', null)];
const w = bareText('wb', list, NOW);
check('сводка: счётчик, все артикулы, без названий',
  w.includes('WB: в продаже без конкурентов — 3 товара') && w.includes('2. <b>A&lt;1&gt;</b>\n3. <b>B</b>') && !w.includes('Название') && !w.includes('Электростанция'), w);
check('сводка: у новинки дата поступления, у старых — нет',
  w.includes('1. <b>AFERIY-X</b> — 🆕 в продаже с 07.11') && !w.includes('A&lt;1&gt;</b> —'), w);
check('части через пустую строку, ссылка своей площадки', w.includes('\n\n') && w.includes('#competitors-wb-bare'), w);
const n = bareText('ozon', list, NOW, 1);
check('повод «новинка»: тот же полный список, заголовок про новинку',
  n.includes('Ozon: новый товар в продаже без конкурентов') && n.includes('Всего без конкурентов — 3 товара') && n.includes('3. <b>B</b>'), n);
check('несколько новинок — число в заголовке', bareText('wb', list, NOW, 2).includes('новые товары (2)'));
const many = bareText('wb', Array.from({ length: 83 }, (_, i) => p(`K${i}`, '', null)), NOW);
check('длинный список — первые 80 и «ещё 3»', many.includes('…и ещё 3') && !many.includes('K80'), many.slice(-300));
check('всё привязано', bareText('ozon', []).startsWith('✅ <b>Ozon'));
console.log(failed ? `\nПРОВАЛЕНО: ${failed}` : '\nВсе проверки прошли');
process.exit(failed ? 1 : 0);
