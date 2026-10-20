/**
 * «Реклама» — раздел «Реклама 2.0», этап 1 (14.10.2026).
 *
 * Вкладки:
 *   Обзор     — бюджет по правилу владельца (5% от заказов по цене продавца):
 *               период, месяц с прогнозом, сегодня; расход по дням против нормы;
 *               товары, которым нужно внимание, и кандидаты на рекламу.
 *   Товары    — каждый товар: заказы, расход, ДРР, воронка (в корзину, в заказ)
 *               против медианы площадки, остаток, маржа, кампании, узкие места.
 *               Клик — карточка товара с графиком и отметкой «Не рекламировать».
 *   Кампании  — ручное управление: пауза/запуск, ставки по товарам, дневной
 *               лимит WB, недельный бюджет Ozon. Каждое действие — через окно
 *               подтверждения, уходит в площадку и пишется в журнал.
 *   Автопилот — этап 2 «советник» (14.10.2026): предложения по правилам,
 *               менеджер применяет или отклоняет; решённые — с замером эффекта.
 *   Журнал    — все изменения: кто, что, было → стало, ответ площадки.
 *
 * Данные — одним запросом /api/ads2/overview (сервер собирает из РНП и базы
 * рекламы, площадки не дёргает). Старые панели (AdsManage, AdsBySku,
 * AdsInsightPanel и ~850 строк мёртвого кода) заменены этим экраном.
 */
import { Fragment, useCallback, useEffect, useMemo, useState, useRef } from 'react';
import {
  ArrowsClockwiseIcon, MagnifyingGlassIcon, WarningIcon, WarningOctagonIcon, LightbulbIcon, PauseIcon, PlayIcon,
  PencilSimpleIcon, XIcon, CaretDownIcon, CaretRightIcon, ArrowSquareOutIcon, ProhibitIcon, CheckCircleIcon, RobotIcon,
  CaretUpIcon,
} from '@phosphor-icons/react';
import { apiGet, apiPost, errText } from '../api/http';
import { nf0, nf1, nf2, rub, rub2, num, pct, ddmm, kRub, ProductCell } from './ads2ui';
import {
  NO_ADS_REASON_LABEL,
  type Ads2Mp, type Ads2Overview, type Ads2Product, type Ads2Campaign, type Ads2CampaignItem, type Ads2Stat, type Ads2Issue,
  type Ads2ActionKind, type Ads2Proposal, type Ads2AutopilotState,
} from '../../shared/ads2';

// ─── Числа ──────────────────────────────────────────────────────────────────

type Tab = 'overview' | 'products' | 'campaigns' | 'autopilot' | 'log';
const TABS: Array<[Tab, string]> = [['overview', 'Обзор'], ['products', 'Товары'], ['campaigns', 'Кампании'], ['autopilot', 'Автопилот'], ['log', 'Журнал']];

const STATUS: Record<string, { label: string; cls: string }> = {
  active: { label: 'активна', cls: 'good' }, paused: { label: 'пауза', cls: '' }, ready: { label: 'готова', cls: 'info' },
  out_of_budget: { label: 'нет бюджета', cls: 'warn' }, planned: { label: 'запланирована', cls: 'info' },
  finished: { label: 'завершена', cls: '' }, archived: { label: 'архив', cls: '' }, deleted: { label: 'удалена', cls: '' },
};
const PAYMENT: Record<string, string> = { cpm: 'за показы', cpc: 'за клик', cpo: 'за заказ' };
const OZ_STRATEGY: Record<string, string> = {
  TARGET_BIDS: 'средняя цена клика', MAX_CLICKS: 'макс. кликов', TOP_MAX_CLICKS: 'топ, макс. кликов',
  TARGET_CIR: 'целевой ДРР', TOP_PROMOTION: 'вывод в топ', NO_AUTO_STRATEGY: 'без стратегии',
};
const bidTypeLabel = (mp: Ads2Mp, t: string | null) => (mp === 'wb' ? (t === 'unified' ? 'единая ставка' : 'ручная ставка') : (OZ_STRATEGY[t ?? ''] ?? t ?? ''));

// ─── Окно подтверждения и уведомления ───────────────────────────────────────

type ActionPayload = {
  mp: Ads2Mp; campaignId: string; kind: Ads2ActionKind; sku?: string; placement?: 'search' | 'recommendations' | 'combined';
  valueRub?: number; enabled?: boolean; confirmBig?: boolean;
};
type Pending = { title: string; lines: string[]; payload: ActionPayload; warn?: string };
type ActionResult = { ok: boolean; message: string; needConfirm?: boolean };

function ConfirmDialog({ p, busy, onCancel, onOk }: { p: Pending; busy: boolean; onCancel: () => void; onOk: () => void }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onCancel(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [busy, onCancel]);
  return (
    <div className="ad2-modal-bg" onClick={() => !busy && onCancel()}>
      <div className="ad2-modal" role="dialog" aria-modal="true" aria-label={p.title} onClick={e => e.stopPropagation()}>
        <h3>{p.title}</h3>
        {p.lines.map(l => <p key={l}>{l}</p>)}
        {p.warn && <div className="ad2-warnbox"><WarningIcon size={16} /> {p.warn}</div>}
        <p className="muted ad2-small">Команда уйдёт в {p.payload.mp === 'wb' ? 'Wildberries' : 'Ozon'} сразу и запишется в журнал.</p>
        <div className="ad2-modal-btns">
          <button className="btn" onClick={onCancel} disabled={busy}>Отмена</button>
          <button className="btn btn-primary" onClick={onOk} disabled={busy}>{busy ? 'Отправляю…' : 'Применить'}</button>
        </div>
      </div>
    </div>
  );
}

function useActions(reload: () => void) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.ok ? 5000 : 12000);
    return () => clearTimeout(t);
  }, [toast]);
  const run = useCallback(async () => {
    if (!pending) return;
    setBusy(true);
    try {
      const r = await apiPost<ActionResult>('/api/ads2/action', pending.payload);
      if (r.data.needConfirm) {
        // Большой скачок ставки/бюджета: сервер просит отдельное подтверждение.
        setPending({ ...pending, warn: r.data.message, payload: { ...pending.payload, confirmBig: true } });
        return;
      }
      setToast({ ok: r.data.ok, text: r.data.ok ? `Готово: ${r.data.message}` : `Не применено: ${r.data.message}` });
      setPending(null);
      if (r.data.ok) reload();
    } catch (e) {
      setToast({ ok: false, text: `Не применено: ${errText(e)}` });
      setPending(null);
    } finally { setBusy(false); }
  }, [pending, reload]);
  const ui = (
    <>
      {pending && <ConfirmDialog p={pending} busy={busy} onCancel={() => setPending(null)} onOk={run} />}
      {toast && (
        <div className={`ad2-toast ${toast.ok ? 'ok' : 'bad'}`} role="status">
          {toast.ok ? <CheckCircleIcon size={18} /> : <WarningIcon size={18} />} <span>{toast.text}</span>
          <button className="ad2-x" onClick={() => setToast(null)} aria-label="Закрыть"><XIcon size={14} /></button>
        </div>
      )}
    </>
  );
  return { ask: setPending, ui, setToast };
}

