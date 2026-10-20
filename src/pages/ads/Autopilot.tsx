/** «Реклама» → «Автопилот» (этап 2, «советник»): предложения по правилам, решение за менеджером, замер эффекта. */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowsClockwiseIcon, WarningIcon, CheckCircleIcon, XIcon, RobotIcon, PlayIcon, PauseIcon,
} from '@phosphor-icons/react';
import { apiGet, apiPost, errText } from '../../api/http';
import { rub, num, pct, ProductCell } from '../ads2ui';
import type { Ads2Overview, Ads2Proposal, Ads2AutopilotState } from '../../../shared/ads2';
import type { ActionResult, SetToast } from './shared';


type ApResp = { state: Ads2AutopilotState; proposals: Ads2Proposal[] };
type ApDecision = { p: Ads2Proposal; decision: 'apply' | 'reject'; warn?: string; confirmBig?: boolean };

const LEVEL: Record<Ads2Proposal['level'], { label: string; cls: string }> = {
  critical: { label: 'срочно', cls: 'bad' }, warn: { label: 'внимание', cls: 'warn' }, growth: { label: 'рост', cls: 'good' }, info: { label: 'совет', cls: 'info' },
};
const P_STATUS: Record<string, { label: string; cls: string }> = {
  applied: { label: 'применено', cls: 'good' }, rejected: { label: 'отклонено', cls: '' }, failed: { label: 'отказ площадки', cls: 'bad' },
};
const isCommand = (p: Ads2Proposal) => p.kind !== 'task' && p.kind !== 'new_campaign';
const dt = (ms: number) => new Date(ms).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

function DecideDialog({ x, busy, onCancel, onOk, setNote, note }: {
  x: ApDecision; busy: boolean; onCancel: () => void; onOk: () => void; note: string; setNote: (s: string) => void;
}) {
  const apply = x.decision === 'apply';
  return (
    <div className="ad2-modal-bg" onClick={() => !busy && onCancel()}>
      <div className="ad2-modal" role="dialog" aria-modal="true" aria-label={x.p.title} onClick={e => e.stopPropagation()}>
        <h3>{apply ? (isCommand(x.p) ? 'Применить предложение' : 'Принять совет') : 'Отклонить предложение'}</h3>
        <p><b>{x.p.title}</b></p>
        <p className="muted">{x.p.reason}</p>
        {x.warn && <div className="ad2-warnbox"><WarningIcon size={16} /> {x.warn}</div>}
        {!apply && (
          <label className="ad2-field">Почему (необязательно — автопилот учтётся и 3 дня не будет предлагать это снова)
            <input className="input" value={note} maxLength={300} onChange={e => setNote(e.target.value)} placeholder="например: идёт акция, ставку держим" />
          </label>
        )}
        {apply && isCommand(x.p) && <p className="muted ad2-small">Команда уйдёт в {x.p.mp === 'wb' ? 'Wildberries' : 'Ozon'} сразу и запишется в журнал.</p>}
        <div className="ad2-modal-btns">
          <button className="btn" onClick={onCancel} disabled={busy}>Отмена</button>
          <button className={`btn ${apply ? 'btn-primary' : ''}`} onClick={onOk} disabled={busy}>
            {busy ? 'Отправляю…' : apply ? (isCommand(x.p) ? 'Применить' : 'Принято') : 'Отклонить'}
          </button>
        </div>
      </div>
    </div>
  );
}

function EffectCell({ e }: { e: Ads2Proposal['effect'] }) {
  if (!e) return <span className="muted">–</span>;
  if (!e.days || !e.after) return <span className="muted">замер завтра</span>;
  const b = e.before;
  return (
    <span className="ad2-small" title="3 дня до решения → дни после (до 3)">
      расход/день {rub(b?.perDay)} → <b>{rub(e.after.perDay)}</b> · заказы {num(b?.orders)} → <b>{num(e.after.orders)}</b> · ДРР {pct(b?.drr)} → <b>{pct(e.after.drr)}</b>
      <span className="muted"> ({e.days} дн)</span>
    </span>
  );
}

