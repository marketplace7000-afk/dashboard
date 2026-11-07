/**
 * Telegram «товары без конкурентов» (07.11.2026): тексты новинок и недельной сводки.
 * Запуск: node node_modules/tsx/dist/cli.mjs scripts/check-bare-notify.ts
 */
import './_ads-check-env';
import { newBareText, weeklyBareText } from '../api/_lib/ads/bareNotify';

let failed = 0;
const check = (name: string, ok: boolean, got?: unknown) => { if (!ok) failed++; console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : ` — ${JSON.stringify(got)}`}`); };
const p = (key: string, name: string, since: number | null) => ({ key, name, ourId: '1', photo: '', our: null, links: [], inStock: true, stockSince: since }) as any;

const one = newBareText('ozon', [p('AFERIY-X', 'Электростанция <AFERIY>', Date.UTC(2026, 10, 7, 10))]);
check('новинка: заголовок в единственном числе', one.includes('Ozon: новый товар в продаже без конкурентов') && one.includes('\n\n'), one);
check('новинка: дата поступления и экранирование', one.includes('в продаже с 07.11') && one.includes('&lt;AFERIY&gt;'), one);
check('ссылка сразу на фильтр', one.includes('#competitors-ozon-bare'), one);
check('пусто — ничего не шлём', newBareText('wb', []) === '');
const many = newBareText('wb', Array.from({ length: 23 }, (_, i) => p(`K${i}`, '', null)));
check('много новинок — первые 15 и «ещё 8»', many.includes('— 23') && many.includes('…и ещё 8') && !many.includes('K15'), many);
const w = weeklyBareText('wb', [p('A', '', null), p('B', '', null)]);
check('сводка: счётчик, список и ссылка своей площадки', w.includes('WB: в продаже без конкурентов — 2 товара') && w.includes('• <b>A</b>\n\n• <b>B</b>') && w.includes('#competitors-wb-bare'), w);
check('сводка: всё привязано', weeklyBareText('ozon', []).startsWith('✅ <b>Ozon'));
console.log(failed ? `\nПРОВАЛЕНО: ${failed}` : '\nВсе проверки прошли');
process.exit(failed ? 1 : 0);
