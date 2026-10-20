/** «Реклама» → «Кампании»: ручное управление — пауза/запуск, ставки, дневной лимит WB, недельный бюджет Ozon. */
import { useEffect, useMemo, useState } from 'react';
import {
  MagnifyingGlassIcon, PencilSimpleIcon, XIcon, CaretDownIcon, CaretRightIcon, PauseIcon, PlayIcon,
} from '@phosphor-icons/react';
import { nf1, nf2, rub, rub2, num, pct, ProductCell } from '../ads2ui';
import type { Ads2Mp, Ads2Overview, Ads2Campaign, Ads2CampaignItem, Ads2Stat } from '../../../shared/ads2';
import { PAYMENT, StatusChip, bidTypeLabel, type Pending } from './shared';


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

export function Campaigns({ d, ask, openId, setOpenId }: { d: Ads2Overview; ask: (p: Pending) => void; openId: string | null; setOpenId: (id: string | null) => void }) {
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
