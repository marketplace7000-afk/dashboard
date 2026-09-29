import { useMemo, useState } from 'react';
import { SpinnerIcon, ArrowsClockwiseIcon, WarningIcon, CheckCircleIcon, XCircleIcon, ImagesIcon, ArchiveIcon, ArrowUUpLeftIcon, CaretRightIcon, CaretDownIcon } from '@phosphor-icons/react';
import { OzonProductInfo } from '../api/marketplaces';
import { useLiveOzonBundle } from '../api/useLiveOzonCache';
import { archiveSKU, unarchiveSKU, getArchivedSKUs } from '../utils/procurementLogic';

type Row = OzonProductInfo & { _checks: { photos: number; nameLen: number; hasMarketingPrice: boolean } };

const isPlaceholderImage = (url: string) => !url || url.includes('placeholder');

export function LiveOzonCardAudit() {
  const bundle = useLiveOzonBundle();
  const rows: Row[] = useMemo(
    () => bundle.products.map((i) => {
      // primary_image часто заполнен даже когда images = [] (Ozon v3 quirk).
      const allImgs = [i.primary_image, ...(i.images ?? [])].filter(Boolean) as string[];
      const uniqueImgs = Array.from(new Set(allImgs)).filter((u) => !isPlaceholderImage(u));
      return {
        ...i,
        _checks: {
          photos: uniqueImgs.length,
          nameLen: i.name?.length ?? 0,
          hasMarketingPrice: !!i.marketing_price && parseFloat(i.marketing_price) > 0,
        },
      };
    }),
    [bundle]
  );
  const loading = bundle.loading && bundle.fetchedAt == null;
  const error = bundle.error;
  const load = bundle.refresh;

  // Архивация карточек (клиент: «много архивных карточек, добавить возможность
  // архивировать»). Храним в localStorage под namespace 'card-audit'.
  const [archiveTick, setArchiveTick] = useState(0);
  const [showArchive, setShowArchive] = useState(false);
  const archivedSet = useMemo(() => new Set(getArchivedSKUs('card-audit')), [archiveTick]);
  const isArchived = (offerId?: string) => archivedSet.has(String(offerId || '').toUpperCase());
  const onArchive = (offerId?: string) => {
    if (!offerId) return;
    // Хранилище браузера могло переполниться — раньше запись падала молча.
    if (!archiveSKU(offerId.toUpperCase(), 'card-audit')) {
      alert('Не удалось сохранить: в браузере кончилось место. Обновите страницу и попробуйте снова.');
      return;
    }
    setArchiveTick((t) => t + 1);
  };
  const onUnarchive = (offerId?: string) => { if (offerId) { unarchiveSKU(offerId.toUpperCase(), 'card-audit'); setArchiveTick((t) => t + 1); } };

  // Что считаем «слабой карточкой»: меньше 3 фото или название короче 40 символов
  const weakAll = rows
    .map((r) => {
      const issues: string[] = [];
      if (r._checks.photos < 3) issues.push(`${r._checks.photos} фото`);
      if (r._checks.nameLen < 40) issues.push(`короткое название (${r._checks.nameLen} симв.)`);
      if (!r._checks.hasMarketingPrice) issues.push('нет маркетинговой цены');
      return { r, issues, score: 3 - issues.length };
    })
    .filter((x) => x.issues.length > 0)
    .sort((a, b) => a.score - b.score);
  const weak = weakAll.filter((x) => !isArchived(x.r.offer_id));
  const archivedRows = rows.filter((r) => isArchived(r.offer_id));

  const stats = {
    total: rows.length,
    lowPhotos: rows.filter((r) => r._checks.photos < 3).length,
    shortName: rows.filter((r) => r._checks.nameLen < 40).length,
    avgPhotos: rows.length ? (rows.reduce((s, r) => s + r._checks.photos, 0) / rows.length).toFixed(1) : '0',
  };

  return (
    <div className="grid" style={{ gap: 20 }}>
      <div className="flex-between">
        <div className="row gap-8">
          {!loading && <span className="chip info">{rows.length} карточек проверено</span>}
          {!loading && <span className="chip warn">{weak.length} нуждаются в доработке</span>}
        </div>
        <button className="btn btn-sm" onClick={load} disabled={loading}>
          {loading
            ? <SpinnerIcon size={13} weight="bold" className="spin" />
            : <ArrowsClockwiseIcon size={13} weight="bold" />}
          Обновить
        </button>
      </div>

      <div className="card" style={{ background: 'var(--accent-soft)' }}>
        <h2 style={{ marginTop: 0 }}>Что проверяем сейчас (через Ozon API)</h2>
        <div className="grid grid-3" style={{ gap: 12, fontSize: 13 }}>
          <div className="row" style={{ gap: 8 }}>
            <CheckCircleIcon size={16} weight="fill" style={{ color: 'var(--good)' }} />
            <span>Кол-во фото в карточке</span>
          </div>
          <div className="row" style={{ gap: 8 }}>
            <CheckCircleIcon size={16} weight="fill" style={{ color: 'var(--good)' }} />
            <span>Длина названия (SEO)</span>
          </div>
          <div className="row" style={{ gap: 8 }}>
            <CheckCircleIcon size={16} weight="fill" style={{ color: 'var(--good)' }} />
            <span>Маркетинговая цена</span>
          </div>
        </div>
        <h2 style={{ fontSize: 14, marginTop: 18, marginBottom: 8 }}>Что добавим в полной версии (запрос Дмитрия)</h2>
        <div className="grid grid-2" style={{ gap: 10, fontSize: 13 }}>
          <div className="row" style={{ gap: 8 }}>
            <XCircleIcon size={16} weight="fill" style={{ color: 'var(--muted)' }} />
            <span>Сравнение нашего описания vs описаний топ-3 конкурентов (LLM-анализ)</span>
          </div>
          <div className="row" style={{ gap: 8 }}>
            <XCircleIcon size={16} weight="fill" style={{ color: 'var(--muted)' }} />
            <span>Извлечение частых проблем из отзывов и FAQ покупателей</span>
          </div>
          <div className="row" style={{ gap: 8 }}>
            <XCircleIcon size={16} weight="fill" style={{ color: 'var(--muted)' }} />
            <span>Анализ фото-сета: качество, ракурсы, инфографика</span>
          </div>
          <div className="row" style={{ gap: 8 }}>
            <XCircleIcon size={16} weight="fill" style={{ color: 'var(--muted)' }} />
            <span>Чек-лист отсутствующих характеристик (по аналогам)</span>
          </div>
        </div>
      </div>

      {loading && rows.length === 0 && (
        <div className="card muted" style={{ padding: 30, textAlign: 'center' }}>
          <SpinnerIcon size={20} weight="bold" className="spin" /> Проверяем карточки…
        </div>
      )}

      {error && (
        <div className="card" style={{ display: 'flex', gap: 10, background: 'rgba(220,38,38,.08)' }}>
          <WarningIcon size={18} weight="bold" style={{ color: 'var(--bad)' }} />
          <div className="muted">{error}</div>
        </div>
      )}

      {rows.length > 0 && (
        <>
          <div className="grid grid-4">
            <div className="card kpi">
              <div className="card-title">Всего карточек</div>
              <div className="v">{stats.total}</div>
            </div>
            <div className="card kpi">
              <div className="card-title">Среднее фото / карточка</div>
              <div className="v">{stats.avgPhotos}</div>
              <div className="d muted">Ozon рекомендует ≥ 5</div>
            </div>
            <div className="card kpi">
              <div className="card-title">Мало фото (&lt; 3)</div>
              <div className="v" style={{ color: stats.lowPhotos > 0 ? 'var(--warn)' : 'var(--good)' }}>{stats.lowPhotos}</div>
            </div>
            <div className="card kpi">
              <div className="card-title">Короткое название (&lt; 40 симв.)</div>
              <div className="v" style={{ color: stats.shortName > 0 ? 'var(--warn)' : 'var(--good)' }}>{stats.shortName}</div>
            </div>
          </div>

          {weak.length > 0 && (
            <div className="card">
              <div className="flex-between" style={{ marginBottom: 12 }}>
                <h2 style={{ margin: 0 }}>Карточки с замечаниями</h2>
                <span className="chip warn">{weak.length}</span>
              </div>
              <table>
                <thead>
                  <tr>
                    <th></th>
                    <th>Артикул</th>
                    <th>Товар</th>
                    <th className="right"><ImagesIcon size={14} weight="bold" style={{ verticalAlign: -2 }} /> Фото</th>
                    <th className="right">Длина названия</th>
                    <th>Замечания</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {weak.map(({ r, issues }) => (
                    <tr key={r.id}>
                      <td style={{ width: 36 }}>
                        {r.primary_image
                          ? <img src={r.primary_image} alt="" style={{ width: 28, height: 28, borderRadius: 6, objectFit: 'cover' }} />
                          : <div style={{ width: 28, height: 28, borderRadius: 6, background: 'var(--bg-2)' }} />}
                      </td>
                      <td className="muted" style={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12 }}>{r.offer_id}</td>
                      <td style={{ maxWidth: 360, fontSize: 13 }}>
                        <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>{r.name ?? '—'}</div>
                      </td>
                      <td className="right">{r._checks.photos}</td>
                      <td className="right">{r._checks.nameLen}</td>
                      <td>
                        <div className="row gap-8" style={{ flexWrap: 'wrap' }}>
                          {issues.map((iss) => <span key={iss} className="chip warn">{iss}</span>)}
                        </div>
                      </td>
                      <td className="right">
                        <button className="btn btn-sm" title="В архив" onClick={() => onArchive(r.offer_id)}>
                          <ArchiveIcon size={12} weight="bold" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div>
            <button className="btn btn-sm" onClick={() => setShowArchive((s) => !s)}
                    style={{ background: 'transparent', border: 'none', color: 'var(--muted)', padding: '6px 0' }}>
              {showArchive ? <CaretDownIcon size={12} weight="bold" /> : <CaretRightIcon size={12} weight="bold" />}
              Архив карточек ({archivedRows.length})
            </button>
            {showArchive && archivedRows.length > 0 && (
              <div className="card" style={{ padding: 0, marginTop: 8 }}>
                <table>
                  <thead>
                    <tr>
                      <th style={{ paddingLeft: 18 }}>Артикул / Товар</th>
                      <th className="right">Фото</th>
                      <th style={{ textAlign: 'center', paddingRight: 18 }}>Действия</th>
                    </tr>
                  </thead>
                  <tbody>
                    {archivedRows.map((r) => (
                      <tr key={r.id} style={{ opacity: 0.7 }}>
                        <td style={{ paddingLeft: 18 }}>
                          <div style={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12 }}>{r.offer_id}</div>
                          <div className="muted" style={{ fontSize: 12 }}>{r.name ?? '—'}</div>
                        </td>
                        <td className="right">{[r.primary_image, ...(r.images ?? [])].filter((u) => u && !isPlaceholderImage(u)).length}</td>
                        <td style={{ textAlign: 'center', paddingRight: 18 }}>
                          <button className="btn btn-sm" onClick={() => onUnarchive(r.offer_id)}>
                            <ArrowUUpLeftIcon size={12} weight="bold" /> Вернуть
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
