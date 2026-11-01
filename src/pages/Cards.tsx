/**
 * «Ведение карточек» (31.10.2026) — только владелец.
 * Два листа: Wildberries и Ozon. Поиск: щёлкнул товар — выбран, рядом «Закрепить» и «Отменить».
 * Карточка — строка таблицы, по щелчку раскрываются вкладки.
 * Размеры и таблицы — как в «Рекламе», шрифт чуть крупнее (стили .cm-* в styles.css).
 * На площадках раздел ничего не меняет.
 */
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { CaretDownIcon, CaretRightIcon } from '@phosphor-icons/react';
import { apiGet, apiPost, errText } from '../api/http';

type Mp = 'wb' | 'ozon';
type Goal = 'growth' | 'hold' | 'sell_out';
type Period = { orders: number; amount: number; ads: number; drrPct: number | null };
type Pin = {
  mp: Mp; sku: string; article: string; name: string; photo: string;
  margin: { pct: number | null; rubPerSale: number | null; roi: number | null; buyoutPct: number | null; profit7d: number | null; minPct: number; minSource: 'card' | 'plan'; floorPrice: number | null; below: boolean } | null;
  goal: Goal; minMarginPct: number | null; minMarginUntil: string | null; maxDrrPct: number | null; minStockDays: number | null;
  turnover?: {
    here: { stock: number | null; fbo: number | null; fbs: number | null; perDay: number | null; days: number | null };
    other: { mp: Mp; stock: number | null; perDay: number | null; days: number | null } | null;
    totalStock: number | null; totalPerDay: number | null; totalDays: number | null;
  };
  cur: Period | null; prev: Period | null; stock: number | null; price: number | null; dataDate: string | null;
};
type Item = { sku: string; article: string; name: string; photo: string };
type Query = {
  text: string; freq: number | null; freqDyn: number | null; pos: number | null; posDyn: number | null;
  reach: number | null; cart: number | null; orders: number | null; ordersDyn: number | null; gmv: number | null;
  viewConv: number | null; visibility: number | null;
};
type CompNm = { nmId: number; shown: boolean | null; pos: number | null; open: number | null; cart: number | null; orders: number | null };
type Comp = {
  setDate: string;
  cards: { nmId: number; name: string; brand: string }[];
  queries: { text: string; freq: number | null; nms?: CompNm[] }[];
};
type Details = { queries: Query[]; collectedAt: number | null; comp: Comp | null };
type WatchLink = {
  id: string; url: string; status: string; title: string; brand: string; seller: string; photo: string;
  price: number | null; rating: number | null; feedbacks: number | null; stock: number | null; orders: number | null; ordersDays: number | null;
  ctr: number | null; gmv: number | null; drr: number | null; convPdp: number | null; inAds: boolean | null; inPromo: boolean | null; hidden: boolean;
};
type Watch = { at: number | null; our: WatchLink | null; links: WatchLink[] };
type VisRow = { sku: string; relevance: number | null; popularity: number | null; rating: number | null; reviews: number | null; price: number | null; delivery: string; promo: string; cpc: number | null; pos: number | null; name: string; seller: string; ours: boolean };
type VisQuery = { query: string; date: string; region: string; regionWhy: string; total: number | null; ours: VisRow | null; top: VisRow[]; topRelevance: number | null; topPopularity: number | null; topPrice: number | null; diag: string };

const GOAL_LABEL: Record<Goal, string> = { growth: 'Рост продаж', hold: 'Удержание', sell_out: 'Распродажа' };
const MP_INFO: Record<Mp, { label: string; color: string }> = {
  wb: { label: 'Wildberries', color: '#cb11ab' },
  ozon: { label: 'Ozon', color: '#005bff' },
};
const num = (n: number | null | undefined) => n == null ? '—' : Math.round(n).toLocaleString('ru-RU');
const rub = (n: number | null | undefined) => n == null ? '—' : `${Math.round(n).toLocaleString('ru-RU')} ₽`;
const pct = (n: number | null | undefined) => n == null ? '—' : `${String(n).replace('.', ',')} %`;
const dec = (n: number | null | undefined) => n == null ? '—' : String(n).replace('.', ',');
const dateRu = (s: string) => s.split('-').reverse().join('.');
const stockDays = (p: Pin) => p.turnover?.here.days ?? null;
/** Товар лежит дольше квартала: деньги заморожены, подсвечиваем. */
const SLOW_DAYS = 90;
const perDay = (n: number | null | undefined) => n == null ? 'нет продаж' : `${String(Math.round(n * 10) / 10).replace('.', ',')} в день`;

