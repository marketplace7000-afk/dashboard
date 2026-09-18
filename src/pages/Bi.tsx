import { useEffect, useState } from 'react';
import { SpinnerIcon, ArrowsClockwiseIcon, WarningIcon, InfoIcon } from '@phosphor-icons/react';
import { PenaltiesCard } from '../components/PenaltiesCard';
import { apiGet, errText } from '../api/http';

/**
 * BI-сводка: ОПиУ, разложение рубля выручки, ДДС по неделям, воронка.
 * Визуал по образцу дашборда, который прислал клиент 05.08, но на наших данных:
 * всё считается из транзакций Ozon — тех же, что площадка кладёт в финотчёт.
 */

type PnlLine = { label: string; amount: number; hint?: string };
type Resp = {
  ok: boolean;
  /** true — сводка ещё считается на сервере, данных в этом ответе нет. */
  building?: boolean;
  days?: number;
  pnl?: PnlLine[];
  breakdown?: { label: string; amount: number; share: number }[];
  cashflow?: { week: string; income: number; outcome: number }[];
  funnel?: { stage: string; value: number; ofPrev: number | null }[];
  funnelAvailable?: boolean;
  revenue?: number;
  netProfit?: number;
  diagnostics?: string;
  error?: string;
};

const rub = (n: number) => Math.round(n).toLocaleString('ru-RU') + ' ₽';
const num = (n: number) => Math.round(n).toLocaleString('ru-RU');
const shortRub = (n: number) => {
  const v = Math.abs(n);
  if (v >= 1_000_000) return `${(n / 1_000_000).toFixed(1)} млн`;
  if (v >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(Math.round(n));
};
const dateRu = (iso: string) => new Date(iso).toLocaleDateString('ru-RU', { day: '2-digit', month: 'short' });

// Цвета долей — по кругу, чтобы соседние сегменты различались.
const SHARE_COLORS = ['#dc2626', '#ea580c', '#d97706', '#ca8a04', '#0891b2', '#4f46e5', '#7c3aed', '#16a34a'];

export function Bi() {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<Resp | null>(null);
  const [loading, setLoading] = useState(false);

  const load = async (force = false) => {
    setLoading(true);
    try {
      // Таймауты и заголовок принудительного обновления — в общем клиенте.
      const { data: j } = await apiGet<Resp>(`/api/bi?days=${days}`, { force });
      setData(j);
    } catch (e) {
      setData({ ok: false, error: errText(e) });
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { void load(); /* eslint-disable-next-line */ }, [days]);

  // Пока сводка собирается в фоне — сами перезапрашиваем, чтобы не заставлять
  // жать «Обновить» вслепую.
  useEffect(() => {
    if (!data?.building) return;
    const t = setTimeout(() => void load(), 20_000);
    return () => clearTimeout(t);
    // eslint-disable-next-line
  }, [data?.building]);

  const maxFlow = Math.max(1, ...(data?.cashflow ?? []).map(c => Math.max(c.income, c.outcome)));

  const hasError = !!data && (!data.ok || !!data.error);
  const isBuilding = !!data?.ok && !!data.building;

  // Каркас ОПиУ на случай, когда цифр нет: раздел показывает свои статьи с
  // прочерками. Пустой экран не отличить от сломанной страницы, а прочерк
  // честно говорит «значения нет» — и это не то же самое, что ноль.
  const PNL_SKELETON: { label: string; amount: number | null }[] = [
    { label: 'Выручка (доставлено покупателям)', amount: null },
    { label: 'Возвраты, отмены, невыкуп', amount: null },
    { label: 'Комиссия площадки', amount: null },
    { label: 'Логистика и обработка', amount: null },
    { label: 'Реклама', amount: null },
    { label: 'Эквайринг', amount: null },
    { label: 'Хранение', amount: null },
    { label: 'Прочие удержания', amount: null },
    { label: 'Прибыль до себестоимости', amount: null },
  ];
  const pnlRows: { label: string; amount: number | null; hint?: string }[] =
    data?.pnl?.length ? data.pnl : PNL_SKELETON;

  return (
    <div className="grid" style={{ gap: 20 }}>
      <div className="row gap-8" style={{ justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap' }}>
        <div className="muted" style={{ fontSize: 13, maxWidth: 620 }}>
          Отчёт о прибылях и убытках, движение денег и структура расходов — из транзакций Ozon,
          тех же, что попадают в финотчёт кабинета.
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

      {/* Статус — узкой плашкой СВЕРХУ, а не вместо страницы. Раздел всегда
          показывает свою структуру: пустые блоки понятнее пустого экрана. */}
      {(hasError || isBuilding) && (
        <div className="card" style={{ borderLeft: `3px solid ${hasError ? 'var(--bad)' : 'var(--accent)'}` }}>
          <div className="row gap-8" style={{ alignItems: 'center' }}>
            {hasError
              ? <WarningIcon size={16} weight="bold" style={{ color: 'var(--bad)' }} />
              : <SpinnerIcon size={16} className="spin" />}
            <div>
              <div style={{ fontWeight: 600 }}>
                {hasError ? 'Данные не пришли' : 'Собираем сводку'}
              </div>
              <div className="muted" style={{ fontSize: 12 }}>
                {hasError
                  ? `${data?.error}. Цифры ниже пустые — это не нули по бизнесу, а отсутствие ответа.`
                  : 'Первый проход по транзакциям Ozon занимает до минуты. Обновится само.'}
              </div>
            </div>
            {hasError && (
              <button className="btn btn-sm" style={{ marginLeft: 'auto' }} onClick={() => void load(true)}>
                Повторить
              </button>
            )}
          </div>
        </div>
      )}

      {(
        <>
          <div className="grid grid-3" style={{ gap: 12 }}>
            <div className="kpi">
              <div className="card-title">Выручка за период</div>
              <div className="v">{data?.revenue == null ? '—' : rub(data.revenue)}</div>
            </div>
            <div className="kpi">
              <div className="card-title">Прибыль до себестоимости</div>
              <div className="v" style={{ color: data?.netProfit == null ? undefined : data.netProfit > 0 ? 'var(--good)' : 'var(--bad)' }}>
                {data?.netProfit == null ? '—' : rub(data.netProfit)}
              </div>
            </div>
            <div className="kpi">
              <div className="card-title">Доля, что остаётся</div>
              <div className="v">
                {data?.revenue ? `${Math.round(((data.netProfit ?? 0) / data.revenue) * 100)}%` : '—'}
              </div>
            </div>
          </div>

          {/* ── ОПиУ ── */}
          <div className="card">
            <div className="card-title">Отчёт о прибылях и убытках</div>
            <div style={{ overflowX: 'auto', marginTop: 10 }}>
              <table className="table" style={{ minWidth: 420 }}>
                <tbody>
                  {pnlRows.map((l, i, arr) => {
                    const last = i === arr.length - 1;
                    return (
                      <tr key={l.label} style={last ? { borderTop: '2px solid var(--bd)' } : undefined}>
                        <td style={{ fontWeight: last ? 700 : 400 }}>
                          {l.label}
                          {l.hint && <div className="muted" style={{ fontSize: 11 }}>{l.hint}</div>}
                        </td>
                        <td style={{
                          textAlign: 'right',
                          fontWeight: last ? 700 : 500,
                          color: l.amount === null ? 'var(--muted)' : l.amount < 0 ? 'var(--bad)' : last ? 'var(--good)' : undefined,
                        }}>
                          {l.amount === null ? '—' : rub(l.amount)}
                        </td>
                        <td className="muted" style={{ textAlign: 'right', width: 70, fontSize: 12 }}>
                          {data?.revenue && l.amount !== null ? `${Math.round((Math.abs(l.amount) / data.revenue) * 100)}%` : ''}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* ── Куда уходит каждый рубль ── */}
          <div className="card">
            <div className="card-title">Куда уходит каждый ₽ выручки</div>
            {!(data?.breakdown ?? []).length && (
              <div className="muted" style={{ fontSize: 12, marginTop: 10 }}>Долей пока нет — ждём цифры.</div>
            )}
            <div style={{ display: 'flex', height: 26, borderRadius: 6, overflow: 'hidden', marginTop: 12, background: 'var(--bg-3)' }}>
              {(data?.breakdown ?? []).map((b, i) => (
                <div
                  key={b.label}
                  title={`${b.label}: ${rub(b.amount)} (${b.share}%)`}
                  style={{
                    width: `${Math.max(0, b.share)}%`,
                    background: SHARE_COLORS[i % SHARE_COLORS.length],
                  }}
                />
              ))}
            </div>
            <div className="row gap-8" style={{ flexWrap: 'wrap', marginTop: 12 }}>
              {(data?.breakdown ?? []).map((b, i) => (
                <div key={b.label} className="row gap-8" style={{ alignItems: 'center', fontSize: 12, marginRight: 12 }}>
                  <span style={{
                    width: 10, height: 10, borderRadius: 2,
                    background: SHARE_COLORS[i % SHARE_COLORS.length], display: 'inline-block',
                  }} />
                  <span>{b.label}</span>
                  <span className="muted">{b.share}% · {rub(b.amount)}</span>
                </div>
              ))}
            </div>
          </div>

          {/* ── ДДС ── */}
          <div className="card">
            <div className="card-title">Движение денег по неделям</div>
            {!(data?.cashflow ?? []).length && (
              <div className="muted" style={{ fontSize: 12, marginTop: 10 }}>
                Данных за период нет — график появится, когда придут транзакции.
              </div>
            )}
            <div className="row gap-8" style={{ alignItems: 'flex-end', marginTop: 16, minHeight: 130, overflowX: 'auto' }}>
              {(data?.cashflow ?? []).map(c => (
                <div key={c.week} style={{ textAlign: 'center', minWidth: 74 }}>
                  <div className="row gap-8" style={{ alignItems: 'flex-end', justifyContent: 'center', height: 100 }}>
                    <div
                      title={`Приход: ${rub(c.income)}`}
                      style={{
                        width: 20, background: 'var(--good)', borderRadius: '3px 3px 0 0',
                        height: `${Math.max(2, (c.income / maxFlow) * 100)}%`,
                      }}
                    />
                    <div
                      title={`Расход: ${rub(c.outcome)}`}
                      style={{
                        width: 20, background: 'var(--bad)', borderRadius: '3px 3px 0 0',
                        height: `${Math.max(2, (c.outcome / maxFlow) * 100)}%`,
                      }}
                    />
                  </div>
                  <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>{dateRu(c.week)}</div>
                  <div style={{ fontSize: 11, color: 'var(--good)' }}>+{shortRub(c.income)}</div>
                  <div style={{ fontSize: 11, color: 'var(--bad)' }}>−{shortRub(c.outcome)}</div>
                </div>
              ))}
            </div>
          </div>

          {/* ── Штрафы и удержания ── они теряются внутри строки «прочие удержания» ── */}
          <PenaltiesCard />

          {/* ── Воронка ── */}
          <div className="card">
            <div className="card-title">Воронка рекламного трафика</div>
            <div className="muted" style={{ fontSize: 12 }}>
              только платный трафик: общих показов карточек Ozon в API продавца нет
            </div>
            {data?.funnelAvailable ? (
              <div style={{ marginTop: 12 }}>
                {(data?.funnel ?? []).map(f => {
                  const first = data.funnel?.[0]?.value || 1;
                  return (
                    <div key={f.stage} style={{ marginBottom: 10 }}>
                      <div className="row gap-8" style={{ justifyContent: 'space-between', fontSize: 12 }}>
                        <span>{f.stage}</span>
                        <span className="muted">
                          {num(f.value)}{f.ofPrev !== null ? ` · ${f.ofPrev}% от предыдущего` : ''}
                        </span>
                      </div>
                      <div style={{ background: 'var(--bg-3)', borderRadius: 4, height: 12, marginTop: 4 }}>
                        <div style={{
                          width: `${Math.max(1, (f.value / first) * 100)}%`,
                          height: '100%', background: 'var(--accent)', borderRadius: 4,
                        }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="muted" style={{ marginTop: 12, display: 'flex', gap: 6, alignItems: 'center' }}>
                <InfoIcon size={14} weight="bold" /> Отчёт рекламы ещё собирается — воронка появится после прогрева.
              </div>
            )}
          </div>

          {data?.diagnostics && (
            <div className="muted" style={{ fontSize: 11 }}>{data.diagnostics}</div>
          )}
        </>
      )}
    </div>
  );
}
