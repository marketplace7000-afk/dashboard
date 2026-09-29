import { useEffect, useState } from 'react';
import {
  StarIcon, ChatCircleTextIcon, ArrowsClockwiseIcon, CheckCircleIcon, WarningIcon, InfoIcon, ArchiveIcon, CalendarBlankIcon, SparkleIcon, SpinnerIcon, CopyIcon, PaperPlaneRightIcon,
} from '@phosphor-icons/react';
import { wbFeedbacks, wbAnswerFeedback, WbFeedback, wbQuestions, WbQuestion, wbAnswerQuestion } from '../api/marketplaces';
import { aiReviewReply } from '../api/ai';

type View = 'unanswered' | 'archive';

function fmtDate(iso: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: 'short', year: 'numeric' });
}

function Stars({ n }: { n: number }) {
  return (
    <div className="row" style={{ gap: 1 }}>
      {[1, 2, 3, 4, 5].map(i => (
        <StarIcon
          key={i}
          size={14}
          weight={i <= n ? 'fill' : 'regular'}
          style={{ color: i <= n ? '#f59e0b' : 'var(--border)' }}
        />
      ))}
    </div>
  );
}

type AiState = { reply?: string; loading: boolean; error?: string };

/** Детерминированный хеш строки — чтобы у одного отзыва всегда был один шаблон. */
function hashCode(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  return h;
}

