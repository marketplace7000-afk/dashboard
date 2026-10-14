/**
 * «Конкуренты» — отдельный раздел (15.10.2026, по просьбе владельца: из «Рекламы»
 * вынесено всё про конкурентов, чтобы не было «каши»).
 *
 * Листы:
 *   Привязка конкурентов — у каждого нашего товара его конкуренты: система предлагает,
 *       менеджер подтверждает, отмечает «Не наш» или добавляет своего (кнопка у товара).
 *       Наш товар — первой строкой той же таблицы: цена под ценой, рейтинг под рейтингом.
 *       Строки не прыгают: порядок — как привязаны. Данные свежие: ночью полный проход
 *       Агента 3, днём (11:40, 16:40) и по кнопке «Обновить сейчас» — быстрый по витрине.
 *   Позиции и рынок — WB: позиции наших карточек в поиске, сравнения карточек;
 *       Ozon: наше место среди продавцов категории и топ рынка.
 *   Советник по продажам — почему в выбранный день просели (или выросли) заказы:
 *       день против среднего за 7 дней, по товарам, с причинами и что сделать.
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowsClockwiseIcon, MagnifyingGlassIcon, PlusIcon, WarningIcon, WarningOctagonIcon, LightbulbIcon, TrendUpIcon, InfoIcon, CheckCircleIcon, XIcon,
} from '@phosphor-icons/react';
import { apiGet, apiPost, errText } from '../api/http';
import type {
  Ads2Mp, Ads2Competitors, Ads2WatchLink, Ads2WatchProduct, Ads2Advisor, Ads2AdvisorProduct, Ads2AdvisorCause,
} from '../../shared/ads2';
import { nf0, nf1, rub, num, pct, ddmm, kRub, when, ProductCell, PosDyn, PctDyn, MiniLines } from './ads2ui';

type Sheet = 'watch' | 'market' | 'advisor';
const SHEETS: Array<[Sheet, string]> = [['watch', 'Привязка конкурентов'], ['market', 'Позиции и рынок'], ['advisor', 'Советник по продажам']];

const W_STATUS: Record<Ads2WatchLink['status'], { label: string; cls: string }> = {
  active: { label: 'подтверждён', cls: 'good' }, suggested: { label: 'предложен', cls: 'info' }, ignored: { label: 'не наш', cls: '' },
};

function useToast() {
  const [toast, setToast] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.ok ? 5000 : 12000);
    return () => clearTimeout(t);
  }, [toast]);
  const ui = toast && (
    <div className={`ad2-toast ${toast.ok ? 'ok' : 'bad'}`} role="status">
      {toast.ok ? <CheckCircleIcon size={18} /> : <WarningIcon size={18} />} <span>{toast.text}</span>
      <button className="ad2-x" onClick={() => setToast(null)} aria-label="Закрыть"><XIcon size={14} /></button>
    </div>
  );
  return { setToast, ui };
}

// ─── Лист «Привязка конкурентов» ────────────────────────────────────────────

const TASK_STATUS: Record<string, string> = { queued: 'в очереди', claimed: 'агент взял', running: 'агент снимает', done: 'готово', failed: 'ошибка', cancelled: 'отменено' };

/** Свежесть данных и «Обновить сейчас». Пока задание в работе — опрашиваем сервер. */
function RefreshBar({ d, mp, onData, setToast }: { d: Ads2Competitors; mp: Ads2Mp; onData: (x: Ads2Competitors) => void; setToast: (t: { ok: boolean; text: string }) => void }) {
  const [busy, setBusy] = useState(false);
  const r = d.refresh;
  const open = r.task && ['queued', 'claimed', 'running'].includes(r.task.status);
  const lastDone = useRef<number | null>(r.task?.finishedAt ?? null);
  useEffect(() => {
    if (!open) return;
    const t = setInterval(() => {
      apiGet<Ads2Competitors>(`/api/ads2/competitors?mp=${mp}`).then(x => onData(x.data)).catch(() => { /* следующий опрос */ });
    }, 15_000);
    return () => clearInterval(t);
  }, [open, mp, onData]);
  useEffect(() => {
    const f = r.task?.finishedAt ?? null;
    if (f && lastDone.current && f !== lastDone.current && r.task?.status === 'done') setToast({ ok: true, text: `Данные конкурентов обновлены: ${r.task.message ?? ''}`.slice(0, 220) });
    lastDone.current = f;
  }, [r.task?.finishedAt, r.task?.status, r.task?.message, setToast]);
  const run = async () => {
    setBusy(true);
    try {
      const x = await apiPost<Ads2Competitors & { queued?: { already: boolean } }>('/api/ads2/competitors', { mp, action: 'refresh' });
      onData(x.data);
      setToast({ ok: true, text: x.data.queued?.already ? 'Обновление уже идёт — дождитесь его, данные появятся сами' : 'Агент обновит цены, рейтинг и отзывы за 2–5 минут, данные появятся сами' });
    } catch (e) { setToast({ ok: false, text: `Не запустилось: ${errText(e)}` }); }
    finally { setBusy(false); }
  };
  const next = r.nextRuns.find(t => t > Date.now());
  return (
    <div className="cmp-refresh">
      <div className="cmp-refresh-t">
        <span>Витрина (цены, рейтинг, отзывы): <b>{when(r.cardsAt)}</b></span>
        <span>Аналитика кабинета: <b>{when(r.fullAt)}</b></span>
        {next && <span className="muted">следующее обновление: {when(next)}</span>}
        {r.task && <span className={`chip ${open ? 'info' : r.task.status === 'failed' ? 'bad' : ''}`}>
          {r.task.light ? 'быстрое' : 'полное'} обновление: {TASK_STATUS[r.task.status] ?? r.task.status}{open ? '…' : ''}</span>}
      </div>
      <button className="btn" onClick={run} disabled={busy || !!open} title="Агент на ПК снимет карточки привязанных конкурентов и наших товаров на витрине">
        <ArrowsClockwiseIcon size={15} className={busy || open ? 'spin' : ''} /> Обновить сейчас
      </button>
    </div>
  );
}

