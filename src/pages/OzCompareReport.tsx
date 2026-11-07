/**
 * «Конкуренты» Ozon → кнопка «Расширенные показатели Ozon» у товара (05.11.2026).
 * По ТЗ менеджера «Ozon Competitor Intelligence»: наш товар + до 3 конкурентов, все показатели
 * «Товаров на Ozon» за 7 или 28 дней, расчёты раздела 4 (shared/ozCompare.ts), лидер в строке,
 * сопоставимые полоски, выводы «Наблюдение / Гипотеза / Риск / Предупреждение» с основанием,
 * подсказка с полем и формулой у каждой строки, CSV и копирование выводов.
 * Ничего не выдумываем: нет значения в отчёте — «н/д».
 */
import { Fragment, useMemo, useState } from 'react';
import type { Ads2WatchLink, Ads2WatchProduct } from '../../shared/ads2';
import { OZ_METHOD, ozInsights, ozMetrics, type Ads2OzMetrics, type Ads2OzRow, type OzInsight } from '../../shared/ozCompare';
import { nf0, when } from './ads2ui';

type Per = 7 | 28;
type Cell = number | string | null;
type Row = {
  label: string;
  /** Определение · поле отчёта · формула — в подсказке. */
  tip: string;
  get: (r: Ads2OzRow, m: Ads2OzMetrics) => Cell;
  fmt: (v: Cell, r: Ads2OzRow) => string;
  /** Подсветить лидера среди сравниваемых (больше — лучше). */
  best?: boolean;
  /** Полоска для сравнения по одной метрике. */
  bar?: boolean;
  /** Строка-оценка: показываем приглушённо, с «≈». */
  est?: boolean;
};

const ND = 'н/д';
const nf2 = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const isNum = (v: Cell): v is number => typeof v === 'number' && Number.isFinite(v);
const cnt = (v: Cell) => (isNum(v) ? nf0.format(v) : ND);
const pc = (v: Cell) => (isNum(v) ? `${nf2.format(v)} %` : ND);
const rb = (v: Cell) => (isNum(v) ? `${nf0.format(v)} ₽` : ND);
const days = (v: Cell, of: number) => (isNum(v) ? `${nf0.format(v)} из ${of}` : ND);
const txt = (v: Cell) => (v == null || v === '' ? ND : String(v));
const dmy = (s: Cell) => (typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s.split('-').reverse().join('.') : ND);

