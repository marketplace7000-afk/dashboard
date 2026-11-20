// «Документы» в чате с покупателем (20.11.2026): инструкции, техпаспорта, сертификаты, фото комплектации
// из папки товара на Яндекс.Диске и файлы, добавленные в кабинете. Отправка — в чат площадки
// (PDF/JPG/PNG до 5 МБ, большой PDF сервер сожмёт) или на почту покупателя.
import { useEffect, useRef, useState } from 'react';
import {
  XIcon, SpinnerIcon, FilePdfIcon, FileImageIcon, FileDocIcon, FileXlsIcon, FileIcon, PaperPlaneRightIcon, EnvelopeSimpleIcon,
  MagnifyingGlassIcon, UploadSimpleIcon, TrashIcon, WarningIcon, CheckCircleIcon, ArrowSquareOutIcon,
} from '@phosphor-icons/react';
import { chatsApi, type ChatDoc, type ChatDocsOverview, type ChatThread } from '../api/chats';
import { MP_NAME } from './InboxUi';

const sizeText = (n: number | null) => (n == null ? '' : n >= 1048576 ? `${(n / 1048576).toFixed(1).replace('.', ',')} МБ` : `${Math.max(1, Math.round(n / 1024))} КБ`);
const BIG = 5 * 1024 * 1024;

function DocIcon({ ext }: { ext: string }) {
  if (ext === 'pdf') return <FilePdfIcon size={22} />;
  if (/^(jpe?g|png)$/.test(ext)) return <FileImageIcon size={22} />;
  if (/^docx?$/.test(ext)) return <FileDocIcon size={22} />;
  if (/^xlsx?$/.test(ext)) return <FileXlsIcon size={22} />;
  return <FileIcon size={22} />;
}

function DocRow({ d, on, toggle, onDelete, showFolder }: { d: ChatDoc; on: boolean; toggle: () => void; onDelete?: () => void; showFolder?: boolean }) {
  const note = !d.chatOk ? 'в чат нельзя — только на почту'
    : d.size != null && d.size > BIG ? (d.ext === 'pdf' ? 'больше 5 МБ — в чат WB сожмём или разделим на части, в Ozon уйдёт целиком' : 'большая — уменьшим перед отправкой') : '';
  return (
    <label className={`rv-doc${on ? ' is-on' : ''}`}>
      <input type="checkbox" checked={on} onChange={toggle} />
      <span className="rv-doc-ic"><DocIcon ext={d.ext} /></span>
      <span className="rv-doc-body">
        <span className="rv-doc-name">{d.name}</span>
        <span className="rv-doc-meta">
          {[d.category, d.english ? 'на английском' : '', sizeText(d.size), showFolder ? d.folder.split('/').pop() : ''].filter(Boolean).join(' · ')}
          {note && <span className={d.chatOk ? '' : 'rv-doc-warn'}> · {note}</span>}
        </span>
      </span>
      <a className="btn btn-ghost rv-doc-open" href={chatsApi.docUrl(d.id)} target="_blank" rel="noopener noreferrer" title="Открыть и проверить" onClick={e => e.stopPropagation()}>
        <ArrowSquareOutIcon size={18} />
      </a>
      {onDelete && (
        <button type="button" className="btn btn-ghost rv-doc-open" title="Убрать из кабинета" onClick={e => { e.preventDefault(); onDelete(); }}>
          <TrashIcon size={18} />
        </button>
      )}
    </label>
  );
}

