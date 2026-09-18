import { useEffect, useMemo, useState } from 'react';
import {
  ArrowsClockwiseIcon, WarningIcon, MegaphoneIcon, InfoIcon, CheckCircleIcon, XCircleIcon, PauseIcon, PlayIcon,
  SpinnerIcon, ShieldCheckIcon, CurrencyRubIcon, TrendUpIcon, TrendDownIcon, CursorClickIcon, EyeIcon, ShoppingCartIcon, WalletIcon,
} from '@phosphor-icons/react';
import { getWbToken, clearCache, readCache } from '../api/wb';
import {
  wbGetBalance, wbGetPromotionCount, wbGetFullStats, wbGetPayments,
  daysAgo, today, roas,
  WbFullStatsItem, WbBalance, WbPromotionCount, WbPayment,
} from '../api/wbAds';
import {
  ozonGetCampaigns, ozonGetDailyExpenses, hasOzonPerfCreds, clearOzonPerfCache, readOzonPerfCache,
  OzonCampaign, parseRu,
  daysAgo as oDaysAgo, today as oToday,
} from '../api/ozonAds';
import { localDateStr } from '../api/marketplaces';
import { fmtRangeRu } from '../api/useLiveOzon';
import { AiAdvice } from '../components/AiAdvice';
import { AdsBySku } from '../components/AdsBySku';
import { AdsManage } from '../components/AdsManage';
import { AdsInsightPanel } from '../components/AdsInsightPanel';
void oDaysAgo; void oToday;
// Окно рекламы Ozon = N завершённых суток по ВЧЕРА (сегодня неполный → исключаем;
// раньше брали today-7..today = 8 дней, из-за чего расход/заказы были завышены).
const ozonAdsWindow = (p: '7d' | '30d') => ({ from: localDateStr(p === '7d' ? 7 : 30), to: localDateStr(1) });

type Mp = 'wb' | 'ozon';
type Period = '7d' | '30d';

const WB_TYPE_LABEL: Record<number, string> = {
  4: 'Каталог', 5: 'Карточка', 6: 'Поиск', 7: 'Рекомендации', 8: 'Авто', 9: 'Поиск + каталог',
};
const WB_STATUS_LABEL: Record<number, { label: string; color: string; bg: string; Icon: any }> = {
  '-1': { label: 'прекращена', color: 'var(--bad)', bg: 'rgba(220,38,38,.10)', Icon: XCircleIcon },
  4:    { label: 'готова', color: 'var(--accent)', bg: 'var(--accent-soft)', Icon: PlayIcon },
  7:    { label: 'алгоритм', color: 'var(--warn)', bg: 'rgba(217,119,6,.10)', Icon: PlayIcon },
  8:    { label: 'пауза', color: 'var(--muted)', bg: 'var(--bg-3)', Icon: PauseIcon },
  9:    { label: 'активна', color: 'var(--good)', bg: 'rgba(22,163,74,.10)', Icon: CheckCircleIcon },
  11:   { label: 'пауза', color: 'var(--muted)', bg: 'var(--bg-3)', Icon: PauseIcon },
};

const fmtRub = (n: number) => (Number.isFinite(n) ? Math.round(n) : 0).toLocaleString('ru-RU') + ' ₽';
const fmtNum = (n: number) => (Number.isFinite(n) ? Math.round(n) : 0).toLocaleString('ru-RU');
const fmtPct = (n: number) => (Number.isFinite(n) ? Math.round(n * 10) / 10 : 0).toFixed(1) + '%';

function fmtAgo(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} сек назад`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} мин назад`;
  const h = Math.round(m / 60);
  return `${h} ч назад`;
}

const COOLDOWN_MS = 30_000;

