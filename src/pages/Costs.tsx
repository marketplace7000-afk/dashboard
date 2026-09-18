import { useEffect, useMemo, useState } from 'react';
import {
  SpinnerIcon, ArrowsClockwiseIcon, WarningIcon, CheckCircleIcon, UploadSimpleIcon, MagnifyingGlassIcon,
} from '@phosphor-icons/react';
import { useProcurement } from '../api/useProcurement';
import { apiGet, apiPost, errText } from '../api/http';

/**
 * Себестоимость — свой справочник вместо листа «Склад» в Google-таблице.
 *
 * Почему это отдельный раздел: себестоимости нет ни в одном API площадок, это
 * данные закупок. Всё остальное (цены, комиссии, логистика, реклама) мы уже
 * тянем из API — она осталась последней, что держит нас на чужой таблице.
 *
 * Принцип показа: если себестоимости нет — прочерк и явный счётчик «нет по N
 * товарам», а не подстановка оценки. Оценка молча превращает ROI в выдумку.
 */

type CostEntry = { cost: number; source: 'manual' | 'import'; updatedAt: string; note?: string };
type Resp = { ok: boolean; items?: Record<string, CostEntry>; updatedAt?: string; error?: string };

const rub = (n: number) => Math.round(n).toLocaleString('ru-RU') + ' ₽';
const norm = (s: unknown) => String(s ?? '').trim().toUpperCase();

