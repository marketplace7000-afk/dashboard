import { useState, useEffect } from 'react';
import { SpinnerIcon, WarningIcon, InfoIcon, ArrowsClockwiseIcon } from '@phosphor-icons/react';
import { fetchRepricer, saveRepricerSettings, type RepricerReport, type RepricerSettings, type Strategy } from '../api/repricer';
import { errText } from '../api/http';

const RU = (n: number | null) => (n == null ? '—' : Math.round(n).toLocaleString('ru-RU'));
const PCT = (n: number | null) => (n == null ? '—' : `${n}%`);

const STRATEGY_LABEL: Record<Strategy, string> = {
  'undercut-min': 'подрезать самого дешёвого',
  'match-min': 'встать вровень с самым дешёвым',
  'match-avg': 'держаться среднего по рынку',
};

/**
 * Репрайсер, этап 2: пороги и предложения.
 *
 * Экран намеренно не имеет кнопки «применить». Цены в WB агент не ставит, и пока
 * клиент не согласует пороги, каждое число здесь — предположение, о чём и
 * написано вверху. Спрятать это за красивым интерфейсом было бы хуже всего:
 * по предложенной цене примут решение, считая её посчитанной по их правилам.
 */
export function Repricer() {
  const [data, setData] = useState<RepricerReport | null>(null);
  const [draft, setDraft] = useState<RepricerSettings | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true); setError(null);
    try {
      const r = await fetchRepricer();
      setData(r); setDraft(r.settings);
    } catch (e) { setError(errText(e)); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, []);

  const save = async () => {
    if (!draft) return;
    setSaving(true); setError(null);
    try {
      await saveRepricerSettings(draft);
      await load();
    } catch (e) { setError(errText(e)); }
    finally { setSaving(false); }
  };

  const num = (k: keyof RepricerSettings, label: string, suffix: string) => (
    <label style={{ display: 'grid', gap: 4 }}>
      <span className="card-title" style={{ fontSize: 11 }}>{label}</span>
      <span className="row gap-8">
        <input
          type="number" className="input" style={{ width: 90 }}
          value={String(draft?.[k] ?? '')}
          onChange={e => draft && setDraft({ ...draft, [k]: Number(e.target.value) })}
        />
        <span className="muted" style={{ fontSize: 12 }}>{suffix}</span>
      </span>
    </label>
  );

  return (
    <div className="grid" style={{ gap: 16 }}>
      <div className="card" style={{ background: 'var(--accent-soft)' }}>
        <div className="row gap-8" style={{ alignItems: 'flex-start' }}>
          <InfoIcon size={16} weight="bold" style={{ color: 'var(--accent-2)', flexShrink: 0, marginTop: 2 }} />
          <div style={{ fontSize: 13, color: 'var(--accent-2)', lineHeight: 1.55 }}>
            <strong>Репрайсер предлагает, а не ставит цены.</strong> Ничего в Wildberries отсюда не
            отправляется: агент считает, какую цену имело бы смысл поставить, и объясняет почему.
            Решение и простановка — за менеджером.
          </div>
        </div>
      </div>

      {data && !data.settings.confirmedByClient && (
        <div className="card" style={{ borderColor: 'var(--warn)' }}>
          <div className="row gap-8" style={{ alignItems: 'flex-start' }}>
            <WarningIcon size={16} weight="bold" style={{ color: 'var(--warn)', flexShrink: 0, marginTop: 2 }} />
            <div style={{ fontSize: 13, lineHeight: 1.55 }}>
              <strong>Пороги пока предварительные.</strong> Минимальная маржа, шаг и частота выставлены
              нами по умолчанию и не согласованы. Пока это так, считайте предложения прикидкой:
              цифры честные, но правила — наши, а не ваши.
            </div>
          </div>
        </div>
      )}

      <div className="card">
        <div className="flex-between" style={{ marginBottom: 12 }}>
          <h2 style={{ margin: 0, fontSize: 15 }}>Пороги</h2>
          <div className="row gap-8">
            <button className="btn btn-sm" onClick={() => void load()} disabled={loading}>
              {loading ? <SpinnerIcon size={13} className="spin" /> : <ArrowsClockwiseIcon size={13} weight="bold" />}
              Пересчитать
            </button>
            <button className="btn btn-sm btn-primary" onClick={() => void save()} disabled={saving || !draft}>
              {saving ? 'Сохраняем…' : 'Сохранить'}
            </button>
          </div>
        </div>
        {draft && (
          <div className="row gap-8" style={{ flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <label style={{ display: 'grid', gap: 4 }}>
              <span className="card-title" style={{ fontSize: 11 }}>Стратегия</span>
              <select
                className="input" value={draft.strategy}
                onChange={e => setDraft({ ...draft, strategy: e.target.value as Strategy })}
              >
                {(Object.keys(STRATEGY_LABEL) as Strategy[]).map(s => (
                  <option key={s} value={s}>{STRATEGY_LABEL[s]}</option>
                ))}
              </select>
            </label>
            {num('minMarginPct', 'Минимальная маржа', '%')}
            {num('undercutRub', 'Подрезать на', '₽')}
            {num('maxStepPct', 'Шаг за раз', '% от цены')}
            {num('minIntervalHours', 'Не чаще чем раз в', 'ч')}
            <label style={{ display: 'grid', gap: 4, flex: 1, minWidth: 220 }}>
              <span className="card-title" style={{ fontSize: 11 }}>Стоп-лист (артикулы через запятую)</span>
              <input
                className="input" value={draft.stopList.join(', ')}
                onChange={e => setDraft({ ...draft, stopList: e.target.value.split(',').map(s => s.trim()).filter(Boolean) })}
              />
            </label>
          </div>
        )}
      </div>

      {error && (
        <div className="card"><div className="row gap-8" style={{ fontSize: 13, color: 'var(--bad)' }}>
          <WarningIcon size={14} weight="bold" /> {error}
        </div></div>
      )}

      <div className="card">
        <h2 style={{ margin: '0 0 12px', fontSize: 15 }}>
          Предложения {data ? `(${data.suggestions.filter(s => s.suggestedPrice != null).length})` : ''}
        </h2>
        {loading && !data && <div className="muted" style={{ fontSize: 13 }}>Считаем…</div>}
        {data && !data.suggestions.length && (
          <div className="muted" style={{ fontSize: 13 }}>
            Пока не по чему считать: закрепите конкурентов за товарами на вкладке рядом, и после
            ночного сбора цен здесь появятся предложения.
          </div>
        )}
        {!!data?.suggestions.length && (
          <div style={{ overflowX: 'auto' }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Артикул</th>
                  <th className="right">Сейчас</th>
                  <th className="right">Предлагаем</th>
                  <th className="right">Ниже нельзя</th>
                  <th className="right">Маржа</th>
                  <th className="right">Рынок (мин)</th>
                  <th>Почему</th>
                </tr>
              </thead>
              <tbody>
                {data.suggestions.map(s => (
                  <tr key={s.sku}>
                    <td>{s.sku}</td>
                    <td className="right">{RU(s.currentPrice)}</td>
                    <td className="right" style={{ fontWeight: 600 }}>
                      {s.suggestedPrice == null ? '—' : RU(s.suggestedPrice)}
                    </td>
                    <td className="right">{RU(s.floorPrice)}</td>
                    <td className="right">
                      {PCT(s.marginNow)}
                      {s.marginSuggested != null && s.marginSuggested !== s.marginNow && ` → ${s.marginSuggested}%`}
                    </td>
                    <td className="right">{RU(s.market.min)}{s.market.total ? ` (из ${s.market.total})` : ''}</td>
                    <td className="muted" style={{ fontSize: 12.5, lineHeight: 1.5, minWidth: 280 }}>
                      {s.blocker ? <><WarningIcon size={12} weight="bold" /> </> : null}{s.reason}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {!!data?.skipped.length && (
          <div className="muted" style={{ fontSize: 12.5, marginTop: 10, lineHeight: 1.55 }}>
            {/* Пропущенные показываем явно: молчаливо короткий список читается как
                «больше ничего и не надо», а это неправда. */}
            Пропущено {data.skipped.length}: {data.skipped.slice(0, 8).map(s => `${s.sku} — ${s.why}`).join('; ')}
            {data.skipped.length > 8 ? ' и другие' : ''}.
          </div>
        )}
      </div>
    </div>
  );
}
