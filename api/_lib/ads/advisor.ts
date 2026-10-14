/**
 * Советник по продажам дня (15.10.2026, просьба владельца: «почему в конкретный день
 * хромают продажи, на что обратить внимание, где подкрутить»).
 *
 * Берёт выбранный день (по умолчанию вчера — последний полный) и сравнивает с
 * средним за 7 дней до него. По каждому товару ищет причину в данных, которые уже
 * есть на сервере, — новых запросов к площадкам не делает:
 *   РНП      — заказы, выручка, переходы в карточку, корзины, расход рекламы, остатки,
 *              цена продавца и СПП (по заказам), позиция Ozon по дням;
 *   кабинет  — позиция наших карточек WB за день (Агент 3, ad_pos_daily);
 *   витрина  — цены конкурентов и наши по дням (ad_comp_card), привязки — competitors.json;
 *   журнал   — изменения рекламы (пауза, ставка, лимит) за день до и в день.
 *
 * Причины — правила с порогами (ниже), у каждой цифры «было → стало» и действие.
 * Главная причина товара — первая по приоритету; по ней собираются «главные причины дня».
 */
import { getRnp } from '../rnp';
import { mskDate } from '../mskDate';
import { listCampaigns, listChanges, listItems, listFlags, type AdMp } from './store';
import { compCardSeries, posSeries } from './cabinet';
import { getAllLinks } from '../competitorWatch';
import type { Ads2Advisor, Ads2AdvisorCause, Ads2AdvisorProduct, Ads2AdvisorTotals } from '../../../shared/ads2';

