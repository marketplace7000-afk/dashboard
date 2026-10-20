/** «Сборщики»: расход на нейросеть и состояние ключа (бывший раздел «ИИ-агенты»). */
import { useEffect, useState } from 'react';
import { WarningIcon, CaretDownIcon, CaretUpIcon } from '@phosphor-icons/react';
import { fetchAiUsage, type UsageResponse, type AiHealth } from '../../api/aiUsage';

// ─── Расход на нейросеть (бывший раздел «ИИ-агенты», 13.10.2026) ────────────
// Это НАШ учёт по ответам Anthropic, а не выгрузка их счёта: возможны
// расхождения на копейки. Остаток кредитов Anthropic по API не отдаёт.

const AI_LABEL: Record<string, string> = {
  insights: 'Дневной инсайт',
  'card-audit': 'Аудит карточек',
  'review-reply': 'Ответы на отзывы',
  'price-reason': 'Обоснование цены',
  'competitors-summary': 'Конкурентная разведка',
  chat: 'Чат-копилот',
};

const KEY_STATE: Record<AiHealth['state'], { label: string; color: string }> = {
  ok:             { label: 'работает',          color: 'var(--good)' },
  no_credit:      { label: 'кредиты кончились', color: 'var(--bad)' },
  invalid_key:    { label: 'ключ не принят',    color: 'var(--bad)' },
  not_configured: { label: 'ключ не задан',     color: 'var(--warn)' },
  unreachable:    { label: 'нет связи',         color: 'var(--warn)' },
};

const fmtRub = (n: number) => `${n.toFixed(2)} ₽`;

export function useAiStatus() {
  const [usage, setUsage] = useState<UsageResponse | null>(null);
  const [health, setHealth] = useState<AiHealth | null>(null);
  useEffect(() => {
    fetchAiUsage(7).then(setUsage);
    const t = setInterval(() => fetchAiUsage(7, true).then(setUsage), 60_000);
    fetch('/api/ai/health', { credentials: 'include' })
      .then(r => r.json()).then((j: AiHealth) => setHealth(j))
      .catch(() => setHealth({
        ok: false, configured: false, state: 'unreachable',
        detail: 'Сервер не ответил на проверку ключа.', model: null, checkedAt: Date.now(),
        consoleUrl: 'https://console.anthropic.com/settings/billing',
      }));
    return () => clearInterval(t);
  }, []);
  return { usage, health };
}

/** Когда ключ не работает, все ИИ-блоки кабинета отдают ошибку — говорим об этом вверху. */
export function AiAlert({ health }: { health: AiHealth | null }) {
  if (!health || health.state === 'ok') return null;
  return (
    <div className="ah-alert ah-alert--bad" role="alert">
      <WarningIcon size={15} weight="fill" />
      <span>
        Нейросеть не отвечает: {health.detail}
        {health.state === 'no_credit' && <> <a href={health.consoleUrl} target="_blank" rel="noreferrer">Пополнить баланс</a>.</>}
      </span>
    </div>
  );
}

export function AiSpend({ usage, health }: { usage: UsageResponse | null; health: AiHealth | null }) {
  const [open, setOpen] = useState(false);
  const today = usage?.today ?? null;
  const limitRub = usage?.limitRub ?? 0;
  const costToday = today?.totalCostRub ?? 0;
  const limitPct = limitRub > 0 ? Math.min(100, Math.round((costToday / limitRub) * 100)) : 0;
  const barColor = limitPct > 80 ? 'var(--bad)' : limitPct > 50 ? 'var(--warn)' : 'var(--good)';

  // Разбивка по задачам за 7 дней: складываем дневные агрегаты.
  const byTask = new Map<string, { requests: number; costRub: number }>();
  for (const d of usage?.days ?? []) {
    for (const [k, v] of Object.entries(d.byAgent ?? {})) {
      const acc = byTask.get(k) ?? { requests: 0, costRub: 0 };
      acc.requests += v.requests; acc.costRub += v.costRub;
      byTask.set(k, acc);
    }
  }
  const rows = [...byTask.entries()].filter(([, v]) => v.requests > 0).sort((a, b) => b[1].costRub - a[1].costRub);
  const consoleUrl = health?.consoleUrl ?? 'https://console.anthropic.com/settings/billing';

  return (
    <section className="card ah-ai" aria-labelledby="ah-ai-title">
      <div className="ah-ai-row">
        <h2 id="ah-ai-title">Расход на нейросеть</h2>
        <span className="ah-ai-key" style={{ color: health ? KEY_STATE[health.state].color : 'var(--muted)' }}>
          ● {health ? KEY_STATE[health.state].label : 'проверка…'}
          {health?.model && <span className="ah-sub"> · {health.model}</span>}
        </span>
        {usage ? (
          <>
            <span className="ah-ai-fact">
              Сегодня <strong>{fmtRub(costToday)}</strong>
              {limitRub > 0 && <span className="ah-sub"> из {limitRub} ₽</span>}
              {limitRub > 0 && <span className="ah-ai-bar"><span style={{ width: `${limitPct}%`, background: barColor }} /></span>}
            </span>
            <span className="ah-ai-fact">
              7 дней <strong>{fmtRub(usage.totalRub ?? 0)}</strong>
              <span className="ah-sub"> · ${(usage.totalUsd ?? 0).toFixed(2)}</span>
            </span>
            <span className="ah-ai-fact">Запросов сегодня <strong>{(today?.totalRequests ?? 0).toLocaleString('ru-RU')}</strong></span>
            <button className="btn btn-sm ah-ai-more" onClick={() => setOpen(o => !o)} aria-expanded={open}>
              {open ? <CaretUpIcon size={13} /> : <CaretDownIcon size={13} />} По задачам
            </button>
          </>
        ) : <span className="ah-sub">Статистика трат пока недоступна.</span>}
      </div>

      {open && usage && (
        <div className="ah-ai-detail">
          {rows.length === 0
            ? <div className="ah-sub">За 7 дней нейросеть не вызывалась.</div>
            : (
              <table className="ah-server-tbl">
                <tbody>
                  {rows.map(([k, v]) => (
                    <tr key={k}>
                      <td>{AI_LABEL[k] ?? k}</td>
                      <td className="ah-sub ah-num">{v.requests.toLocaleString('ru-RU')} запр.</td>
                      <td className="ah-num"><strong>{fmtRub(v.costRub)}</strong></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          <div className="ah-sub ah-ai-note">
            Учёт платформы по ответам Anthropic, рубли по курсу {usage.fx ? `${usage.fx.rub.toFixed(2)} ₽${usage.fx.source === 'cbr' ? ' (ЦБ)' : ''}` : 'ЦБ'}.
            Остаток на счету видно только в <a href={consoleUrl} target="_blank" rel="noreferrer">консоли Anthropic</a>.
          </div>
        </div>
      )}
    </section>
  );
}
