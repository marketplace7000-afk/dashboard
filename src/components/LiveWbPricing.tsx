/**
 * Модуль управления ценами WB.
 *
 * Колонки соответствуют тому, что покупатель реально видит на витрине WB:
 *   - Наша (ЛК)            — цена, выставленная в личном кабинете (price)
 *   - Серая · без кошелька — цена после скидки продавца (discountedPrice)
 *   - Зелёная · с кошельком— финальная по WB-кошельку (clubDiscountedPrice)
 *   - Маржа / ROI          — из закупочной Google-таблицы по SKU
 *   - Рекомендация         — вердикт по ROI-таблице (норма/внимание/стоп-докуп/выход)
 *   - Архив                — раздельный scope 'prices-wb'
 */
import { useState, useMemo, useEffect, Fragment } from 'react';
import { useShowcaseCheck } from '../api/showcaseCheck';
import { safeSetItem } from '../utils/safeStorage';
import { onUiStateChange } from '../utils/uiState';
import {
  CaretDownIcon,
  CaretUpIcon,
  ArrowClockwiseIcon,
  SpinnerIcon,
  ImageIcon,
  TagIcon,
  ArchiveIcon,
  ArrowCounterClockwiseIcon,
  EyeIcon,
} from '@phosphor-icons/react';
import { useLiveWbBundle, wbCardIndex } from '../api/useLiveWbCache';
import type { WbPriceRow, WbCard } from '../api/marketplaces';
import { useProcurement } from '../api/useProcurement';
import { calcROI, roiStatus, ROI_STATUS_COLOR } from '../utils/roiLogic';
import { archiveSKU, unarchiveSKU, getArchivedSKUs } from '../utils/procurementLogic';
import { calcWbProfit, WB_DEFAULTS, type WbCalcInput } from '../utils/wbProfit';
import { AiAdvice } from './AiAdvice';
import { PricingGlobalParams, type GParamField } from './PricingGlobalParams';
import { wbBuyerPricesRes, wbCardEconRes, wbBoxTariffsRes, adsBySkuRes, productEconRes, wbShowcaseRes, wbStockRes } from '../api/pricingResources';
import { fmtClock, fmtDateClock } from '../api/sideResource';
import { wbImageUrl } from '../utils/wbBasket';
import { mskDate } from '../utils/mskDate';
import { noteSwallowed } from '../utils/log';
import { adsAdvice } from '../utils/adsAdvice';
import { useEffect as useEffectM } from 'react';
let marginsPushedAt = 0;

// До скольких дней сделка считается «свежей» и её finishedPrice можно показывать
// как текущую цену покупателя. Дальше вернее взять живой клубный ценник из API.
const FRESH_SALE_DAYS = 7;

// Поля глобальной панели WB. Пусто → факт по товару; вписано → умолчание для всех.
const WB_GPARAMS: GParamField[] = [
  { key: 'usn', label: 'УСН', suffix: '%' },
  { key: 'nds', label: 'НДС', suffix: '%' },
  { key: 'acq', label: 'Эквайринг', suffix: '%' },
  { key: 'drr', label: 'ДРР по умолч.', suffix: '%' },
  { key: 'buyout', label: '% выкупа по умолч.', suffix: '%' },
  { key: 'spp', label: 'СПП по умолч.', suffix: '%' },
];

// Живые «крутилки» калькулятора в раскрытой строке. Ключ — nmId. Пусто = дефолт
// (цена ЛК, себест из таблицы, СПП из продаж, остальное — WB_DEFAULTS).
type CalcKnobs = Partial<Pick<WbCalcInput, 'retail' | 'cost' | 'spp' | 'drr' | 'buyout' | 'commission'>>;

const fmt = (n: number) => n.toLocaleString('ru-RU') + ' ₽';

// % выкупа из таблицы: значение хранится долей (0.92) — переводим в проценты; если
// вдруг уже в процентах (>1.5) — берём как есть; пусто/0 → фолбэк 88% (просьба клиента).
const buyoutPct = (v?: number | null): number =>
  (v && v > 0) ? (v > 1.5 ? Math.round(v) : Math.round(v * 100)) : 88;

type Row = WbPriceRow & { card?: WbCard };

type BuyerPrice = { price: number; spp: number; beforeSpp: number; date: string; fromMemory?: boolean };

