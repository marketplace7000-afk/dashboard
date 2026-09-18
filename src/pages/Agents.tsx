import { useState, useEffect } from 'react';
import { SparkleIcon, RobotIcon, CheckCircleIcon, WarningIcon } from '@phosphor-icons/react';
import { fetchAiUsage, type UsageResponse, type AiHealth } from '../api/aiUsage';

const fmtNum = (n: number) => n.toLocaleString('ru-RU');

// Реальные ИИ-агенты платформы (серверные действия /api/ai/* в api/route.ts).
// key — метка агента в логах трат (aiUsage.byAgent).
const AGENTS: { key: string; name: string; role: string; where: string }[] = [
  { key: 'insights',            name: 'Аналитик · дневной инсайт',   role: 'Сводка и инсайты по продажам за период, действия на неделю', where: 'Дашборд' },
  { key: 'card-audit',          name: 'Аудит карточек (Vision)',     role: 'Анализ фото и контента карточки, оценка 0–100, рекомендации', where: 'Модули · Конкуренты' },
  { key: 'review-reply',        name: 'Ответы на отзывы',            role: 'Черновики вежливых ответов на отзывы WB', where: 'Отзывы' },
  { key: 'price-reason',        name: 'Обоснование цены',            role: 'Объяснение рекомендации по цене относительно рынка', where: 'Цены' },
  { key: 'competitors-summary', name: 'Конкурентная разведка',       role: 'Сравнение нашей карточки с топом выдачи', where: 'Конкуренты' },
  { key: 'chat',                name: 'AI-копилот (чат)',            role: 'Чат-ассистент по данным платформы (кнопка ✨)', where: 'Везде' },
];

// Состояния ключа с человеческими названиями. «Подключён» и «работает» — разные
// вещи: когда кончаются кредиты, ключ на месте, но каждый ИИ-блок отдаёт ошибку.
const KEY_STATE: Record<AiHealth['state'], { label: string; color: string }> = {
  ok:             { label: 'работает',        color: 'var(--good)' },
  no_credit:      { label: 'кредиты кончились', color: 'var(--bad)' },
  invalid_key:    { label: 'ключ не принят',  color: 'var(--bad)' },
  not_configured: { label: 'ключ не задан',   color: 'var(--warn)' },
  unreachable:    { label: 'нет связи',       color: 'var(--warn)' },
};

