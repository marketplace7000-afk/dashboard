/**
 * Общие настройки модулей цен WB и Ozon (вынесено 20.10.2026 из LiveWbPricing /
 * LiveOzonPricing — там был один и тот же код в двух копиях).
 *
 * Всё хранится в общей памяти UI под ключами `${prefix}:…`:
 *   - knobs / knobs-base — ручные значения калькулятора по строке и их «база»
 *     (src/utils/knobs.ts);
 *   - globalParams — глобальные параметры расчёта (панель сверху);
 *   - inStockOnly — переключатель «В продаже / Все»;
 *   - архив SKU — отдельный scope `${prefix}` (procurementLogic).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { safeSetItem } from '../utils/safeStorage';
import { onUiStateChange } from '../utils/uiState';
import { noteSwallowed } from '../utils/log';
import { archiveSKU, unarchiveSKU, getArchivedSKUs } from '../utils/procurementLogic';
import type { KnobBase } from '../utils/knobs';
import type { ListMode } from './PriceToolbar';

export type PricingPrefix = 'prices-wb' | 'prices-ozon';
export type KnobMap = Record<number, Record<string, string>>;

const num = (v: any) => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
export const fmt = (v: any) => num(v).toLocaleString('ru-RU') + ' ₽';

// % выкупа из таблицы: значение хранится долей (0.92) — переводим в проценты; если
// вдруг уже в процентах (>1.5) — берём как есть; пусто/0 → фолбэк 88% (просьба клиента 21.07).
export const buyoutPct = (v?: number | null): number =>
  (v && v > 0) ? (v > 1.5 ? Math.round(v) : Math.round(v * 100)) : 88;

const readJson = <T,>(key: string): T => { try { return JSON.parse(localStorage.getItem(key) || '{}'); } catch { return {} as T; } };
const writeJson = (key: string, v: unknown, what: string) => {
  try { safeSetItem(key, JSON.stringify(v)); } catch (e) { noteSwallowed('ui-prefs', what, e, 60 * 60_000); }
};

export function usePricingPrefs(prefix: PricingPrefix) {
  const KNOBS_LS = `${prefix}:knobs`;
  const KNOBS_BASE_LS = `${prefix}:knobs-base`;
  const GP_LS = `${prefix}:globalParams`;
  const STOCK_LS = `${prefix}:inStockOnly`;

  // Крутилки калькулятора: храним СЫРУЮ строку из инпута (в т.ч. пустую), чтобы
  // поле можно было свободно стереть и вписать своё. В расчёт идёт распарсенное
  // число, пустое/битое → откат к значению по умолчанию.
  const loadKnobs = () => readJson<KnobMap>(KNOBS_LS);
  const saveKnobs = (n: KnobMap) => writeJson(KNOBS_LS, n, 'сценарий не сохранён');
  const [knobs, setKnobs] = useState<KnobMap>(loadKnobs);
  // База ручных значений (05.10.2026, см. src/utils/knobs.ts): что было «по данным»
  // в момент ввода. Данные обновились — ручное значение по этому полю снимается.
  const loadBase = () => readJson<KnobBase>(KNOBS_BASE_LS);
  const saveBase = (n: KnobBase) => writeJson(KNOBS_BASE_LS, n, 'сценарий не сохранён');
  const [knobsBase, setKnobsBase] = useState<KnobBase>(loadBase);
  const setKnob = (id: number, k: string, v: string, auto?: number) => {
    setKnobs(prev => { const n = { ...prev, [id]: { ...prev[id], [k]: v } }; saveKnobs(n); return n; });
    if (auto !== undefined && Number.isFinite(auto)) {
      setKnobsBase(prev => { const n = { ...prev, [id]: { ...prev[id], [k]: auto } }; saveBase(n); return n; });
    }
  };
  const resetKnobs = (id: number) => {
    setKnobs(prev => { const n = { ...prev }; delete n[id]; saveKnobs(n); return n; });
    setKnobsBase(prev => { if (!prev[id]) return prev; const n = { ...prev }; delete n[id]; saveBase(n); return n; });
  };
  // Результат чистки устаревших ручных значений (pruneKnobs) — в состояние и в память.
  const replaceKnobs = (k: KnobMap, base: KnobBase) => {
    setKnobs(k); saveKnobs(k);
    setKnobsBase(base); saveBase(base);
  };

  // Переключатель «В продаже / Все / Архив» (13.10.2026); выбор «в продаже» запоминается.
  // Фильтр «только в продаже» включён по умолчанию — мёртвые SKU не мешаются (09.07).
  const [showArchive, setShowArchive] = useState(false);
  const [inStockOnly, setInStockOnly] = useState<boolean>(() => {
    try { return localStorage.getItem(STOCK_LS) !== '0'; } catch { return true; }
  });
  const setListMode = (m: ListMode) => {
    setShowArchive(m === 'archive');
    if (m === 'archive') return;
    setInStockOnly(m === 'sale');
    try { localStorage.setItem(STOCK_LS, m === 'sale' ? '1' : '0'); } catch (e) { noteSwallowed('ui-prefs', 'настройка интерфейса не сохранена', e, 60 * 60_000); }
  };
  const listMode: ListMode = showArchive ? 'archive' : inStockOnly ? 'sale' : 'all';

  // Глобальные параметры расчёта (панель сверху): draft — что в полях, applied — что
  // реально применено. Пусто → берётся факт по товару. Крутилка строки главнее.
  const loadGP = () => readJson<Record<string, string>>(GP_LS);
  const [gpDraft, setGpDraft] = useState<Record<string, string>>(loadGP);
  const [gpApplied, setGpApplied] = useState<Record<string, string>>(loadGP);
  const gpAppliedRef = useRef(gpApplied);
  gpAppliedRef.current = gpApplied;
  const gpChange = (k: string, v: string) => setGpDraft(p => ({ ...p, [k]: v }));
  const gpApply = () => { setGpApplied(gpDraft); writeJson(GP_LS, gpDraft, 'настройка интерфейса не сохранена'); };
  const gpReset = () => { setGpDraft({}); setGpApplied({}); writeJson(GP_LS, {}, 'настройка интерфейса не сохранена'); };
  // Значение глоб. параметра (или fallback, если поле пустое/битое).
  const gp = (k: string, fb: number): number => {
    const s = gpApplied[k];
    if (s == null || s.trim() === '') return fb;
    const n = parseFloat(s.replace(',', '.'));
    return isNaN(n) ? fb : n;
  };

  // Архив — раздельный scope на каждую площадку.
  const [archiveTick, setArchiveTick] = useState(0);
  const archivedSet = useMemo(() => new Set(getArchivedSKUs(prefix)), [archiveTick, prefix]);
  const onArchive = (code: string) => {
    // Хранилище браузера могло переполниться — тогда молча ничего не происходило
    // и кнопка выглядела нерабочей (жалоба 01.08). Теперь говорим прямо.
    if (!archiveSKU(code.toUpperCase(), prefix)) {
      alert('Не удалось сохранить: в браузере кончилось место. Обновите страницу и попробуйте снова.');
      return;
    }
    setArchiveTick(t => t + 1);
  };
  const onUnarchive = (code: string) => { unarchiveSKU(code.toUpperCase(), prefix); setArchiveTick(t => t + 1); };

  // Общая память: пришли изменения с сервера (другой пользователь/вкладка) — перечитать архив, параметры, сценарии.
  useEffect(() => onUiStateChange(() => { setArchiveTick(t => t + 1); const gp = loadGP();
    // Черновик (введено, но не применено) не трогаем: синхронизация раз в 30 с стирала ввод.
    setGpDraft(d => JSON.stringify(d) === JSON.stringify(gpAppliedRef.current) ? gp : d);
    setGpApplied(gp); setKnobs(loadKnobs()); setKnobsBase(loadBase()); }), []);

  return {
    knobs, knobsBase, setKnob, resetKnobs, replaceKnobs,
    showArchive, inStockOnly, listMode, setListMode,
    gpDraft, gpChange, gpApply, gpReset, gp,
    archivedSet, onArchive, onUnarchive,
  };
}