const GROUPS: { title: string; note?: string; rows: Row[] }[] = [
  { title: 'Охват и воронка', note: 'Воронка условная: показы, просмотры поиска и просмотры карточки — разные счётчики Ozon, переходы между ними — не прямая атрибуция', rows: [
    { label: 'Показы всего', tip: 'Счётчик показов карточки. Поле отчёта «Показы всего»', get: r => r.views, fmt: cnt, best: true, bar: true },
    { label: 'Просмотры в поиске и каталоге', tip: 'Отдельный счётчик событий — не доказывает источник показов. Поле «Просмотры в поиске и каталоге»', get: r => r.searchViews, fmt: cnt, bar: true },
    { label: 'Просмотры карточки', tip: 'Все просмотры карточки (не уникальные). Поле «Просмотры карточки»', get: r => r.pdpViews, fmt: cnt, best: true, bar: true },
    { label: 'CTR proxy, %', tip: 'Условный коэффициент, НЕ официальный CTR Ozon.\nФормула: 100 × просмотры карточки ÷ показы всего', get: (_, m) => m.ctrProxy, fmt: pc, best: true },
    { label: 'Карточка ÷ поиск, %', tip: 'Контекстный показатель, не вложенная воронка — может быть больше 100 %.\nФормула: 100 × просмотры карточки ÷ просмотры в поиске и каталоге', get: (_, m) => m.pdpToSearch, fmt: pc },
    { label: 'Разница счётчиков, шт', tip: 'Диагностическая разница событий. НЕ «рекламные показы».\nФормула: показы всего − просмотры в поиске и каталоге', get: (_, m) => m.gap, fmt: cnt },
    { label: 'Доля разницы, %', tip: 'Соотношение счётчиков, НЕ доля платного трафика.\nФормула: 100 × (показы − просмотры поиска) ÷ показы', get: (_, m) => m.gapShare, fmt: pc },
    { label: 'В корзину из поиска и каталога, %', tip: 'Как в отчёте Ozon. Поле «В корзину из поиска и каталога, %»', get: r => r.toCartSearch, fmt: pc, best: true },
    { label: 'В корзину из карточки, %', tip: 'Как в отчёте Ozon. Поле «В корзину из карточки, %»', get: r => r.toCartPdp, fmt: pc, best: true },
    { label: 'Конверсия из показа в заказ, %', tip: 'Как в отчёте Ozon. Поле «Конверсия из показа в заказ, %»', get: r => r.viewToOrder, fmt: pc, best: true },
    { label: 'Заказы ÷ просмотры карточки, %', tip: 'Условная конверсия: заказы и просмотры могут не совпадать по пользователям и окнам.\nФормула: 100 × заказано, шт ÷ просмотры карточки', get: (_, m) => m.crPdp, fmt: pc, best: true },
  ] },
  { title: 'Продажи и цена', rows: [
    { label: 'Оборот (заказано на сумму), ₽', tip: 'Поле «Заказано на сумму, ₽»', get: r => r.gmv, fmt: rb, best: true, bar: true },
    { label: 'Заказано, шт', tip: 'Поле «Заказано, штуки»', get: r => r.orders, fmt: cnt, best: true, bar: true },
    { label: 'Динамика оборота, %', tip: 'К прошлому такому же периоду. Поле «Динамика оборота, %»', get: r => r.dyn, fmt: v => (isNum(v) ? `${v > 0 ? '+' : ''}${nf0.format(v)} %` : ND), best: true },
    { label: 'Средний чек, ₽', tip: 'Формула: оборот ÷ заказано, шт. Сверять со средней ценой', get: (_, m) => m.avgCheck, fmt: rb },
    { label: 'Средняя цена, ₽', tip: 'Поле «Средняя цена, ₽»', get: r => r.avgPrice, fmt: rb },
    { label: 'Минимальная цена, ₽', tip: 'Поле «Минимальная цена, ₽»', get: r => r.minPrice, fmt: rb },
    { label: 'Скидка от медианной цены, %', tip: 'Поле «Скидка от медианной цены, %»', get: r => r.discount, fmt: pc },
    { label: 'Заказы на 1000 показов', tip: 'Эффективность общего охвата.\nФормула: 1000 × заказано, шт ÷ показы всего', get: (_, m) => m.ordersPer1k, fmt: v => (isNum(v) ? nf2.format(v) : ND), best: true },
    { label: 'Оборот на 1000 показов, ₽', tip: 'Валовая отдача охвата, не прибыль.\nФормула: 1000 × оборот ÷ показы всего', get: (_, m) => m.gmvPer1k, fmt: rb, best: true },
  ] },
  { title: 'Продвижение и акции', note: 'Реклама и акции — независимые признаки. «0 дней продвижения» при ДРР больше 0 возможно из-за определения показателя у Ozon — это не значит, что рекламы точно не было', rows: [
    { label: 'Дней с продвижением', tip: 'Число дней из периода, не бюджет и не каналы. Поле «Дней с продвижением»', get: r => r.adsDays, fmt: (v, r) => days(v, r.period) },
    { label: 'Дней в акциях', tip: 'Поле «Дней в акциях»', get: r => r.promoDays, fmt: (v, r) => days(v, r.period) },
    { label: 'Доля суммы заказов по акциям, %', tip: 'Поле «Доля суммы заказов по акциям, %»', get: r => r.promoShare, fmt: pc },
    { label: 'ДРР, %', tip: 'Доля рекламных расходов в обороте — как в отчёте; не равна доле платного трафика. Поле «Доля рекламных расходов, %»', get: r => r.drr, fmt: pc },
    { label: 'Оценка расходов на рекламу, ₽', tip: 'НЕПРОВЕРЕННАЯ оценка: база ДРР и окно могут не совпадать с оборотом. Не фактический расход.\nФормула: оборот × ДРР ÷ 100', get: (_, m) => m.adCostEst, fmt: v => (isNum(v) ? `≈ ${nf0.format(v)} ₽` : ND), est: true },
    { label: 'ROAS по ДРР, x', tip: 'Математическое преобразование ДРР, НЕ точный ROAS кампаний.\nФормула: 100 ÷ ДРР', get: (_, m) => m.roasProxy, fmt: v => (isNum(v) ? `≈ ${nf2.format(v)}` : ND), est: true },
  ] },
  { title: 'Ограничения и карточка', rows: [
    { label: 'Остаток на конец периода, шт', tip: 'Поле «Остаток на конец периода, штуки»', get: r => r.stock, fmt: cnt },
    { label: 'Остатка хватит на, дней', tip: 'Грубая оценка при ровном спросе, без поставок и возвратов.\nФормула: остаток ÷ (заказано, шт ÷ дней периода)', get: (_, m) => m.stockCover, fmt: v => (isNum(v) ? nf0.format(v) : ND), est: true },
    { label: 'Дней без остатка (как в отчёте Ozon)', tip: 'Поле «Дней без остатка» — Ozon всегда считает его из 28 дней, при любом периоде.\nУ карточек с большим остатком значение часто близко к 28, поэтому выводы по нему одному не делаем', get: r => r.stockDays, fmt: v => days(v, 28) },
    { label: 'Упущенные продажи, ₽', tip: 'Поле «Упущенные продажи» — оценка Ozon', get: r => r.missed, fmt: rb },
    { label: 'Доля выкупа, %', tip: 'Поле «Доля выкупа, %»', get: r => r.buyout, fmt: pc, best: true },
    { label: 'Дата создания карточки', tip: 'Поле «Дата создания карточки товара»', get: r => r.created, fmt: dmy },
    { label: 'Схема работы', tip: 'Поле «Схема работы»', get: r => r.schema, fmt: txt },
    { label: 'Признак товара', tip: 'Поле «Признак товара»', get: r => r.bin, fmt: txt },
    { label: 'Категория', tip: 'Поле «Категория 3 уровня»', get: r => r.category, fmt: txt },
  ] },
];