function WbReviewsPanel() {
  const [view, setView] = useState<View>('unanswered');
  const [feedbacks, setFeedbacks] = useState<WbFeedback[]>([]);
  const [counts, setCounts] = useState<{ unanswered: number; archive: number }>({ unanswered: 0, archive: 0 });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [starFilter, setStarFilter] = useState<number | 'all'>('all');
  const [aiByFb, setAiByFb] = useState<Record<string, AiState>>({});
  const [sendByFb, setSendByFb] = useState<Record<string, { sending?: boolean; sent?: boolean; error?: string }>>({});
  const [bulk, setBulk] = useState<{ running: boolean; done: number; total: number; failed: number } | null>(null);

  // Отзыв без текста — только оценка. Гонять Claude ради «спасибо» на 449 таких
  // отзывов значит платить за каждую «пятёрку»; благодарность и так одинаковая.
  // Claude — только там, где есть что читать.
  const THANKS = [
    'Спасибо за оценку! Рады, что товар вам подошёл. Если появятся вопросы — мы на связи.',
    'Благодарим за пятёрку! Приятно, что покупка оправдала ожидания.',
    'Спасибо, что нашли время оценить товар! Будем рады видеть вас снова.',
  ];
  const draftFor = async (f: WbFeedback): Promise<string> => {
    if (!(f.text || '').trim()) return THANKS[Math.abs(hashCode(f.id)) % THANKS.length];
    const r = await aiReviewReply({ text: f.text || '', rating: f.productValuation, productName: f.productDetails?.productName });
    return r.reply;
  };

  const submitReply = async (f: WbFeedback, text: string) => {
    if (!text.trim()) return;
    setSendByFb(prev => ({ ...prev, [f.id]: { sending: true } }));
    const r = await wbAnswerFeedback(f.id, text.trim());
    if (r.ok) {
      setSendByFb(prev => ({ ...prev, [f.id]: { sent: true } }));
      setFeedbacks(prev => prev.filter(x => x.id !== f.id));   // ушёл в архив
      setCounts(c => ({ unanswered: Math.max(0, c.unanswered - 1), archive: c.archive + 1 }));
    } else {
      setSendByFb(prev => ({ ...prev, [f.id]: { error: r.error || 'Ошибка отправки' } }));
    }
    return r.ok;
  };

  // «Ответить на все»: последовательно, чтобы не упереться в лимиты WB и не
  // выстрелить сотней запросов к Claude разом. Прогресс виден, ошибки не
  // останавливают остальных.
  const answerAll = async () => {
    const list = feedbacks.filter(f => !f.answer);
    if (!list.length || !confirm(`Ответить на ${list.length} отзывов и опубликовать в WB?`)) return;
    setBulk({ running: true, done: 0, total: list.length, failed: 0 });
    let failed = 0;
    for (const [i, f] of list.entries()) {
      try {
        const text = aiByFb[f.id]?.reply || await draftFor(f);
        const ok = await submitReply(f, text);
        if (!ok) failed++;
      } catch { failed++; }
      setBulk({ running: true, done: i + 1, total: list.length, failed });
      await new Promise(r => setTimeout(r, 400));
    }
    setBulk({ running: false, done: list.length, total: list.length, failed });
  };

  const genReply = async (f: WbFeedback) => {
    setAiByFb(prev => ({ ...prev, [f.id]: { loading: true } }));
    try {
      const r = await aiReviewReply({
        text: f.text || '',
        rating: f.productValuation,
        productName: f.productDetails?.productName,
      });
      setAiByFb(prev => ({ ...prev, [f.id]: { loading: false, reply: r.reply } }));
    } catch (e: any) {
      setAiByFb(prev => ({ ...prev, [f.id]: { loading: false, error: e?.message || 'Ошибка' } }));
    }
  };

  // force — по кнопке «Обновить»: сходить в WB, а не перечитать кэш. Без этого
  // ответы, опубликованные на площадке, появлялись в кабинете через 2 часа.
  const load = async (force = false) => {
    setLoading(true);
    setError(null);
    try {
      const r = await wbFeedbacks({ isAnswered: view === 'archive', take: 50, force });
      setFeedbacks(r.feedbacks || []);
      setCounts({ unanswered: r.countUnanswered, archive: r.countArchive });
    } catch (e: any) {
      setError(e?.message || 'Ошибка');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [view]);

  // Распределение по звёздам
  const starDist = [5, 4, 3, 2, 1].map(s => ({
    stars: s,
    count: feedbacks.filter(f => f.productValuation === s).length,
  }));
  const avgRating = feedbacks.length
    ? feedbacks.reduce((s, f) => s + (f.productValuation || 0), 0) / feedbacks.length
    : 0;

  const filtered = starFilter === 'all'
    ? feedbacks
    : feedbacks.filter(f => f.productValuation === starFilter);

  return (
    <div className="grid" style={{ gap: 16 }}>
      {/* Шапка статуса */}
      <div className="card" style={{ background: 'var(--bg-3)' }}>
        <div className="flex-between" style={{ flexWrap: 'wrap', gap: 12 }}>
          <div className="row gap-12" style={{ flexWrap: 'wrap' }}>
            <div className="row gap-8">
              <span className="mp-tab-dot" style={{ background: '#cb11ab', width: 10, height: 10 }} />
              <strong style={{ fontSize: 14 }}>Wildberries Feedbacks</strong>
            </div>
            {error
              ? <span className="chip bad"><WarningIcon size={11} weight="bold" /> ошибка</span>
              : loading
                ? <span className="chip"><SpinnerIcon size={11} weight="bold" className="spin" /> загрузка</span>
                : <span className="chip good"><CheckCircleIcon size={11} weight="bold" /> подключено</span>}
            <span className="muted" style={{ fontSize: 12 }}>
              неотвеченных: <b style={{ color: 'var(--bad)' }}>{counts.unanswered}</b> · в архиве: <b style={{ color: 'var(--text)' }}>{counts.archive}</b>
            </span>
          </div>
          <div className="row gap-8">
            {view === 'unanswered' && (
              <button className="btn" onClick={() => void answerAll()} disabled={loading || !!bulk?.running}
                title="Сгенерировать ответы и опубликовать в WB по всем неотвеченным, по одному">
                {bulk?.running ? <SpinnerIcon size={14} className="spin" /> : <PaperPlaneRightIcon size={14} weight="bold" />}
                {bulk?.running ? `Отвечаю ${bulk.done}/${bulk.total}` : 'Ответить на все'}
              </button>
            )}
            <button className="btn btn-primary" onClick={() => load(true)} disabled={loading}>
              <ArrowsClockwiseIcon size={14} weight="bold" className={loading ? 'spin' : ''} />
              {loading ? 'Загрузка…' : 'Обновить'}
            </button>
          </div>
        </div>
        {bulk && !bulk.running && (
          <div className="muted" style={{ fontSize: 12.5, marginTop: 8 }}>
            Опубликовано {bulk.done - bulk.failed} из {bulk.total}{bulk.failed ? `, не удалось ${bulk.failed} — они остались в списке` : ''}.
          </div>
        )}
      </div>

      {error && (
        <div className="card" style={{ background: 'rgba(220,38,38,.08)', color: 'var(--bad)', display: 'flex', gap: 10 }}>
          <WarningIcon size={18} weight="bold" />
          <span style={{ fontSize: 13 }}>{error}</span>
        </div>
      )}

      {/* KPI */}
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>
        <div className="card kpi">
          <span className="d muted"><ChatCircleTextIcon size={11} weight="bold" /> Неотвеченных</span>
          <span className="v" style={{ color: counts.unanswered > 0 ? 'var(--bad)' : 'var(--good)' }}>{counts.unanswered}</span>
        </div>
        <div className="card kpi">
          <span className="d muted"><ArchiveIcon size={11} weight="bold" /> В архиве</span>
          <span className="v">{counts.archive.toLocaleString('ru-RU')}</span>
        </div>
        <div className="card kpi">
          <span className="d muted">Средняя оценка (показано)</span>
          <span className="v" style={{ color: avgRating >= 4.5 ? 'var(--good)' : avgRating >= 4 ? 'var(--warn)' : 'var(--bad)' }}>
            {feedbacks.length ? avgRating.toFixed(2) : '—'}
          </span>
          {feedbacks.length > 0 && <Stars n={Math.round(avgRating)} />}
        </div>
        <div className="card kpi">
          <span className="d muted">★ 1–3 в подборке</span>
          <span className="v" style={{ color: 'var(--bad)' }}>
            {feedbacks.filter(f => f.productValuation <= 3).length}
          </span>
        </div>
        <div className="card kpi">
          <span className="d muted">★ 5 в подборке</span>
          <span className="v" style={{ color: 'var(--good)' }}>
            {feedbacks.filter(f => f.productValuation === 5).length}
          </span>
        </div>
      </div>

      {/* Фильтры */}
      <div className="row gap-12" style={{ flexWrap: 'wrap' }}>
        <div className="period-switch">
          <button className={`period-btn ${view === 'unanswered' ? 'active' : ''}`} onClick={() => setView('unanswered')}>
            Неотвеченные ({counts.unanswered})
          </button>
          <button className={`period-btn ${view === 'archive' ? 'active' : ''}`} onClick={() => setView('archive')}>
            Архив
          </button>
        </div>
        <div className="period-switch">
          <button className={`period-btn ${starFilter === 'all' ? 'active' : ''}`} onClick={() => setStarFilter('all')}>Все ★</button>
          {[5, 4, 3, 2, 1].map(s => (
            <button key={s} className={`period-btn ${starFilter === s ? 'active' : ''}`} onClick={() => setStarFilter(s)}>
              {s}★ ({starDist.find(d => d.stars === s)?.count || 0})
            </button>
          ))}
        </div>
      </div>

      {/* Список */}
      {filtered.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: 32, color: 'var(--muted)' }}>
          {loading ? 'Загружаем…' : view === 'unanswered' ? '🎉 Нет неотвеченных отзывов!' : 'В архиве пусто'}
        </div>
      ) : (
        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(440px, 1fr))', gap: 12 }}>
          {filtered.map(f => {
            const rating = f.productValuation || 0;
            const isNeg = rating <= 3;
            return (
              <div key={f.id} className="card" style={{
                padding: 16,
                background: isNeg ? 'rgba(220,38,38,.06)' : rating === 4 ? 'rgba(217,119,6,.06)' : 'var(--bg-2)',
              }}>
                <div className="flex-between" style={{ marginBottom: 8, alignItems: 'flex-start' }}>
                  <div>
                    <div className="row gap-8" style={{ marginBottom: 4 }}>
                      <Stars n={rating} />
                      <span style={{ fontWeight: 600, fontSize: 13 }}>{rating}/5</span>
                    </div>
                    <div className="muted" style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}>
                      <CalendarBlankIcon size={11} weight="bold" /> {fmtDate(f.createdDate)}
                      {f.userName && <> · {f.userName}</>}
                    </div>
                  </div>
                  {f.answer && (
                    <span className="chip good"><CheckCircleIcon size={10} weight="bold" /> отвечено</span>
                  )}
                </div>

                {f.productDetails && (
                  <div style={{ fontSize: 12, marginBottom: 8, color: 'var(--accent)', fontWeight: 500 }}>
                    {f.productDetails.productName} · nmId {f.productDetails.nmId}
                  </div>
                )}

                <div style={{ fontSize: 13, lineHeight: 1.5, marginBottom: 8, whiteSpace: 'pre-wrap' }}>
                  {f.text || <span className="muted" style={{ fontStyle: 'italic' }}>— только оценка, без текста —</span>}
                </div>

                {f.answer && (
                  <div style={{
                    background: 'var(--bg-3)',
                    borderRadius: 8,
                    padding: '8px 10px',
                    fontSize: 12,
                    lineHeight: 1.45,
                    color: 'var(--muted)',
                    borderLeft: '2px solid var(--accent)',
                  }}>
                    <div style={{ fontWeight: 600, fontSize: 11, marginBottom: 2, color: 'var(--accent)' }}>Ваш ответ:</div>
                    {f.answer.text}
                  </div>
                )}

                {!f.answer && (() => {
                  const a = aiByFb[f.id];
                  return (
                    <div style={{ marginTop: 8 }}>
                      {!a?.reply && (
                        <button
                          className="btn btn-sm"
                          onClick={() => genReply(f)}
                          disabled={a?.loading}
                          style={{ background: 'var(--accent-soft)', color: 'var(--accent-2)' }}
                        >
                          {a?.loading ? <SpinnerIcon size={12} className="spin" /> : <SparkleIcon size={12} weight="fill" />}
                          {a?.loading ? 'Генерирую…' : 'Сгенерировать ответ через Claude'}
                        </button>
                      )}
                      {a?.error && (
                        <div style={{ color: 'var(--bad)', fontSize: 12, marginTop: 6 }}>
                          <WarningIcon size={12} weight="bold" /> {a.error}
                        </div>
                      )}
                      {a?.reply && (
                        <div style={{
                          background: 'var(--accent-soft)', borderRadius: 8, padding: '10px 12px', fontSize: 12.5,
                          lineHeight: 1.5, color: 'var(--accent-2)', borderLeft: '2px solid var(--accent)',
                        }}>
                          <div className="flex-between" style={{ marginBottom: 4 }}>
                            <div style={{ fontWeight: 600, fontSize: 11 }}>
                              <SparkleIcon size={11} weight="fill" /> Черновик ответа от Claude:
                            </div>
                            <div className="row gap-8">
                              <button className="btn btn-sm btn-primary" title="Опубликовать ответ в WB"
                                disabled={sendByFb[f.id]?.sending || sendByFb[f.id]?.sent}
                                onClick={() => void submitReply(f, a.reply || '')}>
                                {sendByFb[f.id]?.sending ? <SpinnerIcon size={11} className="spin" /> : <PaperPlaneRightIcon size={11} weight="bold" />}
                                {sendByFb[f.id]?.sent ? 'Отправлено ✓' : 'Отправить в WB'}
                              </button>
                              <button
                                className="btn btn-sm"
                                title="Скопировать"
                                onClick={() => navigator.clipboard?.writeText(a.reply || '')}
                              >
                                <CopyIcon size={11} weight="bold" /> Копировать
                              </button>
                              <button
                                className="btn btn-sm"
                                title="Сгенерировать заново"
                                onClick={() => genReply(f)}
                              >
                                <ArrowsClockwiseIcon size={11} weight="bold" />
                              </button>
                            </div>
                          </div>
                          <div style={{ whiteSpace: 'pre-wrap' }}>{a.reply}</div>
                          {sendByFb[f.id]?.error && (
                            <div style={{ color: 'var(--bad)', fontSize: 12, marginTop: 6 }}>
                              <WarningIcon size={12} weight="bold" /> {sendByFb[f.id]?.error}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })()}
              </div>
            );
          })}
        </div>
      )}

      <div className="muted" style={{ fontSize: 11, display: 'flex', gap: 6, alignItems: 'center' }}>
        <InfoIcon size={12} weight="bold" />
        Источник — WB Feedbacks API <code>/api/v1/feedbacks</code>. Лимит 50 отзывов за запрос.
        Автогенерация ответов через Claude — после привязки модуля «Отзывы → черновики».
      </div>
    </div>
  );
}

function WbQuestionsPanel() {
  const [view, setView] = useState<View>('unanswered');
  const [questions, setQuestions] = useState<WbQuestion[]>([]);
  const [counts, setCounts] = useState<{ unanswered: number; archive: number }>({ unanswered: 0, archive: 0 });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [aiByQ, setAiByQ] = useState<Record<string, AiState>>({});
  const [sendByQ, setSendByQ] = useState<Record<string, { sending?: boolean; sent?: boolean; error?: string }>>({});

  const submitAnswer = async (q: WbQuestion, text: string) => {
    if (!text.trim()) return;
    setSendByQ(prev => ({ ...prev, [q.id]: { sending: true } }));
    const r = await wbAnswerQuestion(q.id, text.trim());
    if (r.ok) {
      setSendByQ(prev => ({ ...prev, [q.id]: { sent: true } }));
      setQuestions(prev => prev.filter(x => x.id !== q.id)); // ушёл в отвеченные
      setCounts(c => ({ ...c, unanswered: Math.max(0, c.unanswered - 1) }));
    } else {
      setSendByQ(prev => ({ ...prev, [q.id]: { error: r.error || 'Ошибка отправки' } }));
    }
  };

  const [bulk, setBulk] = useState<{ running: boolean; done: number; total: number; failed: number } | null>(null);

  // «Ответить на все» для вопросов: черновик от Claude → публикация, по одному,
  // чтобы не упереться в лимиты WB. Уже сгенерированный черновик переиспользуем.
  const answerAll = async () => {
    const list = questions.filter(q => !q.answer);
    if (!list.length || !confirm(`Ответить на ${list.length} вопросов и опубликовать в WB?`)) return;
    setBulk({ running: true, done: 0, total: list.length, failed: 0 });
    let failed = 0;
    for (const [i, q] of list.entries()) {
      try {
        let text = aiByQ[q.id]?.reply;
        if (!text) {
          const r = await aiReviewReply({
            text: q.text || '', productName: q.productDetails?.productName,
            tone: 'Это ВОПРОС покупателя о товаре. Дай конкретный, полезный, вежливый ответ на вопрос (без «спасибо за отзыв»).',
          });
          text = r.reply;
        }
        const r = await wbAnswerQuestion(q.id, (text || '').trim());
        if (r.ok) {
          setQuestions(prev => prev.filter(x => x.id !== q.id));
          setCounts(c => ({ ...c, unanswered: Math.max(0, c.unanswered - 1) }));
        } else failed++;
      } catch { failed++; }
      setBulk({ running: true, done: i + 1, total: list.length, failed });
      await new Promise(r => setTimeout(r, 400));
    }
    setBulk({ running: false, done: list.length, total: list.length, failed });
  };

  const genAnswer = async (q: WbQuestion) => {
    setAiByQ(prev => ({ ...prev, [q.id]: { loading: true } }));
    try {
      // Переиспользуем движок ответов: tone указывает, что это ВОПРОС о товаре —
      // Claude даёт конкретный полезный ответ, а не отзыв-реплай.
      const r = await aiReviewReply({
        text: q.text || '',
        productName: q.productDetails?.productName,
        tone: 'Это ВОПРОС покупателя о товаре. Дай конкретный, полезный, вежливый ответ на вопрос (без «спасибо за отзыв»).',
      });
      setAiByQ(prev => ({ ...prev, [q.id]: { loading: false, reply: r.reply } }));
    } catch (e: any) {
      setAiByQ(prev => ({ ...prev, [q.id]: { loading: false, error: e?.message || 'Ошибка' } }));
    }
  };

  const load = async (force = false) => {
    setLoading(true);
    setError(null);
    try {
      const r = await wbQuestions({ isAnswered: view === 'archive', take: 50, force });
      setQuestions(r.questions || []);
      setCounts({ unanswered: r.countUnanswered, archive: r.countArchive });
    } catch (e: any) {
      setError(e?.message || 'Ошибка');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [view]);

  return (
    <div className="grid" style={{ gap: 16 }}>
      <div className="card" style={{ background: 'var(--bg-3)' }}>
        <div className="flex-between" style={{ flexWrap: 'wrap', gap: 12 }}>
          <div className="row gap-12" style={{ flexWrap: 'wrap' }}>
            <div className="row gap-8">
              <span className="mp-tab-dot" style={{ background: '#cb11ab', width: 10, height: 10 }} />
              <strong style={{ fontSize: 14 }}>Wildberries · вопросы о товаре</strong>
            </div>
            {error
              ? <span className="chip bad"><WarningIcon size={11} weight="bold" /> ошибка</span>
              : loading
                ? <span className="chip"><SpinnerIcon size={11} weight="bold" className="spin" /> загрузка</span>
                : <span className="chip good"><CheckCircleIcon size={11} weight="bold" /> подключено</span>}
            <span className="muted" style={{ fontSize: 12 }}>
              без ответа: <b style={{ color: 'var(--bad)' }}>{counts.unanswered}</b> · в архиве: <b>{counts.archive}</b>
            </span>
          </div>
          <div className="row gap-8">
            {view === 'unanswered' && (
              <button className="btn" onClick={() => void answerAll()} disabled={loading || !!bulk?.running}
                title="Сгенерировать ответы и опубликовать в WB по всем неотвеченным, по одному">
                {bulk?.running ? <SpinnerIcon size={14} className="spin" /> : <PaperPlaneRightIcon size={14} weight="bold" />}
                {bulk?.running ? `Отвечаю ${bulk.done}/${bulk.total}` : 'Ответить на все'}
              </button>
            )}
            <button className="btn btn-primary" onClick={() => load(true)} disabled={loading}>
              <ArrowsClockwiseIcon size={14} weight="bold" className={loading ? 'spin' : ''} />
              {loading ? 'Загрузка…' : 'Обновить'}
            </button>
          </div>
        </div>
        {bulk && !bulk.running && (
          <div className="muted" style={{ fontSize: 12.5, marginTop: 8 }}>
            Опубликовано {bulk.done - bulk.failed} из {bulk.total}{bulk.failed ? `, не удалось ${bulk.failed} — они остались в списке` : ''}.
          </div>
        )}
      </div>

      {error && (
        <div className="card" style={{ background: 'rgba(220,38,38,.08)', color: 'var(--bad)', display: 'flex', gap: 10 }}>
          <WarningIcon size={18} weight="bold" />
          <span style={{ fontSize: 13 }}>{error}</span>
        </div>
      )}

      <div className="row gap-12" style={{ flexWrap: 'wrap' }}>
        <div className="period-switch">
          <button className={`period-btn ${view === 'unanswered' ? 'active' : ''}`} onClick={() => setView('unanswered')}>
            Без ответа ({counts.unanswered})
          </button>
          <button className={`period-btn ${view === 'archive' ? 'active' : ''}`} onClick={() => setView('archive')}>
            Архив
          </button>
        </div>
      </div>

      {questions.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: 32, color: 'var(--muted)' }}>
          {loading ? 'Загружаем…' : view === 'unanswered' ? '🎉 Нет вопросов без ответа!' : 'В архиве пусто'}
        </div>
      ) : (
        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(440px, 1fr))', gap: 12 }}>
          {questions.map(q => (
            <div key={q.id} className="card" style={{ padding: 16, background: q.answer ? 'var(--bg-2)' : 'rgba(217,119,6,.06)' }}>
              <div className="flex-between" style={{ marginBottom: 8, alignItems: 'flex-start' }}>
                <div className="muted" style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}>
                  <CalendarBlankIcon size={11} weight="bold" /> {fmtDate(q.createdDate)}
                  {q.userName && <> · {q.userName}</>}
                </div>
                {q.answer
                  ? <span className="chip good"><CheckCircleIcon size={10} weight="bold" /> отвечено</span>
                  : <span className="chip warn"><WarningIcon size={10} weight="bold" /> без ответа</span>}
              </div>
              {q.productDetails && (
                <div style={{ fontSize: 12, marginBottom: 8, color: 'var(--accent)', fontWeight: 500 }}>
                  {q.productDetails.productName} · nmId {q.productDetails.nmId}
                </div>
              )}
              <div style={{ fontSize: 13, lineHeight: 1.5, marginBottom: 8, whiteSpace: 'pre-wrap' }}>{q.text}</div>
              {q.answer && (
                <div style={{ background: 'var(--bg-3)', borderRadius: 8, padding: '8px 10px', fontSize: 12, lineHeight: 1.45, color: 'var(--muted)', borderLeft: '2px solid var(--accent)' }}>
                  <div style={{ fontWeight: 600, fontSize: 11, marginBottom: 2, color: 'var(--accent)' }}>Ваш ответ:</div>
                  {q.answer.text}
                </div>
              )}
              {!q.answer && (() => {
                const a = aiByQ[q.id];
                return (
                  <div style={{ marginTop: 8 }}>
                    {!a?.reply && (
                      <button className="btn btn-sm" onClick={() => genAnswer(q)} disabled={a?.loading}
                        style={{ background: 'var(--accent-soft)', color: 'var(--accent-2)' }}>
                        {a?.loading ? <SpinnerIcon size={12} className="spin" /> : <SparkleIcon size={12} weight="fill" />}
                        {a?.loading ? 'Генерирую…' : 'Сгенерировать ответ через Claude'}
                      </button>
                    )}
                    {a?.error && (
                      <div style={{ color: 'var(--bad)', fontSize: 12, marginTop: 6 }}>
                        <WarningIcon size={12} weight="bold" /> {a.error}
                      </div>
                    )}
                    {a?.reply && (
                      <div style={{ background: 'var(--accent-soft)', borderRadius: 8, padding: '10px 12px', fontSize: 12.5, lineHeight: 1.5, color: 'var(--accent-2)', borderLeft: '2px solid var(--accent)' }}>
                        <div className="flex-between" style={{ marginBottom: 4 }}>
                          <div style={{ fontWeight: 600, fontSize: 11 }}>
                            <SparkleIcon size={11} weight="fill" /> Черновик ответа от Claude:
                          </div>
                          <div className="row gap-8">
                            <button className="btn btn-sm btn-primary" title="Опубликовать ответ в WB"
                              disabled={sendByQ[q.id]?.sending || sendByQ[q.id]?.sent}
                              onClick={() => submitAnswer(q, a.reply || '')}>
                              {sendByQ[q.id]?.sending ? <SpinnerIcon size={11} className="spin" /> : <PaperPlaneRightIcon size={11} weight="bold" />}
                              {sendByQ[q.id]?.sent ? 'Отправлено ✓' : 'Отправить в WB'}
                            </button>
                            <button className="btn btn-sm" title="Скопировать" onClick={() => navigator.clipboard?.writeText(a.reply || '')}>
                              <CopyIcon size={11} weight="bold" /> Копировать
                            </button>
                            <button className="btn btn-sm" title="Сгенерировать заново" onClick={() => genAnswer(q)}>
                              <ArrowsClockwiseIcon size={11} weight="bold" />
                            </button>
                          </div>
                        </div>
                        <div style={{ whiteSpace: 'pre-wrap' }}>{a.reply}</div>
                        {sendByQ[q.id]?.error && (
                          <div style={{ color: 'var(--bad)', fontSize: 11, marginTop: 4 }}>
                            <WarningIcon size={11} weight="bold" /> {sendByQ[q.id]?.error}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })()}
            </div>
          ))}
        </div>
      )}

      <div className="muted" style={{ fontSize: 11, display: 'flex', gap: 6, alignItems: 'center' }}>
        <InfoIcon size={12} weight="bold" />
        Источник — WB Feedbacks API <code>/api/v1/questions</code>. Прогревается фоновым сборщиком.
      </div>
    </div>
  );
}

function OzonReviewsPanel() {
  return (
    <div className="card" style={{ background: 'var(--accent-soft)' }}>
      <div className="row gap-8" style={{ alignItems: 'flex-start' }}>
        <InfoIcon size={18} weight="bold" style={{ color: 'var(--accent-2)', flexShrink: 0, marginTop: 2 }} />
        <div>
          <div style={{ fontWeight: 600, color: 'var(--accent-2)' }}>Ozon Reviews API требует Premium-подписку</div>
          <div style={{ fontSize: 13, color: 'var(--accent-2)', marginTop: 6, lineHeight: 1.5 }}>
            <code>/v1/review/list</code> отвечает <i>«not available with existing subscription»</i>.
            Чтобы тянуть отзывы Ozon — нужно подключить тариф «Premium» в кабинете продавца.
            После подключения добавлю аналогичный блок с фильтрами/звёздами/ответами как для WB.
          </div>
        </div>
      </div>
    </div>
  );
}

export function Reviews() {
  const [mp, setMp] = useState<'wb' | 'wb-q' | 'ozon'>('wb');
  return (
    <div className="grid" style={{ gap: 20 }}>
      <div className="row gap-8" style={{ flexWrap: 'wrap' }}>
        <button className={`mp-tab ${mp === 'wb' ? 'active' : ''}`} onClick={() => setMp('wb')}>
          <span className="mp-tab-dot" style={{ background: '#cb11ab' }} />
          WB · Отзывы
          <span className="muted" style={{ marginLeft: 6 }}>live</span>
        </button>
        <button className={`mp-tab ${mp === 'wb-q' ? 'active' : ''}`} onClick={() => setMp('wb-q')}>
          <span className="mp-tab-dot" style={{ background: '#cb11ab' }} />
          WB · Вопросы
          <span className="muted" style={{ marginLeft: 6 }}>о товаре</span>
        </button>
        <button className={`mp-tab ${mp === 'ozon' ? 'active' : ''}`} onClick={() => setMp('ozon')}>
          <span className="mp-tab-dot" style={{ background: '#005bff' }} />
          Ozon
          <span className="muted" style={{ marginLeft: 6 }}>требует Premium</span>
        </button>
      </div>
      {mp === 'wb' ? <WbReviewsPanel /> : mp === 'wb-q' ? <WbQuestionsPanel /> : <OzonReviewsPanel />}
    </div>
  );
}
