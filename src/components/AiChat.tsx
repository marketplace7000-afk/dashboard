import { useEffect, useRef, useState } from 'react';
import {
  SparkleIcon, PaperPlaneRightIcon, XIcon, TrashIcon, SpinnerIcon, ChatCircleDotsIcon,
} from '@phosphor-icons/react';
import { ChatMessage, loadHistory, saveHistory, clearHistory, newMessage, sendChat } from '../api/aiChat';

type Props = {
  /** Имя текущей страницы (Дашборд, Цены и т.д.) — попадёт в контекст Claude. */
  currentPage?: string;
};

// Лёгкий безопасный рендер markdown из ответа Claude: **жирный** и `код` → React-узлы
// (без dangerouslySetInnerHTML). Переносы строк сохраняет white-space: pre-wrap контейнера.
function renderMarkdown(text: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  const re = /\*\*([^*]+)\*\*|`([^`]+)`/g;
  let last = 0, m: RegExpExecArray | null, key = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    if (m[1] != null) parts.push(<strong key={key++}>{m[1]}</strong>);
    else if (m[2] != null) parts.push(
      <code key={key++} style={{ background: 'rgba(0,0,0,.06)', padding: '1px 4px', borderRadius: 4, fontSize: 12 }}>{m[2]}</code>
    );
    last = re.lastIndex;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

const SUGGESTIONS = [
  'Какие товары приносят больше всего за неделю?',
  'Что не так с моими карточками?',
  'Где я теряю деньги на рекламе?',
  'На какие отзывы срочно ответить?',
  'Сравни мои продажи WB и Ozon',
];

export function AiChatBubble({ currentPage }: Props) {
  const [open, setOpen] = useState(false);
  const [history, setHistory] = useState<ChatMessage[]>(() => loadHistory());
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { saveHistory(history); }, [history]);
  // Прокрутка в самый низ: при новых сообщениях, «Думаю…» И при ОТКРЫТИИ чата.
  // Раньше не было `open` в зависимостях — список монтируется только при открытии,
  // и эффект не срабатывал → чат показывался с верха, приходилось листать (баг 22.07).
  // rAF — на случай, когда раскладка ещё не готова в момент коммита.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    const id = requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
    return () => cancelAnimationFrame(id);
  }, [history, sending, open]);
  useEffect(() => {
    if (open && inputRef.current) inputRef.current.focus();
  }, [open]);

  const submit = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    setError(null);
    const userMsg = newMessage('user', trimmed);
    const nextHistory = [...history, userMsg];
    setHistory(nextHistory);
    setDraft('');
    setSending(true);
    try {
      const r = await sendChat(nextHistory, currentPage);
      if (!r.ok || !r.reply) {
        setError(r.error || 'AI не ответил');
        setHistory(h => [...h, newMessage('assistant', `⚠ Ошибка: ${r.error || 'AI не ответил'}`)]);
      } else {
        setHistory(h => [...h, newMessage('assistant', r.reply!)]);
      }
    } catch (e: any) {
      setError(e?.message || 'Сеть');
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit(draft);
    }
  };

  const onClear = () => {
    if (!confirm('Очистить историю диалога?')) return;
    clearHistory();
    setHistory([]);
    setError(null);
  };

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        title="AI-копилот"
        style={{
          position: 'fixed', right: 24, bottom: 24,
          width: 56, height: 56, borderRadius: 28,
          background: 'linear-gradient(135deg, #6366f1, #8b5cf6)',
          color: '#fff', border: 'none', cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          boxShadow: '0 8px 24px rgba(99,102,241,.4)',
          zIndex: 9999,
        }}
      >
        <SparkleIcon size={26} weight="fill" />
        {history.length > 0 && (
          <span style={{
            position: 'absolute', top: 6, right: 6,
            background: '#fff', color: '#6366f1',
            fontSize: 10, fontWeight: 700,
            borderRadius: 10, padding: '1px 6px',
          }}>{Math.min(history.length, 99)}</span>
        )}
      </button>
    );
  }

  return (
    <div style={{
      position: 'fixed', right: 24, bottom: 24,
      width: 'min(440px, calc(100vw - 48px))',
      height: 'min(640px, calc(100vh - 48px))',
      display: 'flex', flexDirection: 'column',
      background: 'var(--bg)', border: '1px solid var(--border)',
      borderRadius: 16, boxShadow: '0 16px 48px rgba(0,0,0,.18)',
      zIndex: 9999, overflow: 'hidden',
    }}>
      {/* Шапка */}
      <div style={{
        padding: '12px 14px',
        background: 'linear-gradient(135deg, #6366f1, #8b5cf6)',
        color: '#fff',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        flexShrink: 0,
      }}>
        <div className="row gap-8">
          <SparkleIcon size={18} weight="fill" />
          <div>
            <div style={{ fontWeight: 600, fontSize: 14 }}>AI-копилот</div>
            <div style={{ fontSize: 11, opacity: 0.85 }}>Claude знает твои продажи, отзывы и рекламу</div>
          </div>
        </div>
        <div className="row gap-8">
          <button
            onClick={onClear}
            title="Очистить историю"
            style={{ background: 'transparent', border: 'none', color: '#fff', cursor: 'pointer', padding: 4 }}
          >
            <TrashIcon size={16} weight="bold" />
          </button>
          <button
            onClick={() => setOpen(false)}
            title="Закрыть"
            style={{ background: 'transparent', border: 'none', color: '#fff', cursor: 'pointer', padding: 4 }}
          >
            <XIcon size={18} weight="bold" />
          </button>
        </div>
      </div>

      {/* Список сообщений */}
      <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', padding: '16px 14px' }}>
        {history.length === 0 && (
          <div style={{ textAlign: 'center', padding: '20px 8px' }}>
            <ChatCircleDotsIcon size={36} weight="duotone" style={{ color: 'var(--muted)', opacity: 0.6 }} />
            <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 8, lineHeight: 1.55 }}>
              Спроси о продажах, отзывах, ценах, конкурентах или о любом твоём товаре.
              <br />
              Контекст обновляется раз в 30 минут из кэша WB/Ozon.
            </div>
            <div style={{ marginTop: 16, display: 'grid', gap: 6 }}>
              {SUGGESTIONS.map((s, i) => (
                <button
                  key={i}
                  onClick={() => submit(s)}
                  style={{
                    background: 'var(--accent-soft)', border: '1px solid var(--border)',
                    color: 'var(--accent-2)', padding: '8px 12px', borderRadius: 10,
                    fontSize: 12.5, textAlign: 'left', cursor: 'pointer', lineHeight: 1.4,
                  }}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {history.map(m => (
          <div key={m.id} style={{
            marginBottom: 12,
            display: 'flex',
            justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start',
          }}>
            <div style={{
              maxWidth: '85%',
              padding: '9px 12px',
              borderRadius: 12,
              background: m.role === 'user' ? 'var(--accent)' : 'var(--bg-2)',
              color: m.role === 'user' ? '#fff' : 'var(--text)',
              fontSize: 13, lineHeight: 1.5,
              whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            }}>
              {m.role === 'assistant' ? renderMarkdown(m.content) : m.content}
            </div>
          </div>
        ))}

        {sending && (
          <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
            <div style={{
              padding: '9px 12px', borderRadius: 12, background: 'var(--bg-2)',
              fontSize: 13, color: 'var(--muted)',
              display: 'inline-flex', alignItems: 'center', gap: 6,
            }}>
              <SpinnerIcon size={14} className="spin" /> Думаю…
            </div>
          </div>
        )}
      </div>

      {error && (
        <div style={{
          fontSize: 12, color: 'var(--bad)', padding: '6px 14px',
          background: 'rgba(220,38,38,.06)', borderTop: '1px solid var(--border)',
        }}>
          {error}
        </div>
      )}

      {/* Ввод */}
      <div style={{
        borderTop: '1px solid var(--border)', padding: 10, flexShrink: 0,
        display: 'flex', gap: 8, alignItems: 'flex-end',
      }}>
        <textarea
          ref={inputRef}
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={currentPage ? `Спроси про «${currentPage}»…` : 'Спроси что-нибудь…'}
          rows={1}
          style={{
            flex: 1, resize: 'none', maxHeight: 100,
            padding: '8px 10px', border: '1px solid var(--border)',
            borderRadius: 10, fontSize: 13, background: 'var(--bg-2)',
            fontFamily: 'inherit', outline: 'none',
          }}
        />
        <button
          onClick={() => submit(draft)}
          disabled={!draft.trim() || sending}
          style={{
            background: 'var(--accent)', color: '#fff', border: 'none',
            width: 36, height: 36, borderRadius: 10, cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            opacity: (!draft.trim() || sending) ? 0.4 : 1,
            flexShrink: 0,
          }}
        >
          <PaperPlaneRightIcon size={16} weight="bold" />
        </button>
      </div>
    </div>
  );
}
