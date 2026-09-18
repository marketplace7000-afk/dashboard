import { useEffect, useState } from 'react';
import { WarningIcon, SpinnerIcon } from '@phosphor-icons/react';
import { initTelegramApp } from '../api/telegramApp';

export function Login({ onLogin }: { onLogin: () => void }) {
  const [pwd, setPwd] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authEnabled, setAuthEnabled] = useState<boolean | null>(null);
  // Внутри Telegram Mini App показываем не форму пароля, а статус авто-входа.
  const [tgState, setTgState] = useState<'idle' | 'checking' | 'denied'>('idle');
  // Запасной вход по паролю внутри Telegram: если авто-вход по TG-ID не прошёл
  // (бот выключен, ID не в списке), человек не должен оставаться запертым.
  const [forcePwd, setForcePwd] = useState(false);

  // Открыто внутри Telegram? SDK кладёт window.Telegram.WebApp.initData (подпись бота).
  const tgInitData = (() => {
    try { return (window as any)?.Telegram?.WebApp?.initData as string | undefined; }
    catch { return undefined; }
  })();

  // Вход по проверенному Telegram-ID. Бэк сам сверит подпись и белый список.
  const loginViaTelegram = async (initData: string) => {
    setTgState('checking');
    setError(null);
    try {
      const r = await fetch('/api/auth/tg', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ initData }),
      });
      if (r.ok) { onLogin(); return; }
      const j = await r.json().catch(() => ({}));
      if (r.status === 403) {
        setError(`Ваш Telegram${j?.tgId ? ` (ID ${j.tgId})` : ''} не в списке доступа. Обратитесь к администратору.`);
      } else if (r.status === 401) {
        setError('Не удалось подтвердить вход из Telegram. Откройте мини-приложение заново.');
      } else if (r.status === 503) {
        setError('Вход через Telegram не настроен на сервере.');
      } else {
        setError(j?.error || `Ошибка ${r.status}`);
      }
      setTgState('denied');
    } catch (e: any) {
      setError(e?.message || 'Сетевая ошибка');
      setTgState('denied');
    }
  };

  // На mount проверяем — может быть уже залогинены, или auth выключен на бэке
  useEffect(() => {
    // Telegram Mini App: разворачиваем на весь экран и пробуем авто-вход по TG-ID.
    if (tgInitData) {
      initTelegramApp();
      loginViaTelegram(tgInitData);
      return;
    }
    fetch('/api/auth/check', { credentials: 'include' })
      .then(async r => {
        // ПОРЯДОК ВАЖЕН. 401 разбираем ПЕРВЫМ, до любых догадок о теле ответа.
        // Раньше сначала смотрели content-type, и на проде это ломало вход:
        // nginx отдаёт на 401 SPA-заглушку index.html, то есть не JSON, —
        // приложение решало «бэкенда нет, пускаем без пароля», показывало
        // интерфейс без сессии, и дальше КАЖДЫЙ запрос получал 401. Выглядело
        // это как «данные пропали» (11.08), хотя данные были на месте.
        if (r.status === 401) {
          setAuthEnabled(true);
          return;
        }
        // Vite-dev возвращает HTML index.html на любой /api/* — это значит
        // бэка нет (запущен vite dev, а не vercel dev). Пропускаем без пароля.
        const ct = r.headers.get('content-type') || '';
        if (!ct.includes('application/json')) {
          setAuthEnabled(false);
          onLogin();
          return;
        }
        const j = await r.json().catch(() => ({}));
        if (r.ok && j?.ok) {
          // либо auth выключен, либо уже в сессии — оба случая = пускаем
          onLogin();
          setAuthEnabled(j.authEnabled ?? true);
        } else if (r.status === 401) {
          // бэк есть, auth включен, но сессии нет — показываем форму
          setAuthEnabled(true);
        } else {
          setAuthEnabled(true);
        }
      })
      .catch(() => {
        // Сетевая ошибка — бэка нет, локалка. Пускаем.
        setAuthEnabled(false);
        onLogin();
      });
  /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, []);

  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!pwd) return;
    setLoading(true);
    setError(null);
    try {
      const r = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ password: pwd }),
      });
      if (r.ok) {
        onLogin();
        return;
      }
      const j = await r.json().catch(() => ({}));
      if (r.status === 503) setError('Авторизация не настроена на сервере (нет AUTH_PASSWORD в env)');
      else if (r.status === 401) setError('Неверный пароль');
      else setError(j?.error || `Ошибка ${r.status}`);
    } catch (e: any) {
      setError(e?.message || 'Сетевая ошибка');
    } finally {
      setLoading(false);
    }
  };

  // Telegram Mini App: вместо формы пароля — статус авто-входа по TG-ID.
  if (tgInitData && !forcePwd) {
    return (
      <div className="login-wrap">
        <div className="login-card" style={{ textAlign: 'center', padding: 40 }}>
          <div className="brand" style={{ padding: 0, marginBottom: 18, fontSize: 22, justifyContent: 'center' }}>
            <span>Avto Vibe</span>
          </div>
          {tgState !== 'denied' ? (
            <>
              <SpinnerIcon size={28} weight="bold" className="spin" style={{ color: 'var(--accent)' }} />
              <p style={{ marginTop: 14, color: 'var(--muted)', fontSize: 13 }}>Проверяем доступ по Telegram…</p>
            </>
          ) : (
            <>
              {error && (
                <div style={{
                  background: 'rgba(220,38,38,.08)', color: 'var(--bad)',
                  padding: '10px 12px', borderRadius: 8, fontSize: 12.5, marginBottom: 14,
                  display: 'flex', gap: 8, alignItems: 'center', textAlign: 'left',
                }}>
                  <WarningIcon size={14} weight="bold" /> {error}
                </div>
              )}
              <button
                className="btn btn-primary"
                style={{ width: '100%', justifyContent: 'center' }}
                onClick={() => loginViaTelegram(tgInitData)}
              >
                Повторить вход
              </button>
              <button
                type="button"
                className="btn"
                style={{ width: '100%', justifyContent: 'center', marginTop: 8 }}
                onClick={() => { setError(null); setAuthEnabled(true); setForcePwd(true); }}
              >
                Войти по паролю
              </button>
            </>
          )}
        </div>
      </div>
    );
  }

  if (authEnabled === null) {
    return (
      <div className="login-wrap">
        <div className="login-card" style={{ textAlign: 'center', padding: 48 }}>
          <SpinnerIcon size={28} weight="bold" className="spin" style={{ color: 'var(--accent)' }} />
        </div>
      </div>
    );
  }

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <div className="brand" style={{ padding: 0, marginBottom: 18, fontSize: 22 }}>
          <span>Avto Vibe</span>
        </div>
        <h2>Вход в кабинет</h2>
        <p>Введи пароль кабинета продавца.</p>

        <div className="field">
          <label className="field-label">Пароль</label>
          <input
            className="input"
            type="password"
            value={pwd}
            onChange={(e) => setPwd(e.target.value)}
            autoFocus
            disabled={loading}
            autoComplete="current-password"
          />
        </div>

        {error && (
          <div style={{
            background: 'rgba(220,38,38,.08)', color: 'var(--bad)',
            padding: '8px 12px', borderRadius: 8, fontSize: 12.5, marginBottom: 12,
            display: 'flex', gap: 8, alignItems: 'center',
          }}>
            <WarningIcon size={14} weight="bold" /> {error}
          </div>
        )}

        <button
          className="btn btn-primary"
          style={{ width: '100%', justifyContent: 'center' }}
          type="submit"
          disabled={loading || !pwd}
        >
          {loading ? <SpinnerIcon size={14} weight="bold" className="spin" /> : null}
          {loading ? 'Проверка…' : 'Войти'}
        </button>

        <div style={{ marginTop: 14, fontSize: 12, color: 'var(--muted)', textAlign: 'center' }}>
          Кабинет продавца: <b style={{ color: 'var(--text)' }}>ИП Алешко</b> · WB&nbsp;+&nbsp;Ozon
        </div>
      </form>
    </div>
  );
}
