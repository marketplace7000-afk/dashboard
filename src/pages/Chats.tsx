// Раздел «Чаты с покупателями» (WB и Ozon). Диалоги собирает сервер каждые 5 минут,
// ИИ готовит черновик к новому сообщению покупателя; отправка — кнопкой.
// Вид: стили .rv- в styles.css, общие детали — components/InboxUi.tsx (13.10.2026).
import { useEffect, useRef, useState } from 'react';
import {
  ArrowsClockwiseIcon, WarningIcon, SpinnerIcon, PaperPlaneRightIcon, SparkleIcon, MagnifyingGlassIcon, ArrowLeftIcon, ChatsCircleIcon,
  ArrowSquareOutIcon,
} from '@phosphor-icons/react';
import { chatsApi, type ChatThread, type ChatMsg, type ChatView, type ChatMp } from '../api/chats';
import { reviewsApi } from '../api/reviews';
import type { ReviewSettings } from '../../shared/reviews';
import { MP_NAME, MpTag, Switch, Badge, mpVar, useAutoGrow, sourcesText } from '../components/InboxUi';

const key = (t: { marketplace: string; chatId: string }) => `${t.marketplace}|${t.chatId}`;

function fmt(ms: number | null): string {
  if (!ms) return '—';
  const d = new Date(ms);
  const today = new Date();
  const same = d.toDateString() === today.toDateString();
  return same ? d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString('ru-RU', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function statusBadge(t: ChatThread) {
  if (t.status === 'escalated') return <Badge tone="bad">На проверку</Badge>;
  if (t.status === 'drafted') return <Badge tone="info">Черновик готов</Badge>;
  if (t.status === 'sent') return <Badge tone="good">Отвечено</Badge>;
  if (t.status === 'skipped') return <Badge tone="neutral">Пропущен</Badge>;
  if (t.lastFromBuyer) return <Badge tone="warn">Ждёт ответа</Badge>;
  return null;
}

function Avatar({ t }: { t: ChatThread }) {
  const letter = (t.clientName || 'П').trim().charAt(0).toUpperCase();
  return <span className="rv-avatar" style={mpVar(t.marketplace)} aria-hidden="true">{letter}</span>;
}

/** Фото товара; нет фото (или не загрузилось) — буква покупателя, как раньше. */
function ProductThumb({ t, size = 'sm' }: { t: ChatThread; size?: 'sm' | 'lg' }) {
  const [broken, setBroken] = useState(false);
  if (!t.productPhoto || broken) return size === 'sm' ? <Avatar t={t} /> : null;
  return (
    <span className={`rv-pthumb rv-pthumb--${size}`} style={mpVar(t.marketplace)} aria-hidden="true">
      <img src={t.productPhoto} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setBroken(true)} />
    </span>
  );
}

/** Полоса «о каком товаре чат» над перепиской. */
function ProductStrip({ t }: { t: ChatThread }) {
  if (!t.productName && !t.offerId && !t.sku) {
    return <div className="rv-product rv-product--none">Товар не определён: покупатель написал не из карточки товара и не назвал артикул или номер заказа.</div>;
  }
  const idName = t.marketplace === 'wb' ? 'nmID' : 'SKU';
  return (
    <div className="rv-product">
      <ProductThumb t={t} size="lg" />
      <div className="rv-product-body">
        <b className="rv-product-name">{t.productName || 'Название не загружено'}</b>
        <span className="rv-muted">
          {[t.offerId && `арт. ${t.offerId}`, t.sku && `${idName} ${t.sku}`].filter(Boolean).join(' · ')}
        </span>
      </div>
      {t.productUrl && (
        <a className="btn btn-ghost rv-product-link" href={t.productUrl} target="_blank" rel="noopener noreferrer">
          На {MP_NAME[t.marketplace]} <ArrowSquareOutIcon size={16} />
        </a>
      )}
    </div>
  );
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
  const views: [ChatView, string, number | null][] = [
    ['waiting', 'Ждут ответа', data?.counts.waiting ?? null], ['drafts', 'Черновики', data?.counts.drafts ?? null], ['all', 'Все', null],
  ];

  return (
    <div className="rv-page">
      <section className="rv-hero">
        <div className="rv-stats">
          {(['wb', 'ozon'] as const).map(m => (
            <div key={m} className="rv-stat rv-stat--mp" style={mpVar(m)}>
              <span className="rv-stat-label"><span className="rv-dot" />Чаты {MP_NAME[m]}</span>
              <span className="rv-stat-pair">
                <span><b className="rv-stat-num">{data?.counts[m].waiting ?? '…'}</b> ждут</span>
                <span><b className="rv-stat-num rv-stat-num--sm">{data?.counts[m].drafts ?? '…'}</b> черновиков</span>
              </span>
              {settings && (
                <Switch checked={m === 'wb' ? settings.chatAutoSendWb : settings.chatAutoSendOzon}
                  onChange={() => toggle(m === 'wb' ? 'chatAutoSendWb' : 'chatAutoSendOzon')}
                  title="Отправлять черновик без кнопки. Пометки «на проверку» никогда не отправляются сами.">
                  Автоответ
                </Switch>
              )}
            </div>
          ))}
        </div>
        <div className="rv-hero-side">
          {settings && (
            <Switch checked={settings.chatAutoDraft} onChange={() => toggle('chatAutoDraft')}
              title="ИИ сам готовит черновик к каждому новому сообщению покупателя (за последние 48 ч)">
              ИИ сам пишет черновики
            </Switch>
          )}
          <button className="btn btn-primary" onClick={syncNow} disabled={syncing}>
            {syncing ? <SpinnerIcon size={17} className="spin" /> : <ArrowsClockwiseIcon size={17} />} Обновить
          </button>
        </div>
      </section>
      <p className="rv-sub rv-sub--page">
        Новые сообщения приходят каждые 5 минут{data ? ` · в базе ${data.totals.wb} диалогов WB и ${data.totals.ozon} Ozon` : ''}.
        Ответ ИИ строит по всей переписке, карточке и материалам товара, нашим прошлым ответам и архиву Telegram.
        Без «Автоответа» сообщение уходит только по кнопке «Отправить».
      </p>

      <div className={`rv-chat${sel && selThread ? ' has-thread' : ''}`}>
        <aside className="rv-chat-list">
          <div className="rv-chat-tools">
            <div className="rv-seg rv-seg--full" role="tablist">
              {views.map(([k, t, n]) => (
                <button key={k} role="tab" aria-selected={view === k} className={`rv-seg-btn${view === k ? ' is-active' : ''}`} onClick={() => setView(k)}>
                  {t}{n != null && <span className="rv-count">{n}</span>}
                </button>
              ))}
            </div>
            <div className="rv-pills" role="group" aria-label="Площадка">
              {([['all', 'Все площадки'], ['wb', 'WB'], ['ozon', 'Ozon']] as [ChatMp, string][]).map(([k, t]) => (
                <button key={k} aria-pressed={mp === k} className={`rv-pill${mp === k ? ' is-on' : ''}`} onClick={() => setMp(k)}
                  style={k !== 'all' ? mpVar(k) : undefined}>
                  {k !== 'all' && <span className="rv-dot" />}{t}
                </button>
              ))}
            </div>
            <form className="rv-search" onSubmit={e => { e.preventDefault(); load(); }}>
              <MagnifyingGlassIcon size={17} />
              <input className="input" placeholder="Товар, артикул, имя или текст" value={q} onChange={e => setQ(e.target.value)} />
            </form>
          </div>
          {err && <div className="rv-callout rv-callout--bad"><WarningIcon size={18} /><span>{err}</span></div>}
          {!data && !err && <div className="rv-empty"><SpinnerIcon size={20} className="spin" /> Загружаю…</div>}
          {data && !data.threads.length && <div className="rv-empty">{view === 'waiting' ? 'Все покупатели получили ответ.' : 'Здесь пока пусто.'}</div>}
          <div className="rv-threads">
            {data?.threads.map(t => (
              <button key={key(t)} className={`rv-thread${sel === key(t) ? ' is-active' : ''}`} style={mpVar(t.marketplace)} onClick={() => setSel(key(t))}>
                <ProductThumb t={t} />
                <span className="rv-thread-body">
                  <span className="rv-thread-top">
                    <b>{t.clientName || 'Покупатель'}</b>
                    <time>{fmt(t.lastAt)}</time>
                  </span>
                  <span className="rv-thread-product">
                    <MpTag mp={t.marketplace} />
                    <span className="rv-thread-pname">{t.productName || (t.offerId ? `арт. ${t.offerId}` : 'Товар не определён')}</span>
                  </span>
                  <span className="rv-thread-last">{t.lastFromBuyer ? '' : <span className="rv-muted">Вы: </span>}{t.lastText}</span>
                  {statusBadge(t) && <span className="rv-thread-status">{statusBadge(t)}</span>}
                </span>
              </button>
            ))}
          </div>
        </aside>

        <section className="rv-chat-pane">
          {sel && selThread
            ? <ThreadPane key={sel} mp={selThread.marketplace} id={selThread.chatId} onBack={() => setSel(null)} onChanged={replaceThread} onSent={() => load()} />
            : <div className="rv-empty rv-empty--pane"><ChatsCircleIcon size={40} weight="light" /><div>Выберите диалог в списке слева</div></div>}
        </section>
      </div>
    </div>
  );
}

function ThreadPane({ mp, id, onBack, onChanged, onSent }: {
  mp: 'wb' | 'ozon'; id: string; onBack: () => void; onChanged: (t: ChatThread) => void; onSent: () => void;
}) {
  const [th, setTh] = useState<ChatThread | null>(null);
  const [msgs, setMsgs] = useState<ChatMsg[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const area = useAutoGrow(text);

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

  if (!th) return <div className="rv-empty rv-empty--pane">{error || <><SpinnerIcon size={20} className="spin" /> Загружаю…</>}</div>;

  const hint = [sourcesText(th.sourcesUsed), th.draftCostUsd ? `$${th.draftCostUsd.toFixed(3)}` : ''].filter(Boolean).join(' · ');

  return (
    <div className="rv-thread-pane" style={mpVar(th.marketplace)}>
      <header className="rv-pane-head">
        <button className="btn btn-ghost rv-back" onClick={onBack} aria-label="К списку диалогов"><ArrowLeftIcon size={18} /></button>
        <Avatar t={th} />
        <div className="rv-pane-title">
          <b>{th.clientName || 'Покупатель'}</b>
          <span className="rv-muted"><MpTag mp={th.marketplace} /> чат с покупателем</span>
        </div>
        {statusBadge(th)}
      </header>
      <ProductStrip t={th} />

      <div className="rv-messages">
        {msgs.map(m => (
          <div key={m.id} className={`rv-msg ${m.fromBuyer ? 'rv-msg--buyer' : 'rv-msg--shop'}`}>
            {/^\[(фото|фото\/файл|файл[^\]]*|фото: \d+)\]$/.test(m.text.trim())
              ? <span className="rv-muted">Фото или файл — открыть можно в кабинете {MP_NAME[th.marketplace]}</span>
              : m.text}
            <time>{m.fromBuyer ? '' : 'Магазин · '}{fmt(m.at)}</time>
          </div>
        ))}
        <div ref={bottom} />
      </div>

      <div className="rv-composer">
        {th.escalationReason && th.status === 'escalated' && (
          <div className="rv-callout rv-callout--bad"><WarningIcon size={18} /><span><b>Проверьте перед отправкой.</b> {th.escalationReason}</span></div>
        )}
        {!th.canReply && <div className="rv-callout rv-callout--warn"><WarningIcon size={18} /><span>Нет данных чата для ответа — нажмите «Обновить» вверху страницы.</span></div>}
        <textarea ref={area} className="textarea rv-textarea" rows={3} aria-label="Сообщение покупателю"
          placeholder={th.lastFromBuyer ? 'Черновик готовится — или напишите ответ сами' : 'Сообщение покупателю'}
          value={text} onChange={e => setText(e.target.value)}
          onBlur={() => { if (text !== (th.draftAnswer || '')) act('save', async () => apply((await chatsApi.save(mp, id, text)).thread)); }} />
        <div className="rv-reply-foot">
          <span className="rv-hint">
            {text.length <= 1000
              ? <span>{text.length} из 1000</span>
              : <span className="rv-text-warn" title="Площадка принимает до 1000 символов в одном сообщении — текст разделится по абзацам и предложениям">
                  {text.length} симв. · уйдёт {Math.ceil(text.length / 950)} сообщениями
                </span>}
            {hint ? ` · ${hint}` : ''}
          </span>
          <div className="rv-actions">
            {th.status === 'skipped'
              ? <button className="btn" disabled={!!busy} onClick={() => act('unskip', async () => apply((await chatsApi.unskip(mp, id)).thread))}>Вернуть в работу</button>
              : <button className="btn btn-ghost" disabled={!!busy} onClick={() => act('skip', async () => { apply((await chatsApi.skip(mp, id)).thread); onSent(); })}>Пропустить</button>}
            <button className="btn" disabled={!!busy} onClick={() => act('draft', async () => apply((await chatsApi.draft(mp, id)).thread))}>
              {busy === 'draft' ? <SpinnerIcon size={17} className="spin" /> : <SparkleIcon size={17} />} {th.draftAnswer ? 'Переписать' : 'Написать черновик'}
            </button>
            <button className="btn btn-primary" disabled={!!busy || !th.canReply} onClick={send}>
              {busy === 'send' ? <SpinnerIcon size={17} className="spin" /> : <PaperPlaneRightIcon size={17} />} Отправить
            </button>
          </div>
        </div>
        {error && <div className="rv-callout rv-callout--bad"><WarningIcon size={18} /><span>{error}</span></div>}
      </div>
    </div>
  );
}
