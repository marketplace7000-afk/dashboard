import { Fragment, useMemo, useState, useEffect } from 'react';
import { useShowcaseCheck } from '../api/showcaseCheck';
import { safeSetItem } from '../utils/safeStorage';
import { onUiStateChange } from '../utils/uiState';
import {
  SpinnerIcon, WarningIcon, ArrowsClockwiseIcon, CalculatorIcon,
  CaretUpIcon, CaretDownIcon, StorefrontIcon, ArchiveIcon, ArrowCounterClockwiseIcon, EyeIcon,
} from '@phosphor-icons/react';
import { OzonPriceRow, OzonProductInfo } from '../api/marketplaces';
import { useLiveOzonBundle, productInfoIndex } from '../api/useLiveOzonCache';
import { useProcurement } from '../api/useProcurement';
import { calcROI, roiStatus, ROI_STATUS_COLOR } from '../utils/roiLogic';
import { adsAdvice } from '../utils/adsAdvice';
import { archiveSKU, unarchiveSKU, getArchivedSKUs } from '../utils/procurementLogic';
import { AiAdvice } from './AiAdvice';
import { calcOzonProfit, OZON_DEFAULTS, type OzonCalcInput } from '../utils/ozonProfit';
import { PricingGlobalParams, type GParamField } from './PricingGlobalParams';
import { ozonBuyerPricesRes, ozonSkuAdsRes, ozonShowcaseRes } from '../api/pricingResources';
import { fmtClock, fmtDateClock } from '../api/sideResource';
import { noteSwallowed } from '../utils/log';
import { productEconRes } from '../api/pricingResources';
import { mskDate } from '../utils/mskDate';
import { useEffect as useEffectM } from 'react';
let marginsPushedAt = 0;

// Поля глобальной панели Ozon. «СПП по умолч.» заполняет вторую цену там,
// где нет факта (Ozon соинвест в API не отдаёт) — buyer = ЛК × (1 − соинвест%).
const OZON_GPARAMS: GParamField[] = [
  { key: 'usn', label: 'УСН', suffix: '%' },
  { key: 'nds', label: 'НДС', suffix: '%' },
  { key: 'acq', label: 'Эквайринг', suffix: '%' },
  { key: 'drr', label: 'ДРР по умолч.', suffix: '%' },
  { key: 'buyout', label: '% выкупа по умолч.', suffix: '%' },
  { key: 'spp', label: 'СПП по умолч.', suffix: '%' },
];

// Крутилки калькулятора прибыли Ozon по строке. Ключ — product_id.
// buyout (% выкупа) — отдельный ключ: в OzonCalcInput вместо него returnRate (% возвратов = 100 − выкуп).
/** Сколько дней память соинвеста считается пригодной для восстановления цены. */
const SPP_MEMORY_DAYS = 14;
const SHOWCASE_FRESH_MS = 6 * 60 * 60_000; // старше — не витрина, а история (см. LiveWbPricing.tsx)

type OzKnobs = Partial<Pick<OzonCalcInput, 'price' | 'cost' | 'spp' | 'drr' | 'commission' | 'acquiring'>> & { buyout?: number };

type Row = OzonPriceRow & { name?: string; primary_image?: string };

function pickRecommendBase(r: OzonPriceRow): { src: 'ozon' | 'external' | 'self' | null; min: number } {
  const o = +r.price_indexes.ozon_index_data?.min_price || 0;
  const e = +r.price_indexes.external_index_data?.min_price || 0;
  const s = +r.price_indexes.self_marketplaces_index_data?.min_price || 0;
  const candidates: { src: 'ozon' | 'external' | 'self'; min: number }[] = [];
  if (o > 0) candidates.push({ src: 'ozon', min: o });
  if (e > 0) candidates.push({ src: 'external', min: e });
  if (s > 0) candidates.push({ src: 'self', min: s });
  if (!candidates.length) return { src: null, min: 0 };
  candidates.sort((a, b) => a.min - b.min);
  return candidates[0];
}

const SOURCE_LABEL: Record<'ozon' | 'external' | 'self', string> = {
  ozon: 'другие селлеры на Ozon',
  external: 'другие площадки (WB, ЯМ и т.д.)',
  self: 'твои магазины-двойники',
};

const num = (v: any) => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
const fmt = (v: any) => num(v).toLocaleString('ru-RU') + ' ₽';

// % выкупа из таблицы (доля 0..1 → %); пусто/0 → фолбэк 88% (просьба клиента 21.07).
const buyoutPct = (v?: number | null): number =>
  (v && v > 0) ? (v > 1.5 ? Math.round(v) : Math.round(v * 100)) : 88;

