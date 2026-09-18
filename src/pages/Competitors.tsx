import { useState, useEffect } from 'react';
import { MagnifyingGlassIcon, SpinnerIcon, SparkleIcon, StarIcon, WarningIcon, ArrowSquareOutIcon, XIcon, CameraIcon, InfoIcon } from '@phosphor-icons/react';
import { competitorsSearch, competitorsCard, CompetitorItem, CompetitorCard, Platform } from '../api/competitors';
import { aiCompetitorsSummary, CompetitorsSummaryResult, aiCardAudit, CardAuditResult } from '../api/ai';

const RU = (n: number) => n.toLocaleString('ru-RU');

const PRESET_QUERIES = [
  'CarPlay адаптер',
  'CarPlay TBox',
  'Android магнитола',
  'видеорегистратор',
  'держатель MagSafe',
  'FM трансмиттер',
  'антирадар',
  'зарядка в прикуриватель',
];

export function Competitors() {
  const [mp, setMp] = useState<Platform>('wb');
  const [query, setQuery] = useState('CarPlay адаптер');
  const [items, setItems] = useState<CompetitorItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selectedOurIdx, setSelectedOurIdx] = useState<number | null>(null);
  const [summary, setSummary] = useState<CompetitorsSummaryResult | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);

  // Глубокий разбор одной карточки конкурента (фото через Claude Vision) — только WB
  const [deepItem, setDeepItem] = useState<CompetitorItem | null>(null);
  const [deepCard, setDeepCard] = useState<CompetitorCard | null>(null);
  const [deepAudit, setDeepAudit] = useState<CardAuditResult | null>(null);
  const [deepLoading, setDeepLoading] = useState(false);
  const [deepError, setDeepError] = useState<string | null>(null);

  const openDeep = async (it: CompetitorItem) => {
    setDeepItem(it); setDeepCard(null); setDeepAudit(null); setDeepError(null); setDeepLoading(true);
    try {
      const card = await competitorsCard(it.platform, it.id);
      setDeepCard(card);
      const chars = card.characteristics.map(c => `${c.name}: ${c.value}`).join('; ');
      const res = await aiCardAudit({
        name: card.name || it.name,
        brand: card.brand || it.brand || undefined,
        description: card.description,
        characteristics: chars,
        images: card.images.slice(0, 6),
        price: it.price,
      });
      setDeepAudit(res.audit);
    } catch (e: any) {
      setDeepError(e?.message || 'Ошибка разбора');
    } finally {
      setDeepLoading(false);
    }
  };
  const closeDeep = () => { setDeepItem(null); setDeepCard(null); setDeepAudit(null); setDeepError(null); };

  const run = async (q: string, platform: Platform = mp) => {
    setLoading(true);
    setError(null);
    setNotice(null);
    setSummary(null);
    setSelectedOurIdx(null);
    try {
      const res = await competitorsSearch(platform, q, 16);
      setItems(res.items);
      if (res.error) {
        setError(platform === 'ozon'
          ? 'Ozon: выдача временно недоступна (антибот/прогрев). Попробуйте позже — данные подтянет фоновый сборщик.'
          : 'WB: поиск временно ограничен. Данные обновятся автоматически.');
      } else if (res.partial) {
        setNotice('Показаны данные из кэша — свежие подтягиваются фоном.');
      }
    } catch (e: any) {
      setError(e?.message || 'Ошибка');
      setItems([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { run(query, mp); /* eslint-disable-next-line */ }, []);

  const switchMp = (next: Platform) => {
    if (next === mp) return;
    setMp(next);
    run(query, next);
  };

  const runAi = async () => {
    if (selectedOurIdx === null || items.length === 0) return;
    setAiLoading(true); setAiError(null);
    try {
      const our = items[selectedOurIdx];
      const competitors = items.filter((_, i) => i !== selectedOurIdx).slice(0, 10);
      const res = await aiCompetitorsSummary({
        query,
        our: { name: our.name, brand: our.brand, price: our.price, rating: our.rating, feedbacks: our.reviews },
        competitors: competitors.map(c => ({
          name: c.name, brand: c.brand, price: c.price, rating: c.rating, feedbacks: c.reviews,
        })),
      });
      setSummary(res.summary);
    } catch (e: any) {
      setAiError(e?.message || 'Ошибка');
    } finally {
      setAiLoading(false);
    }
  };

  const stats = items.length > 0 ? {
    avgPrice: items.reduce((s, i) => s + i.price, 0) / items.length,
    minPrice: Math.min(...items.map(i => i.price)),
    maxPrice: Math.max(...items.map(i => i.price)),
    avgRating: items.reduce((s, i) => s + (i.rating || 0), 0) / items.length,
    totalFeedbacks: items.reduce((s, i) => s + (i.reviews || 0), 0),
  } : null;

  return (
    <div className="grid" style={{ gap: 20 }}>
      <div className="row gap-8" style={{ flexWrap: 'wrap' }}>
        <button className={`mp-tab ${mp === 'wb' ? 'active' : ''}`} onClick={() => switchMp('wb')}>
          <span className="mp-tab-dot" style={{ background: '#cb11ab' }} />
          Wildberries
        </button>
        <button className={`mp-tab ${mp === 'ozon' ? 'active' : ''}`} onClick={() => switchMp('ozon')}>
          <span className="mp-tab-dot" style={{ background: '#005bff' }} />
          Ozon
        </button>
      </div>

      <div className="card" style={{ background: 'var(--accent-soft)' }}>
        <div className="row gap-8" style={{ alignItems: 'flex-start' }}>
          <SparkleIcon size={18} weight="fill" style={{ color: 'var(--accent-2)', flexShrink: 0, marginTop: 2 }} />
          <div style={{ fontSize: 13, color: 'var(--accent-2)', lineHeight: 1.55 }}>
            <strong>Парсинг конкурентов {mp === 'wb' ? 'Wildberries' : 'Ozon'}</strong> — топ выдачи по запросу.
            Данные идут из серверного кэша (фоновый сборщик с троттлом), площадка не банит.
            Выберите карточку как «нашу» — Claude сравнит её с остальными.
            {mp === 'wb' && ' Кнопка «разобрать» — анализ фото и контента через Claude Vision.'}
          </div>
        </div>
      </div>

      <div className="card">
        <form
          onSubmit={(e) => { e.preventDefault(); run(query); }}
          style={{ display: 'flex', gap: 8, marginBottom: 10 }}
        >
          <div style={{ flex: 1, position: 'relative' }}>
            <MagnifyingGlassIcon size={14} weight="bold" style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted)' }} />
            <input
              type="text"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Запрос для поиска конкурентов…"
              style={{ width: '100%', padding: '9px 12px 9px 32px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-2)', fontSize: 13 }}
            />
          </div>
          <button type="submit" className="btn btn-primary" disabled={loading}>
            {loading ? <SpinnerIcon size={14} className="spin" /> : <MagnifyingGlassIcon size={14} weight="bold" />}
            Искать
          </button>
        </form>
        <div className="row gap-8" style={{ flexWrap: 'wrap' }}>
          {PRESET_QUERIES.map(q => (
            <button
              key={q}
              className="chip"
              style={{ cursor: 'pointer', background: query === q ? 'var(--accent-soft)' : undefined }}
              onClick={() => { setQuery(q); run(q); }}
            >
              {q}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div className="card" style={{ background: 'rgba(220,38,38,.08)', display: 'flex', gap: 10 }}>
          <WarningIcon size={18} weight="bold" style={{ color: 'var(--bad)' }} />
          <div style={{ fontSize: 13 }}>{error}</div>
        </div>
      )}
      {notice && !error && (
        <div className="muted" style={{ fontSize: 12, display: 'flex', gap: 6, alignItems: 'center' }}>
          <InfoIcon size={12} weight="bold" /> {notice}
        </div>
      )}

      {stats && (
        <div className="grid grid-4">
          <div className="card kpi"><div className="card-title">Найдено карточек</div><div className="v">{items.length}</div></div>
          <div className="card kpi"><div className="card-title">Средняя цена</div><div className="v">{RU(Math.round(stats.avgPrice))} ₽</div></div>
          <div className="card kpi"><div className="card-title">Диапазон цен</div><div className="v" style={{ fontSize: 18 }}>{RU(Math.round(stats.minPrice))} – {RU(Math.round(stats.maxPrice))} ₽</div></div>
          <div className="card kpi"><div className="card-title">Средний рейтинг</div><div className="v">{stats.avgRating.toFixed(2)} <StarIcon size={14} weight="fill" style={{ color: '#f59e0b', verticalAlign: -1 }} /></div><div className="d muted">отзывов всего: {RU(stats.totalFeedbacks)}</div></div>
        </div>
      )}

      {selectedOurIdx !== null && (
        <div className="card" style={{ background: 'var(--bg-3)' }}>
          <div className="flex-between" style={{ flexWrap: 'wrap', gap: 10 }}>
            <div className="row gap-8">
              <SparkleIcon size={16} weight="fill" style={{ color: 'var(--accent)' }} />
              <strong style={{ fontSize: 14 }}>«Наша» карточка выбрана:</strong>
              <span className="muted" style={{ fontSize: 13 }}>{items[selectedOurIdx]?.name?.slice(0, 80)}…</span>
            </div>
            <button className="btn btn-primary" onClick={runAi} disabled={aiLoading}>
              {aiLoading ? <SpinnerIcon size={14} className="spin" /> : <SparkleIcon size={14} weight="fill" />}
              {aiLoading ? 'Анализирую конкурентов…' : 'Сравнить через Claude'}
            </button>
          </div>
        </div>
      )}

      {aiError && (
        <div className="card" style={{ background: 'rgba(220,38,38,.08)' }}>
          <WarningIcon size={16} weight="bold" style={{ color: 'var(--bad)' }} /> {aiError}
        </div>
      )}

      {summary && (
        <div className="card" style={{ background: 'var(--accent-soft)' }}>
          <h2 style={{ marginTop: 0, color: 'var(--accent-2)', fontSize: 16 }}>
            <SparkleIcon size={16} weight="fill" /> Анализ от Claude
          </h2>
          {summary.position && <p style={{ fontSize: 13.5, lineHeight: 1.55 }}><strong>Позиция:</strong> {summary.position}</p>}
          {summary.priceGap && <p style={{ fontSize: 13.5, lineHeight: 1.55 }}><strong>Цена:</strong> {summary.priceGap}</p>}
          {summary.ratingGap && <p style={{ fontSize: 13.5, lineHeight: 1.55 }}><strong>Рейтинг:</strong> {summary.ratingGap}</p>}
          {summary.advantages && summary.advantages.length > 0 && (
            <>
              <div style={{ marginTop: 10, fontSize: 13, fontWeight: 600 }}>Преимущества:</div>
              <ul style={{ margin: '6px 0 0', paddingLeft: 20, fontSize: 13, lineHeight: 1.65 }}>{summary.advantages.map((s, i) => <li key={i}>{s}</li>)}</ul>
            </>
          )}
          {summary.gaps && summary.gaps.length > 0 && (
            <>
              <div style={{ marginTop: 10, fontSize: 13, fontWeight: 600 }}>Где обходят:</div>
              <ul style={{ margin: '6px 0 0', paddingLeft: 20, fontSize: 13, lineHeight: 1.65 }}>{summary.gaps.map((s, i) => <li key={i}>{s}</li>)}</ul>
            </>
          )}
          {summary.actions && summary.actions.length > 0 && (
            <>
              <div style={{ marginTop: 10, fontSize: 13, fontWeight: 600 }}>Что сделать:</div>
              <ul style={{ margin: '6px 0 0', paddingLeft: 20, fontSize: 13, lineHeight: 1.65 }}>{summary.actions.map((s, i) => <li key={i}>{s}</li>)}</ul>
            </>
          )}
          {summary.raw && <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>{summary.raw}</pre>}
        </div>
      )}

      {items.length > 0 && (
        <div className="card" style={{ padding: 0 }}>
          <table>
            <thead>
              <tr>
                <th></th>
                <th style={{ width: 60 }}>#</th>
                <th>Товар</th>
                <th>Бренд / продавец</th>
                <th className="right">Цена</th>
                <th className="right">Рейтинг</th>
                <th className="right">Отзывов</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {items.map((it, i) => (
                <tr
                  key={it.id}
                  style={{ background: selectedOurIdx === i ? 'var(--accent-soft)' : undefined, cursor: 'pointer' }}
                  onClick={() => setSelectedOurIdx(i === selectedOurIdx ? null : i)}
                >
                  <td style={{ width: 30 }}>
                    <input type="radio" checked={selectedOurIdx === i} readOnly />
                  </td>
                  <td>
                    {it.image
                      ? <img src={it.image} alt="" style={{ width: 44, height: 44, objectFit: 'cover', borderRadius: 6 }} onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                      : <div style={{ width: 44, height: 44, borderRadius: 6, background: 'var(--bg-2)' }} />}
                  </td>
                  <td style={{ maxWidth: 360, fontSize: 13 }}>
                    <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
                      {it.name}
                    </div>
                    <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>{it.platform === 'wb' ? 'nmId' : 'sku'} {it.id}</div>
                  </td>
                  <td style={{ fontSize: 12 }}>
                    <div>{it.brand || '—'}</div>
                    <div className="muted" style={{ fontSize: 11 }}>{it.seller || ''}</div>
                  </td>
                  <td className="right" style={{ fontSize: 13 }}>
                    <div><strong>{RU(Math.round(it.price))} ₽</strong></div>
                    {it.oldPrice && it.oldPrice > it.price && <div className="muted" style={{ fontSize: 11, textDecoration: 'line-through' }}>{RU(Math.round(it.oldPrice))} ₽</div>}
                  </td>
                  <td className="right" style={{ fontSize: 13 }}>
                    {it.rating ? <>{it.rating.toFixed(2)} <StarIcon size={12} weight="fill" style={{ color: '#f59e0b' }} /></> : '—'}
                  </td>
                  <td className="right muted" style={{ fontSize: 12 }}>{RU(it.reviews || 0)}</td>
                  <td>
                    <div className="row gap-8" style={{ justifyContent: 'flex-end' }}>
                      {it.platform === 'wb' && (
                        <button
                          className="btn"
                          style={{ padding: '4px 8px', fontSize: 12 }}
                          onClick={(e) => { e.stopPropagation(); openDeep(it); }}
                          title="Разобрать карточку и фото через Claude Vision"
                        >
                          <CameraIcon size={13} weight="bold" /> разобрать
                        </button>
                      )}
                      <a href={it.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} style={{ color: 'var(--muted)' }}>
                        <ArrowSquareOutIcon size={14} weight="bold" />
                      </a>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {deepItem && (
        <div
          onClick={closeDeep}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.55)', zIndex: 1000, display: 'flex', justifyContent: 'center', alignItems: 'flex-start', padding: 24, overflowY: 'auto' }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="card"
            style={{ maxWidth: 860, width: '100%', marginTop: 20 }}
          >
            <div className="flex-between" style={{ marginBottom: 12 }}>
              <div className="row gap-8">
                <CameraIcon size={18} weight="fill" style={{ color: 'var(--accent)' }} />
                <strong style={{ fontSize: 15 }}>Разбор карточки конкурента</strong>
              </div>
              <button className="btn" style={{ padding: '4px 8px' }} onClick={closeDeep}><XIcon size={14} weight="bold" /></button>
            </div>

            <div style={{ fontSize: 13, marginBottom: 4 }}>{deepCard?.name || deepItem.name}</div>
            <div className="muted" style={{ fontSize: 12, marginBottom: 12 }}>
              {(deepCard?.brand || deepItem.brand) || '—'} · {deepItem.platform === 'wb' ? 'nmId' : 'sku'} {deepItem.id} · {RU(Math.round(deepItem.price))} ₽
              {deepItem.rating ? <> · {deepItem.rating.toFixed(2)}★</> : null}
              {deepCard ? <> · фото: {deepCard.photoCount}</> : null}
            </div>

            {/* Галерея фото конкурента */}
            {deepCard && deepCard.images.length > 0 && (
              <div className="row gap-8" style={{ flexWrap: 'wrap', marginBottom: 14 }}>
                {deepCard.images.map((src, i) => (
                  <img
                    key={i}
                    src={src}
                    alt=""
                    style={{ width: 96, height: 128, objectFit: 'cover', borderRadius: 6, border: '1px solid var(--border)' }}
                    onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                  />
                ))}
              </div>
            )}

            {deepLoading && (
              <div className="row gap-8 muted" style={{ fontSize: 13, padding: '12px 0' }}>
                <SpinnerIcon size={16} className="spin" /> Скачиваю фото и анализирую через Claude Vision…
              </div>
            )}
            {deepError && (
              <div className="card" style={{ background: 'rgba(220,38,38,.08)', fontSize: 13 }}>
                <WarningIcon size={15} weight="bold" style={{ color: 'var(--bad)' }} /> {deepError}
              </div>
            )}

            {deepAudit && (
              <div style={{ display: 'grid', gap: 12 }}>
                {typeof deepAudit.score === 'number' && (
                  <div className="row gap-8">
                    <SparkleIcon size={16} weight="fill" style={{ color: 'var(--accent)' }} />
                    <strong style={{ fontSize: 14 }}>Оценка карточки: {deepAudit.score}/100</strong>
                  </div>
                )}
                {renderList('Сильные стороны', deepAudit.strengths)}
                {renderList('Слабые стороны', deepAudit.weaknesses)}
                {renderList('Проблемы фото', deepAudit.photoIssues)}
                {renderList('Чего не хватает в контенте', deepAudit.missingContent)}
                {renderList('Проблемы из отзывов', deepAudit.reviewProblems)}
                {renderList('Что бы мы улучшили / переняли', deepAudit.actions)}
                {deepAudit.raw && <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>{deepAudit.raw}</pre>}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function renderList(title: string, items?: string[]) {
  if (!items || items.length === 0) return null;
  return (
    <div>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>{title}:</div>
      <ul style={{ margin: 0, paddingLeft: 20, fontSize: 13, lineHeight: 1.6 }}>
        {items.map((s, i) => <li key={i}>{s}</li>)}
      </ul>
    </div>
  );
}
