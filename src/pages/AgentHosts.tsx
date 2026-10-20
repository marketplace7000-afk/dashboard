/**
 * Экран «Сборщики» — живая визуализация сети агентов (ТЗ раздел 7.1).
 *
 * Назначение: за 3 секунды понять, какие агенты живы, что каждый делает сейчас,
 * на сколько процентов готово, когда был прошлый прогон и когда следующий.
 *
 * Сверху вниз: связь с ПК → «Сейчас» (идущие задания с процентом) → «Сутки»
 * (шкала 00–24 МСК: прошедшие прогоны, идущий, плановые) → карточки агентов →
 * журнал (очередь и завершённые).
 *
 * Источник данных — только сервер: GET /api/agents/live раз в 4 с, пока вкладка
 * видима (скрыта — раз в 30 с). На клиенте только форматирование: процент из
 * этапа и счётчика, плановые моменты дня из cron расписания. Время — МСК.
 * Стили — блок «Сборщики» в styles.css (префикс .ah-).
 */
import { WarningIcon } from '@phosphor-icons/react';
import { useAgentsLive } from './agents/useAgentsLive';
import { StatusBar, RunningCard, IdleCard } from './agents/Now';
import { DayTrack } from './agents/DayTrack';
import { AgentCards } from './agents/AgentCards';
import { Journal } from './agents/Journal';
import { useAiStatus, AiAlert, AiSpend } from './agents/AiSpend';

// ─── Страница ────────────────────────────────────────────────────────────────
export function AgentHosts() {
  const { live, err, busy, cmdErr, post, cancel } = useAgentsLive();
  const ai = useAiStatus();

  if (!live) return <div className="card">{err ? `Не удалось загрузить данные агентов: ${err}. Страница повторит попытку сама.` : 'Загружаю…'}</div>;

  return (
    <div className="ah-page">
      {err && <div className="ah-alert ah-alert--warn"><WarningIcon size={15} weight="fill" /> Связь с сервером прервалась ({err}), данные могут быть устаревшими.</div>}
      {cmdErr && <div className="ah-alert ah-alert--warn"><WarningIcon size={15} weight="fill" /> {cmdErr}</div>}
      <AiAlert health={ai.health} />
      <StatusBar live={live} busy={busy} post={post} />

      <section aria-label="Сейчас">
        {live.tasks.length > 0
          ? <div className="ah-runs">{live.tasks.map(t => <RunningCard key={t.id} task={t} live={live} onCancel={cancel} />)}</div>
          : <IdleCard live={live} busy={busy} post={post} />}
      </section>

      <DayTrack live={live} />
      <AgentCards live={live} busy={busy} post={post} />
      <Journal live={live} busy={busy} onCancel={cancel} />
      <AiSpend usage={ai.usage} health={ai.health} />
    </div>
  );
}
