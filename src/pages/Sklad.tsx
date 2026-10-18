/**
 * Раздел «Склад» (ТЗ: Sklad/Анализ и проект системы учёта.md). Замена
 * Google-таблицы «Склад (orig)»: после переноса истории таблица выключается.
 *
 *   Остатки · Движения (приход, расход, перемещения) · Инвентаризация —
 *   SkladStock.tsx; Товары · Склады · Пользователи · Журнал действий — здесь;
 *   Перенос из таблицы — пока таблица жива.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  MagnifyingGlassIcon, ArrowsClockwiseIcon, PlusIcon, LinkIcon, PackageIcon, WarningIcon,
} from '@phosphor-icons/react';
import {
  sklad, skladErr, ROLE_LABEL, MP_LABEL, MODE_LABEL, STATUS_LABEL, KIND_LABEL,
  type Bootstrap, type Product, type Warehouse, type MpWarehouse, type User, type AuditRow,
  type ImportReport, type SyncReport, type UnboundWarehouse, type ProductStatus, type Role, type MpCode, type MpMode, type WarehouseKind,
} from '../api/sklad';
import { Modal, Field, fmtDate, fmtNum } from '../components/SkladUi';
import { StockTab, MovesTab, InventoryTab, HistoryTab } from './SkladStock';

type Tab = 'stock' | 'moves' | 'inventory' | 'products' | 'warehouses' | 'users' | 'audit' | 'history';

export function Sklad() {
  const [data, setData] = useState<Bootstrap | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('stock');
  const [productFilter, setProductFilter] = useState<Product | null>(null);

  const load = () => sklad.bootstrap().then(d => { setData(d); setError(null); }).catch(e => setError(skladErr(e)));
  useEffect(() => { load(); }, []);

  if (error) return <div className="card sk-err"><WarningIcon size={16} weight="bold" /> {error} <button className="btn btn-sm" onClick={load}>Повторить</button></div>;
  if (!data) return <div className="card muted">Загрузка раздела «Склад»…</div>;

  const role = data.me.role;
  const tabs: Array<[Tab, string]> = [
    ['stock', 'Остатки'], ['moves', 'Движения'], ['inventory', 'Инвентаризация'],
    ['products', `Товары · ${data.products.filter(p => p.status !== 'archived').length}`], ['warehouses', 'Склады'],
  ];
  if (role === 'owner') tabs.push(['users', 'Пользователи']);
  if (role === 'owner' || role === 'manager') tabs.push(['audit', 'Журнал действий'], ['history', 'Перенос из таблицы']);

  return (
    <div className="sk">
      <div className="sk-tabs">
        {tabs.map(([k, label]) => (
          <button key={k} className={`sk-tab ${tab === k ? 'active' : ''}`} onClick={() => setTab(k)}>{label}</button>
        ))}
        <span className="sk-me muted">{data.me.name === ROLE_LABEL[role] ? data.me.name : `${data.me.name} · ${ROLE_LABEL[role]}`}</span>
      </div>
      {tab === 'stock' && <StockTab data={data} onOpenProduct={p => { setProductFilter(p); setTab('moves'); }} />}
      {tab === 'moves' && <MovesTab data={data} productFilter={productFilter} clearProductFilter={() => setProductFilter(null)} />}
      {tab === 'inventory' && <InventoryTab data={data} />}
      {tab === 'history' && <HistoryTab data={data} reload={load} />}
      {tab === 'products' && <ProductsTab data={data} reload={load} />}
      {tab === 'warehouses' && <WarehousesTab data={data} reload={load} />}
      {tab === 'users' && <UsersTab data={data} reload={load} />}
      {tab === 'audit' && <AuditTab />}
    </div>
  );
}

// ─── Товары ────────────────────────────────────────────────────────────────
function ProductsTab({ data, reload }: { data: Bootstrap; reload: () => void }) {
  const role = data.me.role;
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<ProductStatus | 'all' | 'live'>('live');
  const [open, setOpen] = useState<Product | 'new' | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [syncOpen, setSyncOpen] = useState(false);

  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    const digits = s.replace(/\D+/g, '');
    return data.products.filter(p => {
      if (status === 'live' && p.status === 'archived') return false;
      if (status !== 'live' && status !== 'all' && p.status !== status) return false;
      if (!s) return true;
      return p.article.toLowerCase().includes(s) || p.name.toLowerCase().includes(s)
        || (digits.length >= 4 && p.barcodes.some(b => b.barcode.includes(digits)));
    });
  }, [data.products, q, status]);

  const noDims = data.products.filter(p => p.status === 'active' && !(p.lengthCm && p.widthCm && p.heightCm && p.weightG)).length;
  const noLink = data.products.filter(p => p.status === 'active' && !p.diskUrl).length;

  return (
    <>
      <div className="sk-toolbar">
        <div className="sk-search">
          <MagnifyingGlassIcon size={16} />
          <input className="input" placeholder="Артикул, название или отсканируйте баркод" value={q} onChange={e => setQ(e.target.value)} autoFocus />
        </div>
        <select className="input sk-select" value={status} onChange={e => setStatus(e.target.value as any)}>
          <option value="live">В работе (без архива)</option>
          <option value="all">Все</option>
          {data.dict.productStatuses.map(s => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
        </select>
        <span className="sk-spacer" />
        {role !== 'warehouse' && <button className="btn" onClick={() => setImportOpen(true)}><ArrowsClockwiseIcon size={16} /> Обновить из таблицы</button>}
        {(role === 'owner' || role === 'manager') && <button className="btn" onClick={() => setSyncOpen(true)}><LinkIcon size={16} /> Сверить с WB и Ozon</button>}
        {role !== 'warehouse' && <button className="btn btn-primary" onClick={() => setOpen('new')}><PlusIcon size={16} /> Товар</button>}
      </div>

      {(noDims > 0 || noLink > 0) && (
        <div className="sk-hints">
          {noDims > 0 && <span className="chip warn">Без габаритов или веса: {noDims}</span>}
          {noLink > 0 && role !== 'warehouse' && <span className="chip">Без ссылки на Яндекс Диск: {noLink}</span>}
        </div>
      )}

      <div className="card sk-table-card">
        <div className="sk-scroll">
          <table className="sk-table">
            <thead>
              <tr>
                <th />
                <th>Артикул / название</th>
                <th>Статус</th>
                <th>Баркод</th>
                <th className="num">Д×Ш×В, см</th>
                <th className="num">Вес, г</th>
                <th className="num">В коробке</th>
                <th>Площадки</th>
                <th>Диск</th>
              </tr>
            </thead>
            <tbody>
              {list.map(p => (
                <tr key={p.id} className={p.status === 'archived' ? 'sk-row-muted' : ''} onClick={() => setOpen(p)}>
                  <td className="sk-ph">{p.photoUrl ? <img src={p.photoUrl} alt="" loading="lazy" /> : <PackageIcon size={22} className="muted" />}</td>
                  <td><div className="sk-art">{p.article}</div><div className="muted sk-name">{p.name || '—'}</div></td>
                  <td><StatusChip s={p.status} /></td>
                  <td className="sk-mono">{p.barcodes.find(b => b.kind === 'main')?.barcode ?? p.barcodes[0]?.barcode ?? '—'}{p.barcodes.length > 1 ? <span className="muted"> +{p.barcodes.length - 1}</span> : null}</td>
                  <td className="num">{p.lengthCm && p.widthCm && p.heightCm ? `${fmtNum(p.lengthCm)}×${fmtNum(p.widthCm)}×${fmtNum(p.heightCm)}` : <span className="sk-miss">нет</span>}</td>
                  <td className="num">{p.weightG ? <>{fmtNum(p.weightG)}{p.weightG > data.dict.heavyWeightG ? <span className="chip warn sk-ml">СГТ</span> : null}</> : <span className="sk-miss">нет</span>}</td>
                  <td className="num">{fmtNum(p.perBox)}</td>
                  <td>{p.mp.length ? p.mp.map(m => <span key={m.mp} className="chip sk-mp">{m.mp === 'ozon' ? 'Ozon' : m.mp === 'wb1' ? 'WB1' : m.mp === 'wb2' ? 'WB2' : 'ЯМ'}</span>) : <span className="muted">—</span>}</td>
                  <td onClick={e => e.stopPropagation()}>{p.diskUrl ? <a href={p.diskUrl} target="_blank" rel="noreferrer">открыть</a> : <span className="muted">—</span>}</td>
                </tr>
              ))}
              {!list.length && <tr><td colSpan={9} className="muted sk-empty">{data.products.length ? 'Ничего не найдено' : 'Справочник пуст — нажмите «Обновить из таблицы»'}</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      {open && <ProductModal data={data} product={open === 'new' ? null : open} onClose={() => setOpen(null)} onSaved={() => { setOpen(null); reload(); }} />}
      {importOpen && <ImportModal onClose={() => setImportOpen(false)} onDone={reload} />}
      {syncOpen && <SyncModal data={data} onClose={() => setSyncOpen(false)} onDone={reload} />}
    </>
  );
}

function StatusChip({ s }: { s: ProductStatus }) {
  const cls = s === 'active' ? 'good' : s === 'draft' ? 'info' : s === 'phaseout' ? 'warn' : '';
  return <span className={`chip ${cls}`}>{STATUS_LABEL[s]}</span>;
}

function ProductModal({ data, product, onClose, onSaved }: { data: Bootstrap; product: Product | null; onClose: () => void; onSaved: () => void }) {
  const role = data.me.role;
  const onlyDims = role === 'warehouse';
  const [f, setF] = useState({
    article: product?.article ?? '', name: product?.name ?? '', status: product?.status ?? 'draft' as ProductStatus,
    lengthCm: product?.lengthCm ?? '', widthCm: product?.widthCm ?? '', heightCm: product?.heightCm ?? '',
    weightG: product?.weightG ?? '', perBox: product?.perBox ?? '', photoUrl: product?.photoUrl ?? '',
    diskUrl: product?.diskUrl ?? '', notes: product?.notes ?? '',
    barcodes: (product?.barcodes ?? []).map(b => b.barcode).join('\n'),
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [audit, setAudit] = useState<AuditRow[] | null>(null);
  useEffect(() => { if (product && role !== 'warehouse') sklad.product(product.id).then(r => setAudit(r.audit)).catch(() => setAudit([])); }, [product, role]);

  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });

  const save = async () => {
    setSaving(true); setErr(null);
    const mainBefore = product?.barcodes.find(b => b.kind === 'main')?.barcode;
    const codes = f.barcodes.split(/[\s,;]+/).map(s => s.replace(/\D+/g, '')).filter(Boolean);
    const barcodes = codes.map((c, i) => ({ barcode: c, kind: product?.barcodes.find(b => b.barcode === c)?.kind ?? (i === 0 && !mainBefore ? 'main' : 'extra') }));
    const dims = { lengthCm: f.lengthCm, widthCm: f.widthCm, heightCm: f.heightCm, weightG: f.weightG, perBox: f.perBox, barcodes };
    const input = onlyDims ? dims : { ...dims, article: f.article, name: f.name, status: f.status, photoUrl: f.photoUrl, diskUrl: f.diskUrl, notes: f.notes };
    try { await sklad.saveProduct(product?.id ?? null, input); onSaved(); }
    catch (e) { setErr(skladErr(e)); }
    finally { setSaving(false); }
  };

  return (
    <Modal title={product ? product.article : 'Новый товар'} onClose={onClose} wide>
      {product?.photoUrl && <img className="sk-photo" src={product.photoUrl} alt="" />}
      <div className="grid grid-2">
        <Field label="Артикул (= offer_id Ozon = артикул продавца WB)"><input className="input" value={f.article} onChange={set('article')} disabled={onlyDims} /></Field>
        <Field label="Статус">
          <select className="input" value={f.status} onChange={set('status')} disabled={onlyDims}>
            {data.dict.productStatuses.map(s => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
          </select>
        </Field>
      </div>
      <Field label="Название"><input className="input" value={f.name} onChange={set('name')} disabled={onlyDims} /></Field>
      <div className="grid grid-4">
        <Field label="Длина, см"><input className="input" inputMode="decimal" value={f.lengthCm} onChange={set('lengthCm')} /></Field>
        <Field label="Ширина, см"><input className="input" inputMode="decimal" value={f.widthCm} onChange={set('widthCm')} /></Field>
        <Field label="Высота, см"><input className="input" inputMode="decimal" value={f.heightCm} onChange={set('heightCm')} /></Field>
        <Field label="Вес, г"><input className="input" inputMode="decimal" value={f.weightG} onChange={set('weightG')} /></Field>
      </div>
      <div className="grid grid-2">
        <Field label="Штук в коробке"><input className="input" inputMode="numeric" value={f.perBox} onChange={set('perBox')} /></Field>
        <Field label="Баркоды" hint="По одному в строке; первый — основной"><textarea className="input sk-mono" rows={3} value={f.barcodes} onChange={set('barcodes')} /></Field>
      </div>
      {!onlyDims && (
        <>
          <Field label="Ссылка на Яндекс Диск" hint="Папка с информацией о товаре от поставщика (фото, сертификаты, упаковка)">
            <div className="row gap-8"><input className="input" value={f.diskUrl} onChange={set('diskUrl')} placeholder="https://disk.yandex.ru/d/…" />{f.diskUrl && <a className="btn" href={f.diskUrl} target="_blank" rel="noreferrer">Открыть</a>}</div>
          </Field>
          <Field label="Ссылка на фото"><input className="input" value={f.photoUrl} onChange={set('photoUrl')} /></Field>
          <Field label="Заметки"><textarea className="input" rows={2} value={f.notes} onChange={set('notes')} /></Field>
        </>
      )}
      {product && product.mp.length > 0 && (
        <div className="sk-block">
          <div className="field-label">Карточки на площадках</div>
          {product.mp.map(m => (
            <div key={m.mp} className="sk-mpline"><b>{MP_LABEL[m.mp]}</b> <span className="muted">{m.mp === 'ozon' ? `sku ${m.extSku} · product_id ${m.extItem}` : `nmID ${m.extSku} · chrtID ${m.extItem}`}</span> {m.title && <span className="muted">· {m.title}</span>}</div>
          ))}
        </div>
      )}
      {err && <div className="sk-err"><WarningIcon size={14} weight="bold" /> {err}</div>}
      <div className="row gap-8 sk-actions">
        <button className="btn btn-primary" onClick={save} disabled={saving}>{saving ? 'Сохраняю…' : 'Сохранить'}</button>
        <button className="btn" onClick={onClose}>Отмена</button>
      </div>
      {audit && audit.length > 0 && (
        <div className="sk-block">
          <div className="field-label">История изменений</div>
          {audit.slice(0, 15).map(a => <AuditLine key={a.id} a={a} />)}
        </div>
      )}
    </Modal>
  );
}

const ACTION_LABEL: Record<string, string> = {
  create: 'создал', update: 'изменил', delete: 'удалил', seed: 'начальное заполнение', sync: 'сверка с площадкой',
  'import-create': 'импорт: создан', 'import-update': 'импорт: обновлён', 'import-archive': 'импорт: в архив', run: 'запуск',
};
const ENTITY_LABEL: Record<string, string> = { product: 'Товар', warehouse: 'Склад', mp_warehouse: 'Склад площадки', user: 'Пользователь', 'mp-sync': 'Сверка WB/Ozon' };

function AuditLine({ a, showEntity }: { a: AuditRow; showEntity?: boolean }) {
  const fields = Object.entries(a.diff).map(([k, v]) => Array.isArray(v) ? `${k}: ${short(v[0])} → ${short(v[1])}` : `${k}: ${short(v)}`).join('; ');
  return (
    <div className="sk-audit">
      <span className="muted">{fmtDate(a.ts)}</span> <b>{a.userName}</b> {showEntity && <span>{ENTITY_LABEL[a.entity] ?? a.entity} #{a.entityId} · </span>}{ACTION_LABEL[a.action] ?? a.action}
      {fields && <div className="muted sk-audit-diff">{fields}</div>}
    </div>
  );
}
const short = (v: unknown) => { const s = v === null || v === undefined || v === '' ? '∅' : typeof v === 'object' ? JSON.stringify(v) : String(v); return s.length > 60 ? s.slice(0, 60) + '…' : s; };

function ImportModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [rep, setRep] = useState<ImportReport | null>(null);
  const [busy, setBusy] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const run = (dry: boolean) => {
    setBusy(true); setErr(null);
    sklad.importSheet(dry).then(r => { setRep(r); if (!dry) onDone(); }).catch(e => setErr(skladErr(e))).finally(() => setBusy(false));
  };
  useEffect(() => { run(true); }, []);
  const total = rep ? rep.created.length + rep.updated.length + rep.reactivated.length + rep.archivedNew.length + rep.archivedGone.length + rep.barcodesAdded : 0;
  return (
    <Modal title="Обновить товары из Google-таблицы" onClose={onClose} wide>
      <p className="muted">Источник — лист «Склад Уфа» (активный ассортимент) и «База ШК(парсер)» (выведенные артикулы). Пустые ячейки таблицы не затирают данные, внесённые здесь.</p>
      {busy && <div className="muted">{rep ? 'Применяю…' : 'Читаю таблицу и считаю, что изменится…'}</div>}
      {err && <div className="sk-err"><WarningIcon size={14} weight="bold" /> {err}</div>}
      {rep && !busy && (
        <>
          <div className={`chip ${rep.dryRun ? 'info' : 'good'}`}>{rep.dryRun ? 'Пробный прогон — ничего не записано' : 'Готово — изменения записаны'}</div>
          <ul className="sk-report">
            <li>На листе «Склад Уфа»: <b>{rep.master}</b> товаров</li>
            <ReportList label="Новые товары" items={rep.created} />
            <ReportList label="Обновятся поля" items={rep.updated.map(u => `${u.article} (${u.fields.join(', ')})`)} />
            <ReportList label="Вернутся из архива" items={rep.reactivated} />
            <ReportList label="Выведенные из ассортимента — заведём архивными" items={rep.archivedNew} />
            <ReportList label="Пропали со «Склада Уфа» — уйдут в архив" items={rep.archivedGone} />
            <li>Новых баркодов: <b>{rep.barcodesAdded}</b></li>
            <ReportList label="Конфликты баркодов (не применены)" items={rep.barcodeConflicts} bad />
            <ReportList label="Предупреждения" items={rep.warnings} bad />
          </ul>
          <div className="row gap-8 sk-actions">
            {rep.dryRun && total > 0 && <button className="btn btn-primary" onClick={() => run(false)}>Применить</button>}
            {rep.dryRun && total === 0 && <span className="chip good">Справочник совпадает с таблицей</span>}
            <button className="btn" onClick={onClose}>Закрыть</button>
          </div>
        </>
      )}
    </Modal>
  );
}

function ReportList({ label, items, bad }: { label: string; items: string[]; bad?: boolean }) {
  const [all, setAll] = useState(false);
  if (!items.length) return null;
  const shown = all ? items : items.slice(0, 12);
  return (
    <li className={bad ? 'sk-bad' : ''}>{label}: <b>{items.length}</b>
      <div className="muted sk-report-items">{shown.join(', ')}{items.length > shown.length && <> … <button className="btn btn-sm" onClick={() => setAll(true)}>ещё {items.length - shown.length}</button></>}</div>
    </li>
  );
}

/**
 * Склады в кабинетах WB/Ozon, которые ещё ни к чему не привязаны. Наш склад
 * угадан по названию («Склад ФФ Подольск-Рязань» → ФФ Подольск) — остаётся
 * нажать «Привязать», и заказы с этого склада начнут списываться с нашего.
 */
