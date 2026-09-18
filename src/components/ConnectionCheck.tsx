import { useState } from 'react';
import { CheckCircleIcon, XCircleIcon, SpinnerIcon, PlugsConnectedIcon } from '@phosphor-icons/react';
import {
  wbSellerInfo, wbCardsList, wbFeedbacks, wbPrices,
  ozonProductList, ozonAnalyticsTotals,
} from '../api/marketplaces';
import { tgGetMe, tgConfigured } from '../api/telegram';
import { wbFetch, getWbToken } from '../api/wb';

type Probe = {
  name: string;
  run: () => Promise<string>;
};

// WB-проверки убраны намеренно: браузер не обращается к WB (режим cron-only).
// Статус WB-областей виден в Настройках (по данным фонового сборщика).
const probes: Probe[] = [
  {
    name: 'Ozon · Список товаров',
    run: async () => {
      const r = await ozonProductList(20);
      return `товаров: ${r.total}`;
    },
  },
  {
    name: 'Ozon · Аналитика за сутки',
    run: async () => {
      const r = await ozonAnalyticsTotals(1);
      return `заказов: ${r.ordered_units}, выручка: ${r.revenue.toLocaleString('ru-RU')} ₽`;
    },
  },
  {
    name: 'Telegram · Bot info',
    run: async () => {
      if (!tgConfigured()) throw new Error('VITE_TELEGRAM_BOT_TOKEN не задан в .env');
      const me = await tgGetMe();
      return `@${me.username} · id ${me.id}`;
    },
  },
];

type Result = { status: 'idle' | 'pending' | 'ok' | 'err'; message?: string; ms?: number };

export function ConnectionCheck({ compact = false }: { compact?: boolean }) {
  const [state, setState] = useState<Record<string, Result>>(
    () => Object.fromEntries(probes.map((p) => [p.name, { status: 'idle' }]))
  );

  const runOne = async (p: Probe) => {
    setState((s) => ({ ...s, [p.name]: { status: 'pending' } }));
    const t0 = performance.now();
    try {
      const msg = await p.run();
      const ms = Math.round(performance.now() - t0);
      setState((s) => ({ ...s, [p.name]: { status: 'ok', message: msg, ms } }));
    } catch (e: any) {
      const ms = Math.round(performance.now() - t0);
      setState((s) => ({ ...s, [p.name]: { status: 'err', message: String(e?.message ?? e), ms } }));
    }
  };

  const runAll = async () => {
    for (const p of probes) await runOne(p);
  };

  const ok = Object.values(state).filter((r) => r.status === 'ok').length;
  const err = Object.values(state).filter((r) => r.status === 'err').length;
  const pending = Object.values(state).filter((r) => r.status === 'pending').length;

  return (
    <div style={compact ? {} : undefined} className={compact ? '' : 'card'}>
      <div className="flex-between" style={{ marginBottom: 12 }}>
        {!compact && (
          <h2 style={{ margin: 0, display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <PlugsConnectedIcon size={18} weight="bold" /> Реальное подключение к API
          </h2>
        )}
        <div className="row gap-8" style={{ marginLeft: compact ? 'auto' : 0 }}>
          {ok > 0 && <span className="chip good">{ok} ok</span>}
          {err > 0 && <span className="chip bad">{err} fail</span>}
          {pending > 0 && <span className="chip info">{pending} в работе</span>}
          <button className="btn btn-sm btn-primary" onClick={runAll}>Проверить все</button>
        </div>
      </div>

      {!compact && (
        <div className="muted" style={{ fontSize: 12.5, marginBottom: 12 }}>
          Вызовы идут через vite dev-proxy: ключи WB и Ozon берутся из <code>.env</code> и
          подставляются в заголовки на стороне сервера разработки. В прод-сборке такая же логика
          переедет на backend.
        </div>
      )}

      <div className="grid" style={{ gap: 6 }}>
        {probes.map((p) => {
          const r = state[p.name];
          return (
            <div key={p.name} style={{
              display: 'grid', gridTemplateColumns: '24px 1fr auto auto', gap: 10, alignItems: 'center',
              padding: '8px 10px', borderRadius: 8, background: 'var(--bg)',
            }}>
              <span>
                {r.status === 'idle' && <span className="dot" style={{ color: 'var(--muted)' }} />}
                {r.status === 'pending' && <SpinnerIcon size={16} weight="bold" className="spin" />}
                {r.status === 'ok' && <CheckCircleIcon size={18} weight="fill" style={{ color: 'var(--good)' }} />}
                {r.status === 'err' && <XCircleIcon size={18} weight="fill" style={{ color: 'var(--bad)' }} />}
              </span>
              <div>
                <div style={{ fontWeight: 500, fontSize: 13 }}>{p.name}</div>
                {r.message && (
                  <div className="muted" style={{ fontSize: 11.5, marginTop: 2, wordBreak: 'break-word' }}>
                    {r.message}
                  </div>
                )}
              </div>
              <div className="muted" style={{ fontSize: 11 }}>{r.ms != null ? `${r.ms} мс` : ''}</div>
              <button className="btn btn-sm" onClick={() => runOne(p)}>
                {r.status === 'idle' ? 'тест' : 'повторить'}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