/** Строка таблицы сравнения: наш товар и конкуренты в одних колонках. */
function CmpCells({ l, mp, our }: { l: Ads2WatchLink; mp: Ads2Mp; our: Ads2WatchLink | null }) {
  const diff = l !== our && l.price != null && our?.price ? Math.round((l.price / our.price - 1) * 100) : null;
  const day = l.price != null && l.price1d ? Math.round((l.price / l.price1d - 1) * 100) : null;
  const ordSuffix = mp === 'wb' && l.orders != null && l.ordersDays === 7 ? <span className="muted cmp-unit"> за 7 дн</span> : null;
  return (
    <>
      <td className="ad2-num">{l.price == null && l.stock === 0 ? <span className="muted">нет в наличии</span> : rub(l.price)}
        {day != null && Math.abs(day) >= 3 && <div className={`cmp-sub ${day < 0 ? 'bad' : 'good'}`} title={`вчера ${rub(l.price1d)}`}>{day > 0 ? '+' : ''}{day}% за сутки</div>}</td>
      <td className="ad2-num">{diff == null || diff === 0 ? <span className="muted">{l === our ? '' : '–'}</span>
        : <span className={`ad2-dyn ${diff < 0 ? 'bad' : 'good'}`} title={diff < 0 ? 'конкурент дешевле нас' : 'конкурент дороже нас'}>{diff > 0 ? '+' : ''}{diff}%</span>}</td>
      <td className="ad2-num">{l.rating ? nf1.format(l.rating) : <span className="muted">{l.rating === 0 ? 'нет' : '–'}</span>}</td>
      <td className="ad2-num">{num(l.feedbacks)}</td>
      {mp === 'wb' ? <>
        <td className="ad2-num">{num(l.orders)}{ordSuffix} <PctDyn v={l.ordersDyn} /></td>
        <td className="ad2-num">{num(l.avgPos)}</td>
        <td className="ad2-num">{pct(l.ctr)}</td>
      </> : <>
        <td className="ad2-num">{num(l.orders)}</td>
        <td className="ad2-num">{l.gmv != null ? kRub(l.gmv) : '–'}</td>
        <td className="ad2-num">{pct(l.convPdp)}</td>
        <td className="ad2-num">{pct(l.drr)}</td>
      </>}
      <td className="cmp-yn">{l.inAds == null ? '–' : l.inAds ? 'да' : 'нет'} / {l.inPromo == null ? '–' : l.inPromo ? 'да' : 'нет'}</td>
    </>
  );
}

