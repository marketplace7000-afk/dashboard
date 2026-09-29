/**
 * Надёжная запись в localStorage.
 *
 * Зачем: в браузере на хранилище лимит около 5 МБ, а мы держим там кэши WB, Ozon,
 * финансов и закупок. Когда место кончается, localStorage.setItem БРОСАЕТ
 * исключение. У части кода записи были без try/catch — исключение вылетало прямо
 * из обработчика клика, и кнопка выглядела нерабочей: нажимаешь, а ничего не
 * происходит (жалоба 01.08 — «в архив не добавляется, кнопка не нажимается»).
 *
 * Решение: пишем через safeSetItem. Если места нет — вычищаем кэши (их всегда
 * можно перезагрузить с сервера) и пробуем снова. Пользовательские настройки,
 * архив и ручные значения при этом не трогаем.
 */
import { noteSwallowed } from './log';
import { pushUiState } from './uiState';

// Кэши, которые не жалко удалить: данные восстановятся при следующей загрузке.
// Порядок важен — вычищаем от самых объёмных к мелким.
const EVICTABLE_PREFIXES = [
  'av_procurement_ctx',     // снимок закупок для ИИ-контекста, самый крупный
  'live-wb-cache',
  'live-wb-state',
  'av_finance_summary',
  'av_ozon_fin_cache_',
  'av_ozon_perf_cache_',
  'av_wb_cache_',
  'av_ai_',                 // дневные кэши ответов ИИ
];

function isQuotaError(e: unknown): boolean {
  const name = (e as { name?: string })?.name ?? '';
  return /quota|QuotaExceeded|NS_ERROR_DOM_QUOTA/i.test(name) || /quota/i.test(String(e));
}

/** Удаляет кэши, освобождая место. Возвращает, сколько ключей удалено. */
function evictCaches(): number {
  let removed = 0;
  try {
    for (const prefix of EVICTABLE_PREFIXES) {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (k && k.startsWith(prefix)) {
          localStorage.removeItem(k);
          removed++;
        }
      }
      if (removed) break;   // освободили место — дальше чистить незачем
    }
  } catch (e) {
    // Хранилище недоступно целиком (приватный режим, отключены куки). Сделать
    // ничего нельзя, но именно отсюда растут жалобы «ничего не сохраняется».
    noteSwallowed('storage', 'очистка хранилища не удалась', e, 60 * 60_000);
  }
  return removed;
}

/**
 * Записать значение. При нехватке места чистит кэши и пробует ещё раз.
 * @returns удалось ли сохранить
 */
export function safeSetItem(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value); pushUiState(key, value);
    return true;
  } catch (e) {
    if (!isQuotaError(e)) return false;   // приватный режим/запрет — чистка не поможет
    if (!evictCaches()) return false;
    try {
      localStorage.setItem(key, value); pushUiState(key, value);
      console.warn('[storage] место кончилось, кэши очищены — запись прошла со второй попытки');
      return true;
    } catch {
      return false;
    }
  }
}
