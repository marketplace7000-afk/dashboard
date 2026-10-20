/** «Реклама» → «Обзор»: бюджет по правилу 5%, расход по дням, товары для внимания и кандидаты. */
import { useState } from 'react';
import { nf0, rub, num, pct, ddmm, kRub, ProductCell } from '../ads2ui';
import type { Ads2Overview } from '../../../shared/ads2';
import { IssueIcon } from './shared';


/** Полоса «факт против бюджета»: зелёная до 100%, дальше красная. */
function BudgetBar({ fact, plan }: { fact: number; plan: number }) {
  const ratio = plan > 0 ? fact / plan : 0;
  const w = Math.min(ratio, 1.5) / 1.5 * 100;
  return (
    <div className="ad2-bar" title={`${rub(fact)} из ${rub(plan)}`}>
      <div className={`ad2-bar-fill ${ratio > 1.05 ? 'over' : ratio > 0.9 ? 'near' : ''}`} style={{ width: `${w}%` }} />
      <div className="ad2-bar-mark" style={{ left: `${100 / 1.5}%` }} />
    </div>
  );
}

// ─── График «расход против нормы» ───────────────────────────────────────────

function SpendChart({ days }: { days: Ads2Overview['days'] }) {
  const [hover, setHover] = useState<number | null>(null);
  if (!days.length) return null;
  const W = 760, H = 200, PL = 56, PR = 12, PT = 12, PB = 26;
  const max = Math.max(1, ...days.map(d => Math.max(d.spend, d.budget))) * 1.1;
  const step = (W - PL - PR) / days.length;
  const bw = Math.max(4, Math.min(28, step - 6));
  const y = (v: number) => PT + (H - PT - PB) * (1 - v / max);
  const ticks = [0, max / 2, max].map(v => Math.round(v / 100) * 100);
  const line = days.map((d, i) => `${i ? 'L' : 'M'}${PL + step * i + step / 2},${y(d.budget)}`).join(' ');
  const h = hover == null ? null : days[hover];
  return (
    <div className="ad2-chart">
      <div className="ad2-legend">
        <span><i className="ad2-sw ad2-sw-spend" /> Расход на рекламу</span>
        <span><i className="ad2-sw ad2-sw-over" /> Расход выше нормы</span>
        <span><i className="ad2-sw ad2-sw-norm" /> Норма: 5% от заказов дня</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Расход на рекламу по дням против нормы 5% от заказов" onMouseLeave={() => setHover(null)}>
        {ticks.map(t => (
          <g key={t}>
            <line x1={PL} x2={W - PR} y1={y(t)} y2={y(t)} className="ad2-grid" />
            <text x={PL - 8} y={y(t) + 4} textAnchor="end" className="ad2-axis">{t >= 1000 ? `${nf0.format(t / 1000)}k` : t}</text>
          </g>
        ))}
        {days.map((d, i) => {
          const x = PL + step * i + (step - bw) / 2;
          const over = d.budget > 0 && d.spend > d.budget * 1.05;
          return (
            <g key={d.date} onMouseEnter={() => setHover(i)}>
              <rect x={PL + step * i} y={PT} width={step} height={H - PT - PB} fill="transparent" />
              <rect x={x} y={y(d.spend)} width={bw} height={Math.max(0, y(0) - y(d.spend))} rx={3}
                className={`ad2-barc ${over ? 'over' : ''} ${hover === i ? 'hl' : ''}`} />
              {(days.length <= 16 || i % Math.ceil(days.length / 15) === 0) && (
                <text x={PL + step * i + step / 2} y={H - 8} textAnchor="middle" className="ad2-axis">{ddmm(d.date)}</text>
              )}
            </g>
          );
        })}
        <path d={line} className="ad2-normline" />
      </svg>
      {h && (
        <div className="ad2-tip" style={{ left: `${((PL + step * hover! + step / 2) / W) * 100}%` }}>
          <b>{ddmm(h.date)}</b>
          <span>Расход {rub(h.spend)}</span>
          <span>Норма {rub(h.budget)}</span>
          <span className="muted">Заказы {kRub(h.orders)} · ДРР {pct(h.orders > 0 ? h.spend / h.orders * 100 : null)}</span>
        </div>
      )}
    </div>
  );
}