const DAY = 86_400_000;
const addDays = (d: string, n: number) => new Date(Date.parse(d + 'T00:00:00Z') + n * DAY).toISOString().slice(0, 10);
const r1 = (v: number) => Math.round(v * 10) / 10;
const r0 = (v: number) => Math.round(v);
const nf1 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });
/** Дробь в тексте — по-русски, с запятой. */
const f1 = (v: number) => nf1.format(r1(v));
const up = (s: unknown) => String(s ?? '').trim().toUpperCase();
const nf = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
const rub = (v: number) => `${nf.format(Math.round(v))} ₽`;
const kRub = (v: number) => (Math.abs(v) >= 1_000_000 ? `${(v / 1_000_000).toFixed(1).replace('.', ',')} млн ₽` : Math.abs(v) >= 10_000 ? `${nf.format(Math.round(v / 1000))} тыс ₽` : rub(v));
const pctCh = (a: number, b: number) => (b > 0 ? Math.round((a / b - 1) * 100) : null);
const sign = (v: number) => (v > 0 ? `+${v}` : `${v}`);
const ddmm = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}`;

/** Приоритет причин просадки: первая найденная — главная. */
const DOWN_ORDER = ['stock_out', 'ads_off', 'ads_down', 'position_down', 'price_up', 'spp_down', 'comp_cheaper', 'card_conv_down', 'cart_conv_down', 'traffic_down', 'stock_low'] as const;
const UP_ORDER = ['ads_up', 'position_up', 'comp_out', 'price_down', 'traffic_up'] as const;

export const ADVISOR_LABEL: Record<string, { label: string; action: string }> = {
  stock_out: { label: 'Нет остатка', action: 'Пополнить остаток; рекламу по этим товарам держать на паузе до поставки' },
  stock_low: { label: 'Остаток на исходе', action: 'Запланировать поставку; ставки не повышать' },
  ads_off: { label: 'Реклама остановилась', action: 'Проверить кампании: пауза, кончился бюджет или дневной лимит' },
  ads_down: { label: 'Реклама просела', action: 'Проверить ставки, лимиты и бюджет кампаний (вкладка «Кампании» в «Рекламе»)' },
  position_down: { label: 'Упала позиция в поиске', action: 'Проверить ставку, цену против конкурентов, свежие отзывы и рейтинг' },
  price_up: { label: 'Выросла наша цена', action: 'Сверить цену с конкурентами; если рост не плановый — вернуть в «Ценах»' },
  spp_down: { label: 'Площадка уменьшила скидку (СПП)', action: 'Цена для покупателя выросла без нашего участия — проверить цену продавца в «Ценах»' },
  comp_cheaper: { label: 'Конкурент снизил цену', action: 'Оценить ответ: цена, акция или промо; конкурент — в «Конкурентах»' },
  card_conv_down: { label: 'Карточка хуже продаёт', action: 'Конверсия в корзину упала: цена, фото, первые отзывы, наличие размеров/цветов' },
  cart_conv_down: { label: 'Бросают корзину', action: 'Из корзины заказывают реже: срок доставки, наличие на складах, цена' },
  traffic_down: { label: 'Меньше переходов в карточку', action: 'Спрос или видимость: позиция, реклама, сезон' },
  low_volume: { label: 'Редкие продажи — обычный разброс', action: 'Ничего не делать; смотреть сумму за неделю, а не один день' },
  unknown: { label: 'Причина не видна в данных', action: 'Возможно, спрос, день недели или колебание; смотреть динамику ещё день' },
  ads_up: { label: 'Реклама добавила', action: 'Держать, следить за ДРР' },
  position_up: { label: 'Позиция выросла', action: 'Закрепить: не урезать ставку и остаток' },
  comp_out: { label: 'У конкурента кончился товар', action: 'Окно для роста: проверить остаток и ставку' },
  price_down: { label: 'Наша цена ниже', action: 'Проверить, что маржа в норме' },
  traffic_up: { label: 'Больше переходов', action: '' },
  growth: { label: 'Рост без явной причины', action: '' },
};

export async function getAdvisor(mp: AdMp, dateArg?: string): Promise<Ads2Advisor> {
  const yesterday = mskDate(1);
  const dates: string[] = [];
  for (let i = 0; i < 14; i++) dates.push(addDays(yesterday, -i));
  const D = dateArg && dates.includes(dateArg) ? dateArg : yesterday;
  const baseFrom = addDays(D, -7), baseTo = addDays(D, -1);
  const rnp = await getRnp(mp, addDays(D, -14), D);
  const notes: string[] = [...rnp.notes];
  const idx = new Map(rnp.dates.map((d, i) => [d, i]));
  const iD = idx.get(D);
  const baseI = rnp.dates.map((d, i) => (d >= baseFrom && d <= baseTo ? i : -1)).filter(i => i >= 0);
  const iWeek = idx.get(addDays(D, -7));
  const keys = Object.keys(rnp.facts);
  const at = (k: string, m: string, i: number | undefined): number | null => (i == null ? null : rnp.facts[k]?.[m]?.[i] ?? null);
  const sumBase = (k: string, m: string): number | null => {
    let s: number | null = null;
    for (const i of baseI) { const x = rnp.facts[k]?.[m]?.[i]; if (x != null) s = (s ?? 0) + x; }
    return s;
  };
  const avgBase = (k: string, m: string): number => (sumBase(k, m) ?? 0) / Math.max(1, baseI.length);
  const has = (m: string) => rnp.present.includes(m);

  // Справочники: товар → номер на площадке, архив (самовыкуп, дубли — не считаем нигде).
  const item = new Map(rnp.items.map(it => [it.sku, it]));
  const adSkuOf = (k: string) => (mp === 'wb' ? k : item.get(k)?.extId || null);
  const archived = new Set(listFlags().filter(f => f.mp === mp && f.archived).map(f => f.sku));
  const work = keys.filter(k => { const a = adSkuOf(k); return !(a && archived.has(a)); });

  // Итоги площадки за день и в среднем за базу.
  const totals = (pick: (k: string, m: string) => number): Ads2AdvisorTotals => {
    let orders = 0, revenue = 0, spend = 0, views = 0, carts = 0;
    for (const k of work) {
      orders += pick(k, 'ordered_cnt'); revenue += pick(k, 'ordered_amount'); spend += pick(k, 'adv_expenses');
      views += pick(k, 'session_view_pdp'); carts += pick(k, 'hits_tocart');
    }
    return {
      orders: r1(orders), revenue: r0(revenue), spend: r0(spend), drr: revenue > 0 ? r1(spend / revenue * 100) : null,
      views: has('session_view_pdp') ? r0(views) : null, cartConv: has('hits_tocart') && views > 0 ? r1(carts / views * 100) : null,
    };
  };
  const day = totals((k, m) => at(k, m, iD) ?? 0);
  const base = totals((k, m) => avgBase(k, m));
  const weekAgo = iWeek == null ? null : (() => { const t = totals((k, m) => at(k, m, iWeek) ?? 0); return { orders: t.orders, revenue: t.revenue }; })();
  if (iD == null) notes.push(`За ${ddmm(D)} в РНП ещё нет данных.`);

  // Кампании, журнал изменений, привязанные конкуренты.
  const campName = new Map(listCampaigns(mp).map(c => [String(c.id), { name: c.name || `кампания ${c.id}`, status: String(c.status ?? '') }]));
  const campsBySku = new Map<string, Set<string>>();
  for (const it of listItems(mp)) { const s = campsBySku.get(String(it.sku)) ?? new Set(); s.add(String(it.campaign_id)); campsBySku.set(String(it.sku), s); }
  const dayStart = Date.parse(addDays(D, -1) + 'T00:00:00+03:00'), dayEnd = Date.parse(D + 'T23:59:59+03:00');
  const changes = listChanges(500).filter(c => c.mp === mp && c.at >= dayStart && c.at <= dayEnd && c.status === 'applied');
  const links = getAllLinks(mp);
  const compIds = new Set<string>();
  const ourIds = new Set<string>();
  for (const k of keys) { const a = adSkuOf(k); if (a) ourIds.add(a); }
  for (const ls of Object.values(links)) for (const l of ls) if (l.status !== 'ignored') compIds.add(String(l.nmId));
  const cards = compCardSeries(mp, [...compIds, ...ourIds], addDays(D, -10), D);
  const wbPos = mp === 'wb' ? posSeries(mp, addDays(D, -10), D) : new Map<string, Map<string, number>>();
  /** Последнее значение ряда витрины на дату (не позже). */
  const onDate = (id: string, date: string) => {
    const m = cards.get(id);
    if (!m) return null;
    let best: { price: number | null; stock: number | null } | null = null;
    for (const [d, x] of m) if (d <= date) best = x;
    return best;
  };
  const firstIn = (id: string, from: string, to: string) => {
    const m = cards.get(id);
    if (!m) return null;
    for (const [d, x] of m) if (d >= from && d <= to && x.price != null) return { date: d, ...x };
    return null;
  };

  const products: Ads2AdvisorProduct[] = [];
  for (const k of work) {
    const it = item.get(k);
    const adSku = adSkuOf(k);
    const o = at(k, 'ordered_cnt', iD) ?? 0, ob = avgBase(k, 'ordered_cnt');
    const rev = at(k, 'ordered_amount', iD) ?? 0, revB = avgBase(k, 'ordered_amount');
    if (ob < 0.5 && o < 2) continue; // товар без продаж — не о чем говорить
    const delta = rev - revB;
    const causes: Ads2AdvisorCause[] = [];
    const add = (code: string, level: Ads2AdvisorCause['level'], text: string) => causes.push({ code, level, text, action: ADVISOR_LABEL[code]?.action });

    // 1. Остаток на день (снимок РНП за этот день; если нет — последний до него).
    let stockD: number | null = at(k, 'stocks', iD);
    if (stockD == null) for (let i = (iD ?? rnp.dates.length) - 1; i >= 0 && stockD == null; i--) stockD = at(k, 'stocks', i);
    if (stockD === 0) add('stock_out', 'critical', `Остаток к продаже ${ddmm(D)}: 0 шт (FBO ${at(k, 'stocks_fbo', iD) ?? 0}, FBS ${at(k, 'stocks_fbs', iD) ?? 0})`);
    else if (stockD != null && ob > 0 && stockD / ob < 3) add('stock_low', 'warn', `Остатка ${nf.format(stockD)} шт — на ${f1(stockD / ob)} дн при ${f1(ob)} заказах в день`);

    // 2. Реклама: расход дня против среднего, и что меняли в кампаниях.
    const sp = at(k, 'adv_expenses', iD) ?? 0, spB = avgBase(k, 'adv_expenses');
    const camps = adSku ? campsBySku.get(adSku) : undefined;
    const ev = changes.filter(c => (adSku && String(c.sku ?? '').split(/,\s*/).includes(adSku)) || (c.campaign_id && camps?.has(String(c.campaign_id))));
    const STATUS_RU: Record<string, string> = { active: 'идёт', paused: 'на паузе', out_of_budget: 'кончился бюджет', ready: 'не запущена', finished: 'завершена', archived: 'в архиве' };
    const campNow = camps ? [...camps].map(id => campName.get(id)).filter(Boolean).slice(0, 2).map(x => `«${x!.name.slice(0, 70)}» — ${STATUS_RU[x!.status] ?? x!.status}`).join('; ') : '';
    const campText = campNow ? ` · сейчас: ${campNow}` : ' · товар не в кампаниях';
    const evText = ev.length ? ` · в кампаниях меняли: ${ev.slice(0, 3).map(c => `${c.action}${c.actor === 'autopilot' ? ' (автопилот)' : ''}`).join(', ')}` : '';
    if (spB >= 100 && sp < spB * 0.1) add('ads_off', 'critical', `Расход на рекламу ${rub(sp)} против ${rub(spB)} в среднем — реклама почти не крутилась${evText}${campText}`);
    else if (spB >= 100 && sp < spB * 0.5) add('ads_down', 'warn', `Расход на рекламу ${rub(sp)} против ${rub(spB)} (${sign(pctCh(sp, spB) ?? 0)}%)${evText}`);
    else if (spB >= 50 && sp > spB * 1.6 && delta > 0) add('ads_up', 'good', `Расход на рекламу ${rub(sp)} против ${rub(spB)} (${sign(pctCh(sp, spB) ?? 0)}%)`);

    // 3. Позиция в поиске: Ozon — РНП (средневзвешенная по дням), WB — отчёт кабинета за день.
    let posD: number | null = null, posB: number | null = null;
    if (mp === 'ozon') {
      const w = at(k, 'pos_weight', iD), s = at(k, 'pos_wsum', iD);
      posD = w ? s! / w : null;
      const wb = sumBase(k, 'pos_weight'), sb = sumBase(k, 'pos_wsum');
      posB = wb ? sb! / wb : null;
    } else if (adSku) {
      const m = wbPos.get(adSku);
      if (m) {
        posD = m.get(D) ?? null;
        const prev = [...m.entries()].filter(([d]) => d >= baseFrom && d <= baseTo).map(([, p]) => p);
        posB = prev.length ? prev.reduce((a, b) => a + b, 0) / prev.length : null;
      }
    }
    if (posD != null && posB != null) {
      if (posD - posB >= Math.max(2, posB * 0.25)) add('position_down', 'warn', `Средняя позиция в поиске ${f1(posD)} против ${f1(posB)} — карточка ниже в выдаче`);
      else if (posB - posD >= Math.max(2, posB * 0.25) && delta > 0) add('position_up', 'good', `Позиция ${f1(posD)} против ${f1(posB)} — выше в выдаче`);
    }

    // 4. Наша цена: цена продавца за штуку и СПП (по заказам дня против базы).
    const unit = (amount: number | null, cnt: number | null) => (amount && cnt ? amount / cnt : null);
    const pD = unit(at(k, 'ordered_amount', iD), at(k, 'ordered_cnt', iD)), pB = unit(sumBase(k, 'ordered_amount'), sumBase(k, 'ordered_cnt'));
    if (pD && pB) {
      const ch = pctCh(pD, pB)!;
      if (ch >= 5) add('price_up', 'warn', `Цена продавца ${rub(pD)} против ${rub(pB)} (${sign(ch)}%)`);
      else if (ch <= -5 && delta > 0) add('price_down', 'good', `Цена продавца ${rub(pD)} против ${rub(pB)} (${ch}%)`);
    }
    const sppD = (() => { const b = at(k, 'spp_base', iD), d = at(k, 'spp_disc', iD); return b ? d! / b * 100 : null; })();
    const sppB = (() => { const b = sumBase(k, 'spp_base'), d = sumBase(k, 'spp_disc'); return b ? d! / b * 100 : null; })();
    if (sppD != null && sppB != null && sppB - sppD >= 3) add('spp_down', 'warn', `СПП ${f1(sppD)}% против ${f1(sppB)}% — для покупателя товар подорожал`);

    // 5. Конкуренты (привязанные; подтверждённые главнее предложенных).
    const art = up(mp === 'wb' ? it?.article : k);
    const mine = (links[art] ?? []).filter(l => l.status !== 'ignored');
    const confirmed = mine.filter(l => l.status === 'active');
    const pool = confirmed.length ? confirmed : mine;
    const ourNow = adSku ? onDate(adSku, D)?.price ?? null : null;
    for (const l of pool) {
      const id = String(l.nmId);
      const now = onDate(id, D), was = firstIn(id, addDays(D, -7), addDays(D, -1));
      const nm = (l.title || id).slice(0, 40);
      if (now?.price != null && was?.price != null && was.date < D) {
        const ch = pctCh(now.price, was.price)!;
        if (ch <= -7) add('comp_cheaper', 'warn', `Конкурент «${nm}» снизил цену: ${rub(was.price)} → ${rub(now.price)} (${ch}%) с ${ddmm(was.date)}${ourNow ? `; наша ${rub(ourNow)}` : ''}${l.status === 'suggested' ? ' (конкурент не подтверждён)' : ''}`);
      }
      if (now?.stock === 0 && was && was.stock != null && was.stock > 0 && delta > 0) add('comp_out', 'good', `У конкурента «${nm}» кончился товар`);
    }

    // 6. Воронка: переходы в карточку и конверсии.
    const vD = at(k, 'session_view_pdp', iD), vB = avgBase(k, 'session_view_pdp');
    const cD = at(k, 'hits_tocart', iD), cB = avgBase(k, 'hits_tocart');
    if (vD != null && vB >= 20) {
      if (vD < vB * 0.7) add('traffic_down', 'info', `Переходов в карточку ${nf.format(vD)} против ${nf.format(vB)} в среднем (${sign(pctCh(vD, vB) ?? 0)}%)`);
      else if (vD > vB * 1.4 && delta > 0) add('traffic_up', 'good', `Переходов в карточку ${nf.format(vD)} против ${nf.format(vB)}`);
      if (cD != null && vD >= 20 && vB > 0 && cB > 0) {
        const convD = cD / vD * 100, convB = cB / vB * 100;
        if (convD < convB * 0.7) add('card_conv_down', 'warn', `В корзину кладут ${f1(convD)}% переходов против ${f1(convB)}%`);
        if (cD >= 5 && cB >= 3) {
          const toOrdD = o / cD * 100, toOrdB = ob / cB * 100;
          if (toOrdD < toOrdB * 0.6) add('cart_conv_down', 'warn', `Из корзины заказали ${f1(toOrdD)}% против ${f1(toOrdB)}%`);
        }
      }
    }

    const order = delta < 0 ? DOWN_ORDER as readonly string[] : UP_ORDER as readonly string[];
    let primary = order.find(c => causes.some(x => x.code === c)) ?? (delta < 0 ? 'unknown' : 'growth');
    // Редкие продажи (меньше 2 в день): день без заказа — обычный разброс. Если нет «жёсткой»
    // причины (остаток, реклама, позиция, цена, конкурент) — не пугаем выводами о конверсии.
    const HARD = ['stock_out', 'ads_off', 'ads_down', 'position_down', 'price_up', 'spp_down', 'comp_cheaper'];
    if (delta < 0 && ob < 2 && o <= Math.floor(ob) && !HARD.includes(primary)) {
      primary = 'low_volume';
      causes.splice(0, causes.length, { code: 'low_volume', level: 'info', text: `В среднем ${f1(ob)} заказа в день — ${o ? 'один заказ' : 'день без заказа'} в пределах обычного разброса`, action: ADVISOR_LABEL.low_volume.action });
    }
    // Причины без отношения к направлению (рост при просадке и наоборот) — не путаем менеджера.
    const shown = causes.filter(c => (delta < 0 ? c.level !== 'good' : c.level === 'good' || c.code === 'stock_low' || c.code === 'stock_out'));
    products.push({
      key: k, adSku, article: it?.article || k, name: it?.name ?? '', photo: it?.photo ?? '',
      link: adSku ? (mp === 'wb' ? `https://www.wildberries.ru/catalog/${adSku}/detail.aspx` : `https://www.ozon.ru/product/${adSku}/`) : null,
      orders: o, ordersBase: r1(ob), revenue: r0(rev), revenueBase: r0(revB), delta: r0(delta), causes: shown, primary,
    });
  }

  const down = products.filter(p => p.delta < 0 && (p.ordersBase - p.orders >= 1 || p.delta < -3000)).sort((a, b) => Number(a.primary === 'low_volume') - Number(b.primary === 'low_volume') || a.delta - b.delta);
  const upList = products.filter(p => p.delta > 0 && (p.orders - p.ordersBase >= 1 || p.delta > 3000)).sort((a, b) => b.delta - a.delta);

  // Главные причины дня: просадка по главной причине товаров.
  const byCause = new Map<string, { delta: number; products: number }>();
  for (const p of down) { const x = byCause.get(p.primary) ?? { delta: 0, products: 0 }; x.delta += p.delta; x.products++; byCause.set(p.primary, x); }
  // «Обычный разброс» и «не видно причины» — в конец: это не то, с чем работать.
  const soft = (c: string) => (c === 'low_volume' || c === 'unknown' ? 1 : 0);
  const drivers = [...byCause.entries()].map(([code, x]) => ({ code, label: ADVISOR_LABEL[code]?.label ?? code, delta: r0(x.delta), products: x.products, action: ADVISOR_LABEL[code]?.action ?? '' }))
    .sort((a, b) => soft(a.code) - soft(b.code) || a.delta - b.delta);

  // Короткий вывод.
  const summary: string[] = [];
  const chO = pctCh(day.orders, base.orders), chR = pctCh(day.revenue, base.revenue);
  if (iD != null) {
    const vs = (ch: number | null) => (ch == null ? '' : ` (${sign(ch)}% к среднему)`);
    summary.push(`${ddmm(D)}: заказов ${nf.format(day.orders)}${vs(chO)}, выручка ${kRub(day.revenue)}${vs(chR)}. Среднее за 7 дней до этого: ${nf.format(base.orders)} заказов и ${kRub(base.revenue)} в день.`);
    if (chO != null && chR != null && Math.abs(chO - chR) >= 30) {
      summary.push(chR > chO
        ? 'Выручка и заказы разошлись: заказов меньше, но среди них дорогие товары — смотрите обе цифры.'
        : 'Выручка и заказы разошлись: заказов больше, но дешёвых — дорогие товары продались хуже обычного.');
    }
    if (weekAgo && weekAgo.revenue > 0) {
      const w = pctCh(day.revenue, weekAgo.revenue)!, wo = pctCh(day.orders, weekAgo.orders);
      summary.push(`Против того же дня неделю назад (${ddmm(addDays(D, -7))}): заказы ${wo == null ? '–' : `${sign(wo)}%`}, выручка ${sign(w)}%${Math.abs(w) < 10 && chR != null && chR <= -15 ? ' — похоже на обычный спад этого дня недели' : ''}.`);
    }
    if (day.spend || base.spend) summary.push(`Реклама: ${rub(day.spend)} против ${rub(base.spend)} в среднем, ДРР ${day.drr == null ? '–' : f1(day.drr)}% против ${base.drr == null ? '–' : f1(base.drr)}%.`);
    const losers = products.filter(p => p.ordersBase >= 1);
    const share = losers.length ? losers.filter(p => p.delta < 0).length / losers.length : 0;
    if (chR != null && chR <= -15 && share >= 0.65) summary.push(`Просели ${Math.round(share * 100)}% товаров с продажами — спад общий по площадке (спрос, день недели, сбой площадки), а не в отдельных карточках.`);
    else {
      const main = drivers.find(x => x.delta < 0 && x.code !== 'low_volume' && x.code !== 'unknown');
      if (main) summary.push(`Больше всего выручки забрало: «${main.label}» — ${kRub(-main.delta)} (${main.products} тов.). ${main.action}.`);
    }
    if (chR != null && chR > 10 && upList[0]) summary.push(`Рост дал прежде всего «${upList[0].name || upList[0].article}» (${sign(r0(upList[0].delta / 1000))} тыс ₽).`);
  }
  // Технические карточки (цена за штуку до 150 ₽ и десятки заказов в день) искажают число заказов.
  const tech = work.filter(k => {
    for (const i of [...baseI, iD ?? -1]) {
      const c = at(k, 'ordered_cnt', i), a = at(k, 'ordered_amount', i);
      if (c && c >= 20 && a != null && a / c < 150) return true;
    }
    return false;
  }).map(k => item.get(k)?.article || k);
  if (tech.length) notes.push(`Похоже на технические карточки (цена до 150 ₽, десятки заказов в день): ${tech.slice(0, 8).join(', ')}${tech.length > 8 ? ` и ещё ${tech.length - 8}` : ''} — они искажают число заказов. Уберите их в архив: «Реклама» → «Товары» → галочки → «В архив».`);
  if (!cards.size) notes.push('История цен конкурентов копится с 15.10.2026 — сравнение «конкурент снизил цену» заработает через 1–2 дня после первых замеров.');
  if (mp === 'wb' && !wbPos.size) notes.push('Позиция WB по дням появится после первого ночного прохода Агента 3 с новым отчётом (с 16.10.2026).');

  return {
    ok: true, mp, date: D, baseFrom, baseTo, dates, day, base, weekAgo, summary, drivers,
    down: down.slice(0, 25), up: upList.slice(0, 10), notes: [...new Set(notes)],
  };
}
