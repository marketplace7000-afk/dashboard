// Раздел «Отзывы и вопросы» — агент 2 (ТЗ-агент-отзывы v0.5, раздел 14).
// Сбор, черновики и публикация — на сервере (/api/reviews/*); здесь только экран.
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  StarIcon, ArrowsClockwiseIcon, WarningIcon, SpinnerIcon, PaperPlaneRightIcon, SparkleIcon, ArrowSquareOutIcon,
} from '@phosphor-icons/react';
import { reviewsApi, parseTelegramExport } from '../api/reviews';
import {
  DIRECTIONS, type ReviewItem, type ReviewView, type ReviewsOverview, type ReviewDirection, type KbFolder,
} from '../../shared/reviews';

const MP_COLOR = { wb: '#cb11ab', ozon: '#005bff' } as const;
const MP_NAME = { wb: 'WB', ozon: 'Ozon' } as const;

function fmtDate(ms: number | null): string {
  if (!ms) return '—';
  return new Date(ms).toLocaleString('ru-RU', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}
function ago(ms: number | null): string {
  if (!ms) return 'ещё не было';
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 1) return 'только что';
  if (m < 60) return `${m} мин назад`;
  return `${Math.round(m / 60)} ч назад`;
}
function usd(n: number): string { return `$${n.toFixed(2)}`; }

function Stars({ n }: { n: number }) {
  return (
    <span className="row" style={{ gap: 1, display: 'inline-flex' }}>
      {[1, 2, 3, 4, 5].map(i => (
        <StarIcon key={i} size={13} weight={i <= n ? 'fill' : 'regular'} style={{ color: i <= n ? '#f59e0b' : 'var(--border)' }} />
      ))}
    </span>
  );
}

type Tab = 'inbox' | 'kb' | 'log' | 'settings';