function WbAdsPanel() {
  const [period, setPeriod] = useState<Period>('7d');

  const [balance, setBalance] = useState<WbBalance | null>(null);
  const [counts, setCounts] = useState<WbPromotionCount | null>(null);
  const [stats, setStats] = useState<WbFullStatsItem[]>([]);
  const [payments, setPayments] = useState<WbPayment[]>([]);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const [fromCache, setFromCache] = useState(false);
  const [tick, setTick] = useState(0); // обновляет «X мин назад» каждые 30 сек

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cooldownLeft, setCooldownLeft] = useState(0);
  const [lastAttemptAt, setLastAttemptAt] = useState(0);

  // Перерисовка «X мин назад»
  useEffect(() => {
    const t = setInterval(() => setTick(x => x + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  // Таймер кулдауна
  useEffect(() => {
    if (cooldownLeft <= 0) return;
    const t = setInterval(() => {
      const left = Math.max(0, COOLDOWN_MS - (Date.now() - lastAttemptAt));
      setCooldownLeft(left);
      if (left === 0) clearInterval(t);
    }, 300);
    return () => clearInterval(t);
  }, [cooldownLeft, lastAttemptAt]);

  const startCooldown = () => {
    setLastAttemptAt(Date.now());
    setCooldownLeft(COOLDOWN_MS);
  };

  // Последовательная загрузка с graceful handling: если одна часть упала на 429 —
  // не валим всю страницу, показываем что есть. На 429 — fail fast (без retry).
  const load = async (force: boolean) => {
    if (cooldownLeft > 0) return;
    setLoading(true);
    setError(null);
    let anyError: string | null = null;
    let anySuccess = false;

    const begin = period === '7d' ? daysAgo(7) : daysAgo(30);
    const end = today();

    // Балланс
    try {
      const r = await wbGetBalance(force);
      setBalance(r.data);
      anySuccess = true;
    } catch (e: any) {
      console.warn('[WbAds] balance failed:', e?.message);
      if (!anyError) anyError = `Баланс: ${e?.message}`;
    }

    // Кампании
    let advertIds: number[] = [];
    try {
      const r = await wbGetPromotionCount(force);
      setCounts(r.data);
      anySuccess = true;
      for (const g of r.data.adverts || []) {
        if (g.status === -1) continue;
        for (const a of g.advert_list || []) advertIds.push(a.advertId);
      }
      // Не режем здесь — wbGetFullStats сам возьмёт 100 САМЫХ СВЕЖИХ (высокий ID),
      // иначе тратящие недавние кампании обрезались и расход был 0 (фикс 28.07).
    } catch (e: any) {
      console.warn('[WbAds] promotion/count failed:', e?.message);
      if (!anyError) anyError = `Кампании: ${e?.message}`;
    }

    // Статистика
    if (advertIds.length > 0) {
      try {
        const r = await wbGetFullStats(advertIds, begin, end, force);
        setStats(r.data || []);
        anySuccess = true;
      } catch (e: any) {
        console.warn('[WbAds] fullstats failed:', e?.message);
        if (!anyError) anyError = `Статистика: ${e?.message}`;
      }
    }

    // Платежи
    try {
      const r = await wbGetPayments(daysAgo(30), today(), force);
      setPayments(r.data || []);
      anySuccess = true;
    } catch (e: any) {
      console.warn('[WbAds] payments failed:', e?.message);
      // Платежи — не критично, не ставим anyError
    }

    if (anySuccess) {
      setFetchedAt(Date.now());
      setFromCache(false);
    }
    if (anyError) setError(anyError);
    if (force) startCooldown();
    setLoading(false);
  };

  // На mount/смену периода: сначала мгновенно рисуем из кэша, затем САМИ тянем
  // свежее из API. Раньше «в API сами не лезем, юзер жмёт кнопку» — это было из-за
  // анти-burst WB, когда браузер ходил в WB напрямую. Сейчас cron-only: браузер
  // ходит в наш кэш, 429 от WB невозможен → грузим автоматически, как Ozon.
  useEffect(() => {
    const begin = period === '7d' ? daysAgo(7) : daysAgo(30);
    const end = today();
    const balC = readCache<WbBalance>('promotion', '/adv/v1/balance');
    const cntC = readCache<WbPromotionCount>('promotion', '/adv/v1/promotion/count');
    if (balC) setBalance(balC.data);
    if (cntC) {
      setCounts(cntC.data);
      // Попробуем восстановить fullstats из кэша по тем же IDs
      const ids: number[] = [];
      for (const g of cntC.data.adverts || []) {
        if (g.status === -1) continue;
        for (const a of g.advert_list || []) ids.push(a.advertId);
      }
      if (ids.length) {
        const idsSlice = ids.slice().sort((a, b) => b - a).slice(0, 100).sort((a, b) => a - b); // 100 свежих, ASC → ключ кэша
        const queryIds = `ids=${idsSlice.join(',')}`; // формат WB 07.2026: через запятую
        const fsC = readCache<WbFullStatsItem[]>('promotion', `/adv/v3/fullstats?${queryIds}&beginDate=${begin}&endDate=${end}`, { method: 'GET' });
        if (fsC) setStats(fsC.data || []);
      }
    }
    const payC = readCache<WbPayment[]>('promotion', `/adv/v1/payments?from=${daysAgo(30)}&to=${today()}`);
    if (payC) setPayments(payC.data || []);

    const newestT = [balC, cntC, payC].filter(Boolean).map(c => c!.fetchedAt);
    if (newestT.length) {
      setFetchedAt(Math.max(...newestT));
      setFromCache(true);
    }
    // Авто-подтягивание свежего (wbFetchCached сам вернёт кэш, если он ещё свежий,
    // иначе сходит в наш серверный кэш — быстро и без обращения к WB).
    load(false);
  /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [period]);

  // Сводные метрики
  const totals = useMemo(() => {
    const t = { views: 0, clicks: 0, sum: 0, orders: 0, sum_price: 0, atbs: 0, shks: 0 };
    for (const s of stats) {
      t.views += s.views || 0;
      t.clicks += s.clicks || 0;
      t.sum += s.sum || 0;
      t.orders += s.orders || 0;
      t.sum_price += s.sum_price || 0;
      t.atbs += s.atbs || 0;
      t.shks += s.shks || 0;
    }
    return t;
  }, [stats]);

  const totalCtr = totals.views > 0 ? (totals.clicks / totals.views) * 100 : 0;
  const totalCpc = totals.clicks > 0 ? totals.sum / totals.clicks : 0;
  const totalCr = totals.clicks > 0 ? (totals.orders / totals.clicks) * 100 : 0;
  const totalRoas = roas(totals.sum_price, totals.sum);

  // Сортировка кампаний по расходу
  const sortedStats = useMemo(() => {
    const meta = new Map<number, { status: number; type: number }>();
    for (const g of counts?.adverts || []) {
      for (const a of g.advert_list || []) meta.set(a.advertId, { status: g.status, type: g.type });
    }
    return stats
      .map(s => ({ s, m: meta.get(s.advertId) }))
      .sort((a, b) => b.s.sum - a.s.sum);
  }, [stats, counts]);

  // Топ проёбы: расход > 0, но CTR < 0.5% ИЛИ нет заказов при расходе > 500₽
  const losers = useMemo(() => {
    return sortedStats.filter(({ s }) => {
      if (s.sum < 100) return false;
      const lowCtr = s.views > 0 && (s.clicks / s.views) * 100 < 0.5;
      const noOrders = s.sum > 500 && s.orders === 0;
      return lowCtr || noOrders;
    }).slice(0, 10);
  }, [sortedStats]);

  const totalPaid = useMemo(() => payments.reduce((acc, p) => acc + (p.sum || 0), 0), [payments]);

  const cdSec = Math.ceil(cooldownLeft / 1000);
  const totalCampaigns = counts?.all ?? 0;
  const activeCount = (counts?.adverts || []).filter(g => g.status === 9).reduce((s, g) => s + g.count, 0);

  // Force tick into deps so "X мин назад" обновляется
  const agoLabel = fetchedAt ? fmtAgo(Date.now() - fetchedAt) : '—';
  void tick;

  const adviceContext = {
    площадка: 'Wildberries',
    итого: { расход: Math.round(totals.sum), выручка: Math.round(totals.sum_price), ctr_пр: +totalCtr.toFixed(2), cpc: Math.round(totalCpc), cr_пр: +totalCr.toFixed(1), roas: totalRoas != null ? +totalRoas.toFixed(2) : null, заказов: totals.orders },
    топ_кампаний: sortedStats.slice(0, 12).map(({ s }) => ({ id: s.advertId, расход: Math.round(s.sum), заказов: s.orders, ctr_пр: s.views > 0 ? +((s.clicks / s.views) * 100).toFixed(2) : 0, выручка: Math.round(s.sum_price) })),
    неэффективные: losers.map(({ s }) => ({ id: s.advertId, расход: Math.round(s.sum), заказов: s.orders })),
  };

  return (
    <div className="grid" style={{ gap: 16 }}>
      <AiAdvice module="ads" context={adviceContext} disabled={stats.length === 0} />
      {/* ─── Статус и управление ─── */}
      <div className="card" style={{ background: 'var(--bg-3)' }}>
        <div className="flex-between" style={{ flexWrap: 'wrap', gap: 12 }}>
          <div className="row gap-12" style={{ flexWrap: 'wrap' }}>
            <div>
              <div style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.3 }}>
                WB · реклама
              </div>
              <div className="row gap-8" style={{ marginTop: 6, flexWrap: 'wrap' }}>
                <span style={{
                  background: error ? 'rgba(220,38,38,.10)' : 'rgba(22,163,74,.10)',
                  color: error ? 'var(--bad)' : 'var(--good)',
                  padding: '4px 10px', borderRadius: 999, fontSize: 12, fontWeight: 600,
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                }}>
                  {error ? <XCircleIcon size={12} weight="bold" /> : <ShieldCheckIcon size={12} weight="bold" />}
                  {error ? 'ошибка' : 'подключено'}
                </span>
                {fetchedAt && (
                  <span className="muted" style={{ fontSize: 12 }}>
                    {fromCache ? '📦 из кэша · ' : '🟢 свежие · '}{agoLabel}
                  </span>
                )}
              </div>
              {error && <div className="muted" style={{ fontSize: 11, marginTop: 6, color: 'var(--bad)' }}>{error}</div>}
            </div>
          </div>
          <div className="row gap-8" style={{ flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <span className="muted" style={{ fontSize: 12, alignSelf: 'center' }}>{fmtRangeRu(daysAgo(period === '7d' ? 7 : 30), today())}</span>
            <div className="period-switch">
              {(['7d', '30d'] as Period[]).map(p => (
                <button key={p} className={`period-btn ${period === p ? 'active' : ''}`} onClick={() => setPeriod(p)}>
                  {p === '7d' ? '7 дней' : '30 дней'}
                </button>
              ))}
            </div>
            <button
              className="btn"
              onClick={() => { clearCache('promotion'); setStats([]); setBalance(null); setCounts(null); setPayments([]); setFetchedAt(null); }}
              disabled={loading}
            >
              Сбросить кэш
            </button>
            <button
              className="btn btn-primary"
              onClick={() => load(true)}
              disabled={loading || cooldownLeft > 0}
              title={cooldownLeft > 0 ? `Подожди ещё ${cdSec} сек` : 'Принудительно тянуть из WB API'}
            >
              <ArrowsClockwiseIcon size={14} weight="bold" className={loading ? 'spin' : ''} />
              {loading ? 'Загрузка…' : cooldownLeft > 0 ? `Подожди ${cdSec} сек` : 'Обновить из API'}
            </button>
          </div>
        </div>
        <div className="muted" style={{ fontSize: 11.5, marginTop: 10 }}>
          Кэш 30 минут, cooldown 30 сек. <code>/adv/v3/fullstats</code> имеет лимит 1 req/min, поэтому
          если кампаний больше 100, WB вернёт только первую сотню.
        </div>
      </div>

      {/* Empty state — кэш пуст, в API ещё не ходили */}
      {!fetchedAt && !loading && (
        <div className="card" style={{ background: 'var(--accent-soft)', textAlign: 'center', padding: '24px 18px' }}>
          <div style={{ fontWeight: 600, color: 'var(--accent-2)', marginBottom: 6 }}>Данных в кэше нет</div>
          <div className="muted" style={{ fontSize: 13, color: 'var(--accent-2)', marginBottom: 12 }}>
            Нажми <b>«Обновить из API»</b> выше — подтянем баланс, кампании и статистику. Дальше будет браться из кэша 30 минут.
          </div>
        </div>
      )}

      {/* ─── KPI Row ─── */}
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>
        <div className="card kpi">
          <span className="d muted"><WalletIcon size={11} weight="bold" /> Баланс</span>
          <span className="v">{balance ? fmtRub(balance.balance) : '—'}</span>
          {balance && (
            <span className="d muted" style={{ fontSize: 11 }}>
              нетто {fmtRub(balance.net)} · бонус {fmtRub(balance.bonus)}
            </span>
          )}
        </div>
        <div className="card kpi">
          <span className="d muted"><CurrencyRubIcon size={11} weight="bold" /> Расход за {period === '7d' ? '7д' : '30д'}</span>
          <span className="v" style={{ color: 'var(--bad)' }}>{fmtRub(totals.sum)}</span>
        </div>
        <div className="card kpi">
          <span className="d muted"><CurrencyRubIcon size={11} weight="bold" /> Выручка от рекламы</span>
          <span className="v" style={{ color: 'var(--good)' }}>{fmtRub(totals.sum_price)}</span>
        </div>
        <div className="card kpi" title="ROAS = выручка / расход. >1 = прибыльно">
          <span className="d muted">ROAS</span>
          <span className="v" style={{ color: totalRoas === null ? 'var(--muted)' : totalRoas >= 1 ? 'var(--good)' : 'var(--bad)' }}>
            {totalRoas !== null ? '×' + totalRoas.toFixed(2) : '—'}
          </span>
        </div>
        <div className="card kpi">
          <span className="d muted"><EyeIcon size={11} weight="bold" /> Показы</span>
          <span className="v">{fmtNum(totals.views)}</span>
        </div>
        <div className="card kpi">
          <span className="d muted"><CursorClickIcon size={11} weight="bold" /> Клики</span>
          <span className="v">{fmtNum(totals.clicks)}</span>
          <span className="d muted" style={{ fontSize: 11 }}>CTR {fmtPct(totalCtr)} · CPC {fmtRub(totalCpc)}</span>
        </div>
        <div className="card kpi">
          <span className="d muted"><ShoppingCartIcon size={11} weight="bold" /> Заказы</span>
          <span className="v">{fmtNum(totals.orders)}</span>
          <span className="d muted" style={{ fontSize: 11 }}>CR {fmtPct(totalCr)} · в корзину {fmtNum(totals.atbs)}</span>
        </div>
        <div className="card kpi">
          <span className="d muted">Кампаний</span>
          <span className="v">{totalCampaigns}</span>
          <span className="d muted" style={{ fontSize: 11 }}>активных {activeCount}</span>
        </div>
      </div>

      {/* ─── Топ проёбы ─── */}
      {losers.length > 0 && (
        <div className="card" style={{ background: 'rgba(220,38,38,.04)', padding: 0 }}>
          <div className="flex-between" style={{ padding: '14px 18px', borderBottom: '1px solid var(--border)' }}>
            <h3 style={{ margin: 0, display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              <TrendDownIcon size={16} weight="bold" style={{ color: 'var(--bad)' }} />
              Кампании, которые сливают бюджет
            </h3>
            <span className="chip bad">{losers.length}</span>
          </div>
          <table>
            <thead>
              <tr>
                <th style={{ paddingLeft: 18 }}>ID</th>
                <th>Тип</th>
                <th style={{ textAlign: 'right' }}>Расход</th>
                <th style={{ textAlign: 'right' }}>Показы</th>
                <th style={{ textAlign: 'right' }}>Клики</th>
                <th style={{ textAlign: 'right' }}>CTR</th>
                <th style={{ textAlign: 'right' }}>Заказы</th>
                <th style={{ paddingRight: 18 }}>Причина</th>
              </tr>
            </thead>
            <tbody>
              {losers.map(({ s, m }) => {
                const ctr = s.views > 0 ? (s.clicks / s.views) * 100 : 0;
                const reasons: string[] = [];
                if (ctr < 0.5 && s.views > 0) reasons.push(`CTR ${fmtPct(ctr)} < 0.5%`);
                if (s.sum > 500 && s.orders === 0) reasons.push('нет заказов');
                return (
                  <tr key={s.advertId}>
                    <td style={{ paddingLeft: 18, fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12 }}>{s.advertId}</td>
                    <td style={{ fontSize: 12 }}>{m ? WB_TYPE_LABEL[m.type] : '—'}</td>
                    <td style={{ textAlign: 'right', fontWeight: 600 }}>{fmtRub(s.sum)}</td>
                    <td style={{ textAlign: 'right' }}>{fmtNum(s.views)}</td>
                    <td style={{ textAlign: 'right' }}>{fmtNum(s.clicks)}</td>
                    <td style={{ textAlign: 'right', color: 'var(--bad)' }}>{fmtPct(ctr)}</td>
                    <td style={{ textAlign: 'right', color: s.orders === 0 ? 'var(--bad)' : 'var(--text)' }}>{s.orders}</td>
                    <td style={{ paddingRight: 18, fontSize: 11, color: 'var(--bad)' }}>{reasons.join(' · ')}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* ─── Таблица всех кампаний с метриками ─── */}
      <div className="card" style={{ padding: 0 }}>
        <div className="flex-between" style={{ padding: '14px 18px', borderBottom: '1px solid var(--border)' }}>
          <h3 style={{ margin: 0 }}>Кампании · сортировка по расходу</h3>
          <span className="muted" style={{ fontSize: 12 }}>{sortedStats.length} с данными за период</span>
        </div>
        {sortedStats.length === 0 ? (
          <div style={{ padding: 32, textAlign: 'center', color: 'var(--muted)' }}>
            {loading ? 'Загружаем…' : 'Нет данных по кампаниям за этот период'}
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ minWidth: 900 }}>
              <thead>
                <tr>
                  <th style={{ paddingLeft: 18 }}>ID</th>
                  <th>Тип</th>
                  <th style={{ textAlign: 'center' }}>Статус</th>
                  <th style={{ textAlign: 'right' }}>Расход</th>
                  <th style={{ textAlign: 'right' }}>Показы</th>
                  <th style={{ textAlign: 'right' }}>Клики</th>
                  <th style={{ textAlign: 'right' }}>CTR</th>
                  <th style={{ textAlign: 'right' }}>CPC</th>
                  <th style={{ textAlign: 'right' }}>Заказы</th>
                  <th style={{ textAlign: 'right' }}>Выручка</th>
                  <th style={{ textAlign: 'right', paddingRight: 18 }}>ROAS</th>
                </tr>
              </thead>
              <tbody>
                {sortedStats.map(({ s, m }) => {
                  const ctr = s.views > 0 ? (s.clicks / s.views) * 100 : 0;
                  const cpc = s.clicks > 0 ? s.sum / s.clicks : 0;
                  const r = roas(s.sum_price, s.sum);
                  const st = m ? WB_STATUS_LABEL[m.status] : null;
                  return (
                    <tr key={s.advertId}>
                      <td style={{ paddingLeft: 18, fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12, color: 'var(--muted)' }}>{s.advertId}</td>
                      <td style={{ fontSize: 12 }}>{m ? WB_TYPE_LABEL[m.type] : '—'}</td>
                      <td style={{ textAlign: 'center' }}>
                        {st && (
                          <span style={{ background: st.bg, color: st.color, padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 600 }}>
                            {st.label}
                          </span>
                        )}
                      </td>
                      <td style={{ textAlign: 'right', fontWeight: 600 }}>{s.sum > 0 ? fmtRub(s.sum) : '—'}</td>
                      <td style={{ textAlign: 'right' }}>{fmtNum(s.views)}</td>
                      <td style={{ textAlign: 'right' }}>{fmtNum(s.clicks)}</td>
                      <td style={{ textAlign: 'right', color: ctr < 0.5 && s.views > 0 ? 'var(--bad)' : ctr >= 2 ? 'var(--good)' : 'var(--text)' }}>
                        {s.views > 0 ? fmtPct(ctr) : '—'}
                      </td>
                      <td style={{ textAlign: 'right' }}>{s.clicks > 0 ? fmtRub(cpc) : '—'}</td>
                      <td style={{ textAlign: 'right', color: s.orders === 0 && s.sum > 300 ? 'var(--bad)' : 'var(--text)' }}>{s.orders}</td>
                      <td style={{ textAlign: 'right' }}>{s.sum_price > 0 ? fmtRub(s.sum_price) : '—'}</td>
                      <td style={{ textAlign: 'right', paddingRight: 18, fontWeight: 600, color: r === null ? 'var(--muted)' : r >= 1 ? 'var(--good)' : 'var(--bad)' }}>
                        {r !== null ? '×' + r.toFixed(2) : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ─── История пополнений ─── */}
      {payments.length > 0 && (
        <div className="card" style={{ padding: 0 }}>
          <div className="flex-between" style={{ padding: '14px 18px', borderBottom: '1px solid var(--border)' }}>
            <h3 style={{ margin: 0 }}>Пополнения за 30 дней</h3>
            <span className="chip">{payments.length} платежей · итого {fmtRub(totalPaid)}</span>
          </div>
          <table>
            <thead>
              <tr>
                <th style={{ paddingLeft: 18 }}>Дата</th>
                <th>Тип</th>
                <th style={{ textAlign: 'right', paddingRight: 18 }}>Сумма</th>
              </tr>
            </thead>
            <tbody>
              {payments.slice(0, 30).map(p => (
                <tr key={p.id}>
                  <td style={{ paddingLeft: 18, fontSize: 12 }}>{p.date}</td>
                  <td style={{ fontSize: 12 }}>{p.paymentType || (p.type === 0 ? 'банк. карта' : p.type === 1 ? 'счёт' : `тип ${p.type}`)}</td>
                  <td style={{ textAlign: 'right', paddingRight: 18, fontWeight: 600, color: 'var(--good)' }}>+{fmtRub(p.sum)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ─── Группы кампаний (старая агрегация по типу/статусу) ─── */}
      {counts && (counts.adverts?.length ?? 0) > 0 && (
        <div className="card" style={{ padding: 0 }}>
          <div className="flex-between" style={{ padding: '14px 18px', borderBottom: '1px solid var(--border)' }}>
            <h3 style={{ margin: 0 }}>Кампании по типу и статусу</h3>
          </div>
          <table>
            <thead>
              <tr>
                <th style={{ paddingLeft: 18 }}>Тип</th>
                <th style={{ textAlign: 'center' }}>Статус</th>
                <th style={{ textAlign: 'right', paddingRight: 18 }}>Количество</th>
              </tr>
            </thead>
            <tbody>
              {(counts.adverts || [])
                .slice()
                .sort((a, b) => b.count - a.count)
                .map((g, i) => {
                  const st = WB_STATUS_LABEL[g.status] || { label: `статус ${g.status}`, color: 'var(--muted)', bg: 'var(--bg-3)', Icon: InfoIcon };
                  const Icon = st.Icon;
                  return (
                    <tr key={`${g.type}-${g.status}-${i}`}>
                      <td style={{ paddingLeft: 18, fontSize: 13 }}>{WB_TYPE_LABEL[g.type] || `тип ${g.type}`}</td>
                      <td style={{ textAlign: 'center' }}>
                        <span style={{ background: st.bg, color: st.color, padding: '3px 10px', borderRadius: 999, fontSize: 11.5, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                          <Icon size={11} weight="bold" /> {st.label}
                        </span>
                      </td>
                      <td style={{ textAlign: 'right', paddingRight: 18, fontWeight: 700 }}>{g.count}</td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const OZON_STATE_LABEL: Record<string, { label: string; color: string; bg: string }> = {
  CAMPAIGN_STATE_RUNNING:  { label: 'активна',   color: 'var(--good)',   bg: 'rgba(22,163,74,.10)' },
  CAMPAIGN_STATE_PAUSED:   { label: 'пауза',     color: 'var(--muted)',  bg: 'var(--bg-3)' },
  CAMPAIGN_STATE_FINISHED: { label: 'завершена', color: 'var(--muted)',  bg: 'var(--bg-3)' },
  CAMPAIGN_STATE_DISABLED: { label: 'выключена', color: 'var(--bad)',    bg: 'rgba(220,38,38,.10)' },
  CAMPAIGN_STATE_DRAFT:    { label: 'черновик',  color: 'var(--accent)', bg: 'var(--accent-soft)' },
};

const OZON_TYPE_LABEL: Record<string, string> = {
  SKU: 'SKU (продвижение в поиске)',
  SEARCH_PROMO: 'Поиск (Sponsored Search)',
  BANNER: 'Баннер',
  BRAND_SHELF: 'Брендовая полка',
};

function OzonAdsPanel() {
  const [period, setPeriod] = useState<Period>('7d');
  const [campaigns, setCampaigns] = useState<OzonCampaign[]>([]);
  const [daily, setDaily] = useState<Array<{
    id: string; title?: string; date: string;
    views?: number; clicks?: number; moneySpent?: string | number;
    orders?: number; ordersMoney?: string | number; models?: number;
  }>>([]);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const [fromCache, setFromCache] = useState(false);
  const [tick, setTick] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Чтение кэша на mount
  useEffect(() => {
    // Креды на сервере (env OZON_PERF_*). Клиент ничего не проверяет.
    const cmpC = readOzonPerfCache<{ list: OzonCampaign[] }>('/api/client/campaign');
    const { from, to } = ozonAdsWindow(period);
    const dailyC = readOzonPerfCache<{ rows: any[] }>(`/api/client/statistics/daily/json?dateFrom=${from}&dateTo=${to}`);
    if (cmpC) setCampaigns(cmpC.data.list || []);
    if (dailyC) setDaily(dailyC.data.rows || []);
    const ts = [cmpC, dailyC].filter(Boolean).map(c => c!.fetchedAt);
    if (ts.length) {
      setFetchedAt(Math.max(...ts));
      setFromCache(true);
    }
  /* eslint-disable-next-line */
  }, [period]);

  useEffect(() => {
    const t = setInterval(() => setTick(x => x + 1), 30_000);
    return () => clearInterval(t);
  }, []);
  void tick;

  const load = async (force: boolean) => {
    setLoading(true);
    setError(null);
    try {
      const { from, to } = ozonAdsWindow(period);
      const [cmpR, dailyR] = await Promise.all([
        ozonGetCampaigns(force).catch(e => ({ error: e })),
        ozonGetDailyExpenses(from, to, force).catch(e => ({ error: e })),
      ]);
      if ('error' in cmpR) throw cmpR.error;
      if ('error' in dailyR) throw dailyR.error;
      setCampaigns(cmpR.data.list || []);
      setDaily(dailyR.data.rows || []);
      setFromCache(cmpR.fromCache && dailyR.fromCache);
      setFetchedAt(Date.now());
    } catch (e: any) {
      setError(e?.message || 'Ошибка');
    } finally {
      setLoading(false);
    }
  };

  // Сводные метрики из daily-rows. Ozon отдаёт деньги строкой "1 234,56" — парсим parseRu.
  const totals = useMemo(() => {
    const t = { views: 0, clicks: 0, sum: 0, orders: 0, ordersMoney: 0 };
    for (const r of daily) {
      t.views += parseRu(r.views);
      t.clicks += parseRu(r.clicks);
      t.sum += parseRu(r.moneySpent);
      t.orders += parseRu(r.orders);
      t.ordersMoney += parseRu(r.ordersMoney);
    }
    return t;
  }, [daily]);

  const totalCtr = totals.views > 0 ? (totals.clicks / totals.views) * 100 : 0;
  const totalCpc = totals.clicks > 0 ? totals.sum / totals.clicks : 0;
  const totalRoas = totals.sum > 0 ? totals.ordersMoney / totals.sum : null;

  // Агрегация по кампаниям
  const byCampaign = useMemo(() => {
    const map = new Map<string, { id: string; title?: string; views: number; clicks: number; sum: number; orders: number; ordersMoney: number; }>();
    for (const r of daily) {
      const id = String(r.id);
      const cur = map.get(id) || { id, title: r.title, views: 0, clicks: 0, sum: 0, orders: 0, ordersMoney: 0 };
      cur.views += parseRu(r.views);
      cur.clicks += parseRu(r.clicks);
      cur.sum += parseRu(r.moneySpent);
      cur.orders += parseRu(r.orders);
      cur.ordersMoney += parseRu(r.ordersMoney);
      map.set(id, cur);
    }
    return Array.from(map.values()).sort((a, b) => b.sum - a.sum);
  }, [daily]);

  const cmpMeta = useMemo(() => {
    const m = new Map<string, OzonCampaign>();
    for (const c of campaigns) m.set(c.id, c);
    return m;
  }, [campaigns]);

  const activeCount = campaigns.filter(c => c.state === 'CAMPAIGN_STATE_RUNNING').length;
  const agoLabel = fetchedAt ? fmtAgo(Date.now() - fetchedAt) : '—';

  return (
    <div className="grid" style={{ gap: 16 }}>
      <div className="card" style={{ background: 'var(--bg-3)' }}>
        <div className="flex-between" style={{ flexWrap: 'wrap', gap: 12 }}>
          <div>
            <div style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.3 }}>
              Ozon · Performance API
            </div>
            <div className="row gap-8" style={{ marginTop: 6, flexWrap: 'wrap' }}>
              <span style={{
                background: error ? 'rgba(220,38,38,.10)' : 'rgba(22,163,74,.10)',
                color: error ? 'var(--bad)' : 'var(--good)',
                padding: '4px 10px', borderRadius: 999, fontSize: 12, fontWeight: 600,
                display: 'inline-flex', alignItems: 'center', gap: 6,
              }}>
                {error ? <XCircleIcon size={12} weight="bold" /> : <ShieldCheckIcon size={12} weight="bold" />}
                {error ? 'ошибка' : 'подключено'}
              </span>
              {fetchedAt && (
                <span className="muted" style={{ fontSize: 12 }}>
                  {fromCache ? '📦 из кэша · ' : '🟢 свежие · '}{agoLabel}
                </span>
              )}
            </div>
            {error && <div className="muted" style={{ fontSize: 11, marginTop: 6, color: 'var(--bad)' }}>{error}</div>}
          </div>
          <div className="row gap-8" style={{ flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <span className="muted" style={{ fontSize: 12, alignSelf: 'center' }}>{fmtRangeRu(ozonAdsWindow(period).from, ozonAdsWindow(period).to)}</span>
            <div className="period-switch">
              {(['7d', '30d'] as Period[]).map(p => (
                <button key={p} className={`period-btn ${period === p ? 'active' : ''}`} onClick={() => setPeriod(p)}>
                  {p === '7d' ? '7 дней' : '30 дней'}
                </button>
              ))}
            </div>
            <button
              className="btn"
              onClick={() => { clearOzonPerfCache(); setCampaigns([]); setDaily([]); setFetchedAt(null); }}
              disabled={loading}
            >
              Сбросить кэш
            </button>
            <button className="btn btn-primary" onClick={() => load(true)} disabled={loading}>
              <ArrowsClockwiseIcon size={14} weight="bold" className={loading ? 'spin' : ''} />
              {loading ? 'Загрузка…' : 'Обновить из API'}
            </button>
          </div>
        </div>
        <div className="muted" style={{ fontSize: 11.5, marginTop: 10 }}>
          OAuth-токен живёт 30 минут, кэшируется автоматически. Данные кампаний — кэш 30 мин.
          У Ozon мягкие лимиты (~100 req/min), анти-burst как у WB нет.
        </div>
      </div>

      {!fetchedAt && !loading && (
        <div className="card" style={{ background: 'var(--accent-soft)', textAlign: 'center', padding: '24px 18px' }}>
          <div style={{ fontWeight: 600, color: 'var(--accent-2)', marginBottom: 6 }}>Данных в кэше нет</div>
          <div className="muted" style={{ fontSize: 13, color: 'var(--accent-2)' }}>
            Нажми <b>«Обновить из API»</b> — подтянем кампании и расход за период.
          </div>
        </div>
      )}

      {/* KPI */}
      {(fetchedAt || campaigns.length > 0) && (
        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>
          <div className="card kpi">
            <span className="d muted">Кампаний</span>
            <span className="v">{campaigns.length}</span>
            <span className="d muted" style={{ fontSize: 11 }}>активных {activeCount}</span>
          </div>
          <div className="card kpi">
            <span className="d muted"><CurrencyRubIcon size={11} weight="bold" /> Расход</span>
            <span className="v" style={{ color: 'var(--bad)' }}>{fmtRub(totals.sum)}</span>
            <span className="d muted" style={{ fontSize: 11 }}>за {period === '7d' ? '7д' : '30д'}</span>
          </div>
          <div className="card kpi">
            <span className="d muted"><CurrencyRubIcon size={11} weight="bold" /> Выручка</span>
            <span className="v" style={{ color: 'var(--good)' }}>{fmtRub(totals.ordersMoney)}</span>
          </div>
          <div className="card kpi" title="ROAS = выручка / расход. >1 — прибыльно">
            <span className="d muted">ROAS</span>
            <span className="v" style={{ color: totalRoas === null ? 'var(--muted)' : totalRoas >= 1 ? 'var(--good)' : 'var(--bad)' }}>
              {totalRoas !== null ? '×' + totalRoas.toFixed(2) : '—'}
            </span>
          </div>
          <div className="card kpi" title="ДРР = доля рекламных расходов = расход / выручка. Чем ниже, тем лучше">
            <span className="d muted">ДРР</span>
            <span className="v" style={{ color: totals.ordersMoney <= 0 ? 'var(--muted)' : (totals.sum / totals.ordersMoney) * 100 > 15 ? 'var(--bad)' : (totals.sum / totals.ordersMoney) * 100 >= 5 ? 'var(--warn)' : 'var(--good)' }}>
              {totals.ordersMoney > 0 ? ((totals.sum / totals.ordersMoney) * 100).toFixed(1) + '%' : '—'}
            </span>
          </div>
          <div className="card kpi">
            <span className="d muted"><EyeIcon size={11} weight="bold" /> Показы</span>
            <span className="v">{fmtNum(totals.views)}</span>
          </div>
          <div className="card kpi">
            <span className="d muted"><CursorClickIcon size={11} weight="bold" /> Клики</span>
            <span className="v">{fmtNum(totals.clicks)}</span>
            <span className="d muted" style={{ fontSize: 11 }}>CTR {fmtPct(totalCtr)} · CPC {fmtRub(totalCpc)}</span>
          </div>
          <div className="card kpi">
            <span className="d muted"><ShoppingCartIcon size={11} weight="bold" /> Заказы</span>
            <span className="v">{fmtNum(totals.orders)}</span>
          </div>
        </div>
      )}

      {/* Таблица кампаний */}
      {byCampaign.length > 0 && (
        <div className="card" style={{ padding: 0 }}>
          <div className="flex-between" style={{ padding: '14px 18px', borderBottom: '1px solid var(--border)' }}>
            <h3 style={{ margin: 0 }}>Кампании · сортировка по расходу</h3>
            <span className="muted" style={{ fontSize: 12 }}>{byCampaign.length} с данными за период</span>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ minWidth: 900 }}>
              <thead>
                <tr>
                  <th style={{ paddingLeft: 18 }}>ID / Название</th>
                  <th>Тип</th>
                  <th style={{ textAlign: 'center' }}>Статус</th>
                  <th style={{ textAlign: 'right' }}>Расход</th>
                  <th style={{ textAlign: 'right' }}>Показы</th>
                  <th style={{ textAlign: 'right' }}>Клики</th>
                  <th style={{ textAlign: 'right' }}>CTR</th>
                  <th style={{ textAlign: 'right' }}>CPC</th>
                  <th style={{ textAlign: 'right' }}>Заказы</th>
                  <th style={{ textAlign: 'right' }}>Выручка</th>
                  <th style={{ textAlign: 'right' }} title="ДРР = расход / выручка. Чем ниже, тем эффективнее">ДРР</th>
                  <th style={{ textAlign: 'right', paddingRight: 18 }}>ROAS</th>
                </tr>
              </thead>
              <tbody>
                {byCampaign.map(c => {
                  const meta = cmpMeta.get(c.id);
                  const ctr = c.views > 0 ? (c.clicks / c.views) * 100 : 0;
                  const cpc = c.clicks > 0 ? c.sum / c.clicks : 0;
                  const r = c.sum > 0 && c.ordersMoney > 0 ? c.ordersMoney / c.sum : null;
                  const drr = c.sum > 0 && c.ordersMoney > 0 ? (c.sum / c.ordersMoney) * 100 : null;
                  const st = meta?.state ? OZON_STATE_LABEL[meta.state] : null;
                  const typeLabel = meta?.advObjectType ? OZON_TYPE_LABEL[meta.advObjectType] || meta.advObjectType : null;
                  return (
                    <tr key={c.id}>
                      <td style={{ paddingLeft: 18 }}>
                        <div style={{ fontWeight: 600, fontSize: 13 }}>{c.title || meta?.title || `Кампания ${c.id}`}</div>
                        <div className="muted" style={{ fontSize: 11, fontFamily: 'ui-monospace, Menlo, monospace' }}>{c.id}</div>
                      </td>
                      <td style={{ fontSize: 12 }}>{typeLabel || <span className="muted">—</span>}</td>
                      <td style={{ textAlign: 'center' }}>
                        {st ? (
                          <span style={{ background: st.bg, color: st.color, padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 600 }}>
                            {st.label}
                          </span>
                        ) : <span className="muted">—</span>}
                      </td>
                      <td style={{ textAlign: 'right', fontWeight: 600 }}>{c.sum > 0 ? fmtRub(c.sum) : <span className="muted">—</span>}</td>
                      <td style={{ textAlign: 'right' }}>{c.views > 0 ? fmtNum(c.views) : <span className="muted">—</span>}</td>
                      <td style={{ textAlign: 'right' }}>{c.clicks > 0 ? fmtNum(c.clicks) : <span className="muted">—</span>}</td>
                      <td style={{ textAlign: 'right', color: ctr < 0.5 && c.views > 0 ? 'var(--bad)' : ctr >= 2 ? 'var(--good)' : 'var(--text)' }}>
                        {c.views > 0 ? fmtPct(ctr) : <span className="muted">—</span>}
                      </td>
                      <td style={{ textAlign: 'right' }}>{c.clicks > 0 && c.sum > 0 ? fmtRub(cpc) : <span className="muted">—</span>}</td>
                      <td style={{ textAlign: 'right', color: c.orders === 0 && c.sum > 300 ? 'var(--bad)' : 'var(--text)' }}>{c.orders}</td>
                      <td style={{ textAlign: 'right' }}>{c.ordersMoney > 0 ? fmtRub(c.ordersMoney) : <span className="muted">—</span>}</td>
                      <td style={{ textAlign: 'right', fontWeight: 600, color: drr === null ? 'var(--muted)' : drr > 15 ? 'var(--bad)' : drr >= 5 ? 'var(--warn)' : 'var(--good)' }}>
                        {drr !== null ? drr.toFixed(1) + '%' : <span className="muted">—</span>}
                      </td>
                      <td style={{ textAlign: 'right', paddingRight: 18, fontWeight: 600, color: r === null ? 'var(--muted)' : r >= 1 ? 'var(--good)' : 'var(--bad)' }}>
                        {r !== null ? '×' + r.toFixed(2) : <span className="muted">—</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Список всех кампаний (даже без данных за период) */}
      {campaigns.length > 0 && (
        <div className="card" style={{ padding: 0 }}>
          <div className="flex-between" style={{ padding: '14px 18px', borderBottom: '1px solid var(--border)' }}>
            <h3 style={{ margin: 0 }}>Все кампании · {campaigns.length}</h3>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ minWidth: 700 }}>
              <thead>
                <tr>
                  <th style={{ paddingLeft: 18 }}>ID / Название</th>
                  <th>Тип</th>
                  <th>Оплата</th>
                  <th style={{ textAlign: 'center' }}>Статус</th>
                  <th style={{ textAlign: 'right' }}>Дн. бюджет</th>
                  <th style={{ paddingRight: 18 }}>Период</th>
                </tr>
              </thead>
              <tbody>
                {campaigns.map(c => {
                  const st = c.state ? OZON_STATE_LABEL[c.state] : null;
                  const typeLabel = c.advObjectType ? OZON_TYPE_LABEL[c.advObjectType] || c.advObjectType : '—';
                  return (
                    <tr key={c.id}>
                      <td style={{ paddingLeft: 18 }}>
                        <div style={{ fontWeight: 500, fontSize: 13 }}>{c.title || `Кампания ${c.id}`}</div>
                        <div className="muted" style={{ fontSize: 11, fontFamily: 'ui-monospace, Menlo, monospace' }}>{c.id}</div>
                      </td>
                      <td style={{ fontSize: 12 }}>{typeLabel}</td>
                      <td style={{ fontSize: 12 }} className="muted">{c.paymentType || '—'}</td>
                      <td style={{ textAlign: 'center' }}>
                        {st && (
                          <span style={{ background: st.bg, color: st.color, padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 600 }}>
                            {st.label}
                          </span>
                        )}
                      </td>
                      <td style={{ textAlign: 'right', fontSize: 12 }}>{c.dailyBudget ? fmtRub(Number(c.dailyBudget)) : '—'}</td>
                      <td style={{ paddingRight: 18, fontSize: 11, color: 'var(--muted)' }}>
                        {c.fromDate}{c.toDate ? ` → ${c.toDate}` : ''}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

export function Ads() {
  const [mp, setMp] = useState<Mp>('wb');

  return (
    <div className="grid" style={{ gap: 20 }}>
      <div className="row gap-8" style={{ flexWrap: 'wrap' }}>
        <button className={`mp-tab ${mp === 'wb' ? 'active' : ''}`} onClick={() => setMp('wb')}>
          <span className="mp-tab-dot" style={{ background: '#cb11ab' }} />
          Wildberries
          <span className="muted" style={{ marginLeft: 6 }}>live API</span>
        </button>
        <button className={`mp-tab ${mp === 'ozon' ? 'active' : ''}`} onClick={() => setMp('ozon')}>
          <span className="mp-tab-dot" style={{ background: '#005bff' }} />
          Ozon
          <span className="muted" style={{ marginLeft: 6 }}>Performance API</span>
        </button>
      </div>

      <AdsManage platform={mp}>{(report) => <AdsInsightPanel platform={mp} report={report} />}</AdsManage>

      {/* Поартикульный расход и ДРР — выше кампаний: клиент смотрит именно на него. */}
      <AdsBySku platform={mp} />

      {/* 18.09.2026: панели кампаний WB/Ozon и «Совет ИИ по разделу» убраны по просьбе клиента — остались «Управление рекламой» и «Реклама по артикулам». */}
    </div>
  );
}
