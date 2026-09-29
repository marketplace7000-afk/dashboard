import { useEffect, useState } from 'react';
import { SparkleIcon, SpinnerIcon, ArrowsClockwiseIcon, WarningIcon, CaretDownIcon, CaretRightIcon } from '@phosphor-icons/react';
import { aiInsights, loadDaily, saveDaily, InsightsResult } from '../api/ai';
import { noteSwallowed } from '../utils/log';

type Props = {
  period: string;
  kpis: Record<string, number | string>;
  marketplaces: Record<string, { revenue: number; orders: number; products: number }>;
  topProducts?: Array<{ name: string; revenue?: number; orders?: number }>;
  /** Готовность данных. Пока false — авто-генерация не запускается. */
  ready?: boolean;
  /** Маркетплейсы которые вернули ошибку — чтобы Claude не врал «WB мёртв». */
  errors?: Record<string, string | undefined>;
};

// v3: фронт теперь передаёт errors{} отдельно от marketplaces{} —
// если у пользователя в localStorage висит старый инсайт «WB полностью мёртв»,
// сгенерированный на 429-нулях, при заходе он автоматически сбросится.
const KEY = 'ai-insights:dashboard:v3';

type Stored = {
  generatedAt: string;
  insights: InsightsResult;
};

const COLLAPSE_KEY = 'ai-insights:collapsed';

export function DailyAiInsights(props: Props) {
  const [data, setData] = useState<Stored | null>(() => loadDaily<Stored>(KEY));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem(COLLAPSE_KEY) === '1'; } catch { return false; }
  });
  const toggleCollapsed = () => setCollapsed(c => {
    const next = !c;
    try { localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0'); } catch (e) { noteSwallowed('ui-prefs', 'настройка интерфейса не сохранена', e, 60 * 60_000); }
    return next;
  });

  const generate = async (force: boolean) => {
    setLoading(true);
    setError(null);
    try {
      const r = await aiInsights(props, { noCache: force });
      const stored: Stored = { generatedAt: new Date().toISOString(), insights: r.insights };
      setData(stored);
      saveDaily(KEY, stored);
    } catch (e: any) {
      setError(e?.message || 'Ошибка');
    } finally {
      setLoading(false);
    }
  };

  // Авто-генерация раз в день. Условия:
  //  1) на сегодня нет сохранённой версии в localStorage
  //  2) parent сообщил, что данные загружены (ready === true)
  //  3) есть фактическая выручка > 0 (иначе Claude будет писать «всё по нулям»,
  //     даже если просто данные ещё подгружаются или сегодня день только начался)
  //
  // Если выручка реально 0 — пользователь сам нажмёт «Пересоздать».
  const totalRevenue = Number(props.kpis?.totalRevenue ?? 0);
  useEffect(() => {
    if (data || loading) return;
    if (props.ready === false) return;
    if (!(totalRevenue > 0)) return;
    generate(false);
    // eslint-disable-next-line
  }, [props.ready, totalRevenue]);

  const ins = data?.insights;

  return (
    <div className="card" style={{ background: 'var(--accent-soft)' }}>
      <div className="flex-between" style={{ marginBottom: collapsed ? 0 : 10, flexWrap: 'wrap', gap: 8 }}>
        <h2
          style={{ margin: 0, display: 'inline-flex', alignItems: 'center', gap: 8, color: 'var(--accent-2)', cursor: 'pointer', userSelect: 'none' }}
          onClick={toggleCollapsed}
          title={collapsed ? 'Развернуть' : 'Свернуть'}
        >
          {collapsed ? <CaretRightIcon size={14} weight="bold" /> : <CaretDownIcon size={14} weight="bold" />}
          <SparkleIcon size={18} weight="fill" /> Инсайт агента-аналитика
        </h2>
        <div className="row gap-8">
          {data && (
            <span className="chip info" title={`Сгенерировано ${new Date(data.generatedAt).toLocaleString('ru-RU')}`}>
              сегодня · {new Date(data.generatedAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
          {!data && !loading && <span className="chip">ещё не сгенерировано</span>}
          {loading && <span className="chip"><SpinnerIcon size={11} className="spin" /> генерируется…</span>}
          <button
            className="btn btn-sm"
            onClick={() => generate(true)}
            disabled={loading}
            title="Пересоздать инсайт (вне дневного лимита)"
          >
            <ArrowsClockwiseIcon size={12} weight="bold" /> Пересоздать
          </button>
        </div>
      </div>

      {!collapsed && (<>
      {error && (
        <div className="row gap-8" style={{ color: 'var(--bad)', fontSize: 13 }}>
          <WarningIcon size={14} weight="bold" /> {error}
        </div>
      )}

      {!ins && !error && !loading && (
        <div className="muted" style={{ fontSize: 13 }}>
          Инсайт сгенерируется автоматически, когда подгрузятся данные за период.
        </div>
      )}

      {ins?.summary && (
        <div style={{ fontSize: 13.5, lineHeight: 1.65, color: 'var(--accent-2)' }}>{ins.summary}</div>
      )}
      {ins?.insights && ins.insights.length > 0 && (
        <ul style={{ marginTop: 12, marginBottom: 0, paddingLeft: 20, lineHeight: 1.75, fontSize: 13, color: 'var(--accent-2)' }}>
          {ins.insights.slice(0, 5).map((line, i) => <li key={i}>{line}</li>)}
        </ul>
      )}
      {ins?.actions && ins.actions.length > 0 && (
        <>
          <div style={{ marginTop: 12, fontSize: 12, fontWeight: 600, color: 'var(--accent-2)', textTransform: 'uppercase', letterSpacing: 0.4 }}>
            Действия на неделю
          </div>
          <ul style={{ marginTop: 6, marginBottom: 0, paddingLeft: 20, lineHeight: 1.75, fontSize: 13, color: 'var(--accent-2)' }}>
            {ins.actions.slice(0, 4).map((line, i) => <li key={i}>{line}</li>)}
          </ul>
        </>
      )}
      {ins?.raw && (
        <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12, marginTop: 10 }}>{ins.raw}</pre>
      )}
      </>)}
    </div>
  );
}
