/**
 * «Закупки» (19.11.2026) — что, сколько и когда заказать в Китае. Только владелец:
 * сервер закрывает /api/purchase всем остальным. Расчёт — shared/purchase.ts, данные — api/_lib/purchase.ts;
 * экран только показывает и сохраняет настройки и отметки «больше не закупаем».
 */
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowClockwiseIcon, CaretDownIcon, CaretUpIcon, GearIcon, MagnifyingGlassIcon } from '@phosphor-icons/react';
import '../purchase.css';
import { PurchaseSeason } from './PurchaseSeason';
import { apiGet, apiPost, errText } from '../api/http';
import type { PurchaseRow, PurchaseSettings, MoneyCheck, PurchaseTotals, Signal, TransitLot } from '../../shared/purchase';

type Resp = {
  ok: true; today: string; builtAt: string; settings: PurchaseSettings;
  rates: { usd: number; cny: number; source: 'owner' | 'cbr' | 'none'; date: string };
  leadDefault: number; leadSamples: number; rows: PurchaseRow[]; totals: PurchaseTotals; lots: TransitLot[]; failed: string[]; notes: string[]; money: MoneyCheck | null; minBalance: number;
};
type Filter = 'order' | 'all' | 'ok' | 'skip';

/** Почему товар в архиве или почему нет, хотя «План» говорит иное. */
const skipNote = (r: PurchaseRow) =>
  r.skipBy === 'plan' ? (r.planStatus === 'Архив' ? 'архив «Плана»' : '«Вывод» в «Плане»')
  : r.skipBy === 'hand' && r.skip ? 'отмечено здесь'
  : r.skipBy === 'hand' ? 'закупаем, хоть в «Плане» «' + r.planStatus + '»'
  : '';

const nf0 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });
const rub = (v: number) => (v ? `${nf0.format(v)} ₽` : '–');
const mln = (v: number) => `${(v / 1e6).toLocaleString('ru-RU', { maximumFractionDigits: 1, minimumFractionDigits: 1 })} млн ₽`;
const ddmm = (d: string) => (d ? `${d.slice(8, 10)}.${d.slice(5, 7)}` : '–');
const MONTHS = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const SIGNAL: Record<Signal, { label: string; cls: string }> = {
  late: { label: 'Пора заказывать', cls: 'late' },
  soon: { label: 'На этой неделе', cls: 'soon' },
  ok: { label: 'Запас есть', cls: 'ok' },
  none: { label: 'Нет продаж', cls: 'none' },
  skip: { label: 'В архиве', cls: 'skip' },
};

function whenText(r: PurchaseRow): string {
  if (r.signal === 'none' || r.daysToOrder === null) return '–';
  if (r.daysTotal === 0) return 'товара нет — заказать сейчас';
  if (r.daysToOrder < 0) return `опоздали на ${-r.daysToOrder} дн.`;
  if (r.daysToOrder === 0) return 'сегодня';
  return `до ${ddmm(r.orderBy)} · через ${r.daysToOrder} дн.`;
}

type Sheet = 'buy' | 'season';

/** Листы раздела: «Что заказать» и «Сезонность» (21.11.2026). */
export function Purchase() {
  const [sheet, setSheet] = useState<Sheet>(() => { try { return (localStorage.getItem('pur.sheet') as Sheet) || 'buy'; } catch { return 'buy'; } });
  const pick = (s: Sheet) => { setSheet(s); try { localStorage.setItem('pur.sheet', s); } catch { /* лист просто не запомнится */ } };
  return (
    <div className="sa pur">
      <div className="pur-sheets sa-seg">
        <button className={sheet === 'buy' ? 'on' : ''} onClick={() => pick('buy')}>Что заказать</button>
        <button className={sheet === 'season' ? 'on' : ''} onClick={() => pick('season')}>Сезонность</button>
      </div>
      {sheet === 'buy' ? <PurchaseBuy /> : <PurchaseSeason />}
    </div>
  );
}

