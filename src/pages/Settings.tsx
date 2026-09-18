import { useEffect, useState } from 'react';
import { CheckIcon, WarningIcon, ClockIcon, InfoIcon } from '@phosphor-icons/react';
import { WbScope, SCOPE_LABEL, getAllWbTokens, setWbToken } from '../api/wb';
import { getOzonPerfCreds, setOzonPerfCreds, ozonPerfFetch } from '../api/ozonAds';
import { getGlobalSettings, saveGlobalSettings, defaultSettings, GlobalSettings } from '../utils/procurementLogic';
import { getTgDiagnostics } from '../api/telegramApp';
import { fetchAppSettings, saveAppSettings, type AppSettings } from '../api/productEcon';
import { errText } from '../api/http';

const WB_SCOPES: WbScope[] = ['stats', 'prices', 'analytics', 'promotion', 'supplies'];

type WbTokenStatus = 'idle' | 'checking' | 'ok' | 'error';

// Статус области БЕЗ обращения к WB: браузер не пингует WB (режим cron-only).
// Смотрим, обновлял ли фоновый сборщик соответствующий namespace.
const SCOPE_NS: Record<WbScope, string> = {
  stats: 'wb:statistics', prices: 'wb:discounts', analytics: 'wb:analytics',
  promotion: 'wb:promotion', supplies: 'wb:supplies',
};
async function pingScope(scope: WbScope): Promise<{ ok: boolean; msg: string }> {
  try {
    const r = await fetch('/api/meta/status', { credentials: 'include' });
    const j = await r.json();
    const m = j?.namespaces?.[SCOPE_NS[scope]];
    if (m?.lastRefreshAt) {
      return { ok: true, msg: `сборщик обновил ${new Date(m.lastRefreshAt).toLocaleString('ru-RU')}` };
    }
    return { ok: false, msg: 'сборщик ещё не получал данные по этой области (ждём ближайший прогон)' };
  } catch {
    return { ok: false, msg: 'не удалось получить статус сборщика' };
  }
}

