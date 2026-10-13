import type { ReactNode } from 'react';
import { MagnifyingGlassIcon, ClockIcon, SpinnerIcon, XIcon } from '@phosphor-icons/react';

// Панель фильтров «Цен» (13.10.2026) — по образцу «РНП»: сверху переключатели
// (какие товары показать и сортировка), ниже поиск и время проверки витрины.
// Одна и та же для WB и Ozon, чтобы вкладки выглядели одинаково.
export type ListMode = 'sale' | 'all' | 'archive';
export type PriceSort = 'price' | 'margin' | 'roi' | 'name';

const SORTS: [PriceSort, string][] = [['price', 'цена'], ['margin', 'маржа'], ['roi', 'ROI'], ['name', 'название']];

export function PriceToolbar({
  mode, onMode, counts, saleHint, search, onSearch, searchPlaceholder, sortBy, onSort, checkedAt, checkedHint, loading,
}: {
  mode: ListMode;
  onMode: (m: ListMode) => void;
  counts: { sale: number; all: number; archive: number };
  saleHint: string;
  search: string;
  onSearch: (v: string) => void;
  searchPlaceholder: string;
  sortBy: PriceSort;
  onSort: (s: PriceSort) => void;
  checkedAt: string;
  checkedHint: string;
  loading?: boolean;
}) {
  const modes: [ListMode, string, number, string][] = [
    ['sale', 'В продаже', counts.sale, saleHint],
    ['all', 'Все', counts.all, 'Все товары, кроме архива'],
    ['archive', 'Архив', counts.archive, 'Товары, убранные в архив кнопкой в строке'],
  ];
  return (
    <section className="card pr-filters">
      <div className="pr-frow">
        <div className="period-switch" role="group" aria-label="Какие товары показать">
          {modes.map(([k, l, n, hint]) => (
            <button key={k} className={`period-btn ${mode === k ? 'active' : ''}`} onClick={() => onMode(k)} title={hint}>
              {l} <span className="pr-count">{n}</span>
            </button>
          ))}
        </div>
        <div className="pr-sort">
          <span className="muted">Сортировка</span>
          <div className="period-switch" role="group" aria-label="Сортировка">
            {SORTS.map(([k, l]) => (
              <button key={k} className={`period-btn ${sortBy === k ? 'active' : ''}`} onClick={() => onSort(k)}
                title={k === 'name' ? 'По названию, от А до Я' : 'От большего к меньшему'}>{l}</button>
            ))}
          </div>
        </div>
      </div>
      <div className="pr-frow">
        <label className="pr-search">
          <MagnifyingGlassIcon size={16} />
          <input className="input" placeholder={searchPlaceholder} value={search} onChange={e => onSearch(e.target.value)} aria-label="Поиск товара" />
          {search && <button className="pr-search-clear" onClick={() => onSearch('')} title="Очистить поиск" aria-label="Очистить поиск"><XIcon size={13} weight="bold" /></button>}
        </label>
        <span className="pr-spacer" />
        {loading && <span className="muted pr-upd"><SpinnerIcon size={14} className="spin" /> загрузка…</span>}
        <span className="muted pr-upd" title={checkedHint}><ClockIcon size={15} /> витрина проверена {checkedAt}</span>
      </div>
    </section>
  );
}

// Плитки сводки над таблицей.
export function PriceKpis({ items }: { items: { label: string; value: ReactNode; hint?: string }[] }) {
  return (
    <div className="pr-kpis">
      {items.map(k => (
        <div key={k.label} className="pr-kpi" title={k.hint}>
          <span className="pr-kpi-label">{k.label}</span>
          <span className="pr-kpi-value">{k.value}</span>
        </div>
      ))}
    </div>
  );
}
