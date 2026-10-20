/** «Реклама» → «Товары»: таблица товаров, архив пачкой и карточка товара (ProductDrawer). */
import { useEffect, useMemo, useState } from 'react';
import {
  MagnifyingGlassIcon, CaretDownIcon, CaretUpIcon, ArrowSquareOutIcon, XIcon, ProhibitIcon,
} from '@phosphor-icons/react';
import { apiPost, errText } from '../../api/http';
import { nf1, rub, num, pct, ddmm, kRub, ProductCell } from '../ads2ui';
import { NO_ADS_REASON_LABEL, type Ads2Overview, type Ads2Product } from '../../../shared/ads2';
import { IssueIcon, StatusChip, type SetToast } from './shared';


type PFilter = 'all' | 'ads' | 'noads' | 'issues' | 'flagged' | 'archive';
type PSort = 'revenue' | 'spend' | 'drr' | 'stock';

export function Products({ d, openProduct, onChanged, setToast }: {
  d: Ads2Overview; openProduct: (k: string) => void; onChanged: () => void; setToast: SetToast;
}) {
  const [q, setQ] = useState('');
  const [f, setF] = useState<PFilter>('all');
  const [sort, setSort] = useState<PSort>('revenue');
  const [dir, setDir] = useState<1 | -1>(-1);
  const [shown, setShown] = useState(60);
  // Архив (карточки под самовыкуп, дубли): отмечаем пачкой — галочки в строках или «выбрать все найденные».
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [reason, setReason] = useState('self_buyout');
  const [saving, setSaving] = useState(false);
  const work = useMemo(() => d.products.filter(p => !p.archived), [d]);
  const counts = useMemo(() => ({
    all: work.length,
    ads: work.filter(p => p.spend > 0 || p.campaigns.length).length,
    noads: work.filter(p => !p.spend && !p.campaigns.length).length,
    issues: work.filter(p => p.issues.some(i => i.level !== 'info')).length,
    flagged: work.filter(p => p.flag).length,
    archive: d.products.length - work.length,
  }), [d, work]);
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    const xs = (f === 'archive' ? d.products.filter(p => p.archived) : work).filter(p =>
      (f === 'all' || f === 'archive' || (f === 'ads' && (p.spend > 0 || p.campaigns.length)) || (f === 'noads' && !p.spend && !p.campaigns.length)
        || (f === 'issues' && p.issues.some(i => i.level !== 'info')) || (f === 'flagged' && p.flag))
      && (!s || `${p.name} ${p.article} ${p.adSku ?? ''} ${p.key}`.toLowerCase().includes(s)));
    const val = (p: Ads2Product) => sort === 'revenue' ? p.revenue : sort === 'spend' ? p.spend : sort === 'drr' ? (p.drr ?? -1) : (p.daysOfStock ?? 1e9);
    return xs.sort((a, b) => (val(a) - val(b)) * dir);
  }, [d, q, f, sort, dir]);
  const th = (k: PSort, label: string) => (
    <th className="ad2-num ad2-sortable" onClick={() => { if (sort === k) setDir(dir === -1 ? 1 : -1); else { setSort(k); setDir(-1); } }}>
      {label} {sort === k && (dir === -1 ? <CaretDownIcon size={11} /> : <CaretUpIcon size={11} />)}
    </th>
  );
  const skuOf = (p: Ads2Product) => p.adSku ?? p.key;
  const selKeys = list.filter(p => sel.has(p.key));
  const allSel = list.length > 0 && list.every(p => sel.has(p.key));
  const toggle = (k: string) => setSel(s => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const archive = async (on: boolean) => {
    if (!selKeys.length) return;
    setSaving(true);
    try {
      await apiPost('/api/ads2/flags', { mp: d.mp, skus: selKeys.map(skuOf), archive: on, reason: on ? reason : null });
      setToast({ ok: true, text: on
        ? `В архиве: ${selKeys.length}. Скрыты из «Товаров», «Обзора» и «Конкурентов», отмечены «Не рекламировать» — автопилот их не тронет`
        : `Возвращены из архива: ${selKeys.length}. Отметка «Не рекламировать» осталась — снимите в карточке товара, если нужно` });
      setSel(new Set());
      onChanged();
    } catch (e) { setToast({ ok: false, text: `Не сохранено: ${errText(e)}` }); }
    finally { setSaving(false); }
  };
  return (
    <section className="card ad2-tablecard">
      <div className="ad2-filters">
        <label className="ad2-search">
          <MagnifyingGlassIcon size={15} />
          <input className="input" placeholder="Название, артикул или SKU" value={q} onChange={e => { setQ(e.target.value); setShown(60); }} />
        </label>
        <div className="period-switch" role="group" aria-label="Фильтр">
          {([['all', 'Все'], ['ads', 'С рекламой'], ['noads', 'Без рекламы'], ['issues', 'Есть проблемы'], ['flagged', 'Не рекламировать'], ['archive', 'Архив']] as Array<[PFilter, string]>).map(([k, l]) => (
            <button key={k} className={`period-btn ${f === k ? 'active' : ''}`} onClick={() => { setF(k); setShown(60); setSel(new Set()); }}>{l} <span className="ad2-cnt">{counts[k]}</span></button>
          ))}
        </div>
      </div>
      {selKeys.length > 0 && (
        <div className="ad2-selbar">
          <b>Выбрано: {selKeys.length}</b>
          {f === 'archive'
            ? <button className="btn btn-sm" disabled={saving} onClick={() => void archive(false)}>Вернуть из архива</button>
            : <>
                <select className="select" value={reason} onChange={e => setReason(e.target.value)} aria-label="Причина архива">
                  {Object.entries(NO_ADS_REASON_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select>
                <button className="btn btn-sm btn-bad" disabled={saving} onClick={() => void archive(true)}>В архив</button>
              </>}
          <button className="btn btn-sm" onClick={() => setSel(new Set())}>Снять выбор</button>
          {f !== 'archive' && <span className="muted ad2-small">Архив — для карточек под самовыкуп и дублей: скрыты из «Товаров», «Обзора» и «Конкурентов», автопилот их не трогает. Вернуть — фильтр «Архив».</span>}
        </div>
      )}
      <div className="ad2-scroll">
        <table className="ad2-table">
          <thead>
            <tr>
              <th className="ad2-col-chk"><input type="checkbox" aria-label="Выбрать все найденные" title="Выбрать все найденные (с учётом поиска и фильтра)" checked={allSel}
                onChange={() => setSel(allSel ? new Set() : new Set(list.map(p => p.key)))} /></th>
              <th className="ad2-col-prod">Товар</th>
              <th className="ad2-num">Заказы</th>
              {th('revenue', 'Заказано')}
              {th('spend', 'Реклама')}
              {th('drr', 'ДРР')}
              <th className="ad2-num" title="Доля заказов, пришедших из рекламы">Из рекламы</th>
              <th className="ad2-num" title={`Карточка → корзина. Медиана площадки ${pct(d.medians.pdpToCart)}`}>В корзину</th>
              <th className="ad2-num" title={`Корзина → заказ. Медиана площадки ${pct(d.medians.cartToOrder)}`}>В заказ</th>
              {th('stock', 'Запас')}
              <th className="ad2-num">Маржа</th>
              <th>Кампании</th>
              <th>Внимание</th>
            </tr>
          </thead>
          <tbody>
            {list.slice(0, shown).map(p => (
              <tr key={p.key} onClick={() => openProduct(p.key)} className={`ad2-click ${sel.has(p.key) ? 'ad2-row-sel' : ''}`}>
                <td className="ad2-col-chk" onClick={e => e.stopPropagation()}><input type="checkbox" aria-label="Выбрать" checked={sel.has(p.key)} onChange={() => toggle(p.key)} /></td>
                <td className="ad2-col-prod"><ProductCell p={p} /></td>
                <td className="ad2-num">{num(p.orders)}</td>
                <td className="ad2-num">{rub(p.revenue)}</td>
                <td className="ad2-num">{p.spend ? rub(p.spend) : <span className="muted">–</span>}</td>
                <td className={`ad2-num ${p.drr != null && p.drr > 10 ? 'ad2-bad' : ''}`}>{pct(p.drr)}</td>
                <td className="ad2-num">{pct(p.advShare)}</td>
                <td className={`ad2-num ${p.issues.some(i => i.code === 'card_to_cart') ? 'ad2-warn' : ''}`}>{pct(p.pdpToCart)}</td>
                <td className={`ad2-num ${p.issues.some(i => i.code === 'cart_to_order') ? 'ad2-warn' : ''}`}>{pct(p.cartToOrder)}</td>
                <td className={`ad2-num ${p.daysOfStock != null && p.daysOfStock < 7 ? 'ad2-bad' : ''}`}>{p.daysOfStock == null ? (p.stock === 0 ? '0 шт' : '–') : `${num(p.daysOfStock)} дн`}</td>
                <td className="ad2-num">{pct(p.marginPct)}</td>
                <td>{p.archived ? <span className="chip">архив</span> : p.flag ? <span className="chip bad">не рекламировать</span> : p.campaigns.length ? `${p.campaigns.filter(c => c.status === 'active').length} из ${p.campaigns.length}` : <span className="muted">нет</span>}</td>
                <td><span className="ad2-issues">{p.issues.map(i => <IssueIcon key={i.code} i={i} />)}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {list.length > shown && <button className="btn" onClick={() => setShown(shown + 100)}>Показать ещё {Math.min(100, list.length - shown)} из {list.length - shown}</button>}
      {!list.length && <p className="muted">Ничего не найдено.</p>}
    </section>
  );
}

/** Мини-график товара: заказы (столбики) и расход (линия) по дням — на своих шкалах, подписаны. */
function ProductSpark({ p, dates }: { p: Ads2Product; dates: string[] }) {
  const W = 520, H = 110, P = 6;
  const n = dates.length;
  if (n < 2) return null;
  const mo = Math.max(1, ...p.series.orders.map(v => v ?? 0));
  const ms = Math.max(1, ...p.series.spend.map(v => v ?? 0));
  const step = (W - 2 * P) / n;
  const line = p.series.spend.map((v, i) => `${i ? 'L' : 'M'}${P + step * i + step / 2},${H - P - ((v ?? 0) / ms) * (H - 2 * P)}`).join(' ');
  return (
    <div>
      <div className="ad2-legend">
        <span><i className="ad2-sw ad2-sw-orders" /> Заказы, шт (макс {num(mo)})</span>
        <span><i className="ad2-sw ad2-sw-spendline" /> Расход на рекламу (макс {rub(ms)})</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="ad2-spark" role="img" aria-label="Заказы и расход по дням">
        {p.series.orders.map((v, i) => (
          <rect key={i} x={P + step * i + 1} width={Math.max(1, step - 2)} y={H - P - ((v ?? 0) / mo) * (H - 2 * P)} height={((v ?? 0) / mo) * (H - 2 * P)} rx={2} className="ad2-spark-bar">
            <title>{`${ddmm(dates[i])}: заказов ${num(v)}, расход ${rub(p.series.spend[i])}`}</title>
          </rect>
        ))}
        <path d={line} className="ad2-spark-line" />
      </svg>
    </div>
  );
}

function FunnelStep({ label, value, med }: { label: string; value: number | null; med: number | null }) {
  const low = value != null && med != null && value < med * 0.6;
  return (
    <div className={`ad2-fstep ${low ? 'low' : ''}`}>
      <div className="muted">{label}</div>
      <div className="ad2-fstep-v">{pct(value)}</div>
      <div className="muted ad2-small">медиана {pct(med)}</div>
    </div>
  );
}

export function ProductDrawer({ d, p, onClose, onChanged, setToast, openCampaign }: {
  d: Ads2Overview; p: Ads2Product; onClose: () => void; onChanged: () => void;
  setToast: SetToast; openCampaign: (id: string) => void;
}) {
  const [reason, setReason] = useState(p.flag?.reason ?? 'self_buyout');
  const [note, setNote] = useState(p.flag?.note ?? '');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  const saveFlag = async (noAds: boolean) => {
    setSaving(true);
    try {
      await apiPost('/api/ads2/flags', { mp: d.mp, sku: p.adSku ?? p.key, noAds, reason: noAds ? reason : null, note: noAds ? note : null });
      setToast({ ok: true, text: noAds ? 'Отметка «Не рекламировать» поставлена — автопилот товар не тронет' : 'Отметка снята' });
      onChanged();
    } catch (e) { setToast({ ok: false, text: `Не сохранено: ${errText(e)}` }); }
    finally { setSaving(false); }
  };
  const setArchive = async (on: boolean) => {
    setSaving(true);
    try {
      await apiPost('/api/ads2/flags', { mp: d.mp, skus: [p.adSku ?? p.key], archive: on, reason: on ? reason : null });
      setToast({ ok: true, text: on ? 'Товар в архиве — скрыт с экранов «Рекламы», автопилот его не тронет' : 'Товар возвращён из архива' });
      onChanged();
      if (on) onClose();
    } catch (e) { setToast({ ok: false, text: `Не сохранено: ${errText(e)}` }); }
    finally { setSaving(false); }
  };
  return (
    <div className="ad2-drawer-bg" onClick={onClose}>
      <aside className="ad2-drawer" onClick={e => e.stopPropagation()} aria-label="Карточка товара">
        <div className="ad2-drawer-head">
          <ProductCell p={p} />
          {p.link && <a className="btn btn-sm" href={p.link} target="_blank" rel="noreferrer"><ArrowSquareOutIcon size={13} /> на площадке</a>}
          <button className="ad2-x" onClick={onClose} aria-label="Закрыть"><XIcon size={18} /></button>
        </div>

        {p.issues.length > 0 && (
          <div className="ad2-drawer-issues">
            {p.issues.map(i => <div key={i.code} className={`ad2-lv-${i.level}`}><IssueIcon i={i} /> {i.text}</div>)}
          </div>
        )}

        <div className="ad2-mini-kpis">
          <div><span className="muted">Заказы</span><b>{num(p.orders)} · {kRub(p.revenue)}</b></div>
          <div><span className="muted">Реклама</span><b>{rub(p.spend)} · ДРР {pct(p.drr)}</b></div>
          <div><span className="muted">Из рекламы</span><b>{num(p.advOrders)} зак · {pct(p.advShare)}</b></div>
          <div title="К продаже = наличие − резерв, по API площадки; снимок раз в день (РНП)"><span className="muted">Остаток к продаже</span><b>{num(p.stock)} шт · {p.daysOfStock == null ? '–' : `${p.daysOfStock} дн`}</b>
            <span className="muted ad2-small">FBO {num(p.stockFbo)} · FBS {num(p.stockFbs)}{p.outSince ? ` · нет с ${ddmm(p.outSince)}` : ''}</span></div>
          <div><span className="muted">Цена · маржа</span><b>{rub(p.price)} · {pct(p.marginPct)}</b></div>
          <div><span className="muted">Позиция в поиске</span><b>{p.avgPos == null ? '–' : nf1.format(p.avgPos)}</b></div>
        </div>

        <h4>Воронка за период</h4>
        <div className="ad2-funnel">
          <div className="ad2-fstep"><div className="muted">Переходы в карточку</div><div className="ad2-fstep-v">{num(p.cardViews)}</div></div>
          <FunnelStep label="В корзину" value={p.pdpToCart} med={d.medians.pdpToCart} />
          <div className="ad2-fstep"><div className="muted">Корзины</div><div className="ad2-fstep-v">{num(p.carts)}</div></div>
          <FunnelStep label="Из корзины в заказ" value={p.cartToOrder} med={d.medians.cartToOrder} />
        </div>
        <p className="muted ad2-small">Сравнение с конкурентами по каждому шагу появится с разделом «Конкуренты» (этап 4). Пока — с медианой ваших товаров на площадке.</p>

        <h4>Заказы и реклама по дням</h4>
        <ProductSpark p={p} dates={d.dates} />

        <h4>Кампании</h4>
        {!p.campaigns.length && <p className="muted">Товар не участвует в кампаниях.</p>}
        <ul className="ad2-plain">
          {p.campaigns.map(c => (
            <li key={c.id}><button className="ad2-link" onClick={() => openCampaign(c.id)}>{c.name}</button> <StatusChip s={c.status} /></li>
          ))}
        </ul>

        <h4>Не рекламировать</h4>
        <p className="muted ad2-small">Карточки под самовыкупы, вывод или неактивные. Автопилот такие товары не трогает и не предлагает для них кампании.</p>
        <div className="ad2-flag">
          <select className="select" value={reason} onChange={e => setReason(e.target.value)} aria-label="Причина">
            {Object.entries(NO_ADS_REASON_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
          <input className="input" placeholder="Комментарий (необязательно)" value={note} onChange={e => setNote(e.target.value)} maxLength={300} />
          {p.flag
            ? <>
                <button className="btn" disabled={saving} onClick={() => saveFlag(true)}>Сохранить</button>
                <button className="btn btn-good" disabled={saving} onClick={() => saveFlag(false)}>Снять отметку</button>
              </>
            : <button className="btn btn-bad" disabled={saving} onClick={() => saveFlag(true)}><ProhibitIcon size={14} /> Не рекламировать</button>}
        </div>

        <h4>Архив</h4>
        <p className="muted ad2-small">Для карточек под самовыкуп и дублей: товар пропадает из «Товаров», «Обзора» и «Конкурентов» и получает «Не рекламировать». Найти и вернуть — фильтр «Архив» во вкладке «Товары».</p>
        <div className="ad2-flag">
          {p.archived
            ? <button className="btn btn-good" disabled={saving} onClick={() => void setArchive(false)}>Вернуть из архива</button>
            : <button className="btn" disabled={saving} onClick={() => void setArchive(true)}>В архив (причина: {NO_ADS_REASON_LABEL[reason] ?? reason})</button>}
        </div>
      </aside>
    </div>
  );
}
