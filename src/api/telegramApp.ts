/**
 * Инициализация Telegram Mini App.
 *
 * Полноэкранный режим (requestFullscreen) появился в Bot API 8.0 и может тихо не
 * сработать: старый клиент, десктоп, неподдерживаемое устройство. Метод ничего не
 * возвращает — об отказе Telegram сообщает СОБЫТИЕМ fullscreenFailed. Поэтому
 * слушаем события и складываем результат в диагностику, которую видно в разделе
 * «Настройки»: иначе на телефоне непонятно, почему окно не развернулось.
 */
import { noteSwallowed } from '../utils/log';

type TgDiag = {
  inTelegram: boolean;
  version: string | null;
  platform: string | null;
  fullscreenSupported: boolean;
  isFullscreen: boolean;
  error: string | null;
};

const diag: TgDiag = {
  inTelegram: false,
  version: null,
  platform: null,
  fullscreenSupported: false,
  isFullscreen: false,
  error: null,
};

/** Текущее состояние — для отображения в интерфейсе. */
export function getTgDiagnostics(): TgDiag {
  return { ...diag };
}

function wa(): any | null {
  try { return (window as any)?.Telegram?.WebApp ?? null; } catch { return null; }
}

/**
 * Проставляет отступ сверху под системную строку и панель Telegram.
 *
 * CSS-переменные --tg-safe-area-inset-* Telegram отдаёт не во всех версиях, и в
 * полноэкранном режиме шапка уезжала под кнопки «Закрыть» и «…». Поэтому читаем
 * значения из JS-объекта и выставляем свою переменную сами. Если клиент не отдал
 * ничего, а полный экран включён, берём запасное значение — лучше лишний отступ,
 * чем заголовок под кнопками Telegram.
 */
const FALLBACK_TOP = 96;   // примерная высота статус-бара плюс панели Telegram
const EXTRA_GAP = 20;      // визуальный зазор, чтобы шапка не липла к кнопкам

function applyInsets(app: any): void {
  try {
    const safe = app.safeAreaInset ?? {};
    const content = app.contentSafeAreaInset ?? {};
    let top = (Number(safe.top) || 0) + (Number(content.top) || 0);
    if (!top && app.isFullscreen) top = FALLBACK_TOP;
    if (top) top += EXTRA_GAP;
    document.documentElement.style.setProperty('--av-tg-top', `${top}px`);
    document.documentElement.style.setProperty('--av-tg-bottom', `${Number(safe.bottom) || 0}px`);
  } catch (e) {
    // Без отступов приложение работает, но шапка залезает под системную панель.
    noteSwallowed('tg-app', 'безопасные отступы не применены', e, 60 * 60_000);
  }
}

let inited = false;

/** Разворачивает приложение и включает полноэкранный режим. Безопасно вне Telegram. */
export function initTelegramApp(): void {
  if (inited) return;
  const app = wa();
  if (!app) return;
  inited = true;

  diag.inTelegram = true;
  diag.version = app.version ?? null;
  diag.platform = app.platform ?? null;
  diag.fullscreenSupported = typeof app.requestFullscreen === 'function';

  try { app.ready?.(); } catch (e) { noteSwallowed('tg-app', 'ready не отработал', e, 60 * 60_000); }
  try { app.expand?.(); } catch (e) { noteSwallowed('tg-app', 'expand не отработал', e, 60 * 60_000); }
  // Свайп вниз закрывает окно и мешает прокручивать таблицы.
  // Метод новый, на старых клиентах его нет — это ожидаемо, поэтому пишем редко.
  try { app.disableVerticalSwipes?.(); }
  catch (e) { noteSwallowed('tg-app', 'свайпы не отключены', e, 60 * 60_000); }

  applyInsets(app);

  // События приходят асинхронно: и успех, и отказ.
  try {
    app.onEvent?.('fullscreenChanged', () => {
      diag.isFullscreen = !!app.isFullscreen;
      diag.error = null;
      applyInsets(app);            // в полном экране отступы другие
    });
    app.onEvent?.('fullscreenFailed', (e: any) => {
      const reason = e?.error ?? 'UNKNOWN';
      // ALREADY_FULLSCREEN — не ошибка, режим уже включён.
      diag.error = reason === 'ALREADY_FULLSCREEN' ? null : String(reason);
      diag.isFullscreen = reason === 'ALREADY_FULLSCREEN';
      applyInsets(app);
    });
    // Telegram пересчитывает безопасные зоны при повороте и смене режима.
    app.onEvent?.('safeAreaChanged', () => applyInsets(app));
    app.onEvent?.('contentSafeAreaChanged', () => applyInsets(app));
    app.onEvent?.('viewportChanged', () => applyInsets(app));
  } catch (e) {
    // Старый клиент без onEvent: отступы не будут пересчитываться при повороте.
    noteSwallowed('tg-app', 'подписка на события Telegram не удалась', e, 60 * 60_000);
  }

  if (!diag.fullscreenSupported) {
    diag.error = `клиент не поддерживает полный экран (Bot API ${app.version ?? '<8.0'})`;
    return;
  }

  // Просим полный экран ПОСЛЕ ready(): часть клиентов игнорирует вызов, если
  // приложение ещё не сообщило о готовности.
  setTimeout(() => {
    try {
      app.requestFullscreen();
      // Состояние обновится событием; на случай, если событие не придёт, читаем поле.
      setTimeout(() => {
        diag.isFullscreen = !!app.isFullscreen;
        applyInsets(app);
      }, 400);
    } catch (e) {
      diag.error = (e as Error)?.message ?? 'вызов не удался';
    }
  }, 120);
}
