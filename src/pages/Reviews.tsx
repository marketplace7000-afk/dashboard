// Раздел «Отзывы и вопросы» — агент 2 (ТЗ-агент-отзывы v0.5, раздел 14).
// Сбор, черновики и публикация — на сервере (/api/reviews/*); здесь только экран.
// Вид: стили .rv- в styles.css, общие детали — components/InboxUi.tsx (13.10.2026).
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  StarIcon, ArrowsClockwiseIcon, WarningIcon, SpinnerIcon, PaperPlaneRightIcon, SparkleIcon, ArrowSquareOutIcon,
  MagnifyingGlassIcon, XIcon,
} from '@phosphor-icons/react';
import { reviewsApi, parseTelegramExport } from '../api/reviews';
import {
  DIRECTIONS, type ReviewItem, type ReviewView, type ReviewsOverview, type ReviewDirection, type KbFolder,
} from '../../shared/reviews';
import { MP_NAME, MpTag, Switch, Badge, mpVar, useAutoGrow, sourcesText } from '../components/InboxUi';

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
    <span className="rv-stars" aria-label={`Оценка ${n} из 5`}>
      {[1, 2, 3, 4, 5].map(i => (
        <StarIcon key={i} size={17} weight={i <= n ? 'fill' : 'regular'} className={i <= n ? 'on' : ''} />
      ))}
    </span>
  );
}

