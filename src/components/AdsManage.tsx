import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ArrowsClockwiseIcon, SpinnerIcon, WarningIcon } from '@phosphor-icons/react';
import { apiGet, errText } from '../api/http';
import { wbImageUrl } from '../utils/wbBasket';

/**
 * «Управление рекламой» — товарная таблица для решений по рекламе (17.09.2026).
 * Сервер (/api/ads-manage) сводит рекламу, все заказы, остатки FBS из таблицы
 * «Склад» и маржу с листа «Цены» в одну строку на артикул; здесь — сводка,
 * фильтр по статусу и таблица. Итоговые рекомендации даёт Claude (панель выше таблицы).
 */

export type ManageStatus = 'scale' | 'ok' | 'watch' | 'over' | 'stop' | 'stock' | 'no-ads';
export type ManageRow = {
  platform: 'wb' | 'ozon'; article: string; id: string; name: string; photo: string; category: string;
  spend7: number; adsRevenue7: number; adsOrders7: number; views7: number; clicks7: number;
  ctr7: number | null; cpc7: number | null; spend30: number; adsRevenue30: number;
  orders7: number; orders30: number; revenue7: number; revenue30: number;
  drr7: number | null; drr30: number | null; drrAds7: number | null; norm: number; adsShare7: number | null;
  stock: number | null; transit: number | null; velocity: number | null;
  stockDays: number | null; stockDaysWithTransit: number | null;
  marginPct: number | null; marginRub: number | null; marginAfterAdsPct: number | null;
  status: ManageStatus; statusNote: string;
};
type Summary = {
  platform: 'wb' | 'ozon'; available: boolean; items: number; withAds: number;
  spend7: number; spend30: number; revenue7: number; revenue30: number; adsRevenue7: number;
  drr7: number | null; drr30: number | null; norm: number; byStatus: Record<ManageStatus, number>; stockCritical: number;
};
export type ManageReport = {
  ok: boolean; error?: string; generatedAt: number; rows: ManageRow[];
  summary: { wb: Summary; ozon: Summary };
  stock: { fetchedAt: number | null; warehouses: { name: string; mps: string[]; rows: number }[]; error?: string };
  margins: { wb: number | null; ozon: number | null };
  diagnostics: string[];
};

export const STATUS_META: Record<ManageStatus, { label: string; color: string; bg: string; hint: string }> = {
  scale:    { label: 'усилить',      color: 'var(--good)',  bg: 'rgba(22,163,74,.12)',  hint: 'ДРР в норме, маржа и остаток позволяют добавить бюджет' },
  ok:       { label: 'норма',        color: 'var(--text)',  bg: 'var(--bg-3)',          hint: 'ДРР в пределах нормы — держать' },
  watch:    { label: 'следить',      color: 'var(--warn)',  bg: 'rgba(217,119,6,.12)',  hint: 'ДРР выше нормы, но не критично' },
  over:     { label: 'перерасход',   color: 'var(--bad)',   bg: 'rgba(220,38,38,.12)',  hint: 'ДРР сильно выше нормы или маржа после рекламы < 0' },
  stop:     { label: 'стоп',         color: 'var(--bad)',   bg: 'rgba(220,38,38,.18)',  hint: 'Расход есть, заказов нет' },
  stock:    { label: 'мало остатка', color: 'var(--warn)',  bg: 'rgba(217,119,6,.14)',  hint: 'Остаток меньше 7 дней — рекламу не разгонять' },
  'no-ads': { label: 'без рекламы',  color: 'var(--muted)', bg: 'var(--bg-3)',          hint: 'Реклама за 7 дней не крутилась' },
};
const STATUS_ORDER: ManageStatus[] = ['stop', 'over', 'stock', 'watch', 'scale', 'ok', 'no-ads'];