// ─── Мелкие детали ──────────────────────────────────────────────────────────

function StatusChip({ s }: { s: string }) {
  const st = STATUS[s] ?? { label: s || '—', cls: '' };
  return <span className={`chip ${st.cls}`}>{st.label}</span>;
}

function IssueIcon({ i }: { i: Ads2Issue }) {
  const Icon = i.level === 'critical' ? WarningOctagonIcon : i.level === 'warn' ? WarningIcon : LightbulbIcon;
  return <span className={`ad2-issue ad2-lv-${i.level}`} title={i.text}><Icon size={16} weight="fill" /></span>;
}

/** Полоса «факт против бюджета»: зелёная до 100%, дальше красная. */
function BudgetBar({ fact, plan }: { fact: number; plan: number }) {
  const ratio = plan > 0 ? fact / plan : 0;
  const w = Math.min(ratio, 1.5) / 1.5 * 100;
  return (
    <div className="ad2-bar" title={`${rub(fact)} из ${rub(plan)}`}>
      <div className={`ad2-bar-fill ${ratio > 1.05 ? 'over' : ratio > 0.9 ? 'near' : ''}`} style={{ width: `${w}%` }} />
      <div className="ad2-bar-mark" style={{ left: `${100 / 1.5}%` }} />
    </div>
  );
}

// ─── График «расход против нормы» ───────────────────────────────────────────

function SpendChart({ days }: { days: Ads2Overview['days'] }) {
  const [hover, setHover] = useState<number | null>(null);
  if (!days.length) return null;
  const W = 760, H = 200, PL = 56, PR = 12, PT = 12, PB = 26;
  const max = Math.max(1, ...days.map(d => Math.max(d.spend, d.budget))) * 1.1;
  const step = (W - PL - PR) / days.length;
  const bw = Math.max(4, Math.min(28, step - 6));
  const y = (v: number) => PT + (H - PT - PB) * (1 - v / max);
  const ticks = [0, max / 2, max].map(v => Math.round(v / 100) * 100);
  const line = days.map((d, i) => `${i ? 'L' : 'M'}${PL + step * i + step / 2},${y(d.budget)}`).join(' ');
  const h = hover == null ? null : days[hover];
  return (
    <div className="ad2-chart">
      <div className="ad2-legend">
        <span><i className="ad2-sw ad2-sw-spend" /> Расход на рекламу</span>
        <span><i className="ad2-sw ad2-sw-over" /> Расход выше нормы</span>
        <span><i className="ad2-sw ad2-sw-norm" /> Норма: 5% от заказов дня</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Расход на рекламу по дням против нормы 5% от заказов" onMouseLeave={() => setHover(null)}>
        {ticks.map(t => (
          <g key={t}>
            <line x1={PL} x2={W - PR} y1={y(t)} y2={y(t)} className="ad2-grid" />
            <text x={PL - 8} y={y(t) + 4} textAnchor="end" className="ad2-axis">{t >= 1000 ? `${nf0.format(t / 1000)}k` : t}</text>
          </g>
        ))}
        {days.map((d, i) => {
          const x = PL + step * i + (step - bw) / 2;
          const over = d.budget > 0 && d.spend > d.budget * 1.05;
          return (
            <g key={d.date} onMouseEnter={() => setHover(i)}>
              <rect x={PL + step * i} y={PT} width={step} height={H - PT - PB} fill="transparent" />
              <rect x={x} y={y(d.spend)} width={bw} height={Math.max(0, y(0) - y(d.spend))} rx={3}
                className={`ad2-barc ${over ? 'over' : ''} ${hover === i ? 'hl' : ''}`} />
              {(days.length <= 16 || i % Math.ceil(days.length / 15) === 0) && (
                <text x={PL + step * i + step / 2} y={H - 8} textAnchor="middle" className="ad2-axis">{ddmm(d.date)}</text>
              )}
            </g>
          );
        })}
        <path d={line} className="ad2-normline" />
      </svg>
      {h && (
        <div className="ad2-tip" style={{ left: `${((PL + step * hover! + step / 2) / W) * 100}%` }}>
          <b>{ddmm(h.date)}</b>
          <span>Расход {rub(h.spend)}</span>
          <span>Норма {rub(h.budget)}</span>
          <span className="muted">Заказы {kRub(h.orders)} · ДРР {pct(h.orders > 0 ? h.spend / h.orders * 100 : null)}</span>
        </div>
      )}
    </div>
  );
}

// ─── Обзор ──────────────────────────────────────────────────────────────────