type Tab = 'inbox' | 'kb' | 'log' | 'settings';
const TABS: [Tab, string][] = [['inbox', 'Отзывы и вопросы'], ['kb', 'База знаний'], ['log', 'Журнал'], ['settings', 'Настройки']];

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
  const budget = ov?.settings.monthlyBudgetUsd ?? 0;
  const spend = ov?.spendMonthUsd ?? 0;
  const spendPct = budget > 0 ? Math.min(100, (spend / budget) * 100) : 0;

  return (
    <div className="rv-page">
      <section className="rv-hero">
        <div className="rv-stats">
          <div className="rv-stat">
            <span className="rv-stat-num">{ov ? totalUn : '…'}</span>
            <span className="rv-stat-label">без ответа</span>
          </div>
          <div className="rv-stat">
            <span className={`rv-stat-num${totalPend ? ' rv-stat-num--accent' : ''}`}>{ov ? totalPend : '…'}</span>
            <span className="rv-stat-label">ждут вашего решения</span>
          </div>
          {ov && (
            <div className="rv-stat rv-stat--budget" title={`Общий лимит ключа — до ${usd(ov.settings.keyBudgetUsd)} в месяц`}>
              <span className="rv-stat-label">Claude в этом месяце</span>
              <span className="rv-budget"><b>{usd(spend)}</b> из {usd(budget)}</span>
              <span className={`rv-meter${spendPct >= 100 ? ' is-bad' : spendPct >= 80 ? ' is-warn' : ''}`}><span style={{ width: `${spendPct}%` }} /></span>
            </div>
          )}
        </div>
        <button className="btn btn-primary" onClick={collectNow} disabled={collecting}>
          {collecting ? <SpinnerIcon size={17} className="spin" /> : <ArrowsClockwiseIcon size={17} />} Собрать сейчас
        </button>
      </section>

      {ov && budget > 0 && spend >= budget * 0.8 && (
        <div className="rv-callout rv-callout--warn">
          <WarningIcon size={18} />
          <span>{spend >= budget ? 'Подлимит на Claude исчерпан — новые черновики не готовятся до следующего месяца или до увеличения лимита в «Настройках».' : 'Израсходовано 80% подлимита на Claude — включён экономный режим.'}</span>
        </div>
      )}
      {ovErr && <div className="rv-callout rv-callout--bad"><WarningIcon size={18} /><span>Не удалось загрузить сводку: {ovErr}</span></div>}

      {ov && (
        <div className="rv-dirs">
          {DIRECTIONS.map(d => {
            const c = ov.counters[d.key];
            const st = ov.collect.find(x => x.direction === d.key);
            const noApi = d.key === 'ozon_reviews';
            return (
              <div key={d.key} className="rv-dir" style={mpVar(d.mp)}>
                <div className="rv-dir-title"><span className="rv-dot" />{MP_NAME[d.mp]} — {d.kind === 'review' ? 'отзывы' : 'вопросы'}</div>
                {noApi && !st?.ok
                  ? <div className="rv-dir-note">{st?.note || 'Нет доступа по API'}</div>
                  : (
                    <div className="rv-dir-nums">
                      <span><b>{c.unanswered}</b> без ответа</span>
                      <span><b>{c.pending}</b> ждут</span>
                    </div>
                  )}
                <div className="rv-dir-foot">
                  <span className={st && !st.ok && st.error ? 'rv-text-bad' : ''} title={st?.error || undefined}>
                    {st && !st.ok && st.error ? 'Ошибка сбора' : `Сбор ${ago(st?.at ?? null)}`}
                  </span>
                  {noApi
                    ? <span title="Ozon не даёт отвечать на отзывы по API — ответ вставляется в кабинете">Ответ — в кабинете Ozon</span>
                    : (
                      <Switch checked={ov.settings.autoPublish[d.key]} onChange={v => toggleAuto(d.key, v)} title="Публиковать ответы без эскалации автоматически">
                        Автоответ
                      </Switch>
                    )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <nav className="rv-tabs" role="tablist">
        {TABS.map(([k, t]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={`rv-tab${tab === k ? ' is-active' : ''}`} onClick={() => setTab(k)}>{t}</button>
        ))}
      </nav>

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
const NO_FILTERS: Filters = { mp: '', kind: '', rating: '', q: '', days: '' };
function loadFilters(): Filters {
  try { return { ...NO_FILTERS, ...JSON.parse(localStorage.getItem(FILTERS_KEY) || '{}') }; }
  catch { return { ...NO_FILTERS }; }
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
  const filtered = !!(f.mp || f.kind || f.rating || f.q.trim() || f.days);
  const views: [ReviewView, string, number | null][] = [
    ['unanswered', 'Без ответа', counts.un], ['pending', 'Ждут решения', counts.pend], ['answered', 'Отвеченные', null], ['all', 'Все', null],
  ];

  return (
    <div className="rv-inbox">
      <div className="rv-seg" role="tablist">
        {views.map(([k, t, n]) => (
          <button key={k} role="tab" aria-selected={view === k} className={`rv-seg-btn${view === k ? ' is-active' : ''}`} onClick={() => setView(k)}>
            {t}{n != null && <span className="rv-count">{n}</span>}
          </button>
        ))}
      </div>

      <div className="rv-filters">
        <label className="rv-search">
          <MagnifyingGlassIcon size={17} />
          <input className="input" placeholder="Артикул, товар или текст" value={f.q} onChange={e => setFilter({ q: e.target.value })} />
        </label>
        <select className="select" value={f.mp} onChange={e => setFilter({ mp: e.target.value })} aria-label="Площадка">
          <option value="">WB и Ozon</option><option value="wb">Только WB</option><option value="ozon">Только Ozon</option>
        </select>
        <select className="select" value={f.kind} onChange={e => setFilter({ kind: e.target.value })} aria-label="Тип">
          <option value="">Отзывы и вопросы</option><option value="review">Только отзывы</option><option value="question">Только вопросы</option>
        </select>
        <select className="select" value={f.days} onChange={e => setFilter({ days: e.target.value })} aria-label="Период">
          <option value="">За всё время</option><option value="1">За сутки</option><option value="7">За 7 дней</option><option value="30">За 30 дней</option>
        </select>
        <div className="rv-rating" role="group" aria-label="Оценка">
          {[1, 2, 3, 4, 5].map(n => (
            <button key={n} aria-pressed={ratingSet.has(String(n))} className={`rv-rating-btn${ratingSet.has(String(n)) ? ' is-on' : ''}`} onClick={() => toggleRating(n)}>
              {n}<StarIcon size={13} weight="fill" />
            </button>
          ))}
        </div>
        {filtered && <button className="rv-link" onClick={() => setF({ ...NO_FILTERS })}><XIcon size={14} /> Сбросить</button>}
      </div>

      {(sel.size > 0 || bulk) && (
        <div className="rv-bulk">
          {sel.size > 0 && <span>Выбрано: <b>{sel.size}</b>{publishable.length < sel.size ? ` · готовых к публикации ${publishable.length}` : ''}</span>}
          {bulk && <span className="rv-muted">{bulk}</span>}
          <span className="rv-spacer" />
          {sel.size > 0 && <button className="btn" onClick={() => setSel(new Set())}>Снять выбор</button>}
          {sel.size > 0 && (
            <button className="btn btn-primary" onClick={bulkPublish} disabled={!publishable.length}
              title="Публикуются только готовые черновики без пометки «на проверку»">
              <PaperPlaneRightIcon size={17} /> Опубликовать {publishable.length || ''}
            </button>
          )}
        </div>
      )}

      {err && <div className="rv-callout rv-callout--bad"><WarningIcon size={18} /><span>{err}</span></div>}
      {loading && !items.length && <div className="rv-empty"><SpinnerIcon size={20} className="spin" /> Загружаю…</div>}
      {!loading && !items.length && !err && (
        filtered
          ? <div className="rv-empty">
              <div>По выбранным фильтрам ничего нет{view === 'unanswered' && counts.un ? <>, а всего без ответа — <b>{counts.un}</b></> : ''}.</div>
              <button className="btn" onClick={() => setF({ ...NO_FILTERS })}>Сбросить фильтры</button>
            </div>
          : <div className="rv-empty">{view === 'unanswered' ? 'Все отзывы и вопросы отвечены.' : 'Здесь пока пусто.'}</div>
      )}

      <div className="rv-list">
        {items.map(it => (
          <ItemCard key={it.id} it={it} selected={sel.has(it.id)}
            onSelect={v => setSel(prev => { const s = new Set(prev); v ? s.add(it.id) : s.delete(it.id); return s; })}
            onReplace={replace} onDrop={view === 'unanswered' || view === 'pending' ? drop : () => { load(); onChanged(); }} />
        ))}
      </div>
      {items.length < total && <button className="btn rv-more" onClick={() => setLimit(l => l + 50)}>Показать ещё {Math.min(50, total - items.length)} из {total - items.length}</button>}
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
  const area = useAutoGrow(text);
  useEffect(() => { setText(it.draftAnswer || ''); }, [it.draftAnswer]);

  const answered = it.answeredOnMarketplace || it.status === 'published';
  const ozonReview = it.marketplace === 'ozon' && it.kind === 'review';
  const long = (it.text || '').length > 320;

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

  const badge = answered ? <Badge tone="good">Отвечено{it.publishedBy === 'auto' ? ' автоматически' : ''}</Badge>
    : it.status === 'escalated' ? <Badge tone="bad">На проверку</Badge>
    : it.status === 'drafted' ? <Badge tone="info">Черновик готов</Badge>
    : it.status === 'skipped' ? <Badge tone="neutral">Пропущено</Badge>
    : <Badge tone="neutral">Новый</Badge>;
  const product = it.productName || it.offerId || `SKU ${it.sku || '—'}`;
  const hint = [sourcesText(it.sourcesUsed), it.draftAnswer && it.draftModel && it.draftModel !== 'template' && it.draftCostUsd ? usd(it.draftCostUsd) : '']
    .filter(Boolean).join(' · ');

  return (
    <article className={`rv-item${selected ? ' is-selected' : ''}${it.status === 'escalated' && !answered ? ' is-escalated' : ''}`} style={mpVar(it.marketplace)}>
      <header className="rv-item-head">
        {!answered && (
          <input type="checkbox" className="rv-check" checked={selected} onChange={e => onSelect(e.target.checked)} aria-label="Выбрать для публикации" />
        )}
        <div className="rv-item-title">
          <div className="rv-item-product">
            <span>{product}</span>
            {it.productUrl && <a href={it.productUrl} target="_blank" rel="noreferrer" title="Открыть товар на площадке"><ArrowSquareOutIcon size={16} /></a>}
          </div>
          <div className="rv-item-meta">
            <MpTag mp={it.marketplace} />
            <span>{it.kind === 'review' ? 'Отзыв' : 'Вопрос'}</span>
            {it.offerId && it.productName && <span>арт. {it.offerId}</span>}
            <span>{fmtDate(it.createdAt)}</span>
          </div>
        </div>
        {badge}
      </header>

      <div className="rv-item-body">
        {it.rating != null && <Stars n={it.rating} />}
        <p className="rv-item-text">
          {it.text ? (long && !open ? <>{it.text.slice(0, 320)}… <button className="rv-link" onClick={() => setOpen(true)}>Читать целиком</button></> : it.text)
            : <span className="rv-muted">Покупатель не оставил текста</span>}
        </p>
        {(it.pros || it.cons) && (
          <dl className="rv-proscons">
            {it.pros && <div><dt>Достоинства</dt><dd>{it.pros}</dd></div>}
            {it.cons && <div><dt>Недостатки</dt><dd>{it.cons}</dd></div>}
          </dl>
        )}
      </div>

      {answered ? (
        it.marketplaceAnswer ? <div className="rv-answered"><div className="rv-label">Ответ магазина</div>{it.marketplaceAnswer}</div> : null
      ) : (
        <div className="rv-reply">
          {it.escalationReason && (
            <div className="rv-callout rv-callout--bad"><WarningIcon size={18} /><span><b>Проверьте перед отправкой.</b> {it.escalationReason}</span></div>
          )}
          <label className="rv-label" htmlFor={`rv-ans-${it.id}`}>Ответ покупателю</label>
          <textarea id={`rv-ans-${it.id}`} ref={area} className="textarea rv-textarea" rows={3}
            placeholder={it.status === 'new' ? 'Черновик готовится — или напишите ответ сами' : 'Напишите ответ покупателю'}
            value={text} onChange={e => setText(e.target.value)} onBlur={saveIfChanged} disabled={it.status === 'skipped'} />
          <div className="rv-reply-foot">
            <span className="rv-hint">{busy === 'save' ? 'Сохраняю…' : hint}</span>
            <div className="rv-actions">
              {it.status === 'skipped'
                ? <button className="btn" disabled={!!busy} onClick={() => act('unskip', async () => onReplace((await reviewsApi.unskip(it.id)).item))}>Вернуть в работу</button>
                : <>
                  <button className="btn btn-ghost" disabled={!!busy} onClick={() => act('skip', async () => { await reviewsApi.skip(it.id); onDrop(it.id); })}>Пропустить</button>
                  <button className="btn" disabled={!!busy} onClick={() => act('draft', async () => onReplace((await reviewsApi.draft(it.id)).item))}>
                    {busy === 'draft' ? <SpinnerIcon size={17} className="spin" /> : <SparkleIcon size={17} />} {it.draftAnswer ? 'Переписать' : 'Написать черновик'}
                  </button>
                  {ozonReview ? (
                    <button className="btn btn-primary" disabled={!text.trim()}
                      title="Ozon не даёт отвечать на отзывы по API: ответ копируется, открывается кабинет — вставьте его в отзыв (Ctrl+V). После ответа отзыв сам уйдёт из списка при следующем сборе."
                      onClick={async () => {
                        try { await navigator.clipboard.writeText(text.trim()); } catch { /* без буфера — откроем кабинет всё равно */ }
                        if (text !== (it.draftAnswer || '')) saveIfChanged();
                        window.open('https://seller.ozon.ru/app/reviews', '_blank', 'noopener');
                      }}>
                      <ArrowSquareOutIcon size={17} /> Скопировать и открыть Ozon
                    </button>
                  ) : (
                    <button className="btn btn-primary" disabled={!!busy || !text.trim()} onClick={publish}>
                      {busy === 'publish' ? <SpinnerIcon size={17} className="spin" /> : <PaperPlaneRightIcon size={17} />} Опубликовать
                    </button>
                  )}
                </>}
            </div>
          </div>
        </div>
      )}
      {error && <div className="rv-callout rv-callout--bad"><WarningIcon size={18} /><span>{error}</span></div>}
    </article>
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

  if (err) return <div className="rv-callout rv-callout--bad"><WarningIcon size={18} /><span>{err}</span></div>;
  if (!kb) return <div className="rv-empty"><SpinnerIcon size={20} className="spin" /> Загружаю…</div>;

  return (
    <div className="rv-stack">
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
  const rows: [string, string][] = [
    ['Наши ответы на отзывы WB', `${ans('wb', 'review')}${st(hd.wb_reviews)}`],
    ['Наши ответы на вопросы WB', `${ans('wb', 'question')}${st(hd.wb_questions)}`],
    ['Наши ответы на вопросы Ozon', `${ans('ozon', 'question')}${st(hd.ozon_questions)}`],
    ['Переписка в чатах покупателей', `WB ${kb.chats.wb}, Ozon ${kb.chats.ozon} пар${kb.chats.at ? ` · обновлено ${ago(kb.chats.at)}` : ''}`],
    ['Карточки товаров', `WB ${kb.cards.wb}, Ozon ${kb.cards.ozon}${kb.cards.at ? ` · обновлено ${ago(kb.cards.at)}` : ''}`],
    ['Архив Telegram', `${kb.telegram.pairs} пар`],
  ];
  return (
    <section className="rv-panel">
      <h2>На чём учится ИИ</h2>
      <p className="rv-sub">
        Шаблонов нет: под каждый отзыв и вопрос ИИ собирает ответ сам — по нашим прошлым ответам в кабинетах, переписке с покупателями,
        карточке товара и материалам с Диска. Всё обновляется само.
      </p>
      <dl className="rv-kv">
        {rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
      </dl>
      <div className="rv-panel-row">
        <div>
          <b>Профиль стиля</b> <span className="rv-muted">{kb.style ? `составлен ${fmtDate(kb.style.at)}` : 'ещё не составлен'}</span>
          <div className="rv-hint">ИИ сам читает наши реальные ответы и описывает, как магазин общается с покупателями. Обновляется раз в неделю (≈ $0,05).</div>
        </div>
        <div className="rv-actions">
          <button className="btn" disabled={!!busy} onClick={() => run('src', reviewsApi.refreshSources, 'Карточки и чаты обновлены')}>
            {busy === 'src' ? <SpinnerIcon size={17} className="spin" /> : <ArrowsClockwiseIcon size={17} />} Обновить карточки и чаты
          </button>
          <button className="btn" disabled={!!busy} onClick={() => run('style', reviewsApi.buildStyle, 'Профиль стиля пересоставлен')}>
            {busy === 'style' ? <SpinnerIcon size={17} className="spin" /> : <ArrowsClockwiseIcon size={17} />} Пересоставить профиль
          </button>
        </div>
      </div>
      {kb.style && (
        <details className="rv-details">
          <summary>Показать профиль стиля</summary>
          <pre className="rv-pre">{kb.style.text}</pre>
        </details>
      )}
      {msg && <div className="rv-hint">{msg}</div>}
    </section>
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
  const unconfirmed = kb.folders.filter(f => !f.confirmed && !f.shared).length;
  return (
    <section className="rv-panel">
      <div className="rv-panel-row">
        <h2>Материалы по товарам (Яндекс.Диск)</h2>
        <button className="btn" onClick={start} disabled={ix.running}>
          {ix.running ? <><SpinnerIcon size={17} className="spin" /> {ix.done} из {ix.total || '…'}</> : <><ArrowsClockwiseIcon size={17} /> Обновить материалы</>}
        </button>
      </div>
      <p className="rv-sub">
        Папка проверяется сама каждые 6 часов (03, 09, 15, 21 МСК): новые папки и файлы добавляются, изменённые перечитываются, удалённые убираются.
        Word и PDF читаются на сервере бесплатно{kb.poppler ? '' : ' (PDF-модуль ещё не установлен — PDF до 3 МБ идут через Claude)'}; сканы и фото комплектации — через Claude один раз.
        {ix.current && <> Сейчас: {ix.current}</>}
      </p>
      {kb.diskSync && (
        <div className="rv-hint">
          Последняя проверка {fmtDate(kb.diskSync.at)}: новых папок {kb.diskSync.added.length}, изменённых {kb.diskSync.changed.length}, удалённых {kb.diskSync.removed.length}.
        </div>
      )}
      {unconfirmed > 0 && (
        <div className="rv-callout rv-callout--warn">
          <WarningIcon size={18} />
          <span>Новых папок без подтверждения: {unconfirmed}. ИИ уже использует подобранные артикулы — проверьте их и нажмите «Подтвердить».</span>
        </div>
      )}
      {ix.error && <div className="rv-callout rv-callout--bad"><WarningIcon size={18} /><span>{ix.error}</span></div>}
      {kb.folders.length > 0 && (
        <div className="rv-table-wrap">
          <table className="rv-table">
            <thead><tr><th>Папка</th><th>Артикулы</th><th>Файлы</th><th /></tr></thead>
            <tbody>
              {kb.folders.map(fd => <FolderRow key={fd.path} fd={fd} onPreview={() => show(fd.path)} open={openPath === fd.path} preview={preview} reload={reload} />)}
            </tbody>
          </table>
        </div>
      )}
      {kb.withoutMaterials.length > 0 && (
        <div className="rv-hint">
          Без папки на Диске ({kb.withoutMaterials.length}) — отвечаем по карточке товара и нашей истории: {kb.withoutMaterials.slice(0, 40).join(', ')}{kb.withoutMaterials.length > 40 ? '…' : ''}
        </div>
      )}
    </section>
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
      <tr className={fd.confirmed || fd.shared ? '' : 'is-new'}>
        <td>{fd.path}{!fd.confirmed && !fd.shared && <> <Badge tone="warn">новая</Badge></>}</td>
        <td>
          {fd.shared && !fd.confirmed ? <span className="rv-muted" title="Артикул не нужен: материалы этой папки ИИ берёт для вложенных папок товаров или для набора, в который она входит">общая папка — без артикула</span> : (
          <div className="rv-inline">
            <input className="input" style={{ width: 220 }} value={v} onChange={e => setV(e.target.value)} placeholder="артикулы через запятую" />
            {fd.confirmed && v === fd.offerIds.join(', ')
              ? <Badge tone="good">подтверждено</Badge>
              : <button className="btn" onClick={confirmIt}>Подтвердить</button>}
          </div>)}
        </td>
        <td className="rv-muted">
          прочитано {done} из {fd.files.length}{errs.length ? <span className="rv-text-bad" title={errs.map(e => `${e.name}: ${e.note}`).join('\n')}> · ошибок {errs.length}</span> : null}
        </td>
        <td><button className="btn btn-ghost" onClick={onPreview}>{open ? 'Скрыть' : 'Текст'}</button></td>
      </tr>
      {open && <tr><td colSpan={4}><pre className="rv-pre">{preview}</pre></td></tr>}
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
    <section className="rv-panel">
      <h2>Архив Telegram</h2>
      <p className="rv-sub">
        В базе: {stats.pairs} пар «вопрос → ответ» из {stats.dialogs} диалогов{stats.lastDate ? `, последний ответ ${stats.lastDate}` : ''}.
        Файл разбирается здесь, в браузере: на сервер уходят только пары без имён; телефоны и @username вырезаются. В GitHub архив не попадает.
      </p>
      <details className="rv-details">
        <summary>Как выгрузить архив</summary>
        <p className="rv-sub">
          Telegram Desktop под аккаунтом, куда пишут покупатели → Настройки → Продвинутые → «Экспорт данных из Telegram» → только «Личные чаты» →
          формат «Машиночитаемый JSON», медиа не включать → «Экспортировать». Файл result.json лежит в Загрузки\Telegram Desktop\ChatExport_ДАТА.
          Копию удобно хранить в «Рабочий стол\Agents\Agent ответов на отзывы и вопросы\02 Telegram-архивы».
        </p>
      </details>
      <div className="rv-inline">
        <input ref={input} type="file" accept=".json,application/json" style={{ display: 'none' }} onChange={e => e.target.files?.[0] && onFile(e.target.files[0])} />
        <button className="btn" onClick={() => input.current?.click()}>Загрузить result.json</button>
        {state && <span className="rv-hint">{state}</span>}
      </div>
    </section>
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
  if (!d) return <div className="rv-empty"><SpinnerIcon size={20} className="spin" /> Загружаю…</div>;
  return (
    <div className="rv-log">
      <section className="rv-panel">
        <h2>Расход Claude по дням</h2>
        {!byDay.length && <div className="rv-muted">Вызовов ещё не было.</div>}
        <dl className="rv-kv">
          {byDay.map(([day, x]) => <div key={day}><dt>{day}</dt><dd>{usd(x.cost)} · {x.calls} выз.</dd></div>)}
        </dl>
      </section>
      <section className="rv-panel">
        <h2>События</h2>
        <ul className="rv-events">
          {d.log.map((l, i) => (
            <li key={i} className={l.level === 'error' ? 'rv-text-bad' : l.level === 'warn' ? 'rv-text-warn' : ''}>
              <time>{fmtDate(l.at)}</time> {l.message}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

// ─── Настройки ─────────────────────────────────────────────────────────────
function SettingsTab({ ov, onSaved }: { ov: ReviewsOverview; onSaved: (s: ReviewsOverview['settings']) => void }) {
  const [s, setS] = useState(ov.settings);
  const [state, setState] = useState<string | null>(null);
  const save = async () => {
    setState('Сохраняю…');
    try { const r = await reviewsApi.saveSettings(s); onSaved(r.settings); setState('Сохранено'); } catch (e: any) { setState(e?.message || 'Ошибка'); }
  };
  const num = (k: keyof typeof s) => (e: any) => setS({ ...s, [k]: Number(e.target.value) });
  return (
    <section className="rv-panel rv-settings">
      <div className="field"><label className="field-label">Ссылка на папку Яндекс.Диска (доступ по ссылке)</label>
        <input className="input" value={s.yandexDiskUrl} onChange={e => setS({ ...s, yandexDiskUrl: e.target.value })} placeholder="https://disk.yandex.ru/d/…" /></div>
      <div className="rv-settings-grid">
        <div className="field"><label className="field-label">Подлимит раздела на Claude, $ в месяц</label>
          <input className="input" type="number" min={0} step={1} value={s.monthlyBudgetUsd} onChange={num('monthlyBudgetUsd')} /></div>
        <div className="field"><label className="field-label">Общий лимит ключа, $ в месяц (для подписи)</label>
          <input className="input" type="number" min={0} step={1} value={s.keyBudgetUsd} onChange={num('keyBudgetUsd')} /></div>
        <div className="field"><label className="field-label">Отзывы с оценкой не выше — всегда на проверку</label>
          <input className="input" type="number" min={0} max={5} value={s.escalateRatingMax} onChange={num('escalateRatingMax')} /></div>
        <div className="field"><label className="field-label">Черновики после каждого сбора</label>
          <Switch checked={s.autoDraft} onChange={v => setS({ ...s, autoDraft: v })}>Готовить автоматически</Switch></div>
        <div className="field"><label className="field-label">Модель черновиков</label>
          <input className="input" value={s.draftModel} onChange={e => setS({ ...s, draftModel: e.target.value })} /></div>
        <div className="field"><label className="field-label">Модель чтения PDF и фото</label>
          <input className="input" value={s.indexModel} onChange={e => setS({ ...s, indexModel: e.target.value })} /></div>
      </div>
      <div className="rv-inline"><button className="btn btn-primary" onClick={save}>Сохранить настройки</button>{state && <span className="rv-hint">{state}</span>}</div>
    </section>
  );
}