export function Agents() {
  const [usage, setUsage] = useState<UsageResponse | null>(null);
  const [health, setHealth] = useState<AiHealth | null>(null);

  useEffect(() => {
    fetchAiUsage(7).then(setUsage);
    const t = setInterval(() => fetchAiUsage(7, true).then(setUsage), 60_000);
    fetch('/api/ai/health', { credentials: 'include' })
      .then(r => r.json())
      .then((j: AiHealth) => setHealth(j))
      .catch(() => setHealth({
        ok: false, configured: false, state: 'unreachable',
        detail: 'Сервер не ответил на проверку ключа.', model: null, checkedAt: Date.now(),
        consoleUrl: 'https://console.anthropic.com/settings/billing',
      }));
    return () => clearInterval(t);
  }, []);

  const today = usage?.today ?? null;
  const limitRub = usage?.limitRub ?? 0;
  const costToday = today?.totalCostRub ?? 0;
  const reqToday = today?.totalRequests ?? 0;
  const limitPct = limitRub > 0 ? Math.min(100, Math.round((costToday / limitRub) * 100)) : 0;

  const metricsFor = (key: string) => today?.byAgent?.[key] ?? null;

  return (
    <div className="grid" style={{ gap: 20 }}>
      <div className="card" style={{ background: 'var(--accent-soft)' }}>
        <div className="row gap-8" style={{ alignItems: 'flex-start' }}>
          <RobotIcon size={18} weight="fill" style={{ color: 'var(--accent-2)', flexShrink: 0, marginTop: 2 }} />
          <div style={{ fontSize: 13, color: 'var(--accent-2)', lineHeight: 1.55 }}>
            {/* Раньше тут было написано «тянутся из логов Anthropic» — неправда:
                это НАШ учёт по ответам API. Расхождение с чеком Anthropic
                возможно, и лучше сказать об этом заранее. */}
            <strong>ИИ-агенты платформы.</strong> Реальные вызовы Claude по задачам ниже. Запросы и токены
            платформа считает сама, по ответам Anthropic на каждый вызов. Модель и ключ — на сервере
            (вкладка «Настройки»).
          </div>
        </div>
      </div>

      <div className="grid grid-4">
        <div className="card kpi">
          <div className="card-title">Запросов сегодня</div>
          <div className="v">{fmtNum(reqToday)}</div>
          <div className="d muted">за 7 дней: {fmtNum(usage?.totalRequests ?? 0)}</div>
        </div>
        <div className="card kpi">
          <div className="card-title">Стоимость сегодня</div>
          <div className="v">{costToday.toFixed(2)} ₽</div>
          <div className="d muted">из лимита {limitRub} ₽ · {limitPct}%</div>
          <div style={{ height: 4, background: 'var(--bg-2)', borderRadius: 2, marginTop: 6, overflow: 'hidden' }}>
            <div style={{ width: `${limitPct}%`, height: '100%', background: limitPct > 80 ? 'var(--bad)' : limitPct > 50 ? 'var(--warn)' : 'var(--good)' }} />
          </div>
        </div>
        <div className="card kpi">
          <div className="card-title">За 7 дней</div>
          <div className="v">{(usage?.totalRub ?? 0).toFixed(2)} ₽</div>
          {/* Счёт Anthropic приходит в долларах — рубли это пересчёт, и подпись
              обязана говорить, каким курсом и откуда он взят. Иначе цифра
              выглядит точнее, чем есть. */}
          <div className="d muted">
            ${(usage?.totalUsd ?? 0).toFixed(2)}
            {usage?.fx ? ` · курс ${usage.fx.rub.toFixed(2)} ₽${usage.fx.source === 'cbr' ? ' по ЦБ' : ', последний известный'}` : ''}
          </div>
        </div>
        <div className="card kpi">
          <div className="card-title">Ключ Claude</div>
          {health === null
            ? <div className="v" style={{ fontSize: 18, color: 'var(--muted)' }}>проверка…</div>
            : <>
                <div className="v" style={{ fontSize: 16, color: KEY_STATE[health.state].color }}>
                  ● {KEY_STATE[health.state].label}
                </div>
                <div className="d muted">{health.model || '—'}</div>
              </>}
        </div>
      </div>

      {health && health.state !== 'ok' && (
        <div className="card" style={{ borderColor: 'var(--bad)' }}>
          <div className="row gap-8" style={{ alignItems: 'flex-start' }}>
            <WarningIcon size={16} weight="bold" style={{ color: 'var(--bad)', flexShrink: 0, marginTop: 2 }} />
            <div style={{ fontSize: 13, lineHeight: 1.55 }}>
              <strong>ИИ сейчас не отвечает.</strong> {health.detail}
              {health.state === 'no_credit' && (
                <> <a href={health.consoleUrl} target="_blank" rel="noreferrer">Пополнить баланс</a>.</>
              )}
            </div>
          </div>
        </div>
      )}

      <div className="card">
        <div className="muted" style={{ fontSize: 12.5, lineHeight: 1.6 }}>
          {/* Прямо говорим, чего тут нет и почему: подставлять «примерный остаток»
              было бы хуже пустоты, потому что по нему стали бы планировать. */}
          Здесь показан <strong>расход</strong> за период, а не остаток на счету. Остаток кредитов
          Anthropic по API не отдаёт ни в каком виде — его видно только в{' '}
          <a href={health?.consoleUrl ?? 'https://console.anthropic.com/settings/billing'} target="_blank" rel="noreferrer">консоли Anthropic</a>.
          Суммы посчитаны по официальному прайсу Anthropic и переведены в рубли по курсу ЦБ,
          поэтому от счёта они могут отличаться на копейки.
        </div>
      </div>

      <div>
        <h2 style={{ margin: '4px 0 12px', fontSize: 15 }}>Агенты ({AGENTS.length})</h2>
        <div className="grid grid-2">
          {AGENTS.map((a) => {
            const m = metricsFor(a.key);
            const active = !!m && m.requests > 0;
            return (
              <div key={a.key} className="card" style={{ padding: 16 }}>
                <div className="flex-between" style={{ marginBottom: 6 }}>
                  <div className="row gap-8">
                    <div style={{ width: 34, height: 34, borderRadius: 9, background: 'var(--accent-soft)', display: 'grid', placeItems: 'center' }}>
                      <SparkleIcon size={18} weight="fill" style={{ color: 'var(--accent-2)' }} />
                    </div>
                    <div>
                      <div style={{ fontWeight: 600, fontSize: 14 }}>{a.name}</div>
                      <div className="muted" style={{ fontSize: 11.5 }}>Claude · {a.where}</div>
                    </div>
                  </div>
                  {active
                    ? <span className="chip good"><CheckCircleIcon size={10} weight="bold" /> работал сегодня</span>
                    : <span className="chip"><span className="dot" /> сегодня не вызывался</span>}
                </div>
                <div className="muted" style={{ fontSize: 12.5, lineHeight: 1.55, marginBottom: 12 }}>{a.role}</div>
                <div className="grid grid-3" style={{ gap: 10 }}>
                  <div>
                    <div className="card-title" style={{ fontSize: 11 }}>Запросов</div>
                    <div style={{ fontWeight: 600 }}>{fmtNum(m?.requests ?? 0)}</div>
                  </div>
                  <div>
                    <div className="card-title" style={{ fontSize: 11 }}>Токены in/out</div>
                    <div style={{ fontWeight: 600, fontSize: 13 }}>{fmtNum(m?.tokensIn ?? 0)} / {fmtNum(m?.tokensOut ?? 0)}</div>
                  </div>
                  <div>
                    <div className="card-title" style={{ fontSize: 11 }}>Стоимость</div>
                    <div style={{ fontWeight: 600 }}>{(m?.costRub ?? 0).toFixed(2)} ₽</div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {!usage && (
        <div className="card">
          <div className="row gap-8 muted" style={{ fontSize: 13 }}>
            <WarningIcon size={14} weight="bold" /> Статистика трат пока недоступна (нет данных от /api/ai/usage).
          </div>
        </div>
      )}
    </div>
  );
}