function Overview({ d, openProduct }: { d: Ads2Overview; openProduct: (k: string) => void }) {
  const b = d.budget;
  const attention = d.products.filter(p => p.issues.some(i => i.level !== 'info')) // у архива остаётся только «отмечен, но реклама идёт»
    .sort((x, y) => (y.issues.some(i => i.level === 'critical') ? 1 : 0) - (x.issues.some(i => i.level === 'critical') ? 1 : 0) || y.spend - x.spend);
  const chances = d.products.filter(p => p.issues.some(i => i.code === 'no_ads_opportunity'));
  const active = d.campaigns.filter(c => c.status === 'active').length;
  const overMonth = b.month.forecastBudget > 0 && b.month.forecastSpend > b.month.forecastBudget * 1.05;
  return (
    <div className="grid" style={{ gap: 16 }}>
      <section className="ad2-kpis">
        <div className="card ad2-kpi">
          <div className="card-title">Расход за период</div>
          <div className="ad2-kpi-v">{rub(b.spend)}</div>
          <BudgetBar fact={b.spend} plan={b.budget} />
          <div className="ad2-kpi-sub">бюджет {rub(b.budget)} = {b.sharePct}% от заказов {kRub(b.orders)}</div>
        </div>
        <div className="card ad2-kpi">
          <div className="card-title">ДРР за период</div>
          <div className={`ad2-kpi-v ${b.drrPct != null && b.drrPct > b.sharePct * 1.05 ? 'bad' : 'good'}`}>{pct(b.drrPct)}</div>
          <div className="ad2-kpi-sub">норма {b.sharePct}% · расход ÷ все заказы, не только рекламные</div>
        </div>
        <div className="card ad2-kpi">
          <div className="card-title">{b.month.label[0].toUpperCase() + b.month.label.slice(1)}: прогноз</div>
          <div className={`ad2-kpi-v ${overMonth ? 'bad' : ''}`}>{rub(b.month.forecastSpend)}</div>
          <BudgetBar fact={b.month.forecastSpend} plan={b.month.forecastBudget} />
          <div className="ad2-kpi-sub">бюджет месяца ≈ {rub(b.month.forecastBudget)} · уже потрачено {rub(b.month.spend)}</div>
        </div>
        <div className="card ad2-kpi">
          <div className="card-title">Сегодня</div>
          <div className="ad2-kpi-v">{rub(b.today.spend)}</div>
          <BudgetBar fact={b.today.spend} plan={b.today.norm} />
          <div className="ad2-kpi-sub">норма дня {rub(b.today.norm)} · активных кампаний {active}</div>
        </div>
      </section>

      <section className="card">
        <h2>Расход по дням</h2>
        <SpendChart days={d.days} />
      </section>

      <div className="ad2-two">
        <section className="card">
          <h2>Требует внимания <span className="muted ad2-count">{attention.length}</span></h2>
          {!attention.length && <p className="muted">Узких мест не найдено.</p>}
          <ul className="ad2-list">
            {attention.slice(0, 12).map(p => (
              <li key={p.key}>
                <ProductCell p={p} onOpen={() => openProduct(p.key)} />
                <div className="ad2-list-issues">
                  {p.issues.filter(i => i.level !== 'info').map(i => <div key={i.code} className={`ad2-lv-${i.level}`}><IssueIcon i={i} /> {i.text}</div>)}
                </div>
              </li>
            ))}
          </ul>
        </section>
        <section className="card">
          <h2>Кандидаты на рекламу <span className="muted ad2-count">{chances.length}</span></h2>
          <p className="muted ad2-small">Продаются без рекламы, запас от 30 дней, маржа от 20%. Создавать ли кампанию — решает менеджер.</p>
          {!chances.length && <p className="muted">Сейчас таких нет.</p>}
          <ul className="ad2-list">
            {chances.slice(0, 10).map(p => (
              <li key={p.key}>
                <ProductCell p={p} onOpen={() => openProduct(p.key)} />
                <div className="ad2-list-num">{num(p.orders)} зак · {kRub(p.revenue)} · запас {num(p.daysOfStock)} дн</div>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}

// ─── Товары ─────────────────────────────────────────────────────────────────

type PFilter = 'all' | 'ads' | 'noads' | 'issues' | 'flagged' | 'archive';
type PSort = 'revenue' | 'spend' | 'drr' | 'stock';

function Products({ d, openProduct, onChanged, setToast }: {
  d: Ads2Overview; openProduct: (k: string) => void; onChanged: () => void; setToast: (t: { ok: boolean; text: string }) => void;
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

function ProductDrawer({ d, p, onClose, onChanged, setToast, openCampaign }: {
  d: Ads2Overview; p: Ads2Product; onClose: () => void; onChanged: () => void;
  setToast: (t: { ok: boolean; text: string }) => void; openCampaign: (id: string) => void;
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

// ─── Кампании ───────────────────────────────────────────────────────────────

function StatCells({ s }: { s: Ads2Stat | null }) {
  return (
    <>
      <td className="ad2-num">{s ? rub(s.spend) : '–'}</td>
      <td className="ad2-num">{s ? num(s.views) : '–'}</td>
      <td className="ad2-num">{s ? pct(s.ctr) : '–'}</td>
      <td className="ad2-num">{s ? rub2(s.cpc) : '–'}</td>
      <td className="ad2-num">{s ? nf1.format(s.orders) : '–'}</td>
      <td className={`ad2-num ${s?.drr != null && s.drr > 10 ? 'ad2-bad' : ''}`}>{s ? pct(s.drr) : '–'}</td>
    </>
  );
}

/** Поле суммы с кнопкой: «изменить» → поле → «ок». */
function MoneyEdit({ value, onSubmit, disabled, title, suffix = '₽' }: {
  value: number | null; onSubmit: (v: number) => void; disabled?: boolean; title: string; suffix?: string;
}) {
  const [edit, setEdit] = useState(false);
  const [v, setV] = useState('');
  if (!edit) {
    return (
      <span className="ad2-money">
        {value == null ? <span className="muted">–</span> : `${nf2.format(value)} ${suffix}`}
        {!disabled && <button className="ad2-icon-btn" title={title} onClick={e => { e.stopPropagation(); setV(value == null ? '' : String(value)); setEdit(true); }}><PencilSimpleIcon size={14} /></button>}
      </span>
    );
  }
  const n = Number(v.replace(',', '.').replace(/\s/g, ''));
  return (
    <form className="ad2-money-edit" onClick={e => e.stopPropagation()} onSubmit={e => { e.preventDefault(); if (n > 0) { onSubmit(n); setEdit(false); } }}>
      <input className="input" autoFocus inputMode="decimal" value={v} onChange={e => setV(e.target.value)} aria-label={title} />
      <button className="btn btn-sm btn-primary" disabled={!(n > 0)}>ок</button>
      <button type="button" className="btn btn-sm" onClick={() => setEdit(false)}>×</button>
    </form>
  );
}

function CampaignRow({ c, open, toggle, ask, mp }: {
  c: Ads2Campaign; open: boolean; toggle: () => void; ask: (p: Pending) => void; mp: Ads2Mp;
}) {
  const limitCell = mp === 'wb'
    ? (c.can.dailyLimit
      ? <span className="ad2-limit">
          <MoneyEdit value={c.dailyLimitOn ? c.dailyLimit : null} title="Дневной лимит"
            onSubmit={v => ask({ title: 'Дневной лимит кампании', lines: [c.name, `Лимит в сутки: ${c.dailyLimitOn && c.dailyLimit ? `${rub(c.dailyLimit)} → ` : ''}${rub(v)}`, 'Остаток лимита на следующий день не переносится.'],
              payload: { mp, campaignId: c.id, kind: 'daily_limit', valueRub: v, enabled: true } })} />
          {c.dailyLimitOn && <button className="ad2-icon-btn" title="Выключить лимит" onClick={e => { e.stopPropagation(); ask({ title: 'Выключить дневной лимит', lines: [c.name, 'Кампания сможет тратить без суточного потолка.'], payload: { mp, campaignId: c.id, kind: 'daily_limit', enabled: false } }); }}><XIcon size={13} /></button>}
          {c.dailyLimitOn && c.spentToday != null && <span className="muted ad2-small">сегодня {rub(c.spentToday)}</span>}
        </span>
      : <span className="muted" title="Дневной лимит WB есть только у кампаний с оплатой за клик">—</span>)
    : (c.can.weeklyBudget
      ? <MoneyEdit value={c.weeklyBudget} title="Недельный бюджет"
          onSubmit={v => ask({ title: 'Недельный бюджет кампании', lines: [c.name, `Бюджет в неделю: ${c.weeklyBudget ? `${rub(c.weeklyBudget)} → ` : ''}${rub(v)}`],
            payload: { mp, campaignId: c.id, kind: 'weekly_budget', valueRub: v } })} />
      : <span className="muted">{c.weeklyBudget ? rub(c.weeklyBudget) : '—'}</span>);
  return (
    <>
      <tr className="ad2-click" onClick={toggle}>
        <td className="ad2-col-camp">
          <div className="ad2-campcell">
            <span className="ad2-caret">{open ? <CaretDownIcon size={13} /> : <CaretRightIcon size={13} />}</span>
            <span className="ad2-camp-name">{c.name}</span>
            <span className="muted ad2-small">{c.id} · {PAYMENT[c.payment ?? ''] ?? c.payment ?? ''} · {bidTypeLabel(mp, c.bidType)} · товаров {c.items.length}</span>
          </div>
        </td>
        <td><StatusChip s={c.status} /></td>
        <td onClick={e => e.stopPropagation()}>{limitCell}</td>
        <StatCells s={c.stat} />
        <td onClick={e => e.stopPropagation()} className="ad2-actions">
          {c.can.pause && <button className="btn btn-sm" onClick={() => ask({ title: 'Поставить кампанию на паузу', lines: [c.name], payload: { mp, campaignId: c.id, kind: 'pause' } })}><PauseIcon size={13} /> Пауза</button>}
          {c.can.start && <button className="btn btn-sm btn-good" onClick={() => ask({ title: 'Запустить кампанию', lines: [c.name, mp === 'wb' ? 'WB запустит кампанию, если на её счету хватает бюджета.' : ''].filter(Boolean), payload: { mp, campaignId: c.id, kind: 'start' } })}><PlayIcon size={13} /> Запустить</button>}
        </td>
      </tr>
      {open && (
        <tr className="ad2-sub">
          <td colSpan={10}>
            <CampaignItems c={c} ask={ask} mp={mp} />
          </td>
        </tr>
      )}
    </>
  );
}

function CampaignItems({ c, ask, mp }: { c: Ads2Campaign; ask: (p: Pending) => void; mp: Ads2Mp }) {
  const unified = mp === 'wb' && c.bidType === 'unified';
  const bidAsk = (it: Ads2CampaignItem, placement: 'search' | 'recommendations' | 'combined', cur: number | null, v: number) => ask({
    title: 'Ставка товара',
    lines: [`${it.name || it.article || it.sku} · ${c.name}`,
      `${placement === 'recommendations' ? 'Рекомендации' : placement === 'combined' ? 'Поиск и рекомендации' : mp === 'wb' ? 'Поиск' : 'Ставка'}: ${cur != null ? `${rub2(cur)} → ` : ''}${rub2(v)}${mp === 'wb' && c.payment === 'cpm' ? ' за 1000 показов' : ' за клик'}`],
    warn: it.noAds ? 'Товар отмечен «Не рекламировать».' : undefined,
    payload: { mp, campaignId: c.id, kind: 'bid', sku: it.sku, placement, valueRub: v },
  });
  return (
    <table className="ad2-table ad2-inner">
      <thead>
        <tr>
          <th>Товар</th>
          {mp === 'wb'
            ? (unified ? <th className="ad2-num">Ставка (поиск и рекомендации)</th> : <><th className="ad2-num">Ставка в поиске</th><th className="ad2-num">Ставка в рекомендациях</th></>)
            : <th className="ad2-num">{c.bidType === 'TARGET_CIR' ? 'Целевой ДРР' : 'Ставка за клик'}</th>}
          <th className="ad2-num">Расход</th><th className="ad2-num">Показы</th><th className="ad2-num">CTR</th>
          <th className="ad2-num">CPC</th><th className="ad2-num">Заказы</th><th className="ad2-num">ДРР</th><th className="ad2-num">Позиция</th>
        </tr>
      </thead>
      <tbody>
        {c.items.map(it => (
          <tr key={it.sku}>
            <td><ProductCell p={{ photo: it.photo, name: it.name || it.sku, article: it.article ? `${it.article} · ${it.sku}` : it.sku }} />{it.noAds && <span className="chip bad">не рекламировать</span>}</td>
            {mp === 'wb'
              ? (unified
                ? <td className="ad2-num"><MoneyEdit value={it.bidSearch} title="Единая ставка" disabled={!c.can.bid} onSubmit={v => bidAsk(it, 'combined', it.bidSearch, v)} /></td>
                : <>
                    <td className="ad2-num"><MoneyEdit value={it.bidSearch || null} title="Ставка в поиске" disabled={!c.can.bid} onSubmit={v => bidAsk(it, 'search', it.bidSearch, v)} /></td>
                    <td className="ad2-num"><MoneyEdit value={it.bidReco || null} title="Ставка в рекомендациях" disabled={!c.can.bid} onSubmit={v => bidAsk(it, 'recommendations', it.bidReco, v)} /></td>
                  </>)
              : <td className="ad2-num">
                  {c.bidType === 'TARGET_CIR' ? pct(it.targetCir)
                    : c.can.bid ? <MoneyEdit value={it.bid} title="Ставка за клик" onSubmit={v => bidAsk(it, 'search', it.bid, v)} />
                    : <span className="muted" title="Ставку ведёт стратегия Ozon">авто</span>}
                </td>}
            <StatCells s={it.stat} />
            <td className="ad2-num">{it.stat?.avgPos == null ? '–' : nf1.format(it.stat.avgPos)}</td>
          </tr>
        ))}
        {!c.items.length && <tr><td colSpan={9} className="muted">Товары кампании ещё не собраны.</td></tr>}
      </tbody>
    </table>
  );
}

type CFilter = 'active' | 'paused' | 'all';

function Campaigns({ d, ask, openId, setOpenId }: { d: Ads2Overview; ask: (p: Pending) => void; openId: string | null; setOpenId: (id: string | null) => void }) {
  const [f, setF] = useState<CFilter>('active');
  const [q, setQ] = useState('');
  const isActive = (c: Ads2Campaign) => c.status === 'active' || c.status === 'out_of_budget';
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    return d.campaigns
      .filter(c => (f === 'all' || (f === 'active' ? isActive(c) : !isActive(c)))
        && (!s || `${c.name} ${c.id} ${c.items.map(i => `${i.sku} ${i.article} ${i.name}`).join(' ')}`.toLowerCase().includes(s)))
      .sort((a, b) => (b.stat?.spend ?? 0) - (a.stat?.spend ?? 0));
  }, [d, f, q]);
  const counts = { active: d.campaigns.filter(isActive).length, paused: d.campaigns.filter(c => !isActive(c)).length, all: d.campaigns.length };
  useEffect(() => {
    if (openId && !list.some(c => c.id === openId)) { setF('all'); }
  }, [openId, list]);
  return (
    <section className="card ad2-tablecard">
      <div className="ad2-filters">
        <label className="ad2-search">
          <MagnifyingGlassIcon size={15} />
          <input className="input" placeholder="Название, ID кампании или товар" value={q} onChange={e => setQ(e.target.value)} />
        </label>
        <div className="period-switch" role="group" aria-label="Статус">
          {([['active', 'Работают'], ['paused', 'Пауза и готовые'], ['all', 'Все']] as Array<[CFilter, string]>).map(([k, l]) => (
            <button key={k} className={`period-btn ${f === k ? 'active' : ''}`} onClick={() => setF(k)}>{l} <span className="ad2-cnt">{counts[k]}</span></button>
          ))}
        </div>
        <span className="muted ad2-small">
          {d.mp === 'wb' ? 'Ставки WB: за 1000 показов (оплата за показы) или за клик.' : 'Ставку Ozon можно менять вручную только при стратегии «средняя цена клика»; у остальных её ведёт Ozon.'}
          {d.mp === 'ozon' && ' Статистика кампаний Ozon копится с 14.10.'}
        </span>
      </div>
      <div className="ad2-scroll">
        <table className="ad2-table">
          <thead>
            <tr>
              <th className="ad2-col-camp">Кампания</th><th>Статус</th><th>{d.mp === 'wb' ? 'Дневной лимит' : 'Бюджет в неделю'}</th>
              <th className="ad2-num">Расход</th><th className="ad2-num">Показы</th><th className="ad2-num">CTR</th><th className="ad2-num">CPC</th>
              <th className="ad2-num">Заказы</th><th className="ad2-num">ДРР</th><th />
            </tr>
          </thead>
          <tbody>
            {list.map(c => <CampaignRow key={c.id} c={c} mp={d.mp} ask={ask} open={openId === c.id} toggle={() => setOpenId(openId === c.id ? null : c.id)} />)}
          </tbody>
        </table>
      </div>
      {!list.length && <p className="muted">Кампаний нет.</p>}
    </section>
  );
}

// ─── Журнал ─────────────────────────────────────────────────────────────────

type LogItem = { id: number; at: number; mp: string; campaign_id: string | null; sku: string | null; actor: string; action: string; before: any; after: any; reason: string | null; status: string; result: any };
const ACTION_LABEL: Record<string, string> = { pause: 'пауза', start: 'запуск', bid: 'ставка', daily_limit: 'дневной лимит', weekly_budget: 'недельный бюджет', no_ads_on: '«не рекламировать»', no_ads_off: 'снята отметка' };
const ACTOR_LABEL: Record<string, string> = { manager: 'менеджер', owner: 'владелец', autopilot: 'автопилот' };
const LOG_STATUS: Record<string, { label: string; cls: string }> = {
  applied: { label: 'применено', cls: 'good' }, failed: { label: 'отказ', cls: 'bad' }, proposed: { label: 'предложено', cls: 'info' },
  rejected: { label: 'отклонено', cls: '' }, rolled_back: { label: 'откат', cls: 'warn' },
};

function Journal({ mp, names }: { mp: Ads2Mp; names: Map<string, string> }) {
  const [items, setItems] = useState<LogItem[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    // Площадка — на сервере: раньше 300 записей делились на обе, и по одной была видна только часть.
    setItems(null); setErr(null);
    apiGet<{ items: LogItem[] }>(`/api/ads2/log?limit=300&mp=${mp}`).then(r => setItems(r.data.items)).catch(e => setErr(errText(e)));
  }, [mp]);
  const list = (items ?? []).filter(i => i.mp === mp);
  return (
    <section className="card ad2-tablecard">
      <p className="muted ad2-small">Все изменения рекламы из этого раздела: кто, что, было → стало и ответ площадки. Изменения в кабинетах WB и Ozon напрямую сюда не попадают.</p>
      {err && <div className="rnp-alert">Журнал не загрузился: {err}</div>}
      {items && !list.length && <p className="muted">Изменений пока не было.</p>}
      {list.length > 0 && (
        <div className="ad2-scroll">
          <table className="ad2-table">
            <thead><tr><th>Когда</th><th>Кто</th><th>Действие</th><th>Кампания / товар</th><th>Результат</th></tr></thead>
            <tbody>
              {list.map(i => (
                <tr key={i.id}>
                  <td className="ad2-nowrap">{new Date(i.at).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</td>
                  <td>{ACTOR_LABEL[i.actor] ?? i.actor}</td>
                  <td>{ACTION_LABEL[i.action] ?? i.action}</td>
                  <td>{i.campaign_id ? (names.get(i.campaign_id) ?? i.campaign_id) : ''}{i.sku ? <span className="muted"> · {i.sku}</span> : null}</td>
                  <td><span className={`chip ${LOG_STATUS[i.status]?.cls ?? ''}`}>{LOG_STATUS[i.status]?.label ?? i.status}</span> {i.result?.message ?? i.result?.error ?? (i.after?.reason ? NO_ADS_REASON_LABEL[i.after.reason] ?? '' : '')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// ─── Автопилот (этап 2) ─────────────────────────────────────────────────────

type ApResp = { state: Ads2AutopilotState; proposals: Ads2Proposal[] };
type ApDecision = { p: Ads2Proposal; decision: 'apply' | 'reject'; warn?: string; confirmBig?: boolean };

const LEVEL: Record<Ads2Proposal['level'], { label: string; cls: string }> = {
  critical: { label: 'срочно', cls: 'bad' }, warn: { label: 'внимание', cls: 'warn' }, growth: { label: 'рост', cls: 'good' }, info: { label: 'совет', cls: 'info' },
};
const P_STATUS: Record<string, { label: string; cls: string }> = {
  applied: { label: 'применено', cls: 'good' }, rejected: { label: 'отклонено', cls: '' }, failed: { label: 'отказ площадки', cls: 'bad' },
};
const isCommand = (p: Ads2Proposal) => p.kind !== 'task' && p.kind !== 'new_campaign';
const dt = (ms: number) => new Date(ms).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

function DecideDialog({ x, busy, onCancel, onOk, setNote, note }: {
  x: ApDecision; busy: boolean; onCancel: () => void; onOk: () => void; note: string; setNote: (s: string) => void;
}) {
  const apply = x.decision === 'apply';
  return (
    <div className="ad2-modal-bg" onClick={() => !busy && onCancel()}>
      <div className="ad2-modal" role="dialog" aria-modal="true" aria-label={x.p.title} onClick={e => e.stopPropagation()}>
        <h3>{apply ? (isCommand(x.p) ? 'Применить предложение' : 'Принять совет') : 'Отклонить предложение'}</h3>
        <p><b>{x.p.title}</b></p>
        <p className="muted">{x.p.reason}</p>
        {x.warn && <div className="ad2-warnbox"><WarningIcon size={16} /> {x.warn}</div>}
        {!apply && (
          <label className="ad2-field">Почему (необязательно — автопилот учтётся и 3 дня не будет предлагать это снова)
            <input className="input" value={note} maxLength={300} onChange={e => setNote(e.target.value)} placeholder="например: идёт акция, ставку держим" />
          </label>
        )}
        {apply && isCommand(x.p) && <p className="muted ad2-small">Команда уйдёт в {x.p.mp === 'wb' ? 'Wildberries' : 'Ozon'} сразу и запишется в журнал.</p>}
        <div className="ad2-modal-btns">
          <button className="btn" onClick={onCancel} disabled={busy}>Отмена</button>
          <button className={`btn ${apply ? 'btn-primary' : ''}`} onClick={onOk} disabled={busy}>
            {busy ? 'Отправляю…' : apply ? (isCommand(x.p) ? 'Применить' : 'Принято') : 'Отклонить'}
          </button>
        </div>
      </div>
    </div>
  );
}

function EffectCell({ e }: { e: Ads2Proposal['effect'] }) {
  if (!e) return <span className="muted">–</span>;
  if (!e.days || !e.after) return <span className="muted">замер завтра</span>;
  const b = e.before;
  return (
    <span className="ad2-small" title="3 дня до решения → дни после (до 3)">
      расход/день {rub(b?.perDay)} → <b>{rub(e.after.perDay)}</b> · заказы {num(b?.orders)} → <b>{num(e.after.orders)}</b> · ДРР {pct(b?.drr)} → <b>{pct(e.after.drr)}</b>
      <span className="muted"> ({e.days} дн)</span>
    </span>
  );
}

function Autopilot({ d, setToast, reload }: { d: Ads2Overview; setToast: (t: { ok: boolean; text: string }) => void; reload: () => void }) {
  const mp = d.mp;
  const [view, setView] = useState<'open' | 'done'>('open');
  const [data, setData] = useState<ApResp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [dec, setDec] = useState<ApDecision | null>(null);
  const [note, setNote] = useState('');

  const load = useCallback(async () => {
    try { const r = await apiGet<ApResp>(`/api/ads2/autopilot?mp=${mp}${view === 'done' ? '&history=1' : ''}`); setData(r.data); setErr(null); }
    catch (e) { setErr(errText(e)); }
  }, [mp, view]);
  useEffect(() => { void load(); }, [load]);

  const prodBySku = useMemo(() => new Map(d.products.filter(p => p.adSku).map(p => [p.adSku!, p])), [d]);
  const campName = useMemo(() => new Map(d.campaigns.map(c => [c.id, c.name])), [d]);

  const post = async (body: Record<string, unknown>, label: string) => {
    setBusy(label);
    try { const r = await apiPost<ApResp>('/api/ads2/autopilot', body, { timeoutMs: 120_000 }); setData(r.data); if (view === 'done') await load(); }
    catch (e) { setToast({ ok: false, text: `Не получилось: ${errText(e)}` }); }
    finally { setBusy(null); }
  };
  const decide = async () => {
    if (!dec) return;
    setBusy('decide');
    try {
      const r = await apiPost<ActionResult>('/api/ads2/autopilot', { id: dec.p.id, decision: dec.decision, note: note || null, confirmBig: !!dec.confirmBig });
      if (r.data.needConfirm) { setDec({ ...dec, warn: r.data.message, confirmBig: true }); return; }
      setToast({ ok: r.data.ok, text: r.data.ok ? `Готово: ${r.data.message}` : `Не применено: ${r.data.message}` });
      setDec(null); setNote('');
      await load();
      if (r.data.ok && dec.decision === 'apply' && isCommand(dec.p)) reload();
    } catch (e) {
      setToast({ ok: false, text: `Не применено: ${errText(e)}` });
      setDec(null);
    } finally { setBusy(null); }
  };

  const st = data?.state;
  const list = data?.proposals ?? [];
  const commands = list.filter(isCommand);
  const advice = list.filter(p => !isCommand(p));

  const card = (p: Ads2Proposal) => {
    const pr = p.sku ? prodBySku.get(p.sku) : undefined;
    return (
      <div key={p.id} className={`ad2-prop lvl-${p.level}`}>
        <div className="ad2-prop-main">
          <div className="ad2-prop-title"><span className={`chip ${LEVEL[p.level].cls}`}>{LEVEL[p.level].label}</span> <b>{p.title}</b></div>
          <div className="ad2-prop-what">
            {(pr || p.sku) && <ProductCell p={{ photo: pr?.photo ?? '', name: pr?.name || p.productName || '', article: pr?.article ?? p.sku ?? '', link: pr?.link }} />}
            {p.campaignId && <span className="muted ad2-small">Кампания: {campName.get(p.campaignId) ?? p.campaignName ?? p.campaignId}</span>}
          </div>
          <p className="ad2-prop-reason">{p.reason}</p>
        </div>
        <div className="ad2-prop-btns">
          <button className="btn btn-primary btn-sm" disabled={!!busy || st?.mode === 'off'} onClick={() => { setNote(''); setDec({ p, decision: 'apply' }); }}>
            <CheckCircleIcon size={14} /> {isCommand(p) ? 'Применить' : 'Принято'}
          </button>
          <button className="btn btn-sm" disabled={!!busy} onClick={() => { setNote(''); setDec({ p, decision: 'reject' }); }}>
            <XIcon size={14} /> {isCommand(p) ? 'Отклонить' : 'Скрыть'}
          </button>
        </div>
      </div>
    );
  };

  return (
    <>
      <section className="card ad2-ap-head">
        <div className="ad2-ap-mode">
          <RobotIcon size={22} />
          <div>
            <b>Автопилот: {st?.mode === 'off' ? 'выключен' : 'с подтверждением'}</b>
            <div className="muted ad2-small">
              {st?.mode === 'off' ? 'Предложения не готовятся.'
                : `Готовит предложения, применяет менеджер${st?.confirmUntil ? ` · режим «с подтверждением» до ${new Date(st.confirmUntil).toLocaleDateString('ru-RU')} (решение владельца)` : ''}.`}
              {st?.lastRun && <> Пересчёт: {dt(st.lastRun.at)}.</>}
            </div>
          </div>
        </div>
        <span className="rnp-spacer" />
        {st && (st.counts14d.applied || st.counts14d.rejected) ? (
          <span className="muted ad2-small">за 14 дн: применено {st.counts14d.applied ?? 0}, отклонено {st.counts14d.rejected ?? 0}</span>
        ) : null}
        <button className="btn btn-sm" disabled={!!busy || st?.mode === 'off'} onClick={() => post({ run: true }, 'run')} title="Пересчитать предложения по свежим данным">
          <ArrowsClockwiseIcon size={13} className={busy === 'run' ? 'spin' : ''} /> Пересчитать
        </button>
        <button className="btn btn-sm" disabled={!!busy} onClick={() => post({ mode: st?.mode === 'off' ? 'confirm' : 'off' }, 'mode')}>
          {st?.mode === 'off' ? <><PlayIcon size={13} /> Включить</> : <><PauseIcon size={13} /> Выключить</>}
        </button>
      </section>

      <div className="period-switch ad2-ap-views" role="group" aria-label="Список">
        <button className={`period-btn ${view === 'open' ? 'active' : ''}`} onClick={() => setView('open')}>Предложения{view === 'open' && data ? ` · ${list.length}` : ''}</button>
        <button className={`period-btn ${view === 'done' ? 'active' : ''}`} onClick={() => setView('done')}>Решённые и замер</button>
      </div>

      {err && <div className="rnp-alert">Автопилот не загрузился: {err}</div>}
      {!data && !err && <div className="card muted">Загружаю…</div>}

      {data && view === 'open' && (
        <>
          {!list.length && <section className="card muted">{st?.mode === 'off' ? 'Автопилот выключен.' : 'Предложений нет — всё в пределах правил. Пересчёт идёт после каждого обновления данных.'}</section>}
          {commands.length > 0 && (
            <section className="card ad2-props">
              <h3>Изменения в кампаниях · {commands.length}</h3>
              {commands.map(card)}
            </section>
          )}
          {advice.length > 0 && (
            <section className="card ad2-props">
              <h3>Советы команде · {advice.length}</h3>
              <p className="muted ad2-small">Площадке ничего не отправляется: задачи по карточке и кандидаты на новые кампании — решает менеджер.</p>
              {advice.map(card)}
            </section>
          )}
        </>
      )}

      {data && view === 'done' && (
        <section className="card ad2-tablecard">
          {!list.length && <p className="muted">Решённых предложений пока нет.</p>}
          {list.length > 0 && (
            <div className="ad2-scroll">
              <table className="ad2-table">
                <thead><tr><th>Когда</th><th>Предложение</th><th>Решение</th><th>Эффект</th></tr></thead>
                <tbody>
                  {list.map(p => {
                    const pr = p.sku ? prodBySku.get(p.sku) : undefined;
                    return (
                      <tr key={p.id}>
                        <td className="ad2-nowrap">{p.decidedAt ? dt(p.decidedAt) : ''}</td>
                        <td><b>{p.title}</b><div className="muted ad2-small">{[pr?.article ?? p.sku, p.campaignId ? campName.get(p.campaignId) ?? p.campaignName ?? p.campaignId : null].filter(Boolean).join(' · ')}</div></td>
                        <td><span className={`chip ${P_STATUS[p.status]?.cls ?? ''}`}>{P_STATUS[p.status]?.label ?? p.status}</span>
                          {(p.note || p.result?.error || (p.status === 'failed' && p.result?.message)) && <div className="muted ad2-small">{p.note ?? p.result?.error ?? p.result?.message}</div>}</td>
                        <td>{isCommand(p) && p.status === 'applied' ? <EffectCell e={p.effect} /> : <span className="muted">–</span>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      <details className="card ad2-autopilot">
        <summary><b>По каким правилам работает автопилот</b></summary>
        <ul>
          <li>Бюджет — 5% от суммы заказов по цене продавца, отдельно WB и Ozon. Если площадка тратит больше, ставки только снижаются — начиная с товаров с худшим ДРР.</li>
          <li>Потолок ставки из экономики товара: заказ не дороже 40% маржи; клик и 1000 показов — от него через конверсию и CTR.</li>
          <li>Шаг изменения — не больше 15%. После изменения товар не трогается 24 часа, пока идёт замер.</li>
          <li>Остаток меньше 7 дней — ставки вниз; у всех товаров кампании меньше 3 дней — пауза кампании.</li>
          <li>Расход без заказов или ДРР больше двух норм — ставка вниз; 1 500 ₽ за неделю без единого заказа — пауза кампании.</li>
          <li>Ставка вверх — только при ДРР ниже 60% нормы, запасе от 14 дней и марже не ниже края плана месяца («Цены» → «Репрайсер»). Если узкое место в карточке или корзине, вместо повышения — задача команде.</li>
          <li>Конкуренты (с 15.10): если наша цена покупателю выше медианы подтверждённых конкурентов на 8%+, ставку не поднимает — даёт задачу по цене. Если у всех конкурентов нет в наличии, а ДРР в норме, — окно для +15%.</li>
          <li>Ozon: «ДРР вдвое выше нормы» считается с поправкой на медиану категории из «Товаров на Ozon». При перерасходе площадки за проход снижаются только 5 товаров с худшим ДРР.</li>
          <li>WB «за клик» без дневного лимита — предложит лимит с запасом 30% к среднему расходу.</li>
          <li>Товары «Не рекламировать» не трогает; новые кампании только советует. Отклонённое не предлагает снова 3 дня.</li>
        </ul>
      </details>

      {dec && <DecideDialog x={dec} busy={busy === 'decide'} note={note} setNote={setNote} onCancel={() => { setDec(null); setNote(''); }} onOk={decide} />}
    </>
  );
}

// ─── Страница ───────────────────────────────────────────────────────────────

function Board({ mp }: { mp: Ads2Mp }) {
  // 15.10: «Конкуренты» переехали в свой раздел — сохранённая вкладка 'competitors' открывает «Обзор».
  const [tab, setTab] = useState<Tab>(() => { try { const t = localStorage.getItem('ads2:tab') as Tab; return TABS.some(([k]) => k === t) ? t : 'overview'; } catch { return 'overview'; } });
  const [days, setDays] = useState<number>(() => { try { return Number(localStorage.getItem('ads2:days')) || 14; } catch { return 14; } });
  const [data, setData] = useState<Ads2Overview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [productKey, setProductKey] = useState<string | null>(null);
  const [openCamp, setOpenCamp] = useState<string | null>(null);

  // Номер запроса: при быстром переключении фильтров старый ответ мог прийти
  // позже нового и затереть его (прожарка 20.10.2026) — применяем только последний.
  const seq = useRef(0);
  const load = useCallback(async () => {
    const my = ++seq.current;
    setLoading(true);
    try { const r = await apiGet<Ads2Overview>(`/api/ads2/overview?mp=${mp}&days=${days}`); if (my === seq.current) { setData(r.data); setErr(null); } }
    catch (e) { if (my === seq.current) setErr(errText(e)); }
    finally { if (my === seq.current) setLoading(false); }
  }, [mp, days]);
  useEffect(() => { void load(); }, [load]);
  const { ask, ui, setToast } = useActions(load);

  const go = (t: Tab) => { setTab(t); try { localStorage.setItem('ads2:tab', t); } catch { /* не критично */ } };
  const syncNow = async () => {
    setSyncing(true);
    try {
      const r = await apiPost<{ result: string[] }>('/api/ads2/sync', {}, { timeoutMs: 180_000 });
      setToast({ ok: true, text: `Кампании обновлены: ${r.data.result.join(' · ').slice(0, 220)}` });
      await load();
    } catch (e) { setToast({ ok: false, text: `Обновить не удалось: ${errText(e)}` }); }
    finally { setSyncing(false); }
  };
  const product = data && productKey ? data.products.find(p => p.key === productKey) ?? null : null;
  const names = useMemo(() => new Map((data?.campaigns ?? []).map(c => [c.id, c.name])), [data]);
  const issues = data?.products.filter(p => p.issues.some(i => i.level !== 'info')).length ?? 0;

  return (
    <div className="grid ad2" style={{ gap: 16 }}>
      <section className="card ad2-head">
        <div className="ad2-tabs" role="tablist">
          {TABS.map(([k, l]) => (
            <button key={k} role="tab" aria-selected={tab === k} className={`ad2-tab ${tab === k ? 'active' : ''}`} onClick={() => go(k)}>
              {l}{k === 'overview' && issues > 0 && <span className="ad2-badge">{issues}</span>}
            </button>
          ))}
        </div>
        <span className="rnp-spacer" />
        <div className="period-switch" role="group" aria-label="Период">
          {[7, 14, 30].map(n => (
            <button key={n} className={`period-btn ${days === n ? 'active' : ''}`} onClick={() => { setDays(n); try { localStorage.setItem('ads2:days', String(n)); } catch { /* не критично */ } }}>{n} дн</button>
          ))}
        </div>
        <span className="muted ad2-small" title={data?.lastSync?.result.join('\n') ?? ''}>
          {loading ? 'загружаю…' : data?.lastSync ? `кампании на ${new Date(data.lastSync.at).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}` : ''}
        </span>
        <button className="btn btn-sm" onClick={syncNow} disabled={syncing} title="Забрать кампании, ставки и лимиты из площадки сейчас">
          <ArrowsClockwiseIcon size={13} className={syncing ? 'spin' : ''} /> Обновить
        </button>
      </section>

      {err && <div className="rnp-alert">Не удалось загрузить рекламу: {err}</div>}
      {data?.notes.map(n => <div key={n} className="rnp-note">{n}</div>)}
      {!data && !err && <div className="card muted">Загружаю…</div>}

      {data && (
        <Fragment key={`${mp}-${days}`}>
          {tab === 'overview' && <Overview d={data} openProduct={setProductKey} />}
          {tab === 'products' && <Products d={data} openProduct={setProductKey} onChanged={load} setToast={setToast} />}
          {tab === 'campaigns' && <Campaigns d={data} ask={ask} openId={openCamp} setOpenId={setOpenCamp} />}
          {tab === 'autopilot' && <Autopilot d={data} setToast={setToast} reload={load} />}
          {tab === 'log' && <Journal mp={mp} names={names} />}
        </Fragment>
      )}

      {data && product && (
        <ProductDrawer d={data} p={product} onClose={() => setProductKey(null)} onChanged={load} setToast={setToast}
          openCampaign={id => { setProductKey(null); setOpenCamp(id); go('campaigns'); }} />
      )}
      {ui}
    </div>
  );
}

export function Ads() {
  const [mp, setMp] = useState<Ads2Mp>(() => { try { return localStorage.getItem('ads2:mp') === 'ozon' ? 'ozon' : 'wb'; } catch { return 'wb'; } });
  const choose = (m: Ads2Mp) => { setMp(m); try { localStorage.setItem('ads2:mp', m); } catch { /* не критично */ } };
  const [topbarH, setTopbarH] = useState(56);
  useEffect(() => {
    const tb = document.querySelector('.topbar') as HTMLElement | null;
    if (!tb) return;
    const measure = () => setTopbarH(h => (tb.offsetHeight !== h ? tb.offsetHeight : h));
    measure();
    const timers = [100, 400, 1000].map(ms => setTimeout(measure, ms));
    window.addEventListener('resize', measure);
    return () => { timers.forEach(clearTimeout); window.removeEventListener('resize', measure); };
  }, []);
  return (
    <div className="grid" style={{ gap: 16 }}>
      <div className="row gap-8 rnp-tabs" style={{ top: topbarH }}>
        <button className={`mp-tab ${mp === 'wb' ? 'active' : ''}`} onClick={() => choose('wb')}>
          <span className="mp-tab-dot" style={{ background: '#cb11ab' }} /> Wildberries
        </button>
        <button className={`mp-tab ${mp === 'ozon' ? 'active' : ''}`} onClick={() => choose('ozon')}>
          <span className="mp-tab-dot" style={{ background: '#005bff' }} /> Ozon
        </button>
      </div>
      <Fragment key={mp}><Board mp={mp} /></Fragment>
    </div>
  );
}
