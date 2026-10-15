/**
 * Общие мелочи разделов «Реклама» и «Конкуренты» (15.10.2026): формат чисел,
 * ячейка товара, динамика позиции и процентов, мини-график.
 */

export const nf0 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
export const nf1 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });
export const nf2 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });
export const rub = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? '–' : `${nf0.format(v)} ₽`);
export const rub2 = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? '–' : `${nf2.format(v)} ₽`);
export const num = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? '–' : nf0.format(v));
export const pct = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? '–' : `${nf1.format(v)}%`);
export const ddmm = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}`;
export const kRub = (v: number) => (Math.abs(v) >= 1_000_000 ? `${nf1.format(v / 1_000_000)} млн ₽` : Math.abs(v) >= 10_000 ? `${nf0.format(v / 1000)} тыс ₽` : rub(v));
export const when = (ms: number | null | undefined) => (ms ? new Date(ms).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');
/** «сегодня в 11:42», «вчера в 16:41», «13.10 в 05:43» — по Москве, как расписание агента. */
export function whenRel(ms: number | null | undefined, now = Date.now()): string {
  if (!ms) return '—';
  const MSK = 3 * 3600_000;
  const day = (t: number) => Math.floor((t + MSK) / 86_400_000);
  const hm = new Date(ms + MSK).toISOString().slice(11, 16);
  const dd = day(now) - day(ms);
  if (dd === 0) return `сегодня в ${hm}`;
  if (dd === 1) return `вчера в ${hm}`;
  const iso = new Date(ms + MSK).toISOString();
  return `${iso.slice(8, 10)}.${iso.slice(5, 7)} в ${hm}`;
}

export function ProductCell({ p, onOpen }: { p: { photo: string; name: string; article: string; link?: string | null }; onOpen?: () => void }) {
  return (
    <div className="ad2-prod">
      {p.photo ? <img src={p.photo} alt="" loading="lazy" onError={e => { e.currentTarget.style.visibility = 'hidden'; }} /> : <span className="ad2-noimg" />}
      <div className="ad2-prod-t">
        {onOpen ? <button className="ad2-link" onClick={onOpen}>{p.name || p.article}</button>
          : p.link ? <a href={p.link} target="_blank" rel="noreferrer" title={p.name}>{p.name || p.article}</a>
          : <span>{p.name || p.article}</span>}
        <span className="muted">{p.article}</span>
      </div>
    </div>
  );
}

/** Динамика позиции: меньше — лучше. WB отдаёт разницу «сейчас − прошлый период». */
export function PosDyn({ v }: { v: number | null }) {
  if (v == null || v === 0) return null;
  const better = v < 0;
  return <span className={`ad2-dyn ${better ? 'good' : 'bad'}`}>{better ? '▲' : '▼'}{nf0.format(Math.abs(v))}</span>;
}

export function PctDyn({ v }: { v: number | null }) {
  if (v == null || v === 0) return null;
  // от почти нулевой базы динамика бывает «+372 277%» — это просто «новый рост»
  return <span className={`ad2-dyn ${v > 0 ? 'good' : 'bad'}`}>{v > 999 ? '>+999' : `${v > 0 ? '+' : ''}${nf0.format(v)}`}%</span>;
}

export function MiniLines({ s }: { s: { date: string; my: number | null; competitor: number | null; best: number | null }[] }) {
  const W = 260, H = 56;
  const vals = s.flatMap(x => [x.my, x.competitor, x.best]).filter((v): v is number => v != null);
  if (s.length < 2 || !vals.length) return null;
  const max = Math.max(...vals) || 1;
  const path = (k: 'my' | 'competitor' | 'best') => s.map((x, i) => {
    const v = x[k];
    if (v == null) return '';
    return `${i === 0 ? 'M' : 'L'}${((i / (s.length - 1)) * W).toFixed(1)},${(H - (v / max) * (H - 4) - 2).toFixed(1)}`;
  }).join(' ');
  return (
    <svg className="ad2-minilines" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="Выручка: мы, ближайший конкурент, лидер">
      <path d={path('best')} className="l-best" /><path d={path('competitor')} className="l-comp" /><path d={path('my')} className="l-my" />
    </svg>
  );
}
