/**
 * «Рука на пульсе» (РНП) — заказы, реклама, воронка и остатки по дням и товарам.
 *
 * Своя замена РнП «Культуры Аналитики» (11.10.2026): данные — из API WB и Ozon
 * по нашим ключам, сервер собирает их раз в 2 часа в базу (api/_lib/rnp.ts).
 *
 * Экран: листы WB / Ozon (как в «Ценах») → фильтры (период, свёртка по дням,
 * неделям, месяцам; строки по товарам, категориям, брендам; категория, поиск,
 * «в наличии») → выбор метрик → правила подсветки (порог, падение к прошлому
 * столбцу) и тепловая карта → таблица: на товар блок строк, по строке на метрику.
 *
 * Всё, что не базовая метрика (средний чек, ДРР, CTR, конверсии), считается
 * здесь из сумм — поэтому свёртка по неделям и категориям не искажает проценты.
 * Настройки экрана помнятся в браузере отдельно для WB и Ozon.
 */
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowsClockwiseIcon, DownloadSimpleIcon, FunnelIcon, PlusIcon, TrashIcon, MagnifyingGlassIcon,
  CaretDownIcon, CaretUpIcon, ArrowSquareOutIcon,
} from '@phosphor-icons/react';
import { apiGet, apiPost, errText } from '../api/http';
import { RNP_METRICS, RNP_METRIC, type RnpMetric, type RnpMp, type RnpResponse, type RnpItem } from '../../shared/rnp';

// ─── Настройки (localStorage, на каждую площадку свои) ──────────────────────

type RuleOp = 'gt' | 'lt' | 'eq' | 'drop' | 'rise';
type RuleColor = 'red' | 'amber' | 'green' | 'blue';
type Rule = { id: string; metric: string; op: RuleOp; value: number; color: RuleColor; on: boolean };

type Settings = {
  period: '7' | '14' | '30' | '60' | 'custom';
  from: string; to: string;
  dateGroup: 'day' | 'week' | 'month';
  rowGroup: 'product' | 'category' | 'brand';
  category: string;
  inStock: boolean;
  metrics: string[];
  rules: Rule[];
  heatmap: boolean;
  onlyFlagged: boolean;
  sortMetric: string;
  sortDir: 'desc' | 'asc';
};

const OP_LABEL: Record<RuleOp, string> = { gt: 'больше', lt: 'меньше', eq: 'равно', drop: 'упало к прошлому столбцу на, %', rise: 'выросло к прошлому столбцу на, %' };
const COLOR_LABEL: Record<RuleColor, string> = { red: 'красный', amber: 'жёлтый', green: 'зелёный', blue: 'синий' };

const PRESETS: Array<Omit<Rule, 'id' | 'on'> & { title: string }> = [
  { title: 'ДРР выше 15%', metric: 'percent_drr', op: 'gt', value: 15, color: 'red' },
  { title: 'Заказы упали на 30%+', metric: 'ordered_cnt', op: 'drop', value: 30, color: 'amber' },
  { title: 'Запас меньше 14 дней', metric: 'days_of_stock', op: 'lt', value: 14, color: 'amber' },
  { title: 'Нет заказов', metric: 'ordered_cnt', op: 'eq', value: 0, color: 'blue' },
  { title: 'CTR рекламы ниже 1%', metric: 'adv_ctr', op: 'lt', value: 1, color: 'amber' },
  { title: 'Заказы выросли на 30%+', metric: 'ordered_cnt', op: 'rise', value: 30, color: 'green' },
];

const DEFAULTS: Settings = {
  period: '14', from: '', to: '', dateGroup: 'day', rowGroup: 'product', category: '', inStock: true,
  metrics: ['ordered_cnt', 'ordered_amount', 'avg_bill', 'adv_expenses', 'percent_drr', 'stocks'],
  rules: [
    { id: 'r1', metric: 'percent_drr', op: 'gt', value: 15, color: 'red', on: true },
    { id: 'r2', metric: 'ordered_cnt', op: 'drop', value: 30, color: 'amber', on: true },
  ],
  heatmap: true, onlyFlagged: false, sortMetric: 'ordered_amount', sortDir: 'desc',
};

const LS_KEY = (mp: RnpMp) => `rnp:${mp}:settings:v1`;