/** Бренд, а если Ozon пишет «без бренда» — продавец. */
const who = (l: Ads2WatchLink) => (l.brand && !/^без бренда$/i.test(l.brand.trim()) ? l.brand : l.seller || l.brand || '');

type Card = { id: string; name: string; photo: string; url: string; brand: string; ours: boolean; row: Ads2OzRow | null; noSales7: boolean };

const LEVEL_CLS: Record<OzInsight['level'], string> = { 'Наблюдение': 'info', 'Гипотеза': 'warn', 'Риск': 'bad', 'Предупреждение': 'bad', 'Недостаточно данных': '' };

function toCard(l: Ads2WatchLink, per: Per, ours: boolean, name?: string, photo?: string): Card {
  return { id: l.id, name: l.title || name || `SKU ${l.id}`, photo: l.photo || photo || '', url: l.url || `https://www.ozon.ru/product/${l.id}`, brand: who(l),
    ours, row: (per === 28 ? l.ozx28 : l.ozx) ?? null, noSales7: per === 7 && !!l.noSales7 };
}

/** Текст выводов для копирования (в чат, в заметки). */
function insightsText(cards: Card[], per: Per, all: Map<string, OzInsight[]>): string {
  const out = [`Выводы по «Товарам на Ozon» за ${per} дней (${when(Date.now())})`];
  for (const c of cards) {
    out.push('', `${c.ours ? 'Наш товар' : 'Конкурент'} · SKU ${c.id} · ${c.name}`);
    for (const i of all.get(c.id) ?? []) out.push(`— [${i.level}] ${i.text}. Основание: ${i.basis}. Альтернатива: ${i.alt}. Проверить: ${i.check}.`);
    if (!(all.get(c.id) ?? []).length) out.push('— правила раздела не сработали');
  }
  return out.join('\n');
}

