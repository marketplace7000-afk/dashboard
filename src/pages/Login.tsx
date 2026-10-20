import { useEffect, useState } from 'react';
import { WarningIcon, SpinnerIcon } from '@phosphor-icons/react';

// Коды ошибок сервера → понятный текст. Неизвестный код не показываем как есть.
const LOGIN_ERRORS: Record<string, string> = {
  too_many_attempts: 'Слишком много попыток входа. Подождите 15 минут и попробуйте снова.',
  auth_not_configured: 'Вход не настроен на сервере. Сообщите администратору.',
};

const SERVER_DOWN = 'Сервер не отвечает. Проверьте интернет и попробуйте через минуту.';

export function Login({ onLogin }: { onLogin: () => void }) {
  const [pwd, setPwd] = useState('');
  // Логин — личная учётка (сотрудники складов, менеджеры). Пусто = общий пароль владельца.
  const [login, setLogin] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authEnabled, setAuthEnabled] = useState<boolean | null>(null);

  // На mount проверяем — может быть уже залогинены, или auth выключен на бэке
  useEffect(() => {
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
        // бэка нет (запущен vite dev без сервера). Пускаем без пароля ТОЛЬКО в
        // разработке: на проде HTML вместо JSON — это 502 от nginx, и раньше
        // кабинет открывался пустым, будто «всё сломалось» (прожарка 20.10).
        const ct = r.headers.get('content-type') || '';
        if (!ct.includes('application/json')) {
          if (import.meta.env.DEV) { setAuthEnabled(false); onLogin(); return; }
          setAuthEnabled(true);
          setError(SERVER_DOWN);
          return;
        }
        const j = await r.json().catch(() => ({}));
        if (r.ok && j?.ok) {
          // либо auth выключен, либо уже в сессии — оба случая = пускаем
          onLogin();
          setAuthEnabled(j.authEnabled ?? true);
        } else {
          setAuthEnabled(true);
        }
      })
      .catch(() => {
        // Сетевая ошибка: в разработке — бэка нет, пускаем; на проде — сервер недоступен.
        if (import.meta.env.DEV) { setAuthEnabled(false); onLogin(); return; }
        setAuthEnabled(true);
        setError(SERVER_DOWN);
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
        body: JSON.stringify(login.trim() ? { login: login.trim(), password: pwd } : { password: pwd }),
      });
      if (r.ok) {
        onLogin();
        return;
      }
      const j = await r.json().catch(() => ({}));
      if (r.status === 401) setError(login.trim() ? 'Неверный логин или пароль' : 'Неверный пароль');
      else if (j?.error && LOGIN_ERRORS[j.error]) setError(LOGIN_ERRORS[j.error]);
      else if (r.status === 503) setError(LOGIN_ERRORS.auth_not_configured);
      else if (r.status >= 500) setError(SERVER_DOWN);
      else setError(`Не удалось войти (код ${r.status}). Попробуйте ещё раз.`);
    } catch {
      setError(SERVER_DOWN);
    } finally {
      setLoading(false);
    }
  };

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
        <div className="brand" style={{ padding: 0, marginBottom: 18, fontSize: 24.5 }}>
          <span>Avto Vibe</span>
        </div>
        <h2>Вход в кабинет</h2>
        <p>Сотрудникам — логин и пароль, которые выдал владелец. Владельцу — только пароль кабинета.</p>

        <div className="field">
          <label className="field-label">Логин</label>
          <input
            className="input"
            value={login}
            onChange={(e) => setLogin(e.target.value)}
            placeholder="пусто — вход владельца"
            disabled={loading}
            autoComplete="username"
            autoCapitalize="none"
          />
        </div>

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
            padding: '8px 12px', borderRadius: 8, fontSize: 15.5, marginBottom: 12,
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

        <div style={{ marginTop: 14, fontSize: 15.5, color: 'var(--muted)', textAlign: 'center' }}>
          Кабинет продавца: <b style={{ color: 'var(--text)' }}>ИП Алешко</b> · WB&nbsp;+&nbsp;Ozon
        </div>
      </form>
    </div>
  );
}