export function ChatDocsPanel({ th, onClose, onSent }: { th: ChatThread; onClose: () => void; onSent: () => void }) {
  const mp = th.marketplace;
  const [ov, setOv] = useState<ChatDocsOverview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [sel, setSel] = useState<Map<string, ChatDoc>>(new Map());
  const [q, setQ] = useState('');
  const [found, setFound] = useState<ChatDoc[] | null>(null);
  const [mode, setMode] = useState<'chat' | 'email'>('chat');
  const [to, setTo] = useState('');
  const [mailText, setMailText] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<{ ok: string[]; errors: string[]; where: string } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = async () => {
    try {
      const r = await chatsApi.docs(mp, th.chatId);
      setOv(r); setErr(null);
      setTo(t => t || r.emails[0] || '');
      setMailText(t => t || r.mailDefault.text);
    } catch (e: any) { setErr(e?.message || 'Ошибка'); }
  };
  useEffect(() => { load(); }, [th.chatId]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy]);

  const search = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (q.trim().length < 2) { setFound(null); return; }
    setBusy('search');
    try { setFound((await chatsApi.searchDocs(q.trim())).docs); } catch (e: any) { setErr(e?.message || 'Ошибка'); }
    setBusy(null);
  };
  const toggle = (d: ChatDoc) => setSel(m => { const n = new Map(m); if (n.has(d.id)) n.delete(d.id); else n.set(d.id, d); return n; });

  const picked = [...sel.values()];
  const notForChat = picked.filter(d => !d.chatOk);

  const send = async () => {
    setBusy('send'); setResult(null); setErr(null);
    try {
      const ids = picked.map(d => d.id);
      const r = mode === 'chat' ? await chatsApi.sendDocs(mp, th.chatId, ids) : await chatsApi.emailDocs(mp, th.chatId, ids, to.trim(), mailText);
      setResult({ ok: r.sent, errors: r.errors, where: mode === 'chat' ? `в чат ${MP_NAME[mp]}` : `на ${to.trim()}` });
      if (r.sent.length) { setSel(new Map()); onSent(); }
      load();
    } catch (e: any) { setResult({ ok: [], errors: [e?.message || 'Не отправлено'], where: '' }); }
    setBusy(null);
  };

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy('upload'); setErr(null);
    try {
      for (const f of Array.from(files)) {
        const { doc } = await chatsApi.uploadDoc(f, th.offerId);
        setSel(m => new Map(m).set(doc.id, doc));
      }
      await load();
    } catch (e: any) { setErr(`Файл не добавлен: ${e?.message || 'ошибка'}`); }
    setBusy(null);
    if (fileInput.current) fileInput.current.value = '';
  };
  const del = async (d: ChatDoc) => {
    if (!confirm(`Убрать «${d.name}» из кабинета? Покупателям, кому он уже ушёл, файл останется.`)) return;
    try { await chatsApi.deleteDoc(d.id); setSel(m => { const n = new Map(m); n.delete(d.id); return n; }); load(); } catch (e: any) { setErr(e?.message || 'Ошибка'); }
  };

  const canSend = picked.length > 0 && !busy && (mode === 'chat'
    ? notForChat.length === 0 && th.canReply
    : !!ov?.mail.ready && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to.trim()));

  return (
    <div className="rv-docs-bg" onClick={() => !busy && onClose()}>
      <div className="rv-docs" role="dialog" aria-modal="true" aria-label="Документы для покупателя" onClick={e => e.stopPropagation()}>
        <header className="rv-docs-head">
          <div>
            <h3>Документы для покупателя</h3>
            <span className="rv-muted">{th.productName || 'Товар не определён'}{th.offerId ? ` · арт. ${th.offerId}` : ''}</span>
          </div>
          <button className="btn btn-ghost" onClick={onClose} disabled={!!busy} aria-label="Закрыть"><XIcon size={20} /></button>
        </header>

        <div className="rv-docs-scroll">
          {err && <div className="rv-callout rv-callout--bad"><WarningIcon size={18} /><span>{err}</span></div>}
          {!ov && !err && <div className="rv-empty"><SpinnerIcon size={20} className="spin" /> Загружаю…</div>}

          {ov && (
            <section className="rv-docs-sec">
              <h4>Документы этого товара</h4>
              {!th.offerId && <p className="rv-muted">Товар чата не определён — найдите документы поиском ниже.</p>}
              {th.offerId && !ov.docs.length && (
                <p className="rv-muted">
                  {ov.diskConnected
                    ? <>Для арт. {th.offerId} на Яндекс.Диске нет папки с документами. Положите файлы в папку товара (Диск проверяется каждые 6 часов) или добавьте файл с компьютера.</>
                    : 'Папка Яндекс.Диска не подключена (Отзывы → Материалы).'}
                </p>
              )}
              <div className="rv-doc-list">
                {ov.docs.map(d => <DocRow key={d.id} d={d} on={sel.has(d.id)} toggle={() => toggle(d)} onDelete={d.source === 'upload' ? () => del(d) : undefined} />)}
              </div>
              <div className="rv-docs-row">
                <input ref={fileInput} type="file" hidden multiple accept=".pdf,.jpg,.jpeg,.png,.docx,.doc,.xlsx,.xls" onChange={e => upload(e.target.files)} />
                <button className="btn" disabled={!!busy} onClick={() => fileInput.current?.click()}>
                  {busy === 'upload' ? <SpinnerIcon size={17} className="spin" /> : <UploadSimpleIcon size={17} />} Добавить файл с компьютера
                </button>
                <span className="rv-muted rv-docs-tip">Файл останется в кабинете у этого товара{th.offerId ? ` (арт. ${th.offerId})` : ''}, до 10 МБ.</span>
              </div>
            </section>
          )}

          {ov && (
            <section className="rv-docs-sec">
              <h4>Другие товары</h4>
              <form className="rv-search" onSubmit={search}>
                <MagnifyingGlassIcon size={17} />
                <input className="input" placeholder="Артикул или название файла" value={q} onChange={e => { setQ(e.target.value); if (!e.target.value) setFound(null); }} />
              </form>
              {busy === 'search' && <div className="rv-muted"><SpinnerIcon size={16} className="spin" /> Ищу…</div>}
              {found && !found.length && <p className="rv-muted">Ничего не нашлось.</p>}
              {found && found.length > 0 && (
                <div className="rv-doc-list">
                  {found.map(d => <DocRow key={d.id} d={d} on={sel.has(d.id)} toggle={() => toggle(d)} showFolder />)}
                </div>
              )}
            </section>
          )}

          {ov && ov.log.length > 0 && (
            <section className="rv-docs-sec">
              <h4>Уже отправляли в этом чате</h4>
              <ul className="rv-docs-log">
                {ov.log.slice(0, 6).map((l, i) => (
                  <li key={i} className={l.ok ? '' : 'rv-doc-warn'}>
                    {new Date(l.at).toLocaleString('ru-RU', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                    {' · '}{l.channel === 'email' ? `на почту ${l.to || ''}` : 'в чат'}
                    {' · '}{l.ok ? l.names.join(', ') : `не ушло: ${l.error || ''}`}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>

        {ov && (
          <footer className="rv-docs-foot">
            <div className="rv-seg" role="tablist" aria-label="Куда отправить">
              <button role="tab" aria-selected={mode === 'chat'} className={`rv-seg-btn${mode === 'chat' ? ' is-active' : ''}`} onClick={() => setMode('chat')}>
                <PaperPlaneRightIcon size={16} /> В чат {MP_NAME[mp]}
              </button>
              <button role="tab" aria-selected={mode === 'email'} className={`rv-seg-btn${mode === 'email' ? ' is-active' : ''}`} onClick={() => setMode('email')}>
                <EnvelopeSimpleIcon size={16} /> На почту
              </button>
            </div>

            {mode === 'chat' && notForChat.length > 0 && (
              <div className="rv-callout rv-callout--warn"><WarningIcon size={18} />
                <span>{notForChat.map(d => `«${d.name}»`).join(', ')} — Word и Excel в чат не уходят, площадка принимает только PDF, JPG и PNG. Отправьте их на почту или уберите галочку.</span>
              </div>
            )}
            {mode === 'chat' && mp === 'ozon' && (
              <p className="rv-muted rv-docs-tip">В чате Ozon у части покупателей файл не открывается — тогда отправьте его на почту.</p>
            )}
            {mode === 'email' && !ov.mail.ready && (
              <div className="rv-callout rv-callout--warn"><WarningIcon size={18} />
                <span>Почта магазина ещё не подключена — письма отправлять пока не с чего. Это делается один раз на сервере (нужен ящик магазина и пароль приложения).</span>
              </div>
            )}
            {mode === 'email' && ov.mail.ready && (
              <div className="rv-docs-mail">
                <label className="rv-docs-field">
                  <span>Почта покупателя</span>
                  <input className="input" type="email" placeholder="buyer@mail.ru" value={to} onChange={e => setTo(e.target.value)} list="rv-docs-emails" />
                  <datalist id="rv-docs-emails">{ov.emails.map(e => <option key={e} value={e} />)}</datalist>
                </label>
                {ov.emails.length > 0 && <span className="rv-muted rv-docs-tip">Адрес взят из сообщений покупателя — проверьте.</span>}
                <label className="rv-docs-field">
                  <span>Текст письма</span>
                  <textarea className="textarea" rows={5} value={mailText} onChange={e => setMailText(e.target.value)} />
                </label>
                <span className="rv-muted rv-docs-tip">Письмо уйдёт с адреса {ov.mail.from}. В чат после отправки напишите, что документы на почте.</span>
              </div>
            )}

            {result && (
              <div className={`rv-callout ${result.errors.length ? 'rv-callout--bad' : 'rv-callout--good'}`}>
                {result.errors.length ? <WarningIcon size={18} /> : <CheckCircleIcon size={18} />}
                <span>
                  {result.ok.length > 0 && <>Отправлено {result.where}: {result.ok.join(', ')}. </>}
                  {result.errors.join(' · ')}
                </span>
              </div>
            )}

            <div className="rv-docs-actions">
              <span className="rv-muted">
                {busy === 'send' ? 'Готовлю и отправляю — большой файл до минуты…' : picked.length ? `Выбрано: ${picked.length}` : 'Отметьте нужные файлы'}
              </span>
              <button className="btn btn-primary" disabled={!canSend} onClick={send}>
                {busy === 'send' ? <SpinnerIcon size={17} className="spin" /> : mode === 'chat' ? <PaperPlaneRightIcon size={17} /> : <EnvelopeSimpleIcon size={17} />}
                {mode === 'chat' ? ' Отправить в чат' : ' Отправить на почту'}
              </button>
            </div>
          </footer>
        )}
      </div>
    </div>
  );
}