function Turnover({ p }: { p: Pin }) {
  const t = p.turnover;
  if (!t) return <>{num(p.stock)}</>;
  const days = t.here.days;
  const low = days != null && p.minStockDays != null && days < p.minStockDays;
  const slow = days != null && days > SLOW_DAYS;
  return (
    <>
      <b className={low ? 'cm-bad' : slow ? 'cm-warn' : ''}>{days == null ? '—' : `${num(days)} дн.`}</b>
      <div className="cm-sub">{num(t.here.stock)} шт. · {perDay(t.here.perDay)}</div>
      <div className="cm-sub">FBO {num(t.here.fbo)} · FBS {num(t.here.fbs)}</div>
      {t.other && <div className="cm-sub">WB + Ozon: {t.totalDays == null ? '—' : `${num(t.totalDays)} дн.`}, {num(t.totalStock)} шт.</div>}
    </>
  );
}

function change(cur?: number, prev?: number) {
  if (cur == null || !prev) return null;
  const d = Math.round(((cur - prev) / prev) * 100);
  return <div className={`cm-sub ${d < 0 ? 'cm-bad' : ''}`}>{d > 0 ? '+' : ''}{d} %</div>;
}

function Settings({ pin, onSaved }: { pin: Pin; onSaved: () => void }) {
  const [f, setF] = useState<{ goal: Goal; minMarginPct: number | string; minMarginUntil: string; maxDrrPct: number | string; minStockDays: number | string }>({
    goal: pin.goal, minMarginPct: pin.minMarginPct ?? '', minMarginUntil: pin.minMarginUntil ?? '', maxDrrPct: pin.maxDrrPct ?? '', minStockDays: pin.minStockDays ?? '',
  });
  const [msg, setMsg] = useState('');
  const save = async () => {
    setMsg('');
    try { await apiPost('/api/cards/pin', { mp: pin.mp, sku: pin.sku, ...f }); setMsg('Сохранено'); onSaved(); }
    catch (e) { setMsg(errText(e)); }
  };
  const days = stockDays(pin);
  const input = (key: 'minMarginPct' | 'maxDrrPct' | 'minStockDays', placeholder: string) => (
    <input className="input" inputMode="decimal" placeholder={placeholder} value={f[key]} onChange={e => setF({ ...f, [key]: e.target.value })} />
  );
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div className="cm-rules">
        <div className="cm-rule">
          <h4>1. Минимальная маржа</h4>
          <div className={`cm-now ${pin.margin?.below ? 'cm-bad' : ''}`}>Сейчас {pct(pin.margin?.pct)}</div>
          {input('minMarginPct', `план месяца ${pct(pin.margin?.minSource === 'plan' ? pin.margin.minPct : null)}`)}
          <label className="field-label" style={{ margin: 0 }}>Действует до
            <input className="input" type="date" value={f.minMarginUntil} onChange={e => setF({ ...f, minMarginUntil: e.target.value })} style={{ marginTop: 4 }} />
          </label>
          <p>Главное правило. Ниже него агент предлагает снижать ставку и не поднимает её, какой бы большой ДРР ни стоял.{pin.mp === 'wb' ? ` Репрайсер не опускает цену ниже ${pin.margin?.floorPrice == null ? 'расчётной границы' : rub(pin.margin.floorPrice)}.` : ''}</p>
        </div>
        <div className="cm-rule">
          <h4>2. Максимальный ДРР</h4>
          <div className="cm-now">Сейчас {pct(pin.cur?.drrPct)}</div>
          {input('maxDrrPct', 'не задан')}
          <p>Дополнительный предел расходов на рекламу. Срабатывает, только если маржа в норме. ДРР 99 % означает «отдельного предела нет», но минимум маржи всё равно действует.</p>
        </div>
        <div className="cm-rule">
          <h4>3. Минимальный запас, дней</h4>
          <div className={`cm-now ${days != null && pin.minStockDays != null && days < pin.minStockDays ? 'cm-bad' : ''}`}>Хватит на {days ?? '—'} дн.</div>
          {input('minStockDays', 'обычно 14')}
          <p>На сколько дней продаж должен оставаться товар. Если запас меньше, агент не предлагает поднимать ставку: иначе реклама быстрее выберет остаток. Пустое поле — порог 14 дней. Меньше 3 дней при расходах на рекламу агент предложит убрать товар из кампании. Автопилот считает запас по продажам за 7 дней, здесь показан расчёт за 28.</p>
        </div>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>Цель
          <select className="input" style={{ width: 190 }} value={f.goal} onChange={e => setF({ ...f, goal: e.target.value as Goal })}>
            {(Object.keys(GOAL_LABEL) as Goal[]).map(g => <option key={g} value={g}>{GOAL_LABEL[g]}</option>)}
          </select>
        </label>
        <button className="btn btn-primary" onClick={save}>Сохранить</button>
        {msg && <span className="muted">{msg}</span>}
      </div>
      <p className="cm-note" style={{ margin: 0 }}>Автопилот рекламы только предлагает: ставки меняются после подтверждения. Цель пока ни на что не влияет. Пустой минимум или истёкший срок возвращают план месяца из «Цен».</p>
    </div>
  );
}