export function Autopilot({ d, setToast, reload }: { d: Ads2Overview; setToast: SetToast; reload: () => void }) {
  const mp = d.mp;
  const [view, setView] = useState<'open' | 'done'>('open');
  const [data, setData] = useState<ApResp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [dec, setDec] = useState<ApDecision | null>(null);
  const [note, setNote] = useState('');

  const load = useCallback(async () => {
    try { const r = await apiGet<ApResp>(`/api/ads2/autopilot?mp=${mp}${view === 'done' ? '&history=1' : ''}`); setData(r.data); setErr(null); }
    catch (e) { setErr(errText(e)); }
  }, [mp, view]);
  useEffect(() => { void load(); }, [load]);

  const prodBySku = useMemo(() => new Map(d.products.filter(p => p.adSku).map(p => [p.adSku!, p])), [d]);
  const campName = useMemo(() => new Map(d.campaigns.map(c => [c.id, c.name])), [d]);

  const post = async (body: Record<string, unknown>, label: string) => {
    setBusy(label);
    try { const r = await apiPost<ApResp>('/api/ads2/autopilot', body, { timeoutMs: 120_000 }); setData(r.data); if (view === 'done') await load(); }
    catch (e) { setToast({ ok: false, text: `Не получилось: ${errText(e)}` }); }
    finally { setBusy(null); }
  };
  const decide = async () => {
    if (!dec) return;
    setBusy('decide');
    try {
      const r = await apiPost<ActionResult>('/api/ads2/autopilot', { id: dec.p.id, decision: dec.decision, note: note || null, confirmBig: !!dec.confirmBig });
      if (r.data.needConfirm) { setDec({ ...dec, warn: r.data.message, confirmBig: true }); return; }
      setToast({ ok: r.data.ok, text: r.data.ok ? `Готово: ${r.data.message}` : `Не применено: ${r.data.message}` });
      setDec(null); setNote('');
      await load();
      if (r.data.ok && dec.decision === 'apply' && isCommand(dec.p)) reload();
    } catch (e) {
      setToast({ ok: false, text: `Не применено: ${errText(e)}` });
      setDec(null);
    } finally { setBusy(null); }
  };

  const st = data?.state;
  const list = data?.proposals ?? [];
  const commands = list.filter(isCommand);
  const advice = list.filter(p => !isCommand(p));

  const card = (p: Ads2Proposal) => {
    const pr = p.sku ? prodBySku.get(p.sku) : undefined;
    return (
      <div key={p.id} className={`ad2-prop lvl-${p.level}`}>
        <div className="ad2-prop-main">
          <div className="ad2-prop-title"><span className={`chip ${LEVEL[p.level].cls}`}>{LEVEL[p.level].label}</span> <b>{p.title}</b></div>
          <div className="ad2-prop-what">
            {(pr || p.sku) && <ProductCell p={{ photo: pr?.photo ?? '', name: pr?.name || p.productName || '', article: pr?.article ?? p.sku ?? '', link: pr?.link }} />}
            {p.campaignId && <span className="muted ad2-small">Кампания: {campName.get(p.campaignId) ?? p.campaignName ?? p.campaignId}</span>}
          </div>
          <p className="ad2-prop-reason">{p.reason}</p>
        </div>
        <div className="ad2-prop-btns">
          <button className="btn btn-primary btn-sm" disabled={!!busy || st?.mode === 'off'} onClick={() => { setNote(''); setDec({ p, decision: 'apply' }); }}>
            <CheckCircleIcon size={14} /> {isCommand(p) ? 'Применить' : 'Принято'}
          </button>
          <button className="btn btn-sm" disabled={!!busy} onClick={() => { setNote(''); setDec({ p, decision: 'reject' }); }}>
            <XIcon size={14} /> {isCommand(p) ? 'Отклонить' : 'Скрыть'}
          </button>
        </div>
      </div>
    );
  };

  return (
    <>
      <section className="card ad2-ap-head">
        <div className="ad2-ap-mode">
          <RobotIcon size={22} />
          <div>
            <b>Автопилот: {st?.mode === 'off' ? 'выключен' : 'с подтверждением'}</b>
            <div className="muted ad2-small">
              {st?.mode === 'off' ? 'Предложения не готовятся.'
                : `Готовит предложения, применяет менеджер${st?.confirmUntil ? ` · режим «с подтверждением» до ${new Date(st.confirmUntil).toLocaleDateString('ru-RU')} (решение владельца)` : ''}.`}
              {st?.lastRun && <> Пересчёт: {dt(st.lastRun.at)}.</>}
            </div>
          </div>
        </div>
        <span className="rnp-spacer" />
        {st && (st.counts14d.applied || st.counts14d.rejected) ? (
          <span className="muted ad2-small">за 14 дн: применено {st.counts14d.applied ?? 0}, отклонено {st.counts14d.rejected ?? 0}</span>
        ) : null}
        <button className="btn btn-sm" disabled={!!busy || st?.mode === 'off'} onClick={() => post({ run: true }, 'run')} title="Пересчитать предложения по свежим данным">
          <ArrowsClockwiseIcon size={13} className={busy === 'run' ? 'spin' : ''} /> Пересчитать
        </button>
        <button className="btn btn-sm" disabled={!!busy} onClick={() => post({ mode: st?.mode === 'off' ? 'confirm' : 'off' }, 'mode')}>
          {st?.mode === 'off' ? <><PlayIcon size={13} /> Включить</> : <><PauseIcon size={13} /> Выключить</>}
        </button>
      </section>

      <div className="period-switch ad2-ap-views" role="group" aria-label="Список">
        <button className={`period-btn ${view === 'open' ? 'active' : ''}`} onClick={() => setView('open')}>Предложения{view === 'open' && data ? ` · ${list.length}` : ''}</button>
        <button className={`period-btn ${view === 'done' ? 'active' : ''}`} onClick={() => setView('done')}>Решённые и замер</button>
      </div>

      {err && <div className="rnp-alert">Автопилот не загрузился: {err}</div>}
      {!data && !err && <div className="card muted">Загружаю…</div>}

      {data && view === 'open' && (
        <>
          {!list.length && <section className="card muted">{st?.mode === 'off' ? 'Автопилот выключен.' : 'Предложений нет — всё в пределах правил. Пересчёт идёт после каждого обновления данных.'}</section>}
          {commands.length > 0 && (
            <section className="card ad2-props">
              <h3>Изменения в кампаниях · {commands.length}</h3>
              {commands.map(card)}
            </section>
          )}
          {advice.length > 0 && (
            <section className="card ad2-props">
              <h3>Советы команде · {advice.length}</h3>
              <p className="muted ad2-small">Площадке ничего не отправляется: задачи по карточке и кандидаты на новые кампании — решает менеджер.</p>
              {advice.map(card)}
            </section>
          )}
        </>
      )}

      {data && view === 'done' && (
        <section className="card ad2-tablecard">
          {!list.length && <p className="muted">Решённых предложений пока нет.</p>}
          {list.length > 0 && (
            <div className="ad2-scroll">
              <table className="ad2-table">
                <thead><tr><th>Когда</th><th>Предложение</th><th>Решение</th><th>Эффект</th></tr></thead>
                <tbody>
                  {list.map(p => {
                    const pr = p.sku ? prodBySku.get(p.sku) : undefined;
                    return (
                      <tr key={p.id}>
                        <td className="ad2-nowrap">{p.decidedAt ? dt(p.decidedAt) : ''}</td>
                        <td><b>{p.title}</b><div className="muted ad2-small">{[pr?.article ?? p.sku, p.campaignId ? campName.get(p.campaignId) ?? p.campaignName ?? p.campaignId : null].filter(Boolean).join(' · ')}</div></td>
                        <td><span className={`chip ${P_STATUS[p.status]?.cls ?? ''}`}>{P_STATUS[p.status]?.label ?? p.status}</span>
                          {(p.note || p.result?.error || (p.status === 'failed' && p.result?.message)) && <div className="muted ad2-small">{p.note ?? p.result?.error ?? p.result?.message}</div>}</td>
                        <td>{isCommand(p) && p.status === 'applied' ? <EffectCell e={p.effect} /> : <span className="muted">–</span>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      <details className="card ad2-autopilot">
        <summary><b>По каким правилам работает автопилот</b></summary>
        <ul>
          <li>Бюджет — 5% от суммы заказов по цене продавца, отдельно WB и Ozon. Если площадка тратит больше, ставки только снижаются — начиная с товаров с худшим ДРР.</li>
          <li>Потолок ставки из экономики товара: заказ не дороже 40% маржи; клик и 1000 показов — от него через конверсию и CTR.</li>
          <li>Шаг изменения — не больше 15%. После изменения товар не трогается 24 часа, пока идёт замер.</li>
          <li>Остаток меньше 7 дней — ставки вниз; у всех товаров кампании меньше 3 дней — пауза кампании.</li>
          <li>Расход без заказов или ДРР больше двух норм — ставка вниз; 1 500 ₽ за неделю без единого заказа — пауза кампании.</li>
          <li>Ставка вверх — только при ДРР ниже 60% нормы, запасе от 14 дней и марже не ниже края плана месяца («Цены» → «Репрайсер»). Если узкое место в карточке или корзине, вместо повышения — задача команде.</li>
          <li>Конкуренты (с 15.10): если наша цена покупателю выше медианы подтверждённых конкурентов на 8%+, ставку не поднимает — даёт задачу по цене. Если у всех конкурентов нет в наличии, а ДРР в норме, — окно для +15%.</li>
          <li>Ozon: «ДРР вдвое выше нормы» считается с поправкой на медиану категории из «Товаров на Ozon». При перерасходе площадки за проход снижаются только 5 товаров с худшим ДРР.</li>
          <li>WB «за клик» без дневного лимита — предложит лимит с запасом 30% к среднему расходу.</li>
          <li>Товары «Не рекламировать» не трогает; новые кампании только советует. Отклонённое не предлагает снова 3 дня.</li>
        </ul>
      </details>

      {dec && <DecideDialog x={dec} busy={busy === 'decide'} note={note} setNote={setNote} onCancel={() => { setDec(null); setNote(''); }} onOk={decide} />}
    </>
  );
}
