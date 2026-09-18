import { useEffect, useState } from 'react';
import { SparkleIcon, SpinnerIcon, ArrowsClockwiseIcon, ClockCounterClockwiseIcon } from '@phosphor-icons/react';
import { apiGet, errText } from '../api/http';
import type { ManageReport } from './AdsManage';

/**
 * Панель Claude в «Управлении рекламой»: рекомендации по артикулам с шагом и
 * эффектом в ₽/нед, действия по магазину, разбор прошлых советов и журнал запусков.
 * Данные — /api/ads-insight (сервер собирает вход из ads-manage и зовёт Claude).
 */

type Action = 'усилить' | 'держать' | 'сбавить' | 'остановить' | 'запустить';
type Insight = {
  ok: boolean; error?: string; platform: 'wb' | 'ozon'; generatedAt: number; model: string;
  summary: string; storeActions: { priority: 'high' | 'medium' | 'low'; text: string }[];
  items: { article: string; action: Action; why: string; step: string; effectRub: number; risk?: string }[];
  warnings: string[]; followUp?: { prevAt: number; lines: string[] };
};
type JournalEntry = { at: number; platform: string; summary: string; items: Insight['items']; storeActions: Insight['storeActions'] };

const ACTION_META: Record<Action, { color: string; bg: string }> = {
  'усилить':    { color: 'var(--good)',  bg: 'rgba(22,163,74,.12)' },
  'запустить':  { color: 'var(--good)',  bg: 'rgba(22,163,74,.08)' },
  'держать':    { color: 'var(--text)',  bg: 'var(--bg-3)' },
  'сбавить':    { color: 'var(--warn)',  bg: 'rgba(217,119,6,.12)' },
  'остановить': { color: 'var(--bad)',   bg: 'rgba(220,38,38,.12)' },
};
const fmtRub = (n: number) => (n > 0 ? '+' : '') + Math.round(n).toLocaleString('ru-RU') + ' ₽';
const fmtDate = (ms: number) => new Date(ms).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