function WbTokensCard() {
  const [tokens, setTokens] = useState(getAllWbTokens());
  const [statuses, setStatuses] = useState<Record<WbScope, WbTokenStatus>>({
    stats: 'idle', prices: 'idle', analytics: 'idle', promotion: 'idle', supplies: 'idle',
  });
  const [msgs, setMsgs] = useState<Record<WbScope, string>>({
    stats: '', prices: '', analytics: '', promotion: '', supplies: '',
  });
  const [visible, setVisible] = useState<Record<WbScope, boolean>>({
    stats: false, prices: false, analytics: false, promotion: false, supplies: false,
  });

  const update = (scope: WbScope, val: string) => {
    setTokens(t => ({ ...t, [scope]: val }));
    setWbToken(scope, val || null);
    setStatuses(s => ({ ...s, [scope]: 'idle' }));
  };

  const checkOne = async (scope: WbScope) => {
    setStatuses(s => ({ ...s, [scope]: 'checking' }));
    const r = await pingScope(scope);
    setStatuses(s => ({ ...s, [scope]: r.ok ? 'ok' : 'error' }));
    setMsgs(m => ({ ...m, [scope]: r.msg }));
  };

  const checkAll = async () => {
    await Promise.all(WB_SCOPES.filter(s => tokens[s]).map(checkOne));
  };

  const filled = WB_SCOPES.filter(s => tokens[s]).length;

  return (
    <div className="card">
      <div className="flex-between" style={{ marginBottom: 14 }}>
        <h2>Wildberries · API-токены</h2>
        <span className={`chip ${filled === 5 ? 'good' : filled > 0 ? 'warn' : ''}`}>
          <span className="dot" /> {filled}/5 заполнено
        </span>
      </div>
      <div className="muted" style={{ fontSize: 12.5, marginBottom: 14 }}>
        Токен с нужными категориями WB API. На проде серверный <code>WB_TOKEN</code> в <code>.env</code> —
        он используется фоновым сборщиком. Поля ниже хранятся в localStorage браузера (для теста разных аккаунтов).
        Совет: заведите <b>отдельный</b> токен для платформы, чтобы не делить квоту с другими интеграциями.
      </div>

      <div className="grid" style={{ gap: 10 }}>
        {WB_SCOPES.map(scope => {
          const st = statuses[scope];
          const msg = msgs[scope];
          const tok = tokens[scope] || '';
          return (
            <div key={scope} className="grid" style={{ gridTemplateColumns: '160px 1fr auto auto', gap: 10, alignItems: 'center' }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 500 }}>{SCOPE_LABEL[scope]}</div>
                {st === 'ok' && <span className="chip good" style={{ marginTop: 2 }}><CheckIcon size={10} weight="bold" /> ок</span>}
                {st === 'error' && <span className="chip bad" style={{ marginTop: 2 }} title={msg}><WarningIcon size={10} weight="bold" /> нет данных</span>}
                {st === 'checking' && <span className="chip" style={{ marginTop: 2 }}>проверка…</span>}
              </div>
              <input
                className="input"
                type="text"
              autoComplete="off"
                value={tok}
                onChange={e => update(scope, e.target.value)}
                placeholder="eyJhbGciOi…"
                style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12, WebkitTextSecurity: visible[scope] ? 'none' : 'disc' } as any}
              />
              <button className="btn btn-sm" onClick={() => setVisible(v => ({ ...v, [scope]: !v[scope] }))}>
                {visible[scope] ? 'скрыть' : 'показать'}
              </button>
              <button className="btn btn-sm" onClick={() => checkOne(scope)} disabled={!tok || st === 'checking'}>
                проверить
              </button>
            </div>
          );
        })}
      </div>

      <div className="row gap-8" style={{ marginTop: 14, flexWrap: 'wrap' }}>
        <button className="btn btn-primary" onClick={checkAll} disabled={filled === 0}>Проверить все</button>
        <button
          className="btn"
          title="Применить первый непустой токен ко всем 5 полям. Используй, если у тебя один универсальный JWT со всеми правами."
          onClick={() => {
            const first = WB_SCOPES.map(s => tokens[s]).find(t => t && t.trim());
            if (!first) return;
            WB_SCOPES.forEach(s => setWbToken(s, first));
            setTokens(getAllWbTokens());
            setStatuses({ stats: 'idle', prices: 'idle', analytics: 'idle', promotion: 'idle', supplies: 'idle' });
          }}
          disabled={filled === 0}
        >
          Применить первый ко всем
        </button>
        <button
          className="btn"
          onClick={() => {
            WB_SCOPES.forEach(s => setWbToken(s, null));
            setTokens(getAllWbTokens());
            setStatuses({ stats: 'idle', prices: 'idle', analytics: 'idle', promotion: 'idle', supplies: 'idle' });
          }}
        >
          Очистить все
        </button>
      </div>

      {Object.values(msgs).some(m => m) && (
        <div className="muted" style={{ fontSize: 11, marginTop: 12, fontFamily: 'ui-monospace, monospace' }}>
          {WB_SCOPES.filter(s => msgs[s]).map(s => (
            <div key={s}>{SCOPE_LABEL[s]}: {msgs[s]}</div>
          ))}
        </div>
      )}
    </div>
  );
}