function PurchaseBuy() {
  const [data, setData] = useState<Resp | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<Filter>(() => { try { return (localStorage.getItem('pur.filter') as Filter) || 'order'; } catch { return 'order'; } });
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);

  const load = useCallback(async (fresh = false) => {
    setBusy(true);
    try { const r = await apiGet<Resp>(`/api/purchase${fresh ? '?fresh=1' : ''}`); setData(r.data); setErr(''); }
    catch (e) { setErr(errText(e)); }
    finally { setBusy(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const setF = (f: Filter) => { setFilter(f); try { localStorage.setItem('pur.filter', f); } catch { /* фильтр просто не запомнится */ } };

  const toggleSkip = async (key: string, skip: boolean) => {
    try { await apiPost('/api/purchase/skip', { key, skip }); await load(true); } catch (e) { setErr(errText(e)); }
  };

  const rows = useMemo(() => {
    const all = data?.rows ?? [];
    const s = q.trim().toLowerCase();
    return all.filter(r => {
      if (s && !`${r.name} ${r.articles.join(' ')}`.toLowerCase().includes(s)) return false;
      if (filter === 'order') return r.signal === 'late' || r.signal === 'soon';
      if (filter === 'ok') return r.signal === 'ok';
      if (filter === 'skip') return r.signal === 'skip';
      return r.signal !== 'skip';   // «Все» — без архива
    });
  }, [data, filter, q]);

  if (!data) {
    return <div className="card">{err ? <span className="bad">Не загрузилось: {err}</span> : 'Считаю закупки…'}</div>;
  }
  const t = data.totals;
  const counts = { order: t.late + t.soon, all: data.rows.filter(r => r.signal !== 'skip').length, ok: t.ok, skip: data.rows.filter(r => r.signal === 'skip').length };

  return (
    <>
      {(data.failed.length > 0 || err) && (
        <div className="card pur-fail">
          {err && <div>Не выполнено: {err}</div>}
          {data.failed.map(f => <div key={f}>Не прочитано: {f}. Остальные цифры посчитаны без этого.</div>)}
        </div>
      )}

      <div className="pur-kpis">
        <div className="card pur-kpi late"><div className="card-title">Пора заказывать</div><b>{t.late}</b><span>{mln(t.sumLate)}</span></div>
        <div className="card pur-kpi soon"><div className="card-title">Заказать на этой неделе</div><b>{t.soon}</b><span>{mln(t.sumSoon)}</span></div>
        <div className="card pur-kpi"><div className="card-title">Закупки на 30 дней вперёд</div><b>{mln(t.sum30)}</b><span>фабрика + логистика</span></div>
        <div className="card pur-kpi"><div className="card-title">Запас есть</div><b>{t.ok}</b><span>товаров</span></div>
      </div>

      {data.money && <MoneyCard m={data.money} min={data.minBalance} rows={data.rows} />}

      <div className="pur-bar">
        <div className="sa-seg">
          {([['order', 'К заказу'], ['all', 'Все'], ['ok', 'Запас есть'], ['skip', 'Архив']] as Array<[Filter, string]>).map(([k, l]) => (
            <button key={k} className={filter === k ? 'on' : ''} onClick={() => setF(k)}>{l} <span className="muted">{counts[k]}</span></button>
          ))}
        </div>
        <label className="pur-search"><MagnifyingGlassIcon size={18} /><input className="input" placeholder="Товар или артикул" value={q} onChange={e => setQ(e.target.value)} /></label>
        <span className="pur-spacer" />
        <span className="muted pur-meta">
          $ {nf1.format(data.rates.usd)} ₽ · ¥ {nf1.format(data.rates.cny)} ₽ {data.rates.source === 'cbr' ? `(ЦБ ${ddmm(data.rates.date)})` : data.rates.source === 'owner' ? `(ваш, ${ddmm(data.rates.date)})` : '(курса нет)'}
          {' · '}срок {data.leadDefault} дн.
        </span>
        <button className="btn" onClick={() => setShowSettings(v => !v)}><GearIcon size={18} /> Настройки</button>
        <button className="btn" disabled={busy} onClick={() => void load(true)}><ArrowClockwiseIcon size={18} /> {busy ? 'Считаю…' : 'Пересчитать'}</button>
      </div>

      {showSettings && <SettingsPanel data={data} onSaved={() => { setShowSettings(false); void load(true); }} />}

      <div className="card pur-table-card">
        <div className="pur-scroll">
          <table className="pur-table">
            <thead>
              <tr>
                <th>Товар</th>
                <th className="num">Продаж в день</th>
                <th className="num">Есть сейчас</th>
                <th className="num">Едет из Китая</th>
                <th className="num">Хватит, дней</th>
                <th>Когда заказать</th>
                <th className="num">Сколько и сумма</th>
                <th>В архив</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => {
                const isOpen = open === r.key;
                const sig = SIGNAL[r.signal];
                const etas = r.lots.map(l => l.eta).filter(Boolean).sort();
                return (
                  <Fragment key={r.key}>
                    <tr className={`pur-row ${sig.cls}`} onClick={() => setOpen(isOpen ? null : r.key)}>
                      <td className="pur-name"><div className="pur-name-in">
                        <span className="pur-caret">{isOpen ? <CaretUpIcon size={16} /> : <CaretDownIcon size={16} />}</span>
                        <div>
                          <div>{r.name}</div>
                          <div className="muted pur-art">{r.articles.join(' · ')}{r.planStatus && r.planStatus !== 'Рабочий' && <span className={`chip pur-st ${r.planStatus === 'Новинка' ? 'new' : 'out'}`}>{r.planStatus}</span>}</div>
                        </div>
                      </div></td>
                      <td className="num">{r.ratePerDay ? nf1.format(r.ratePerDay) : '–'}{r.rateBasis === 'plan' && <div className="muted pur-sub">по плану</div>}</td>
                      <td className="num">{nf0.format(r.stockFf + r.stockFbo)}<div className="muted pur-sub">FBS {nf0.format(r.stockFf)} · FBO {nf0.format(r.stockFbo)}</div></td>
                      <td className="num">{r.transit ? nf0.format(r.transit) : '–'}{etas.length > 0 && <div className="muted pur-sub">≈ {ddmm(etas[0])}</div>}</td>
                      <td className="num">{r.daysOnHand ?? '–'}{r.transit > 0 && r.daysTotal !== null && <div className="muted pur-sub">с едущим {r.daysTotal}</div>}</td>
                      <td><span className={`pur-sig ${sig.cls}`}>{sig.label}</span><div className="pur-sub">{whenText(r)}</div>{r.gap && <div className="pur-sub bad">не будет с {ddmm(r.gap.from)} до {ddmm(r.gap.to)}</div>}</td>
                      <td className="num">{r.qty ? `${nf0.format(r.qty)} шт.` : '–'}{r.qty > 0 && <div className="pur-sub">{rub(r.sumFactory + r.sumLogistics)}</div>}{r.boxQty > 1 && r.qty > 0 && <div className="muted pur-sub">коробка {r.boxQty}</div>}</td>
                      <td onClick={e => e.stopPropagation()}>
                        <label className="pur-skip" title="Архив: не предлагать к заказу, не считать в деньгах и в утренней сводке"><input type="checkbox" checked={r.skip} onChange={e => void toggleSkip(r.key, e.target.checked)} /> </label>
                        {skipNote(r) && <div className="muted pur-sub">{skipNote(r)}</div>}
                      </td>
                    </tr>
                    {isOpen && (
                      <tr className="pur-detail"><td colSpan={8}><RowDetail r={r} /></td></tr>
                    )}
                  </Fragment>
                );
              })}
              {!rows.length && <tr><td colSpan={8} className="muted pur-empty">Под фильтр ничего не попало.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <LotsCard lots={data.lots} />

      <div className="muted pur-foot">
        Продажи — факт за 7 и 30 дней (WB и Ozon; WB Global не считаем — с января уходим с площадки), дни без остатка не считаются. FBS годится любой площадке,
        FBO продаётся только на своей. Партии должно хватать на {data.settings.coverDays} дн. после прихода + {data.settings.safetyDays} дн. запаса.
        Срок «оплата → ФФ» — по трекеру закупщика ({data.leadSamples} доставок), у товара свой, если доставок ≥ 2.
        Посчитано {new Date(data.builtAt).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}.
        {data.notes.map(n => <div key={n}>{n}</div>)}
      </div>
    </>
  );
}

function RowDetail({ r }: { r: PurchaseRow }) {
  const mp = (label: string, rate: number, fbo: number | null, days: number | null) =>
    <div><b>{label}</b>: {nf1.format(rate)} в день{fbo !== null && <>, FBO {nf0.format(fbo)}{days !== null && ` (хватит на ${days} дн.)`}</>}</div>;
  return (
    <div className="pur-det">
      <div className="pur-det-col">
        {mp('WB', r.rate.wb, r.fbo.wb, r.fboDays.wb)}
        {mp('Ozon', r.rate.ozon, r.fbo.ozon, r.fboDays.ozon)}
        <div>Продано: за 7 дней {nf0.format(r.sold7)}, за 30 дней {nf0.format(r.sold30)}; в наличии {r.inStockDays} дн. из 30</div>
      </div>
      <div className="pur-det-col">
        <div>Срок доставки: {r.lead} дн.{r.leadSamples >= 2 ? ` (свой, по ${r.leadSamples} доставкам)` : ' (общий)'}</div>
        <div>Цена фабрики: {rub(r.factoryPrice)} · себестоимость {rub(r.landedCost)} · вес {r.weightG ? `${nf0.format(r.weightG)} г` : '–'}</div>
        <div>Фабрике {rub(r.sumFactory)} · логистика {rub(r.sumLogistics)}</div>
        {r.lots.map(l => <div key={l.order + l.article}>Заказ {l.order}: {nf0.format(l.qty)} шт., {l.stage.toLowerCase()}{l.eta ? `, придёт ≈ ${ddmm(l.eta)}` : ''}{l.issues.length > 0 && <span className="warn"> — {l.issues.join('; ')}</span>}</div>)}
      </div>
      {r.notes.length > 0 && <ul className="pur-notes">{r.notes.map(n => <li key={n}>{n}</li>)}</ul>}
      {r.qty > 0 && !r.skip && <div className="pur-plan-pay"><button className="btn" onClick={() => { location.hash = planPayLink(r); }}>Запланировать оплату в «Финансах»</button> <span className="muted">откроется новая закупка с этим товаром и {nf0.format(r.qty)} шт.; сумму и дату впишете сами</span></div>}
    </div>
  );
}

/** Ссылка на новую закупку в «Финансах»: товар и штуки подставлены, дата — «заказать до» (не раньше сегодня). */
function planPayLink(r: PurchaseRow): string {
  const today = new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10);
  const date = r.orderBy && r.orderBy > today ? r.orderBy : today;
  const q = new URLSearchParams({ new: 'purchase', article: r.key, qty: String(r.qty), name: r.name, date });
  return '#finance?' + q.toString();
}

function LotsCard({ lots }: { lots: TransitLot[] }) {
  if (!lots.length) return null;
  const sorted = [...lots].sort((a, b) => (a.eta || '9') .localeCompare(b.eta || '9'));
  return (
    <div className="card">
      <h2>Едет из Китая</h2>
      <div className="pur-scroll">
        <table className="pur-table pur-lots">
          <thead><tr><th>Заказ</th><th>Товар</th><th className="num">Штук</th><th>Этап</th><th>Придёт на ФФ</th><th>Что не так</th></tr></thead>
          <tbody>
            {sorted.map(l => (
              <tr key={l.order + l.article}>
                <td>{l.order}</td><td>{l.article}</td><td className="num">{nf0.format(l.qty)}</td><td>{l.stage}</td>
                <td>{l.eta ? ddmm(l.eta) : '–'}</td><td className={l.issues.length ? 'warn' : 'muted'}>{l.issues.join('; ') || '–'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SettingsPanel({ data, onSaved }: { data: Resp; onSaved: () => void }) {
  const s = data.settings;
  const [f, setF] = useState(() => ({
    coverDays: String(s.coverDays), safetyDays: String(s.safetyDays), leadDays: String(s.leadDays), minOrderDays: String(s.minOrderDays),
    usdPerKg: String(s.usdPerKg), usd: s.usd ? String(s.usd) : '', cny: s.cny ? String(s.cny) : '',
    season: s.season.map(String),
  }));
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const field = (k: keyof typeof f, label: string, hint: string) => (
    <label className="pur-field"><span>{label}</span>
      <input className="input" inputMode="decimal" value={f[k] as string} onChange={e => setF({ ...f, [k]: e.target.value })} />
      <span className="muted pur-sub">{hint}</span>
    </label>
  );
  const save = async () => {
    setBusy(true);
    try {
      await apiPost('/api/purchase/settings', { ...f, usd: f.usd || 0, cny: f.cny || 0, season: f.season });
      onSaved();
    } catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  };
  return (
    <div className="card pur-settings">
      <h2>Настройки расчёта</h2>
      <div className="pur-fields">
        {field('coverDays', 'Партии хватает на, дней', 'после прихода на ФФ')}
        {field('safetyDays', 'Страховой запас, дней', 'остаток к приходу партии')}
        {field('leadDays', 'Срок доставки, дней', `0 — по трекеру (сейчас ${data.leadDefault})`)}
        {field('minOrderDays', 'Самый маленький заказ, дней продаж', 'чтобы не заказывать по 5–10 шт.')}
        {field('usdPerKg', 'Логистика, $ за кг', 'Китай → Москва')}
        {field('usd', 'Курс доллара, ₽', `пусто — курс ЦБ (${nf1.format(data.rates.usd)})`)}
        {field('cny', 'Курс юаня, ₽', `пусто — курс ЦБ (${nf1.format(data.rates.cny)})`)}
      </div>
      <h3 className="pur-h3">Сезонность по месяцам (1 — как сейчас)</h3>
      <div className="muted pur-sub">Если у товара есть продажи WB год назад, сезонность берётся из них; эти цифры — для остальных товаров.</div>
      <div className="pur-season">
        {MONTHS.map((m, i) => (
          <label key={m} className="pur-field small"><span>{m}</span>
            <input className="input" inputMode="decimal" value={f.season[i]} onChange={e => { const season = [...f.season]; season[i] = e.target.value; setF({ ...f, season }); }} />
          </label>
        ))}
      </div>
      {err && <div className="bad">{err}</div>}
      <div className="pur-bar"><button className="btn btn-primary" disabled={busy} onClick={() => void save()}>{busy ? 'Сохраняю…' : 'Сохранить и пересчитать'}</button></div>
    </div>
  );
}

/** Хватит ли денег: прогноз «Финансов» минус рекомендованные закупки (шаг 2, 19.11.2026). */
function MoneyCard({ m, min, rows }: { m: MoneyCheck; min: number; rows: PurchaseRow[] }) {
  const byKey = new Map(rows.map(r => [r.key, r]));
  const name = (k: string) => byKey.get(k)?.name ?? k;
  const sumOf = (keys: string[]) => keys.reduce((s, k) => { const r = byKey.get(k); return s + (r ? r.sumFactory + r.sumLogistics : 0); }, 0);
  const gapBefore = m.minBefore && m.minBefore.end < min;
  return (
    <div className={`card pur-money ${m.shortfall > 0 ? 'short' : 'fine'}`}>
      <h2>Хватит ли денег на закупки</h2>
      <div className="pur-money-grid">
        <div>
          <div className="card-title">Рекомендации на {ddmm(m.horizon)} (60 дней)</div>
          <b>{mln(m.total)}</b>
        </div>
        <div>
          <div className="card-title">Самый низкий остаток без них</div>
          <b className={gapBefore ? 'bad' : ''}>{m.minBefore ? mln(m.minBefore.end) : '–'}</b>
          <span className="muted">{m.minBefore ? ddmm(m.minBefore.date) : ''}</span>
        </div>
        <div>
          <div className="card-title">С ними</div>
          <b className={m.shortfall > 0 ? 'bad' : ''}>{m.minAfter ? mln(m.minAfter.end) : '–'}</b>
          <span className="muted">{m.minAfter ? ddmm(m.minAfter.date) : ''}</span>
        </div>
      </div>
      {m.shortfall > 0 ? (
        <div className="pur-money-text">
          <div>Не хватает <b>{mln(m.shortfall)}</b> (с запасом {mln(min)}) — с {ddmm(m.firstShort ?? '')}{m.backOn ? `, сам закроется к ${ddmm(m.backOn)}` : ', за 60 дней сам не закрывается'}.</div>
          <div>Искать деньги — до <b>{ddmm(m.askBy ?? '')}</b>. Инвестор под 25 % годовых на этот срок обойдётся примерно в <b>{rub(m.investCost)}</b>.</div>
          {gapBefore && <div className="muted">Разрыв в «Финансах» есть и без новых закупок — его закрывать в первую очередь.</div>}
          {m.affordable.length > 0 && <div>Без нехватки можно оплатить ({mln(sumOf(m.affordable))}): {m.affordable.map(name).join(', ')}.</div>}
          {m.postpone.length > 0 && <div>Остальное ({mln(sumOf(m.postpone))}) — разбить партии (сначала половину) или привлечь деньги. Самое срочное: {m.postpone.slice(0, 5).map(name).join(', ')}.</div>}
        </div>
      ) : (
        <div className="pur-money-text">Денег хватает: остаток не опускается ниже {mln(min)}.</div>
      )}
      <div className="muted pur-sub">Оплата фабрике — 100 % в день заказа, логистика — к приходу в Москву. Прогноз остатка — из «Финансов»; в календарь отсюда ничего не пишется.</div>
    </div>
  );
}