export function Reviews() {
  const [tab, setTab] = useState<Tab>('inbox');
  const [ov, setOv] = useState<ReviewsOverview | null>(null);
  const [ovErr, setOvErr] = useState<string | null>(null);
  const [collecting, setCollecting] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const loadOv = async () => {
    try { setOv(await reviewsApi.overview()); setOvErr(null); }
    catch (e: any) { setOvErr(e?.message || 'Ошибка'); }
  };
  useEffect(() => { loadOv(); const t = setInterval(loadOv, 60_000); return () => clearInterval(t); }, []);

  const collectNow = async () => {
    setCollecting(true);
    try { await reviewsApi.collect(); } catch (e: any) { alert(`Сбор не удался: ${e?.message}`); }
    setCollecting(false);
    await loadOv();
    setReloadKey(k => k + 1);
  };

  const toggleAuto = async (d: ReviewDirection, on: boolean) => {
    if (on && !confirm('Включить автоматическую публикацию? Ответы без эскалации будут уходить покупателям без вашей проверки.')) return;
    if (!ov) return;
    const r = await reviewsApi.saveSettings({ autoPublish: { ...ov.settings.autoPublish, [d]: on } });
    setOv({ ...ov, settings: r.settings });
  };

  const totalUn = ov ? Object.values(ov.counters).reduce((s, c) => s + c.unanswered, 0) : 0;
  const totalPend = ov ? Object.values(ov.counters).reduce((s, c) => s + c.pending, 0) : 0;

  return (
    <div className="grid" style={{ gap: 16 }}>
      {/* Шапка: счётчики, тумблеры, сбор, расход */}
      <div className="card" style={{ background: 'var(--bg-3)' }}>
        <div className="flex-between" style={{ flexWrap: 'wrap', gap: 12 }}>
          <div className="row gap-12" style={{ flexWrap: 'wrap' }}>
            <span><b>{totalUn}</b> <span className="muted">неотвеченных</span></span>
            <span><b>{totalPend}</b> <span className="muted">ждут решения</span></span>
            {ov && <span className="muted">Claude за месяц: {usd(ov.spendMonthUsd)} из {usd(ov.settings.monthlyBudgetUsd)} (ключ — до {usd(ov.settings.keyBudgetUsd)})</span>}
            {ov && ov.settings.monthlyBudgetUsd > 0 && ov.spendMonthUsd >= ov.settings.monthlyBudgetUsd * 0.8 && (
              <span className="chip warn"><WarningIcon size={12} /> {ov.spendMonthUsd >= ov.settings.monthlyBudgetUsd ? 'подлимит исчерпан — черновики остановлены' : 'экономный режим (80% подлимита)'}</span>
            )}
          </div>
          <button className="btn btn-sm" onClick={collectNow} disabled={collecting}>
            {collecting ? <SpinnerIcon size={14} className="spin" /> : <ArrowsClockwiseIcon size={14} />} Собрать сейчас
          </button>
        </div>
        {ovErr && <div className="chip bad" style={{ marginTop: 8 }}>{ovErr}</div>}
        {ov && (
          <div className="row gap-8" style={{ flexWrap: 'wrap', marginTop: 10 }}>
            {DIRECTIONS.map(d => {
              const c = ov.counters[d.key];
              const st = ov.collect.find(x => x.direction === d.key);
              const auto = ov.settings.autoPublish[d.key];
              const disabled = d.key === 'ozon_reviews';
              return (
                <div key={d.key} className="card" style={{ padding: '8px 10px', minWidth: 210, flex: '1 1 210px' }}>
                  <div className="flex-between">
                    <span className="row gap-8"><span className="mp-tab-dot" style={{ background: MP_COLOR[d.mp], width: 8, height: 8 }} /><b>{d.title}</b></span>
                    <label className="row" style={{ gap: 4, fontSize: 12, opacity: disabled ? 0.5 : 1 }} title="Автопубликация ответов без эскалации">
                      <input type="checkbox" checked={auto} disabled={disabled} onChange={e => toggleAuto(d.key, e.target.checked)} /> авто
                    </label>
                  </div>
                  <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                    {disabled
                      ? (st?.note || 'Нет доступа по API')
                      : <>без ответа {c.unanswered} · ждут {c.pending} · сбор {ago(st?.at ?? null)}{st && !st.ok && st.error ? <span style={{ color: 'var(--bad)' }}> · ошибка</span> : null}</>}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="period-switch" style={{ alignSelf: 'start' }}>
        {([['inbox', 'Отзывы и вопросы'], ['kb', 'База знаний'], ['log', 'Журнал'], ['settings', 'Настройки']] as [Tab, string][]).map(([k, t]) => (
          <button key={k} className={`period-btn ${tab === k ? 'active' : ''}`} onClick={() => setTab(k)}>{t}</button>
        ))}
      </div>

      {tab === 'inbox' && <Inbox key={reloadKey} counts={{ un: totalUn, pend: totalPend }} onChanged={loadOv} />}
      {tab === 'kb' && <KnowledgeBase />}
      {tab === 'log' && <LogTab />}
      {tab === 'settings' && ov && <SettingsTab ov={ov} onSaved={s => setOv({ ...ov, settings: s })} />}
    </div>
  );
}

// ─── Список ────────────────────────────────────────────────────────────────
type Filters = { mp: string; kind: string; rating: string; q: string; days: string };
const FILTERS_KEY = 'av-reviews-filters';
function loadFilters(): Filters {
  try { return { mp: '', kind: '', rating: '', q: '', days: '', ...JSON.parse(localStorage.getItem(FILTERS_KEY) || '{}') }; }
  catch { return { mp: '', kind: '', rating: '', q: '', days: '' }; }
}

function Inbox({ counts, onChanged }: { counts: { un: number; pend: number }; onChanged: () => void }) {
  const [view, setView] = useState<ReviewView>('unanswered');
  const [f, setF] = useState<Filters>(loadFilters);
  const [items, setItems] = useState<ReviewItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [bulk, setBulk] = useState<string | null>(null);
  const [limit, setLimit] = useState(50);

  useEffect(() => { try { localStorage.setItem(FILTERS_KEY, JSON.stringify(f)); } catch { /* приватный режим */ } }, [f]);

  const load = async () => {
    setLoading(true); setErr(null);
    try {
      const r = await reviewsApi.items({
        view, mp: f.mp, kind: f.kind, rating: f.rating, q: f.q.trim(),
        from: f.days ? Date.now() - Number(f.days) * 86400_000 : undefined, limit,
      });
      setItems(r.items); setTotal(r.total); setSel(new Set());
    } catch (e: any) { setErr(e?.message || 'Ошибка'); }
    setLoading(false);
  };
  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t); /* eslint-disable-next-line */ }, [view, f, limit]);

  const replace = (it: ReviewItem) => { setItems(prev => prev.map(x => (x.id === it.id ? it : x))); onChanged(); };
  const drop = (id: number) => { setItems(prev => prev.filter(x => x.id !== id)); setTotal(t => t - 1); onChanged(); };

  const publishable = items.filter(i => sel.has(i.id) && i.status === 'drafted' && i.draftAnswer);
  const bulkPublish = async () => {
    if (!publishable.length || !confirm(`Опубликовать ${publishable.length} ответов покупателям?`)) return;
    setBulk(`Публикую 0 из ${publishable.length}…`);
    const r = await reviewsApi.publishBulk(publishable.map(i => i.id)).catch((e: any) => ({ results: [{ id: 0, ok: false, error: e.message }] }));
    const bad = r.results.filter(x => !x.ok);
    setBulk(bad.length ? `Опубликовано ${r.results.length - bad.length}, ошибок ${bad.length}: ${bad[0]?.error || ''}` : `Опубликовано ${r.results.length}`);
    await load(); onChanged();
  };

  const setFilter = (patch: Partial<Filters>) => setF(prev => ({ ...prev, ...patch }));
  const ratingSet = new Set(f.rating.split(',').filter(Boolean));
  const toggleRating = (n: number) => {
    const s = new Set(ratingSet);
    s.has(String(n)) ? s.delete(String(n)) : s.add(String(n));
    setFilter({ rating: [...s].sort().join(',') });
  };

  return (
    <div className="grid" style={{ gap: 12 }}>
      <div className="flex-between" style={{ flexWrap: 'wrap', gap: 8 }}>
        <div className="period-switch">
          {([['unanswered', `Неотвеченные (${counts.un})`], ['pending', `Ждут решения (${counts.pend})`], ['answered', 'Отвеченные'], ['all', 'Все']] as [ReviewView, string][]).map(([k, t]) => (
            <button key={k} className={`period-btn ${view === k ? 'active' : ''}`} onClick={() => setView(k)}>{t}</button>
          ))}
        </div>
        <div className="row gap-8" style={{ flexWrap: 'wrap' }}>
          <select className="select" value={f.mp} onChange={e => setFilter({ mp: e.target.value })} style={{ width: 'auto' }}>
            <option value="">WB и Ozon</option><option value="wb">WB</option><option value="ozon">Ozon</option>
          </select>
          <select className="select" value={f.kind} onChange={e => setFilter({ kind: e.target.value })} style={{ width: 'auto' }}>
            <option value="">Отзывы и вопросы</option><option value="review">Отзывы</option><option value="question">Вопросы</option>
          </select>
          <div className="period-switch">
            {[1, 2, 3, 4, 5].map(n => (
              <button key={n} className={`period-btn ${ratingSet.has(String(n)) ? 'active' : ''}`} onClick={() => toggleRating(n)}>{n}★</button>
            ))}
          </div>
          <select className="select" value={f.days} onChange={e => setFilter({ days: e.target.value })} style={{ width: 'auto' }}>
            <option value="">За всё время</option><option value="1">Сутки</option><option value="7">7 дней</option><option value="30">30 дней</option>
          </select>
          <input className="input" placeholder="Артикул, товар, текст" value={f.q} onChange={e => setFilter({ q: e.target.value })} style={{ width: 200 }} />
        </div>
      </div>

      {(sel.size > 0 || bulk) && (
        <div className="row gap-8">
          {sel.size > 0 && <button className="btn btn-sm btn-primary" onClick={bulkPublish} disabled={!publishable.length}>
            <PaperPlaneRightIcon size={14} /> Опубликовать выбранные ({publishable.length})
          </button>}
          {sel.size > 0 && publishable.length < sel.size && <span className="muted" style={{ fontSize: 12 }}>публикуются только готовые черновики без эскалации</span>}
          {bulk && <span className="muted">{bulk}</span>}
        </div>
      )}

      {err && <div className="chip bad">{err}</div>}
      {loading && !items.length && <div className="muted"><SpinnerIcon size={14} className="spin" /> Загружаю…</div>}
      {!loading && !items.length && !err && <div className="card muted">Здесь пусто. {view === 'unanswered' ? 'Все отзывы и вопросы отвечены.' : ''}</div>}

      {items.map(it => (
        <ItemCard key={it.id} it={it} selected={sel.has(it.id)}
          onSelect={v => setSel(prev => { const s = new Set(prev); v ? s.add(it.id) : s.delete(it.id); return s; })}
          onReplace={replace} onDrop={view === 'unanswered' || view === 'pending' ? drop : () => { load(); onChanged(); }} />
      ))}
      {items.length < total && <button className="btn btn-sm" onClick={() => setLimit(l => l + 50)}>Показать ещё ({total - items.length})</button>}
    </div>
  );
}

function ItemCard({ it, selected, onSelect, onReplace, onDrop }: {
  it: ReviewItem; selected: boolean; onSelect: (v: boolean) => void;
  onReplace: (it: ReviewItem) => void; onDrop: (id: number) => void;
}) {
  const [text, setText] = useState(it.draftAnswer || '');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(it.publishError);
  const [open, setOpen] = useState(false);
  useEffect(() => { setText(it.draftAnswer || ''); }, [it.draftAnswer]);

  const answered = it.answeredOnMarketplace || it.status === 'published';
  const ozonReview = it.marketplace === 'ozon' && it.kind === 'review';
  const long = (it.text || '').length > 280;

  const act = async (name: string, fn: () => Promise<any>) => {
    setBusy(name); setError(null);
    try { await fn(); } catch (e: any) { setError(e?.message || 'Ошибка'); }
    setBusy(null);
  };
  const saveIfChanged = () => { if (text !== (it.draftAnswer || '')) act('save', async () => onReplace((await reviewsApi.save(it.id, text)).item)); };
  const publish = () => act('publish', async () => {
    if (!text.trim()) throw new Error('Пустой ответ');
    if (it.status === 'escalated' && !confirm(`Агент пометил: ${it.escalationReason}. Всё равно опубликовать этот ответ?`)) return;
    const r = await reviewsApi.publish(it.id, text.trim());
    if (!r.ok) throw new Error(r.error || 'Не опубликовано');
    onDrop(it.id);
  });

  const badge = answered ? <span className="chip good">отвечено{it.publishedBy === 'auto' ? ' · авто' : ''}</span>
    : it.status === 'escalated' ? <span className="chip bad">на проверку</span>
    : it.status === 'drafted' ? <span className="chip info">черновик</span>
    : it.status === 'skipped' ? <span className="chip">пропущено</span>
    : <span className="chip">новый</span>;

  return (
    <div className="card" style={{ padding: 14, borderLeft: `3px solid ${MP_COLOR[it.marketplace]}` }}>
      <div className="flex-between" style={{ gap: 8, flexWrap: 'wrap' }}>
        <div className="row gap-8" style={{ flexWrap: 'wrap' }}>
          {!answered && <input type="checkbox" checked={selected} onChange={e => onSelect(e.target.checked)} />}
          <b style={{ color: MP_COLOR[it.marketplace] }}>{MP_NAME[it.marketplace]}</b>
          <span className="muted">{it.kind === 'review' ? 'отзыв' : 'вопрос'}</span>
          {it.rating != null && <Stars n={it.rating} />}
          <span>{it.productName || it.offerId || `SKU ${it.sku || '—'}`}</span>
          {it.offerId && it.productName && <span className="muted" style={{ fontSize: 12 }}>{it.offerId}</span>}
          {it.productUrl && <a href={it.productUrl} target="_blank" rel="noreferrer" title="Открыть на площадке"><ArrowSquareOutIcon size={13} /></a>}
        </div>
        <div className="row gap-8"><span className="muted" style={{ fontSize: 12 }}>{fmtDate(it.createdAt)}</span>{badge}</div>
      </div>

      <div style={{ marginTop: 8, whiteSpace: 'pre-wrap' }}>
        {it.text ? (long && !open ? <>{it.text.slice(0, 280)}… <a onClick={() => setOpen(true)} style={{ cursor: 'pointer' }}>ещё</a></> : it.text)
          : <span className="muted">(без текста)</span>}
      </div>
      {(it.pros || it.cons) && (
        <div className="muted" style={{ fontSize: 13, marginTop: 4 }}>
          {it.pros && <div>+ {it.pros}</div>}{it.cons && <div>− {it.cons}</div>}
        </div>
      )}

      {answered ? (
        it.marketplaceAnswer ? <div style={{ marginTop: 8, padding: 8, background: 'var(--bg-3)', borderRadius: 8, whiteSpace: 'pre-wrap', fontSize: 13 }}>
          <span className="muted">Ответ магазина: </span>{it.marketplaceAnswer}</div> : null
      ) : (
        <>
          {it.escalationReason && <div style={{ color: 'var(--bad)', fontSize: 13, marginTop: 8 }}><WarningIcon size={13} /> {it.escalationReason}</div>}
          <textarea className="textarea" rows={3} style={{ marginTop: 8, width: '100%' }}
            placeholder={it.status === 'new' ? 'Черновик готовится — или напишите ответ сами' : 'Ответ покупателю'}
            value={text} onChange={e => setText(e.target.value)} onBlur={saveIfChanged} disabled={it.status === 'skipped'} />
          <div className="flex-between" style={{ marginTop: 6, flexWrap: 'wrap', gap: 8 }}>
            <span className="muted" style={{ fontSize: 12 }}>
              {it.sourcesUsed.length ? `Опора: ${it.sourcesUsed.map(s => s.split(':')[0]).filter((v, i, a) => a.indexOf(v) === i).map(s => ({ style: 'профиль стиля', card: 'карточка товара', product: 'материалы Диска', history: 'прошлые ответы', chat: 'переписка', telegram: 'Telegram' } as any)[s] || s).join(' · ')}` : ''}
              {it.draftModel && it.draftModel !== 'template' ? ` · ${it.draftModel}${it.draftCostUsd ? ` · ${usd(it.draftCostUsd)}` : ''}` : ''}
            </span>
            <div className="row gap-8">
              {it.status === 'skipped'
                ? <button className="btn btn-sm" disabled={!!busy} onClick={() => act('unskip', async () => onReplace((await reviewsApi.unskip(it.id)).item))}>Вернуть</button>
                : <>
                  <button className="btn btn-sm" disabled={!!busy} onClick={() => act('skip', async () => { await reviewsApi.skip(it.id); onDrop(it.id); })}>Пропустить</button>
                  <button className="btn btn-sm" disabled={!!busy} onClick={() => act('draft', async () => onReplace((await reviewsApi.draft(it.id)).item))}>
                    {busy === 'draft' ? <SpinnerIcon size={14} className="spin" /> : <SparkleIcon size={14} />} {it.draftAnswer ? 'Переписать' : 'Черновик'}
                  </button>
                  <button className="btn btn-sm btn-primary" disabled={!!busy || ozonReview || !text.trim()} onClick={publish}
                    title={ozonReview ? 'Ответы на отзывы Ozon — через агента на ПК (в разработке)' : ''}>
                    {busy === 'publish' ? <SpinnerIcon size={14} className="spin" /> : <PaperPlaneRightIcon size={14} />} Опубликовать
                  </button>
                </>}
            </div>
          </div>
        </>
      )}
      {error && <div className="chip bad" style={{ marginTop: 6 }}>{error}</div>}
    </div>
  );
}

// ─── База знаний ───────────────────────────────────────────────────────────
function KnowledgeBase() {
  const [kb, setKb] = useState<Awaited<ReturnType<typeof reviewsApi.kb>> | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = async () => { try { setKb(await reviewsApi.kb()); } catch (e: any) { setErr(e?.message); } };
  useEffect(() => { load(); }, []);
  useEffect(() => {
    if (!kb?.index.running) return;
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [kb?.index.running]);

  if (err) return <div className="chip bad">{err}</div>;
  if (!kb) return <div className="muted"><SpinnerIcon size={14} className="spin" /> Загружаю…</div>;

  return (
    <div className="grid" style={{ gap: 16 }}>
      <LearningBlock kb={kb} reload={load} />
      <DiskBlock kb={kb} reload={load} />
      <TelegramBlock stats={kb.telegram} reload={load} />
    </div>
  );
}

type Kb = NonNullable<Awaited<ReturnType<typeof reviewsApi.kb>>>;

/** На чём учится ИИ: наша история ответов, чаты покупателей, карточки товаров, профиль стиля. */
function LearningBlock({ kb, reload }: { kb: Kb; reload: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const run = async (key: string, fn: () => Promise<any>, ok: string) => {
    setBusy(key); setMsg(null);
    try { await fn(); setMsg(ok); reload(); } catch (e: any) { setMsg(e?.message || 'Ошибка'); } finally { setBusy(null); }
  };
  const ans = (mp: string, kind: string) => kb.history.answered.find(r => r.marketplace === mp && r.kind === kind)?.n || 0;
  const hd = kb.history.done;
  const st = (done: boolean) => done ? '' : ' · догружается';
  return (
    <div className="card">
      <div className="card-title">На чём учится ИИ</div>
      <div className="muted" style={{ fontSize: 13 }}>
        Шаблонов нет: под каждый отзыв и вопрос ИИ собирает ответ сам — по нашим прошлым ответам в кабинетах, переписке с покупателями,
        карточке товара и материалам с Диска. Всё обновляется само.
      </div>
      <table style={{ width: '100%', marginTop: 10, fontSize: 13, borderCollapse: 'collapse' }}>
        <tbody>
          <tr><td style={{ padding: '4px' }}>Наши ответы на отзывы WB</td><td>{ans('wb', 'review')}{st(hd.wb_reviews)}</td></tr>
          <tr><td style={{ padding: '4px' }}>Наши ответы на вопросы WB</td><td>{ans('wb', 'question')}{st(hd.wb_questions)}</td></tr>
          <tr><td style={{ padding: '4px' }}>Наши ответы на вопросы Ozon</td><td>{ans('ozon', 'question')}{st(hd.ozon_questions)}</td></tr>
          <tr><td style={{ padding: '4px' }}>Переписка в чатах покупателей</td><td>WB {kb.chats.wb} · Ozon {kb.chats.ozon} пар{kb.chats.at ? ` · обновлено ${ago(kb.chats.at)}` : ''}</td></tr>
          <tr><td style={{ padding: '4px' }}>Карточки товаров (описание, характеристики)</td><td>WB {kb.cards.wb} · Ozon {kb.cards.ozon}{kb.cards.at ? ` · обновлено ${ago(kb.cards.at)}` : ''}</td></tr>
          <tr><td style={{ padding: '4px' }}>Telegram</td><td>{kb.telegram.pairs} пар</td></tr>
        </tbody>
      </table>
      <div style={{ marginTop: 10 }}>
        <div className="flex-between" style={{ flexWrap: 'wrap', gap: 8 }}>
          <b style={{ fontSize: 13 }}>Профиль стиля {kb.style ? <span className="muted" style={{ fontWeight: 400 }}>· составлен {fmtDate(kb.style.at)}</span> : <span className="muted" style={{ fontWeight: 400 }}>· ещё не составлен</span>}</b>
          <div className="row gap-8">
            <button className="btn btn-sm" disabled={!!busy} onClick={() => run('src', reviewsApi.refreshSources, 'Карточки и чаты обновлены')}>
              {busy === 'src' ? <SpinnerIcon size={14} className="spin" /> : <ArrowsClockwiseIcon size={14} />} Карточки и чаты
            </button>
            <button className="btn btn-sm" disabled={!!busy} onClick={() => run('style', reviewsApi.buildStyle, 'Профиль стиля пересоставлен')}>
              {busy === 'style' ? <SpinnerIcon size={14} className="spin" /> : <ArrowsClockwiseIcon size={14} />} Пересоставить профиль
            </button>
          </div>
        </div>
        <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
          ИИ сам читает наши реальные ответы и описывает, как магазин общается с покупателями. Обновляется раз в неделю (≈ $0,05).
        </div>
        {kb.style && (
          <details style={{ marginTop: 6, fontSize: 13 }}>
            <summary>Показать профиль</summary>
            <pre style={{ whiteSpace: 'pre-wrap', maxHeight: 360, overflow: 'auto', fontSize: 12, background: 'var(--bg-3)', padding: 8, borderRadius: 8 }}>{kb.style.text}</pre>
          </details>
        )}
        {msg && <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>{msg}</div>}
      </div>
    </div>
  );
}

function DiskBlock({ kb, reload }: { kb: Kb; reload: () => void }) {
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [preview, setPreview] = useState('');
  const start = async () => { await reviewsApi.indexDisk().catch((e: any) => alert(e.message)); setTimeout(reload, 1500); };
  const show = async (p: string) => {
    if (openPath === p) { setOpenPath(null); return; }
    setOpenPath(p); setPreview('…');
    setPreview((await reviewsApi.folderText(p)).text || '(текста нет)');
  };
  const ix = kb.index;
  return (
    <div className="card">
      <div className="flex-between" style={{ flexWrap: 'wrap', gap: 8 }}>
        <div className="card-title" style={{ margin: 0 }}>Материалы по товарам (Яндекс.Диск)</div>
        <button className="btn btn-sm" onClick={start} disabled={ix.running}>
          {ix.running ? <><SpinnerIcon size={14} className="spin" /> {ix.done} из {ix.total || '…'}</> : <><ArrowsClockwiseIcon size={14} /> Обновить материалы</>}
        </button>
      </div>
      <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
        Папка проверяется сама каждые 6 часов (03, 09, 15, 21 МСК): новые папки и файлы добавляются, изменённые перечитываются, удалённые убираются.
        Word и PDF читаются на сервере бесплатно{kb.poppler ? '' : ' (PDF-модуль ещё не установлен — PDF до 3 МБ идут через Claude)'}; сканы и фото комплектации — через Claude один раз.
        {ix.current && <> Сейчас: {ix.current}</>}
      </div>
      {kb.diskSync && (
        <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
          Последняя проверка {fmtDate(kb.diskSync.at)}: новых папок {kb.diskSync.added.length}, изменённых {kb.diskSync.changed.length}, удалённых {kb.diskSync.removed.length}.
        </div>
      )}
      {kb.folders.some(f => !f.confirmed && !f.shared) && (
        <div className="chip" style={{ marginTop: 6 }}>
          Новые папки без подтверждения: {kb.folders.filter(f => !f.confirmed && !f.shared).length}. ИИ уже использует подобранные артикулы — проверьте и нажмите «Подтвердить».
        </div>
      )}
      {ix.error && <div className="chip bad" style={{ marginTop: 6 }}>{ix.error}</div>}
      {kb.folders.length > 0 && (
        <table style={{ width: '100%', marginTop: 10, fontSize: 13, borderCollapse: 'collapse' }}>
          <thead><tr className="muted" style={{ textAlign: 'left' }}><th>Папка</th><th>Артикулы</th><th>Файлы</th><th /></tr></thead>
          <tbody>
            {kb.folders.map(fd => <FolderRow key={fd.path} fd={fd} onPreview={() => show(fd.path)} open={openPath === fd.path} preview={preview} reload={reload} />)}
          </tbody>
        </table>
      )}
      {kb.withoutMaterials.length > 0 && (
        <div className="muted" style={{ fontSize: 12, marginTop: 10 }}>
          Без папки на Диске ({kb.withoutMaterials.length}) — отвечаем по карточке товара и нашей истории: {kb.withoutMaterials.slice(0, 40).join(', ')}{kb.withoutMaterials.length > 40 ? '…' : ''}
        </div>
      )}
    </div>
  );
}

function FolderRow({ fd, onPreview, open, preview, reload }: { fd: KbFolder; onPreview: () => void; open: boolean; preview: string; reload: () => void }) {
  const [v, setV] = useState(fd.offerIds.join(', '));
  const done = fd.files.filter(f => f.status === 'done').length;
  const errs = fd.files.filter(f => f.status === 'error');
  const confirmIt = async () => {
    await reviewsApi.confirmFolder(fd.path, v.split(/[,\s]+/).filter(Boolean));
    reload();
  };
  return (
    <>
      <tr style={{ borderTop: '1px solid var(--border)', background: fd.confirmed || fd.shared ? undefined : 'var(--bg-3)' }}>
        <td style={{ padding: '6px 4px' }}>{fd.path}{!fd.confirmed && !fd.shared && <span className="chip" style={{ marginLeft: 6 }}>новая</span>}</td>
        <td style={{ padding: '6px 4px' }}>
          {fd.shared && !fd.confirmed ? <span className="muted" title="Артикул не нужен: материалы этой папки ИИ берёт для вложенных папок товаров или для набора, в который она входит">общая папка — без артикула</span> : (
          <div className="row gap-8">
            <input className="input" style={{ width: 220, padding: '4px 8px' }} value={v} onChange={e => setV(e.target.value)} placeholder="артикулы через запятую" />
            {fd.confirmed && v === fd.offerIds.join(', ')
              ? <span className="chip good">подтверждено</span>
              : <button className="btn btn-sm" onClick={confirmIt}>Подтвердить</button>}
          </div>)}
        </td>
        <td style={{ padding: '6px 4px' }} className="muted">
          прочитано {done} из {fd.files.length}{errs.length ? <span style={{ color: 'var(--bad)' }} title={errs.map(e => `${e.name}: ${e.note}`).join('\n')}> · ошибок {errs.length}</span> : null}
        </td>
        <td style={{ padding: '6px 4px' }}><button className="btn btn-sm" onClick={onPreview}>{open ? 'Скрыть' : 'Текст'}</button></td>
      </tr>
      {open && <tr><td colSpan={4}><pre style={{ whiteSpace: 'pre-wrap', maxHeight: 320, overflow: 'auto', fontSize: 12, background: 'var(--bg-3)', padding: 8, borderRadius: 8 }}>{preview}</pre></td></tr>}
    </>
  );
}

function TelegramBlock({ stats, reload }: { stats: { pairs: number; dialogs: number; lastDate: string | null }; reload: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<string | null>(null);
  const onFile = async (file: File) => {
    setState('Читаю файл…');
    try {
      const json = JSON.parse(await file.text());
      const { pairs, dialogs } = parseTelegramExport(json);
      if (!pairs.length) throw new Error('В файле не нашлось пар «вопрос покупателя → ответ магазина». Нужен result.json из «Экспорта данных» Telegram Desktop в формате JSON.');
      let added = 0;
      for (let i = 0; i < pairs.length; i += 400) {
        setState(`Загружаю: ${Math.min(i + 400, pairs.length)} из ${pairs.length} пар…`);
        added += (await reviewsApi.importTg(pairs.slice(i, i + 400))).added;
      }
      setState(`Готово: диалогов ${dialogs}, пар ${pairs.length}, новых ${added}.`);
      reload();
    } catch (e: any) { setState(e?.message || 'Ошибка'); }
  };
  return (
    <div className="card">
      <div className="card-title">Архив Telegram</div>
      <div className="muted" style={{ fontSize: 13 }}>
        В базе: {stats.pairs} пар «вопрос → ответ» из {stats.dialogs} диалогов{stats.lastDate ? `, последний ответ ${stats.lastDate}` : ''}.
        Файл разбирается здесь, в браузере: на сервер уходят только пары без имён; телефоны и @username вырезаются. В GitHub архив не попадает.
      </div>
      <details style={{ marginTop: 8, fontSize: 13 }}>
        <summary>Как выгрузить</summary>
        Telegram Desktop под аккаунтом, куда пишут покупатели → Настройки → Продвинутые → «Экспорт данных из Telegram» → только «Личные чаты» →
        формат «Машиночитаемый JSON», медиа не включать → «Экспортировать». Файл result.json лежит в Загрузки\Telegram Desktop\ChatExport_ДАТА.
        Копию удобно хранить в «Рабочий стол\Agents\Agent ответов на отзывы и вопросы\02 Telegram-архивы».
      </details>
      <div className="row gap-8" style={{ marginTop: 8 }}>
        <input ref={input} type="file" accept=".json,application/json" style={{ display: 'none' }} onChange={e => e.target.files?.[0] && onFile(e.target.files[0])} />
        <button className="btn btn-sm" onClick={() => input.current?.click()}>Загрузить result.json</button>
        {state && <span className="muted" style={{ fontSize: 12 }}>{state}</span>}
      </div>
    </div>
  );
}

// ─── Журнал ────────────────────────────────────────────────────────────────
function LogTab() {
  const [d, setD] = useState<Awaited<ReturnType<typeof reviewsApi.log>> | null>(null);
  useEffect(() => { reviewsApi.log().then(setD).catch(() => setD({ log: [], usage: [] } as any)); }, []);
  const byDay = useMemo(() => {
    const m = new Map<string, { cost: number; calls: number }>();
    for (const u of d?.usage || []) { const x = m.get(u.day) || { cost: 0, calls: 0 }; x.cost += u.cost; x.calls += u.calls; m.set(u.day, x); }
    return [...m.entries()];
  }, [d]);
  if (!d) return <div className="muted"><SpinnerIcon size={14} className="spin" /> Загружаю…</div>;
  return (
    <div className="grid grid-2" style={{ gap: 16, alignItems: 'start' }}>
      <div className="card">
        <div className="card-title">Расход Claude по дням</div>
        {!byDay.length && <div className="muted">Вызовов ещё не было.</div>}
        {byDay.map(([day, x]) => <div key={day} className="flex-between" style={{ fontSize: 13 }}><span>{day}</span><span>{usd(x.cost)} · {x.calls} выз.</span></div>)}
      </div>
      <div className="card">
        <div className="card-title">События</div>
        <div style={{ maxHeight: 520, overflow: 'auto', fontSize: 12 }}>
          {d.log.map((l, i) => (
            <div key={i} style={{ padding: '4px 0', borderBottom: '1px solid var(--border)', color: l.level === 'error' ? 'var(--bad)' : l.level === 'warn' ? 'var(--warn)' : undefined }}>
              <span className="muted">{fmtDate(l.at)}</span> {l.message}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Настройки ─────────────────────────────────────────────────────────────
function SettingsTab({ ov, onSaved }: { ov: ReviewsOverview; onSaved: (s: ReviewsOverview['settings']) => void }) {
  const [s, setS] = useState(ov.settings);
  const [state, setState] = useState<string | null>(null);
  const save = async () => {
    setState('сохраняю…');
    try { const r = await reviewsApi.saveSettings(s); onSaved(r.settings); setState('сохранено'); } catch (e: any) { setState(e?.message || 'ошибка'); }
  };
  const num = (k: keyof typeof s) => (e: any) => setS({ ...s, [k]: Number(e.target.value) });
  return (
    <div className="card" style={{ maxWidth: 640 }}>
      <div className="field"><label className="field-label">Ссылка на папку Яндекс.Диска (доступ по ссылке)</label>
        <input className="input" value={s.yandexDiskUrl} onChange={e => setS({ ...s, yandexDiskUrl: e.target.value })} placeholder="https://disk.yandex.ru/d/…" /></div>
      <div className="grid grid-2" style={{ gap: 12 }}>
        <div className="field"><label className="field-label">Подлимит раздела на Claude, $ в месяц</label>
          <input className="input" type="number" min={0} step={1} value={s.monthlyBudgetUsd} onChange={num('monthlyBudgetUsd')} /></div>
        <div className="field"><label className="field-label">Общий лимит ключа, $ в месяц (для подписи)</label>
          <input className="input" type="number" min={0} step={1} value={s.keyBudgetUsd} onChange={num('keyBudgetUsd')} /></div>
        <div className="field"><label className="field-label">Отзывы с оценкой не выше — всегда на проверку</label>
          <input className="input" type="number" min={0} max={5} value={s.escalateRatingMax} onChange={num('escalateRatingMax')} /></div>
        <div className="field"><label className="field-label">Черновики после каждого сбора</label>
          <label className="row gap-8"><input type="checkbox" checked={s.autoDraft} onChange={e => setS({ ...s, autoDraft: e.target.checked })} /> готовить автоматически</label></div>
        <div className="field"><label className="field-label">Модель черновиков</label>
          <input className="input" value={s.draftModel} onChange={e => setS({ ...s, draftModel: e.target.value })} /></div>
        <div className="field"><label className="field-label">Модель чтения PDF и фото</label>
          <input className="input" value={s.indexModel} onChange={e => setS({ ...s, indexModel: e.target.value })} /></div>
      </div>
      <div className="row gap-8"><button className="btn btn-primary" onClick={save}>Сохранить</button>{state && <span className="muted">{state}</span>}</div>
    </div>
  );
}
