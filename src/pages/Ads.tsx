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
import { ArrowsClockwiseIcon } from '@phosphor-icons/react';
import { apiGet, apiPost, errText } from '../api/http';
import type { Ads2Mp, Ads2Overview } from '../../shared/ads2';
import { useActions } from './ads/shared';
import { Overview } from './ads/Overview';
import { Products, ProductDrawer } from './ads/Products';
import { Campaigns } from './ads/Campaigns';
import { Autopilot } from './ads/Autopilot';
import { Journal } from './ads/Journal';
import { mskDate } from '../utils/mskDate';

/**
 * Период (22.10.2026, просьба владельца): кроме 7/14/30 дней — «сегодня», «вчера»,
 * «позавчера» и свои даты. Сервер считает заказы, клики, корзины и расход за
 * любые дни по хранилищу «кампания × товар × день».
 */
type Preset = 'today' | 'yesterday' | 'before' | '7' | '14' | '30' | 'custom';
const PRESETS: Array<[Preset, string]> = [
  ['today', 'Сегодня'], ['yesterday', 'Вчера'], ['before', 'Позавчера'], ['7', '7 дн'], ['14', '14 дн'], ['30', '30 дн'], ['custom', 'Свои даты'],
];
function presetRange(p: Exclude<Preset, 'custom'>): { from: string; to: string } {
  if (p === 'today') return { from: mskDate(0), to: mskDate(0) };
  if (p === 'yesterday') return { from: mskDate(1), to: mskDate(1) };
  if (p === 'before') return { from: mskDate(2), to: mskDate(2) };
  return { from: mskDate(Number(p) - 1), to: mskDate(0) };
}
const readLs = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const writeLs = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* не критично */ } };

type Tab = 'overview' | 'products' | 'campaigns' | 'autopilot' | 'log';
const TABS: Array<[Tab, string]> = [['overview', 'Обзор'], ['products', 'Товары'], ['campaigns', 'Кампании'], ['autopilot', 'Автопилот'], ['log', 'Журнал']];

const ddmmyy = (iso: string) => iso.split('-').reverse().join('.');

// ─── Страница ───────────────────────────────────────────────────────────────

function Board({ mp }: { mp: Ads2Mp }) {
  // 15.10: «Конкуренты» переехали в свой раздел — сохранённая вкладка 'competitors' открывает «Обзор».
  const [tab, setTab] = useState<Tab>(() => { try { const t = localStorage.getItem('ads2:tab') as Tab; return TABS.some(([k]) => k === t) ? t : 'overview'; } catch { return 'overview'; } });
  const [preset, setPreset] = useState<Preset>(() => {
    const v = readLs('ads2:preset') ?? readLs('ads2:days'); // ads2:days — сохранённый выбор до 22.10
    return PRESETS.some(([k]) => k === v) ? v as Preset : '14';
  });
  const [custom, setCustom] = useState(() => {
    try { const c = JSON.parse(readLs('ads2:custom') ?? ''); if (c?.from && c?.to) return c as { from: string; to: string }; } catch { /* нет сохранённого */ }
    return presetRange('7');
  });
  const { from, to } = preset === 'custom' ? custom : presetRange(preset);
  const pick = (p: Preset) => { setPreset(p); writeLs('ads2:preset', p); };
  const setDates = (c: { from: string; to: string }) => { setCustom(c); writeLs('ads2:custom', JSON.stringify(c)); };
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
    try { const r = await apiGet<Ads2Overview>(`/api/ads2/overview?mp=${mp}&from=${from}&to=${to}`); if (my === seq.current) { setData(r.data); setErr(null); } }
    catch (e) { if (my === seq.current) setErr(errText(e)); }
    finally { if (my === seq.current) setLoading(false); }
  }, [mp, from, to]);
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
          {PRESETS.map(([k, l]) => (
            <button key={k} className={`period-btn ${preset === k ? 'active' : ''}`} onClick={() => pick(k)}>{l}</button>
          ))}
        </div>
        {preset === 'custom' && (
          <div className="ad2-dates">
            <label>с <input type="date" value={custom.from} max={custom.to} onChange={e => e.target.value && setDates({ ...custom, from: e.target.value })} /></label>
            <label>по <input type="date" value={custom.to} min={custom.from} max={mskDate(0)} onChange={e => e.target.value && setDates({ ...custom, to: e.target.value })} /></label>
          </div>
        )}
        <span className="ad2-range">{from === to ? ddmmyy(to) : `${ddmmyy(from)} – ${ddmmyy(to)}`}{to === mskDate(0) ? ' · сегодня ещё идёт' : ''}</span>
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
        <Fragment key={`${mp}-${from}-${to}`}>
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