// ─── Обзор ──────────────────────────────────────────────────────────────────

export function Overview({ d, openProduct }: { d: Ads2Overview; openProduct: (k: string) => void }) {
  const b = d.budget;
  const attention = d.products.filter(p => p.issues.some(i => i.level !== 'info')) // у архива остаётся только «отмечен, но реклама идёт»
    .sort((x, y) => (y.issues.some(i => i.level === 'critical') ? 1 : 0) - (x.issues.some(i => i.level === 'critical') ? 1 : 0) || y.spend - x.spend);
  const chances = d.products.filter(p => p.issues.some(i => i.code === 'no_ads_opportunity'));
  const active = d.campaigns.filter(c => c.status === 'active').length;
  const overMonth = b.month.forecastBudget > 0 && b.month.forecastSpend > b.month.forecastBudget * 1.05;
  return (
    <div className="grid" style={{ gap: 16 }}>
      <section className="ad2-kpis">
        <div className="card ad2-kpi">
          <div className="card-title">Расход за период</div>
          <div className="ad2-kpi-v">{rub(b.spend)}</div>
          <BudgetBar fact={b.spend} plan={b.budget} />
          <div className="ad2-kpi-sub">бюджет {rub(b.budget)} = {b.sharePct}% от заказов {kRub(b.orders)}</div>
        </div>
        <div className="card ad2-kpi">
          <div className="card-title">ДРР за период</div>
          <div className={`ad2-kpi-v ${b.drrPct != null && b.drrPct > b.sharePct * 1.05 ? 'bad' : 'good'}`}>{pct(b.drrPct)}</div>
          <div className="ad2-kpi-sub">норма {b.sharePct}% · расход ÷ все заказы, не только рекламные</div>
        </div>
        <div className="card ad2-kpi">
          <div className="card-title">{b.month.label[0].toUpperCase() + b.month.label.slice(1)}: прогноз</div>
          <div className={`ad2-kpi-v ${overMonth ? 'bad' : ''}`}>{rub(b.month.forecastSpend)}</div>
          <BudgetBar fact={b.month.forecastSpend} plan={b.month.forecastBudget} />
          <div className="ad2-kpi-sub">бюджет месяца ≈ {rub(b.month.forecastBudget)} · уже потрачено {rub(b.month.spend)}</div>
        </div>
        <div className="card ad2-kpi">
          <div className="card-title">Сегодня</div>
          <div className="ad2-kpi-v">{rub(b.today.spend)}</div>
          <BudgetBar fact={b.today.spend} plan={b.today.norm} />
          <div className="ad2-kpi-sub">норма дня {rub(b.today.norm)} · активных кампаний {active}</div>
        </div>
      </section>

      <section className="card">
        <h2>Расход по дням</h2>
        <SpendChart days={d.days} />
      </section>

      <div className="ad2-two">
        <section className="card">
          <h2>Требует внимания <span className="muted ad2-count">{attention.length}</span></h2>
          {!attention.length && <p className="muted">Узких мест не найдено.</p>}
          <ul className="ad2-list">
            {attention.slice(0, 12).map(p => (
              <li key={p.key}>
                <ProductCell p={p} onOpen={() => openProduct(p.key)} />
                <div className="ad2-list-issues">
                  {p.issues.filter(i => i.level !== 'info').map(i => <div key={i.code} className={`ad2-lv-${i.level}`}><IssueIcon i={i} /> {i.text}</div>)}
                </div>
              </li>
            ))}
          </ul>
        </section>
        <section className="card">
          <h2>Кандидаты на рекламу <span className="muted ad2-count">{chances.length}</span></h2>
          <p className="muted ad2-small">Продаются без рекламы, запас от 30 дней, маржа от 20%. Создавать ли кампанию — решает менеджер.</p>
          {!chances.length && <p className="muted">Сейчас таких нет.</p>}
          <ul className="ad2-list">
            {chances.slice(0, 10).map(p => (
              <li key={p.key}>
                <ProductCell p={p} onOpen={() => openProduct(p.key)} />
                <div className="ad2-list-num">{num(p.orders)} зак · {kRub(p.revenue)} · запас {num(p.daysOfStock)} дн</div>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
