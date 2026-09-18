import { useEffect, useState } from 'react';
import { ArrowsClockwiseIcon, ClockIcon, SpinnerIcon, InfoIcon } from '@phosphor-icons/react';
import { fetchMetaStatus, subscribeMetaStatus, MetaStatus, fmtAgo, fmtTime, canManualRefresh, markManualRefresh } from '../api/refreshStatus';

type Props = {
  /** Namespace для проверки last-updated. Например 'wb:analytics', 'ozon-seller'. */
  namespaces: string[];
  /** Что вызывать при ручном обновлении (как правило — refresh() из соответствующего хука). */
  onRefresh?: () => Promise<void> | void;
  /** Подпись модуля для подсказки. */
  label?: string;
  /** Компактный вид (для размещения в шапке вкладки). */
  compact?: boolean;
};

export function LastUpdated({ namespaces, onRefresh, label, compact }: Props) {
  const [status, setStatus] = useState<MetaStatus | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    fetchMetaStatus().then(s => { if (alive) setStatus(s); });
    const unsub = subscribeMetaStatus(s => setStatus(s));
    const id = setInterval(() => setTick(t => t + 1), 30_000); // ре-рендер «N мин назад»
    return () => { alive = false; unsub(); clearInterval(id); };
    // eslint-disable-next-line
  }, []);

  // Показываем возраст САМИХ ДАННЫХ (dataAt), а не момент, когда сборщик отработал.
  // Клиент 11.08 сравнил наши цифры с кабинетом (122 против 158 у WB) при плашке
  // «обновлено 3 минуты назад»: плашка говорила про запуск сборщика, а датасет был
  // снят раньше. Выручка за день только растёт, поэтому мы всегда выглядели ниже.
  const dataAt = namespaces
    .map(ns => status?.namespaces?.[ns]?.dataAt)
    .filter((v): v is number => !!v)
    .sort((a, b) => b - a)[0];
  const refreshAt = namespaces
    .map(ns => status?.namespaces?.[ns]?.lastRefreshAt)
    .filter((v): v is number => !!v)
    .sort((a, b) => b - a)[0];
  const latest = dataAt ?? refreshAt;

  // Проверяем троттл для ручной кнопки
  const throttleKey = namespaces[0] || 'global';
  const throttle = canManualRefresh(throttleKey);

  const handleRefresh = async () => {
    if (!throttle.allowed || refreshing) return;
    setRefreshing(true);
    markManualRefresh(throttleKey);
    try {
      if (onRefresh) await onRefresh();
      await fetchMetaStatus(true);
    } finally {
      setRefreshing(false);
      setTick(t => t + 1);
    }
  };

  void tick; // подавляем unused

  return (
    <div className="row gap-8" style={{ alignItems: 'center', flexWrap: 'wrap', fontSize: 12 }}>
      <span
        className="chip"
        title={
          `Данные получены от площадки: ${fmtTime(dataAt)}\n` +
          `Последний проход сборщика: ${fmtTime(refreshAt)}\n` +
          `Источник: ${status?.cronSource ?? 'cron'}\n` +
          `${label ? `Модуль: ${label}` : ''}\n` +
          `Сегодняшний день неполный: площадка досчитывает его в течение суток, ` +
          `поэтому цифра за сегодня всегда ниже, чем в кабинете в этот же момент.`
        }
        style={{ background: latest ? 'var(--bg-3)' : 'rgba(220,38,38,.08)' }}
      >
        <ClockIcon size={12} weight="bold" />
        {compact
          ? <span>{fmtAgo(latest)}</span>
          : <span>данные от {fmtTime(latest)} · {fmtAgo(latest)}</span>}
      </span>
      {onRefresh && (
        <button
          className="btn btn-sm"
          onClick={handleRefresh}
          disabled={!throttle.allowed || refreshing}
          title={
            !throttle.allowed && throttle.remainingMs
              ? `Можно обновить через ${Math.ceil(throttle.remainingMs / 60_000)} мин (лимит, чтобы не словить 429 от маркетплейса)`
              : 'Принудительно перезапросить данные'
          }
        >
          {refreshing
            ? <SpinnerIcon size={12} className="spin" />
            : <ArrowsClockwiseIcon size={12} weight="bold" />}
          {!throttle.allowed && throttle.remainingMs
            ? `Через ${Math.ceil(throttle.remainingMs / 60_000)} мин`
            : 'Обновить'}
        </button>
      )}
      {!latest && (
        <span className="muted" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <InfoIcon size={11} weight="bold" />
          ждём первого автообновления (cron 09:00 МСК)
        </span>
      )}
    </div>
  );
}