function downloadCsv(cards: Card[], per: Per, dataAt: number | null): void {
  const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
  const lines: string[] = [
    q(`Ozon — расширенные показатели, период ${per} дней`),
    q(`Выгружено ${when(Date.now())}; данные агента от ${dataAt ? when(dataAt) : 'н/д'}`),
    q(OZ_METHOD),
    '',
    ['Показатель', ...cards.map(c => `${c.ours ? 'НАШ ' : ''}SKU ${c.id} ${c.name}`)].map(q).join(';'),
  ];
  for (const g of GROUPS) for (const row of g.rows) {
    // В CSV — точные значения (числа с запятой для Excel), без округления карточки.
    lines.push([q(row.label), ...cards.map(c => {
      if (!c.row) return q(ND);
      const v = row.get(c.row, ozMetrics(c.row));
      return isNum(v) ? String(Math.round(v * 10000) / 10000).replace('.', ',') : q(v == null ? ND : String(v));
    })].join(';'));
  }
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `ozon-sravnenie-${cards.map(c => c.id).join('-')}-${per}d.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

export function OzCompareReport({ p, perDefault, dataAt, setToast }: {
  p: Ads2WatchProduct; perDefault: Per; dataAt: number | null; setToast: (t: { ok: boolean; text: string }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [per, setPer] = useState<Per>(perDefault);
  const pool = useMemo(() => {
    return p.links.filter(l => l.status === 'active' && !l.hidden);
  }, [p.links]);
  // По ТЗ на экране максимум 3 конкурента: по умолчанию первые 3 привязанных.
  const [chosen, setChosen] = useState<string[] | null>(null);
  const sel = (chosen ?? pool.slice(0, 3).map(l => l.id)).filter(id => pool.some(l => l.id === id));
  const toggle = (id: string) => setChosen(() => {
    const cur = sel;
    if (cur.includes(id)) return cur.filter(x => x !== id);
    return cur.length >= 3 ? cur : [...cur, id];
  });
  if (!pool.length) return null;
  const cards: Card[] = [
    ...(p.our ? [toCard(p.our, per, true, p.name, p.photo)] : []),
    ...sel.map(id => pool.find(l => l.id === id)!).map(l => toCard(l, per, false)),
  ];
  const peers = cards.map(c => c.row);
  const ins = new Map(cards.map(c => [c.id, ozInsights(c.row, peers)]));
  const has = (x: Per) => [p.our, ...pool].some(l => l && (x === 28 ? l.ozx28 : l.ozx));
  const ourCat = cards.find(c => c.ours)?.row?.category ?? cards[0]?.row?.category ?? null;
  const otherCat = cards.filter(c => c.row?.category && ourCat && c.row.category !== ourCat);
  const copy = () => {
    const t = insightsText(cards, per, ins);
    navigator.clipboard?.writeText(t).then(() => setToast({ ok: true, text: 'Выводы скопированы' }), () => setToast({ ok: false, text: 'Не удалось скопировать' }));
  };
  return (
    <div className="cmp-rep oz-rep">
      <button className={`btn ${open ? '' : 'btn-primary'}`} onClick={() => setOpen(o => !o)} aria-expanded={open}>
        {open ? 'Скрыть расширенные показатели' : 'Расширенные показатели Ozon'}
      </button>
      {open && !has(7) && !has(28) && <p className="muted cmp-note">По этим карточкам «Товары на Ozon» ещё не сняты полностью — показатели появятся после ночного прохода агента.</p>}
      {open && (has(7) || has(28)) && <>
        <div className="cmp-rep-bar">
          <h3>Показатели за</h3>
          <div className="cmp-rep-per" role="group" aria-label="Период отчёта">
            {([7, 28] as const).map(x => <button key={x} className={`btn ${per === x ? 'btn-primary' : ''}`} disabled={!has(x)} onClick={() => setPer(x)}>{x} дней</button>)}
          </div>
          <div className="oz-rep-tools">
            <button className="btn" onClick={() => downloadCsv(cards, per, dataAt)}>Скачать CSV</button>
            <button className="btn" onClick={copy}>Копировать выводы</button>
          </div>
        </div>
        {pool.length > 0 && (
          <div className="oz-rep-pick" role="group" aria-label="С кем сравнить">
            <span className="muted">Сравнить с (до 3):</span>
            {pool.map(l => (
              <label key={l.id} className={`cmp-check ${sel.includes(l.id) ? 'on' : ''}`} title={l.title}>
                <input type="checkbox" checked={sel.includes(l.id)} disabled={!sel.includes(l.id) && sel.length >= 3} onChange={() => toggle(l.id)} />
                {who(l) || 'SKU'} · {l.id}
              </label>
            ))}
          </div>
        )}
        {otherCat.length > 0 && <div className="oz-rep-warn" role="alert">Другая категория: {otherCat.map(c => `SKU ${c.id} — «${c.row!.category}»`).join(', ')} (у нашего — «{ourCat}»). Сравнение таких карточек может вводить в заблуждение.</div>}
        <div className="ad2-scroll">
          <table className="ad2-table cmp-rep-table oz-rep-table">
            <colgroup><col className="cmp-rep-lab" />{cards.map(c => <col key={c.id} />)}</colgroup>
            <thead><tr>
              <th>Показатель</th>
              {cards.map(c => (
                <th key={c.id} className={c.ours ? 'cmp-rep-our' : ''}>
                  <a href={c.url} target="_blank" rel="noreferrer" title={c.name}>
                    {c.photo ? <img src={c.photo} alt="" loading="lazy" onError={e => { e.currentTarget.style.visibility = 'hidden'; }} /> : null}
                    <span className="cmp-rep-nm">{c.id}</span>
                    {c.brand && <span className="cmp-rep-brand">{c.brand}</span>}
                  </a>
                  {c.ours && <span className="chip ad2-chipsm cmp-chip-our">наш товар</span>}
                  {!c.row && <div className="cmp-sub warn">{c.noSales7 ? 'нет продаж за 7 дней — Ozon не включает в недельный отчёт' : 'нет в отчёте за период'}</div>}
                </th>
              ))}
            </tr></thead>
            <tbody>
              {GROUPS.map(g => (
                <Fragment key={g.title}>
                  <tr className="oz-rep-group"><th colSpan={cards.length + 1} scope="colgroup">{g.title}{g.note && <span className="muted"> — {g.note}</span>}</th></tr>
                  {g.rows.map(row => {
                    const vals = cards.map(c => (c.row ? row.get(c.row, ozMetrics(c.row)) : null));
                    const nums = vals.filter(isNum);
                    const max = nums.length ? Math.max(...nums) : null;
                    const lead = row.best && nums.length >= 2 && max != null && nums.filter(v => v === max).length === 1 ? max : null;
                    return (
                      <tr key={row.label}>
                        <th scope="row" title={row.tip}>{row.label}<span className="oz-rep-i" aria-hidden>ⓘ</span></th>
                        {cards.map((c, i) => {
                          const v = vals[i];
                          const isLead = lead != null && v === lead;
                          return (
                            <td key={c.id} className={[c.ours ? 'cmp-rep-our' : '', isLead ? 'oz-lead' : '', row.est ? 'oz-est' : ''].filter(Boolean).join(' ')}
                              title={isNum(v) ? `${row.label}: ${String(Math.round(v * 10000) / 10000).replace('.', ',')}${isLead ? ' — лидер среди сравниваемых' : ''}` : undefined}>
                              {c.row ? row.fmt(v, c.row) : ND}
                              {row.bar && isNum(v) && max ? <span className="oz-bar" aria-hidden><i style={{ width: `${Math.max(2, (v / max) * 100)}%` }} /></span> : null}
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
        <div className="oz-ins">
          <h3>Выводы</h3>
          <p className="muted cmp-note">Каждый вывод подписан: наблюдение, гипотеза, риск или предупреждение. У гипотез — основание, другое объяснение и что проверить руками. Это не факты о стратегии конкурента.</p>
          <div className="oz-ins-grid">
            {cards.map(c => (
              <div key={c.id} className={`oz-ins-card ${c.ours ? 'ours' : ''}`}>
                <div className="oz-ins-h">{c.ours ? 'Наш товар' : c.brand || 'Конкурент'} · {c.id}</div>
                {(ins.get(c.id) ?? []).length === 0 && <p className="muted">Правила не сработали — особых сигналов нет.</p>}
                {(ins.get(c.id) ?? []).map(i => (
                  <div key={i.id} className="oz-ins-item">
                    <span className={`chip ad2-chipsm ${LEVEL_CLS[i.level]}`}>{i.level}</span> {i.text}
                    <div className="muted oz-ins-why">Основание: {i.basis}. Может быть иначе: {i.alt}. Проверить: {i.check}.</div>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
        <p className="muted cmp-rep-note">{OZ_METHOD} Период — {per} дней{dataAt ? `, данные ночного прохода агента от ${when(dataAt)}` : ''}. Наведите на название строки — там поле отчёта и формула.</p>
      </>}
    </div>
  );
}
