// Раздел «Чаты с покупателями» (WB и Ozon). Диалоги собирает сервер каждые 5 минут,
// ИИ готовит черновик к новому сообщению покупателя; отправка — кнопкой.
import { useEffect, useRef, useState } from 'react';
import { ArrowsClockwiseIcon, WarningIcon, SpinnerIcon, PaperPlaneRightIcon, SparkleIcon, MagnifyingGlassIcon } from '@phosphor-icons/react';
import { chatsApi, type ChatThread, type ChatMsg, type ChatView, type ChatMp } from '../api/chats';
import { reviewsApi } from '../api/reviews';
import type { ReviewSettings } from '../../shared/reviews';

const MP_COLOR = { wb: '#cb11ab', ozon: '#005bff' } as const;
const MP_NAME = { wb: 'WB', ozon: 'Ozon' } as const;
const key = (t: { marketplace: string; chatId: string }) => `${t.marketplace}|${t.chatId}`;

function MpBadge({ mp }: { mp: 'wb' | 'ozon' }) {
  return <span style={{ fontSize: 11, fontWeight: 700, color: '#fff', background: MP_COLOR[mp], borderRadius: 4, padding: '1px 5px' }}>{MP_NAME[mp]}</span>;
}

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
  const [mp, setMp] = useState<ChatMp>('all');
  const [q, setQ] = useState('');
  const [data, setData] = useState<Awaited<ReturnType<typeof chatsApi.list>> | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [settings, setSettings] = useState<ReviewSettings | null>(null);

  const load = async () => {
    try { setData(await chatsApi.list(view, mp, q)); setErr(null); } catch (e: any) { setErr(e?.message || 'Ошибка'); }
  };
  useEffect(() => { load(); }, [view, mp]);
  useEffect(() => { const t = setInterval(load, 60_000); return () => clearInterval(t); }, [view, mp, q]);
  useEffect(() => { reviewsApi.overview().then(o => setSettings(o.settings)).catch(() => {}); }, []);

  const syncNow = async () => {
    setSyncing(true);
    try { await chatsApi.sync(); } catch (e: any) { alert(`Синхронизация не удалась: ${e?.message}`); }
    setSyncing(false);
    load();
  };
  const toggle = async (k: 'chatAutoDraft' | 'chatAutoSendWb' | 'chatAutoSendOzon') => {
    if (!settings) return;
    if (k !== 'chatAutoDraft' && !settings[k]
      && !confirm(`Включить автоответы в чатах ${k === 'chatAutoSendWb' ? 'Wildberries' : 'Ozon'}? Черновики без пометки «на проверку» будут уходить покупателю без вашей кнопки.`)) return;
    setSettings((await reviewsApi.saveSettings({ [k]: !settings[k] } as any)).settings);
  };

  const replaceThread = (t: ChatThread) => setData(d => d ? { ...d, threads: d.threads.map(x => key(x) === key(t) ? t : x) } : d);
  const selThread = data?.threads.find(t => key(t) === sel);

  return (
    <div className="grid" style={{ gap: 12 }}>
      <div className="card" style={{ padding: 12 }}>
        <div className="flex-between" style={{ flexWrap: 'wrap', gap: 10 }}>
          <div className="row gap-8" style={{ flexWrap: 'wrap', gap: 16 }}>
            {(['wb', 'ozon'] as const).map(m => (
              <div key={m} className="row gap-8" style={{ gap: 8 }}>
                <MpBadge mp={m} />
                <span className="muted" style={{ fontSize: 13 }}>ждут: <b>{data?.counts[m].waiting ?? '…'}</b> · черновиков: <b>{data?.counts[m].drafts ?? '…'}</b></span>
                {settings && (
                  <label className="row gap-8" style={{ fontSize: 13, cursor: 'pointer', gap: 4 }} title="Отправлять черновик без кнопки. Пометки «на проверку» никогда не отправляются сами.">
                    <input type="checkbox" checked={m === 'wb' ? settings.chatAutoSendWb : settings.chatAutoSendOzon} onChange={() => toggle(m === 'wb' ? 'chatAutoSendWb' : 'chatAutoSendOzon')} />
                    автоответ
                  </label>
                )}
              </div>
            ))}
          </div>
          <div className="row gap-8" style={{ flexWrap: 'wrap' }}>
            {settings && (
              <label className="row gap-8" style={{ fontSize: 13, cursor: 'pointer' }} title="ИИ сам готовит черновик к каждому новому сообщению покупателя (за последние 48 ч)">
                <input type="checkbox" checked={settings.chatAutoDraft} onChange={() => toggle('chatAutoDraft')} /> черновики сами
              </label>
            )}
            <button className="btn btn-sm" onClick={syncNow} disabled={syncing}>
              {syncing ? <SpinnerIcon size={14} className="spin" /> : <ArrowsClockwiseIcon size={14} />} Обновить
            </button>
          </div>
        </div>
        <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
          Новые сообщения подтягиваются каждые 5 минут{data ? ` · в базе ${data.totals.wb} диалогов WB и ${data.totals.ozon} Ozon` : ''}.
          Ответ ИИ строит по всей переписке, карточке и материалам товара, нашим прошлым ответам и архиву Telegram.
          «Автоответ» включается отдельно для каждой площадки; без него — только кнопкой «Отправить».
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(260px, 360px) minmax(0, 1fr)', gap: 12, alignItems: 'start' }} className="chats-grid">
        <div className="card" style={{ padding: 8 }}>
          <div className="row gap-8" style={{ marginBottom: 8, flexWrap: 'wrap' }}>
            {([['waiting', 'Ждут ответа'], ['drafts', 'Черновики'], ['all', 'Все']] as [ChatView, string][]).map(([k, t]) => (
              <button key={k} className={`period-btn ${view === k ? 'active' : ''}`} onClick={() => setView(k)}>{t}</button>
            ))}
          </div>
          <div className="row gap-8" style={{ marginBottom: 8 }}>
            {([['all', 'Все площадки'], ['wb', 'WB'], ['ozon', 'Ozon']] as [ChatMp, string][]).map(([k, t]) => (
              <button key={k} className={`period-btn ${mp === k ? 'active' : ''}`} onClick={() => setMp(k)}
                style={k !== 'all' && mp === k ? { borderColor: MP_COLOR[k], color: MP_COLOR[k] } : undefined}>{t}</button>
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
              <div key={key(t)} onClick={() => setSel(key(t))}
                style={{ padding: '8px 6px', borderRadius: 8, cursor: 'pointer', background: sel === key(t) ? 'var(--bg-3)' : undefined, borderBottom: '1px solid var(--border)', borderLeft: `3px solid ${MP_COLOR[t.marketplace]}` }}>
                <div className="flex-between" style={{ gap: 6 }}>
                  <span className="row gap-8" style={{ gap: 6 }}><MpBadge mp={t.marketplace} /><b style={{ fontSize: 13 }}>{t.clientName || 'Покупатель'}</b></span>
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

        {sel && selThread ? <ThreadPane key={sel} mp={selThread.marketplace} id={selThread.chatId} onChanged={t => { replaceThread(t); }} onSent={() => load()} />
          : <div className="card muted" style={{ padding: 24 }}>Выберите диалог слева</div>}
      </div>
      <style>{`@media (max-width: 760px) { .chats-grid { grid-template-columns: minmax(0, 1fr) !important; } }`}</style>
    </div>
  );
}

function ThreadPane({ mp, id, onChanged, onSent }: { mp: 'wb' | 'ozon'; id: string; onChanged: (t: ChatThread) => void; onSent: () => void }) {
  const [th, setTh] = useState<ChatThread | null>(null);
  const [msgs, setMsgs] = useState<ChatMsg[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  const load = async () => {
    try {
      const r = await chatsApi.thread(mp, id);
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
    const r = await chatsApi.send(mp, id, text.trim());
    if (!r.ok) throw new Error(r.error || 'Не отправлено');
    await load(); onSent();
  });

  if (!th) return <div className="card muted" style={{ padding: 24 }}>{error || <><SpinnerIcon size={14} className="spin" /> Загружаю…</>}</div>;

  return (
    <div className="card" style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div className="flex-between" style={{ flexWrap: 'wrap', gap: 8 }}>
        <div className="row gap-8" style={{ gap: 8 }}>
          <MpBadge mp={th.marketplace} />
          <b>{th.clientName || 'Покупатель'}</b>
          <span className="muted" style={{ marginLeft: 8, fontSize: 13 }}>{th.productName || '—'}{th.offerId ? ` · ${th.offerId}` : ''}</span>
        </div>
        {statusChip(th)}
      </div>

      <div style={{ maxHeight: '50vh', overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 6, padding: 4, background: 'var(--bg-2, transparent)' }}>
        {msgs.map(m => (
          <div key={m.id} style={{
            alignSelf: m.fromBuyer ? 'flex-start' : 'flex-end', maxWidth: '82%', padding: '6px 10px', borderRadius: 10,
            background: m.fromBuyer ? 'var(--bg-3)' : (mp === 'wb' ? 'rgba(203,17,171,0.12)' : 'rgba(0,91,255,0.12)'), whiteSpace: 'pre-wrap', fontSize: 14,
          }}>
            {m.text}
            <div className="muted" style={{ fontSize: 11, textAlign: 'right', marginTop: 2 }}>{m.fromBuyer ? '' : 'магазин · '}{fmt(m.at)}</div>
          </div>
        ))}
        <div ref={bottom} />
      </div>

      {th.escalationReason && th.status === 'escalated' && <div style={{ color: 'var(--bad)', fontSize: 13 }}><WarningIcon size={13} /> {th.escalationReason}</div>}
      {!th.canReply && <div className="chip bad">Нет данных чата для ответа — нажмите «Обновить» вверху</div>}
      <textarea className="textarea" rows={4} style={{ width: '100%' }}
        placeholder={th.lastFromBuyer ? 'Черновик готовится — или напишите ответ сами' : 'Сообщение покупателю'}
        value={text} onChange={e => setText(e.target.value)}
        onBlur={() => { if (text !== (th.draftAnswer || '')) act('save', async () => apply((await chatsApi.save(mp, id, text)).thread)); }} />
      <div className="flex-between" style={{ flexWrap: 'wrap', gap: 8 }}>
        <span className="muted" style={{ fontSize: 12 }}>
          {text.length}/1000
          {th.sourcesUsed.length ? ` · опора: ${[...new Set(th.sourcesUsed.map(s => s.split(':')[0]))].map(s => ({ style: 'профиль стиля', card: 'карточка', product: 'материалы Диска', history: 'прошлые ответы', chat: 'переписка' } as any)[s] || s).join(', ')}` : ''}
          {th.draftCostUsd ? ` · $${th.draftCostUsd.toFixed(3)}` : ''}
        </span>
        <div className="row gap-8">
          {th.status === 'skipped'
            ? <button className="btn btn-sm" disabled={!!busy} onClick={() => act('unskip', async () => apply((await chatsApi.unskip(mp, id)).thread))}>Вернуть</button>
            : <button className="btn btn-sm" disabled={!!busy} onClick={() => act('skip', async () => { apply((await chatsApi.skip(mp, id)).thread); onSent(); })}>Пропустить</button>}
          <button className="btn btn-sm" disabled={!!busy} onClick={() => act('draft', async () => apply((await chatsApi.draft(mp, id)).thread))}>
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
