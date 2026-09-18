import { useEffect, useState } from 'react';
import { CheckCircleIcon, WarningIcon, SpinnerIcon, PaperPlaneTiltIcon } from '@phosphor-icons/react';
import { tgConfigured, tgGetMe, tgSendMessage, TgBotInfo } from '../api/telegram';

type State =
  | { kind: 'no-token' }
  | { kind: 'loading' }
  | { kind: 'ok'; info: TgBotInfo }
  | { kind: 'err'; message: string };

export function TelegramLiveStatus() {
  const [state, setState] = useState<State>(() => tgConfigured() ? { kind: 'loading' } : { kind: 'no-token' });
  const [sending, setSending] = useState(false);
  const [sendResult, setSendResult] = useState<string | null>(null);

  useEffect(() => {
    if (!tgConfigured()) return;
    tgGetMe()
      .then((info) => setState({ kind: 'ok', info }))
      .catch((e) => setState({ kind: 'err', message: String(e?.message ?? e) }));
  }, []);

  const sendTest = async () => {
    setSending(true);
    setSendResult(null);
    try {
      await tgSendMessage(
        '🚀 *Avto Vibe* — тестовое сообщение от бота\\.\n\n' +
        'Соединение работает\\. Когда модули заработают, сюда будут приходить:\n' +
        '— алерты на негативные отзывы\n' +
        '— рекомендации по ценам\n' +
        '— дневной и недельный отчёты',
        { parse_mode: 'MarkdownV2' },
      );
      setSendResult('Отправлено в чат');
    } catch (e: any) {
      setSendResult('Ошибка: ' + (e?.message ?? e));
    } finally {
      setSending(false);
    }
  };

  if (state.kind === 'no-token') {
    return (
      <div className="card" style={{ background: 'rgba(217,119,6,.06)' }}>
        <div className="flex-between" style={{ marginBottom: 10 }}>
          <h2 style={{ margin: 0, display: 'inline-flex', alignItems: 'center', gap: 10 }}>
            <PaperPlaneTiltIcon size={18} weight="bold" />
            Telegram Bot · ждём токен
          </h2>
          <span className="chip warn"><span className="dot" /> не подключено</span>
        </div>
        <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.6 }}>
          Скелет интеграции готов. Чтобы подключить — создаём бота через <b>@BotFather</b>,
          вставляем токен в <code>.env</code>:
        </div>
        <pre style={{ background: 'var(--bg-2)', padding: 12, borderRadius: 8, fontSize: 12, margin: '10px 0', overflow: 'auto' }}>
{`VITE_TELEGRAM_BOT_TOKEN=123456789:AAH...
VITE_TELEGRAM_CHAT_ID=-1001234567890`}
        </pre>
        <div className="muted" style={{ fontSize: 12 }}>
          После — перезапуск <code>npm run dev</code>, и здесь появятся: статус бота, кнопка
          тестового сообщения, последние входящие команды.
        </div>
      </div>
    );
  }

  if (state.kind === 'loading') {
    return (
      <div className="card" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <SpinnerIcon size={18} weight="bold" className="spin" />
        <span className="muted">Проверка бота через getMe…</span>
      </div>
    );
  }

  if (state.kind === 'err') {
    return (
      <div className="card" style={{ background: 'rgba(220,38,38,.06)' }}>
        <div className="flex-between" style={{ marginBottom: 10 }}>
          <h2 style={{ margin: 0, display: 'inline-flex', alignItems: 'center', gap: 10 }}>
            <WarningIcon size={18} weight="bold" style={{ color: 'var(--bad)' }} />
            Telegram Bot · ошибка
          </h2>
        </div>
        <div className="muted" style={{ fontSize: 12.5 }}>{state.message}</div>
      </div>
    );
  }

  const info = state.info;
  return (
    <div className="card" style={{ background: 'rgba(22,163,74,.06)' }}>
      <div className="flex-between" style={{ marginBottom: 14 }}>
        <h2 style={{ margin: 0, display: 'inline-flex', alignItems: 'center', gap: 10 }}>
          <CheckCircleIcon size={18} weight="fill" style={{ color: 'var(--good)' }} />
          Telegram Bot · подключён
        </h2>
        <span className="chip good"><span className="dot" /> live</span>
      </div>
      <div className="grid grid-3" style={{ gap: 14 }}>
        <div>
          <div className="card-title">Username</div>
          <div style={{ fontWeight: 600 }}>@{info.username}</div>
        </div>
        <div>
          <div className="card-title">Имя</div>
          <div style={{ fontWeight: 600 }}>{info.first_name}</div>
        </div>
        <div>
          <div className="card-title">ID бота</div>
          <div style={{ fontWeight: 600 }}>{info.id}</div>
        </div>
        <div>
          <div className="card-title">Группы</div>
          <div>{info.can_join_groups ? 'может вступать' : '—'}</div>
        </div>
        <div>
          <div className="card-title">Чтение группы</div>
          <div>{info.can_read_all_group_messages ? 'все сообщения' : 'только упоминания'}</div>
        </div>
        <div>
          <div className="card-title">Inline-запросы</div>
          <div>{info.supports_inline_queries ? 'поддерживает' : 'нет'}</div>
        </div>
      </div>
      <hr className="sep" />
      <div className="row gap-12">
        <button className="btn btn-primary btn-sm" onClick={sendTest} disabled={sending}>
          {sending
            ? <><SpinnerIcon size={13} weight="bold" className="spin" /> Отправляем…</>
            : <><PaperPlaneTiltIcon size={13} weight="bold" /> Отправить тестовое сообщение</>}
        </button>
        {sendResult && <span className="muted" style={{ fontSize: 12 }}>{sendResult}</span>}
      </div>
    </div>
  );
}