export function AdsInsightPanel({ platform, report }: { platform: 'wb' | 'ozon'; report: ManageReport | null }) {
  const [ins, setIns] = useState<Insight | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [journal, setJournal] = useState<JournalEntry[] | null>(null);
  const [showJournal, setShowJournal] = useState(false);

  const load = async (refresh = false) => {
    setLoading(true); setError(null);
    try {
      const { data } = await apiGet<Insight>(`/api/ads-insight?mp=${platform}${refresh ? '&refresh=1' : ''}`, { timeoutMs: 180_000 });
      if (!data?.ok) throw new Error(data?.error || 'нет ответа');
      setIns(data);
      if (data.error) setError(data.error);
      if (showJournal) void loadJournal();
    } catch (e) {
      setError(errText(e));
    } finally {
      setLoading(false);
    }
  };
  const loadJournal = async () => {
    try {
      const { data } = await apiGet<{ ok: boolean; entries: JournalEntry[] }>(`/api/ads-insight?mp=${platform}&journal=1`);
      setJournal((data?.entries ?? []).slice().reverse());
    } catch { setJournal([]); }
  };
  useEffect(() => { setIns(null); void load(); /* eslint-disable-next-line */ }, [platform]);

  const rowsByArt = new Map((report?.rows ?? []).filter((r) => r.platform === platform).map((r) => [r.article, r]));
  const total = (ins?.items ?? []).reduce((s, it) => s + (it.effectRub || 0), 0);

  return (
    <div className="card" style={{ borderColor: 'var(--accent)', background: 'var(--accent-soft, rgba(99,102,241,.06))' }}>
      <div className="flex-between" style={{ flexWrap: 'wrap', gap: 8 }}>
        <div className="row gap-8" style={{ alignItems: 'center' }}>
          <SparkleIcon size={18} weight="fill" style={{ color: 'var(--accent)' }} />
          <b>Рекомендации Claude · {platform === 'wb' ? 'WB' : 'Ozon'}</b>
          {ins?.generatedAt ? <span className="muted" style={{ fontSize: 12 }}>анализ от {fmtDate(ins.generatedAt)}{ins.model ? ` · ${ins.model}` : ''}</span> : null}
        </div>
        <div className="row gap-8">
          <button className="btn btn-sm" onClick={() => { setShowJournal((v) => !v); if (!journal) void loadJournal(); }} title="Прошлые запуски анализа">
            <ClockCounterClockwiseIcon size={14} /> Журнал
          </button>
          <button className="btn btn-sm" onClick={() => load(true)} disabled={loading} title="Запросить свежий анализ у Claude (30–60 сек). Автоматически обновляется раз в сутки после 06:00 МСК">
            {loading ? <SpinnerIcon size={14} className="spin" /> : <ArrowsClockwiseIcon size={14} />} Обновить анализ
          </button>
        </div>
      </div>

      {error && <div style={{ color: 'var(--bad)', fontSize: 13, marginTop: 8 }}>{error}</div>}
      {!ins && loading && <div className="muted" style={{ marginTop: 10 }}><SpinnerIcon size={14} className="spin" /> Claude смотрит рекламу, заказы, остатки и маржу…</div>}

      {ins && (
        <div className="grid" style={{ gap: 12, marginTop: 10 }}>
          {ins.summary && <div style={{ fontSize: 14, lineHeight: 1.45 }}>{ins.summary}</div>}

          {ins.storeActions.length > 0 && (
            <div>
              <div className="card-title" style={{ marginBottom: 4 }}>По магазину</div>
              {ins.storeActions.map((a, i) => (
                <div key={i} style={{ fontSize: 13, padding: '3px 0' }}>
                  <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 4, marginRight: 8, background: a.priority === 'high' ? 'var(--bad)' : a.priority === 'medium' ? 'var(--warn)' : 'var(--muted)' }} />
                  {a.text}
                </div>
              ))}
            </div>
          )}

          {ins.items.length > 0 && (
            <div>
              <div className="flex-between" style={{ marginBottom: 4 }}>
                <div className="card-title">По товарам · {ins.items.length}</div>
                <div className="muted" style={{ fontSize: 12 }} title="Сумма оценок эффекта по всем рекомендациям, ₽ в неделю">итого эффект ≈ <b style={{ color: total >= 0 ? 'var(--good)' : 'var(--bad)' }}>{fmtRub(total)}/нед</b></div>
              </div>
              <div className="tbl-scroll">
                <table style={{ width: '100%', fontSize: 13 }}>
                  <thead>
                    <tr>
                      <th style={{ textAlign: 'left', width: 170 }}>Артикул</th>
                      <th style={{ textAlign: 'left', width: 96 }}>Решение</th>
                      <th style={{ textAlign: 'left' }}>Почему · что сделать</th>
                      <th style={{ textAlign: 'right', width: 110 }} title="Оценка эффекта, ₽ в неделю">Эффект</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ins.items.map((it) => {
                      const r = rowsByArt.get(it.article);
                      const m = ACTION_META[it.action] ?? ACTION_META['держать'];
                      return (
                        <tr key={it.article}>
                          <td style={{ verticalAlign: 'top' }}>
                            <div style={{ fontWeight: 600 }}>{it.article}</div>
                            {r && <div className="muted" style={{ fontSize: 11 }}>расход {Math.round(r.spend7).toLocaleString('ru-RU')} ₽ · ДРР {r.drr7 ?? r.drrAds7 ?? '—'}%{r.stockDays !== null ? ` · остаток ${r.stockDays} дн` : ''}</div>}
                          </td>
                          <td style={{ verticalAlign: 'top' }}>
                            <span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 999, fontSize: 12, fontWeight: 600, color: m.color, background: m.bg, whiteSpace: 'nowrap' }}>{it.action}</span>
                          </td>
                          <td style={{ verticalAlign: 'top' }}>
                            <div>{it.why}</div>
                            <div className="muted" style={{ fontSize: 12 }}>→ {it.step}{it.risk ? ` · риск: ${it.risk}` : ''}</div>
                          </td>
                          <td style={{ verticalAlign: 'top', textAlign: 'right', fontWeight: 600, color: it.effectRub >= 0 ? 'var(--good)' : 'var(--bad)' }}>{fmtRub(it.effectRub)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {ins.followUp?.lines?.length ? (
            <div>
              <div className="card-title" style={{ marginBottom: 4 }}>Прошлые советы ({fmtDate(ins.followUp.prevAt)}) — что стало</div>
              {ins.followUp.lines.map((l, i) => <div key={i} className="muted" style={{ fontSize: 12 }}>· {l}</div>)}
            </div>
          ) : null}

          {ins.warnings.length > 0 && (
            <div className="muted" style={{ fontSize: 12 }}>
              {ins.warnings.map((w, i) => <div key={i}>⚠ {w}</div>)}
            </div>
          )}
        </div>
      )}

      {showJournal && (
        <div style={{ marginTop: 12, borderTop: '1px solid var(--border)', paddingTop: 10 }}>
          <div className="card-title" style={{ marginBottom: 6 }}>Журнал запусков</div>
          {!journal && <div className="muted" style={{ fontSize: 12 }}>загрузка…</div>}
          {journal && journal.length === 0 && <div className="muted" style={{ fontSize: 12 }}>пока пусто</div>}
          {journal?.map((e, i) => (
            <details key={i} style={{ fontSize: 13, marginBottom: 4 }}>
              <summary>{fmtDate(e.at)} · {e.items?.length ?? 0} рекомендаций · эффект {fmtRub((e.items ?? []).reduce((s, it) => s + (it.effectRub || 0), 0))}/нед</summary>
              <div className="muted" style={{ fontSize: 12, margin: '4px 0 6px' }}>{e.summary}</div>
              {(e.items ?? []).map((it, k) => <div key={k} style={{ fontSize: 12 }}>{it.article} — <b>{it.action}</b>: {it.step} ({fmtRub(it.effectRub)})</div>)}
            </details>
          ))}
        </div>
      )}
    </div>
  );
}