type SortKey = 'freq' | 'pos' | 'reach' | 'orders';

function Queries({ mp, d }: { mp: Mp; d: Details }) {
  const [sort, setSort] = useState<SortKey>('freq');
  const [q, setQ] = useState('');
  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    const list = d.queries.filter(r => r.text.toLowerCase().includes(s));
    // Позиция: меньше — лучше; пустые значения всегда внизу.
    const val = (r: Query) => r[sort] ?? (sort === 'pos' ? Infinity : -Infinity);
    return [...list].sort((a, b) => sort === 'pos' ? val(a) - val(b) : val(b) - val(a));
  }, [d.queries, q, sort]);
  if (!d.queries.length) return <div className="muted">Запросов пока нет: они соберутся при следующем обновлении данных.</div>;
  const head = (key: SortKey, label: string) => (
    <th style={{ cursor: 'pointer', textDecoration: sort === key ? 'underline' : undefined }} onClick={() => setSort(key)} aria-sort={sort === key ? (key === 'pos' ? 'ascending' : 'descending') : 'none'}>{label}</th>
  );
  return (
    <div>
      <div className="cm-filter"><input className="input" placeholder="Найти запрос" value={q} onChange={e => setQ(e.target.value)} /></div>
      <div className="cm-scroll">
        <table className="cm-table">
          <thead><tr>
            <th className="l stick">Запрос</th>
            {head('freq', mp === 'wb' ? 'Частота' : 'Искали')}
            {head('pos', 'Место')}
            {head('reach', mp === 'wb' ? 'Переходы' : 'Увидели')}
            <th>{mp === 'wb' ? 'Корзины' : 'В карточку'}</th>
            {head('orders', 'Заказы')}
          </tr></thead>
          <tbody>{rows.map(r => (
            <tr key={r.text}>
              <td className="l q stick">{r.text}</td>
              <td>{num(r.freq)}</td>
              <td>{num(r.pos)}</td>
              <td>{num(r.reach)}</td>
              <td>{mp === 'wb' ? num(r.cart) : pct(r.viewConv)}</td>
              <td>{num(r.orders)}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      <p className="cm-note">
        {mp === 'wb'
          ? `За 7 дней, ${d.queries.length} запросов по переходам. Показы и CTR по запросу WB не отдаёт.`
          : `Период около 4 недель, без последних 3 дней. Через API Ozon отдаёт не больше 15 самых частых запросов.`}
        {d.collectedAt ? ` Собрано ${new Date(d.collectedAt).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}.` : ''}
      </p>
    </div>
  );
}

/** Наша карточка против привязанных конкурентов: те же данные, что в разделе «Конкуренты». */
function WatchTable({ mp, w }: { mp: Mp; w: Watch }) {
  const row = (x: WatchLink, ours: boolean) => (
    <tr key={x.id} className={ours ? 'is-target' : ''}>
      <td className="l stick">
        <div className="cm-prod" style={{ minWidth: 300 }}>
          {x.photo && <img src={x.photo} alt="" />}
          <span style={{ minWidth: 0 }}>
            {ours ? <b>Наша карточка</b> : <a href={x.url} target="_blank" rel="noreferrer">{x.brand || x.seller || x.id}</a>}
            <div className="cm-sub" style={{ overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>{x.title}</div>
          </span>
        </div>
      </td>
      <td>{rub(x.price)}</td>
      <td>{dec(x.rating)}<div className="cm-sub">{num(x.feedbacks)} отз.</div></td>
      <td>{num(x.orders)}{x.ordersDays ? <div className="cm-sub">за {x.ordersDays} дн.</div> : null}</td>
      {mp === 'ozon' && <td>{rub(x.gmv)}</td>}
      <td>{pct(x.ctr)}</td>
      {mp === 'ozon' && <td>{pct(x.convPdp)}</td>}
      {mp === 'ozon' && <td>{pct(x.drr)}</td>}
      <td>{x.inAds == null ? '—' : x.inAds ? 'да' : 'нет'}</td>
      <td>{x.inPromo == null ? '—' : x.inPromo ? 'да' : 'нет'}</td>
      <td className={x.stock === 0 || x.hidden ? 'cm-bad' : ''}>{x.hidden ? 'не виден' : x.stock == null ? '—' : x.stock === 0 ? 'нет' : num(x.stock)}</td>
    </tr>
  );
  return (
    <div className="cm-scroll">
      <table className="cm-table">
        <thead><tr>
          <th className="l stick">Карточка</th><th>Цена</th><th>Рейтинг</th><th>Заказы</th>
          {mp === 'ozon' && <th>Выручка</th>}
          <th>CTR</th>
          {mp === 'ozon' && <th>В корзину</th>}
          {mp === 'ozon' && <th>ДРР</th>}
          <th>Реклама</th><th>Акции</th><th>Остаток</th>
        </tr></thead>
        <tbody>
          {w.our && row(w.our, true)}
          {w.links.map(l => row(l, false))}
        </tbody>
      </table>
    </div>
  );
}

function Competitors({ pin, comp }: { pin: Pin; comp: Comp | null }) {
  const mp = pin.mp;
  const [w, setW] = useState<Watch | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    let live = true;
    apiGet<Watch>(`/api/cards/competitors?mp=${mp}&sku=${encodeURIComponent(pin.sku)}`)
      .then(r => { if (live) setW(r.data); })
      .catch(e => { if (live) setErr(errText(e)); });
    return () => { live = false; };
  }, [mp, pin.sku]);
  const [own, ...rest] = comp?.cards ?? [];
  const hasNms = !!comp?.queries.some(q => q.nms?.length);
  const of = (q: Comp['queries'][number], nm: number) => q.nms?.find(n => n.nmId === nm);
  const cell = (n?: CompNm) => n == null ? '—' : n.shown === false ? 'нет данных' : <>{num(n.pos)} место<div className="cm-sub">{num(n.orders)} зак.</div></>;
  return (
    <div style={{ display: 'grid', gap: 16 }}>
      {err && <div className="cm-bad">{err}</div>}
      {!w && !err && <div className="muted">Загрузка…</div>}
      {w && (w.links.length
        ? <WatchTable mp={mp} w={w} />
        : <div className="muted">К этой карточке не привязаны конкуренты. Привяжите их в разделе «Конкуренты», и они появятся здесь после ночного прохода.</div>)}
      {mp === 'ozon' && <p className="cm-note" style={{ margin: 0 }}>Цифры из «Товаров на Ozon» и витрины. Запросы конкретного конкурента Ozon открывает только с Premium Pro, поэтому борьбу по запросам смотрите на вкладке «Видимость в поиске»: там лидеры выдачи.</p>}
      {mp === 'wb' && comp && (
        <div>
          <div className="cm-scroll">
            <table className="cm-table">
              <thead><tr>
                <th className="l stick">Запрос</th>
                <th>Частота</th>
                {hasNms && <th className="gl">Мы</th>}
                {hasNms && rest.map(c => <th key={c.nmId} title={c.name}>{c.brand || c.nmId}</th>)}
              </tr></thead>
              <tbody>{comp.queries.map(q => (
                <tr key={q.text}>
                  <td className="l q stick">{q.text}</td>
                  <td>{num(q.freq)}</td>
                  {hasNms && <td className="gl"><b>{cell(of(q, own.nmId))}</b></td>}
                  {hasNms && rest.map(c => <td key={c.nmId}>{cell(of(q, c.nmId))}</td>)}
                </tr>
              ))}</tbody>
            </table>
          </div>
          <p className="cm-note">Сравнение от {dateRu(comp.setDate)}, за 30 дней. «Нет данных»: WB не отдал цифры по этой карточке, это не значит, что её нет в поиске.</p>
        </div>
      )}
      {mp === 'wb' && !comp && <div className="muted">Запросов сравнения пока нет: они появятся после ночного прохода, если у карточки есть открытое сравнение.</div>}
    </div>
  );
}

function Visibility({ pin }: { pin: Pin }) {
  const [rows, setRows] = useState<VisQuery[] | null>(null);
  const [err, setErr] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    apiGet<{ rows: VisQuery[] }>(`/api/cards/visibility?sku=${encodeURIComponent(pin.sku)}`)
      .then(r => { if (live) setRows(r.data.rows); })
      .catch(e => { if (live) setErr(errText(e)); });
    return () => { live = false; };
  }, [pin.sku]);
  if (err) return <div className="cm-bad">{err}</div>;
  if (!rows) return <div className="muted">Загрузка…</div>;
  if (!rows.length) return <div className="muted">Снимка пока нет. Агент снимает его ночью в полном проходе Ozon: до 10 запросов на карточку, сначала ваши целевые.</div>;
  const [first] = rows;
  const sorted = [...rows].sort((a, b) => (a.ours?.pos ?? 1e9) - (b.ours?.pos ?? 1e9));
  return (
    <div>
      <div style={{ marginBottom: 12 }}><b>Регион: {first.region}.</b> <span className="muted">{first.regionWhy}. Снимок от {dateRu(first.date)}.</span></div>
      <div className="cm-scroll">
        <table className="cm-table">
          <thead><tr>
            <th className="l stick">Запрос</th><th>Место</th><th className="l">Что мешает</th>
            <th className="gl">Соответствие запросу</th><th>Популярность</th><th>Цена</th><th>Отзывы</th><th>Доставка</th><th>Акции</th><th>Клик, ₽</th>
          </tr></thead>
          <tbody>{sorted.map(v => (
            <Fragment key={v.query}>
              <tr className="cm-row" onClick={() => setOpen(open === v.query ? null : v.query)}>
                <td className="l q stick">{v.query}</td>
                <td><b>{v.ours?.pos ?? 'нет'}</b>{v.total ? <div className="cm-sub">из {num(v.total)}</div> : null}</td>
                <td className="l" style={{ whiteSpace: 'normal', minWidth: 210 }}>{v.diag}</td>
                <td className={`gl ${v.topRelevance != null && (v.ours?.relevance ?? 0) < v.topRelevance * 0.85 ? 'cm-bad' : ''}`}>{dec(v.ours?.relevance)}<div className="cm-sub">топ-10: {dec(v.topRelevance)}</div></td>
                <td>{dec(v.ours?.popularity)}<div className="cm-sub">топ-10: {dec(v.topPopularity)}</div></td>
                <td>{rub(v.ours?.price)}<div className="cm-sub">топ-10: {rub(v.topPrice)}</div></td>
                <td>{dec(v.ours?.rating)}<div className="cm-sub">{num(v.ours?.reviews)} шт.</div></td>
                <td>{v.ours?.delivery || '—'}</td>
                <td>{v.ours?.promo || '—'}</td>
                <td>{dec(v.ours?.cpc)}</td>
              </tr>
              {open === v.query && v.top.map(t => (
                <tr key={t.sku}>
                  <td className="l q stick" style={{ fontWeight: 400 }}>{t.pos}. {t.name}<div className="cm-sub">{t.seller}</div></td>
                  <td>{t.pos}</td><td />
                  <td className="gl">{dec(t.relevance)}</td><td>{dec(t.popularity)}</td><td>{rub(t.price)}</td>
                  <td>{dec(t.rating)}<div className="cm-sub">{num(t.reviews)} шт.</div></td>
                  <td>{t.delivery || '—'}</td><td>{t.promo || '—'}</td><td>{dec(t.cpc)}</td>
                </tr>
              ))}
            </Fragment>
          ))}</tbody>
        </table>
      </div>
      <p className="cm-note">Щёлкните запрос, чтобы увидеть первую десятку. Это снимок одного момента: Ozon не советует сравнивать оценки разных дней и складывать их между собой, у параметров разный вес. Динамику смотрите по среднему месту и заказам на вкладке «Запросы».</p>
    </div>
  );
}

