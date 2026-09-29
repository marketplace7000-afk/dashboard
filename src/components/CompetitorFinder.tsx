import { useState } from 'react';
import { MagnifyingGlassIcon, SpinnerIcon, ArrowSquareOutIcon, StarIcon, WarningIcon } from '@phosphor-icons/react';

// «Найти конкурентов» — живой парс публичных витрин WB и Ozon по названию товара
// (бэкенд /api/competitors/search, кэш 8 часов). Показывает реальные карточки со
// ссылками. Это поиск по названию: продавцы того же товара, но БЕЗ гарантии, что
// именно они стоят за «минимальной ценой» из индекса Ozon (Ozon её не раскрывает).

type Item = {
  platform: 'wb' | 'ozon';
  id: string; name: string; seller: string | null;
  price: number; rating: number | null; reviews: number | null;
  image: string | null; url: string;
};

const fmt = (n: number) => n.toLocaleString('ru-RU') + ' ₽';

async function searchMp(mp: 'wb' | 'ozon', q: string): Promise<Item[]> {
  const r = await fetch(`/api/competitors/search?mp=${mp}&q=${encodeURIComponent(q)}&limit=8`, { credentials: 'include' });
  if (!r.ok) throw new Error(`${mp.toUpperCase()} ${r.status}`);
  const j = await r.json();
  return (j.items ?? []) as Item[];
}

export function CompetitorFinder({ query, myPrice }: { query: string; myPrice?: number }) {
  const [state, setState] = useState<'idle' | 'loading' | 'done'>('idle');
  const [items, setItems] = useState<Item[]>([]);
  const [errs, setErrs] = useState<string[]>([]);

  const run = async () => {
    setState('loading'); setErrs([]); setItems([]);
    // Обе площадки параллельно; падение одной не роняет вторую.
    const results = await Promise.allSettled([searchMp('ozon', query), searchMp('wb', query)]);
    const ok: Item[] = [];
    const bad: string[] = [];
    for (const r of results) {
      if (r.status === 'fulfilled') ok.push(...r.value);
      else bad.push(String(r.reason?.message || r.reason).slice(0, 60));
    }
    // Дешёвые вперёд; при равенстве — с большим числом отзывов.
    ok.sort((a, b) => a.price - b.price || (b.reviews ?? 0) - (a.reviews ?? 0));
    setItems(ok.slice(0, 10));
    setErrs(bad);
    setState('done');
  };

  if (state === 'idle') {
    return (
      <button className="btn btn-sm" onClick={run} title="Живой поиск по витринам WB и Ozon — реальные карточки со ссылками">
        <MagnifyingGlassIcon size={13} weight="bold" /> Найти конкурентов
      </button>
    );
  }

  if (state === 'loading') {
    return (
      <div className="row gap-8" style={{ fontSize: 12.5, color: 'var(--muted)', padding: '6px 0' }}>
        <SpinnerIcon size={14} weight="bold" className="spin" /> Ищем по витринам WB и Ozon… (до 20 сек)
      </div>
    );
  }

  return (
    <div style={{ marginTop: 4 }}>
      <div className="row gap-8" style={{ marginBottom: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <strong style={{ fontSize: 12.5 }}>Конкуренты по запросу «{query.slice(0, 60)}»</strong>
        <button className="btn btn-sm" onClick={run}>Обновить</button>
      </div>
      {errs.length > 0 && (
        <div className="row gap-6" style={{ fontSize: 12, color: 'var(--warn)', marginBottom: 6 }}>
          <WarningIcon size={13} weight="bold" /> {errs.join(' · ')} — показана вторая площадка
        </div>
      )}
      {items.length === 0 ? (
        <div className="muted" style={{ fontSize: 12.5 }}>Витрины ничего не вернули (возможно, временный блок площадки — попробуй ещё раз чуть позже).</div>
      ) : (
        <div style={{ display: 'grid', gap: 6 }}>
          {items.map((it) => {
            const cheaper = myPrice != null && myPrice > 0 && it.price > 0 && it.price < myPrice;
            return (
              <a key={`${it.platform}-${it.id}`} href={it.url} target="_blank" rel="noopener noreferrer"
                 style={{
                   display: 'flex', gap: 10, alignItems: 'center', padding: '7px 10px',
                   borderRadius: 8, border: '1px solid var(--border)', textDecoration: 'none', color: 'inherit',
                   background: cheaper ? 'rgba(220,38,38,.05)' : 'var(--bg-2)',
                 }}>
                {it.image
                  ? <img src={it.image} alt="" style={{ width: 34, height: 44, objectFit: 'cover', borderRadius: 6, flexShrink: 0 }} />
                  : <div style={{ width: 34, height: 44, borderRadius: 6, background: 'var(--bg-3)', flexShrink: 0 }} />}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.name}</div>
                  <div className="muted" style={{ fontSize: 11 }}>
                    <span style={{ color: it.platform === 'wb' ? '#cb11ab' : '#005bff', fontWeight: 700 }}>{it.platform === 'wb' ? 'WB' : 'Ozon'}</span>
                    {it.seller ? ` · ${it.seller}` : ''}
                    {it.rating ? <> · <StarIcon size={10} weight="fill" style={{ color: '#f59e0b', verticalAlign: -1 }} /> {it.rating}{it.reviews ? ` (${it.reviews})` : ''}</> : ''}
                  </div>
                </div>
                <div style={{ textAlign: 'right', flexShrink: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: 13, color: cheaper ? 'var(--bad)' : 'var(--text)' }}>{fmt(it.price)}</div>
                  {cheaper && <div style={{ fontSize: 10.5, color: 'var(--bad)' }}>дешевле нас</div>}
                </div>
                <ArrowSquareOutIcon size={14} weight="bold" style={{ color: 'var(--muted)', flexShrink: 0 }} />
              </a>
            );
          })}
        </div>
      )}
      <div className="muted" style={{ fontSize: 10.5, marginTop: 6 }}>
        Поиск по названию на публичных витринах. Это продавцы похожих/таких же товаров — Ozon не раскрывает, кто именно стоит за «минимальной ценой» индекса.
      </div>
    </div>
  );
}