function OzonPerfCard() {
  const initial = getOzonPerfCreds();
  const [clientId, setClientId] = useState(initial.clientId || '');
  const [clientSecret, setClientSecret] = useState(initial.clientSecret || '');
  const [showSecret, setShowSecret] = useState(false);
  const [status, setStatus] = useState<'idle' | 'checking' | 'ok' | 'error'>('idle');
  const [msg, setMsg] = useState<string>('');

  const save = () => {
    setOzonPerfCreds(clientId.trim() || null, clientSecret.trim() || null);
    setStatus('idle');
    setMsg('сохранено');
  };

  const test = async () => {
    setOzonPerfCreds(clientId.trim() || null, clientSecret.trim() || null);
    setStatus('checking');
    setMsg('');
    try {
      const r = await ozonPerfFetch<{ list?: any[]; total?: number }>('/api/client/campaign');
      const n = (r?.list || []).length;
      setStatus('ok');
      setMsg(`OAuth ок · кампаний в ответе: ${n}`);
    } catch (e: any) {
      setStatus('error');
      setMsg(e?.message || 'ошибка');
    }
  };

  const filled = clientId.trim() && clientSecret.trim();

  return (
    <div className="card">
      <div className="flex-between" style={{ marginBottom: 14 }}>
        <h2>Ozon · Performance API (Реклама)</h2>
        <span className={`chip ${filled ? (status === 'ok' ? 'good' : status === 'error' ? 'bad' : '') : 'warn'}`}>
          <span className="dot" />
          {status === 'ok' ? 'OAuth ок' : status === 'error' ? 'ошибка' : status === 'checking' ? 'проверка…' : filled ? 'не проверен' : 'не задан'}
        </span>
      </div>
      <div className="muted" style={{ fontSize: 12.5, marginBottom: 14 }}>
        Отдельные креды от Seller API. Кабинет Ozon → Реклама → API → Создать клиента.
        Нужны только для модуля «Реклама» Ozon; остальное работает без них.
      </div>
      <div className="grid grid-2" style={{ gap: 14 }}>
        <div className="field" style={{ margin: 0 }}>
          <label className="field-label">Client-Id</label>
          <input
            className="input"
            value={clientId}
            onChange={e => setClientId(e.target.value)}
            autoComplete="off"
            placeholder="12345678-1234567890123@advertising.performance.ozon.ru"
            style={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12 }}
          />
        </div>
        <div className="field" style={{ margin: 0 }}>
          <label className="field-label">Client-Secret</label>
          <div className="row" style={{ gap: 6 }}>
            <input
              className="input"
              type="text"
            autoComplete="off"
              value={clientSecret}
              onChange={e => setClientSecret(e.target.value)}
              placeholder="••••••••••••"
              style={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12, flex: 1, WebkitTextSecurity: showSecret ? 'none' : 'disc' } as any}
            />
            <button className="btn btn-sm" onClick={() => setShowSecret(v => !v)}>{showSecret ? 'скрыть' : 'показать'}</button>
          </div>
        </div>
      </div>
      <div className="row gap-8" style={{ marginTop: 14 }}>
        <button className="btn btn-primary" onClick={save} disabled={!filled}>Сохранить</button>
        <button className="btn" onClick={test} disabled={!filled || status === 'checking'}>Проверить подключение</button>
        <button
          className="btn"
          onClick={() => { setOzonPerfCreds(null, null); setClientId(''); setClientSecret(''); setStatus('idle'); setMsg('очищено'); }}
        >
          Очистить
        </button>
      </div>
      {msg && (
        <div className="muted" style={{ fontSize: 11.5, marginTop: 10, color: status === 'error' ? 'var(--bad)' : status === 'ok' ? 'var(--good)' : 'var(--muted)', wordBreak: 'break-word' }}>
          {msg}
        </div>
      )}
    </div>
  );
}

