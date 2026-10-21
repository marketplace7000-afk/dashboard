/**
 * Подбор модели Claude под раздел — по выбору владельца в «Настройках» → «Модели ИИ».
 * Список разделов и моделей — shared/aiModels.ts; выбор хранится в настройках
 * кабинета (av-data/settings.json, поле aiModels).
 *
 * Каждый вызов Claude помечен агентом (insights, chat, advise:prices, reviews:draft…);
 * по метке определяем раздел, по разделу — модель. Выбор действует сразу, без
 * перезапуска: настройки читаются из памяти процесса.
 */
import { DEFAULT_AI_MODELS, type AiArea } from '../../shared/aiModels';
import { getSettings } from './settings';

/** Модель раздела: выбор владельца, иначе умолчание. */
export function modelFor(area: AiArea): string {
  return getSettings().aiModels?.[area] || DEFAULT_AI_MODELS[area];
}

/** Раздел по метке агента из callAnthropic. Незнакомая метка — «Всё остальное». */
export function areaForAgent(agent: string | undefined): AiArea {
  const a = String(agent ?? '');
  if (a === 'insights') return 'dashboard';
  if (a === 'chat') return 'assistant';
  if (a === 'price-reason') return 'prices';
  if (a === 'competitors-summary') return 'competitors';
  if (a === 'review-reply') return 'reviews';
  if (a.startsWith('advise:')) {
    const m = a.slice('advise:'.length);
    if (m === 'prices' || m === 'promos') return 'prices';
    if (m === 'ads') return 'ads';
    return 'other';
  }
  if (a.startsWith('ads')) return 'ads';
  return 'other';
}
