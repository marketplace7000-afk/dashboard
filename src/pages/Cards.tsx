/**
 * «Ведение карточек» (31.10.2026) — только владелец. Первая версия: закрепить карточку,
 * задать рамки, увидеть цифры из РНП. На площадках ничего не меняет.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiGet, apiPost, errText } from '../api/http';

type Mp = 'wb' | 'ozon';
type Goal = 'growth' | 'hold' | 'sell_out';
type Period = { orders: number; amount: number; ads: number; drrPct: number | null };
type Pin = {
  mp: Mp; sku: string; article: string; name: string; photo: string;
  goal: Goal; minMarginPct: number | null; maxDrrPct: number | null; minStockDays: number | null;
  cur: Period | null; prev: Period | null; stock: number | null; price: number | null; dataDate: string | null;
};
type Item = { sku: string; article: string; name: string; photo: string };

const GOAL_LABEL: Record<Goal, string> = { growth: 'Рост продаж', hold: 'Удержание', sell_out: 'Распродажа' };
const MP_LABEL: Record<Mp, string> = { wb: 'WB', ozon: 'Ozon' };
const rub = (n: number | null | undefined) => n == null ? '—' : `${Math.round(n).toLocaleString('ru-RU')} ₽`;
const num = (n: number | null | undefined) => n == null ? '—' : Math.round(n).toLocaleString('ru-RU');
const pct = (n: number | null | undefined) => n == null ? '—' : `${String(n).replace('.', ',')} %`;

function delta(cur?: number, prev?: number): string {
  if (cur == null || !prev) return '';
  const d = Math.round(((cur - prev) / prev) * 100);
  return ` (${d > 0 ? '+' : ''}${d} %)`;
}

/** Рамки карточки: пустое поле — рамка не задана. */
function PinSettings({ pin, onSaved }: { pin: Pin; onSaved: () => void }) {
  const [f, setF] = useState({
    goal: pin.goal, minMarginPct: pin.minMarginPct ?? '', maxDrrPct: pin.maxDrrPct ?? '', minStockDays: pin.minStockDays ?? '',
  } as { goal: Goal; minMarginPct: number | string; maxDrrPct: number | string; minStockDays: number | string });
  const [msg, setMsg] = useState('');
  const save = async () => {
    setMsg('');
    try {
      await apiPost('/api/cards/pin', { mp: pin.mp, sku: pin.sku, ...f });
      onSaved();
    } catch (e) { setMsg(errText(e)); }
  };
  const field = (key: 'minMarginPct' | 'maxDrrPct' | 'minStockDays', label: string) => (
    <label style={{ display: 'grid', gap: 4 }}>
      <span className="muted">{label}</span>
      <input className="input" inputMode="decimal" value={f[key]} onChange={e => setF({ ...f, [key]: e.target.value })} style={{ width: 120 }} />
    </label>
  );
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'end', marginTop: 12 }}>
      <label style={{ display: 'grid', gap: 4 }}>
        <span className="muted">Цель</span>
        <select className="input" value={f.goal} onChange={e => setF({ ...f, goal: e.target.value as Goal })}>
          {(Object.keys(GOAL_LABEL) as Goal[]).map(g => <option key={g} value={g}>{GOAL_LABEL[g]}</option>)}
        </select>
      </label>
      {field('minMarginPct', 'Мин. маржа, %')}
      {field('maxDrrPct', 'Макс. ДРР, %')}
      {field('minStockDays', 'Мин. запас, дней')}
      <button className="btn btn-sm" onClick={save}>Сохранить</button>
      {msg && <span style={{ color: 'var(--danger, #c00)' }}>{msg}</span>}
    </div>
  );
}