// Реальное состояние фонового сборщика по всем источникам (из /api/meta/status).
function CollectorStatusCard() {
  const [ns, setNs] = useState<Record<string, { lastRefreshAt: number } | null> | null>(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    fetch('/api/meta/status', { credentials: 'include' })
      .then(r => r.json())
      .then(j => setNs(j?.namespaces ?? null))
      .catch(() => setErr(true));
  }, []);

  const ROWS: { key: string; label: string }[] = [
    { key: 'ozon-seller', label: 'Ozon Seller (выручка, цены, остатки)' },
    { key: 'wb:statistics', label: 'WB Статистика (заказы/выкупы/отчёт)' },
    { key: 'wb:analytics', label: 'WB Воронка (sales-funnel)' },
    { key: 'wb:content', label: 'WB Карточки' },
    { key: 'wb:discounts', label: 'WB Цены' },
    { key: 'wb:promotion', label: 'WB Реклама' },
    { key: 'wb:feedbacks', label: 'WB Отзывы' },
  ];
  const ago = (ts?: number) => {
    if (!ts) return null;
    const m = Math.floor((Date.now() - ts) / 60000);
    return m < 60 ? `${m} мин назад` : `${Math.floor(m / 60)} ч назад`;
  };

  return (
    <div className="card">
      <div className="flex-between" style={{ marginBottom: 12 }}>
        <h2 style={{ display: 'inline-flex', alignItems: 'center', gap: 8, margin: 0 }}>
          <ClockIcon size={18} weight="bold" /> Состояние сборщика данных
        </h2>
        <span className="chip">cron · каждый час</span>
      </div>
      <div className="muted" style={{ fontSize: 12.5, marginBottom: 12 }}>
        Браузер не ходит в WB/Ozon — данные тянет фоновый сборщик на сервере и кладёт в кэш.
        Здесь видно, когда каждый источник обновлялся последний раз.
      </div>
      {err && <div className="muted" style={{ fontSize: 13 }}>Не удалось получить статус сборщика.</div>}
      {!err && (
        <div className="grid" style={{ gap: 6 }}>
          {ROWS.map(r => {
            const m = ns?.[r.key];
            const when = ago(m?.lastRefreshAt);
            return (
              <div key={r.key} className="flex-between" style={{ fontSize: 13, padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
                <span>{r.label}</span>
                {when
                  ? <span className="chip good"><span className="dot" /> {when}</span>
                  : <span className="chip warn"><span className="dot" /> нет данных</span>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Реальные параметры прогноза закупок (используются в procurementLogic).
function ProcurementSettingsCard() {
  const [s, setS] = useState<GlobalSettings>(getGlobalSettings());
  const [saved, setSaved] = useState(false);
  const upd = (k: keyof GlobalSettings, v: number) => { setS(p => ({ ...p, [k]: v })); setSaved(false); };
  const save = () => { saveGlobalSettings(s); setSaved(true); };

  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>Параметры прогноза закупок</h2>
      <div className="muted" style={{ fontSize: 12.5, marginBottom: 14 }}>
        Используются в модуле «Прогноз закупок» и «Распределение» для расчёта «на сколько хватит»,
        даты «заказать до» и рекомендованного объёма закупки. Хранятся в браузере.
      </div>
      <div className="grid grid-3" style={{ gap: 14 }}>
        <div className="field" style={{ margin: 0 }}>
          <label className="field-label">Срок поставки (lead time), дней</label>
          <input className="input" type="number" value={s.leadTime} onChange={e => upd('leadTime', +e.target.value)} />
        </div>
        <div className="field" style={{ margin: 0 }}>
          <label className="field-label">Упаковка/подготовка, дней</label>
          <input className="input" type="number" value={s.packaging} onChange={e => upd('packaging', +e.target.value)} />
        </div>
        <div className="field" style={{ margin: 0 }}>
          <label className="field-label">Целевой запас (покрытие), дней</label>
          <input className="input" type="number" value={s.targetDays} onChange={e => upd('targetDays', +e.target.value)} />
        </div>
      </div>
      <div className="row gap-8" style={{ marginTop: 14, alignItems: 'center' }}>
        <button className="btn btn-primary" onClick={save}>Сохранить</button>
        <button className="btn" onClick={() => { setS(defaultSettings); saveGlobalSettings(defaultSettings); setSaved(true); }}>Сбросить</button>
        {saved && <span className="chip good"><CheckIcon size={11} weight="bold" /> сохранено</span>}
      </div>
    </div>
  );
}

// Диагностика Telegram Mini App. Нужна потому, что полноэкранный режим может
// тихо не включиться (старый клиент, десктоп, отказ устройства), а на телефоне
// консоль недоступна — иначе причину не узнать.
function TelegramAppCard() {
  const [d, setD] = useState(getTgDiagnostics());
  useEffect(() => {
    const t = setInterval(() => setD(getTgDiagnostics()), 1000);
    return () => clearInterval(t);
  }, []);
  if (!d.inTelegram) return null;
  return (
    <div className="card">
      <div className="flex-between" style={{ marginBottom: 10 }}>
        <h2 style={{ margin: 0 }}>Telegram мини-приложение</h2>
        <span className={`chip ${d.isFullscreen ? 'good' : 'warn'}`}>
          {d.isFullscreen ? 'полный экран' : 'обычный режим'}
        </span>
      </div>
      <div className="muted" style={{ fontSize: 12.5, lineHeight: 1.7 }}>
        Платформа: <b>{d.platform ?? '—'}</b> · версия Bot API: <b>{d.version ?? '—'}</b><br />
        Полный экран поддерживается: <b>{d.fullscreenSupported ? 'да' : 'нет'}</b>
        {d.error && (
          <><br /><span style={{ color: 'var(--bad)' }}>Причина отказа: {d.error}</span></>
        )}
        {!d.isFullscreen && !d.error && d.fullscreenSupported && (
          <><br />Запрос отправлен, ответ от Telegram ещё не пришёл.</>
        )}
      </div>
    </div>
  );
}


/**
 * Схема работы со складом — она задаёт, какие ставки комиссии и логистики
 * подставлять в расчёт прибыли. У FBO и FBS они разные, и показать чужие значит
 * ошибиться в прибыли по всему каталогу.
 *
 * Клиент перешёл на FBS 29.08 и попросил оставить возможность вернуть FBO —
 * поэтому это настройка, а не константа в коде.
 */
function FulfilmentCard() {
  const [st, setSt] = useState<AppSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => { fetchAppSettings().then(setSt).catch(e => setError(errText(e))); }, []);

  const pick = async (patch: Partial<AppSettings>) => {
    setSaving(true); setError(null); setSaved(false);
    try {
      const next = await saveAppSettings(patch);
      setSt(next);
      setSaved(true);
    } catch (e) { setError(errText(e)); }
    finally { setSaving(false); }
  };

  const row = (label: string, key: 'wbFulfilment' | 'ozonFulfilment') => (
    <div className="row gap-8" style={{ alignItems: 'center' }}>
      <span style={{ minWidth: 120, fontSize: 13 }}>{label}</span>
      {(['fbs', 'fbo'] as const).map(v => (
        <button
          key={v}
          className={`mp-tab ${st?.[key] === v ? 'active' : ''}`}
          disabled={saving || !st}
          onClick={() => void pick({ [key]: v })}
        >
          {v.toUpperCase()}
        </button>
      ))}
    </div>
  );

  return (
    <div className="card">
      <div className="flex-between" style={{ marginBottom: 10 }}>
        <h2 style={{ margin: 0 }}>Схема работы</h2>
        {saved && <span className="chip good">сохранено</span>}
      </div>
      <div className="muted" style={{ fontSize: 12.5, lineHeight: 1.6, marginBottom: 12 }}>
        От неё зависят комиссия и логистика в расчёте прибыли: у продажи со склада площадки (FBO)
        и со своего склада (FBS) ставки разные. Переключение применяется сразу — таблицы цен
        пересчитаются на новых ставках.
      </div>
      <div className="grid" style={{ gap: 8 }}>
        {row('Wildberries', 'wbFulfilment')}
        {row('Ozon', 'ozonFulfilment')}
      </div>
      {error && (
        <div className="row gap-8" style={{ marginTop: 10, fontSize: 12.5, color: 'var(--bad)' }}>
          <WarningIcon size={13} weight="bold" /> {error}
        </div>
      )}
    </div>
  );
}

export function Settings() {
  return (
    <div className="grid" style={{ gap: 20 }}>
      <TelegramAppCard />
      <WbTokensCard />
      <OzonPerfCard />
      <CollectorStatusCard />
      <ProcurementSettingsCard />
      <FulfilmentCard />

      <div className="card">
        <div className="flex-between" style={{ marginBottom: 10 }}>
          <h2 style={{ margin: 0 }}>Серверные ключи (в <code>.env</code> на сервере)</h2>
          <span className="chip"><InfoIcon size={11} weight="bold" /> не в браузере</span>
        </div>
        <div className="muted" style={{ fontSize: 12.5, lineHeight: 1.6 }}>
          Эти ключи задаются на сервере (<code>/opt/autovibe/.env</code>), не из браузера — так безопаснее:
          <ul style={{ margin: '8px 0 0', paddingLeft: 18, lineHeight: 1.8 }}>
            <li><code>WB_TOKEN</code> — рабочий токен WB для фонового сборщика</li>
            <li><code>OZON_CLIENT_ID</code> / <code>OZON_API_KEY</code> — Ozon Seller API</li>
            <li><code>ANTHROPIC_API_KEY</code> — ключ Claude (через релей)</li>
            <li><code>TELEGRAM_BOT_TOKEN</code> / chat_id — для Telegram-бота (в работе)</li>
            <li><code>AI_DAILY_LIMIT_RUB</code> — дневной лимит трат на ИИ</li>
          </ul>
          После изменения <code>.env</code> — перезапуск сервиса: <code>systemctl restart autovibe</code>.
        </div>
      </div>
    </div>
  );
}