export function LiveWbPricing() {
  const bundle = useLiveWbBundle();
  const cards = wbCardIndex(bundle);
  const procurement = useProcurement();
  // Цена покупателя с СПП — живьём из продаж WB (finishedPrice), не из таблицы.
  // Module-scope ресурс с форс-обновлением: кнопка «Обновить» теперь реально
  // перезапрашивает цену покупателя, а не отдаёт кэш (жалоба клиента 05.08).
  const buyerRes = wbBuyerPricesRes.use();
  const stockRes = wbStockRes.use();
  const buyerPrices: Record<string, BuyerPrice> = buyerRes.data?.items ?? {};
  // Экономика карточек WB по nmId (комиссия категории + объём в литрах). Сервер
  // проходит ВСЕ карточки, поэтому матч по nmId работает даже когда карточка не
  // подтянулась к ценовой строке в браузере (каталог >100 с дублями).
  // ДРР по каждой карточке ИЗ API рекламы WB (разбивка nm[] в статистике
  // кампаний). Раньше калькулятор брал ДРР только из колонки Google-таблицы:
  // для Ozon источник переключили на Performance API ещё 29.07, а у WB
  // поартикульные данные существовали лишь внутри агента-алертов и наружу не
  // отдавались. Теперь берём их, таблица осталась запасным вариантом.
  const adsRes = adsBySkuRes.use();
  const drrByNm = useMemo(() => {
    const m: Record<string, number> = {};
    for (const r of (adsRes.data?.items ?? [])) {
      if (r.platform !== 'wb' || !r.id || r.drr == null) continue;
      m[String(r.id)] = Math.round(r.drr * 10) / 10;
    }
    return m;
  }, [adsRes.data]);

  const econRes = wbCardEconRes.use();
  const wbEcon = econRes.data?.items ?? {};

  // Живая витрина WB. Единственный источник, где есть СПП площадки: в Seller API
  // её нет вообще, и любая «цена покупателя» не с витрины — уже не сегодняшняя.
  const showcaseRes = wbShowcaseRes.use();
  const wbShowcase = showcaseRes.data?.items ?? {};
  // Когда витрина реально снималась в последний раз (fetchedAt перезаписывает и пустая серверная попытка) и средний СПП магазина по снимку.
  const showcaseLastAt = useMemo(() => { let m = 0; for (const it of Object.values(wbShowcase) as any[]) if (Number(it?.at) > m) m = Number(it.at); return m || null; }, [wbShowcase]);
  const showcaseAvgSppFrac = useMemo(() => { const xs = (Object.values(wbShowcase) as any[]).map(it => (it?.greyPrice > 0 && it?.price > 0 && it.price < it.greyPrice) ? (it.greyPrice - it.price) / it.greyPrice : 0).filter(x => x > 0); return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0; }, [wbShowcase]);
  const SHOWCASE_FRESH_MS = 6 * 60 * 60_000;   // старше — не витрина, а история

  // Экономика товара по артикулу: себестоимость, ДРР, комиссия и логистика по
  // выбранной схеме. Главный источник — он собран по артикулу и не зависит от
  // того, попал ли товар в лист «Ozon_wb» (см. api/_lib/productEcon.ts).
  const pEconRes = productEconRes.use();
  const pEcon = pEconRes.data?.wb ?? {};
  // Схема работы подписывается везде, где видна комиссия: клиент 03.09 «не увидел
  // комиссий по FBS» — цифры были по FBS, но ни одна подпись этого не говорила.
  const wbScheme = (pEconRes.data?.fulfilment.wb ?? 'fbs').toUpperCase();
  // Тарифы логистики/хранения WB (tariffs/box) — для расчёта из габаритов карточки.
  const tariffRes = wbBoxTariffsRes.use();
  const boxTariff = tariffRes.data?.deliveryBase ? tariffRes.data : null;
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});
  // Крутилки калькулятора: храним СЫРУЮ строку из инпута (в т.ч. пустую), чтобы
  // поле можно было свободно стереть и вписать своё. В расчёт идёт распарсенное
  // число, пустое/битое → откат к значению по умолчанию.
  const KNOBS_LS = 'prices-wb:knobs';
  const loadKnobs = (): Record<number, Record<string, string>> => { try { return JSON.parse(localStorage.getItem(KNOBS_LS) || '{}'); } catch { return {}; } };
  const saveKnobs = (n: Record<number, Record<string, string>>) => { try { safeSetItem(KNOBS_LS, JSON.stringify(n)); } catch (e) { noteSwallowed('ui-prefs', 'сценарий не сохранён', e, 60 * 60_000); } };
  const [knobs, setKnobs] = useState<Record<number, Record<string, string>>>(loadKnobs);
  const setKnob = (nmId: number, k: keyof CalcKnobs, v: string) =>
    setKnobs(prev => { const n = { ...prev, [nmId]: { ...prev[nmId], [k]: v } }; saveKnobs(n); return n; });
  const [archiveTick, setArchiveTick] = useState(0);
  const [search, setSearch] = useState('');
  const searchQ = search.trim().toLowerCase();
  const [showArchive, setShowArchive] = useState(false);
  const [sortBy, setSortBy] = useState<'price' | 'margin' | 'roi' | 'name'>('price');
  // Фильтр «только в продаже»: остаток WB > 0 или были продажи за 7 дней.
  // Включён по умолчанию — мёртвые SKU не мешаются (просьба клиента 09.07).
  const [inStockOnly, setInStockOnly] = useState<boolean>(() => {
    try { return localStorage.getItem('prices-wb:inStockOnly') !== '0'; } catch { return true; }
  });
  const toggleInStock = () => setInStockOnly(v => {
    try { localStorage.setItem('prices-wb:inStockOnly', v ? '0' : '1'); } catch (e) { noteSwallowed('ui-prefs', 'настройка интерфейса не сохранена', e, 60 * 60_000); }
    return !v;
  });

  // Глобальные параметры расчёта (панель сверху): draft — что в полях, applied — что
  // реально применено. Пусто → берётся факт по товару. Крутилка строки главнее.
  const GP_LS = 'prices-wb:globalParams';
  const loadGP = (): Record<string, string> => { try { return JSON.parse(localStorage.getItem(GP_LS) || '{}'); } catch { return {}; } };
  const [gpDraft, setGpDraft] = useState<Record<string, string>>(loadGP);
  const [gpApplied, setGpApplied] = useState<Record<string, string>>(loadGP);
  const gpChange = (k: string, v: string) => setGpDraft(p => ({ ...p, [k]: v }));
  const gpApply = () => { setGpApplied(gpDraft); try { safeSetItem(GP_LS, JSON.stringify(gpDraft)); } catch (e) { noteSwallowed('ui-prefs', 'настройка интерфейса не сохранена', e, 60 * 60_000); } };
  const gpReset = () => { setGpDraft({}); setGpApplied({}); try { safeSetItem(GP_LS, '{}'); } catch (e) { noteSwallowed('ui-prefs', 'настройка интерфейса не сохранена', e, 60 * 60_000); } };
  // Значение глоб. параметра (или fallback, если поле пустое/битое).
  const gp = (k: string, fb: number): number => {
    const s = gpApplied[k];
    if (s == null || s.trim() === '') return fb;
    const n = parseFloat(s.replace(',', '.'));
    return isNaN(n) ? fb : n;
  };

  // Кнопка «Проверить цены на витрине»: когда Routine снял витрину — подтянуть свежие цены покупателя.
  const sc = useShowcaseCheck('wb', () => { void showcaseRes.refresh(true); void buyerRes.refresh(true); });
  const archivedSet = useMemo(() => new Set(getArchivedSKUs('prices-wb')), [archiveTick]);
  // Общая память: пришли изменения с сервера (другой пользователь/вкладка) — перечитать архив, параметры, сценарии.
  useEffect(() => onUiStateChange(() => { setArchiveTick(t => t + 1); const gp = loadGP(); setGpApplied(gp); setGpDraft(gp); setKnobs(loadKnobs()); }), []);

  const procurementBySku = useMemo(() => {
    const m = new Map<string, typeof procurement.items[number]>();
    for (const p of procurement.items) m.set(p.sku.toUpperCase(), p);
    return m;
  }, [procurement.items]);

  // Индекс «родительский артикул → размерный вариант». Одежда в таблице закупок
  // ведётся по размерам (W-ПАЛАЦБЛЕСК-СИН-M/-L/…), а карточка WB — родительская
  // (W-ПАЛАЦБЛЕСК-СИН). Матчим родителя к любому размеру с себестоимостью (правка 23.07).
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

  const allRows = useMemo<Row[]>(() => {
    return bundle.prices.map((p) => ({ ...p, card: cards.get(p.nmId) }));
  }, [bundle.prices, bundle.cards]);

  // ЕДИНЫЙ расчёт строки WB — источник истины для таблицы, сортировки и ИИ-советника
  // (чтобы они не расходились в цифрах). `k` — крутилки строки; для сортировки/советника
  // передаём {} (дефолтные значения без ручных правок).
  const computeWbRow = (r: Row, k: Record<string, string>) => {
    const vc = (r.vendorCode || '').toUpperCase();
    const proc = procurementBySku.get(vc) ?? procByParent.get(vc); // точный → размерный вариант
    const mainSize = r.sizes?.[0];
    const salesBuyer = buyerPrices[String(r.nmId)];
    // Серая цена (после скидки продавца, до СПП) — «Цена ЛК» и база расчёта.
    // Приоритет — живой ценовой API (актуальнее), затем серая из последней продажи, затем таблица.
    const seraya = Math.round(
      (mainSize?.discountedPrice && mainSize.discountedPrice > 0) ? mainSize.discountedPrice
      : (salesBuyer?.beforeSpp && salesBuyer.beforeSpp > 0) ? salesBuyer.beforeSpp
      : (proc?.lkPriceWb ?? 0)
    );
    const lkPrice = seraya;
    const lkFromApi = !!(mainSize?.discountedPrice || salesBuyer?.beforeSpp);
    // ── Цена покупателя: приоритет по СВЕЖЕСТИ, а не по типу источника ────────
    // Было: цена из «памяти» последних продаж (она живёт полгода) стояла ВЫШЕ
    // живого clubDiscountedPrice из ценового API. Товар, не продававшийся месяцами,
    // показывал цену той давней сделки как текущую — отсюда «Ultra4 СПП 17 842,
    // а по факту 2 692» (телемост 11.08).
    // Стало: свежая сделка → живой клубный ценник → давняя сделка (с датой в
    // подписи) → таблица → цена ЛК.
    const salesBuyerPrice = salesBuyer && salesBuyer.price > 0 ? salesBuyer.price : 0;
    const saleAgeDays = salesBuyer?.date
      ? Math.round((Date.parse(mskDate(0)) - Date.parse(salesBuyer.date)) / 86_400_000)
      : Infinity;
    const clubPrice = mainSize?.clubDiscountedPrice && mainSize.clubDiscountedPrice > 0
      ? mainSize.clubDiscountedPrice : 0;
    const tablePrice = proc?.buyerPriceWb != null && proc.buyerPriceWb > 0 ? proc.buyerPriceWb : 0;

    const showcase = wbShowcase[String(r.nmId)];
    const showcaseFresh = !!showcase && showcase.price > 0 && Date.now() - showcase.at <= SHOWCASE_FRESH_MS;
    // Память витрины (17.09.2026, просьба клиента): снимок старше 6 ч, но витрину сейчас снять нельзя
    // (компьютер выключен) — берём СПП% из последнего снимка и применяем к ТЕКУЩЕЙ серой цене.
    // Раньше в этом случае показывалась клубная цена из API ≈ цене продавца, и СПП «исчезал».
    const showcaseMemPrice = (!showcaseFresh && showcase && showcase.price > 0)
      ? ((showcase.greyPrice && showcase.greyPrice > 0 && seraya > 0) ? Math.max(0, Math.round(seraya * (1 - (showcase.greyPrice - showcase.price) / showcase.greyPrice))) : showcase.price)
      : 0;

    let buyerPrice = 0;
    let buyerSource: 'showcase' | 'showcase-mem' | 'sale' | 'club' | 'old-sale' | 'gp' | 'store-avg' | 'table' | 'lk' | 'none' = 'none';
    if (showcaseFresh) {
      // Витрина главнее всего: это ровно та цифра, которую клиент видит на сайте
      // и с которой сравнивает кабинет (04.09). Всё ниже — запасные пути.
      // Если ЛК-цена с момента снятия витрины изменилась — не держим замороженную
      // абсолютную цену, а пересчитываем по СПП%, запомненному на момент снятия.
      const capturedGrey = showcase.greyPrice && showcase.greyPrice > 0 ? showcase.greyPrice : null;
      if (capturedGrey && seraya > 0 && Math.abs(seraya - capturedGrey) >= 1) {
        const rememberedSppFrac = (capturedGrey - showcase.price) / capturedGrey;
        buyerPrice = Math.max(0, Math.round(seraya * (1 - rememberedSppFrac)));
      } else {
        buyerPrice = showcase.price;
      }
      buyerSource = 'showcase';
    } else if (showcaseMemPrice > 0) {
      buyerPrice = showcaseMemPrice; buyerSource = 'showcase-mem'; // витрина устарела — СПП% из последнего снимка
    } else if (salesBuyerPrice > 0 && !salesBuyer?.fromMemory && saleAgeDays <= FRESH_SALE_DAYS) {
      buyerPrice = salesBuyerPrice; buyerSource = 'sale';       // реально уплаченные деньги, свежие
    } else if (salesBuyerPrice > 0) {
      buyerPrice = salesBuyerPrice; buyerSource = 'old-sale';   // давняя сделка — подписываем датой
    } else if (gp('spp', 0) > 0 && seraya > 0) {
      buyerPrice = Math.max(0, Math.round(seraya * (1 - gp('spp', 0) / 100))); buyerSource = 'gp'; // «СПП по умолч.» из панели
    } else if (showcaseAvgSppFrac > 0 && seraya > 0) {
      buyerPrice = Math.max(0, Math.round(seraya * (1 - showcaseAvgSppFrac))); buyerSource = 'store-avg'; // средний СПП магазина по снимку витрины
    } else if (clubPrice > 0) {
      buyerPrice = clubPrice; buyerSource = 'club';             // живой ценник WB (клубная скидка)
    } else if (tablePrice > 0) {
      buyerPrice = tablePrice; buyerSource = 'table';
    } else if (mainSize?.discountedPrice && mainSize.discountedPrice > 0) {
      buyerPrice = mainSize.discountedPrice; buyerSource = 'lk';
    }
    const buyerFromApiOrSales = buyerSource === 'showcase' || buyerSource === 'showcase-mem' || buyerSource === 'sale' || buyerSource === 'club' || buyerSource === 'old-sale';
    // СПП берём из сделки ТОЛЬКО если цену дала эта же сделка. Иначе выводим из
    // разницы с серой ценой — иначе рядом с клубным ценником стоял бы процент
    // от совсем другой (старой) цены.
    const sppPct = (buyerSource === 'sale' && salesBuyer?.spp && salesBuyer.spp > 0)
      ? salesBuyer.spp
      : (seraya > 0 && buyerPrice > 0 && buyerPrice < seraya) ? Math.round((seraya - buyerPrice) / seraya * 100)
      : 0;
    // Себестоимость: сперва наш справочник по артикулу, и только потом таблица.
    // Раньше было наоборот — точнее, таблица была единственным путём, и товар,
    // которого ещё нет в листе «Ozon_wb», оставался без себестоимости навсегда.
    const econRow = pEcon[vc];
    const cost = econRow?.cost.value ?? proc?.purchasePrice ?? 0;
    const costOrigin = econRow?.cost.value != null ? econRow.cost
      : (proc?.purchasePrice ? { value: proc.purchasePrice, origin: 'reference' as const, note: 'из таблицы' } : econRow?.cost);
    const kn = (key: keyof CalcKnobs): number | undefined => {
      const s = k[key];
      if (s === undefined || s.trim() === '') return undefined;
      const n = parseFloat(s.replace(',', '.'));
      return isNaN(n) ? undefined : n;
    };
    const econ = wbEcon[String(r.nmId)];
    // Комиссия из карточного набора — запасной путь; основной идёт через
    // резолвер (econRow). null тут значит «WB не дал ставку для этой схемы».
    const catComm = econ?.commission != null && econ.commission > 0 ? econ.commission : undefined;
    const volL = econ?.volumeL || 0;
    const volExtra = Math.max(0, volL - 1);
    const logFromApi = boxTariff && volL > 0 ? boxTariff.deliveryBase + boxTariff.deliveryLiter * volExtra : undefined;
    const storFromApi = boxTariff && volL > 0 ? (boxTariff.storageBase + boxTariff.storageLiter * volExtra) * 30 : undefined;
    const commIsDefault = econRow?.commissionPct.value == null && catComm == null && k.commission == null;
    // Порядок приоритета: крутилка строки → факт по товару (таблица/API) → глобальный
    // параметр из панели (gp) → жёсткий дефолт.
    const inp = {
      retail: kn('retail') ?? seraya,
      cost: kn('cost') ?? cost,
      spp: kn('spp') ?? (sppPct > 0 ? sppPct : gp('spp', 0)),
      // ДРР: крутилка → факт по товару (в т.ч. честный 0, если рекламы не было) →
      // старый путь через таблицу рекламы → колонка таблицы → общий параметр.
      // Важно: `econRow.drr.value === 0` это НЕ «нет данных», а «рекламы не было»,
      // поэтому проверяем на null, а не на ложность — иначе ноль снова
      // подменялся бы дефолтом в 7%, из-за которого прибыль занижена у всех.
      drr: kn('drr') ?? econRow?.drr.value ?? drrByNm[String(r.nmId)]
        ?? (proc?.drrWb != null ? proc.drrWb : gp('drr', WB_DEFAULTS.drr)),
      // % выкупа — ФАКТ из таблицы («Чистый % выкупа», доля 0..1) → глоб. параметр → 88%.
      buyout: kn('buyout') ?? econRow?.buyoutFact?.value ?? (proc?.buyoutWB && proc.buyoutWB > 0 ? buyoutPct(proc.buyoutWB) : gp('buyout', 88)),
      // Комиссия по ВЫБРАННОЙ схеме работы (FBO/FBS) — она приходит из резолвера.
      // Схема задаётся в настройках: у FBO и FBS ставки разные, и показывать
      // чужую значит завышать прибыль по всему каталогу (правка клиента 29.08).
      commission: kn('commission') ?? econRow?.commissionPct.value ?? catComm ?? WB_DEFAULTS.commission,
      acquiring: gp('acq', WB_DEFAULTS.acquiring),
      logistic: econRow?.logisticFact?.value ?? econRow?.logisticRub.value ?? logFromApi ?? WB_DEFAULTS.logistic,
      storage: econRow?.storageRub.value ?? storFromApi ?? WB_DEFAULTS.storage,
      // Возврат при невыкупе масштабируется по объёму (46+14×л) — как в эталоне клиента.
      returnBase: logFromApi ?? WB_DEFAULTS.returnBase,
      // Факт обратной логистики из финотчёта (16.09.2026); ручной % выкупа возвращает формулу по тарифу.
      returnCostPerSale: kn('buyout') == null ? (econRow?.returnFact?.value ?? undefined) : undefined,
      usn: gp('usn', WB_DEFAULTS.usn),
      nds: gp('nds', WB_DEFAULTS.nds),
    };
    // Без себестоимости расчёт неполон → маржу не выдаём за достоверную.
    const calc = cost > 0 ? calcWbProfit(inp) : null;
    const marginPct = calc ? Math.round(calc.margin) : null;
    const marginRub = calc ? Math.round(calc.profit) : null;
    const roi = calc ? Math.round(calc.roi) : null;
    const roiInfo = roi !== null && cost > 0 ? roiStatus(roi, cost) : null;
    return { proc, mainSize, salesBuyer, seraya, lkPrice, lkFromApi, buyerPrice, buyerFromApiOrSales, buyerSource, saleAgeDays, sppPct,
      cost, econ, catComm, volL, logFromApi, storFromApi, commIsDefault, inp, calc, marginPct, marginRub, roi, roiInfo, showcase, econRow };
  };

  const archivedKey = (r: Row) => (r.vendorCode || '').toUpperCase();
  const archivedCount = allRows.filter(r => archivedSet.has(archivedKey(r))).length;
  // «В продаже» = товар активен на WB. ГЛАВНЫЙ сигнал — недавняя продажа из WB API
  // (finishedPrice, /api/wb-buyer-prices — то, что и так грузим). Доп. сигналы из
  // таблицы: остаток/продажи/% выкупа WB. Раньше смотрели ТОЛЬКО на колонки листа
  // «Ozon_wb», которые у части товаров (POLFAR/POL-3M) пустые → они прятались.
  // Правка 15.09: раньше «в продаже» смотрели ТОЛЬКО на признаки из таблицы снабжения и на историю продаж —
  // оба дырявые, из-за чего товар без недавних продаж пропадал из вида, даже реально лежа на складе.
  // Теперь главный источник — живые остатки WB (/api/wb-stock, statistics-api): есть остаток сейчас —
  // значит «в продаже», независимо от продаж и таблицы. Старая эвристика — только фолбэк,
  // пока живые остатки ещё не загрузились или API недоступен.
  const isInStock = (r: Row) => {
    const nm = String(r.nmId);
    // Витрина WB (реальная публичная страница, снята браузером) — самое сильное
    // доказательство «в продаже прямо сейчас», сильнее отчёта об остатках.
    const showcase = wbShowcase[nm];
    if (showcase && showcase.price > 0 && Date.now() - showcase.at <= SHOWCASE_FRESH_MS) return true;
    if (stockRes.data && !stockRes.error) {
      const val = stockRes.data.byNm[nm];
      // warehouse_remains — отчёт об остатках НА СКЛАДАХ WB (FBO-логика). У нас
      // FBS: часть товаров хранится у продавца, и WB может вовсе не включить их
      // в этот отчёт (нет строки для nmId). Отсутствие строки — это «неизвестно»,
      // а не «нет в наличии»: даём шанс пройти по фолбэк-сигналам ниже. Явный 0
      // в отчёте по-прежнему считаем «нет в наличии».
      // byNm = FBO + FBS (17.09.2026). Если FBS-часть не получена — явный 0 в FBO-отчёте не приговор.
      if (val !== undefined) { if ((val || 0) > 0) return true; if (!stockRes.data.fbsError) return false; }
    }
    if (buyerPrices[nm]) return true; // была продажа на WB (из API)
    const proc = procurementBySku.get(archivedKey(r));
    if (!proc) return false;
    return (proc.stockWB || 0) > 0 || (proc.sales7WB || 0) > 0 || (proc.sales30WB || 0) > 0 || (proc.buyoutWB || 0) > 0;
  };
  const inStockCount = allRows.filter(r => !archivedSet.has(archivedKey(r)) && isInStock(r)).length;
  const filteredRows = allRows.filter(r => {
    if (searchQ && !(String(r.vendorCode ?? '').toLowerCase().includes(searchQ) || String(r.nmId).includes(searchQ))) return false;
    if (showArchive) return archivedSet.has(archivedKey(r));
    if (archivedSet.has(archivedKey(r))) return false;
    return inStockOnly ? isInStock(r) : true;
  });
  // Сортировка — по ЖИВОМУ расчёту (те же цифры, что в таблице), не по таблице.
  const sortKey = (r: Row) => {
    const m = computeWbRow(r, {});
    return { price: m.buyerPrice, margin: m.marginPct ?? -Infinity, roi: m.roi ?? -Infinity, name: (r.card?.title || r.vendorCode || '').toLowerCase() };
  };
  const rows = [...filteredRows].sort((a, b) => {
    const ka = sortKey(a), kb = sortKey(b);
    if (sortBy === 'name') return ka.name.localeCompare(kb.name);
    return (kb[sortBy] as number) - (ka[sortBy] as number);
  });

  if (bundle.loading) {
    return (
      <div className="card" style={{ textAlign: 'center', padding: 40 }}>
        <SpinnerIcon size={24} weight="bold" className="spin" />
        <div className="muted" style={{ marginTop: 8 }}>Загрузка цен WB…</div>
      </div>
    );
  }

  if (bundle.error) {
    return (
      <div className="card" style={{ background: 'var(--bg-danger, #fff0f0)', padding: 20 }}>
        <div style={{ fontWeight: 600, color: 'var(--danger, #d00)' }}>Ошибка загрузки данных</div>
        <div className="muted" style={{ fontSize: 14, marginTop: 6 }}>{bundle.error}</div>
        <button className="btn btn-sm" style={{ marginTop: 10 }} onClick={bundle.refresh}>Повторить</button>
      </div>
    );
  }

  if (!allRows.length) {
    return (
      <div className="card">
        <div className="muted" style={{ textAlign: 'center', padding: 20 }}>Нет данных о ценах</div>
      </div>
    );
  }

  // Аккордеон: раскрыта максимум одна карточка (просьба клиента 20.07).
  const toggle = (nmId: number) => setExpanded((prev) => (prev[nmId] ? {} : { [nmId]: true }));
  const onArchive = (vendorCode: string) => {
    // См. LiveOzonPricing: при переполнении хранилища запись падала молча.
    if (!archiveSKU(vendorCode.toUpperCase(), 'prices-wb')) {
      alert('Не удалось сохранить: в браузере кончилось место. Обновите страницу и попробуйте снова.');
      return;
    }
    setArchiveTick(t => t + 1);
  };
  const onUnarchive = (vendorCode: string) => { unarchiveSKU(vendorCode.toUpperCase(), 'prices-wb'); setArchiveTick(t => t + 1); };

  // Средний СПП по видимым товарам (реальная скидка: цена покупателя ниже серой) и ДРР магазина за 7 дн из product-econ.
  const sppVals = rows.map(r => computeWbRow(r, {}).sppPct).filter(v => v > 0);
  const avgSpp = sppVals.length ? Math.round(sppVals.reduce((a, b) => a + b, 0) / sppVals.length) : 0;
  const storeDrr7 = pEconRes.data?.storeDrr?.wb?.d7 ?? null;
  // Общая статистика
  const avgDiscount = rows.length
    ? Math.round(rows.reduce((s, r) => s + r.discount, 0) / rows.length)
    : 0;
  const totalSizes = rows.reduce((s, r) => s + (r.sizes?.length ?? 0), 0);
  const editableCount = rows.filter((r) => r.editableSizePrice).length;

  // Снимок маржи для «Управления рекламой» (17.09.2026): те же цифры, что в таблице,
  // уходят в общую память UI (prices-wb:margins); сервер берёт их для «маржи после рекламы».
  useEffectM(() => {
    if (!allRows.length || Date.now() - marginsPushedAt < 60_000) return;
    const items: Record<string, { marginPct: number | null; marginRub: number | null }> = {};
    for (const r of allRows) {
      const m = computeWbRow(r, {});
      const k = String(r.vendorCode ?? '').trim().toUpperCase();
      if (k) items[k] = { marginPct: m.marginPct ?? null, marginRub: m.marginRub ?? null };
    }
    marginsPushedAt = Date.now();
    safeSetItem('prices-wb:margins', JSON.stringify({ at: marginsPushedAt, items }));
  });
  const adviceContext = {
    показано_SKU: rows.length,
    Ø_скидка_пр: avgDiscount,
    строки: rows.slice(0, 20).map((r) => {
      // Те же цифры, что видит клиент в таблице (серая как ЛК, живая маржа), а не ценник-приманка.
      const m = computeWbRow(r, {});
      return { sku: r.vendorCode, nm: r.nmId, цена_ЛК_серая: Math.round(m.seraya), цена_покупателя: Math.round(m.buyerPrice),
        маржа_пр: m.marginPct, прибыль_руб: m.marginRub, ROI_пр: m.roi, СПП_пр: m.sppPct, скидка_пр: r.discount };
    }),
  };

  return (
    <div className="grid" style={{ gap: 16 }}>
      <AiAdvice module="prices" context={adviceContext} disabled={rows.length === 0} />
      <PricingGlobalParams fields={WB_GPARAMS} draft={gpDraft} onChange={gpChange} onApply={gpApply} onReset={gpReset} color="#cb11ab" />
      {/* ─── Сводка ─── */}
      <div className="card">
        <div className="flex-between" style={{ marginBottom: 14 }}>
          <h2 style={{ margin: 0, display: 'inline-flex', alignItems: 'center', gap: 10, whiteSpace: 'nowrap' }}>
            <span className="mp-tab-dot" style={{ background: '#cb11ab' }} />
            Управление ценами WB
          </h2>
          <div className="row gap-8" style={{ flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            {!showArchive && (
              <button
                className="btn btn-sm"
                onClick={toggleInStock}
                title="Показывать только товары с остатком (склады WB + склады продавца FBS) или продажами за 7 дней"
                style={inStockOnly ? { background: 'var(--accent)', color: '#fff', borderColor: 'var(--accent)' } : undefined}
              >
                <TagIcon size={13} weight="bold" /> В продаже ({inStockCount})
              </button>
            )}
            <button
              className="btn btn-sm"
              onClick={() => setShowArchive(s => !s)}
              title={showArchive ? 'Показать активные' : 'Показать архив'}
            >
              {showArchive ? <EyeIcon size={13} weight="bold" /> : <ArchiveIcon size={13} weight="bold" />}
              {showArchive ? 'Активные' : `Архив (${archivedCount})`}
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
                {sc.pending ? <SpinnerIcon size={14} weight="bold" className="spin" /> : <ArrowClockwiseIcon size={14} weight="bold" />}
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
            <div className="v">{rows.length}</div>
          </div>
          <div className="kpi" title="Средний СПП по всем видимым товарам на момент просмотра: реальная скидка площадки (цена покупателя ниже цены продавца)">
            <div className="card-title">Средний СПП</div>
            <div className="v">{avgSpp}%</div>
          </div>
          <div className="kpi" title="Средний ДРР магазина WB за последние 7 дней: расходы на рекламу / выручка по всем кампаниям (из рекламного API)">
            <div className="card-title">ДРР магазина · 7 дн</div>
            <div className="v">{storeDrr7 == null ? '—' : `${storeDrr7}%`}</div>
          </div>
        </div>
      </div>

      {/* ─── Таблица цен ─── */}
      <div className="card">
        <div className="tbl-scroll">
        <table className="mp-table" style={{ fontSize: 15 }}>
          <thead className="mp-head">
            <tr>
              <th style={{ width: 78 }}></th>
              <th>Артикул</th>
              <th className="right" title="Цена продавца в ЛК после скидки продавца (до СПП)" style={{ width: 130 }}>Цена продавца</th>
              <th className="right" title="Реальная цена для покупателя с учётом СПП/соинвеста — из последней продажи или с витрины" style={{ width: 172 }}>Цена покупателя</th>
              <th className="right" title="Живой расчёт: прибыль на единицу, ₽ и % от цены. Раскройте строку, чтобы увидеть полный расчёт" style={{ width: 85 }}>Маржа</th>
              <th className="right" title="ROI = прибыль / себестоимость, %" style={{ width: 80 }}>ROI</th>
              <th className="right" title="Подсказка по рекламе: ДРР за 7/30 дн и маржа после рекламы" style={{ width: 170 }}>Реклама</th>
              <th style={{ width: 80 }}></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              // Фото: сначала то, что отдала карточка, иначе считаем адрес сами по
              // nmId. Карточка приходит не для всех строк (каталог WB отдаёт >100
              // с дублями), и тогда в модуле «Цены» оставались пустые квадраты —
              // жалоба клиента 11.08 и повторно 14.08. В «Аналитике» этот расчёт
              // уже применялся, в «Ценах» — нет.
              const photo = r.card?.photos?.[0]?.c246x328 || r.card?.photos?.[0]?.big
                || (r.nmId ? wbImageUrl(r.nmId) : '');
              const isOpen = expanded[r.nmId] ?? false;
              const isArchived = archivedSet.has(archivedKey(r));
              const k = knobs[r.nmId] || {};
              // Единый расчёт — те же цифры, что в сортировке/советнике (крутилки поверх).
              const { proc, salesBuyer, lkPrice, lkFromApi, buyerPrice, buyerSource, saleAgeDays, sppPct,
                cost, catComm, volL, logFromApi, storFromApi, commIsDefault, inp, calc, showcase,
                marginPct, marginRub, roi, roiInfo, econRow } = computeWbRow(r, k);

              return (
                <Fragment key={r.nmId}>
                  <tr style={{ cursor: 'pointer', ...(isArchived ? { opacity: 0.55 } : {}) }} onClick={() => toggle(r.nmId)}>
                    <td>
                      {photo ? (
                        <img src={photo} alt="" style={{ width: 54, height: 72, objectFit: 'cover', borderRadius: 6 }} />
                      ) : (
                        <div style={{ width: 36, height: 48, borderRadius: 6, background: 'var(--bg-subtle, #f4f4f5)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                          <ImageIcon size={16} weight="light" style={{ color: 'var(--muted)' }} />
                        </div>
                      )}
                    </td>
                    <td>
                      <div style={{ fontWeight: 700, fontSize: 17, lineHeight: 1.25, wordBreak: 'break-word' }} title={`${r.card?.title || r.card?.subjectName || ''} · nm${r.nmId}${r.sizes.length > 1 ? ` · ${r.sizes.length} размеров` : ''}`}>{r.vendorCode}</div>
                    </td>
                    <td className="right" style={{ whiteSpace: 'nowrap' }}>
                      <b>{lkPrice > 0 ? fmt(lkPrice) : '—'}</b>
                      {lkFromApi && <div className="muted" style={{ fontSize: 12 }} title="Серая цена — после скидки продавца (без «приманочного» зачёркнутого ценника). Живьём из WB API/продаж">серая</div>}
                    </td>
                    <td className="right" style={{ whiteSpace: 'nowrap' }}>
                      <b style={{ color: 'var(--good)' }}>{buyerPrice > 0 ? fmt(buyerPrice) : '—'}</b>
                      {/* Подпись называет ИМЕННО тот источник, что дал цену. Раньше
                          любая цена из продаж подписывалась «последняя», и давняя
                          сделка выглядела так же убедительно, как сегодняшняя. */}
                      {buyerSource === 'showcase' && (
                        <div className="muted" style={{ fontSize: 12, color: 'var(--good)' }} title={`Живая цена с витрины wildberries.ru (публичная карточка, снята ${showcase?.at ? new Date(showcase.at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : '—'}). Это ровно то, что видит покупатель, с учётом СПП площадки.${showcase?.oldPrice ? ` Зачёркнутая на витрине: ${showcase.oldPrice.toLocaleString('ru-RU')} ₽.` : ''}`}>витрина · СПП {sppPct}%</div>
                      )}
                      {buyerSource === 'sale' && (
                        <div className="muted" style={{ fontSize: 12 }} title={`Реальная цена покупателя из продажи ${salesBuyer?.date} (СПП ${sppPct}%) — свежее ${FRESH_SALE_DAYS} дней`}>live · СПП {sppPct}%</div>
                      )}
                      {buyerSource === 'showcase-mem' && (
                        <div className="muted" style={{ fontSize: 12 }} title={`СПП ${sppPct}% зафиксирован при последней принудительной проверке витрины (${fmtDateClock(wbShowcase[String(r.nmId)]?.at ?? null)}). Пока витрину не проверили заново, цена покупателя = текущая цена ЛК x (1 - СПП): при смене цены продавца в кабинете цена покупателя пересчитывается пропорционально. Чтобы снять витрину и зафиксировать новый СПП, нажмите «Проверить цены на витрине» и введите пароль.`}>витрина · СПП {sppPct}%</div>
                      )}
                      {buyerSource === 'gp' && (
                        <div className="muted" style={{ fontSize: 12, color: 'var(--warn)' }} title="Витрина по этому товару ещё не снималась и свежих продаж со скидкой нет — цена покупателя оценена по «СПП по умолч.» из глобальных параметров">оценка · СПП по умолч. {sppPct}%</div>
                      )}
                      {buyerSource === 'store-avg' && (
                        <div className="muted" style={{ fontSize: 12, color: 'var(--warn)', whiteSpace: 'normal', lineHeight: 1.25 }} title="Витрина по этому товару ещё не снималась (на странице магазина WB видны только первые ~36 карточек) и свежих продаж со скидкой нет — цена покупателя оценена по среднему СПП магазина из последнего снимка витрины">оценка · средний СПП магазина {sppPct}%</div>
                      )}
                      {buyerSource === 'club' && (
                        <div className="muted" style={{ fontSize: 12 }} title="Живая цена из ценового API WB (clubDiscountedPrice — с клубной скидкой). Свежих продаж нет. Полный СПП с кошельком WB в API не отдаёт, поэтому на витрине может быть чуть ниже.">клубная цена · API</div>
                      )}
                      {buyerSource === 'old-sale' && (
                        <div className="muted" style={{ fontSize: 12, color: 'var(--warn)' }} title={`Свежих продаж нет и клубной цены в API тоже. Показана цена последней сделки от ${salesBuyer?.date} — она может быть неактуальной.`}>
                          продажа {salesBuyer?.date ? salesBuyer.date.slice(5).split('-').reverse().join('.') : '—'}
                          {Number.isFinite(saleAgeDays) ? ` · ${saleAgeDays} дн назад` : ''}
                        </div>
                      )}
                      {buyerSource === 'table' && (
                        <div className="muted" style={{ fontSize: 12, color: 'var(--warn)' }} title="Цена из Google-таблицы: живых источников WB по этому товару нет.">из таблицы</div>
                      )}
                      {buyerSource === 'lk' && (
                        <div className="muted" style={{ fontSize: 12 }} title="СПП неизвестен — показана цена ЛК после скидки продавца.">цена ЛК · без СПП</div>
                      )}
                      {buyerSource === 'none' && sppPct > 0 && (
                        <div className="muted" style={{ fontSize: 13 }}>СПП {sppPct}%</div>
                      )}
                    </td>
                    <td className="right" style={{ whiteSpace: 'nowrap' }}>
                      {marginRub !== null ? (
                        <>
                          <b style={{ fontSize: 17, color: marginPct! >= 30 ? 'var(--good)' : marginPct! >= 15 ? 'var(--warn)' : 'var(--bad)' }}>
                            {Math.round(marginPct ?? 0)}%
                          </b>
                          <div className="muted" style={{ fontSize: 13 }}>{marginRub.toLocaleString('ru-RU')} ₽</div>
                          {commIsDefault && (
                            <div style={{ fontSize: 12, color: 'var(--warn)' }} title={`Комиссия WB не пришла из API — взят дефолт ${WB_DEFAULTS.commission}%. Реальная (обычно ~35.5% для автотоваров) может быть выше → маржа завышена. Раскрой строку и задай комиссию.`}>⚠ ком. {WB_DEFAULTS.commission}%</div>
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
                      {(() => { const adv = adsAdvice({ drr: inp.drr, drr7: econRow?.drr7 ?? null, drr30: econRow?.drr30 ?? null, orders7: econRow?.orders7 ?? 0, marginPct, roi, inStock: isInStock(r) }); return adv ? <div title={adv.hint} className={adv.tone === 'muted' ? 'muted' : undefined} style={{ fontSize: 12, marginTop: 3, whiteSpace: 'normal', lineHeight: 1.3, color: adv.tone === 'bad' ? 'var(--bad)' : adv.tone === 'warn' ? 'var(--warn)' : adv.tone === 'good' ? 'var(--good)' : undefined }}>{adv.text}</div> : null; })()}
</td>
                    <td style={{ textAlign: 'center' }}>
                      <div className="row" style={{ gap: 4, justifyContent: 'center' }} onClick={(e) => e.stopPropagation()}>
                        {isArchived ? (
                          <button className="btn btn-sm" title="Вернуть из архива" onClick={() => onUnarchive(r.vendorCode)}>
                            <ArrowCounterClockwiseIcon size={12} weight="bold" />
                          </button>
                        ) : (
                          <button className="btn btn-sm" title="В архив" onClick={() => onArchive(r.vendorCode)}>
                            <ArchiveIcon size={12} weight="bold" />
                          </button>
                        )}
                        {isOpen
                          ? <CaretUpIcon size={14} weight="bold" />
                          : <CaretDownIcon size={14} weight="bold" />}
                      </div>
                    </td>
                  </tr>

                  {isOpen && (
                    <tr key={`${r.nmId}-details`}>
                      <td colSpan={8} style={{ padding: 0 }}>
                        <div
                          style={{
                            background: 'var(--bg-subtle, #fafafa)',
                            padding: '16px 24px',
                            borderBottom: '1px solid var(--border)',
                          }}
                        >
                          {(() => {
                            // Всё уже посчитано на уровне строки (inp/calc/econ/…) — переиспользуем.
                            const c = calc;
                            const edited = Object.keys(k).length > 0;
                            // Показываем в поле СЫРУЮ строку пользователя (в т.ч. пустую),
                            // иначе — дефолт округлённым до рубля/процента.
                            const shown = (key: keyof CalcKnobs, def: number) =>
                              k[key] !== undefined ? k[key] : String(Math.round(def));
                            const knobFields: { key: keyof CalcKnobs; label: string; val: string; suffix?: string }[] = [
                              { key: 'retail', label: 'Цена продажи (серая)', val: shown('retail', inp.retail), suffix: '₽' },
                              { key: 'cost', label: 'Себестоимость', val: shown('cost', inp.cost), suffix: '₽' },
                              { key: 'spp', label: 'СПП', val: shown('spp', inp.spp), suffix: '%' },
                              { key: 'drr', label: 'ДРР (реклама)', val: shown('drr', inp.drr), suffix: '%' },
                              { key: 'buyout', label: '% выкупа', val: shown('buyout', inp.buyout), suffix: '%' },
                              { key: 'commission', label: 'Комиссия WB', val: shown('commission', inp.commission), suffix: '%' },
                            ];
                            const rows: { l: string; v: number }[] = c ? [
                              { l: 'Себестоимость', v: -c.breakdown.cost },
                              { l: `Комиссия WB (${inp.commission}%) · ${wbScheme}${catComm != null ? ' · API' : ''}`, v: -c.breakdown.commission },
                              { l: `Логистика${econRow?.logisticFact?.value != null ? ' · факт за 30 дн' : logFromApi != null ? ` · тариф (${volL.toFixed(2)} л)` : ''}`, v: -c.breakdown.logistic },
                              { l: `Хранение${storFromApi != null ? ' · API (30 дн)' : ''}`, v: -c.breakdown.storage },
                              { l: `Обратная логистика${k.buyout === undefined && econRow?.returnFact?.value != null ? ` · факт за 30 дн (выкуп ${Math.max(1, inp.buyout)}%)` : ` (выкуп ${Math.max(1, inp.buyout)}% · невыкуп ${100 - Math.max(1, inp.buyout)}%)`}`, v: -c.breakdown.returnCost },
                              { l: `Эквайринг (${inp.acquiring ?? WB_DEFAULTS.acquiring}%)`, v: -c.breakdown.acquiring },
                              { l: `УСН ${inp.usn ?? WB_DEFAULTS.usn}%`, v: -c.breakdown.usn },
                              { l: `НДС ${inp.nds ?? WB_DEFAULTS.nds}%`, v: -c.breakdown.nds },
                              {
                                l: `Реклама ДРР (${inp.drr}%)` + (
                              k.drr !== undefined ? ' · вручную'
                              : econRow?.drrPick === '7d' ? ` · 7 дн · заказов ${econRow.orders7}`
                              : econRow?.drrPick === '30d' ? ` · 30 дн (за 7 дн заказов ${econRow.orders7} — мало)`
                              : econRow?.drrPick === 'store' ? ' · средний по магазину'
                              : drrByNm[String(r.nmId)] != null ? ' · из API рекламы WB'
                              : proc?.drrWb != null ? ' · из таблицы'
                              : ' · параметр по умолчанию'
                            ) + (econRow && (econRow.drr7 != null || econRow.drr30 != null) ? ` · 7д ${econRow.drr7 ?? '—'}% / 30д ${econRow.drr30 ?? '—'}%` : ''),
                            v: -c.breakdown.ads,
                              },
                            ] : [];
                            return (
                              <div className="grid grid-2" style={{ gap: 20, marginBottom: 16 }} onClick={(e) => e.stopPropagation()}>
                                {/* Крутилки */}
                                <div>
                                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                                    {knobFields.map(f => (
                                      <label key={f.key} style={{ fontSize: 14 }}>
                                        <div className="muted" style={{ marginBottom: 3 }}>{f.label}{f.suffix ? `, ${f.suffix}` : ''}</div>
                                        <input
                                          className="input"
                                          type="number"
                                          value={f.val}
                                          onChange={(e) => setKnob(r.nmId, f.key, e.target.value)}
                                          style={{ width: '100%', ...(k[f.key] !== undefined ? { borderColor: 'var(--accent)', fontWeight: 700 } : {}) }}
                                        />
                                      </label>
                                    ))}
                                  </div>
                                  {edited && (
                                    <button className="btn btn-sm" style={{ marginTop: 10 }} onClick={() => setKnobs(prev => { const n = { ...prev }; delete n[r.nmId]; saveKnobs(n); return n; })}>
                                      Сбросить к данным из таблицы
                                    </button>
                                  )}
                                </div>
                                {/* Разбивка */}
                                <div>
                                  <div className="card-title" style={{ marginBottom: 8 }}>Расчёт на 1 продажу</div>
                                  <div style={{ display: 'grid', gap: 3 }}>
                                    <div className="flex-between" style={{ fontSize: 15, fontWeight: 600 }}>
                                      <span>Цена продажи (серая)</span>
                                      <span style={{ color: 'var(--good)' }}>{c ? fmt(Math.round(inp.retail)) : '—'}</span>
                                    </div>
                                    <div className="flex-between muted" style={{ fontSize: 13 }}>
                                      <span>↳ цена покупателя (с СПП {inp.spp}%)</span>
                                      <span>{c ? fmt(Math.round(c.sppPrice)) : '—'}</span>
                                    </div>
                                    {rows.map((x, i) => (
                                      <div key={i} className="flex-between muted" style={{ fontSize: 14 }}>
                                        <span>{x.l}</span>
                                        <span style={{ color: 'var(--bad)' }}>{fmt(Math.round(x.v))}</span>
                                      </div>
                                    ))}
                                    <div className="flex-between" style={{ fontSize: 17, fontWeight: 700, borderTop: '1px solid var(--border)', marginTop: 6, paddingTop: 6 }}>
                                      <span>Чистая прибыль</span>
                                      <span style={{ color: c && c.profit >= 0 ? 'var(--good)' : 'var(--bad)' }}>
                                        {c ? fmt(Math.round(c.profit)) : '—'}
                                        {c && <span style={{ fontSize: 14, fontWeight: 600 }}> · {c.margin.toFixed(1)}%{inp.cost > 0 ? ` · ROI ${c.roi.toFixed(0)}%` : ''}</span>}
                                      </span>
                                    </div>
                                  </div>
                                </div>
                              </div>
                            );
                          })()}

                          {r.sizes.length > 1 && (
                            <>
                              <div className="card-title" style={{ marginBottom: 8, marginTop: 4 }}>
                                Цены по размерам ({r.sizes.length})
                              </div>
                              <table style={{ fontSize: 15 }}>
                                <thead>
                                  <tr>
                                    <th>Размер</th>
                                    <th className="right">Базовая (в ЛК)</th>
                                    <th className="right">Со скидкой</th>
                                    <th className="right">WB Club (зелёная)</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {r.sizes.map((s, i) => (
                                    <tr key={i}>
                                      <td><b>{s.techSizeName || '—'}</b></td>
                                      <td className="right" style={{ whiteSpace: 'nowrap' }}>{fmt(s.price)}</td>
                                      <td className="right" style={{ whiteSpace: 'nowrap' }}>{fmt(s.discountedPrice)}</td>
                                      <td className="right" style={{ whiteSpace: 'nowrap' }}>
                                        {s.clubDiscountedPrice
                                          ? <b style={{ color: 'var(--good)' }}>{fmt(s.clubDiscountedPrice)}</b>
                                          : <span className="muted">—</span>}
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
        </div>

        {bundle.fetchedAt && (
          <div className="muted" style={{ fontSize: 13, marginTop: 8, textAlign: 'right' }}>
            Данные на {bundle.fetchedAt.toLocaleTimeString('ru-RU')} · discounts-prices API
          </div>
        )}
      </div>
    </div>
  );
}