function WatchProduct({ p, mp, showIgnored, onData, setToast }: {
  p: Ads2WatchProduct; mp: Ads2Mp; showIgnored: boolean; onData: (x: Ads2Competitors) => void; setToast: (t: { ok: boolean; text: string }) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [link, setLink] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // «Не наш», нажатое сейчас, оставляет строку на месте (бледной, с «Вернуть»), пока страницу не обновят.
  const [touched, setTouched] = useState<Set<string>>(new Set());
  const send = async (body: Record<string, unknown>, key: string, ok: string) => {
    setBusy(key); setErr(null);
    try {
      const r = await apiPost<Ads2Competitors>('/api/ads2/competitors', { mp, sku: p.key, ...body });
      onData(r.data);
      setToast({ ok: true, text: ok });
      if (body.id) setTouched(s => new Set(s).add(String(body.id)));
      if (body.action === 'add') { setLink(''); setAdding(false); }
    } catch (e) {
      const t = errText(e).replace(/^сервер ответил \d+: /, '');
      if (body.action === 'add') setErr(t); else setToast({ ok: false, text: t });
    } finally { setBusy(null); }
  };
  const add = () => { if (link.trim()) void send({ action: 'add', link: link.trim() }, 'add', 'Конкурент привязан — агент снимет его карточку в ближайшие минуты'); };
  const links = p.links.filter(l => l.status !== 'ignored' || showIgnored || touched.has(l.id));
  const hidden = p.links.length - links.length;
  const our = p.our;
  const mpName = mp === 'wb' ? 'WB' : 'Ozon';
  return (
    <div className="cmp-prod">
      <div className="cmp-prod-head">
        <div className="cmp-prod-id">
          {p.photo ? <img src={p.photo} alt="" loading="lazy" onError={e => { e.currentTarget.style.visibility = 'hidden'; }} /> : <span className="ad2-noimg" />}
          <div>
            <div className="cmp-art">{p.key}</div>
            <div className="muted cmp-name">{our?.url ? <a href={our.url} target="_blank" rel="noreferrer">{p.name}</a> : p.name}{p.ourId ? ` · ${p.ourId}` : ''}</div>
          </div>
        </div>
        <button className={`btn ${adding ? '' : 'btn-primary'}`} onClick={() => { setAdding(a => !a); setErr(null); }}>
          {adding ? 'Отмена' : <><PlusIcon size={14} weight="bold" /> Конкурент</>}
        </button>
      </div>
      {adding && (
        <div className="cmp-add">
          <input className="input" autoFocus value={link} onChange={e => setLink(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') add(); if (e.key === 'Escape') setAdding(false); }}
            placeholder={mp === 'wb' ? 'Ссылка на товар wildberries.ru/catalog/… или артикул WB' : 'Ссылка на товар ozon.ru/product/… или SKU Ozon'} aria-label={`Ссылка или артикул конкурента на ${mpName}`} />
          <button className="btn btn-primary" disabled={!!busy || !link.trim()} onClick={add}>{busy === 'add' ? 'Привязываю…' : 'Привязать'}</button>
          {err && <div className="ad2-err cmp-add-err">{err}</div>}
        </div>
      )}
      {links.length > 0 ? (
        <div className="ad2-scroll cmp-scroll">
          <table className="ad2-table cmp-table">
            <thead><tr>
              <th className="cmp-col-prod">Товар</th>
              <th className="ad2-num">Цена</th><th className="ad2-num" title="Цена конкурента против нашей">К нашей</th>
              <th className="ad2-num">Рейтинг</th><th className="ad2-num">Отзывы</th>
              {mp === 'wb'
                ? <><th className="ad2-num" title="Из «Сравнения карточек» WB за 30 дней; у нашего товара без открытого сравнения — за 7 дней">Заказы, 30 дн</th><th className="ad2-num">Позиция</th><th className="ad2-num">CTR</th></>
                : <><th className="ad2-num">Продано, нед</th><th className="ad2-num">Выручка, нед</th><th className="ad2-num" title="Из карточки в корзину">В корзину</th><th className="ad2-num">ДРР</th></>}
              <th className="cmp-yn" title="Участвует в рекламе / в акции площадки">Реклама / акция</th><th className="cmp-decide">Решение</th>
            </tr></thead>
            <tbody>
              {our && (
                <tr className="cmp-our">
                  <td className="cmp-col-prod"><ProductCell p={{ photo: our.photo || p.photo, name: our.title || p.name, article: `наш товар · ${p.key}`, link: our.url }} /></td>
                  <CmpCells l={our} mp={mp} our={our} />
                  <td className="cmp-decide"><span className="chip ad2-chipsm cmp-chip-our">наш товар</span></td>
                </tr>
              )}
              {links.map(l => {
                const k = `${p.key}:${l.id}`;
                return (
                  <tr key={l.id} className={l.status === 'ignored' ? 'ad2-row-muted' : ''}>
                    <td className="cmp-col-prod">
                      <ProductCell p={{ photo: l.photo, name: l.title || `${mp === 'wb' ? 'артикул' : 'SKU'} ${l.id}`, article: [l.id, l.brand || l.seller].filter(Boolean).join(' · '), link: l.url }} />
                      {(l.note || l.source === 'manual') && <div className="muted cmp-note">{l.source === 'manual' ? 'добавлен вручную' : ''}{l.source === 'manual' && l.note ? ' · ' : ''}{l.note}</div>}
                    </td>
                    <CmpCells l={l} mp={mp} our={our} />
                    <td className="cmp-decide">
                      <span className={`chip ${W_STATUS[l.status].cls} ad2-chipsm`}>{W_STATUS[l.status].label}</span>
                      <div className="cmp-btns">
                      {l.status === 'suggested' && <button className="btn btn-sm" disabled={!!busy} onClick={() => void send({ action: 'approve', id: l.id }, k, 'Подтверждён — идёт в расчёты и советы')}>Подтвердить</button>}
                      {l.status !== 'ignored' && <button className="btn btn-sm" disabled={!!busy} onClick={() => void send({ action: 'ignore', id: l.id }, k, 'Отмечен «не наш» — система его больше не предложит')}>Не наш</button>}
                      {l.status === 'ignored' && <>
                        <button className="btn btn-sm" disabled={!!busy} onClick={() => void send({ action: 'restore', id: l.id }, k, 'Вернул в предложенные')}>Вернуть</button>
                        <button className="btn btn-sm" disabled={!!busy} onClick={() => void send({ action: 'remove', id: l.id }, k, 'Удалён из списка')}>Удалить</button>
                      </>}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : <p className="muted cmp-empty">{p.links.length ? 'Все предложенные отмечены «не наш».' : 'Конкурентов пока нет.'} Добавьте своего: «+ Конкурент».</p>}
      {hidden > 0 && <div className="muted cmp-note">Скрыто «не наших»: {hidden}</div>}
    </div>
  );
}

function WatchSheet({ d, mp, onData, setToast }: { d: Ads2Competitors; mp: Ads2Mp; onData: (x: Ads2Competitors) => void; setToast: (t: { ok: boolean; text: string }) => void }) {
  const [q, setQ] = useState('');
  const [all, setAll] = useState(false);
  const [onlyPending, setOnlyPending] = useState(false);
  const [showIgnored, setShowIgnored] = useState(false);
  const [more, setMore] = useState(15);
  const withLinks = d.watch.filter(p => p.links.length > 0);
  const pendingOf = (p: Ads2WatchProduct) => p.links.filter(l => l.status === 'suggested').length;
  const pending = d.watch.reduce((s, p) => s + pendingOf(p), 0);
  const needle = q.trim().toLowerCase();
  const list = (all ? d.watch : withLinks)
    .filter(p => !onlyPending || pendingOf(p) > 0)
    .filter(p => !needle || p.key.toLowerCase().includes(needle) || p.name.toLowerCase().includes(needle) || p.ourId.includes(needle)
      || p.links.some(l => l.id.includes(needle) || l.title.toLowerCase().includes(needle)));
  return (
    <>
      <section className="card cmp-card">
        <div className="cmp-head">
          <h2>Конкуренты по товарам {pending > 0 && <span className="chip info">ждут решения: {pending}</span>}</h2>
          <RefreshBar d={d} mp={mp} onData={onData} setToast={setToast} />
        </div>
        <p className="muted cmp-lead">
          Система предлагает конкурентов ({mp === 'wb' ? 'из наборов «Сравнение карточек» в кабинете WB' : 'лидеров категории с похожими названием и ценой, «Товары на Ozon»'}).
          В расчёты и советы идут подтверждённые. Не тот — «Не наш», система его больше не предложит. Своего — кнопка «+ Конкурент» у товара.
          Цены, рейтинг и отзывы агент обновляет ночью, в 11:40 и 16:40 и по кнопке «Обновить сейчас»; после привязки нового конкурента — сам через пару минут.
        </p>
        <div className="ad2-filters">
          <label className="ad2-search">
            <MagnifyingGlassIcon size={16} />
            <input className="input" placeholder="Наш артикул, название или артикул конкурента" value={q} onChange={e => { setQ(e.target.value); setMore(15); }} />
          </label>
          <div className="period-switch" role="group" aria-label="Какие товары">
            <button className={`period-btn ${!all ? 'active' : ''}`} onClick={() => setAll(false)}>С конкурентами <span className="ad2-cnt">{withLinks.length}</span></button>
            <button className={`period-btn ${all ? 'active' : ''}`} onClick={() => setAll(true)}>Все товары <span className="ad2-cnt">{d.watch.length}</span></button>
          </div>
          <label className="cmp-check"><input type="checkbox" checked={onlyPending} onChange={e => setOnlyPending(e.target.checked)} /> только ждущие решения</label>
          <label className="cmp-check"><input type="checkbox" checked={showIgnored} onChange={e => setShowIgnored(e.target.checked)} /> показывать «не наших»</label>
        </div>
      </section>
      {list.length === 0 && <div className="card muted">{all || needle || onlyPending ? 'Ничего не найдено.' : 'Привязок пока нет. Предложения появятся после ночного прохода агента; своего конкурента можно привязать в «Все товары».'}</div>}
      {list.slice(0, more).map(p => <WatchProduct key={p.key} p={p} mp={mp} showIgnored={showIgnored} onData={onData} setToast={setToast} />)}
      {list.length > more && <button className="btn" onClick={() => setMore(m => m + 20)}>Показать ещё ({list.length - more})</button>}
    </>
  );
}

// ─── Лист «Позиции и рынок» ─────────────────────────────────────────────────

function MarketSheet({ d, mp }: { d: Ads2Competitors; mp: Ads2Mp }) {
  const [onlyBad, setOnlyBad] = useState(false);
  const head = (
    <p className="muted cmp-lead">
      Данные из аналитики кабинета {mp === 'wb' ? 'WB («Поисковые запросы: ваши товары», «Сравнение карточек»)' : 'Ozon («Товары на Ozon», «Конкурентная позиция»)'} — Агент 3 снимает каждую ночь, только чтение. Снимок: {when(d.at)}.
    </p>
  );
  if (d.empty) return <section className="card">{head}<p>Снимков ещё нет — задание «Конкуренты» запустится ночью по расписанию или кнопкой в «Сборщиках» → Агент 3.</p></section>;
  if (d.wb) {
    const w = d.wb;
    const items = [...w.items].filter(i => !onlyBad || i.bad.length).sort((a, b) => (b.views ?? 0) - (a.views ?? 0));
    return (
      <>
        <section className="ad2-kpis">
          <div className="card ad2-kpi"><div className="card-title">Средняя позиция в поиске</div><div className="ad2-kpi-v">{num(w.summary.avgPos)} <PosDyn v={w.summary.avgPosDyn} /></div><div className="ad2-kpi-sub">медиана {num(w.summary.medianPos)} · {w.period ? `${ddmm(w.period.start)}–${ddmm(w.period.end)}` : '7 дней'}</div></div>
          <div className="card ad2-kpi"><div className="card-title">Видимость</div><div className="ad2-kpi-v">{pct(w.summary.visibility)}</div><div className="ad2-kpi-sub">доля показов карточек в поиске</div></div>
          <div className="card ad2-kpi"><div className="card-title">В рекламе</div><div className="ad2-kpi-v">{num(w.summary.advertised)}</div><div className="ad2-kpi-sub">из {num(w.summary.total)} карточек</div></div>
          <div className="card ad2-kpi"><div className="card-title">Сравнения карточек</div><div className="ad2-kpi-v">{num(w.comparisons.thisMonth)}</div><div className="ad2-kpi-sub">за месяц · агенту можно {w.comparisons.agentLimit}/мес · осталось у WB {num(w.comparisons.remaining)}</div></div>
        </section>
        <section className="card ad2-tablecard">
          <h2>Позиции наших карточек в поиске WB</h2>
          {head}
          <div className="ad2-filters">
            <button className={`period-btn ${!onlyBad ? 'active' : ''}`} onClick={() => setOnlyBad(false)}>Все <span className="ad2-cnt">{w.items.length}</span></button>
            <button className={`period-btn ${onlyBad ? 'active' : ''}`} onClick={() => setOnlyBad(true)}>Есть что исправить <span className="ad2-cnt">{w.items.filter(i => i.bad.length).length}</span></button>
          </div>
          <div className="ad2-scroll">
            <table className="ad2-table">
              <thead><tr><th>Товар</th><th className="ad2-num">Позиция</th><th className="ad2-num">Показы</th><th className="ad2-num">CTR</th><th className="ad2-num">Переходы</th><th className="ad2-num">Заказы</th><th className="ad2-num">Видимость</th><th>Что мешает в поиске (по WB)</th></tr></thead>
              <tbody>
                {items.map(i => (
                  <tr key={i.nmId}>
                    <td className="cmp-col-prod"><ProductCell p={{ photo: i.photo, name: i.vendorCode, article: `${i.name} · ${i.nmId}`, link: `https://www.wildberries.ru/catalog/${i.nmId}/detail.aspx` }} />
                      {i.isAdvertised && <span className="chip info ad2-chipsm">в рекламе</span>}</td>
                    <td className="ad2-num"><b>{num(i.avgPos)}</b> <PosDyn v={i.avgPosDyn} /></td>
                    <td className="ad2-num">{num(i.views)} <PctDyn v={i.viewsDyn} /></td>
                    <td className="ad2-num">{pct(i.ctr)}</td>
                    <td className="ad2-num">{num(i.openCard)}</td>
                    <td className="ad2-num">{num(i.orders)} <PctDyn v={i.ordersDyn} /></td>
                    <td className="ad2-num">{pct(i.visibility)}</td>
                    <td>{i.bad.length ? i.bad.map(b => <span key={b} className="chip warn ad2-chipsm">{b}</span>) : <span className="muted">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
        <section className="card ad2-tablecard">
          <h2>Сравнения карточек (созданы в кабинете WB)</h2>
          <p className="muted cmp-lead">Наш товар выделен. «Отчёт снят» — агент открыл сравнение за 30 дней (заказы, позиция, CTR конкурентов — на листе «Привязка конкурентов»). Бесплатно открываются только свежие наборы (3 дня после создания); чтобы получить отчёт по нужным конкурентам — создайте сравнение в кабинете WB, агент снимет его ночью.</p>
          <div className="ad2-cmpsets">
            {w.comparisons.sets.slice(0, 20).map((s, k) => (
              <div key={k} className="ad2-cmpset">
                <div><b>{s.date ? new Date(s.date).toLocaleDateString('ru-RU') : ''}</b> {s.opened ? <span className="chip good ad2-chipsm">отчёт снят</span> : s.free ? <span className="chip info ad2-chipsm">бесплатно</span> : <span className="chip ad2-chipsm">истёк</span>}</div>
                <div className="ad2-cmpnms">{s.nms.map(n => (
                  <a key={n.nmId} href={`https://www.wildberries.ru/catalog/${n.nmId}/detail.aspx`} target="_blank" rel="noreferrer" className={`ad2-cmpnm ${n.ours ? 'ours' : ''}`} title={n.name}>
                    {n.photo ? <img src={n.photo} alt="" loading="lazy" /> : null}<span>{n.name}</span>
                  </a>
                ))}</div>
              </div>
            ))}
          </div>
        </section>
        {d.errors.length > 0 && <div className="rnp-note">Кабинет ответил ошибкой: {d.errors.join(' · ')}</div>}
      </>
    );
  }
  const o = d.ozon!;
  return (
    <>
      <section className="card ad2-tablecard">
        <h2>Наше место среди продавцов категории</h2>
        {head}
        <div className="ad2-ozpos">
          {o.positions.map(p => (
            <div key={p.category2Id} className="card ad2-kpi">
              <div className="card-title">{p.name}</div>
              <div className="ad2-kpi-v">{p.myPosition ? <>{num(p.myPosition)} <span className="muted cmp-of">из {num(p.sellers)}</span> <PosDyn v={p.myPositionDyn} /></> : <span className="muted cmp-of">нет продаж за период · продавцов {num(p.sellers)}</span>}</div>
              <MiniLines s={p.series} />
              <div className="ad2-kpi-sub"><span className="ad2-lg my">мы</span> <span className="ad2-lg comp">ближайший: {p.competitor ?? '—'}</span> <span className="ad2-lg best">лидер</span>
                {p.percentDiff != null && <> · у ближайшего выручка больше на {nf0.format(p.percentDiff)}%</>}</div>
            </div>
          ))}
        </div>
      </section>
      {o.categories.map(c => {
        const rows = [...c.top, ...c.ours.filter(x => x.rank > 10)];
        return (
          <section key={c.category3Id} className="card ad2-tablecard">
            <h2>{c.name}: топ рынка за неделю <span className="muted cmp-of">{c.ours.length ? `· наших в топ-50: ${c.ours.length}` : '· наших в топ-50 нет'}</span></h2>
            <p className="muted cmp-lead">Средние по категории: в корзину из поиска {pct(c.benchmark.convSearch)}, из карточки {pct(c.benchmark.convPdp)}, ДРР {pct(c.benchmark.drr)}.{c.updateDate ? ` Данные Ozon на ${c.updateDate.slice(0, 10)}.` : ''}</p>
            <div className="ad2-scroll">
              <table className="ad2-table">
                <thead><tr><th className="ad2-num">#</th><th>Товар</th><th>Продавец</th><th className="ad2-num">Цена</th><th className="ad2-num">Выручка</th><th className="ad2-num">Продано</th><th className="ad2-num">В корзину: поиск / карточка</th><th className="ad2-num">ДРР</th><th className="ad2-num">Дней в акциях / трафаретах</th></tr></thead>
                <tbody>
                  {rows.map(x => (
                    <tr key={x.sku} className={x.ours ? 'ad2-row-ours' : ''}>
                      <td className="ad2-num">{x.rank}</td>
                      <td className="cmp-col-prod"><ProductCell p={{ photo: x.photo, name: x.name, article: x.sku, link: x.link }} /></td>
                      <td>{x.ours ? <b>мы</b> : x.seller}</td>
                      <td className="ad2-num">{rub(x.price)}</td>
                      <td className="ad2-num">{kRub(x.gmv ?? 0)} <PctDyn v={x.salesDyn} /></td>
                      <td className="ad2-num">{num(x.sold)}</td>
                      <td className="ad2-num">{pct(x.convSearch)} / {pct(x.convPdp)}</td>
                      <td className="ad2-num">{pct(x.drr)}</td>
                      <td className="ad2-num">{num(x.daysInPromo)} / {num(x.daysWithTrafarets)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}
      {d.errors.length > 0 && <div className="rnp-note">Кабинет ответил ошибкой: {d.errors.join(' · ')}</div>}
    </>
  );
}

// ─── Лист «Советник по продажам» ────────────────────────────────────────────

const WEEKDAY = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const wd = (d: string) => WEEKDAY[new Date(d + 'T12:00:00Z').getUTCDay()];

function CauseLine({ c }: { c: Ads2AdvisorCause }) {
  const Icon = c.level === 'critical' ? WarningOctagonIcon : c.level === 'warn' ? WarningIcon : c.level === 'good' ? TrendUpIcon : InfoIcon;
  return (
    <div className={`adv-cause adv-${c.level}`}>
      <Icon size={17} weight="fill" />
      <div><div>{c.text}</div>{c.action && <div className="adv-action">→ {c.action}</div>}</div>
    </div>
  );
}

function Delta({ a, b, money }: { a: number; b: number; money?: boolean }) {
  if (!b) return null;
  const v = Math.round((a / b - 1) * 100);
  if (!v) return <span className="muted adv-delta">как обычно</span>;
  return <span className={`adv-delta ${v < 0 ? 'bad' : 'good'}`}>{v > 0 ? '+' : ''}{v}% к среднему{money ? '' : ''}</span>;
}

function AdvTable({ rows, kind }: { rows: Ads2AdvisorProduct[]; kind: 'down' | 'up' }) {
  if (!rows.length) return <p className="muted">{kind === 'down' ? 'Заметных просадок по товарам нет.' : 'Заметного роста по товарам нет.'}</p>;
  return (
    <div className="ad2-scroll adv-scroll">
      <table className="ad2-table adv-table">
        <thead><tr><th className="cmp-col-prod">Товар</th><th className="ad2-num">Заказы: день / среднее</th><th className="ad2-num">Выручка: день / среднее</th><th className="ad2-num">Разница</th><th>Что видно в данных и что сделать</th></tr></thead>
        <tbody>
          {rows.map(p => (
            <tr key={p.key}>
              <td className="cmp-col-prod"><ProductCell p={{ photo: p.photo, name: p.article, article: p.name, link: p.link }} /></td>
              <td className="ad2-num">{num(p.orders)} / {nf1.format(p.ordersBase)}</td>
              <td className="ad2-num">{kRub(p.revenue)} / {kRub(p.revenueBase)}</td>
              <td className={`ad2-num ${p.delta < 0 ? 'ad2-bad' : 'adv-good'}`}>{p.delta > 0 ? '+' : ''}{kRub(p.delta)}</td>
              <td className="adv-causes">{p.causes.length ? p.causes.map(c => <CauseLine key={c.code + c.text} c={c} />)
                : <span className="muted">{kind === 'down' ? 'Причина не видна в данных — возможно, спрос; смотреть динамику ещё день' : 'Рост без явной причины в данных'}</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AdvisorSheet({ mp }: { mp: Ads2Mp }) {
  const [date, setDate] = useState<string | null>(null);
  const [d, setD] = useState<Ads2Advisor | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const datesRef = useRef<HTMLDivElement | null>(null);
  // выбранный день — последний справа; на узком экране лента дат прокручивается к нему
  useEffect(() => { const el = datesRef.current?.querySelector('.adv-date.active') as HTMLElement | null; el?.scrollIntoView({ block: 'nearest', inline: 'center' }); }, [d?.date]);
  useEffect(() => {
    setLoading(true);
    apiGet<Ads2Advisor>(`/api/ads2/advisor?mp=${mp}${date ? `&date=${date}` : ''}`)
      .then(r => { setD(r.data); setErr(null); }).catch(e => setErr(errText(e))).finally(() => setLoading(false));
  }, [mp, date]);
  if (err) return <div className="rnp-alert">Советник не загрузился: {err}</div>;
  if (!d) return <div className="card muted">Считаю…</div>;
  const maxDrv = Math.max(1, ...d.drivers.map(x => Math.abs(x.delta)));
  return (
    <>
      <section className="card cmp-card">
        <div className="cmp-head">
          <h2>Советник по продажам · {wd(d.date)} {ddmm(d.date)}</h2>
          {loading && <span className="muted">считаю…</span>}
        </div>
        <p className="muted cmp-lead">День сравнивается со средним за 7 дней до него ({ddmm(d.baseFrom)}–{ddmm(d.baseTo)}). Причины — из РНП (заказы, переходы, корзины, реклама, остатки, цена и СПП), позиций в поиске, журнала рекламы и цен привязанных конкурентов.</p>
        <div className="adv-dates" role="group" aria-label="День" ref={datesRef}>
          {[...d.dates].reverse().map(x => (
            <button key={x} className={`adv-date ${x === d.date ? 'active' : ''} ${['сб', 'вс'].includes(wd(x)) ? 'we' : ''}`} onClick={() => setDate(x)}>
              <span>{wd(x)}</span><b>{ddmm(x)}</b>
            </button>
          ))}
        </div>
      </section>
      <section className="ad2-kpis">
        <div className="card ad2-kpi"><div className="card-title">Заказы</div><div className="ad2-kpi-v">{num(d.day.orders)}</div><Delta a={d.day.orders} b={d.base.orders} /><div className="ad2-kpi-sub">в среднем {nf1.format(d.base.orders)} в день{d.weekAgo ? ` · неделю назад ${num(d.weekAgo.orders)}` : ''}</div></div>
        <div className="card ad2-kpi"><div className="card-title">Выручка (цена продавца)</div><div className="ad2-kpi-v">{kRub(d.day.revenue)}</div><Delta a={d.day.revenue} b={d.base.revenue} money /><div className="ad2-kpi-sub">в среднем {kRub(d.base.revenue)}{d.weekAgo ? ` · неделю назад ${kRub(d.weekAgo.revenue)}` : ''}</div></div>
        <div className="card ad2-kpi"><div className="card-title">Реклама</div><div className="ad2-kpi-v">{rub(d.day.spend)}</div><Delta a={d.day.spend} b={d.base.spend} /><div className="ad2-kpi-sub">ДРР {pct(d.day.drr)} · в среднем {pct(d.base.drr)}</div></div>
        <div className="card ad2-kpi"><div className="card-title">Переходы в карточки</div><div className="ad2-kpi-v">{num(d.day.views)}</div>{d.day.views != null && d.base.views != null && <Delta a={d.day.views} b={d.base.views} />}<div className="ad2-kpi-sub">в корзину {pct(d.day.cartConv)} · в среднем {pct(d.base.cartConv)}</div></div>
      </section>
      {d.summary.length > 0 && (
        <section className="card adv-summary">
          <h2><LightbulbIcon size={18} weight="fill" /> Вывод</h2>
          <ul>{d.summary.map(s => <li key={s}>{s}</li>)}</ul>
        </section>
      )}
      {d.drivers.length > 0 && (
        <section className="card">
          <h2>Главные причины просадки</h2>
          <div className="adv-drivers">
            {d.drivers.map(x => (
              <div key={x.code} className="adv-driver">
                <div className="adv-driver-t"><b>{x.label}</b> <span className="muted">· {x.products} тов.</span></div>
                <div className="adv-bar"><span style={{ width: `${Math.max(3, Math.abs(x.delta) / maxDrv * 100)}%` }} /></div>
                <div className="adv-driver-v">−{kRub(Math.abs(x.delta))}</div>
                {x.action && <div className="adv-action adv-driver-a">→ {x.action}</div>}
              </div>
            ))}
          </div>
        </section>
      )}
      <section className="card ad2-tablecard">
        <h2>Что просело</h2>
        <AdvTable rows={d.down} kind="down" />
      </section>
      <section className="card ad2-tablecard">
        <h2>Что выросло</h2>
        <AdvTable rows={d.up} kind="up" />
      </section>
      {d.notes.map(n => <div key={n} className="rnp-note">{n}</div>)}
    </>
  );
}

// ─── Страница ───────────────────────────────────────────────────────────────

function Board({ mp }: { mp: Ads2Mp }) {
  const [sheet, setSheet] = useState<Sheet>(() => { try { const s = localStorage.getItem('cmp:sheet') as Sheet; return SHEETS.some(([k]) => k === s) ? s : 'watch'; } catch { return 'watch'; } });
  const [d, setD] = useState<Ads2Competitors | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const { setToast, ui } = useToast();
  const onData = useCallback((x: Ads2Competitors) => setD(x), []);
  useEffect(() => {
    setD(null);
    apiGet<Ads2Competitors>(`/api/ads2/competitors?mp=${mp}`).then(r => { setD(r.data); setErr(null); }).catch(e => setErr(errText(e)));
  }, [mp]);
  const go = (s: Sheet) => { setSheet(s); try { localStorage.setItem('cmp:sheet', s); } catch { /* не критично */ } };
  const pending = useMemo(() => d?.watch.reduce((s, p) => s + p.links.filter(l => l.status === 'suggested').length, 0) ?? 0, [d]);
  return (
    <div className="grid ad2 cmp" style={{ gap: 16 }}>
      <section className="card ad2-head">
        <div className="ad2-tabs" role="tablist">
          {SHEETS.map(([k, l]) => (
            <button key={k} role="tab" aria-selected={sheet === k} className={`ad2-tab ${sheet === k ? 'active' : ''}`} onClick={() => go(k)}>
              {l}{k === 'watch' && pending > 0 && <span className="ad2-badge cmp-badge">{pending}</span>}
            </button>
          ))}
        </div>
      </section>
      {sheet === 'advisor' ? <AdvisorSheet mp={mp} /> : <>
        {err && <div className="rnp-alert">Конкуренты не загрузились: {err}</div>}
        {!d && !err && <div className="card muted">Загружаю…</div>}
        {d && sheet === 'watch' && <WatchSheet d={d} mp={mp} onData={onData} setToast={setToast} />}
        {d && sheet === 'market' && <MarketSheet d={d} mp={mp} />}
      </>}
      {ui}
    </div>
  );
}

export function Competitors() {
  const [mp, setMp] = useState<Ads2Mp>(() => { try { return localStorage.getItem('cmp:mp') === 'ozon' ? 'ozon' : localStorage.getItem('cmp:mp') === 'wb' ? 'wb' : (localStorage.getItem('ads2:mp') === 'ozon' ? 'ozon' : 'wb'); } catch { return 'wb'; } });
  const choose = (m: Ads2Mp) => { setMp(m); try { localStorage.setItem('cmp:mp', m); } catch { /* не критично */ } };
  return (
    <div className="grid" style={{ gap: 16 }}>
      <div className="row gap-8 cmp-mps">
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