function loadSettings(mp: RnpMp): Settings {
  try {
    const raw = localStorage.getItem(LS_KEY(mp));
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch { /* приватный режим — живём на умолчаниях */ }
  return DEFAULTS;
}
function saveSettings(mp: RnpMp, s: Settings): void {
  try { localStorage.setItem(LS_KEY(mp), JSON.stringify(s)); } catch { /* не критично */ }
}

// ─── Даты и числа ───────────────────────────────────────────────────────────

const MSK_OFFSET_MS = 3 * 3_600_000;
const mskToday = () => new Date(Date.now() + MSK_OFFSET_MS).toISOString().slice(0, 10);
const addDays = (d: string, n: number) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86_400_000).toISOString().slice(0, 10);
const ddmm = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}`;
const MONTHS = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

function periodRange(s: Settings): { from: string; to: string } {
  if (s.period === 'custom' && s.from && s.to) return { from: s.from, to: s.to };
  const to = mskToday();
  return { from: addDays(to, -(Number(s.period === 'custom' ? 14 : s.period) - 1)), to };
}

type Bucket = { key: string; label: string; title: string; idxs: number[] };

function makeBuckets(dates: string[], g: Settings['dateGroup']): Bucket[] {
  if (g === 'day') return dates.map((d, i) => ({ key: d, label: ddmm(d), title: d.split('-').reverse().join('.'), idxs: [i] }));
  const map = new Map<string, Bucket>();
  dates.forEach((d, i) => {
    let key: string; let label: string;
    if (g === 'week') {
      const dow = (new Date(d + 'T00:00:00Z').getUTCDay() + 6) % 7;   // пн = 0
      key = addDays(d, -dow);
      label = `${ddmm(key)}–${ddmm(addDays(key, 6))}`;
    } else {
      key = d.slice(0, 7);
      label = `${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(2, 4)}`;
    }
    const b = map.get(key) ?? { key, label, title: '', idxs: [] };
    b.idxs.push(i);
    map.set(key, b);
  });
  return [...map.values()].map(b => ({ ...b, title: `${ddmm(dates[b.idxs[0]])} – ${ddmm(dates[b.idxs[b.idxs.length - 1]])}${b.idxs.length < (g === 'week' ? 7 : 28) ? ' (неполный)' : ''}` }));
}

const nf0 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });
function fmt(v: number | null, m: RnpMetric): string {
  if (v === null || !Number.isFinite(v)) return '–';
  if (m.unit === 'pct') return `${nf1.format(v)}%`;
  if (m.unit === 'rub' || m.unit === 'days') return nf0.format(v);
  return Number.isInteger(v) ? nf0.format(v) : nf1.format(v);
}

// ─── Свёртка ────────────────────────────────────────────────────────────────

type Entity = { key: string; title: string; sub: string; photo: string; link: string; skus: string[]; item?: RnpItem };
type Base = Record<string, number | null>;

/** Базовые метрики группы товаров на наборе дней. */
function aggregate(data: RnpResponse, skus: string[], idxs: number[], baseKeys: string[]): Base {
  const out: Base = {};
  for (const key of baseKeys) {
    const kind = RNP_METRIC[key]?.kind;
    if (kind === 'last') {
      // Снимок: берём последний день, где есть хоть одно значение, и складываем товары.
      let res: number | null = null;
      for (let j = idxs.length - 1; j >= 0 && res === null; j--) {
        for (const s of skus) {
          const v = data.facts[s]?.[key]?.[idxs[j]];
          if (v !== null && v !== undefined) res = (res ?? 0) + v;
        }
      }
      out[key] = res;
    } else {
      let res: number | null = null;
      for (const s of skus) {
        const arr = data.facts[s]?.[key];
        if (!arr) continue;
        for (const i of idxs) { const v = arr[i]; if (v !== null && v !== undefined) res = (res ?? 0) + v; }
      }
      out[key] = res;
    }
  }
  return out;
}

function derive(key: string, b: Base): number | null {
  const m = RNP_METRIC[key];
  if (!m) return null;
  if (m.kind !== 'ratio') return b[key] ?? null;
  const n = b[m.num!]; const d = b[m.den!];
  if (n === null || n === undefined || d === null || d === undefined || d === 0) return null;
  return (n / d) * (m.scale ?? 1);
}

function baseKeysFor(metrics: string[]): string[] {
  const set = new Set<string>();
  for (const k of metrics) {
    const m = RNP_METRIC[k];
    if (!m) continue;
    if (m.kind === 'ratio') { set.add(m.num!); set.add(m.den!); } else set.add(k);
  }
  return [...set];
}

// ─── Правила подсветки ──────────────────────────────────────────────────────

function ruleHit(r: Rule, v: number | null, prev: number | null): boolean {
  if (v === null) return false;
  switch (r.op) {
    case 'gt': return v > r.value;
    case 'lt': return v < r.value;
    case 'eq': return Math.abs(v - r.value) < 1e-9;
    case 'drop': return prev !== null && prev > 0 && (prev - v) / prev * 100 >= r.value;
    case 'rise': return prev !== null && prev > 0 && (v - prev) / prev * 100 >= r.value;
  }
}

function ruleTitle(r: Rule): string {
  const m = RNP_METRIC[r.metric];
  const unit = r.op === 'drop' || r.op === 'rise' ? '%' : m?.unit === 'pct' ? '%' : '';
  const op = r.op === 'drop' ? 'упало на' : r.op === 'rise' ? 'выросло на' : r.op === 'gt' ? '>' : r.op === 'lt' ? '<' : '=';
  return `${m?.short ?? m?.label ?? r.metric} ${op} ${r.value}${unit}`;
}

// ─── Мини-график ────────────────────────────────────────────────────────────

function Spark({ values, metric }: { values: Array<number | null>; metric: RnpMetric }) {
  const W = 88, H = 28;
  const nums = values.filter((v): v is number => v !== null);
  if (nums.length < 2) return <span className="rnp-spark-empty" />;
  const max = Math.max(...nums), min = Math.min(0, ...nums);
  const span = max - min || 1;
  const n = values.length;
  const color = metric.better === 'down' ? 'var(--rnp-down)' : metric.better === 'up' ? 'var(--rnp-up)' : 'var(--accent)';
  if (metric.kind === 'sum') {
    const bw = Math.max(1.5, W / n - 1.5);
    return (
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden className="rnp-spark">
        {values.map((v, i) => {
          if (v === null) return null;
          const h = Math.max(1, ((v - min) / span) * (H - 2));
          return <rect key={i} x={(i * W) / n} y={H - h} width={bw} height={h} rx={1} fill={color} opacity={0.75} />;
        })}
      </svg>
    );
  }
  const pts = values.map((v, i) => v === null ? null : `${((i + 0.5) * W) / n},${H - 2 - ((v - min) / span) * (H - 4)}`).filter(Boolean).join(' ');
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden className="rnp-spark">
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.6} strokeLinejoin="round" />
    </svg>
  );
}

// ─── Панель метрик и правил ─────────────────────────────────────────────────

function MetricPicker({ mp, s, set, present }: { mp: RnpMp; s: Settings; set: (p: Partial<Settings>) => void; present: Set<string> }) {
  const groups = ['Продажи', 'Воронка', 'Реклама', 'Остатки'] as const;
  const toggle = (k: string) => set({ metrics: s.metrics.includes(k) ? s.metrics.filter(x => x !== k) : RNP_METRICS.filter(m => m.key === k || s.metrics.includes(m.key)).map(m => m.key) });
  return (
    <div className="rnp-metrics">
      {groups.map(g => {
        const list = RNP_METRICS.filter(m => m.group === g && m.mps.includes(mp));
        if (!list.length) return null;
        return (
          <div key={g} className="rnp-mgroup">
            <span className="rnp-mgroup-title">{g}</span>
            {list.map(m => {
              const has = m.kind === 'ratio' ? present.has(m.num!) && present.has(m.den!) : present.has(m.key);
              return (
                <button key={m.key} className={`rnp-mchip ${s.metrics.includes(m.key) ? 'on' : ''} ${has ? '' : 'nodata'}`}
                  onClick={() => toggle(m.key)} aria-pressed={s.metrics.includes(m.key)}
                  title={`${m.hint ? m.hint + '. ' : ''}${has ? '' : 'За период данных нет.'}`}>
                  {m.label}
                </button>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

function RulesPanel({ mp, s, set }: { mp: RnpMp; s: Settings; set: (p: Partial<Settings>) => void }) {
  const metrics = RNP_METRICS.filter(m => m.mps.includes(mp));
  const upd = (id: string, p: Partial<Rule>) => set({ rules: s.rules.map(r => r.id === id ? { ...r, ...p } : r) });
  const add = (p?: Omit<Rule, 'id' | 'on'>) => set({ rules: [...s.rules, { id: Math.random().toString(36).slice(2, 9), on: true, ...(p ?? { metric: 'ordered_cnt', op: 'lt', value: 1, color: 'amber' }) }] });
  return (
    <div className="rnp-rules">
      <div className="rnp-rules-head">
        <strong>Подсветка</strong>
        <label className="rnp-check"><input type="checkbox" checked={s.heatmap} onChange={e => set({ heatmap: e.target.checked })} /> тепловая карта</label>
        <label className="rnp-check"><input type="checkbox" checked={s.onlyFlagged} onChange={e => set({ onlyFlagged: e.target.checked })} /> показывать только подсвеченные товары</label>
      </div>
      {s.rules.map(r => (
        <div key={r.id} className={`rnp-rule ${r.on ? '' : 'off'}`}>
          <input type="checkbox" checked={r.on} onChange={e => upd(r.id, { on: e.target.checked })} aria-label="Правило включено" />
          <select className="select" value={r.metric} onChange={e => upd(r.id, { metric: e.target.value })}>
            {metrics.map(m => <option key={m.key} value={m.key}>{m.label}</option>)}
          </select>
          <select className="select" value={r.op} onChange={e => upd(r.id, { op: e.target.value as RuleOp })}>
            {(Object.keys(OP_LABEL) as RuleOp[]).map(o => <option key={o} value={o}>{OP_LABEL[o]}</option>)}
          </select>
          <input className="input rnp-rule-val" type="number" value={r.value} onChange={e => upd(r.id, { value: Number(e.target.value) })} />
          <select className={`select rnp-rule-color rnp-c-${r.color}`} value={r.color} onChange={e => upd(r.id, { color: e.target.value as RuleColor })}>
            {(Object.keys(COLOR_LABEL) as RuleColor[]).map(c => <option key={c} value={c}>{COLOR_LABEL[c]}</option>)}
          </select>
          <button className="btn btn-sm" onClick={() => set({ rules: s.rules.filter(x => x.id !== r.id) })} title="Удалить правило"><TrashIcon size={13} /></button>
        </div>
      ))}
      <div className="rnp-presets">
        <button className="btn btn-sm" onClick={() => add()}><PlusIcon size={12} /> Своё правило</button>
        <span className="muted">Готовые:</span>
        {PRESETS.filter(p => RNP_METRIC[p.metric]?.mps.includes(mp)).map(p => (
          <button key={p.title} className={`rnp-preset rnp-c-${p.color}`} onClick={() => add({ metric: p.metric, op: p.op, value: p.value, color: p.color })}>{p.title}</button>
        ))}
      </div>
    </div>
  );
}

// ─── Доска одной площадки ───────────────────────────────────────────────────

const PAGE = 30;

function RnpBoard({ mp }: { mp: RnpMp }) {
  const [s, setS] = useState<Settings>(() => loadSettings(mp));
  const set = useCallback((p: Partial<Settings>) => setS(prev => { const n = { ...prev, ...p }; saveSettings(mp, n); return n; }), [mp]);
  const [data, setData] = useState<(RnpResponse & { collecting?: boolean }) | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [shown, setShown] = useState(PAGE);
  const [panel, setPanel] = useState<'metrics' | 'rules' | null>(null);
  const { from, to } = periodRange(s);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await apiGet<RnpResponse & { collecting?: boolean }>(`/api/rnp?mp=${mp}&from=${from}&to=${to}`);
      setData(r.data); setErr(null);
    } catch (e) { setErr(errText(e)); }
    finally { setLoading(false); }
  }, [mp, from, to]);

  useEffect(() => { void load(); }, [load]);
  // Пока на сервере идёт сбор — переспрашиваем чаще, иначе раз в 5 минут.
  useEffect(() => {
    const t = setInterval(load, data?.collecting ? 20_000 : 300_000);
    return () => clearInterval(t);
  }, [load, data?.collecting]);

  const collectNow = async () => {
    try { await apiPost(`/api/rnp/collect?mp=${mp}`); setData(d => d ? { ...d, collecting: true } : d); } catch (e) { setErr(errText(e)); }
  };

  const present = useMemo(() => new Set(data?.present ?? []), [data]);
  const metrics = useMemo(() => s.metrics.filter(k => RNP_METRIC[k]?.mps.includes(mp)), [s.metrics, mp]);
  const activeRules = useMemo(() => s.rules.filter(r => r.on && RNP_METRIC[r.metric]?.mps.includes(mp)), [s.rules, mp]);

  const view = useMemo(() => {
    if (!data) return null;
    const buckets = makeBuckets(data.dates, s.dateGroup);
    const allIdx = data.dates.map((_, i) => i);
    const baseKeys = baseKeysFor([...metrics, ...activeRules.map(r => r.metric), s.sortMetric, 'stocks']);

    // Товары после фильтров
    const q = search.trim().toLowerCase();
    const lastStock = (sku: string) => {
      const arr = data.facts[sku]?.stocks;
      if (!arr) return null;
      for (let i = arr.length - 1; i >= 0; i--) if (arr[i] !== null) return arr[i];
      return null;
    };
    const items = data.items.filter(it =>
      (!s.category || (it.category || 'Без категории') === s.category) &&
      (!q || `${it.article} ${it.name} ${it.sku} ${it.extId ?? ''}`.toLowerCase().includes(q)) &&
      // «В наличии»: остаток > 0 на последнюю дату. Товар без данных об остатке не прячем.
      (!s.inStock || (lastStock(it.sku) ?? 1) > 0));

    // Строки: товары, категории или бренды
    let entities: Entity[];
    if (s.rowGroup === 'product') {
      entities = items.map(it => ({
        key: it.sku, title: it.article, sub: it.name, photo: it.photo, skus: [it.sku], item: it,
        link: mp === 'wb' ? `https://www.wildberries.ru/catalog/${it.sku}/detail.aspx` : it.extId ? `https://www.ozon.ru/product/${it.extId}/` : '',
      }));
    } else {
      const by = new Map<string, string[]>();
      for (const it of items) {
        const k = (s.rowGroup === 'category' ? it.category : it.brand) || (s.rowGroup === 'category' ? 'Без категории' : 'Без бренда');
        by.set(k, [...(by.get(k) ?? []), it.sku]);
      }
      entities = [...by.entries()].map(([k, skus]) => ({ key: k, title: k, sub: `${skus.length} ${skus.length === 1 ? 'товар' : skus.length < 5 ? 'товара' : 'товаров'}`, photo: '', link: '', skus }));
    }

    type Row = { metric: RnpMetric; cells: Array<number | null>; total: number | null; flags: Array<Rule | null>; totalFlag: Rule | null };
    const build = (skus: string[]) => {
      const perBucket = buckets.map(b => aggregate(data, skus, b.idxs, baseKeys));
      const tot = aggregate(data, skus, allIdx, baseKeys);
      const val = (k: string) => ({ cells: perBucket.map(b => derive(k, b)), total: derive(k, tot) });
      const hits = new Set<Rule>();
      const ruleCells = new Map<string, Array<Rule | null>>();
      for (const r of activeRules) {
        const { cells } = val(r.metric);
        const arr = ruleCells.get(r.metric) ?? cells.map(() => null);
        cells.forEach((v, i) => { if (!arr[i] && ruleHit(r, v, i ? cells[i - 1] : null)) { arr[i] = r; hits.add(r); } });
        ruleCells.set(r.metric, arr);
      }
      const rows: Row[] = metrics.map(k => {
        const { cells, total } = val(k);
        return { metric: RNP_METRIC[k], cells, total, flags: ruleCells.get(k) ?? cells.map(() => null), totalFlag: null };
      });
      return { rows, hits: [...hits], sortVal: derive(s.sortMetric, tot) };
    };

    let blocks = entities.map(e => ({ e, ...build(e.skus) }));
    if (s.onlyFlagged) blocks = blocks.filter(b => b.hits.length);
    const dir = s.sortDir === 'desc' ? -1 : 1;
    blocks.sort((a, b) => {
      if (a.sortVal === null && b.sortVal === null) return a.e.title.localeCompare(b.e.title);
      if (a.sortVal === null) return 1;
      if (b.sortVal === null) return -1;
      return (a.sortVal - b.sortVal) * dir;
    });
    const total = build(items.map(i => i.sku));
    const categories = [...new Set(data.items.map(i => i.category || 'Без категории'))].sort((a, b) => a.localeCompare(b, 'ru'));
    const hasBrands = data.items.some(i => i.brand);
    return { buckets, blocks, total, categories, hasBrands, itemsCount: items.length };
  }, [data, s, metrics, activeRules, search, mp]);

  const exportCsv = () => {
    if (!view) return;
    const head = ['Товар', 'Название', 'Метрика', ...view.buckets.map(b => b.label), 'Итого'];
    const lines = [head];
    const push = (title: string, sub: string, rows: typeof view.total.rows) => rows.forEach(r => lines.push([title, sub, r.metric.label, ...r.cells.map(v => v === null ? '' : String(Math.round(v * 100) / 100).replace('.', ',')), r.total === null ? '' : String(Math.round(r.total * 100) / 100).replace('.', ',')]));
    push('Итого', '', view.total.rows);
    for (const b of view.blocks) push(b.e.title, b.e.sub, b.rows);
    const csv = '﻿' + lines.map(l => l.map(c => /[;"\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c).join(';')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = `РНП ${mp === 'wb' ? 'WB' : 'Ozon'} ${from}…${to}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  const collected = data ? Math.max(0, ...Object.values(data.collectedAt)) : 0;

  return (
    <div className="rnp">
      {/* Фильтры */}
      <section className="card rnp-filters">
        <div className="rnp-frow">
          <div className="period-switch" role="group" aria-label="Период">
            {(['7', '14', '30', '60'] as const).map(p => (
              <button key={p} className={`period-btn ${s.period === p ? 'active' : ''}`} onClick={() => set({ period: p })}>{p} дн</button>
            ))}
            <button className={`period-btn ${s.period === 'custom' ? 'active' : ''}`} onClick={() => set({ period: 'custom', from: s.from || from, to: s.to || to })}>свой</button>
          </div>
          {s.period === 'custom' && (
            <span className="rnp-dates">
              <input className="input" type="date" value={s.from || from} max={s.to || to} onChange={e => set({ from: e.target.value })} aria-label="Начало периода" />
              <span className="muted">–</span>
              <input className="input" type="date" value={s.to || to} min={s.from || from} max={mskToday()} onChange={e => set({ to: e.target.value })} aria-label="Конец периода" />
            </span>
          )}
          <div className="period-switch" role="group" aria-label="Столбцы">
            {([['day', 'по дням'], ['week', 'по неделям'], ['month', 'по месяцам']] as const).map(([k, l]) => (
              <button key={k} className={`period-btn ${s.dateGroup === k ? 'active' : ''}`} onClick={() => set({ dateGroup: k })}>{l}</button>
            ))}
          </div>
          <div className="period-switch" role="group" aria-label="Строки">
            {([['product', 'товары'], ['category', 'категории'], ...(view?.hasBrands ? [['brand', 'бренды']] : [])] as Array<[Settings['rowGroup'], string]>).map(([k, l]) => (
              <button key={k} className={`period-btn ${s.rowGroup === k ? 'active' : ''}`} onClick={() => set({ rowGroup: k })}>{l}</button>
            ))}
          </div>
        </div>
        <div className="rnp-frow">
          <label className="rnp-search">
            <MagnifyingGlassIcon size={15} />
            <input className="input" placeholder="Артикул, название или SKU" value={search} onChange={e => { setSearch(e.target.value); setShown(PAGE); }} />
          </label>
          <select className="select rnp-cat" value={s.category} onChange={e => set({ category: e.target.value })} aria-label="Категория">
            <option value="">Все категории</option>
            {view?.categories.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <label className="rnp-check"><input type="checkbox" checked={s.inStock} onChange={e => set({ inStock: e.target.checked })} /> только в наличии</label>
          <span className="rnp-sort">
            <span className="muted">Сортировка</span>
            <select className="select" value={s.sortMetric} onChange={e => set({ sortMetric: e.target.value })} aria-label="Сортировать по">
              {RNP_METRICS.filter(m => m.mps.includes(mp)).map(m => <option key={m.key} value={m.key}>{m.label}</option>)}
            </select>
            <button className="btn btn-sm" onClick={() => set({ sortDir: s.sortDir === 'desc' ? 'asc' : 'desc' })} title={s.sortDir === 'desc' ? 'По убыванию' : 'По возрастанию'}>
              {s.sortDir === 'desc' ? <CaretDownIcon size={13} /> : <CaretUpIcon size={13} />}
            </button>
          </span>
        </div>
        <div className="rnp-frow">
          <button className={`btn btn-sm ${panel === 'metrics' ? 'btn-primary' : ''}`} onClick={() => setPanel(p => p === 'metrics' ? null : 'metrics')}>
            Метрики · {metrics.length}
          </button>
          <button className={`btn btn-sm ${panel === 'rules' ? 'btn-primary' : ''}`} onClick={() => setPanel(p => p === 'rules' ? null : 'rules')}>
            <FunnelIcon size={13} /> Подсветка · {activeRules.length}
          </button>
          <span className="rnp-active-rules">
            {activeRules.map(r => <span key={r.id} className={`rnp-tag rnp-c-${r.color}`}>{ruleTitle(r)}</span>)}
          </span>
          <span className="rnp-spacer" />
          <span className="muted rnp-upd">
            {data?.collecting ? <><ArrowsClockwiseIcon size={13} className="spin" /> идёт сбор…</> : collected ? `обновлено ${new Date(collected).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}` : ''}
          </span>
          <button className="btn btn-sm" onClick={collectNow} disabled={!!data?.collecting} title="Собрать данные из API площадки сейчас, не дожидаясь планового прохода">
            <ArrowsClockwiseIcon size={13} /> Обновить
          </button>
          <button className="btn btn-sm" onClick={exportCsv} disabled={!view?.blocks.length}><DownloadSimpleIcon size={13} /> CSV</button>
        </div>
        {panel === 'metrics' && <MetricPicker mp={mp} s={s} set={set} present={present} />}
        {panel === 'rules' && <RulesPanel mp={mp} s={s} set={set} />}
      </section>

      {err && <div className="rnp-alert">Не удалось загрузить РНП: {err}</div>}
      {data?.notes.map(n => <div key={n} className="rnp-note">{n}</div>)}
      {!data && !err && <div className="card muted">{loading ? 'Загружаю…' : ''}</div>}

      {view && (
        <section className="card rnp-table-card">
          <div className="rnp-table-head">
            <span><strong>{view.blocks.length}</strong> {s.rowGroup === 'product' ? 'товаров' : s.rowGroup === 'category' ? 'категорий' : 'брендов'}
              {s.onlyFlagged && ` с подсветкой из ${s.rowGroup === 'product' ? view.itemsCount : '…'}`}</span>
            {loading && <span className="muted"><ArrowsClockwiseIcon size={13} className="spin" /> обновляю</span>}
          </div>
          {!metrics.length ? <div className="muted">Выберите хотя бы одну метрику.</div> : (
            <div className="rnp-scroll">
              <table className={`rnp-table ${s.heatmap ? 'heat' : ''}`}>
                <thead>
                  <tr>
                    <th className="rnp-sticky rnp-col-item">{s.rowGroup === 'product' ? 'Товар' : s.rowGroup === 'category' ? 'Категория' : 'Бренд'}</th>
                    <th className="rnp-sticky rnp-col-metric">Метрика</th>
                    <th className="rnp-col-spark">График</th>
                    {view.buckets.map(b => <th key={b.key} className="rnp-num" title={b.title}>{b.label}</th>)}
                    <th className="rnp-num rnp-col-total">Итого</th>
                  </tr>
                </thead>
                <tbody>
                  <Block title="Итого по площадке" sub={`${view.itemsCount} товаров в выборке`} photo="" link="" rows={view.total.rows} hits={[]} heat={s.heatmap} total />
                  {view.blocks.slice(0, shown).map(b => (
                    <Block key={b.e.key} title={b.e.title} sub={b.e.sub} photo={b.e.photo} link={b.e.link} rows={b.rows} hits={b.hits} heat={s.heatmap}
                      cat={s.rowGroup === 'product' ? b.e.item?.category : undefined} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {view.blocks.length > shown && (
            <button className="btn btn-sm rnp-more" onClick={() => setShown(n => n + PAGE)}>Показать ещё {Math.min(PAGE, view.blocks.length - shown)} из {view.blocks.length - shown}</button>
          )}
        </section>
      )}
    </div>
  );
}

// ─── Блок строк одного товара ───────────────────────────────────────────────

type BlockRow = { metric: RnpMetric; cells: Array<number | null>; total: number | null; flags: Array<Rule | null> };

function heatClass(v: number | null, cells: Array<number | null>, m: RnpMetric): string {
  if (v === null || !m.better) return '';
  const nums = cells.filter((x): x is number => x !== null);
  // На двух столбцах карта красит один красным, другой зелёным при любой разнице — шум.
  if (nums.length < 3) return '';
  const min = Math.min(...nums), max = Math.max(...nums);
  if (max === min) return '';
  let t = (v - min) / (max - min);           // 0..1, где 1 — максимум строки
  if (m.better === 'down') t = 1 - t;        // для ДРР и расходов хорошо — низкое
  const lvl = Math.round(t * 4);             // 0..4
  return lvl >= 3 ? `rnp-h-up${lvl - 2}` : lvl <= 1 ? `rnp-h-down${2 - lvl}` : '';
}

function Block({ title, sub, photo, link, rows, hits, heat, total, cat }: {
  title: string; sub: string; photo: string; link: string; rows: BlockRow[]; hits: Rule[]; heat: boolean; total?: boolean; cat?: string;
}) {
  return (
    <>
      {rows.map((r, ri) => (
        <tr key={r.metric.key} className={`${ri === 0 ? 'rnp-first' : ''} ${total ? 'rnp-total' : ''}`}>
          {ri === 0 && (
            <td className="rnp-sticky rnp-col-item" rowSpan={rows.length}>
              <div className="rnp-item">
                {photo ? <img src={photo} alt="" loading="lazy" className="rnp-photo" />
                  : cat !== undefined ? <span className="rnp-photo rnp-photo-empty" /> : null}
                <div className="rnp-item-text">
                  <div className="rnp-item-title" title={title}>
                    {title}
                    {link && <a href={link} target="_blank" rel="noreferrer" title="Открыть на площадке" className="rnp-ext"><ArrowSquareOutIcon size={12} /></a>}
                  </div>
                  {sub && <div className="rnp-item-sub" title={sub}>{sub}</div>}
                  {cat && <div className="rnp-item-cat">{cat}</div>}
                  {hits.length > 0 && (
                    <div className="rnp-item-hits">
                      {hits.map(h => <span key={h.id} className={`rnp-dot rnp-c-${h.color}`} title={ruleTitle(h)} />)}
                    </div>
                  )}
                </div>
              </div>
            </td>
          )}
          <td className="rnp-sticky rnp-col-metric" title={r.metric.hint}>{r.metric.label}</td>
          <td className="rnp-col-spark"><Spark values={r.cells} metric={r.metric} /></td>
          {r.cells.map((v, i) => {
            const f = r.flags[i];
            const cls = f ? `rnp-flag rnp-c-${f.color}` : heat ? heatClass(v, r.cells, r.metric) : '';
            return <td key={i} className={`rnp-num ${cls}`} title={f ? ruleTitle(f) : undefined}>{fmt(v, r.metric)}</td>;
          })}
          <td className="rnp-num rnp-col-total">{fmt(r.total, r.metric)}</td>
        </tr>
      ))}
    </>
  );
}

// ─── Страница ───────────────────────────────────────────────────────────────

export function Rnp() {
  const [mp, setMp] = useState<RnpMp>(() => {
    try { return localStorage.getItem('rnp:mp') === 'ozon' ? 'ozon' : 'wb'; } catch { return 'wb'; }
  });
  const choose = (m: RnpMp) => { setMp(m); try { localStorage.setItem('rnp:mp', m); } catch { /* не критично */ } };

  // Плашки WB/Ozon липнут под топбаром, как в «Ценах»: высоту шапки меряем на месте.
  const [topbarH, setTopbarH] = useState(56);
  useEffect(() => {
    const tb = document.querySelector('.topbar') as HTMLElement | null;
    if (!tb) return;
    const measure = () => setTopbarH(h => (tb.offsetHeight !== h ? tb.offsetHeight : h));
    measure();
    const timers = [100, 400, 1000, 2500].map(ms => setTimeout(measure, ms));
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, { passive: true });
    return () => { timers.forEach(clearTimeout); window.removeEventListener('resize', measure); window.removeEventListener('scroll', measure); };
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
      <Fragment key={mp}><RnpBoard mp={mp} /></Fragment>
    </div>
  );
}
