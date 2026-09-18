export const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbwCPfeSVYni6VCXK206p8sxVly8T7Ur5khc6kMdIxIeZBKSfK5wPH12Q5Qs8j4u96v3/exec';

export type ProcurementItem = {
  sku: string;
  name: string;
  category?: string;
  stockOzon: number;
  stockWB: number;
  warehouseStock: number;
  sales7Ozon: number;
  sales7WB: number;
  sales30Ozon: number;
  sales30WB: number;
  buyoutOzon: number;
  buyoutWB: number;
  dailyOzon: number;
  dailyWB: number;
  dailyTotal: number;
  purchasePrice: number;
  tranzitTotal: number;
  tranzitItems: { qty: number; date: string | null }[] | null;
  tranzitNext: { qty: number; date: string | null } | null;
  mpTransit?: number; // товары в пути на склады МП (FBO Ozon/WB), ещё не в продаже
  marginOzon: number | null;
  marginWB: number | null;
  priceOzon: number | null;
  priceWB: number | null;
  marginHistory: { w: string; o: number | null; wb: number | null }[] | null;
  planOzon?: number[];
  planWB?: number[];
  daysSupplyOzon: number;
  daysSupplyWB: number;
  daysSupplyTotal: number;
  
  // Computed dynamically in procurementLogic
  customLeadTime?: number;
  customPackaging?: number;
  customTargetDays?: number;
  suggestedQty?: number;
  rawSuggestedQty?: number; // расчётный докуп ДО порога мин. партии (для честного UI)
  batchRoundedUp?: boolean; // докуп подняли до мин. партии 100 (расчёт был меньше)
  batchUneconomical?: boolean; // расчёт < 100, но партия 100 = запас на годы (докуп не окупится)
  totalPurchaseCost?: number;
  orderByDate?: string;
  trendFactor?: number;
  planArrivalMonth?: number;
  avgDailyPlan?: number;
  effectiveTargetDays?: number;
  status?: 'ok' | 'low' | 'critical' | 'stop';
  // urgency — новый, привязанный к циклу (leadTime + packaging), а не к 14/30:
  //  order_now  — daysCovered < cycle    (поставка не успеет приехать)
  //  order_soon — cycle ≤ daysCovered < cycle + buffer
  //  healthy    — cycle + buffer ≤ daysCovered ≤ 90
  //  excess     — daysCovered > 90 и докуп не нужен (замороженный капитал)
  //  no_movement — продаж нет вообще (надо архивировать или думать что с этим)
  urgency?: 'order_now' | 'order_soon' | 'healthy' | 'excess' | 'no_movement';
  urgencyCycleDays?: number;   // фактический leadTime + packaging для этого SKU
  urgencyBufferDays?: number;  // буфер безопасности
  recommendedMP?: string;
  roiOzon?: number | null;
  roiWB?: number | null;
  roiStatusOzon?: 'ok' | 'warn' | 'danger' | 'stop' | 'none';
  roiStatusWB?: 'ok' | 'warn' | 'danger' | 'stop' | 'none';

  // ROI и маржинальная прибыль ИЗ листа «Маржа» (финансист считает еженедельно,
  // берём последнюю неделю). Источник истины для ROI-модуля — не считаем сами.
  roiOzonMarzha?: number | null;    // ROI Ozon, % (кол.6, дробь→%)
  roiWbMarzha?: number | null;      // ROI WB, %  (кол.13)
  profitUnitOzon?: number | null;   // прибыль Ozon на единицу, ₽ (кол.14)
  profitUnitWb?: number | null;     // прибыль WB на единицу, ₽  (кол.16)
  profitWeekOzon?: number | null;   // прибыль Ozon за неделю по артикулу, ₽ (кол.15)
  profitWeekWb?: number | null;     // прибыль WB за неделю, ₽    (кол.17)
  marzhaWeekOzon?: number | null;   // номер последней недели Ozon (для подписи)
  marzhaWeekWb?: number | null;     // номер последней недели WB (кол.12)

  // Витринные цены из листа «ДРР и цены» (Ozon убрал цену покупателя из API
  // 12.11.2025 — берём из таблицы). buyer = «с учётом СПП» (что платит покупатель),
  // lk = «наша цена в личном кабинете».
  buyerPriceOzon?: number | null;   // текущая цена Ozon с учётом СПП, ₽ (кол.3)
  lkPriceOzon?: number | null;      // наша цена Ozon в ЛК, ₽           (кол.4)
  buyerPriceWb?: number | null;     // текущая цена WB с учётом СПП, ₽  (кол.7)
  lkPriceWb?: number | null;        // наша цена WB в ЛК, ₽             (кол.8)
  // ДРР % (реклама/заказы за 7 дней) из листа «ДРР и цены»: B/C (Ozon), F/G (WB).
  drrOzon?: number | null;
  drrWb?: number | null;
};