function UnboundList({ data, list, onBound }: { data: Bootstrap; list: UnboundWarehouse[]; onBound: () => void }) {
  const [choice, setChoice] = useState<Record<string, string>>(() =>
    Object.fromEntries(list.map(u => [u.mp + '|' + u.extName, u.suggestWarehouseId ? String(u.suggestWarehouseId) : ''])));
  const [done, setDone] = useState<Record<string, string>>({});
  const bind = async (u: UnboundWarehouse) => {
    const key = u.mp + '|' + u.extName;
    const wid = Number(choice[key]);
    if (!wid) return;
    try {
      await sklad.saveMpWarehouse(null, { warehouseId: wid, mp: u.mp, extName: u.extName, extId: u.extId, mode: u.suggestMode });
      setDone(d => ({ ...d, [key]: 'привязан' }));
      onBound();
    } catch (e) { setDone(d => ({ ...d, [key]: skladErr(e) })); }
  };
  const suggested = list.filter(u => u.suggestWarehouseId && !done[u.mp + '|' + u.extName]);
  return (
    <div className="sk-block">
      <div className="flex-between">
        <div className="field-label">Новые склады в кабинетах — не привязаны ({list.length})</div>
        {suggested.length > 1 && <button className="btn btn-sm btn-primary" onClick={() => suggested.forEach(bind)}>Привязать предложенные ({suggested.length})</button>}
      </div>
      {list.map(u => {
        const key = u.mp + '|' + u.extName;
        return (
          <div key={key} className="sk-unbound">
            <span className="chip">{MP_LABEL[u.mp]}</span>
            <span className="sk-unbound-name">{u.extName}{u.suggestMode === 'heavy_only' && <span className="chip warn sk-ml">СГТ</span>}</span>
            {done[key] ? <span className={done[key] === 'привязан' ? 'chip good' : 'sk-bad'}>{done[key]}</span> : (
              <>
                <select className="input sk-select" value={choice[key]} onChange={e => setChoice(c => ({ ...c, [key]: e.target.value }))}>
                  <option value="">— не привязывать —</option>
                  {data.warehouses.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
                </select>
                <button className="btn btn-sm" disabled={!choice[key]} onClick={() => bind(u)}>Привязать</button>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

function SyncModal({ data, onClose, onDone }: { data: Bootstrap; onClose: () => void; onDone: () => void }) {
  const [rep, setRep] = useState<SyncReport | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { sklad.mpSync().then(r => setRep(r)).catch(e => setErr(skladErr(e))); }, []);
  return (
    <Modal title="Сверка с кабинетами WB и Ozon" onClose={onClose} wide>
      <p className="muted">Только чтение: находим id складов площадок по названию и привязываем карточки по артикулу. В кабинетах ничего не меняется.</p>
      {!rep && !err && <div className="muted">Запрашиваю склады и карточки… (до минуты)</div>}
      {err && <div className="sk-err"><WarningIcon size={14} weight="bold" /> {err}</div>}
      {rep && (
        <ul className="sk-report">
          {Object.entries(rep.warehouses).map(([mp, w]) => (
            <li key={'w' + mp} className={w.error || w.missing.length ? 'sk-bad' : ''}>
              {MP_LABEL[mp as MpCode]} — склады: {w.error ? w.error : <>найдено <b>{w.matched}</b>{w.missing.length ? <>, нет в кабинете: {w.missing.join(', ')}</> : null}</>}
            </li>
          ))}
          {Object.entries(rep.cards).map(([mp, c]) => (
            <li key={'c' + mp} className={c.error ? 'sk-bad' : ''}>
              {MP_LABEL[mp as MpCode]} — карточки: {c.error ? c.error : <>привязано <b>{c.linked}</b>{c.notInCatalog.length ? <div className="muted sk-report-items">Есть на площадке, нет в справочнике ({c.notInCatalog.length}): {c.notInCatalog.slice(0, 30).join(', ')}{c.notInCatalog.length > 30 ? '…' : ''}</div> : null}</>}
            </li>
          ))}
          {rep.skipped.map(s => <li key={s} className="muted">Пропущено — {s}</li>)}
        </ul>
      )}
      {rep && rep.unbound.length > 0 && <UnboundList data={data} list={rep.unbound} onBound={onDone} />}
      <div className="sk-actions"><button className="btn" onClick={() => { onDone(); onClose(); }}>Закрыть</button></div>
    </Modal>
  );
}

// ─── Склады ────────────────────────────────────────────────────────────────
function WarehousesTab({ data, reload }: { data: Bootstrap; reload: () => void }) {
  const canEdit = data.me.role === 'owner' || data.me.role === 'manager';
  const [editWh, setEditWh] = useState<Warehouse | 'new' | null>(null);
  const [editMp, setEditMp] = useState<{ mp: MpWarehouse | null; warehouseId: number } | null>(null);
  return (
    <>
      {canEdit && <div className="sk-toolbar"><span className="sk-spacer" /><button className="btn btn-primary" onClick={() => setEditWh('new')}><PlusIcon size={16} /> Склад</button></div>}
      <div className="sk-wh-grid">
        {data.warehouses.map(w => {
          const mps = data.mpWarehouses.filter(m => m.warehouseId === w.id);
          return (
            <div key={w.id} className={`card sk-wh ${w.active ? '' : 'sk-row-muted'}`}>
              <div className="flex-between">
                <div><h2>{w.name}</h2><div className="muted">{KIND_LABEL[w.kind]}{w.city ? ` · ${w.city}` : ''}{w.sheetName ? ` · лист «${w.sheetName}»` : ''}</div></div>
                {canEdit && <button className="btn btn-sm" onClick={() => setEditWh(w)}>Изменить</button>}
              </div>
              {w.notes && <div className="muted sk-hint">{w.notes}</div>}
              <div className="sk-block">
                <div className="field-label">Склады площадок ({mps.length})</div>
                {(['wb1', 'wb2', 'ozon', 'ym'] as MpCode[]).map(mp => {
                  const list = mps.filter(m => m.mp === mp);
                  if (!list.length) return null;
                  return (
                    <div key={mp} className="sk-mpgroup">
                      <div className="sk-mpgroup-t">{MP_LABEL[mp]}</div>
                      {list.map(m => (
                        <div key={m.id} className={`sk-mpw ${m.active ? '' : 'sk-row-muted'}`} onClick={() => canEdit && setEditMp({ mp: m, warehouseId: w.id })}>
                          <span>{m.extName}</span>
                          {m.mode !== 'stock' && <span className="chip warn">{MODE_LABEL[m.mode]}</span>}
                          {m.extId ? <span className="muted sk-mono">id {m.extId}</span> : <span className="chip">id не найден</span>}
                        </div>
                      ))}
                    </div>
                  );
                })}
                {canEdit && <button className="btn btn-sm" onClick={() => setEditMp({ mp: null, warehouseId: w.id })}><PlusIcon size={14} /> Склад площадки</button>}
              </div>
            </div>
          );
        })}
      </div>
      {editWh && <WarehouseModal wh={editWh === 'new' ? null : editWh} onClose={() => setEditWh(null)} onSaved={() => { setEditWh(null); reload(); }} />}
      {editMp && <MpWarehouseModal data={data} mp={editMp.mp} warehouseId={editMp.warehouseId} onClose={() => setEditMp(null)} onSaved={() => { setEditMp(null); reload(); }} />}
    </>
  );
}

function WarehouseModal({ wh, onClose, onSaved }: { wh: Warehouse | null; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ name: wh?.name ?? '', code: wh?.code ?? '', kind: wh?.kind ?? 'ff' as WarehouseKind, city: wh?.city ?? '',
    sheetName: wh?.sheetName ?? '', sort: wh?.sort ?? 100, notes: wh?.notes ?? '', active: wh?.active ?? true });
  const [err, setErr] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });
  const save = () => sklad.saveWarehouse(wh?.id ?? null, { ...f, sort: Number(f.sort) }).then(onSaved).catch(e => setErr(skladErr(e)));
  return (
    <Modal title={wh ? wh.name : 'Новый склад'} onClose={onClose}>
      <div className="grid grid-2">
        <Field label="Название"><input className="input" value={f.name} onChange={set('name')} /></Field>
        <Field label="Код (латиницей)" hint="Например ff-kazan"><input className="input" value={f.code} onChange={set('code')} /></Field>
        <Field label="Тип"><select className="input" value={f.kind} onChange={set('kind')}>{(['own', 'ff', 'transit'] as WarehouseKind[]).map(k => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}</select></Field>
        <Field label="Город"><input className="input" value={f.city} onChange={set('city')} /></Field>
        <Field label="Лист в Google-таблице" hint="Для сверки остатков на переходе"><input className="input" value={f.sheetName} onChange={set('sheetName')} /></Field>
        <Field label="Порядок в списке"><input className="input" inputMode="numeric" value={f.sort} onChange={set('sort')} /></Field>
      </div>
      <Field label="Заметки"><textarea className="input" rows={2} value={f.notes} onChange={set('notes')} /></Field>
      <label className="row gap-8"><input type="checkbox" checked={f.active} onChange={e => setF({ ...f, active: e.target.checked })} /> Склад работает</label>
      {err && <div className="sk-err"><WarningIcon size={14} weight="bold" /> {err}</div>}
      <div className="row gap-8 sk-actions"><button className="btn btn-primary" onClick={save}>Сохранить</button><button className="btn" onClick={onClose}>Отмена</button></div>
    </Modal>
  );
}

function MpWarehouseModal({ data, mp, warehouseId, onClose, onSaved }: { data: Bootstrap; mp: MpWarehouse | null; warehouseId: number; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ warehouseId: mp?.warehouseId ?? warehouseId, mp: mp?.mp ?? 'wb1' as MpCode, extName: mp?.extName ?? '',
    mode: mp?.mode ?? 'stock' as MpMode, notes: mp?.notes ?? '', active: mp?.active ?? true });
  const [err, setErr] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });
  const save = () => sklad.saveMpWarehouse(mp?.id ?? null, { ...f, warehouseId: Number(f.warehouseId) }).then(onSaved).catch(e => setErr(skladErr(e)));
  const del = () => { if (mp && window.confirm(`Отвязать «${mp.extName}»?`)) sklad.deleteMpWarehouse(mp.id).then(onSaved).catch(e => setErr(skladErr(e))); };
  return (
    <Modal title={mp ? mp.extName : 'Склад площадки'} onClose={onClose}>
      <div className="grid grid-2">
        <Field label="Наш склад"><select className="input" value={f.warehouseId} onChange={set('warehouseId')}>{data.warehouses.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}</select></Field>
        <Field label="Площадка"><select className="input" value={f.mp} onChange={set('mp')}>{data.dict.mps.map(m => <option key={m} value={m}>{MP_LABEL[m]}</option>)}</select></Field>
      </div>
      <Field label="Название склада в кабинете площадки" hint="Точно как в кабинете — по нему находится id"><input className="input" value={f.extName} onChange={set('extName')} /></Field>
      <Field label="Режим"><select className="input" value={f.mode} onChange={set('mode')}>{(['stock', 'heavy_only', 'orders_only'] as MpMode[]).map(m => <option key={m} value={m}>{MODE_LABEL[m]}</option>)}</select></Field>
      <Field label="Заметки"><textarea className="input" rows={2} value={f.notes} onChange={set('notes')} /></Field>
      <label className="row gap-8"><input type="checkbox" checked={f.active} onChange={e => setF({ ...f, active: e.target.checked })} /> Работает</label>
      {mp?.extId && <div className="muted sk-hint">id в кабинете: {mp.extId} · сверено {fmtDate(mp.syncedAt)}</div>}
      {err && <div className="sk-err"><WarningIcon size={14} weight="bold" /> {err}</div>}
      <div className="row gap-8 sk-actions">
        <button className="btn btn-primary" onClick={save}>Сохранить</button>
        <button className="btn" onClick={onClose}>Отмена</button>
        {mp && <><span className="sk-spacer" /><button className="btn btn-bad" onClick={del}>Отвязать</button></>}
      </div>
    </Modal>
  );
}

// ─── Пользователи ──────────────────────────────────────────────────────────
function UsersTab({ data, reload }: { data: Bootstrap; reload: () => void }) {
  const [edit, setEdit] = useState<User | 'new' | null>(null);
  const whName = (id: number) => data.warehouses.find(w => w.id === id)?.name ?? `#${id}`;
  return (
    <>
      <div className="sk-toolbar">
        <span className="muted">Общий пароль кабинета по-прежнему даёт вход владельца. Сотрудникам заводите личные учётки — им откроется только «Склад».</span>
        <span className="sk-spacer" />
        <button className="btn btn-primary" onClick={() => setEdit('new')}><PlusIcon size={16} /> Пользователь</button>
      </div>
      <div className="card sk-table-card">
        <div className="sk-scroll">
          <table className="sk-table">
            <thead><tr><th>Имя</th><th>Логин</th><th>Роль</th><th>Склады</th><th>Вход</th><th>Последний вход</th></tr></thead>
            <tbody>
              {data.users.map(u => (
                <tr key={u.id} className={u.active ? '' : 'sk-row-muted'} onClick={() => setEdit(u)}>
                  <td><b>{u.name}</b>{!u.active && <span className="chip sk-ml">выключен</span>}</td>
                  <td className="sk-mono">{u.login}</td>
                  <td>{ROLE_LABEL[u.role]}</td>
                  <td>{u.role === 'warehouse' ? u.warehouseIds.map(whName).join(', ') : <span className="muted">все</span>}</td>
                  <td>{[u.hasPassword && 'пароль', u.tgId && 'Telegram'].filter(Boolean).join(' + ')}</td>
                  <td className="muted">{fmtDate(u.lastLoginAt)}</td>
                </tr>
              ))}
              {!data.users.length && <tr><td colSpan={6} className="muted sk-empty">Пока никого — добавьте сотрудников</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
      {edit && <UserModal data={data} user={edit === 'new' ? null : edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); reload(); }} />}
    </>
  );
}

function UserModal({ data, user, onClose, onSaved }: { data: Bootstrap; user: User | null; onClose: () => void; onSaved: () => void }) {
  const roleSections = (r: Role) => data.dict.roles.find(x => x.value === r)?.sections ?? ['sklad'];
  const [f, setF] = useState({ name: user?.name ?? '', login: user?.login ?? '', role: user?.role ?? 'warehouse' as Role,
    password: '', tgId: user?.tgId ? String(user.tgId) : '', active: user?.active ?? true, warehouseIds: user?.warehouseIds ?? [] as number[],
    sections: user?.sections ?? roleSections('warehouse'), sectionsTouched: false });
  const [err, setErr] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  const setRole = (e: React.ChangeEvent<HTMLSelectElement>) => { const r = e.target.value as Role; setF({ ...f, role: r, sections: roleSections(r), sectionsTouched: false }); };
  const toggleWh = (id: number) => setF({ ...f, warehouseIds: f.warehouseIds.includes(id) ? f.warehouseIds.filter(x => x !== id) : [...f.warehouseIds, id] });
  const toggleSec = (s: string) => setF({ ...f, sectionsTouched: true, sections: f.sections.includes(s) ? f.sections.filter(x => x !== s) : [...f.sections, s] });
  const sectionsEditable = f.role === 'manager' || f.role === 'buyer';
  const save = () => {
    const input: Record<string, unknown> = { name: f.name, login: f.login, role: f.role, active: f.active,
      tgId: f.tgId.trim() ? Number(f.tgId.trim()) : null, warehouseIds: f.role === 'warehouse' ? f.warehouseIds : [] };
    if (sectionsEditable && (f.sectionsTouched || user?.customSections)) input.sections = f.sections;
    if (f.password) input.password = f.password;
    sklad.saveUser(user?.id ?? null, input).then(onSaved).catch(e => setErr(skladErr(e)));
  };
  return (
    <Modal title={user ? user.name : 'Новый пользователь'} onClose={onClose}>
      <div className="grid grid-2">
        <Field label="Имя"><input className="input" value={f.name} onChange={set('name')} /></Field>
        <Field label="Логин" hint="Почта сотрудника или любое слово латиницей"><input className="input" value={f.login} onChange={set('login')} autoCapitalize="none" /></Field>
        <Field label="Роль"><select className="input" value={f.role} onChange={setRole}>{data.dict.roles.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}</select></Field>
        <Field label={user ? 'Новый пароль' : 'Пароль'} hint={user ? 'Пусто — оставить прежний' : 'Не короче 8 символов'}><input className="input" type="text" value={f.password} onChange={set('password')} autoComplete="new-password" /></Field>
        <Field label="Telegram-ID" hint="Для входа из Telegram без пароля"><input className="input" inputMode="numeric" value={f.tgId} onChange={set('tgId')} /></Field>
      </div>
      {f.role === 'warehouse' && (
        <Field label="Какие склады видит">
          <div className="sk-checks">{data.warehouses.map(w => (
            <label key={w.id} className="row gap-8"><input type="checkbox" checked={f.warehouseIds.includes(w.id)} onChange={() => toggleWh(w.id)} /> {w.name}</label>
          ))}</div>
        </Field>
      )}
      <Field label="Разделы кабинета" hint={sectionsEditable ? 'По умолчанию — набор роли; можно добавить или убрать' : f.role === 'owner' ? 'Владельцу открыто всё' : 'Фулфилменту открыт только «Склад»'}>
        <div className="sk-checks">{data.dict.sections.map(s => (
          <label key={s.value} className="row gap-8">
            <input type="checkbox" checked={f.role === 'owner' || f.sections.includes(s.value)} disabled={!sectionsEditable || s.value === 'sklad'} onChange={() => toggleSec(s.value)} /> {s.label}
          </label>
        ))}</div>
      </Field>
      <div className="muted sk-hint">{f.role === 'warehouse' ? 'Видит только свои склады и только раздел «Склад», без цен и себестоимости.' :
        f.role === 'buyer' ? 'Видит только раздел «Склад»: товары, закупки, ссылки на Яндекс Диск.' :
        f.role === 'manager' ? 'Весь кабинет; в «Складе» — всё, кроме пользователей.' : 'Всё, включая пользователей.'}</div>
      {user && <label className="row gap-8"><input type="checkbox" checked={f.active} onChange={e => setF({ ...f, active: e.target.checked })} /> Учётка включена</label>}
      {err && <div className="sk-err"><WarningIcon size={14} weight="bold" /> {err}</div>}
      <div className="row gap-8 sk-actions"><button className="btn btn-primary" onClick={save}>Сохранить</button><button className="btn" onClick={onClose}>Отмена</button></div>
    </Modal>
  );
}

// ─── Журнал ────────────────────────────────────────────────────────────────
function AuditTab() {
  const [rows, setRows] = useState<AuditRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { sklad.audit(300).then(setRows).catch(e => setErr(skladErr(e))); }, []);
  if (err) return <div className="card sk-err">{err}</div>;
  if (!rows) return <div className="card muted">Загрузка…</div>;
  return <div className="card">{rows.length ? rows.map(a => <AuditLine key={a.id} a={a} showEntity />) : <span className="muted">Журнал пуст</span>}</div>;
}