type SeoDraft = {
  id: number; status: 'draft' | 'approved' | 'rejected';
  before: { title: string; description: string }; after: { title: string; description: string };
  why: string; used: string[]; usedTitle?: string[]; usedDescription?: string[]; skipped: { query: string; reason: string }[]; warnings: string[];
};
type SeoGapRow = {
  text: string; freq: number | null; pos: number | null; reach: number | null; cart: number | null; orders: number | null;
  tier: 'ВЧ' | 'СЧ' | 'НЧ' | null; verdict: 'works' | 'weak' | 'nodata';
  ad: { clicks: number; carts: number; orders: number; spend: number } | null; mark: 'target' | 'exclude' | null; missing: string[];
};
type SeoData = { content: { title: string; description: string }; adDays: number | null; gaps: SeoGapRow[]; draft: SeoDraft | null };
type SeoFilter = 'all' | 'none' | 'target' | 'exclude';

function TextBox({ label, text }: { label: string; text: string }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div className="muted">{label}</div>
      <div className="cm-text">{text}</div>
    </div>
  );
}

function SeoEdits({ pin }: { pin: Pin }) {
  const [d, setD] = useState<SeoData | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<SeoFilter>('all');
  const [q, setQ] = useState('');
  const load = useCallback(async () => {
    try { setD((await apiGet<SeoData>(`/api/cards/seo?mp=${pin.mp}&sku=${encodeURIComponent(pin.sku)}`)).data); setErr(''); }
    catch (e) { setErr(errText(e)); }
  }, [pin.mp, pin.sku]);
  useEffect(() => { void load(); }, [load]);
  const make = async () => {
    setBusy(true); setErr('');
    try { await apiPost('/api/cards/seo/draft', { mp: pin.mp, sku: pin.sku }); await load(); }
    catch (e) { setErr(errText(e)); }
    finally { setBusy(false); }
  };
  const mark = async (text: string, value: 'target' | 'exclude' | null) => {
    // Отметка видна сразу, без ожидания сервера; при ошибке данные перечитываются.
    setD(cur => cur && { ...cur, gaps: cur.gaps.map(g => g.text === text ? { ...g, mark: value } : g) });
    try { await apiPost('/api/cards/seo/mark', { mp: pin.mp, sku: pin.sku, text, mark: value }); }
    catch (e) { setErr(errText(e)); await load(); }
  };
  const decide = async (id: number, decision: 'approved' | 'rejected') => {
    try { await apiPost('/api/cards/seo/decide', { id, decision }); await load(); }
    catch (e) { setErr(errText(e)); }
  };
  if (err && !d) return <div className="cm-bad">{err}</div>;
  if (!d) return <div className="muted">Загрузка…</div>;
  const dr = d.draft;
  const isWb = pin.mp === 'wb', hasAds = d.adDays != null;
  const counts: Record<SeoFilter, number> = {
    all: d.gaps.length, none: d.gaps.filter(g => !g.mark).length,
    target: d.gaps.filter(g => g.mark === 'target').length, exclude: d.gaps.filter(g => g.mark === 'exclude').length,
  };
  const s = q.trim().toLowerCase();
  const rows = d.gaps.filter(g => (filter === 'all' || (filter === 'none' ? !g.mark : g.mark === filter)) && g.text.includes(s));
  const filters: [SeoFilter, string][] = [['all', 'Все'], ['none', 'Без решения'], ['target', 'Целевые'], ['exclude', 'Не наши']];
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div><b>Сейчас в карточке:</b> {d.content.title}</div>
      {d.gaps.length > 0 ? (
        <div>
          <div className="cm-filter">
            <input className="input" placeholder="Найти запрос" value={q} onChange={e => setQ(e.target.value)} />
            {filters.map(([k, label]) => <button key={k} className={`cm-chip ${filter === k ? 'active' : ''}`} onClick={() => setFilter(k)}>{label} · {counts[k]}</button>)}
          </div>
          <div className="cm-scroll">
            <table className="cm-table">
              <thead>
                <tr>
                  <th className="l stick" rowSpan={2}>Запрос</th>
                  <th className="l" rowSpan={2}>Ваше решение</th>
                  <th rowSpan={2}>Тип</th>
                  <th className="c" colSpan={isWb ? 5 : 4}>Поиск{isWb ? ' за 7 дн.' : ' за 4 нед.'}</th>
                  {hasAds && <th className="c" colSpan={4}>Реклама за {d.adDays} дн.</th>}
                  <th className="gl" rowSpan={2}>Оценка</th>
                  <th className="l" rowSpan={2}>Нет в тексте</th>
                </tr>
                <tr className="two">
                  <th className="gl">{isWb ? 'Частота' : 'Искали'}</th><th>Место</th><th>{isWb ? 'Переходы' : 'Увидели'}</th>{isWb && <th>Корзины</th>}<th>Заказы</th>
                  {hasAds && <><th className="gl">₽</th><th>Переходы</th><th>Корзины</th><th>Заказы</th></>}
                </tr>
              </thead>
              <tbody>{rows.map(g => (
                <tr key={g.text} className={g.mark ? `is-${g.mark}` : ''}>
                  <td className="l q stick">{g.text}</td>
                  <td className="l">
                    <span className="cm-marks">
                      <button className={`cm-mark ${g.mark === 'target' ? 'on-target' : ''}`} onClick={() => mark(g.text, g.mark === 'target' ? null : 'target')}>Целевой</button>
                      <button className={`cm-mark ${g.mark === 'exclude' ? 'on-exclude' : ''}`} onClick={() => mark(g.text, g.mark === 'exclude' ? null : 'exclude')}>Не наш</button>
                    </span>
                  </td>
                  <td>{g.tier ?? '—'}</td>
                  <td className="gl">{num(g.freq)}</td><td>{num(g.pos)}</td><td>{num(g.reach)}</td>{isWb && <td>{num(g.cart)}</td>}<td>{num(g.orders)}</td>
                  {hasAds && (g.ad
                    ? <><td className="gl">{num(g.ad.spend)}</td><td>{num(g.ad.clicks)}</td><td>{num(g.ad.carts)}</td><td>{num(g.ad.orders)}</td></>
                    : <><td className="gl">—</td><td>—</td><td>—</td><td>—</td></>)}
                  <td className={`gl ${g.verdict === 'weak' ? 'cm-bad' : g.verdict === 'works' ? 'cm-good' : ''}`}>{g.verdict === 'works' ? 'работает' : g.verdict === 'weak' ? 'слабая воронка' : 'мало данных'}</td>
                  <td className="l" style={{ whiteSpace: 'normal', minWidth: 150 }}>{g.missing.join(', ') || '—'}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
          <p className="cm-note">Типы считаются от самого частого запроса карточки, кроме отмеченных «Не наш». Заказы в рекламе показывают только то, что площадка привязала к запросу, а не все заказы карточки.{!isWb ? ' Реклама Ozon по запросам пока не собирается.' : ''}</p>
        </div>
      ) : <div className="muted">Запросов без покрытия в тексте и рекламных трат нет.</div>}
      {err && <div className="cm-bad">{err}</div>}
      <div><button className="btn btn-primary" onClick={make} disabled={busy || !d.gaps.length}>{busy ? 'Готовлю черновик…' : 'Подготовить черновик'}</button></div>
      {dr && (
        <div style={{ display: 'grid', gap: 12, borderTop: '1px solid var(--border)', paddingTop: 14 }}>
          {dr.why && <div>{dr.why}</div>}
          {dr.warnings.map(w => <div key={w} className="cm-bad">Проверьте: {w}</div>)}
          <div className="cm-texts">
            <TextBox label="Название, было" text={dr.before.title} />
            <TextBox label="Название, станет" text={dr.after.title} />
            <TextBox label="Описание, было" text={dr.before.description} />
            <TextBox label="Описание, станет" text={dr.after.description} />
          </div>
          {dr.usedTitle && dr.usedTitle.length > 0 && <div className="muted">В название: {dr.usedTitle.join(', ')}</div>}
          {dr.usedDescription && dr.usedDescription.length > 0 && <div className="muted">В описание: {dr.usedDescription.join(', ')}</div>}
          {dr.skipped.length > 0 && <div className="muted">Не взяты: {dr.skipped.map(x => `${x.query} (${x.reason})`).join('; ')}</div>}
          {dr.status === 'draft'
            ? <div style={{ display: 'flex', gap: 8 }}><button className="btn btn-primary" onClick={() => decide(dr.id, 'approved')}>Принять</button><button className="btn" onClick={() => decide(dr.id, 'rejected')}>Отклонить</button></div>
            : <div><b>{dr.status === 'approved' ? 'Принято' : 'Отклонено'}</b></div>}
          <div className="muted">Отправки на площадку пока нет: «Принять» только записывает решение, карточка не меняется.</div>
        </div>
      )}
    </div>
  );
}

type Tab = 'queries' | 'comp' | 'vis' | 'edits' | 'rules';

function PinDetails({ pin, onChanged }: { pin: Pin; onChanged: () => void }) {
  const [tab, setTab] = useState<Tab>('queries');
  const [d, setD] = useState<Details | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    let live = true;
    apiGet<Details>(`/api/cards/details?mp=${pin.mp}&sku=${encodeURIComponent(pin.sku)}`)
      .then(r => { if (live) setD(r.data); })
      .catch(e => { if (live) setErr(errText(e)); });
    return () => { live = false; };
  }, [pin.mp, pin.sku]);
  const tabs: [Tab, string][] = [
    ['queries', 'Запросы'], ['comp', 'Конкуренты'],
    ...(pin.mp === 'ozon' ? [['vis', 'Видимость в поиске'] as [Tab, string]] : []),
    ['edits', 'Правки SEO'], ['rules', 'Рамки'],
  ];
  return (
    <div>
      <div className="cm-tabs">
        {tabs.map(([k, label]) => <button key={k} className={`cm-tab ${tab === k ? 'active' : ''}`} onClick={() => setTab(k)}>{label}</button>)}
      </div>
      {tab === 'rules'
        ? <Settings key={`${pin.goal}|${pin.minMarginPct}|${pin.minMarginUntil}|${pin.maxDrrPct}|${pin.minStockDays}`} pin={pin} onSaved={onChanged} />
        : tab === 'edits' ? <SeoEdits pin={pin} />
        : tab === 'vis' ? <Visibility pin={pin} />
        : err ? <div className="cm-bad">{err}</div>
        : !d ? <div className="muted">Загрузка…</div>
        : tab === 'queries' ? <Queries mp={pin.mp} d={d} />
        : <Competitors pin={pin} comp={d.comp} />}
    </div>
  );
}

