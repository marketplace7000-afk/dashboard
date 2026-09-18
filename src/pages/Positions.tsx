/**
 * Позиции по ключевикам — где наш товар (nmId) стоит в поиске WB по запросу.
 * История проверок хранится в localStorage, чтобы видеть динамику позиции.
 */
import { useState } from 'react';
import { MagnifyingGlassIcon, ArrowsClockwiseIcon, WarningIcon, TrendUpIcon, TrendDownIcon, MinusIcon, TrashIcon } from '@phosphor-icons/react';
import { wbPosition, WbPosition } from '../api/competitors';

type Tracked = { id: string; query: string; nmId: number; history: { at: number; position: number | null }[] };
const LS_KEY = 'wb-positions:v1';

function load(): Tracked[] {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || '[]'); } catch { return []; }
}
function save(rows: Tracked[]) { localStorage.setItem(LS_KEY, JSON.stringify(rows)); }

function fmtPos(p: number | null) { return p == null ? 'не в топ-500' : `#${p}`; }

export function Positions() {
  const [rows, setRows] = useState<Tracked[]>(load);
  const [query, setQuery] = useState('CarPlay адаптер');
  const [nmId, setNmId] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const persist = (next: Tracked[]) => { setRows(next); save(next); };

  const check = async (q: string, nm: number, existingId?: string) => {
    const id = existingId || `${nm}:${q}`;
    setBusy(id); setError(null);
    try {
      const res: WbPosition = await wbPosition(q, nm);
      const next = [...rows];
      const i = next.findIndex(r => r.id === id);
      const point = { at: Date.now(), position: res.position };
      if (i >= 0) next[i] = { ...next[i], history: [...next[i].history, point].slice(-30) };
      else next.unshift({ id, query: q, nmId: nm, history: [point] });
      persist(next);
    } catch (e: any) {
      setError(e?.message === 'wb_search_rate_limited' ? 'WB временно ограничил поиск — повторите через минуту.' : (e?.message || 'Ошибка'));
    } finally { setBusy(null); }
  };

  const add = () => {
    const nm = Number(nmId.trim());
    if (!query.trim()) { setError('Укажите ключевой запрос.'); return; }
    if (!Number.isFinite(nm) || nm < 10000) { setError('Укажите реальный nmId товара (артикул WB, обычно 6-10 цифр).'); return; }
    check(query.trim(), nm);
  };

  const remove = (id: string) => persist(rows.filter(r => r.id !== id));

  return (
    <div className="grid" style={{ gap: 18 }}>
      <div className="card" style={{ background: 'var(--bg-2)' }}>
        <div className="row gap-8" style={{ marginBottom: 10 }}>
          <MagnifyingGlassIcon size={16} weight="bold" style={{ color: 'var(--accent)' }} />
          <strong style={{ fontSize: 14 }}>Позиция товара в поиске WB по запросу</strong>
        </div>
        <div className="row gap-8" style={{ flexWrap: 'wrap' }}>
          <input className="input" placeholder="Ключевой запрос (напр. CarPlay адаптер)" value={query}
            onChange={e => setQuery(e.target.value)} style={{ minWidth: 240, flex: 1 }} />
          <input className="input" placeholder="nmId вашего товара" value={nmId}
            onChange={e => setNmId(e.target.value.replace(/\D/g, ''))} style={{ width: 180 }} />
          <button className="btn btn-primary" onClick={add} disabled={busy != null}>
            <ArrowsClockwiseIcon size={14} weight="bold" className={busy ? 'spin' : ''} /> Проверить
          </button>
        </div>
        {error && <div style={{ color: 'var(--bad)', fontSize: 13, marginTop: 8 }}><WarningIcon size={14} weight="bold" /> {error}</div>}
        <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>
          Сканируем топ-500 органической выдачи (без рекламы) и находим ваш nmId. История проверок сохраняется локально.
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: 32, color: 'var(--muted)' }}>
          Добавьте запрос + nmId, чтобы отслеживать позицию.
        </div>
      ) : (
        <div className="grid" style={{ gap: 10 }}>
          {rows.map(r => {
            const hist = r.history;
            const last = hist[hist.length - 1];
            const prev = hist.length > 1 ? hist[hist.length - 2] : null;
            let trend: 'up' | 'down' | 'flat' = 'flat';
            if (prev && last.position != null && prev.position != null) {
              if (last.position < prev.position) trend = 'up';        // меньше число = выше
              else if (last.position > prev.position) trend = 'down';
            }
            return (
              <div key={r.id} className="card" style={{ background: 'var(--bg-2)' }}>
                <div className="flex-between" style={{ flexWrap: 'wrap', gap: 8 }}>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 13 }}>«{r.query}»</div>
                    <div className="muted" style={{ fontSize: 12 }}>nmId {r.nmId}</div>
                  </div>
                  <div className="row gap-12" style={{ alignItems: 'center' }}>
                    <div style={{ fontSize: 20, fontWeight: 700, color: last.position == null ? 'var(--muted)' : last.position <= 20 ? 'var(--good)' : last.position <= 100 ? 'var(--warn)' : 'var(--bad)' }}>
                      {fmtPos(last.position)}
                    </div>
                    {trend === 'up' && <TrendUpIcon size={18} weight="bold" style={{ color: 'var(--good)' }} />}
                    {trend === 'down' && <TrendDownIcon size={18} weight="bold" style={{ color: 'var(--bad)' }} />}
                    {trend === 'flat' && <MinusIcon size={18} weight="bold" style={{ color: 'var(--muted)' }} />}
                    <button className="btn btn-sm" onClick={() => check(r.query, r.nmId, r.id)} disabled={busy === r.id}>
                      <ArrowsClockwiseIcon size={12} weight="bold" className={busy === r.id ? 'spin' : ''} /> Обновить
                    </button>
                    <button className="btn btn-sm" title="Удалить" onClick={() => remove(r.id)}>
                      <TrashIcon size={12} weight="bold" />
                    </button>
                  </div>
                </div>
                {hist.length > 1 && (
                  <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>
                    История: {hist.slice(-10).map(h => fmtPos(h.position)).join(' → ')}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
