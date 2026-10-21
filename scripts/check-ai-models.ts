/**
 * Модели ИИ по разделам (21.10.2026): метка вызова → раздел → модель из «Настроек».
 * Запуск: npm run check
 */
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
process.env.SETTINGS_FILE = join(mkdtempSync(join(tmpdir(), 'av-ai-')), 'settings.json');

const { areaForAgent, modelFor } = await import('../api/_lib/aiModels');
const { setSettings, getSettings } = await import('../api/_lib/settings');
const { cleanAiModels, AI_MODEL_CHOICES, DEFAULT_AI_MODELS } = await import('../shared/aiModels');
const { calcCost } = await import('../api/_lib/aiUsage');
const { costOf } = await import('../api/_lib/reviews/claude');

let failed = 0;
function check(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n      получили ${JSON.stringify(actual)}\n      ждали    ${JSON.stringify(expected)}`}`);
}

console.log('Раздел по метке вызова');
check('инсайты → Дашборд', areaForAgent('insights'), 'dashboard');
check('ИИ-чат → помощник', areaForAgent('chat'), 'assistant');
check('совет в «Ценах» → Цены', areaForAgent('advise:prices'), 'prices');
check('совет по рекламе → Реклама', areaForAgent('advise:ads'), 'ads');
check('сводка конкурентов → Конкуренты', areaForAgent('competitors-summary'), 'competitors');
check('незнакомая метка → Всё остальное', areaForAgent('card-audit'), 'other');

console.log('Выбор владельца');
check('по умолчанию отзывы — Haiku 5.5', modelFor('reviews'), 'claude-haiku-5-5');
check('по умолчанию Дашборд — Opus 5.5', modelFor('dashboard'), 'claude-opus-5-5');
setSettings({ aiModels: { reviews: 'claude-sonnet-5-5' } });
check('выбрал Sonnet для отзывов — действует сразу', modelFor('reviews'), 'claude-sonnet-5-5');
setSettings({ aiModels: { chats: 'claude-fable-5-1' } });
check('выбор другого раздела не сбрасывает отзывы', [modelFor('reviews'), modelFor('chats')], ['claude-sonnet-5-5', 'claude-fable-5-1']);
setSettings({ aiModels: { reviews: 'gpt-4', ads: '# claude-opus-5-5', junk: 'claude-haiku-5-5' } as any });
check('мусор и чужие модели не сохраняются', getSettings().aiModels, { reviews: 'claude-sonnet-5-5', chats: 'claude-fable-5-1' });
check('cleanAiModels отбрасывает неизвестное', cleanAiModels({ reviews: 'claude-haiku-5-5', x: 1, prices: 'nope' }), { reviews: 'claude-haiku-5-5' });
setSettings({ wbFulfilment: 'fbo' });
check('смена других настроек не трогает модели', getSettings().aiModels?.chats, 'claude-fable-5-1');

console.log('Цены всех моделей из списка известны учёту');
for (const c of AI_MODEL_CHOICES) {
  const u = { input_tokens: 1_000_000, output_tokens: 1_000_000 };
  check(`${c.label}: общий учёт`, calcCost(c.id, u).costUsd, c.priceIn + c.priceOut);
  check(`${c.label}: учёт отзывов`, Math.round(costOf(c.id, u) * 100) / 100, c.priceIn + c.priceOut);
}
check('у каждого раздела есть умолчание из списка', Object.values(DEFAULT_AI_MODELS).every(m => AI_MODEL_CHOICES.some(c => c.id === m)), true);

if (failed) { console.error(`\n✗ провалено: ${failed}`); process.exit(1); }
console.log('\n✓ модели ИИ в порядке');
