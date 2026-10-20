/** «Реклама»: общие подписи, окно подтверждения действий и мелкие значки (вынесено из Ads.tsx 20.10.2026). */
import { useCallback, useEffect, useState } from 'react';
import {
  WarningIcon, WarningOctagonIcon, LightbulbIcon, CheckCircleIcon, XIcon,
} from '@phosphor-icons/react';
import { apiPost, errText } from '../../api/http';
import type { Ads2Mp, Ads2ActionKind, Ads2Issue } from '../../../shared/ads2';

export type SetToast = (t: { ok: boolean; text: string }) => void;

export const STATUS: Record<string, { label: string; cls: string }> = {
  active: { label: 'активна', cls: 'good' }, paused: { label: 'пауза', cls: '' }, ready: { label: 'готова', cls: 'info' },
  out_of_budget: { label: 'нет бюджета', cls: 'warn' }, planned: { label: 'запланирована', cls: 'info' },
  finished: { label: 'завершена', cls: '' }, archived: { label: 'архив', cls: '' }, deleted: { label: 'удалена', cls: '' },
};
export const PAYMENT: Record<string, string> = { cpm: 'за показы', cpc: 'за клик', cpo: 'за заказ' };
export const OZ_STRATEGY: Record<string, string> = {
  TARGET_BIDS: 'средняя цена клика', MAX_CLICKS: 'макс. кликов', TOP_MAX_CLICKS: 'топ, макс. кликов',
  TARGET_CIR: 'целевой ДРР', TOP_PROMOTION: 'вывод в топ', NO_AUTO_STRATEGY: 'без стратегии',
};
export const bidTypeLabel = (mp: Ads2Mp, t: string | null) => (mp === 'wb' ? (t === 'unified' ? 'единая ставка' : 'ручная ставка') : (OZ_STRATEGY[t ?? ''] ?? t ?? ''));

// ─── Окно подтверждения и уведомления ───────────────────────────────────────

export type ActionPayload = {
  mp: Ads2Mp; campaignId: string; kind: Ads2ActionKind; sku?: string; placement?: 'search' | 'recommendations' | 'combined';
  valueRub?: number; enabled?: boolean; confirmBig?: boolean;
};
export type Pending = { title: string; lines: string[]; payload: ActionPayload; warn?: string };
export type ActionResult = { ok: boolean; message: string; needConfirm?: boolean };

export function ConfirmDialog({ p, busy, onCancel, onOk }: { p: Pending; busy: boolean; onCancel: () => void; onOk: () => void }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onCancel(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [busy, onCancel]);
  return (
    <div className="ad2-modal-bg" onClick={() => !busy && onCancel()}>
      <div className="ad2-modal" role="dialog" aria-modal="true" aria-label={p.title} onClick={e => e.stopPropagation()}>
        <h3>{p.title}</h3>
        {p.lines.map(l => <p key={l}>{l}</p>)}
        {p.warn && <div className="ad2-warnbox"><WarningIcon size={16} /> {p.warn}</div>}
        <p className="muted ad2-small">Команда уйдёт в {p.payload.mp === 'wb' ? 'Wildberries' : 'Ozon'} сразу и запишется в журнал.</p>
        <div className="ad2-modal-btns">
          <button className="btn" onClick={onCancel} disabled={busy}>Отмена</button>
          <button className="btn btn-primary" onClick={onOk} disabled={busy}>{busy ? 'Отправляю…' : 'Применить'}</button>
        </div>
      </div>
    </div>
  );
}

export function useActions(reload: () => void) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.ok ? 5000 : 12000);
    return () => clearTimeout(t);
  }, [toast]);
  const run = useCallback(async () => {
    if (!pending) return;
    setBusy(true);
    try {
      const r = await apiPost<ActionResult>('/api/ads2/action', pending.payload);
      if (r.data.needConfirm) {
        // Большой скачок ставки/бюджета: сервер просит отдельное подтверждение.
        setPending({ ...pending, warn: r.data.message, payload: { ...pending.payload, confirmBig: true } });
        return;
      }
      setToast({ ok: r.data.ok, text: r.data.ok ? `Готово: ${r.data.message}` : `Не применено: ${r.data.message}` });
      setPending(null);
      if (r.data.ok) reload();
    } catch (e) {
      setToast({ ok: false, text: `Не применено: ${errText(e)}` });
      setPending(null);
    } finally { setBusy(false); }
  }, [pending, reload]);
  const ui = (
    <>
      {pending && <ConfirmDialog p={pending} busy={busy} onCancel={() => setPending(null)} onOk={run} />}
      {toast && (
        <div className={`ad2-toast ${toast.ok ? 'ok' : 'bad'}`} role="status">
          {toast.ok ? <CheckCircleIcon size={18} /> : <WarningIcon size={18} />} <span>{toast.text}</span>
          <button className="ad2-x" onClick={() => setToast(null)} aria-label="Закрыть"><XIcon size={14} /></button>
        </div>
      )}
    </>
  );
  return { ask: setPending, ui, setToast };
}

// ─── Мелкие детали ──────────────────────────────────────────────────────────

export function StatusChip({ s }: { s: string }) {
  const st = STATUS[s] ?? { label: s || '—', cls: '' };
  return <span className={`chip ${st.cls}`}>{st.label}</span>;
}

export function IssueIcon({ i }: { i: Ads2Issue }) {
  const Icon = i.level === 'critical' ? WarningOctagonIcon : i.level === 'warn' ? WarningIcon : LightbulbIcon;
  return <span className={`ad2-issue ad2-lv-${i.level}`} title={i.text}><Icon size={16} weight="fill" /></span>;
}