export function Costs() {
  const procurement = useProcurement();
  const [data, setData] = useState<Resp | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [onlyMissing, setOnlyMissing] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [csv, setCsv] = useState('');
  const [showImport, setShowImport] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const { data: j } = await apiGet<Resp>('/api/costs');
      setData(j);
    } catch (e) {
      setData({ ok: false, error: errText(e) });
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { void load(); }, []);

  const costs = data?.items ?? {};

  // Список товаров берём из закупочного модуля — это тот же перечень, по которому
  // считаются ROI и прогноз, поэтому «покрытие» здесь означает ровно то, что нужно.
  const rows = useMemo(() => {
    const list = (procurement.items ?? []).map((p: any) => ({
      sku: norm(p.sku),
      name: String(p.name ?? ''),
      cost: costs[norm(p.sku)]?.cost ?? null,
      note: costs[norm(p.sku)]?.note,
      source: costs[norm(p.sku)]?.source,
    })).filter(r => r.sku);

    // Артикулы, которые есть в справочнике, но которых нет в закупках — не теряем.
    const seen = new Set(list.map(r => r.sku));
    for (const [sku, e] of Object.entries(costs)) {
      if (!seen.has(sku)) list.push({ sku, name: '', cost: e.cost, note: e.note, source: e.source });
    }

    const needle = q.trim().toUpperCase();
    return list
      .filter(r => (!onlyMissing || r.cost === null))
      .filter(r => !needle || r.sku.includes(needle) || r.name.toUpperCase().includes(needle))
      .sort((a, b) => (a.cost === null ? 0 : 1) - (b.cost === null ? 0 : 1) || a.sku.localeCompare(b.sku));
  }, [procurement.items, costs, q, onlyMissing]);

  const known = rows.filter(r => r.cost !== null).length;
  const missing = rows.filter(r => r.cost === null).length;

  const saveDraft = async () => {
    const items = Object.fromEntries(Object.entries(draft).filter(([, v]) => v.trim() !== ''));
    if (!Object.keys(items).length) { setMsg('Нечего сохранять'); return; }
    setSaving(true); setMsg(null);
    try {
      const { data: j } = await apiPost<any>('/api/costs', { items });
      if (!j?.ok) throw new Error(j?.error ?? 'сервер не подтвердил сохранение');
      setMsg(`Сохранено: ${j.saved}${j.removed ? `, удалено: ${j.removed}` : ''}`);
      setDraft({});
      await load();
      // Пересчитываем закупки/ROI: иначе новая себестоимость увидится только
      // после перезагрузки страницы, и человек решит, что сохранение не сработало.
      procurement.reload();
    } catch (e) {
      setMsg(`Не сохранилось: ${errText(e)}`);
    } finally {
      setSaving(false);
    }
  };

  // Подтянуть себестоимость из основной таблицы клиента. Клиент 11.08 попросил
  // оставить таблицу системой учёта — значит она источник, а мы её кэш.
  const syncSklad = async () => {
    setSaving(true); setMsg(null);
    try {
      const { data: j } = await apiPost<any>('/api/costs', { sync: 'sklad' }, { timeoutMs: 90_000 });
      if (!j?.ok) throw new Error(j?.error ?? 'таблица не прочиталась');
      setMsg(`Из таблицы обновлено: ${j.updated}, всего в справочнике: ${j.total}`);
      await load();
      procurement.reload();
    } catch (e: any) {
      setMsg(`Не сохранилось: не вышло подтянуть таблицу — ${errText(e)}`);
    } finally {
      setSaving(false);
    }
  };

  const importCsv = async () => {
    if (!csv.trim()) return;
    setSaving(true); setMsg(null);
    try {
      const { data: j } = await apiPost<any>('/api/costs', { csv });
      if (!j?.ok) throw new Error(j?.error ?? 'импорт не принят');
      setMsg(`Импортировано: ${j.saved}${j.skipped?.length ? ` · пропущено строк: ${j.skipped.length}` : ''}`);
      setCsv('');
      setShowImport(false);
      await load();
      procurement.reload();
    } catch (e) {
      setMsg(`Импорт не прошёл: ${errText(e)}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="grid" style={{ gap: 20 }}>
      <div className="row gap-8" style={{ justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap' }}>
        <div className="muted" style={{ fontSize: 13, maxWidth: 640 }}>
          Себестоимости нет ни в одном API маркетплейса — это ваши данные о закупках.
          Здесь она хранится у нас, а не в Google-таблице. Где её нет — ROI не считается,
          и это видно прочерком, а не подставленной оценкой.
        </div>
        <div className="row gap-8">
          <button className="btn btn-sm" onClick={() => void syncSklad()} disabled={saving}>
            {saving ? <SpinnerIcon size={13} className="spin" /> : <ArrowsClockwiseIcon size={13} weight="bold" />}
            Из таблицы «Склад»
          </button>
          <button className="btn btn-sm" onClick={() => setShowImport(s => !s)}>
            <UploadSimpleIcon size={13} weight="bold" /> Импорт
          </button>
          <button className="btn btn-sm" onClick={() => void load()} disabled={loading}>
            {loading ? <SpinnerIcon size={13} className="spin" /> : <ArrowsClockwiseIcon size={13} weight="bold" />}
            Обновить
          </button>
        </div>
      </div>

      <div className="grid grid-3" style={{ gap: 12 }}>
        <div className="kpi">
          <div className="card-title">Себестоимость известна</div>
          <div className="v" style={{ color: 'var(--good)' }}>{known}</div>
        </div>
        <div className="kpi">
          <div className="card-title">Нет себестоимости</div>
          <div className="v" style={{ color: missing ? 'var(--bad)' : undefined }}>{missing}</div>
          {missing > 0 && <div className="muted" style={{ fontSize: 11 }}>по ним ROI и прибыль не считаются</div>}
        </div>
        <div className="kpi">
          <div className="card-title">Обновлено</div>
          <div className="v" style={{ fontSize: 18 }}>
            {data?.updatedAt ? new Date(data.updatedAt).toLocaleString('ru-RU', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'}
          </div>
        </div>
      </div>

      {showImport && (
        <div className="card">
          <div className="card-title">Импорт из файла</div>
          <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
            По строке на товар: <code>артикул;себестоимость;пометка</code>. Разделитель — точка с запятой,
            запятая или таб. Заголовок можно оставить. Пометка необязательна — туда удобно писать партию или поставщика.
          </div>
          <textarea
            className="input"
            value={csv}
            onChange={e => setCsv(e.target.value)}
            rows={8}
            placeholder={'POLFAR;820;партия июль\nCARBITLINK;5400'}
            style={{ width: '100%', fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12 }}
          />
          <div className="row gap-8" style={{ marginTop: 8 }}>
            <button className="btn btn-primary btn-sm" onClick={() => void importCsv()} disabled={saving || !csv.trim()}>
              {saving ? <SpinnerIcon size={13} className="spin" /> : <UploadSimpleIcon size={13} weight="bold" />}
              Загрузить
            </button>
            <button className="btn btn-sm" onClick={() => { setShowImport(false); setCsv(''); }}>Отмена</button>
          </div>
        </div>
      )}

      {msg && (
        <div className="card" style={{ borderLeft: `3px solid ${msg.startsWith('Не') ? 'var(--bad)' : 'var(--good)'}` }}>
          <div className="row gap-8" style={{ alignItems: 'center', fontSize: 13 }}>
            {msg.startsWith('Не')
              ? <WarningIcon size={15} weight="bold" style={{ color: 'var(--bad)' }} />
              : <CheckCircleIcon size={15} weight="bold" style={{ color: 'var(--good)' }} />}
            {msg}
          </div>
        </div>
      )}

      {data && !data.ok && (
        <div className="card">
          <div className="muted" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <WarningIcon size={14} weight="bold" /> {data.error ?? 'не удалось загрузить'}
          </div>
        </div>
      )}

      <div className="card">
        <div className="row gap-8" style={{ justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap' }}>
          <div className="row gap-8" style={{ alignItems: 'center' }}>
            <MagnifyingGlassIcon size={14} weight="bold" style={{ color: 'var(--muted)' }} />
            <input
              className="input"
              value={q}
              onChange={e => setQ(e.target.value)}
              placeholder="артикул или название"
              style={{ width: 220, padding: '6px 8px', fontSize: 12 }}
            />
            <label className="row gap-8" style={{ alignItems: 'center', fontSize: 12, cursor: 'pointer' }}>
              <input type="checkbox" checked={onlyMissing} onChange={e => setOnlyMissing(e.target.checked)} />
              только без себестоимости
            </label>
          </div>
          <button
            className="btn btn-primary btn-sm"
            onClick={() => void saveDraft()}
            disabled={saving || !Object.keys(draft).length}
          >
            {saving ? <SpinnerIcon size={13} className="spin" /> : null}
            Сохранить{Object.keys(draft).length ? ` (${Object.keys(draft).length})` : ''}
          </button>
        </div>

        <div style={{ overflowX: 'auto', marginTop: 12 }}>
          <table className="table" style={{ minWidth: 620 }}>
            <thead>
              <tr>
                <th>Артикул</th>
                <th>Товар</th>
                <th style={{ textAlign: 'right' }}>Себестоимость</th>
                <th style={{ width: 150 }}>Новое значение</th>
                <th>Пометка</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.sku}>
                  <td style={{ fontWeight: 600, fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12 }}>{r.sku}</td>
                  <td className="muted" style={{ fontSize: 12 }}>{r.name || '—'}</td>
                  <td style={{ textAlign: 'right', color: r.cost === null ? 'var(--bad)' : undefined }}>
                    {r.cost === null ? 'нет' : rub(r.cost)}
                  </td>
                  <td>
                    <input
                      className="input"
                      inputMode="decimal"
                      value={draft[r.sku] ?? ''}
                      onChange={e => setDraft(d => ({ ...d, [r.sku]: e.target.value }))}
                      placeholder={r.cost === null ? 'ввести' : 'изменить'}
                      style={{ padding: '4px 6px', fontSize: 12, width: 120 }}
                    />
                  </td>
                  <td className="muted" style={{ fontSize: 11 }}>
                    {r.note ?? (r.source === 'import' ? 'из импорта' : '')}
                  </td>
                </tr>
              ))}
              {!rows.length && (
                <tr><td colSpan={5} className="muted" style={{ padding: 14 }}>
                  {procurement.loading ? 'Загружаем список товаров…' : 'Ничего не найдено'}
                </td></tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>
          Пустое поле «Новое значение» ничего не меняет. Ноль или минус — удаляет себестоимость:
          так можно снять ошибочную цифру, не оставляя ноль, который посчитался бы как настоящая цена закупки.
        </div>
      </div>
    </div>
  );
}
