import { useEffect, useState } from 'react';
import { SpinnerIcon, ArrowsClockwiseIcon, WarningIcon, InfoIcon } from '@phosphor-icons/react';
import { apiGet, errText } from '../api/http';

/**
 * Штрафы и удержания площадок. Клиент 05.08 просил взять эту идею из чужого
 * дашборда: «штрафы WB, подозрительные удержания — данные лежат в отчёте
 * реализации, надо только взять операции типа штраф и удержание».
 *
 * Обычные расходы (эквайринг, логистика, возвраты, реклама) сюда НЕ попадают —
 * иначе список превращается в отчёт о расходах и удержания в нём теряются.
 */

type Row = {
  platform: 'wb' | 'ozon';
  kind: 'fine' | 'deduction';
  title: string;
  code?: string;
  amount: number;
  count: number;
};

type Resp = {
  ok: boolean;
  /** true — считается на сервере, данных в ответе нет. */
  building?: boolean;
  rows?: Row[];
  totalFines?: number;
  totalDeductions?: number;
  prevTotal?: number;
  days?: number;
  diagnostics?: string;
  error?: string;
};

const rub = (n: number) => Math.round(n).toLocaleString('ru-RU') + ' ₽';

export function PenaltiesCard() {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<Resp | null>(null);
  const [loading, setLoading] = useState(false);

  const load = async (force = false) => {
    setLoading(true);
    try {
      const { data: j } = await apiGet<Resp>(`/api/penalties?days=${days}`, { force });
      setData(j);
    } catch (e) {
      setData({ ok: false, error: errText(e) });
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { void load(); /* eslint-disable-next-line */ }, [days]);

  // Считается в фоне — перезапросим сами.
  useEffect(() => {
    if (!data?.building) return;
    const t = setTimeout(() => void load(), 20_000);
    return () => clearTimeout(t);
    // eslint-disable-next-line
  }, [data?.building]);

  const rows = data?.rows ?? [];
  const total = (data?.totalFines ?? 0) + (data?.totalDeductions ?? 0);
  const prev = data?.prevTotal ?? 0;
  const deltaPct = prev > 0 ? Math.round(((total - prev) / prev) * 100) : null;

  return (
    <div className="card">
      <div className="row gap-8" style={{ justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap' }}>
        <div>
          <div className="card-title">Штрафы и удержания</div>
          <div className="muted" style={{ fontSize: 12 }}>
            всё, что площадка удержала сверх обычных расходов на продажу
          </div>
        </div>
        <div className="row gap-8" style={{ alignItems: 'center' }}>
          <select
            className="input"
            value={days}
            onChange={e => setDays(Number(e.target.value))}
            style={{ width: 'auto', padding: '6px 8px', fontSize: 12 }}
          >
            <option value={7}>7 дней</option>
            <option value={30}>30 дней</option>
            <option value={90}>90 дней</option>
          </select>
          <button className="btn btn-sm" onClick={() => void load(true)} disabled={loading}>
            {loading ? <SpinnerIcon size={13} className="spin" /> : <ArrowsClockwiseIcon size={13} weight="bold" />}
            Обновить
          </button>
        </div>
      </div>

      {data && !data.ok && (
        <div className="muted" style={{ marginTop: 12, display: 'flex', gap: 6, alignItems: 'center' }}>
          <WarningIcon size={14} weight="bold" /> {data.error ?? 'не удалось загрузить'}
        </div>
      )}

      {data?.ok && data.building && (
        <div className="muted" style={{ marginTop: 12, display: 'flex', gap: 6, alignItems: 'center' }}>
          <SpinnerIcon size={14} className="spin" /> Считаем удержания за период — обновится само.
        </div>
      )}

      {data?.ok && !data.building && (
        <>
          <div className="grid grid-3" style={{ gap: 12, marginTop: 12 }}>
            <div className="kpi">
              <div className="card-title">Штрафы</div>
              <div className="v" style={{ color: data.totalFines ? 'var(--bad)' : undefined }}>
                {rub(data.totalFines ?? 0)}
              </div>
            </div>
            <div className="kpi">
              <div className="card-title">Прочие удержания</div>
              <div className="v">{rub(data.totalDeductions ?? 0)}</div>
            </div>
            <div className="kpi">
              <div className="card-title">Всего за период</div>
              <div className="v">{rub(total)}</div>
              {deltaPct !== null && (
                <div className="muted" style={{ fontSize: 11, color: deltaPct > 0 ? 'var(--bad)' : 'var(--good)' }}>
                  {deltaPct > 0 ? '+' : ''}{deltaPct}% к прошлому периоду
                </div>
              )}
            </div>
          </div>

          {rows.length > 0 ? (
            <div style={{ overflowX: 'auto', marginTop: 12 }}>
              <table className="table" style={{ minWidth: 520 }}>
                <thead>
                  <tr>
                    <th>Что удержали</th>
                    <th>Площадка</th>
                    <th style={{ textAlign: 'right' }}>Операций</th>
                    <th style={{ textAlign: 'right' }}>Сумма</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(r => (
                    <tr key={`${r.platform}:${r.kind}:${r.title}`}>
                      <td>
                        <span style={{ marginRight: 6 }}>{r.kind === 'fine' ? '🔴' : '🟠'}</span>
                        {r.title}
                        {r.code && (
                          <div className="muted" style={{ fontSize: 10, fontFamily: 'ui-monospace, Menlo, monospace' }}>
                            {r.code}
                          </div>
                        )}
                      </td>
                      <td className="muted" style={{ fontSize: 12 }}>{r.platform.toUpperCase()}</td>
                      <td style={{ textAlign: 'right' }}>{r.count}</td>
                      <td style={{ textAlign: 'right', fontWeight: 600 }}>{rub(r.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="muted" style={{ marginTop: 12, display: 'flex', gap: 6, alignItems: 'center' }}>
              <InfoIcon size={14} weight="bold" /> За период удержаний не найдено.
            </div>
          )}

          {data.diagnostics && (
            <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>{data.diagnostics}</div>
          )}
        </>
      )}
    </div>
  );
}
