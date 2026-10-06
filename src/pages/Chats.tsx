// Раздел «Чаты с покупателями» (WB). Диалоги собирает сервер каждые 5 минут,
// ИИ готовит черновик к новому сообщению покупателя; отправка — кнопкой.
import { useEffect, useRef, useState } from 'react';
import { ArrowsClockwiseIcon, WarningIcon, SpinnerIcon, PaperPlaneRightIcon, SparkleIcon, MagnifyingGlassIcon } from '@phosphor-icons/react';
import { chatsApi, type ChatThread, type ChatMsg, type ChatView } from '../api/chats';
import { reviewsApi } from '../api/reviews';
import type { ReviewSettings } from '../../shared/reviews';

const WB = '#cb11ab';

function fmt(ms: number | null): string {
  if (!ms) return '—';
  const d = new Date(ms);
  const today = new Date();
  const same = d.toDateString() === today.toDateString();
  return same ? d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString('ru-RU', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function statusChip(t: ChatThread) {
  if (t.status === 'escalated') return <span className="chip bad">на проверку</span>;
  if (t.status === 'drafted') return <span className="chip info">черновик</span>;
  if (t.status === 'sent') return <span className="chip good">отвечено</span>;
  if (t.status === 'skipped') return <span className="chip">пропущен</span>;
  if (t.lastFromBuyer) return <span className="chip">ждёт ответа</span>;
  return null;
}

export function Chats() {
  const [view, setView] = useState<ChatView>('waiting');
  const [q, setQ] = useState('');
  const [data, setData] = useState<Awaited<ReturnType<typeof chatsApi.list>> | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [settings, setSettings] = useState<ReviewSettings | null>(null);

  const load = async () => {
    try { setData(await chatsApi.list(view, q)); setErr(null); } catch (e: any) { setErr(e?.message || 'Ошибка'); }
  };
  useEffect(() => { load(); }, [view]);
  useEffect(() => { const t = setInterval(load, 60_000); return () => clearInterval(t); }, [view, q]);
  useEffect(() => { reviewsApi.overview().then(o => setSettings(o.settings)).catch(() => {}); }, []);

  const syncNow = async () => {
    setSyncing(true);
    try { await chatsApi.sync(); } catch (e: any) { alert(`Синхронизация не удалась: ${e?.message}`); }
    setSyncing(false);
    load();
  };
  const toggle = async (k: 'chatAutoDraft' | 'chatAutoSendWb') => {
    if (!settings) return;
    if (k === 'chatAutoSendWb' && !settings.chatAutoSendWb
      && !confirm('Включить автоотправку в чатах WB? Черновики без пометки «на проверку» будут уходить покупателю без вашей кнопки.')) return;
    setSettings((await reviewsApi.saveSettings({ [k]: !settings[k] } as any)).settings);
  };

  const replaceThread = (t: ChatThread) => setData(d => d ? { ...d, threads: d.threads.map(x => x.chatId === t.chatId ? t : x) } : d);

  return (
    <div className="grid" style={{ gap: 12 }}>
      <div className="card" style={{ padding: 12 }}>
        <div className="flex-between" style={{ flexWrap: 'wrap', gap: 8 }}>
          <div className="row gap-8" style={{ flexWrap: 'wrap' }}>
            <b style={{ color: WB }}>Wildberries</b>
            <span className="muted">ждут ответа: <b>{data?.counts.waiting ?? '…'}</b> · черновиков: <b>{data?.counts.drafts ?? '…'}</b></span>
            {data && <span className="muted" style={{ fontSize: 12 }}>в базе {data.totals.threads} диалогов, {data.totals.messages} сообщений</span>}
          </div>
          <div className="row gap-8" style={{ flexWrap: 'wrap' }}>
            {settings && (
              <>
                <label className="row gap-8" style={{ fontSize: 13, cursor: 'pointer' }} title="ИИ сам готовит черновик к каждому новому сообщению покупателя (за последние 48 ч)">
                  <input type="checkbox" checked={settings.chatAutoDraft} onChange={() => toggle('chatAutoDraft')} /> черновики сами
                </label>
                <label className="row gap-8" style={{ fontSize: 13, cursor: 'pointer' }} title="Отправлять черновик без кнопки. Пометки «на проверку» никогда не отправляются сами.">
                  <input type="checkbox" checked={settings.chatAutoSendWb} onChange={() => toggle('chatAutoSendWb')} /> авто-отправка
                </label>
              </>
            )}
            <button className="btn btn-sm" onClick={syncNow} disabled={syncing}>
              {syncing ? <SpinnerIcon size={14} className="spin" /> : <ArrowsClockwiseIcon size={14} />} Обновить
            </button>
          </div>
        </div>
        <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
          Новые сообщения подтягиваются каждые 5 минут. Ответ ИИ строит по всей переписке, карточке и материалам товара, нашим прошлым ответам и архиву Telegram.
          Отправка — только кнопкой «Отправить». Чаты Ozon подключим отдельным шагом.
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(260px, 360px) minmax(0, 1fr)', gap: 12, alignItems: 'start' }} className="chats-grid">
        <div className="card" style={{ padding: 8 }}>
          <div className="row gap-8" style={{ marginBottom: 8, flexWrap: 'wrap' }}>
            {([['waiting', 'Ждут ответа'], ['drafts', 'Черновики'], ['all', 'Все']] as [ChatView, string][]).map(([k, t]) => (
              <button key={k} className={`period-btn ${view === k ? 'active' : ''}`} onClick={() => setView(k)}>{t}</button>
            ))}
          </div>
          <form className="row gap-8" style={{ marginBottom: 8 }} onSubmit={e => { e.preventDefault(); load(); }}>
            <input className="input" style={{ flex: 1, padding: '4px 8px' }} placeholder="товар, артикул, имя, текст" value={q} onChange={e => setQ(e.target.value)} />
            <button className="btn btn-sm" type="submit"><MagnifyingGlassIcon size={14} /></button>
          </form>
          {err && <div className="chip bad">{err}</div>}
          {!data && !err && <div className="muted"><SpinnerIcon size={14} className="spin" /> Загружаю…</div>}
          {data && !data.threads.length && <div className="muted" style={{ padding: 8 }}>{view === 'waiting' ? 'Все покупатели получили ответ' : 'Пусто'}</div>}
          <div style={{ maxHeight: '70vh', overflow: 'auto' }}>
            {data?.threads.map(t => (
              <div key={t.chatId} onClick={() => setSel(t.chatId)}
                style={{ padding: '8px 6px', borderRadius: 8, cursor: 'pointer', background: sel === t.chatId ? 'var(--bg-3)' : undefined, borderBottom: '1px solid var(--border)' }}>
                <div className="flex-between" style={{ gap: 6 }}>
                  <b style={{ fontSize: 13 }}>{t.clientName || 'Покупатель'}</b>
                  <span className="muted" style={{ fontSize: 11 }}>{fmt(t.lastAt)}</span>
                </div>
                <div className="muted" style={{ fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.productName || t.offerId || '—'}</div>
                <div style={{ fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {t.lastFromBuyer ? '' : 'Вы: '}{t.lastText}
                </div>
                <div style={{ marginTop: 2 }}>{statusChip(t)}</div>
              </div>
            ))}
          </div>
        </div>

        {sel ? <ThreadPane key={sel} id={sel} onChanged={t => { replaceThread(t); }} onSent={() => load()} />
          : <div className="card muted" style={{ padding: 24 }}>Выберите диалог слева</div>}
      </div>
      <style>{`@media (max-width: 760px) { .chats-grid { grid-template-columns: minmax(0, 1fr) !important; } }`}</style>
    </div>
  );
}

function ThreadPane({ id, onChanged, onSent }: { id: string; onChanged: (t: ChatThread) => void; onSent: () => void }) {
  const [th, setTh] = useState<ChatThread | null>(null);
  const [msgs, setMsgs] = useState<ChatMsg[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  const load = async () => {
    try {
      const r = await chatsApi.thread(id);
      setTh(r.thread); setMsgs(r.messages); setText(r.thread.draftAnswer || ''); setError(r.thread.sendError);
    } catch (e: any) { setError(e?.message || 'Ошибка'); }
  };
  useEffect(() => { load(); }, [id]);
  useEffect(() => { bottom.current?.scrollIntoView({ block: 'end' }); }, [msgs.length]);

  const act = async (name: string, fn: () => Promise<any>) => {
    setBusy(name); setError(null);
    try { await fn(); } catch (e: any) { setError(e?.message || 'Ошибка'); }
    setBusy(null);
  };
  const apply = (t: ChatThread | null | undefined) => { if (t) { setTh(t); setText(t.draftAnswer || ''); onChanged(t); } };
  const send = () => act('send', async () => {
    if (!text.trim()) throw new Error('Пустое сообщение');
    if (th?.status === 'escalated' && !confirm(`ИИ пометил: ${th.escalationReason}. Всё равно отправить?`)) return;
    const r = await chatsApi.send(id, text.trim());
    if (!r.ok) throw new Error(r.error || 'Не отправлено');
    await load(); onSent();
  });

  if (!th) return <div className="card muted" style={{ padding: 24 }}>{error || <><SpinnerIcon size={14} className="spin" /> Загружаю…</>}</div>;

  return (
    <div className="card" style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div className="flex-between" style={{ flexWrap: 'wrap', gap: 8 }}>
        <div>
          <b>{th.clientName || 'Покупатель'}</b>
          <span className="muted" style={{ marginLeft: 8, fontSize: 13 }}>{th.productName || '—'}{th.offerId ? ` · ${th.offerId}` : ''}</span>
        </div>
        {statusChip(th)}
      </div>

      <div style={{ maxHeight: '50vh', overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 6, padding: 4, background: 'var(--bg-2, transparent)' }}>
        {msgs.map(m => (
          <div key={m.id} style={{
            alignSelf: m.fromBuyer ? 'flex-start' : 'flex-end', maxWidth: '82%', padding: '6px 10px', borderRadius: 10,
            background: m.fromBuyer ? 'var(--bg-3)' : 'rgba(203,17,171,0.12)', whiteSpace: 'pre-wrap', fontSize: 14,
          }}>
            {m.text}
            <div className="muted" style={{ fontSize: 11, textAlign: 'right', marginTop: 2 }}>{m.fromBuyer ? '' : 'магазин · '}{fmt(m.at)}</div>
          </div>
        ))}
        <div ref={bottom} />
      </div>

      {th.escalationReason && th.status === 'escalated' && <div style={{ color: 'var(--bad)', fontSize: 13 }}><WarningIcon size={13} /> {th.escalationReason}</div>}
      {!th.canReply && <div className="chip bad">Нет подписи чата для ответа — нажмите «Обновить» вверху</div>}
      <textarea className="textarea" rows={4} style={{ width: '100%' }}
        placeholder={th.lastFromBuyer ? 'Черновик готовится — или напишите ответ сами' : 'Сообщение покупателю'}
        value={text} onChange={e => setText(e.target.value)}
        onBlur={() => { if (text !== (th.draftAnswer || '')) act('save', async () => apply((await chatsApi.save(id, text)).thread)); }} />
      <div className="flex-between" style={{ flexWrap: 'wrap', gap: 8 }}>
        <span className="muted" style={{ fontSize: 12 }}>
          {text.length}/1000
          {th.sourcesUsed.length ? ` · опора: ${[...new Set(th.sourcesUsed.map(s => s.split(':')[0]))].map(s => ({ style: 'профиль стиля', card: 'карточка', product: 'материалы Диска', history: 'прошлые ответы', chat: 'переписка' } as any)[s] || s).join(', ')}` : ''}
          {th.draftCostUsd ? ` · $${th.draftCostUsd.toFixed(3)}` : ''}
        </span>
        <div className="row gap-8">
          {th.status === 'skipped'
            ? <button className="btn btn-sm" disabled={!!busy} onClick={() => act('unskip', async () => apply((await chatsApi.unskip(id)).thread))}>Вернуть</button>
            : <button className="btn btn-sm" disabled={!!busy} onClick={() => act('skip', async () => { apply((await chatsApi.skip(id)).thread); onSent(); })}>Пропустить</button>}
          <button className="btn btn-sm" disabled={!!busy} onClick={() => act('draft', async () => apply((await chatsApi.draft(id)).thread))}>
            {busy === 'draft' ? <SpinnerIcon size={14} className="spin" /> : <SparkleIcon size={14} />} {th.draftAnswer ? 'Переписать' : 'Черновик'}
          </button>
          <button className="btn btn-sm btn-primary" disabled={!!busy || !th.canReply} onClick={send}>
            {busy === 'send' ? <SpinnerIcon size={14} className="spin" /> : <PaperPlaneRightIcon size={14} />} Отправить
          </button>
        </div>
      </div>
      {error && <div className="chip bad">{error}</div>}
    </div>
  );
}
