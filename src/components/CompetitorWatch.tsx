/**
 * Конкуренты одного товара: рынок + список привязок + добавление по ссылке.
 *
 * Клиент просил ровно два способа набора (переписка 11.08, 09:03):
 *  - менеджер сам цепляет по ссылке тех, кто реально важен;
 *  - система предлагает найденных, но НЕ тащит их в расчёт молча.
 * Поэтому предложенные показаны отдельным блоком с кнопкой «взять в расчёт»:
 * пока их не одобрили, на цифры рынка они не влияют.
 */
import { useCallback, useEffect, useState } from 'react';

type Link = {
  nmId: number;
  source: 'manual' | 'auto';
  status: 'active' | 'suggested' | 'ignored';
  title?: string;
  brand?: string;
  note?: string;
  price: number | null;
  priceDate?: string;
};

type Market = {
  ourPrice: number | null;
  min: number | null;
  avg: number | null;
  max: number | null;
  rank: number | null;
  total: number;
  vsMinPct: number | null;
  competitors: Link[];
  reason?: string;
};

const rub = (n: number | null | undefined) =>
  n == null ? '—' : n.toLocaleString('ru-RU') + ' ₽';

export function CompetitorWatch({ sku, ourPrice }: { sku: string; ourPrice: number | null }) {
  const [data, setData] = useState<Market | null>(null);
  const [loading, setLoading] = useState(true);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const q = `?sku=${encodeURIComponent(sku)}${ourPrice ? `&ourPrice=${Math.round(ourPrice)}` : ''}`;
      const r = await fetch(`/api/competitor-watch${q}`, { credentials: 'include' });
      setData(await r.json());
    } catch { setData(null); }
    finally { setLoading(false); }
  }, [sku, ourPrice]);

  useEffect(() => { void reload(); }, [reload]);

  const send = async (body: Record<string, unknown>, okMsg?: string) => {
    setBusy(true); setMsg(null);
    try {
      const r = await fetch('/api/competitor-watch', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sku, ...body }),
      });
      const j = await r.json();
      // Ошибку показываем текстом, а не молча ничего не делаем: чаще всего это
      // просто ссылка не с Wildberries, и человеку надо это сказать.
      if (!j.ok) setMsg(j.detail || j.error || 'Не получилось');
      else { setMsg(okMsg ?? null); setInput(''); await reload(); }
    } catch (e) { setMsg((e as Error).message); }
    finally { setBusy(false); }
  };

  const active = (data?.competitors ?? []).filter(c => c.status === 'active');
  const suggested = (data?.competitors ?? []).filter(c => c.status === 'suggested');

  return (
    <div style={{ marginTop: 14 }}>
      <div className="row gap-8" style={{ alignItems: 'center', marginBottom: 8 }}>
        <strong style={{ fontSize: 13 }}>Конкуренты и рынок</strong>
        <span className="muted" style={{ fontSize: 11 }}>Wildberries</span>
      </div>

      {/* Сводка по рынку. Если считать не по чему — пишем причину, а не прочерк. */}
      {loading ? (
        <div className="muted" style={{ fontSize: 12 }}>Загружаем…</div>
      ) : data?.reason ? (
        <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>{data.reason}</div>
      ) : (
        <div className="row gap-12" style={{ flexWrap: 'wrap', marginBottom: 10, fontSize: 12 }}>
          <span>Наша цена: <b>{rub(data?.ourPrice ?? null)}</b></span>
          <span className="muted">|</span>
          <span>Минимум по рынку: <b>{rub(data?.min ?? null)}</b></span>
          <span>Средняя: <b>{rub(data?.avg ?? null)}</b></span>
          <span>Максимум: <b>{rub(data?.max ?? null)}</b></span>
          <span className="muted">|</span>
          <span>
            Наше место: <b>{data?.rank ?? '—'}</b>
            {data?.total ? <span className="muted"> из {data.total + 1}</span> : null}
          </span>
          {data?.vsMinPct != null && (
            <span style={{ color: data.vsMinPct > 0 ? 'var(--bad)' : 'var(--good)' }}>
              {data.vsMinPct > 0
                ? `дороже минимума на ${data.vsMinPct}%`
                : `дешевле минимума на ${Math.abs(data.vsMinPct)}%`}
            </span>
          )}
        </div>
      )}

      {/* Добавление по ссылке */}
      <div className="row gap-8" style={{ marginBottom: 10, flexWrap: 'wrap' }}>
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && input.trim()) void send({ link: input.trim() }); }}
          placeholder="Ссылка на товар конкурента с Wildberries"
          style={{ flex: '1 1 320px', minWidth: 220 }}
        />
        <button
          className="btn btn-sm"
          disabled={busy || !input.trim()}
          onClick={() => void send({ link: input.trim() })}
        >
          Добавить
        </button>
      </div>
      {msg && <div className="muted" style={{ fontSize: 11, marginBottom: 8 }}>{msg}</div>}

      {/* Кого отслеживаем */}
      {active.length > 0 && (
        <table style={{ width: '100%', fontSize: 12, marginBottom: 10 }}>
          <tbody>
            {active.map(c => (
              <tr key={c.nmId}>
                <td style={{ padding: '3px 0' }}>
                  <a href={`https://www.wildberries.ru/catalog/${c.nmId}/detail.aspx`} target="_blank" rel="noreferrer">
                    {c.title || `nm${c.nmId}`}
                  </a>
                  {c.brand && <span className="muted"> · {c.brand}</span>}
                  {c.note && <span className="muted"> · {c.note}</span>}
                  {c.source === 'auto' && <span className="muted"> · найден системой</span>}
                </td>
                <td className="right" style={{ width: 110 }}>
                  <b>{rub(c.price)}</b>
                  {/* Дата замера: цена может быть вчерашней, и это надо видеть. */}
                  {c.priceDate && <div className="muted" style={{ fontSize: 10 }}>на {c.priceDate.slice(5).split('-').reverse().join('.')}</div>}
                </td>
                <td className="right" style={{ width: 90 }}>
                  <button className="btn btn-sm" disabled={busy} onClick={() => void send({ nmId: c.nmId, remove: true })}>
                    Убрать
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* Найдено системой — ждёт решения человека */}
      {suggested.length > 0 && (
        <div style={{ marginTop: 6 }}>
          <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>
            Система нашла похожие товары. В расчёт рынка они не идут, пока вы их не подтвердите.
          </div>
          {suggested.map(c => (
            <div key={c.nmId} className="row gap-8" style={{ alignItems: 'center', fontSize: 12, padding: '2px 0' }}>
              <a href={`https://www.wildberries.ru/catalog/${c.nmId}/detail.aspx`} target="_blank" rel="noreferrer" style={{ flex: 1 }}>
                {c.title || `nm${c.nmId}`}
              </a>
              <span>{rub(c.price)}</span>
              <button className="btn btn-sm" disabled={busy} onClick={() => void send({ nmId: c.nmId, status: 'active' })}>
                Взять в расчёт
              </button>
              <button className="btn btn-sm" disabled={busy} onClick={() => void send({ nmId: c.nmId, status: 'ignored' })}>
                Не мой конкурент
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