export function Cards() {
  const [pins, setPins] = useState<Pin[] | null>(null);
  const [error, setError] = useState('');
  const [mp, setMp] = useState<Mp>('wb');
  const [items, setItems] = useState<Item[]>([]);
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<Item | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setPins((await apiGet<{ pins: Pin[] }>('/api/cards')).data.pins); setError(''); }
    catch (e) { setError(errText(e)); }
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
    if (!s || picked) return [];
    return items.filter(i => `${i.article} ${i.name} ${i.sku}`.toLowerCase().includes(s)).slice(0, 8);
  }, [items, q, picked]);

  const cancel = () => { setPicked(null); setQ(''); };
  const choose = (m: Mp) => { setMp(m); cancel(); setOpen(null); };
  const pin = async () => {
    if (!picked) return;
    try { await apiPost('/api/cards/pin', { mp, sku: picked.sku }); cancel(); await load(); }
    catch (e) { setError(errText(e)); }
  };
  const unpin = async (p: Pin) => {
    try { await apiPost('/api/cards/unpin', { mp: p.mp, sku: p.sku }); await load(); }
    catch (e) { setError(errText(e)); }
  };

  const list = pins?.filter(p => p.mp === mp) ?? [];
  const count = (m: Mp) => pins?.filter(p => p.mp === m).length ?? 0;

  return (
    <div className="cm">
      <div className="rnp-tabs" style={{ display: 'flex', gap: 6 }}>
        {(Object.keys(MP_INFO) as Mp[]).map(m => (
          <button key={m} className={`mp-tab ${mp === m ? 'active' : ''}`} onClick={() => choose(m)}>
            <span className="mp-tab-dot" style={{ background: MP_INFO[m].color }} /> {MP_INFO[m].label} · {count(m)}
          </button>
        ))}
      </div>

      <div className="cm-card">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          <input
            className="input" style={{ flex: '1 1 260px', width: 'auto', fontSize: 18 }} placeholder={`Найти товар ${MP_INFO[mp].label}: артикул или название`}
            value={picked ? `${picked.article || picked.sku} · ${picked.name}` : q} readOnly={!!picked} onChange={e => setQ(e.target.value)}
          />
          {picked && <button className="btn btn-primary" onClick={pin}>Закрепить</button>}
          {(picked || q) && <button className="btn" onClick={cancel}>Отменить</button>}
        </div>
        {found.length > 0 && (
          <div style={{ marginTop: 6 }}>
            {found.map(i => (
              <button key={i.sku} className="btn" style={{ display: 'flex', gap: 10, alignItems: 'center', width: '100%', textAlign: 'left', marginTop: 4 }} onClick={() => setPicked(i)}>
                {i.photo && <img src={i.photo} alt="" width={36} height={46} style={{ objectFit: 'cover', borderRadius: 4 }} />}
                <span style={{ minWidth: 0 }}><b>{i.article || i.sku}</b> · {i.name}</span>
              </button>
            ))}
          </div>
        )}
        {q.trim() && !picked && !found.length && <div className="muted" style={{ marginTop: 8 }}>Ничего не найдено</div>}
      </div>

      {error && <div className="cm-card cm-bad">{error}</div>}
      {pins === null && !error && <div className="cm-card muted">Загрузка…</div>}
      {pins && !list.length && <div className="cm-card muted">На этом листе карточек нет. Найдите товар выше, щёлкните по нему и нажмите «Закрепить».</div>}

      {list.length > 0 && (
        <div className="cm-card" style={{ padding: 0, overflowX: 'auto' }}>
          <table className="cm-table wide">
            <thead><tr>
              <th className="l">Карточка</th>
              <th>Заказы, 7 дн</th><th>Сумма</th><th>Реклама</th><th>ДРР</th><th>Маржа</th><th>Прибыль, 7 дн</th><th>Цена</th><th title="За сколько дней разойдётся остаток при продажах за 28 дней. Меньше дней — быстрее оборот.">Оборачиваемость</th><th />
            </tr></thead>
            <tbody>
              {list.map(p => {
                const key = `${p.mp}:${p.sku}`, isOpen = open === key;
                return (
                  <Fragment key={key}>
                    <tr className="cm-row" onClick={() => setOpen(isOpen ? null : key)} aria-expanded={isOpen}>
                      <td className="l">
                        <div className="cm-prod">
                          {isOpen ? <CaretDownIcon size={18} /> : <CaretRightIcon size={18} />}
                          {p.photo && <img src={p.photo} alt="" />}
                          <span style={{ minWidth: 0 }}>
                            <b>{p.article || p.sku}</b>
                            <div className="cm-sub" style={{ overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>{p.name}</div>
                          </span>
                        </div>
                      </td>
                      <td>{num(p.cur?.orders)}{change(p.cur?.orders, p.prev?.orders)}</td>
                      <td>{rub(p.cur?.amount)}{change(p.cur?.amount, p.prev?.amount)}</td>
                      <td>{rub(p.cur?.ads)}</td>
                      <td className={p.maxDrrPct != null && (p.cur?.drrPct ?? 0) > p.maxDrrPct ? 'cm-bad' : ''}>{pct(p.cur?.drrPct)}{p.maxDrrPct != null && <div className="cm-sub">макс. {pct(p.maxDrrPct)}</div>}</td>
                      <td className={p.margin?.below ? 'cm-bad' : ''}><b>{pct(p.margin?.pct)}</b><div className="cm-sub">мин. {pct(p.margin?.minPct)}</div></td>
                      <td>{rub(p.margin?.profit7d)}<div className="cm-sub">{rub(p.margin?.rubPerSale)} с продажи</div></td>
                      <td>{rub(p.price)}</td>
                      <td><Turnover p={p} /></td>
                      <td><button className="btn btn-sm" onClick={e => { e.stopPropagation(); void unpin(p); }}>Открепить</button></td>
                    </tr>
                    {isOpen && <tr><td colSpan={10} style={{ padding: 16, textAlign: 'left', whiteSpace: 'normal', maxWidth: 0 }}><PinDetails pin={p} onChanged={load} /></td></tr>}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <div className="muted">Агент пока только наблюдает: на площадках ничего не меняется.</div>
    </div>
  );
}
