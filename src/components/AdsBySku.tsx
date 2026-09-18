import { useEffect, useMemo, useState } from 'react';
import { SpinnerIcon, ArrowsClockwiseIcon, WarningIcon, InfoIcon } from '@phosphor-icons/react';
import { apiGet, errText } from '../api/http';

/**
 * Реклама в разрезе АРТИКУЛОВ — просьба клиента 05.08: «мы не можем тянуть расход
 * из кампаний поартикульно? в моей таблице тянется недельный расход по каждому
 * артикулу». Данные обеих площадок уже собирались (WB — разбивка nm[] внутри
 * статистики кампаний, Ozon — отчёт Performance API по SKU), но показывались
 * только как алерты. Здесь они как таблица: расход, выручка, ДРР и норма рядом.
 */

type Row = {
  platform: 'wb' | 'ozon';
  sku: string;
  category?: string;
  spend: number;
  revenue: number;
  orders: number;
  views: number;
  clicks: number;
  drr: number | null;
  /** Выручка по всем заказам товара — знаменатель ДРР в формуле клиента. */
  totalRevenue?: number;
  drrBase?: 'all-orders' | 'ads-only' | 'none';
  romi: number | null;
  norm: number;
  prevSpend: number;
  prevDrr: number | null;
};

type Resp = {
  ok: boolean; items?: Row[]; days?: number; diagnostics?: string; error?: string;
  /** Какие площадки дали статистику. Нужен, чтобы отличить «расхода не было» от
   *  «данные ещё собираются»: по цифрам это неразличимо, а решения разные. */
  sources?: { wb: boolean; ozon: boolean };
};

const rub = (n: number) => Math.round(n).toLocaleString('ru-RU') + ' ₽';
const num = (n: number) => Math.round(n).toLocaleString('ru-RU');
const pct = (n: number | null) => (n === null ? '—' : `${Math.round(n * 10) / 10}%`);

type SortKey = 'spend' | 'drr' | 'revenue' | 'sku';