export function Cards() {
  const [pins, setPins] = useState<Pin[] | null>(null);
  const [error, setError] = useState('');
  const [mp, setMp] = useState<Mp>('wb');
  const [items, setItems] = useState<Item[]>([]);
  const [q, setQ] = useState('');

  const load = useCallback(async () => {
    try {
      setPins((await apiGet<{ pins: Pin[] }>('/api/cards')).data.pins);
      setError('');
    } catch (e) { setError(errText(e)); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    let live = true;
    apiGet<{ items: Item[] }>(`/api/cards/catalog?mp=${mp}`)
      .then(r => { if (live) setItems(r.data.items); })
      .catch(e => { if (live) setError(errText(e)); });
    return () => { live = false; };
  }, [mp, pins]);

  const found = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return [];
    return items.filter(i => `${i.article} ${i.name} ${i.sku}`.toLowerCase().includes(s)).slice(0, 8);
  }, [items, q]);

  const act = async (url: string, body: unknown) => {
    try { await apiPost(url, body); setQ(''); await load(); }
    catch (e) { setError(errText(e)); }
  };

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <div className="card">
        <p className="muted" style={{ marginTop: 0 }}>
          Агент пока только наблюдает: на площадках ничего не меняется. Запросы, конкуренты и план действий появятся следующими этапами.
        </p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          <select className="input" value={mp} onChange={e => setMp(e.target.value as Mp)} aria-label="Площадка">
            <option value="wb">WB</option>
            <option value="ozon">Ozon</option>
          </select>
          <input className="input" style={{ flex: '1 1 240px' }} placeholder="Артикул или название товара" value={q} onChange={e => setQ(e.target.value)} />
        </div>
        {found.map(i => (
          <div key={i.sku} style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 8 }}>
            <span style={{ flex: 1, minWidth: 0 }}>{i.article || i.sku} · {i.name}</span>
            <button className="btn btn-sm" onClick={() => act('/api/cards/pin', { mp, sku: i.sku })}>Закрепить</button>
          </div>
        ))}
        {q.trim() && !found.length && <div className="muted" style={{ marginTop: 8 }}>Ничего не найдено</div>}
      </div>

      {error && <div className="card" style={{ color: 'var(--danger, #c00)' }}>{error}</div>}
      {pins === null && !error && <div className="card muted">Загрузка…</div>}
      {pins?.length === 0 && <div className="card muted">Закреплённых карточек пока нет. Найдите товар выше и нажмите «Закрепить».</div>}

      {pins?.map(p => (
        <div className="card" key={`${p.mp}:${p.sku}`}>
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
            {p.photo && <img src={p.photo} alt="" width={64} height={85} style={{ objectFit: 'cover', borderRadius: 6 }} />}
            <div style={{ flex: 1, minWidth: 0 }}>
              <strong>{MP_LABEL[p.mp]} · {p.article || p.sku}</strong>
              <div className="muted">{p.name || 'Нет в справочнике РНП'}</div>
            </div>
            <button className="btn btn-sm" onClick={() => act('/api/cards/unpin', { mp: p.mp, sku: p.sku })}>Открепить</button>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 20, marginTop: 12 }}>
            <span>Заказы за 7 дней: <b>{num(p.cur?.orders)}</b>{delta(p.cur?.orders, p.prev?.orders)}</span>
            <span>Сумма: <b>{rub(p.cur?.amount)}</b>{delta(p.cur?.amount, p.prev?.amount)}</span>
            <span>Реклама: <b>{rub(p.cur?.ads)}</b></span>
            <span>ДРР: <b>{pct(p.cur?.drrPct)}</b></span>
            <span>Цена продавца: <b>{rub(p.price)}</b></span>
            <span>Остаток: <b>{num(p.stock)}</b></span>
          </div>
          {!p.cur && <div className="muted" style={{ marginTop: 8 }}>За последние 7 закрытых дней в РНП нет данных по карточке.</div>}
          {p.dataDate && <div className="muted" style={{ marginTop: 8 }}>Данные РНП по {p.dataDate.split('-').reverse().join('.')}, сравнение с предыдущими 7 днями.</div>}
          <PinSettings key={`${p.goal}|${p.minMarginPct}|${p.maxDrrPct}|${p.minStockDays}`} pin={p} onSaved={load} />
        </div>
      ))}
    </div>
  );
}