export async function fetchSheet(sheetName: string, retries = 2): Promise<any[][]> {
  const url = `${APPS_SCRIPT_URL}?sheet=${encodeURIComponent(sheetName)}`;
  let lastErr: any;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status} (лист «${sheetName}»)`);
      const json = await res.json();
      if (json.error) throw new Error(json.error);
      return json.data;
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await new Promise(r => setTimeout(r, 600 * (attempt + 1)));
    }
  }
  throw lastErr;
}

function ensureItem(items: Record<string, ProcurementItem>, sku: string, name = ''): ProcurementItem {
  if (!items[sku]) {
    items[sku] = {
      sku,
      name,
      stockOzon: 0, stockWB: 0, warehouseStock: 0,
      sales7Ozon: 0, sales7WB: 0, sales30Ozon: 0, sales30WB: 0,
      buyoutOzon: 0, buyoutWB: 0,
      dailyOzon: 0, dailyWB: 0, dailyTotal: 0,
      purchasePrice: 0,
      tranzitTotal: 0, tranzitItems: null, tranzitNext: null,
      marginOzon: null, marginWB: null, priceOzon: null, priceWB: null,
      marginHistory: null,
      daysSupplyOzon: 999, daysSupplyWB: 999, daysSupplyTotal: 999,
    };
  } else if (!items[sku].name && name) {
    items[sku].name = name;
  }
  return items[sku];
}

// Опциональный fetch — возвращает [] если лист недоступен (например, нет в whitelist GAS)
async function fetchSheetOptional(sheetName: string): Promise<any[][]> {
  try {
    return await fetchSheet(sheetName, 1);
  } catch (e) {
    console.warn(`[googleSheets] лист "${sheetName}" недоступен, пропускаем:`, (e as Error).message);
    return [];
  }
}

export async function fetchAllGoogleSheetsData(): Promise<ProcurementItem[]> {
  const [owbData, skData, trData, mzData, planData, stockOrigData, drrData] = await Promise.all([
    fetchSheet('Ozon_wb'),
    fetchSheet('Склад и цена закупки'),
    fetchSheet('Транзит'),
    fetchSheet('Маржа'),
    fetchSheet('План'),
    fetchSheetOptional('Склад'), // актуальная себестоимость: B=SKU, H=Закуп
    fetchSheetOptional('ДРР и цены'), // витринные цены: A=SKU, D=цена с СПП, E=ЛК (Ozon)
  ]);

  const items: Record<string, ProcurementItem> = {};
  
  // 1. Ozon_wb
  for (let i = 1; i < owbData.length; i++) {
    const r = owbData[i];
    const sku = String(r[0] || '').trim().toUpperCase();
    if (!sku) continue;
    
    const s30Ozon = Number(r[6]) || 0;
    const s30WB = Number(r[7]) || 0;
    const dailyOzon = Math.round((s30Ozon / 30) * 100) / 100;
    const dailyWB = Math.round((s30WB / 30) * 100) / 100;
    
    items[sku] = {
      sku,
      name: String(r[1] || '').trim(),
      stockOzon: Number(r[2]) || 0,
      stockWB: Number(r[3]) || 0,
      warehouseStock: 0,
      sales7Ozon: Number(r[4]) || 0,
      sales7WB: Number(r[5]) || 0,
      sales30Ozon: s30Ozon,
      sales30WB: s30WB,
      buyoutOzon: Number(r[8]) || 0,
      buyoutWB: Number(r[9]) || 0,
      dailyOzon,
      dailyWB,
      dailyTotal: Math.round((dailyOzon + dailyWB) * 100) / 100,
      purchasePrice: 0,
      tranzitTotal: 0,
      tranzitItems: null,
      tranzitNext: null,
      marginOzon: null,
      marginWB: null,
      priceOzon: null,
      priceWB: null,
      marginHistory: null,
      daysSupplyOzon: 999,
      daysSupplyWB: 999,
      daysSupplyTotal: 999,
    };
  }

  // 2. Склад — только ОБНОВЛЯЕМ существующие SKU (не создаём новые).
  // В листе «Склад» сотни строк с вариантами/упаковками, которые не должны
  // попадать в основной прогноз — только в Ozon_wb настоящие торгующие SKU.
  for (let i = 1; i < skData.length; i++) {
    const r = skData[i];
    const sku = String(r[0] || '').trim().toUpperCase();
    if (!sku || !items[sku]) continue;
    items[sku].warehouseStock += Number(r[2]) || 0;
    if (!items[sku].purchasePrice) items[sku].purchasePrice = Number(r[3]) || 0;
  }

  // 3. Транзит — то же правило, только обновляем существующие
  const trMap: Record<string, {qty: number, date: string|null}[]> = {};
  for (let i = 1; i < trData.length; i++) {
    const r = trData[i];
    const sku = String(r[0] || '').trim().toUpperCase();
    if (!sku || !items[sku]) continue;
    const qty = Number(r[2]) || 0;
    const date = r[3] ? String(r[3]).substring(0, 10) : null;
    if (!trMap[sku]) trMap[sku] = [];
    trMap[sku].push({ qty, date });
  }

  // 4. Маржа
  const marginLatestO: Record<string, any> = {};
  const marginLatestW: Record<string, any> = {};
  const catMap: Record<string, string> = {};
  const historyMap: Record<string, Record<number, {o: number|null, wb: number|null}>> = {};

  for (let i = 1; i < mzData.length; i++) {
    const r = mzData[i];
    const skuO = String(r[0] || '').trim().toUpperCase();
    const skuW = String(r[7] || '').trim().toUpperCase();
    const weekO = Number(r[5]);
    const weekW = Number(r[12]);
    
    if (skuO && r[4] !== '' && r[4] !== null) {
      const mPct = Math.round(Number(r[4]) * 1000) / 10;
      if (!marginLatestO[skuO] || weekO >= marginLatestO[skuO].week) {
        // Из «Маржи»: ROI кол.6 (дробь→%), прибыль/ед кол.14, прибыль/неделю кол.15.
        marginLatestO[skuO] = {
          week: weekO, val: mPct, price: Number(r[2]) || 0,
          roi: (r[6] === '' || r[6] == null) ? null : Math.round(Number(r[6]) * 1000) / 10,
          profitUnit: (r[14] === '' || r[14] == null) ? null : Number(r[14]),
          profitWeek: (r[15] === '' || r[15] == null) ? null : Number(r[15]),
        };
      }
      if (r[1]) catMap[skuO] = String(r[1]).trim();
      if (!historyMap[skuO]) historyMap[skuO] = {};
      if (!historyMap[skuO][weekO]) historyMap[skuO][weekO] = { o: mPct, wb: null };
      else historyMap[skuO][weekO].o = mPct;
    }
    
    if (skuW && r[11] !== '' && r[11] !== null) {
      const mPct = Math.round(Number(r[11]) * 1000) / 10;
      if (!marginLatestW[skuW] || weekW >= marginLatestW[skuW].week) {
        // Из «Маржи»: ROI кол.13, прибыль/ед кол.16, прибыль/неделю кол.17.
        marginLatestW[skuW] = {
          week: weekW, val: mPct, price: Number(r[9]) || 0,
          roi: (r[13] === '' || r[13] == null) ? null : Math.round(Number(r[13]) * 1000) / 10,
          profitUnit: (r[16] === '' || r[16] == null) ? null : Number(r[16]),
          profitWeek: (r[17] === '' || r[17] == null) ? null : Number(r[17]),
        };
      }
      if (!historyMap[skuW]) historyMap[skuW] = {};
      if (!historyMap[skuW][weekW]) historyMap[skuW][weekW] = { o: null, wb: mPct };
      else historyMap[skuW][weekW].wb = mPct;
    }
  }

  // SKU, которые есть в «Марже» (финансист их торгует), но отсутствуют в базовом
  // листе Ozon_wb — например ВБ-only товары (dji, dudu, co2…). Без этого они
  // терялись: в «Марже» за неделю 25 SKU ВБ, на экране было 12. Создаём скелет —
  // деньги из «Маржи» подтянутся ниже; в Закупки/Распределение такие не попадут
  // (нулевые остатки/продажи отфильтрованы там своими условиями).
  for (const skuUp of Object.keys(marginLatestW)) ensureItem(items, skuUp);
  for (const skuUp of Object.keys(marginLatestO)) ensureItem(items, skuUp);

  const marginHistoryFinal: Record<string, any> = {};
  for (const sku of Object.keys(historyMap)) {
    const weeks = Object.entries(historyMap[sku])
      .sort((a, b) => Number(a[0]) - Number(b[0]))
      .slice(-4)
      .map(([w, v]) => ({ w: `W${String(w).padStart(2,'0')}`, o: v.o, wb: v.wb }));
    if (weeks.length >= 2) marginHistoryFinal[sku] = weeks;
  }

  // 5. План
  const planOzon: Record<string, number[]> = {};
  const planWB: Record<string, number[]> = {};
  for (let i = 1; i < planData.length; i++) {
    const r = planData[i];
    const soRaw = String(r[0] || '').trim().toUpperCase();
    const swRaw = String(r[14] || '').trim().toUpperCase();
    if (soRaw && soRaw !== 'NAN' && soRaw !== 'SKU OZON') {
      planOzon[soRaw] = Array.from({length:12}, (_,j) => Number(r[1+j]) || 0);
    }
    if (swRaw && swRaw !== 'NAN' && swRaw !== 'SKU WILDBERRIES') {
      planWB[swRaw] = Array.from({length:12}, (_,j) => Number(r[15+j]) || 0);
    }
  }

  // Подтягиваем SKU из «Маржи», если их ещё нет
  // Маржа НЕ создаёт новых SKU — только обновляет существующие
  // (некоторые SKU могут быть в Маржа но не в Ozon_wb, нам они не нужны)

  // 6. Склад (orig) — актуальная себестоимость переопределяет purchasePrice
  // Формат: B = SKU, H = закуп (₽). Если лист недоступен — просто пропускаем.
  // ВАЖНО: только обновляем существующие SKU. Не создаём новые — в этом листе
  // сотни вариантов/упаковок, которые не должны попадать в основной прогноз.
  // Колонки — по заголовкам («SKU…», «Закуп»), а не по номеру: 04.09 клиент
  // вставил колонку «Link», и всё уехало на одну. Здесь к тому же читалась H,
  // а на сервере I — два парсера с разными номерами для одного листа.
  // Заголовки разнесены по строкам («Закуп» в 1-й, «SKU» во 2-й) — ищем каждую в любой.
  let skuCol = -1, costCol = -1, headerRow = 0;
  for (let i = 0; i < Math.min(stockOrigData.length, 10); i++) {
    const r = (stockOrigData[i] ?? []).map(c => String(c ?? '').trim().toLowerCase());
    if (skuCol < 0) skuCol = r.findIndex(c => /(^|\s)sku(\s|$|\/)|артикул/.test(c));
    if (costCol < 0) costCol = r.findIndex(c => /закуп/.test(c));
    if (skuCol >= 0 && costCol >= 0) { headerRow = i; break; }
  }
  if (skuCol < 0 || costCol < 0) { skuCol = 1; costCol = 8; headerRow = 0; }
  let updatedCosts = 0;
  for (let i = headerRow + 1; i < stockOrigData.length; i++) {
    const r = stockOrigData[i];
    if (!r) continue;
    const sku = String(r[skuCol] || '').trim().toUpperCase();
    const cost = Number(r[costCol]) || 0;
    if (!sku || cost <= 0) continue;
    if (sku === 'SKU' || sku.startsWith('SKU OZON')) continue; // пропуск заголовков
    if (items[sku]) {
      items[sku].purchasePrice = cost;
      updatedCosts++;
    }
  }
  if (stockOrigData.length && updatedCosts > 0) {
    console.info(`[googleSheets] обновили purchasePrice для ${updatedCosts} SKU из листа "Склад"`);
  }

  // 7. ДРР и цены — витринные цены (Ozon убрал цену покупателя из API 12.11.2025).
  // A=SKU, D(3)=цена Ozon с СПП (покупатель), E(4)=цена Ozon ЛК,
  // H(7)=цена WB с СПП, I(8)=цена WB ЛК. Только обновляем существующие SKU.
  const pv = (x: any) => (x === '' || x == null || !Number.isFinite(Number(x))) ? null : Number(x);
  for (let i = 1; i < drrData.length; i++) {
    const r = drrData[i];
    if (!r) continue;
    const sku = String(r[0] || '').trim().toUpperCase();
    if (!sku || !items[sku]) continue;
    items[sku].buyerPriceOzon = pv(r[3]);
    items[sku].lkPriceOzon = pv(r[4]);
    items[sku].buyerPriceWb = pv(r[7]);
    items[sku].lkPriceWb = pv(r[8]);
    // ДРР % = реклам. расходы / заказано, за 7 дней. B(1)/C(2) Ozon, F(5)/G(6) WB.
    const adOz = pv(r[1]), ordOz = pv(r[2]);
    const adWb = pv(r[5]), ordWb = pv(r[6]);
    items[sku].drrOzon = (adOz != null && ordOz && ordOz > 0) ? +(adOz / ordOz * 100).toFixed(1) : null;
    items[sku].drrWb = (adWb != null && ordWb && ordWb > 0) ? +(adWb / ordWb * 100).toFixed(1) : null;
  }

  // Merge and finalize (все ключи уже в верхнем регистре)
  Object.values(items).forEach(p => {
    const skuUp = p.sku;

    const trArr = (trMap[skuUp] || []).filter(t => t.date);
    p.tranzitTotal = trArr.reduce((s, t) => s + t.qty, 0);
    p.tranzitItems = trArr.length > 1 ? trArr : null;
    p.tranzitNext = trArr.length === 1 ? trArr[0] : (trArr.length > 1 ? trArr[0] : null);

    const mO = marginLatestO[skuUp];
    const mW = marginLatestW[skuUp];
    p.marginOzon = mO ? mO.val : null;
    p.marginWB = mW ? mW.val : null;
    p.priceOzon = mO ? mO.price : null;
    p.priceWB = mW ? mW.price : null;
    // ROI и прибыль из «Маржи» (последняя неделя) — источник истины для ROI-модуля.
    p.roiOzonMarzha = mO ? (mO.roi ?? null) : null;
    p.roiWbMarzha = mW ? (mW.roi ?? null) : null;
    p.profitUnitOzon = mO ? (mO.profitUnit ?? null) : null;
    p.profitUnitWb = mW ? (mW.profitUnit ?? null) : null;
    p.profitWeekOzon = mO ? (mO.profitWeek ?? null) : null;
    p.profitWeekWb = mW ? (mW.profitWeek ?? null) : null;
    p.marzhaWeekOzon = mO ? (mO.week ?? null) : null;
    p.marzhaWeekWb = mW ? (mW.week ?? null) : null;
    
    if (catMap[skuUp]) p.category = catMap[skuUp];
    p.marginHistory = marginHistoryFinal[skuUp] || null;
    if (planOzon[skuUp]) p.planOzon = planOzon[skuUp];
    if (planWB[skuUp]) p.planWB = planWB[skuUp];

    const totalStock = p.stockOzon + p.stockWB + p.warehouseStock;
    p.daysSupplyOzon = p.dailyOzon > 0 ? Math.round(p.stockOzon / p.dailyOzon) : 999;
    p.daysSupplyWB = p.dailyWB > 0 ? Math.round(p.stockWB / p.dailyWB) : 999;
    p.daysSupplyTotal = p.dailyTotal > 0 ? Math.round(totalStock / p.dailyTotal) : 999;
  });

  return Object.values(items);
}