export function AdsBySku({ platform }: { platform: 'wb' | 'ozon' }) {
  const [days, setDays] = useState(7);
  const [data, setData] = useState<Resp | null>(null);
  const [loading, setLoading] = useState(false);
  const [sort, setSort] = useState<SortKey>('spend');

  const load = async () => {
    setLoading(true);
    try {
      const { data: j } = await apiGet<Resp>(`/api/ads-advisor/by-sku?days=${days}`, { timeoutMs: 60_000 });
      setData(j);
    } catch (e) {
      setData({ ok: false, error: errText(e) });
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { void load(); /* eslint-disable-next-line */ }, [days]);

  const rows = useMemo(() => {
    const all = (data?.items ?? []).filter(r => r.platform === platform);
    const sorted = [...all];
    sorted.sort((a, b) => {
      if (sort === 'sku') return a.sku.localeCompare(b.sku);
      if (sort === 'drr') return (b.drr ?? -1) - (a.drr ?? -1);
      if (sort === 'revenue') return b.revenue - a.revenue;
      return b.spend - a.spend;
    });
    return sorted;
  }, [data, platform, sort]);

  const total = useMemo(() => rows.reduce((acc, r) => ({
    spend: acc.spend + r.spend,
    revenue: acc.revenue + r.revenue,
    orders: acc.orders + r.orders,
  }), { spend: 0, revenue: 0, orders: 0 }), [rows]);
  const totalDrr = total.revenue > 0 ? (total.spend / total.revenue) * 100 : null;

  return (
    <div className="card">
      <div className="row gap-8" style={{ justifyContent: 'space-between', flexWrap: 'wrap', alignItems: 'center' }}>
        <div>
          <div className="card-title">Реклама по артикулам</div>
          <div className="muted" style={{ fontSize: 12 }}>
            расход и ДРР по каждому товару из API площадки — не из таблицы.
            ДРР считается как расход ÷ выручка по всем заказам, как у вас в учёте
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
            <option value={14}>14 дней</option>
            <option value={30}>30 дней</option>
          </select>
          <select
            className="input"
            value={sort}
            onChange={e => setSort(e.target.value as SortKey)}
            style={{ width: 'auto', padding: '6px 8px', fontSize: 12 }}
            title="Сортировка"
          >
            <option value="spend">по расходу ↓</option>
            <option value="drr">по ДРР ↓</option>
            <option value="revenue">по выручке ↓</option>
            <option value="sku">по артикулу</option>
          </select>
          <button className="btn btn-sm" onClick={() => void load()} disabled={loading}>
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

      {!loading && data?.ok && !rows.length && (
        <div className="muted" style={{ marginTop: 12, display: 'flex', gap: 6, alignItems: 'center' }}>
          <InfoIcon size={14} weight="bold" />
          {/* Честно различаем «нет расхода» и «данные ещё собираются»: подставить
              ноль вместо второго дороже пустой строки — по нулю принимают решения. */}
          {data.sources && !data.sources[platform]
            ? `Статистика кампаний ${platform === 'wb' ? 'Wildberries' : 'Ozon'} ещё собирается — это не ноль расхода, а отсутствие данных. Обновите через пару минут.`
            : (data.diagnostics ?? 'данных за период нет')}
        </div>
      )}

      {rows.length > 0 && (
        <>
          <div className="grid grid-4" style={{ gap: 12, marginTop: 12 }}>
            <div className="kpi">
              <div className="card-title">Расход за период</div>
              <div className="v">{rub(total.spend)}</div>
            </div>
            <div className="kpi">
              <div className="card-title">Выручка с рекламы</div>
              <div className="v">{rub(total.revenue)}</div>
            </div>
            <div className="kpi">
              <div className="card-title">ДРР общий</div>
              <div className="v">{pct(totalDrr)}</div>
            </div>
            <div className="kpi">
              <div className="card-title">Заказов из рекламы</div>
              <div className="v">{num(total.orders)}</div>
            </div>
          </div>

          <div style={{ overflowX: 'auto', marginTop: 12 }}>
            <table className="table" style={{ minWidth: 760 }}>
              <thead>
                <tr>
                  <th>Артикул</th>
                  <th style={{ textAlign: 'right' }}>Расход</th>
                  <th style={{ textAlign: 'right' }}>Было</th>
                  <th style={{ textAlign: 'right' }}>Выручка с рекламы</th>
                  <th style={{ textAlign: 'right' }}>Выручка всего</th>
                  <th style={{ textAlign: 'right' }}>Заказы</th>
                  <th style={{ textAlign: 'right' }} title="Расход ÷ выручка по всем заказам товара. Ниже серым — как считает кабинет площадки (÷ выручка от рекламы).">ДРР</th>
                  <th style={{ textAlign: 'right' }}>Норма</th>
                  <th style={{ textAlign: 'right' }}>ROMI</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => {
                  // Цвет только когда ДРР есть: «нет выручки» — это не «хорошо».
                  const over = r.drr !== null && r.drr > r.norm;
                  const color = r.drr === null ? 'var(--muted)' : over ? 'var(--bad)' : 'var(--good)';
                  const deltaSpend = r.prevSpend > 0 ? Math.round(((r.spend - r.prevSpend) / r.prevSpend) * 100) : null;
                  return (
                    <tr key={`${r.platform}:${r.sku}`}>
                      <td>
                        <div style={{ fontWeight: 600 }}>{r.sku}</div>
                        {r.category && <div className="muted" style={{ fontSize: 11 }}>{r.category}</div>}
                      </td>
                      <td style={{ textAlign: 'right' }}>{rub(r.spend)}</td>
                      <td style={{ textAlign: 'right' }} className="muted">
                        {r.prevSpend ? rub(r.prevSpend) : '—'}
                        {deltaSpend !== null && (
                          <div style={{ fontSize: 11, color: deltaSpend > 0 ? 'var(--bad)' : 'var(--good)' }}>
                            {deltaSpend > 0 ? '+' : ''}{deltaSpend}%
                          </div>
                        )}
                      </td>
                      <td style={{ textAlign: 'right' }}>{r.revenue ? rub(r.revenue) : '—'}</td>
                      <td style={{ textAlign: 'right' }}>{r.totalRevenue ? rub(r.totalRevenue) : '—'}</td>
                      <td style={{ textAlign: 'right' }}>{num(r.orders)}</td>
                      <td style={{ textAlign: 'right', color, fontWeight: 600 }}>
                        {pct(r.drr)}
                        {/* Два определения ДРР, и оба законные. Наш — по всем заказам
                            (формула клиента 14.08); кабинет площадки — по выручке,
                            которую принесла сама реклама. Наш всегда ниже, и с
                            кабинетом он не сойдётся по определению — поэтому рядом
                            показываем и второй, чтобы сверка с кабинетом была
                            возможна (аудит 04.09: 127,5% против 36,1% у одного SKU). */}
                        {r.drrBase === 'ads-only' && (
                          <div className="muted" style={{ fontSize: 10, fontWeight: 400 }}>
                            от выручки рекламы
                          </div>
                        )}
                        {r.drrBase === 'all-orders' && r.revenue > 0 && r.spend > 0 && (
                          <div className="muted" style={{ fontSize: 10, fontWeight: 400 }}
                            title="Так ДРР считает рекламный кабинет площадки: расход ÷ выручка от рекламы. Основная цифра выше — расход ÷ выручка по всем заказам (ваша формула).">
                            в кабинете {Math.round((r.spend / r.revenue) * 1000) / 10}%
                          </div>
                        )}
                      </td>
                      <td style={{ textAlign: 'right' }} className="muted">{r.norm}%</td>
                      <td style={{ textAlign: 'right' }}>{r.romi === null ? '—' : `${Math.round(r.romi)}%`}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>
            «Было» — тот же по длине период до текущего. Норма ДРР задаётся по категории;
            она порог, а факт считается из API. {data?.diagnostics}
          </div>
        </>
      )}
    </div>
  );
}
