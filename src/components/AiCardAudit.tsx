import { useState } from 'react';
import { SparkleIcon, SpinnerIcon, ImagesIcon, CheckCircleIcon, WarningIcon, XCircleIcon, MagnifyingGlassIcon } from '@phosphor-icons/react';
import { useLiveOzonBundle } from '../api/useLiveOzonCache';
import { aiCardAudit, CardAuditResult } from '../api/ai';

const isPlaceholder = (u: string) => !u || u.includes('placeholder');

export function AiCardAudit() {
  const bundle = useLiveOzonBundle();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [filter, setFilter] = useState('');
  const [audit, setAudit] = useState<CardAuditResult | null>(null);
  const [photosAnalyzed, setPhotosAnalyzed] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [duration, setDuration] = useState<number | null>(null);

  const photoCount = (p: typeof bundle.products[number]) => {
    const all = [p.primary_image, ...(p.images || [])].filter(Boolean) as string[];
    return Array.from(new Set(all)).filter(u => !isPlaceholder(u)).length;
  };

  const products = bundle.products
    .filter(p => !filter || p.name?.toLowerCase().includes(filter.toLowerCase()) || p.offer_id?.toLowerCase().includes(filter.toLowerCase()))
    .slice(0, 50);
  const selected = bundle.products.find(p => p.id === selectedId);

  const runAudit = async (forceRefresh = false) => {
    if (!selected) return;
    setLoading(true);
    setError(null);
    if (forceRefresh) setAudit(null);
    const t0 = Date.now();
    try {
      // Объединяем primary_image + images, дедуплицируем, чистим placeholder'ы.
      // Ozon v3/product/info/list иногда отдаёт пустой images, оставляя только primary_image.
      const allUrls = [selected.primary_image, ...(selected.images || [])].filter(Boolean) as string[];
      const imgs = Array.from(new Set(allUrls)).filter(u => !isPlaceholder(u)).slice(0, 6);
      const res = await aiCardAudit({
        name: selected.name,
        images: imgs,
        price: selected.price ? parseFloat(selected.price) : undefined,
      }, { noCache: forceRefresh });
      setAudit(res.audit);
      setPhotosAnalyzed(res.photosAnalyzed);
      setDuration(Date.now() - t0);
    } catch (e: any) {
      setError(e?.message || 'Ошибка');
    } finally {
      setLoading(false);
    }
  };

  if (bundle.loading && bundle.products.length === 0) {
    return <div className="card muted" style={{ padding: 30, textAlign: 'center' }}><SpinnerIcon size={20} className="spin" /> Загружаем карточки Ozon…</div>;
  }
  if (bundle.error) {
    return <div className="card" style={{ background: 'rgba(220,38,38,.08)' }}>{bundle.error}</div>;
  }

  return (
    <div className="grid" style={{ gap: 16 }}>
      <div className="card" style={{ background: 'var(--accent-soft)' }}>
        <div className="row gap-8" style={{ alignItems: 'flex-start' }}>
          <SparkleIcon size={18} weight="fill" style={{ color: 'var(--accent-2)', flexShrink: 0, marginTop: 2 }} />
          <div style={{ fontSize: 13, color: 'var(--accent-2)', lineHeight: 1.55 }}>
            <strong>AI-аудит карточки через Claude Sonnet 4.6.</strong> Анализируется до 6 фото товара (vision) + название, описание, характеристики, цена.
            Стоимость одного аудита ~0.5–1.5 ₽ в зависимости от количества фото. Ответы кэшируются на 6 часов.
          </div>
        </div>
      </div>

      <div className="grid" style={{ gridTemplateColumns: '380px 1fr', gap: 16 }}>
        {/* Левая колонка: список карточек */}
        <div className="card" style={{ padding: 12, maxHeight: 700, overflow: 'auto' }}>
          <div className="row gap-8" style={{ marginBottom: 10, alignItems: 'center' }}>
            <MagnifyingGlassIcon size={14} weight="bold" />
            <input
              type="text"
              placeholder="Найти товар или артикул…"
              value={filter}
              onChange={e => setFilter(e.target.value)}
              style={{ flex: 1, padding: '6px 10px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-2)', fontSize: 13 }}
            />
          </div>
          <div className="muted" style={{ fontSize: 11, marginBottom: 8 }}>{products.length} из {bundle.products.length} карточек</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {products.map(p => (
              <div
                key={p.id}
                onClick={() => { setSelectedId(p.id); setAudit(null); setError(null); }}
                style={{
                  display: 'flex', gap: 10, padding: 8, borderRadius: 8, cursor: 'pointer',
                  background: selectedId === p.id ? 'var(--accent-soft)' : 'transparent',
                  border: `1px solid ${selectedId === p.id ? 'var(--accent)' : 'transparent'}`,
                }}
              >
                {p.primary_image
                  ? <img src={p.primary_image} alt="" style={{ width: 44, height: 44, borderRadius: 6, objectFit: 'cover', flexShrink: 0 }} />
                  : <div style={{ width: 44, height: 44, borderRadius: 6, background: 'var(--bg-2)', flexShrink: 0 }} />}
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 12, lineHeight: 1.35, overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>{p.name || '—'}</div>
                  <div className="muted" style={{ fontSize: 10, marginTop: 2 }}>{p.offer_id} · {photoCount(p)} фото</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Правая колонка: предпросмотр + аудит */}
        <div className="grid" style={{ gap: 12, alignContent: 'start' }}>
          {!selected && (
            <div className="card muted" style={{ padding: 30, textAlign: 'center' }}>
              <ImagesIcon size={32} weight="duotone" style={{ opacity: 0.5 }} />
              <div style={{ marginTop: 10 }}>Выберите карточку слева, чтобы запустить AI-аудит.</div>
            </div>
          )}

          {selected && (
            <>
              <div className="card">
                <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>{selected.name}</div>
                <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
                  Артикул: <code>{selected.offer_id}</code> · Цена: {selected.price ? `${parseFloat(selected.price).toLocaleString('ru-RU')} ₽` : '—'} · Фото: {photoCount(selected)}
                </div>
                <div className="row gap-8" style={{ flexWrap: 'wrap', marginBottom: 12 }}>
                  {Array.from(new Set([selected.primary_image, ...(selected.images || [])].filter(Boolean) as string[])).filter(u => !isPlaceholder(u)).slice(0, 6).map((url, i) => (
                    <img key={i} src={url} alt="" style={{ width: 80, height: 80, objectFit: 'cover', borderRadius: 6, border: '1px solid var(--border)' }} />
                  ))}
                </div>
                <div className="row gap-8">
                  <button className="btn btn-primary" onClick={() => runAudit(false)} disabled={loading}>
                    {loading ? <SpinnerIcon size={14} className="spin" /> : <SparkleIcon size={14} weight="fill" />}
                    {loading ? 'Анализирую…' : audit ? 'Повторить аудит' : 'Запустить AI-аудит'}
                  </button>
                  {audit && (
                    <button className="btn btn-sm" onClick={() => runAudit(true)} disabled={loading}>
                      Обновить (без кэша)
                    </button>
                  )}
                </div>
              </div>

              {error && (
                <div className="card" style={{ background: 'rgba(220,38,38,.08)', display: 'flex', gap: 10 }}>
                  <WarningIcon size={18} weight="bold" style={{ color: 'var(--bad)' }} />
                  <div style={{ fontSize: 13 }}>{error}</div>
                </div>
              )}

              {audit && (
                <div className="grid" style={{ gap: 12 }}>
                  {typeof audit.score === 'number' && (
                    <div className="card kpi">
                      <div className="card-title">Общая оценка карточки</div>
                      <div className="v" style={{ color: audit.score >= 75 ? 'var(--good)' : audit.score >= 50 ? 'var(--warn)' : 'var(--bad)' }}>
                        {audit.score}/100
                      </div>
                      {photosAnalyzed > 0 && (
                        <div className="d muted">проанализировано {photosAnalyzed} фото · {duration ? `${(duration / 1000).toFixed(1)}с` : ''}</div>
                      )}
                    </div>
                  )}

                  <Section title="Сильные стороны" icon={<CheckCircleIcon size={16} weight="fill" style={{ color: 'var(--good)' }} />} items={audit.strengths} />
                  <Section title="Слабые места" icon={<XCircleIcon size={16} weight="fill" style={{ color: 'var(--bad)' }} />} items={audit.weaknesses} />
                  <Section title="Проблемы с фото" icon={<ImagesIcon size={16} weight="fill" style={{ color: 'var(--warn)' }} />} items={audit.photoIssues} />
                  <Section title="Чего не хватает в контенте" icon={<XCircleIcon size={16} weight="fill" style={{ color: 'var(--warn)' }} />} items={audit.missingContent} />
                  <Section title="Проблемы из отзывов" icon={<WarningIcon size={16} weight="fill" style={{ color: 'var(--warn)' }} />} items={audit.reviewProblems} />
                  <Section title="Что сделать" icon={<SparkleIcon size={16} weight="fill" style={{ color: 'var(--accent)' }} />} items={audit.actions} highlight />

                  {audit.raw && (
                    <div className="card muted" style={{ fontSize: 12, whiteSpace: 'pre-wrap' }}>
                      <div style={{ marginBottom: 6, fontWeight: 600 }}>Сырой ответ (не удалось распарсить JSON):</div>
                      {audit.raw}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Section({ title, icon, items, highlight }: { title: string; icon: React.ReactNode; items?: string[]; highlight?: boolean }) {
  if (!items || items.length === 0) return null;
  return (
    <div className="card" style={highlight ? { background: 'var(--accent-soft)' } : undefined}>
      <div className="row gap-8" style={{ marginBottom: 10, alignItems: 'center' }}>
        {icon}
        <strong style={{ fontSize: 14 }}>{title}</strong>
      </div>
      <ul style={{ margin: 0, paddingLeft: 20, lineHeight: 1.7, fontSize: 13 }}>
        {items.map((s, i) => <li key={i}>{s}</li>)}
      </ul>
    </div>
  );
}
