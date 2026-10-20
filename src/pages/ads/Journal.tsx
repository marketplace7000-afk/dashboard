/** «Реклама» → «Журнал»: все изменения — кто, что, было → стало, ответ площадки. */
import { useEffect, useState } from 'react';
import { apiGet, errText } from '../../api/http';
import { NO_ADS_REASON_LABEL, type Ads2Mp } from '../../../shared/ads2';


type LogItem = { id: number; at: number; mp: string; campaign_id: string | null; sku: string | null; actor: string; action: string; before: any; after: any; reason: string | null; status: string; result: any };
const ACTION_LABEL: Record<string, string> = { pause: 'пауза', start: 'запуск', bid: 'ставка', daily_limit: 'дневной лимит', weekly_budget: 'недельный бюджет', no_ads_on: '«не рекламировать»', no_ads_off: 'снята отметка' };
const ACTOR_LABEL: Record<string, string> = { manager: 'менеджер', owner: 'владелец', autopilot: 'автопилот' };
const LOG_STATUS: Record<string, { label: string; cls: string }> = {
  applied: { label: 'применено', cls: 'good' }, failed: { label: 'отказ', cls: 'bad' }, proposed: { label: 'предложено', cls: 'info' },
  rejected: { label: 'отклонено', cls: '' }, rolled_back: { label: 'откат', cls: 'warn' },
};

export function Journal({ mp, names }: { mp: Ads2Mp; names: Map<string, string> }) {
  const [items, setItems] = useState<LogItem[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    // Площадка — на сервере: раньше 300 записей делились на обе, и по одной была видна только часть.
    setItems(null); setErr(null);
    apiGet<{ items: LogItem[] }>(`/api/ads2/log?limit=300&mp=${mp}`).then(r => setItems(r.data.items)).catch(e => setErr(errText(e)));
  }, [mp]);
  const list = (items ?? []).filter(i => i.mp === mp);
  return (
    <section className="card ad2-tablecard">
      <p className="muted ad2-small">Все изменения рекламы из этого раздела: кто, что, было → стало и ответ площадки. Изменения в кабинетах WB и Ozon напрямую сюда не попадают.</p>
      {err && <div className="rnp-alert">Журнал не загрузился: {err}</div>}
      {items && !list.length && <p className="muted">Изменений пока не было.</p>}
      {list.length > 0 && (
        <div className="ad2-scroll">
          <table className="ad2-table">
            <thead><tr><th>Когда</th><th>Кто</th><th>Действие</th><th>Кампания / товар</th><th>Результат</th></tr></thead>
            <tbody>
              {list.map(i => (
                <tr key={i.id}>
                  <td className="ad2-nowrap">{new Date(i.at).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</td>
                  <td>{ACTOR_LABEL[i.actor] ?? i.actor}</td>
                  <td>{ACTION_LABEL[i.action] ?? i.action}</td>
                  <td>{i.campaign_id ? (names.get(i.campaign_id) ?? i.campaign_id) : ''}{i.sku ? <span className="muted"> · {i.sku}</span> : null}</td>
                  <td><span className={`chip ${LOG_STATUS[i.status]?.cls ?? ''}`}>{LOG_STATUS[i.status]?.label ?? i.status}</span> {i.result?.message ?? i.result?.error ?? (i.after?.reason ? NO_ADS_REASON_LABEL[i.after.reason] ?? '' : '')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