const fmtRub = (n: number | null | undefined) => (n === null || n === undefined || !Number.isFinite(n) ? '—' : Math.round(n).toLocaleString('ru-RU') + ' ₽');
const fmtNum = (n: number | null | undefined) => (n === null || n === undefined || !Number.isFinite(n) ? '—' : Math.round(n).toLocaleString('ru-RU'));
const fmtPct = (n: number | null | undefined) => (n === null || n === undefined || !Number.isFinite(n) ? '—' : `${n}%`);
const fmtAgo = (ms: number | null) => {
  if (!ms) return '—';
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 1) return 'только что';
  if (m < 60) return `${m} мин назад`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} ч назад` : `${Math.round(h / 24)} дн назад`;
};
const drrColor = (drr: number | null, norm: number) => {
  if (drr === null) return 'var(--muted)';
  if (drr > norm * 1.5) return 'var(--bad)';
  if (drr > norm) return 'var(--warn)';
  return 'var(--good)';
};

export function StatusBadge({ s }: { s: ManageStatus }) {
  const m = STATUS_META[s];
  return (
    <span title={m.hint} style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 999, fontSize: 12, fontWeight: 600, color: m.color, background: m.bg, whiteSpace: 'nowrap' }}>
      {m.label}
    </span>
  );
}

export function AdsManage({ platform, children }: { platform: 'wb' | 'ozon'; children?: (report: ManageReport | null) => ReactNode }) {
  const [data, setData] = useState<ManageReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<ManageStatus | 'all'>('all');
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<'spend' | 'drr' | 'orders' | 'stock' | 'margin'>('spend');

  const load = async (refresh = false) => {
    setLoading(true); setError(null);
    try {
      const { data: j } = await apiGet<ManageReport>(`/api/ads-manage${refresh ? '?refresh=1' : ''}`, { timeoutMs: 120_000 });
      if (!j?.ok) throw new Error(j?.error || 'нет данных');
      setData(j);
    } catch (e) {
      setError(errText(e));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { void load(); /* eslint-disable-next-line */ }, []);

  const sum = data?.summary?.[platform] ?? null;
  const rows = useMemo(() => {
    const all = (data?.rows ?? []).filter((r) => r.platform === platform);
    const qq = q.trim().toLowerCase();
    const f = all.filter((r) => (filter === 'all' || r.status === filter)
      && (!qq || r.article.toLowerCase().includes(qq) || r.name.toLowerCase().includes(qq) || r.id.includes(qq)));
    f.sort((a, b) => {
      if (sort === 'drr') return (b.drr7 ?? b.drrAds7 ?? -1) - (a.drr7 ?? a.drrAds7 ?? -1);
      if (sort === 'orders') return b.orders7 - a.orders7;
      if (sort === 'stock') return (a.stockDays ?? 1e9) - (b.stockDays ?? 1e9);
      if (sort === 'margin') return (a.marginAfterAdsPct ?? 1e9) - (b.marginAfterAdsPct ?? 1e9);
      return b.spend7 - a.spend7 || b.revenue7 - a.revenue7;
    });
    return f;
  }, [data, platform, filter, q, sort]);

  const photoOf = (r: ManageRow) => r.photo || (r.platform === 'wb' && r.id ? wbImageUrl(Number(r.id)) : '');
  const linkOf = (r: ManageRow) => (r.platform === 'wb'
    ? (r.id ? `https://www.wildberries.ru/catalog/${r.id}/detail.aspx` : '')
    : (r.id ? `https://www.ozon.ru/product/${r.id}` : ''));
  const marginAt = data?.margins?.[platform] ?? null;
  const mpTitle = platform === 'wb' ? 'WB' : 'Ozon';

  return (
    <div className="grid" style={{ gap: 16 }}>
      <div className="flex-between" style={{ flexWrap: 'wrap', gap: 10 }}>
        <div>
          <h2 style={{ margin: 0 }}>Управление рекламой · {mpTitle}</h2>
          <div className="muted" style={{ fontSize: 13, marginTop: 4 }}>
            Реклама 7/30 дн, все заказы, остатки FBS из таблицы «Склад» и маржа с листа «Цены» — по каждому артикулу.
            {data?.generatedAt ? ` Собрано ${fmtAgo(data.generatedAt)}.` : ''}
          </div>
        </div>
        <button className="btn btn-sm" onClick={() => load(true)} disabled={loading} title="Пересобрать отчёт (остатки и реклама берутся заново)">
          {loading ? <SpinnerIcon size={14} className="spin" /> : <ArrowsClockwiseIcon size={14} />} Обновить
        </button>
      </div>

      {error && (
        <div className="card" style={{ borderColor: 'var(--bad)' }}>
          <WarningIcon size={16} style={{ color: 'var(--bad)', verticalAlign: -3 }} /> {error}
        </div>
      )}

      {sum && (
        <div className="grid grid-3" style={{ gap: 12 }}>
          <div className="kpi" title="Расход на рекламу за 7 дней; ниже — за 30 дней">
            <div className="card-title">Расход · 7 дн</div>
            <div className="v">{fmtRub(sum.spend7)}</div>
            <div className="muted" style={{ fontSize: 12 }}>30 дн: {fmtRub(sum.spend30)}</div>
          </div>
          <div className="kpi" title="ДРР магазина = расход на рекламу / выручка по ВСЕМ заказам (формула клиента 14.08). Норма — из категорий товаров.">
            <div className="card-title">ДРР магазина · 7 дн</div>
            <div className="v" style={{ color: drrColor(sum.drr7, sum.norm) }}>{fmtPct(sum.drr7)}</div>
            <div className="muted" style={{ fontSize: 12 }}>норма {sum.norm}% · 30 дн: {fmtPct(sum.drr30)}</div>
          </div>
          <div className="kpi" title="Выручка по всем заказам за 7 дней и доля рекламной выручки в ней">
            <div className="card-title">Выручка · 7 дн</div>
            <div className="v">{fmtRub(sum.revenue7)}</div>
            <div className="muted" style={{ fontSize: 12 }}>с рекламы: {fmtRub(sum.adsRevenue7)}{sum.revenue7 > 0 ? ` (${Math.round((sum.adsRevenue7 / sum.revenue7) * 100)}%)` : ''}</div>
          </div>
          <div className="kpi" title="Сколько артикулов крутили рекламу за 7 дней из всех артикулов площадки с остатком или заказами">
            <div className="card-title">Товаров в рекламе</div>
            <div className="v">{sum.withAds} <span className="muted" style={{ fontSize: 14 }}>/ {sum.items}</span></div>
            <div className="muted" style={{ fontSize: 12 }}>усилить {sum.byStatus.scale} · перерасход {sum.byStatus.over + sum.byStatus.stop}</div>
          </div>
          <div className="kpi" title="Артикулы с продажами, у которых остатка на площадке меньше 7 дней">
            <div className="card-title">Остаток &lt; 7 дней</div>
            <div className="v" style={{ color: sum.stockCritical ? 'var(--warn)' : undefined }}>{sum.stockCritical}</div>
            <div className="muted" style={{ fontSize: 12 }}>остатки: {data?.stock?.fetchedAt ? fmtAgo(data.stock.fetchedAt) : 'нет'}</div>
          </div>
          <div className="kpi" title="Маржа берётся с листа «Цены»: откройте его, чтобы обновить">
            <div className="card-title">Маржа с листа «Цены»</div>
            <div className="v" style={{ fontSize: 18 }}>{marginAt ? fmtAgo(marginAt) : 'нет снимка'}</div>
            <div className="muted" style={{ fontSize: 12 }}>{marginAt ? 'те же цифры, что в «Ценах»' : 'откройте Цены → ' + mpTitle}</div>
          </div>
        </div>
      )}

      {children ? children(data) : null}

      {data?.diagnostics?.length ? (
        <div className="muted" style={{ fontSize: 12 }}>
          {data.diagnostics.map((d, i) => <div key={i}>· {d}</div>)}
        </div>
      ) : null}

      <div className="card">
        <div className="flex-between" style={{ flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
          <div className="row gap-8" style={{ flexWrap: 'wrap' }}>
            <button className={`mp-tab ${filter === 'all' ? 'active' : ''}`} onClick={() => setFilter('all')}>все {sum?.items ?? ''}</button>
            {STATUS_ORDER.map((s) => (
              <button key={s} className={`mp-tab ${filter === s ? 'active' : ''}`} onClick={() => setFilter(s)} title={STATUS_META[s].hint}>
                <span style={{ color: STATUS_META[s].color }}>{STATUS_META[s].label}</span> {sum?.byStatus?.[s] ?? 0}
              </button>
            ))}
          </div>
          <div className="row gap-8">
            <select value={sort} onChange={(e) => setSort(e.target.value as any)} style={{ fontSize: 13 }}>
              <option value="spend">по расходу ↓</option>
              <option value="drr">по ДРР ↓</option>
              <option value="orders">по заказам ↓</option>
              <option value="stock">по остатку (дней) ↑</option>
              <option value="margin">по марже после рекламы ↑</option>
            </select>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="поиск по артикулу" style={{ fontSize: 13, width: 180 }} />
          </div>
        </div>
        <div className="tbl-scroll">
          <table className="mp-table" style={{ minWidth: 858 }}>
            <thead className="mp-head">
              <tr>
                <th style={{ width: 240 }}>Товар</th>
                <th style={{ width: 104 }}>Статус</th>
                <th style={{ width: 92 }} title="Расход на рекламу за 7 дней; ниже — за 30 дней и CTR / цена клика">Расход 7д</th>
                <th style={{ width: 96 }} title="ДРР = расход / выручка по всем заказам за 7 дней; ниже — норма категории и ДРР за 30 дней">ДРР 7д</th>
                <th style={{ width: 104 }} title="Заказы за 7 дней: с рекламы / все; ниже — доля рекламных и скорость продаж">Заказы 7д</th>
                <th style={{ width: 104 }} title="Маржа с листа «Цены» → маржа за вычетом ДРР">Маржа → после</th>
                <th style={{ width: 118 }} title="Остаток на складах, которые отгружают эту площадку (таблица «Склад»), дней при текущей скорости, в пути">Остаток</th>
              </tr>
            </thead>
            <tbody>
              {!data && loading && (
                <tr><td colSpan={7} className="muted" style={{ padding: 20, textAlign: 'center' }}><SpinnerIcon size={16} className="spin" /> Собираю рекламу, заказы, остатки и маржу…</td></tr>
              )}
              {data && rows.length === 0 && (
                <tr><td colSpan={7} className="muted" style={{ padding: 20, textAlign: 'center' }}>Нет строк под фильтр</td></tr>
              )}
              {rows.map((r) => {
                const drr = r.drr7 ?? r.drrAds7;
                const href = linkOf(r);
                const photo = photoOf(r);
                return (
                  <tr key={`${r.platform}:${r.article}`}>
                    <td>
                      <div className="row gap-8" style={{ alignItems: 'center' }}>
                        {photo ? <img src={photo} alt="" style={{ width: 36, height: 48, objectFit: 'cover', borderRadius: 4, flex: '0 0 auto' }} loading="lazy" /> : <div style={{ width: 36, height: 48, borderRadius: 4, background: 'var(--bg-3)', flex: '0 0 auto' }} />}
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontWeight: 600 }}>
                            {href ? <a href={href} target="_blank" rel="noreferrer">{r.article}</a> : r.article}
                            {r.id ? <span className="muted" style={{ fontSize: 11, marginLeft: 6 }}>{r.platform === 'wb' ? 'nm ' : 'sku '}{r.id}</span> : null}
                          </div>
                          <div className="muted" style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.name}>{r.name || r.category || '—'}</div>
                        </div>
                      </div>
                    </td>
                    <td>
                      <StatusBadge s={r.status} />
                      <div className="muted" style={{ fontSize: 11, marginTop: 3 }}>{r.statusNote}</div>
                    </td>
                    <td>
                      <div>{fmtRub(r.spend7)}</div>
                      <div className="muted" style={{ fontSize: 11 }}>30 дн: {fmtRub(r.spend30)}</div>
                      <div className="muted" style={{ fontSize: 11 }}>{r.ctr7 !== null ? `CTR ${r.ctr7}%` : ''}{r.cpc7 !== null ? ` · ${fmtNum(r.cpc7)} ₽/клик` : ''}</div>
                    </td>
                    <td>
                      <div style={{ fontWeight: 600, color: drrColor(drr, r.norm) }}>
                        {fmtPct(drr)}{r.drr7 === null && r.drrAds7 !== null ? <span className="muted" title="Нет выручки по всем заказам — ДРР от рекламной выручки" style={{ fontSize: 11 }}> *</span> : null}
                      </div>
                      <div className="muted" style={{ fontSize: 11 }}>норма {r.norm}% · 30 дн {fmtPct(r.drr30)}</div>
                    </td>
                    <td>
                      <div>{fmtNum(r.adsOrders7)} <span className="muted">/ {fmtNum(r.orders7)}</span></div>
                      <div className="muted" style={{ fontSize: 11 }}>{r.adsShare7 !== null ? `с рекламы ${r.adsShare7}%` : ''}{r.velocity ? ` · ${r.velocity} шт/день` : ''}</div>
                    </td>
                    <td>
                      {r.marginPct === null ? <span className="muted">—</span> : (
                        <div>
                          <span>{r.marginPct}%</span>
                          <span className="muted"> → </span>
                          <b style={{ color: (r.marginAfterAdsPct ?? 0) < 0 ? 'var(--bad)' : (r.marginAfterAdsPct ?? 0) < 10 ? 'var(--warn)' : 'var(--good)' }}>{fmtPct(r.marginAfterAdsPct)}</b>
                        </div>
                      )}
                      <div className="muted" style={{ fontSize: 11 }}>{r.marginRub !== null ? `${fmtRub(r.marginRub)} / шт` : ''}</div>
                    </td>
                    <td>
                      {r.stock === null ? <span className="muted">нет в таблице</span> : (
                        <div>
                          <span style={{ fontWeight: 600, color: r.stockDays !== null && r.stockDays < 7 ? 'var(--bad)' : r.stockDays !== null && r.stockDays < 14 ? 'var(--warn)' : undefined }}>
                            {fmtNum(r.stock)} шт{r.stockDays !== null ? ` · ${r.stockDays} дн` : ''}
                          </span>
                          <div className="muted" style={{ fontSize: 11 }}>
                            {r.transit ? `в пути ${fmtNum(r.transit)}${r.stockDaysWithTransit !== null ? ` → ${r.stockDaysWithTransit} дн` : ''}` : (r.velocity ? 'в пути нет' : 'продаж нет')}
                          </div>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