export function LiveOzonPricing() {
  const bundle = useLiveOzonBundle();
  // Себестоимость и % маржи приходят из Google-таблицы через закупочный модуль
  const procurement = useProcurement();
  // Экономика по артикулу: себестоимость, ДРР, комиссия и логистика по выбранной
  // схеме работы. Собрана по артикулу и не зависит от того, попал ли товар в
  // таблицу клиента (см. api/_lib/productEcon.ts).
  const pEconRes = productEconRes.use();
  const pEcon = pEconRes.data?.ozon ?? {};
  // Схема работы подписывается рядом с комиссией — иначе по цифре не понять,
  // FBO это или FBS (вопрос клиента 03.09).
  const ozScheme = (pEconRes.data?.fulfilment.ozon ?? 'fbs').toUpperCase();
  // Коридор — фикс. значение. Раньше был бегунок, но Ozon по большинству SKU
  // не отдаёт цены конкурентов (индекс пустой), поэтому крутить его было
  // бессмысленно — бегунок убрали, чтобы не вводить в заблуждение.
  const corridor = 5;
  // Цена покупателя Ozon из API акций (только когда action_price реально ниже ЛК) +
  // ПАМЯТЬ последнего настоящего СПП по SKU — чтобы вторая цена не «слетала», когда
  // акция закончилась (просьба клиента: «запоминать крайний СПП»).
  // Ресурсы живут в module-scope и умеют форс-обновление — кнопка «Обновить»
  // теперь реально перезапрашивает цену, а не отдаёт кэш (жалоба клиента 05.08).
  const buyerRes = ozonBuyerPricesRes.use();
  const ozBuyer = buyerRes.data?.items ?? {};
  const ozSppHist = buyerRes.data?.sppHistory ?? {};
  const showcaseRes = ozonShowcaseRes.use();
  const ozShowcase = showcaseRes.data?.items ?? {};
  const showcaseLastAt = useMemo(() => { let m = 0; for (const it of Object.values(ozShowcase) as any[]) if (Number(it?.at) > m) m = Number(it.at); return m || null; }, [ozShowcase]);
  // Расход рекламы по каждому SKU из Performance API — чтобы ДРР считался из API,
  // а не из ручной колонки таблицы (просьба клиента 29.07). Если отчёт недоступен,
  // остаётся прежний порядок: таблица → глобальный параметр.
  const skuAdsRes = ozonSkuAdsRes.use();
  const skuAds = skuAdsRes.data?.items ?? {};
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});
  // Крутилки: храним СЫРУЮ строку (в т.ч. пустую), чтобы поле можно было стереть
  // и вписать своё. В расчёт идёт распарсенное число; пустое → дефолт.
  const KNOBS_LS = 'prices-ozon:knobs';
  const loadKnobs = (): Record<number, Record<string, string>> => { try { return JSON.parse(localStorage.getItem(KNOBS_LS) || '{}'); } catch { return {}; } };
  const saveKnobs = (n: Record<number, Record<string, string>>) => { try { safeSetItem(KNOBS_LS, JSON.stringify(n)); } catch (e) { noteSwallowed('ui-prefs', 'сценарий не сохранён', e, 60 * 60_000); } };
  const [ozKnobs, setOzKnobs] = useState<Record<number, Record<string, string>>>(loadKnobs);
  const setOzKnob = (pid: number, k: keyof OzKnobs, v: string) =>
    setOzKnobs(prev => { const n = { ...prev, [pid]: { ...prev[pid], [k]: v } }; saveKnobs(n); return n; });
  const [archiveTick, setArchiveTick] = useState(0);
  const [search, setSearch] = useState('');
  const searchQ = search.trim().toLowerCase();
  const [showArchive, setShowArchive] = useState(false);
  const [sortBy, setSortBy] = useState<'price' | 'margin' | 'roi' | 'name'>('price');
  // Фильтр «только в продаже» — теперь переключаемый (просьба клиента 09.07).
  const [inStockOnly, setInStockOnly] = useState<boolean>(() => {
    try { return localStorage.getItem('prices-ozon:inStockOnly') !== '0'; } catch { return true; }
  });
  const toggleInStock = () => setInStockOnly(v => {
    try { localStorage.setItem('prices-ozon:inStockOnly', v ? '0' : '1'); } catch (e) { noteSwallowed('ui-prefs', 'настройка интерфейса не сохранена', e, 60 * 60_000); }
    return !v;
  });

  // Глобальные параметры расчёта (панель сверху) — как на WB.
  const GP_LS = 'prices-ozon:globalParams';
  const loadGP = (): Record<string, string> => { try { return JSON.parse(localStorage.getItem(GP_LS) || '{}'); } catch { return {}; } };
  const [gpDraft, setGpDraft] = useState<Record<string, string>>(loadGP);
  const [gpApplied, setGpApplied] = useState<Record<string, string>>(loadGP);
  const gpChange = (k: string, v: string) => setGpDraft(p => ({ ...p, [k]: v }));
  const gpApply = () => { setGpApplied(gpDraft); try { safeSetItem(GP_LS, JSON.stringify(gpDraft)); } catch (e) { noteSwallowed('ui-prefs', 'настройка интерфейса не сохранена', e, 60 * 60_000); } };
  const gpReset = () => { setGpDraft({}); setGpApplied({}); try { safeSetItem(GP_LS, '{}'); } catch (e) { noteSwallowed('ui-prefs', 'настройка интерфейса не сохранена', e, 60 * 60_000); } };
  const gp = (k: string, fb: number): number => {
    const s = gpApplied[k];
    if (s == null || s.trim() === '') return fb;
    const n = parseFloat(s.replace(',', '.'));
    return isNaN(n) ? fb : n;
  };

  // Кнопка «Проверить цены на витрине»: когда Routine снял витрину — подтянуть свежие цены покупателя.
  const sc = useShowcaseCheck('ozon', () => { void showcaseRes.refresh(true); void buyerRes.refresh(true); });
  const archivedSet = useMemo(() => new Set(getArchivedSKUs('prices-ozon')), [archiveTick]);
  // Общая память: пришли изменения с сервера (другой пользователь/вкладка) — перечитать архив, параметры, сценарии.
  useEffect(() => onUiStateChange(() => { setArchiveTick(t => t + 1); const gp = loadGP(); setGpApplied(gp); setGpDraft(gp); setOzKnobs(loadKnobs()); }), []);

  // Индекс sku → ProcurementItem (для маржи/ROI)
  const procurementBySku = useMemo(() => {
    const m = new Map<string, typeof procurement.items[number]>();
    for (const p of procurement.items) m.set(p.sku.toUpperCase(), p);
    return m;
  }, [procurement.items]);

  // Индекс «родительский артикул → размерный вариант» — одежда в закупках ведётся по
  // размерам (…-M/-L), а карточка МП родительская. Матчим к варианту с себестоимостью.
  const procByParent = useMemo(() => {
    const m = new Map<string, typeof procurement.items[number]>();
    for (const p of procurement.items) {
      const parts = p.sku.toUpperCase().split('-');
      if (parts.length < 2) continue;
      const parent = parts.slice(0, -1).join('-');
      const cur = m.get(parent);
      if (!cur || ((p.purchasePrice || 0) > 0 && !(cur.purchasePrice || 0))) m.set(parent, p);
    }
    return m;
  }, [procurement.items]);

  const rows: Row[] = useMemo(() => {
    const byId = productInfoIndex(bundle);
    return bundle.prices.map((p) => {
      const meta = byId.get(p.product_id) as OzonProductInfo | undefined;
      return { ...p, name: meta?.name, primary_image: meta?.primary_image };
    });
  }, [bundle]);

  const recommendFor = (r: Row): { price: number; reason: string; src: string } => {
    const cur = num(r.price.price);
    const min = num(r.price.min_price);
    const base = pickRecommendBase(r);
    if (base.src && base.min > 0) {
      const target = Math.round(base.min * (1 + corridor / 100));
      if (min > 0 && target < min) return { price: min, reason: `минимум ${fmt(min)} (защита по min_price)`, src: base.src };
      return { price: target, reason: `+${corridor}% к минимуму «${SOURCE_LABEL[base.src]}» (${fmt(base.min)})`, src: base.src };
    }
    return { price: cur, reason: 'нет данных по конкурентам', src: '—' };
  };

  const onArchive = (offerId: string) => {
    // Хранилище браузера могло переполниться — тогда молча ничего не происходило
    // и кнопка выглядела нерабочей (жалоба 01.08). Теперь говорим прямо.
    if (!archiveSKU(offerId.toUpperCase(), 'prices-ozon')) {
      alert('Не удалось сохранить: в браузере кончилось место. Обновите страницу и попробуйте снова.');
      return;
    }
    setArchiveTick(t => t + 1);
  };
  const onUnarchive = (offerId: string) => { unarchiveSKU(offerId.toUpperCase(), 'prices-ozon'); setArchiveTick(t => t + 1); };

  // Клиент (06:38): «смотрим только товары, которые в наличии». Фильтруем по
  // остатку Ozon из закупок; если данных об остатках нет — показываем всё.
  // 09.07: фильтр стал переключаемым (кнопка «В продаже»), по умолчанию включён.
  const haveStockData = useMemo(() => [...procurementBySku.values()].some((p) => (p.stockOzon || 0) > 0), [procurementBySku]);
  // Активен на Ozon: остаток, продажи (7/30) ИЛИ % выкупа Ozon (заполнен только при продажах).
  const inStock = (r: Row) => {
    if (!haveStockData) return true;
    const p = procurementBySku.get(r.offer_id.toUpperCase());
    return (p?.stockOzon || 0) > 0 || (p?.sales7Ozon || 0) > 0 || (p?.sales30Ozon || 0) > 0 || (p?.buyoutOzon || 0) > 0;
  };
  const inStockCount = rows.filter(r => !archivedSet.has(r.offer_id.toUpperCase()) && inStock(r)).length;
  const visibleRows = rows.filter(r => (!searchQ || r.offer_id.toLowerCase().includes(searchQ) || String(r.product_id).includes(searchQ)) && (showArchive
    ? archivedSet.has(r.offer_id.toUpperCase())
    : (!archivedSet.has(r.offer_id.toUpperCase()) && (!inStockOnly || inStock(r)))));
  const proposedCount = visibleRows.filter((r) => recommendFor(r).price !== num(r.price.price)).length;
  const archivedCount = rows.filter(r => archivedSet.has(r.offer_id.toUpperCase())).length;

  // ЕДИНЫЙ расчёт строки Ozon — источник истины для таблицы, сортировки и ИИ-советника.
  // kk — крутилки строки; для сортировки/советника передаём {} (дефолты).
  const computeOzonRow = (r: Row, kk: Record<string, string>) => {
    const oid = r.offer_id.toUpperCase();
    const proc = procurementBySku.get(oid) ?? procByParent.get(oid); // точный → размерный вариант
    // Цена ЛК — API-FIRST: marketing_seller_price (реальная цена продавца со скидкой,
    // напр. 30 785) → таблица «ДРР и цены» → и лишь в крайнем случае price.price
    // (это витринный «потолок», напр. 150 000 — ставим последним, чтобы не всплыл).
    const cur = num(r.price.marketing_seller_price) || num(proc?.lkPriceOzon) || num(r.price.price);
    const ozb = ozBuyer[r.offer_id.toUpperCase()];
    const showcase = ozShowcase[oid];
    const showcaseFresh = !!showcase && showcase.price > 0 && Date.now() - showcase.at <= SHOWCASE_FRESH_MS;
    // Живая цена с витрины ozon.ru — если ЛК-цена с момента снятия не изменилась,
    // берём её как есть; если изменилась — пересчитываем по запомненному СПП%
    // от ТЕКУЩЕЙ цены ЛК (тот же приём, что и для WB, см. LiveWbPricing.tsx).
    let buyerFromShowcase = 0;
    if (showcaseFresh) {
      const capturedGrey = showcase.greyPrice && showcase.greyPrice > 0 ? showcase.greyPrice : null;
      if (capturedGrey && cur > 0 && Math.abs(cur - capturedGrey) >= 1) {
        const rememberedSppFrac = (capturedGrey - showcase.price) / capturedGrey;
        buyerFromShowcase = Math.max(0, Math.round(cur * (1 - rememberedSppFrac)));
      } else {
        buyerFromShowcase = showcase.price;
      }
    }
    // Память витрины (17.09.2026, просьба клиента): снимок старше 6 ч — берём СПП% из него и применяем
    // к текущей цене ЛК, пока витрину не сняли заново (компьютер выключен / антибот).
    const showcaseMem = (!showcaseFresh && showcase && showcase.price > 0)
      ? ((showcase.greyPrice && showcase.greyPrice > 0 && cur > 0) ? Math.max(0, Math.round(cur * (1 - (showcase.greyPrice - showcase.price) / showcase.greyPrice))) : showcase.price)
      : 0;
    // Реализация даёт соинвест-ПРОЦЕНТ (надёжнее абсолютной цены: она устаревает при
    // смене цены ЛК и завышает СПП). Применяем % к ТЕКУЩЕЙ цене ЛК: buyer = ЛК×(1−СПП%).
    const buyerFromApi = ozb && ozb.spp > 0 && cur > 0 ? Math.round(cur * (1 - ozb.spp / 100)) : 0;
    const buyerFromTable = num(proc?.buyerPriceOzon) > 0 && num(proc?.buyerPriceOzon) < cur ? num(proc?.buyerPriceOzon) : 0;
    // ПАМЯТЬ: живой скидки нет и в таблице пусто — восстанавливаем от последнего
    // настоящего СПП (buyer = ЛК × (1 − крайний СПП%)). Просьба клиента.
    const memHist = ozSppHist[r.offer_id.toUpperCase()];
    // Память соинвеста годна недолго. 04.09: к светильнику применили 72% из
    // памяти полугодовой давности при реальных ~45% сегодня — получили 2 331 ₽
    // против 4 766 ₽ на витрине. Старый процент на новой цене — это не оценка,
    // а выдумка. Но по просьбе клиента (16.09.2026) память теперь применяется
  // бессрочно: цена по старому СПП ближе к правде, чем цена ЛК. Давность
  // СПП% всегда видна в подсказке у цены на дашборде.
    const memAgeDays = memHist?.date
      ? Math.round((Date.parse(mskDate(0)) - Date.parse(memHist.date)) / 86_400_000) : Infinity;
    const memFresh = !!memHist && memHist.spp > 0;
    const buyerFromMemory = buyerFromApi === 0 && buyerFromTable === 0 && memFresh && cur > 0
      ? Math.round(cur * (1 - memHist.spp / 100)) : 0;
    // Глобальный соинвест по умолч. (панель): последний фолбэк, если даже памяти нет.
    const gpSpp = gp('spp', 0);
    const buyerGlobal = buyerFromApi === 0 && buyerFromTable === 0 && buyerFromMemory === 0 && gpSpp > 0 && cur > 0
      ? Math.round(cur * (1 - gpSpp / 100)) : 0;
    const buyerPrice = buyerFromShowcase > 0 ? buyerFromShowcase
      : showcaseMem > 0 ? showcaseMem
      : buyerFromApi > 0 ? buyerFromApi
      : buyerFromTable > 0 ? buyerFromTable
      : buyerFromMemory > 0 ? buyerFromMemory
      : buyerGlobal > 0 ? buyerGlobal
      : cur;
    const sppReal = buyerPrice > 0 && buyerPrice < cur ? Math.round((cur - buyerPrice) / cur * 100) : 0;
    // Себестоимость: сперва наш справочник по артикулу, и только потом таблица.
    // Раньше путь был только через таблицу, и новый товар оставался без неё —
    // отсюда прочерки вместо прибыли и ROI (правка клиента 29.08).
    const econRow = pEcon[r.offer_id.toUpperCase()];
    const cost = econRow?.cost.value ?? proc?.purchasePrice ?? 0;
    const okn = (key: keyof OzKnobs): number | undefined => {
      const s = kk[key];
      if (s === undefined || s.trim() === '') return undefined;
      const n = parseFloat(s.replace(',', '.'));
      return isNaN(n) ? undefined : n;
    };
    // Комиссия по ВЫБРАННОЙ схеме работы. Была жёстко зашита FBO, хотя клиент
    // перешёл на FBS: ставки у схем разные, и чужая занижала расходы по всему
    // каталогу. Схема задаётся в настройках; резолвер уже выбрал нужное поле.
    const apiComm = econRow?.commissionPct.value ?? (+r.commissions?.sales_percent_fbo || 0);
    const cm: any = r.commissions || {};
    const deliv = +cm.fbo_deliv_to_customer_amount || 0;
    const transMin = +cm.fbo_direct_flow_trans_min_amount || 0;
    const transMax = +cm.fbo_direct_flow_trans_max_amount || 0;
    const apiLog = econRow?.logisticRub.value ?? (deliv + (transMin && transMax ? (transMin + transMax) / 2 : 0));
    // 16.09.2026: схема FBS — берём fbs_return_flow_amount (было fbo: 115 ₽ против 205 ₽ на FBS).
    const apiReturn = +cm.fbs_return_flow_amount || +cm.fbo_return_flow_amount || OZON_DEFAULTS.returnBase;
    const apiAcq = +r.acquiring || 0;
    const drrFromTable = proc?.drrOzon;
    // ДРР из API: расход на рекламу ÷ выручку от рекламы по этому SKU за 30 дней.
    // Приоритетнее таблицы — это живой факт, а не ручная колонка.
    // Приоритет: считаем сами (расход ÷ выручка), иначе берём готовый ДРР из
    // отчёта Ozon — он есть, когда выручку в разрезе товара отчёт не отдал.
    const ad = skuAds[oid];
    const drrFromApi = ad && ad.revenue > 0 && ad.spend > 0
      ? Math.round(ad.spend / ad.revenue * 1000) / 10
      : ad?.drr && ad.drr > 0 ? Math.round(ad.drr * 10) / 10
      : null;
    // Есть ли у товара вообще товарная реклама на Ozon. Если нет — подпись «нет
    // рекламы Ozon», а не пугающее «из таблицы»: разбивку по товару Ozon отдаёт
    // только по активным товарным кампаниям, отсутствие данных здесь — норма.
    const hasOzonAd = !!(ad && (ad.spend > 0 || (ad.drr ?? 0) > 0));
    const commIsDefault = apiComm <= 0 && kk.commission === undefined;
    const buyoutKnob = okn('buyout');
    const price = okn('price') ?? cur;
    // Эквайринг Ozon — % от цены. Приоритет: крутилка → API (₽ ÷ цена) → глоб. параметр → 1.5%.
    const acqPctDefault = cur > 0 && apiAcq > 0 ? (apiAcq / cur * 100) : gp('acq', 1.5);
    const acqPct = okn('acquiring') ?? acqPctDefault;
    const buyoutDefault = econRow?.buyoutFact?.value ?? (proc?.buyoutOzon && proc.buyoutOzon > 0 ? buyoutPct(proc.buyoutOzon) : gp('buyout', 88));
    const oi = {
      price,
      cost: okn('cost') ?? cost,
      commission: okn('commission') ?? (apiComm || OZON_DEFAULTS.commission),
      spp: okn('spp') ?? sppReal,
      // Приоритет ДРР: крутилка → API (факт) → таблица → глобальный параметр.
      // ДРР: крутилка → факт по товару из резолвера (в т.ч. честный 0, если
      // рекламы не было) → прежний путь → таблица → общий параметр. Проверяем на
      // null, а не на ложность: иначе честный ноль снова подменялся бы дефолтом
      // в 7%, из-за которого прибыль занижена у всех товаров без рекламы.
      drr: okn('drr') ?? econRow?.drr.value ?? drrFromApi
        ?? (drrFromTable != null ? drrFromTable : gp('drr', OZON_DEFAULTS.drr)),
      acquiring: Math.round(acqPct / 100 * price), // ₽ из %
      logistic: econRow?.logisticFact?.value ?? (apiLog || OZON_DEFAULTS.logistic),
      storage: OZON_DEFAULTS.storage,
      returnBase: apiReturn,
      // Факт обратной логистики из начислений Ozon (16.09.2026); ручной % выкупа возвращает формулу по тарифу.
      returnCostPerSale: buyoutKnob == null ? (econRow?.returnFact?.value ?? undefined) : undefined,
      // % выкупа: крутилка → ФАКТ из таблицы → глоб. параметр → 88%. returnRate = 100 − выкуп.
      returnRate: Math.max(0, 100 - (buyoutKnob != null ? buyoutKnob : buyoutDefault)),
      usn: gp('usn', OZON_DEFAULTS.usn),
      nds: gp('nds', OZON_DEFAULTS.nds),
    };
    // Без себестоимости расчёт неполон → маржу не выдаём за достоверную.
    const oc = cost > 0 ? calcOzonProfit(oi) : null;
    const marginPct = oc ? Math.round(oc.margin) : null;
    const marginRub = oc ? Math.round(oc.profit) : null;
    const roi = oc ? Math.round(oc.roi) : null;
    const roiInfo = roi !== null && cost > 0 ? roiStatus(roi, cost) : null;
    return { proc, cur, ozb, buyerFromShowcase, showcaseMem, showcase, buyerFromApi, buyerFromTable, buyerFromMemory, memHist, memAgeDays, buyerPrice, sppReal, cost, apiComm, apiLog,
      apiReturn, apiAcq, drrFromTable, drrFromApi, hasOzonAd, acqPct, commIsDefault, oi, oc, marginPct, marginRub, roi, roiInfo, econRow };
  };

  // Ø СПП по видимым SKU — РЕАЛЬНАЯ скидка (цена покупателя ниже ЛК), а не мусор
  // от «потолка» акции. Считаем от цены ЛК и достоверной цены покупателя.
  const sppVals = visibleRows.map(r => computeOzonRow(r, {}).sppReal).filter(v => v > 0);
  const avgSpp = sppVals.length ? Math.round(sppVals.reduce((a, b) => a + b, 0) / sppVals.length) : 0;
  const storeDrr7 = pEconRes.data?.storeDrr?.ozon?.d7 ?? null;

  // Сортировка — по ЖИВОМУ расчёту (те же цифры, что в таблице), не по таблице.
  const sortKey = (r: Row) => {
    const m = computeOzonRow(r, {});
    return { price: m.buyerPrice, margin: m.marginPct ?? -Infinity, roi: m.roi ?? -Infinity, name: (r.name || r.offer_id).toLowerCase() };
  };
  const sortedRows = [...visibleRows].sort((a, b) => {
    const ka = sortKey(a), kb = sortKey(b);
    if (sortBy === 'name') return ka.name.localeCompare(kb.name);
    return (kb[sortBy] as number) - (ka[sortBy] as number);
  });

  // Снимок маржи для «Управления рекламой» (17.09.2026): те же цифры, что в таблице,
  // уходят в общую память UI (prices-ozon:margins); сервер берёт их для «маржи после рекламы».
  useEffectM(() => {
    if (!rows.length || Date.now() - marginsPushedAt < 60_000) return;
    const items: Record<string, { marginPct: number | null; marginRub: number | null }> = {};
    for (const r of rows) {
      const m = computeOzonRow(r, {});
      const k = String(r.offer_id ?? '').trim().toUpperCase();
      if (k) items[k] = { marginPct: m.marginPct ?? null, marginRub: m.marginRub ?? null };
    }
    marginsPushedAt = Date.now();
    safeSetItem('prices-ozon:margins', JSON.stringify({ at: marginsPushedAt, items }));
  });
  const adviceContext = {
    показано_SKU: visibleRows.length,
    предложено_изменений_цены: proposedCount,
    коридор_пр: corridor,
    строки: sortedRows.slice(0, 20).map((r) => {
      // Те же цифры, что в таблице (живой расчёт), а не мёртвые marketing_price/табличная маржа.
      const m = computeOzonRow(r, {});
      const rec = recommendFor(r);
      return { sku: r.offer_id, цена_ЛК: Math.round(m.cur), цена_покупателя: Math.round(m.buyerPrice), СПП_пр: m.sppReal,
        маржа_пр: m.marginPct, прибыль_руб: m.marginRub, ROI_пр: m.roi, рекоменд_цена: rec.price };
    }),
  };

  return (
    <div className="grid" style={{ gap: 16 }}>
      <AiAdvice module="prices" context={adviceContext} disabled={visibleRows.length === 0} />
      <PricingGlobalParams fields={OZON_GPARAMS} draft={gpDraft} onChange={gpChange} onApply={gpApply} onReset={gpReset} color="#005bff" />
      <div className="card">
      <div className="flex-between" style={{ marginBottom: 14 }}>
        <h2 style={{ margin: 0, display: 'inline-flex', alignItems: 'center', gap: 10, whiteSpace: 'nowrap' }}>
          <span className="mp-tab-dot" style={{ background: '#005bff' }} />
          Управление ценами Ozon
        </h2>
        <div className="row gap-8" style={{ flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {bundle.loading && bundle.fetchedAt == null && (
            <span className="chip info"><SpinnerIcon size={11} weight="bold" className="spin" /> загрузка…</span>
          )}
          {!showArchive && (
            <button
              className="btn btn-sm"
              onClick={toggleInStock}
              title="Показывать только товары с остатком на Ozon"
              style={inStockOnly ? { background: 'var(--accent)', color: '#fff', borderColor: 'var(--accent)' } : undefined}
            >
              <StorefrontIcon size={13} weight="bold" /> В продаже ({inStockCount})
            </button>
          )}
          <button
            className="btn btn-sm"
            onClick={() => setShowArchive(s => !s)}
            title={showArchive ? 'Показать активные' : 'Показать архив'}
          >
            {showArchive ? <EyeIcon size={13} weight="bold" /> : <ArchiveIcon size={13} weight="bold" />}
            {showArchive ? `Активные` : `Архив (${archivedCount})`}
          </button>
          <input
            className="input"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Поиск по артикулу…"
            title="Фильтр таблицы по артикулу (любая часть)"
            style={{ width: 210, padding: '6px 10px', fontSize: 14 }}
          />
          <select
            className="input"
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
            style={{ width: 'auto', padding: '6px 8px', fontSize: 14 }}
            title="Сортировка"
          >
            <option value="price">по цене ↓</option>
            <option value="margin">по марже ↓</option>
            <option value="roi">по ROI ↓</option>
            <option value="name">по названию</option>
          </select>
          {sc.pinOpen && !sc.pending ? (
            <form onSubmit={(e) => { e.preventDefault(); void sc.submit(); }} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <input className="input" type="text" inputMode="numeric" autoComplete="off" name="showcase-pin" autoFocus value={sc.pin} onChange={(e) => sc.setPin(e.target.value)} placeholder="Пароль" style={{ width: 110, padding: '6px 10px', fontSize: 14, WebkitTextSecurity: 'disc' } as any} />
              <button className="btn btn-sm" type="submit" disabled={sc.busy}>OK</button>
              <button className="btn btn-sm" type="button" onClick={sc.closePin}>Отмена</button>
              {sc.error && <span style={{ fontSize: 13, color: '#c62828', whiteSpace: 'nowrap' }}>{sc.error}</span>}
            </form>
          ) : (
            <button
              className="btn btn-sm"
              onClick={sc.openPin}
              disabled={!!sc.pending}
              title="Принудительно обновить цены покупателя: Claude откроет витрины WB и Ozon в браузере и запишет реальные цены. Нужен пароль. Выполняется при ближайшем запуске задачи (каждый час в :14), нужен включённый компьютер с Chrome. Данные из API обновляются на сервере автоматически, без кнопок"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}
            >
              {sc.pending ? <SpinnerIcon size={14} weight="bold" className="spin" /> : <ArrowsClockwiseIcon size={14} weight="bold" />}
              {sc.pending ? 'Обновление цен запрошено' : 'Обновить цены покупателя'}
            </button>
          )}
          <span className="muted" style={{ fontSize: 13, flexBasis: '100%', textAlign: 'right', whiteSpace: 'normal' }} title="Когда последний раз снимались цены покупателя с витрины. Автоматических проверок нет: витрину снимает Claude только по вашему запросу (кнопка + пароль, затем напишите Claude в чат: обнови цены покупателя). Между проверками цена покупателя = текущая цена ЛК x (1 - СПП крайней проверки).">
            {sc.pending
              ? `запрос от ${fmtDateClock(sc.pending)} принят — чтобы Claude снял витрины, напишите ему в чат «обнови цены покупателя» (нужен включённый ПК с Chrome)`
              : `цена на витрине проверена: ${fmtDateClock(showcaseLastAt ?? showcaseRes.data?.fetchedAt ?? buyerRes.fetchedAt)}`}
          </span>
        </div>
      </div>

        <div className="grid grid-3" style={{ gap: 12 }}>
          <div className="kpi">
            <div className="card-title">Товаров</div>
            <div className="v">{visibleRows.length}</div>
          </div>
          <div className="kpi" title="Средний СПП по всем видимым товарам на момент просмотра: реальная скидка площадки (цена покупателя ниже цены продавца)">
            <div className="card-title">Средний СПП</div>
            <div className="v">{avgSpp}%</div>
          </div>
          <div className="kpi" title="Средний ДРР магазина Ozon за последние 7 дней: расходы на рекламу / выручка по всем кампаниям (из рекламного API)">
            <div className="card-title">ДРР магазина · 7 дн</div>
            <div className="v">{storeDrr7 == null ? '—' : `${storeDrr7}%`}</div>
          </div>
        </div>
      </div>

      {/* ─── Таблица цен ─── */}
      <div className="card">
      {bundle.error && (
        <div className="row" style={{ gap: 10, padding: 12, background: 'rgba(220,38,38,.08)', borderRadius: 8 }}>
          <WarningIcon size={18} weight="bold" style={{ color: 'var(--bad)' }} />
          <div className="muted" style={{ fontSize: 14 }}>{bundle.error}</div>
        </div>
      )}

      {visibleRows.length > 0 && (
        <div className="tbl-scroll">
        <table className="mp-table" style={{ fontSize: 15 }}>
          <thead className="mp-head">
            <tr>
              <th style={{ width: 78 }}></th>
              <th>Артикул</th>
              <th className="right" title="Наша цена в личном кабинете Ozon (до соинвеста)" style={{ width: 130 }}>Цена продавца</th>
              <th className="right" title="Реальная цена для покупателя с учётом СПП/соинвеста — из последней продажи или с витрины" style={{ width: 172 }}>Цена покупателя</th>
              <th className="right" title="Живой расчёт: прибыль на единицу, ₽ и % от цены. Раскройте строку, чтобы увидеть полный расчёт" style={{ width: 85 }}>Маржа</th>
              <th className="right" title="ROI = прибыль / себестоимость, %" style={{ width: 80 }}>ROI</th>
              <th className="right" title="Подсказка по рекламе: ДРР за 7/30 дн и маржа после рекламы" style={{ width: 170 }}>Реклама</th>
              <th style={{ width: 80 }}></th>
            </tr>
          </thead>
          <tbody>
            {sortedRows.map((r) => {
              const kk = ozKnobs[r.product_id] || {};
              // Единый расчёт — те же цифры, что в сортировке/советнике (крутилки поверх).
              const { proc, cur, buyerFromShowcase, showcaseMem, showcase, buyerFromApi, buyerFromMemory, memHist, memAgeDays, buyerPrice, sppReal, cost, apiComm, apiLog,
                apiReturn, drrFromTable, drrFromApi, hasOzonAd, acqPct, commIsDefault, oi, oc, marginPct, marginRub, roi, roiInfo, econRow } = computeOzonRow(r, kk);
              const oldPrice = num(r.price.old_price);
              const isOpen = !!expanded[r.product_id];
              const isArchived = archivedSet.has(r.offer_id.toUpperCase());

              return (
                <Fragment key={r.product_id}>
                  <tr style={isArchived ? { opacity: 0.55 } : undefined}>
                    <td style={{ width: 44, cursor: 'pointer' }} onClick={() => setExpanded(() => (isOpen ? {} : { [r.product_id]: true }))}>
                      <div className="row" style={{ gap: 4 }}>
                        
                        {r.primary_image
                          ? <img src={r.primary_image} alt="" style={{ width: 54, height: 72, borderRadius: 6, objectFit: 'cover' }} />
                          : <div style={{ width: 54, height: 72, borderRadius: 6, background: 'var(--bg-2)' }} />}
                      </div>
                    </td>
                    <td style={{ maxWidth: 280, fontSize: 15, cursor: 'pointer' }} onClick={() => setExpanded(() => (isOpen ? {} : { [r.product_id]: true }))}>
                      <div style={{ fontWeight: 700, fontSize: 17, lineHeight: 1.25, wordBreak: 'break-word' }} title={r.name ?? ''}>{r.offer_id}</div>
                    </td>
                    <td className="right" style={{ whiteSpace: 'nowrap' }}>
                      <b>{fmt(cur)}</b>
                      <div className="muted" style={{ fontSize: 12 }} title="Наша цена в личном кабинете Ozon — до соинвеста площадки">цена ЛК</div>
                      {oldPrice > cur && (
                        <div className="muted" style={{ fontSize: 13, textDecoration: 'line-through' }}>{fmt(oldPrice)}</div>
                      )}
                    </td>
                    <td className="right" style={{ whiteSpace: 'nowrap' }}>
                      <b style={{ color: 'var(--good)' }}>{fmt(buyerPrice)}</b>
                      {buyerFromShowcase > 0
                  ? <div className="muted" style={{ fontSize: 12, color: 'var(--good)' }} title={`Живая цена с витрины ozon.ru (публичная карточка, снята ${showcase?.at ? new Date(showcase.at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : '—'}). Это ровно то, что видит покупатель, с учётом СПП/соинвеста.${showcase?.oldPrice ? ` Зачёркнутая на витрине: ${showcase.oldPrice.toLocaleString('ru-RU')} ₽.` : ''}`}>витрина · СПП {sppReal}%</div>
                  : showcaseMem > 0 && showcase
                    ? <div className="muted" style={{ fontSize: 12 }} title={`СПП ${sppReal}% зафиксирован при последней принудительной проверке витрины (${fmtDateClock(showcase.at)}). Пока витрину не проверили заново, цена покупателя = текущая цена ЛК x (1 - СПП): при смене цены продавца в кабинете цена покупателя пересчитывается пропорционально. Чтобы снять витрину и зафиксировать новый СПП, нажмите «Проверить цены на витрине» и введите пароль.`}>витрина · СПП {sppReal}%</div>
                  : buyerFromApi > 0
                        ? <div className="muted" style={{ fontSize: 12 }} title="Реальная цена покупателя со соинвестом — из отчёта о реализации Ozon (факт продаж), как у Культуры Аналитики">факт · СПП {sppReal}%</div>
                        : buyerFromMemory > 0 && memHist
                          ? <div style={{ fontSize: 12, color: 'var(--warn)' }} title={`Живой скидки сейчас нет — вторая цена восстановлена от цены ЛК по последнему запомненному СПП ${memHist.spp}% (зафиксирован ${memHist.date})`}>≈ по СПП {memHist.spp}% · {memHist.date}</div>
                          : sppReal > 0
                            ? <div className="muted" style={{ fontSize: 13 }} title="Цена покупателя из таблицы «ДРР и цены» / панели">СПП {sppReal}%</div>
                            : memHist && Number.isFinite(memAgeDays)
                              // Память есть, но старая: честно говорим, что не применяем её.
                              // Старый процент на новой цене — не оценка, а выдумка (04.09).
                              ? <div style={{ fontSize: 12, color: 'var(--warn)' }} title={`Последний известный соинвест ${memHist.spp}% зафиксирован ${memHist.date} — ${memAgeDays} дн назад. Старше ${SPP_MEMORY_DAYS} дней память не применяем: процент мог измениться, и цена вышла бы выдуманной. Показана цена ЛК.`}>нет свежих продаж · СПП {memHist.spp}% устарел ({memAgeDays} дн)</div>
                              : <div className="muted" style={{ fontSize: 12 }} title="Ozon не отдаёт реальную скидку площадки/соинвест в API, и запомненного СПП по товару ещё нет — показываем цену ЛК. Задай «СПП по умолч.» в панели или впиши цену в таблицу">= ЛК · нет скидки в API</div>}
                    </td>
                    <td className="right" style={{ whiteSpace: 'nowrap' }}>
                      {marginRub !== null ? (
                        <>
                          <b style={{ fontSize: 17, color: marginPct! >= 30 ? 'var(--good)' : marginPct! >= 15 ? 'var(--warn)' : 'var(--bad)' }}>
                            {Math.round(marginPct ?? 0)}%
                          </b>
                          <div className="muted" style={{ fontSize: 13 }}>{marginRub.toLocaleString('ru-RU')} ₽</div>
                          {commIsDefault && (
                            <div style={{ fontSize: 12, color: 'var(--warn)' }} title={`Комиссия Ozon не пришла из API — взят дефолт ${OZON_DEFAULTS.commission}%. Раскрой строку и проверь/задай комиссию.`}>⚠ ком. {OZON_DEFAULTS.commission}%</div>
                          )}
                        </>
                      ) : <span className="muted" title={cost <= 0 ? 'Нет себестоимости в таблице — маржу не считаем' : undefined}>—</span>}
                    </td>
                    <td className="right" style={{ whiteSpace: 'nowrap' }}>
                      {roi !== null && roiInfo ? (
                        <span style={{ background: ROI_STATUS_COLOR[roiInfo.status].bg, color: ROI_STATUS_COLOR[roiInfo.status].color, padding: '2px 8px', borderRadius: 999, fontWeight: 600, fontSize: 14 }}>
                          {roi}%
                        </span>
                      ) : <span className="muted">—</span>}
                    </td>
                    <td className="right" style={{ whiteSpace: 'normal' }}>
                      {(() => { const adv = adsAdvice({ drr: oi.drr, drr7: econRow?.drr7 ?? null, drr30: econRow?.drr30 ?? null, orders7: econRow?.orders7 ?? 0, marginPct, roi, inStock: inStock(r) }); return adv ? <div title={adv.hint} className={adv.tone === 'muted' ? 'muted' : undefined} style={{ fontSize: 12, marginTop: 3, whiteSpace: 'normal', lineHeight: 1.3, color: adv.tone === 'bad' ? 'var(--bad)' : adv.tone === 'warn' ? 'var(--warn)' : adv.tone === 'good' ? 'var(--good)' : undefined }}>{adv.text}</div> : null; })()}
</td>
                    <td style={{ textAlign: 'center' }}>
                      <div className="row" style={{ gap: 4, justifyContent: 'center' }} onClick={(e) => e.stopPropagation()}>
                        {isArchived ? (
                          <button className="btn btn-sm" title="Вернуть из архива" onClick={() => onUnarchive(r.offer_id)}>
                            <ArrowCounterClockwiseIcon size={12} weight="bold" />
                          </button>
                        ) : (
                          <button className="btn btn-sm" title="В архив" onClick={() => onArchive(r.offer_id)}>
                            <ArchiveIcon size={12} weight="bold" />
                          </button>
                        )}
                        {isOpen ? <CaretUpIcon size={14} weight="bold" /> : <CaretDownIcon size={14} weight="bold" />}
                      </div>
                    </td>
                  </tr>
                  {isOpen && (
                    <tr style={{ background: 'var(--bg-3)' }}>
                      <td colSpan={8} style={{ padding: '12px 16px' }}>
                        {(() => {
                          // Всё уже посчитано на уровне строки (oi/oc/apiComm/apiLog/…) — переиспользуем.
                          const editedOz = Object.keys(kk).length > 0;
                          const shown = (key: keyof OzKnobs, def: number) =>
                            kk[key] !== undefined ? kk[key] : String(Math.round(def));
                          const ozFields: { key: keyof OzKnobs; label: string; val: string; suffix?: string }[] = [
                            { key: 'price', label: 'Цена продажи (ЛК)', val: shown('price', oi.price), suffix: '₽' },
                            { key: 'cost', label: 'Себестоимость', val: shown('cost', oi.cost), suffix: '₽' },
                            { key: 'spp', label: 'СПП / соинвест', val: shown('spp', oi.spp), suffix: '%' },
                            { key: 'drr', label: 'ДРР (реклама)', val: shown('drr', oi.drr), suffix: '%' },
                            { key: 'commission', label: 'Комиссия Ozon', val: shown('commission', oi.commission), suffix: '%' },
                            { key: 'acquiring', label: 'Эквайринг', val: shown('acquiring', acqPct), suffix: '%' },
                            { key: 'buyout', label: '% выкупа', val: shown('buyout', 100 - oi.returnRate), suffix: '%' },
                          ];
                          const obreak = oc ? [
                            { l: 'Себестоимость', v: -oc.breakdown.cost },
                            { l: `Комиссия Ozon (${oi.commission}%) · ${ozScheme}${apiComm ? ' · API' : ''}`, v: -oc.breakdown.commission },
                            { l: `Логистика${econRow?.logisticFact?.value != null ? ' · факт за 30 дн' : apiLog ? ' · тариф API' : ''}`, v: -oc.breakdown.logistic },
                            { l: 'Хранение', v: -oc.breakdown.storage },
                            { l: `Обратная логистика / возвраты${kk.buyout === undefined && econRow?.returnFact?.value != null ? ' · факт за 30 дн' : ` (невыкуп ${oi.returnRate}%)`}`, v: -oc.breakdown.returnCost },
                            { l: `Эквайринг (${acqPct.toFixed(1)}%)`, v: -oc.breakdown.acquiring },
                            { l: `УСН ${oi.usn}%`, v: -oc.breakdown.usn },
                            { l: `НДС ${oi.nds}%`, v: -oc.breakdown.nds },
                            { l: `Реклама ДРР (${oi.drr}%)` + (
                              kk.drr !== undefined ? ' · вручную'
                              : econRow?.drrPick === '7d' ? ` · 7 дн · заказов ${econRow.orders7}`
                              : econRow?.drrPick === '30d' ? ` · 30 дн (за 7 дн заказов ${econRow.orders7} — мало)`
                              : econRow?.drrPick === 'store' ? ' · средний по магазину'
                              : drrFromApi != null ? ' · из API'
                              : drrFromTable != null ? ' · из таблицы' : ''
                            ) + (econRow && (econRow.drr7 != null || econRow.drr30 != null) ? ` · 7д ${econRow.drr7 ?? '—'}% / 30д ${econRow.drr30 ?? '—'}%` : ''), v: -oc.breakdown.ads },
                          ] : [];
                          return (
                            <div className="grid grid-2" style={{ gap: 20, marginBottom: 14, paddingBottom: 12, borderBottom: '1px dashed var(--border)' }} onClick={(e) => e.stopPropagation()}>
                              <div>
                                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                                  {ozFields.map(f => (
                                    <label key={f.key} style={{ fontSize: 14 }}>
                                      <div className="muted" style={{ marginBottom: 3 }}>{f.label}{f.suffix ? `, ${f.suffix}` : ''}</div>
                                      <input className="input" type="number" value={f.val}
                                        onChange={(e) => setOzKnob(r.product_id, f.key, e.target.value)}
                                        style={{ width: '100%', ...(kk[f.key] !== undefined ? { borderColor: 'var(--accent)', fontWeight: 700 } : {}) }} />
                                    </label>
                                  ))}
                                </div>
                                {editedOz && (
                                  <button className="btn btn-sm" style={{ marginTop: 10 }} onClick={() => setOzKnobs(prev => { const n = { ...prev }; delete n[r.product_id]; saveKnobs(n); return n; })}>
                                    Сбросить
                                  </button>
                                )}
                              </div>
                              <div>
                                <div className="card-title" style={{ marginBottom: 8 }}>Расчёт на 1 продажу</div>
                                <div style={{ display: 'grid', gap: 3 }}>
                                  <div className="flex-between" style={{ fontSize: 15, fontWeight: 600 }}>
                                    <span>Цена покупателя (с СПП {oi.spp}%)</span>
                                    <span style={{ color: 'var(--good)' }}>{oc ? fmt(Math.round(oc.buyerPrice)) : '—'}</span>
                                  </div>
                                  {obreak.map((x, i) => (
                                    <div key={i} className="flex-between muted" style={{ fontSize: 14 }}>
                                      <span>{x.l}</span><span style={{ color: 'var(--bad)' }}>{fmt(Math.round(x.v))}</span>
                                    </div>
                                  ))}
                                  <div className="flex-between" style={{ fontSize: 17, fontWeight: 700, borderTop: '1px solid var(--border)', marginTop: 6, paddingTop: 6 }}>
                                    <span>Чистая прибыль</span>
                                    <span style={{ color: oc && oc.profit >= 0 ? 'var(--good)' : 'var(--bad)' }}>
                                      {oc ? fmt(Math.round(oc.profit)) : '—'}
                                      {oc && <span style={{ fontSize: 14, fontWeight: 600 }}> · {oc.margin.toFixed(1)}%{oi.cost > 0 ? ` · ROI ${oc.roi.toFixed(0)}%` : ''}</span>}
                                    </span>
                                  </div>
                                </div>
                              </div>
                            </div>
                          );
                        })()}
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
        </div>
      )}
      </div>
    </div>
  );
}
