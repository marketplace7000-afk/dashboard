import { useEffect, useState } from 'react';
import {
  BookOpenIcon, ArrowsClockwiseIcon, SpinnerIcon, InfoIcon, LinkSimpleIcon,
} from '@phosphor-icons/react';

// База знаний по площадкам: тезисы, которые копят агенты (тарифы, комиссии,
// правила, новости). Раньше это уходило разрозненными сообщениями в Telegram и
// терялось в переписке — клиент попросил один раздел, где всё копится тезисно.

type Thesis = {
  id: number;
  mp: 'wb' | 'ozon';
  date: string;
  category: string;
  text: string;
  impact: string | null;
  action: string | null;
  source: string | null;
};

type Scope = 'all' | 'wb' | 'ozon';

const CAT_COLOR: Record<string, string> = {
  'тарифы': '#d97706',
  'комиссии': '#dc2626',
  'правила': '#2563eb',
  'склады': '#7c3aed',
  'реклама': '#059669',
  'прочее': 'var(--muted)',
};

function fmtDate(d: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return d || '—';
  const [y, m, dd] = d.split('-');
  return `${dd}.${m}.${y}`;
}

export function Knowledge() {
  const [scope, setScope] = useState<Scope>('all');
  const [items, setItems] = useState<Thesis[]>([]);
  const [loading, setLoading] = useState(false);

  const load = () => {
    setLoading(true);
    const qs = scope === 'all' ? '' : `?mp=${scope}`;
    fetch(`/api/history/knowledge${qs}`, { credentials: 'include' })
      .then(r => r.json())
      .then(j => setItems(j?.items ?? []))
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  };

  useEffect(load, [scope]);

  const wbCount = items.filter(i => i.mp === 'wb').length;
  const ozCount = items.filter(i => i.mp === 'ozon').length;

  return (
    <div className="grid" style={{ gap: 20 }}>
      <div className="card" style={{ background: 'var(--accent-soft)' }}>
        <div className="row gap-8" style={{ alignItems: 'flex-start' }}>
          <BookOpenIcon size={18} weight="fill" style={{ color: 'var(--accent-2)', flexShrink: 0, marginTop: 2 }} />
          <div style={{ fontSize: 13, color: 'var(--accent-2)', lineHeight: 1.55 }}>
            <strong>База знаний по площадкам.</strong> Сюда агенты складывают тезисно всё, что меняется
            у WB и Ozon: тарифы, комиссии, правила приёмки, склады, новости. Источники — официальные
            API площадок и их каналы для продавцов. Обновляется раз в сутки.
          </div>
        </div>
      </div>

      <div className="flex-between" style={{ flexWrap: 'wrap', gap: 12 }}>
        <div className="row gap-8" style={{ flexWrap: 'wrap' }}>
          <button className={`mp-tab ${scope === 'all' ? 'active' : ''}`} onClick={() => setScope('all')}>
            <span className="mp-tab-dot" style={{ background: 'linear-gradient(135deg, #cb11ab, #005bff)' }} />
            Все площадки
            <span className="muted" style={{ marginLeft: 6 }}>{items.length}</span>
          </button>
          <button className={`mp-tab ${scope === 'wb' ? 'active' : ''}`} onClick={() => setScope('wb')}>
            <span className="mp-tab-dot" style={{ background: '#cb11ab' }} />
            Wildberries
            {scope === 'all' && <span className="muted" style={{ marginLeft: 6 }}>{wbCount}</span>}
          </button>
          <button className={`mp-tab ${scope === 'ozon' ? 'active' : ''}`} onClick={() => setScope('ozon')}>
            <span className="mp-tab-dot" style={{ background: '#005bff' }} />
            Ozon
            {scope === 'all' && <span className="muted" style={{ marginLeft: 6 }}>{ozCount}</span>}
          </button>
        </div>
        <button className="btn btn-sm" onClick={load} disabled={loading}>
          {loading ? <SpinnerIcon size={13} weight="bold" className="spin" /> : <ArrowsClockwiseIcon size={13} weight="bold" />}
          Обновить
        </button>
      </div>

      {items.length === 0 ? (
        <div className="card">
          <div className="row gap-8" style={{ alignItems: 'flex-start' }}>
            <InfoIcon size={16} weight="bold" style={{ color: 'var(--muted)', flexShrink: 0, marginTop: 2 }} />
            <div className="muted" style={{ fontSize: 13, lineHeight: 1.6 }}>
              {loading ? 'Загружаем…' : (
                <>
                  Пока пусто. Агенты наполнят раздел, когда площадки что-то изменят: правки тарифов,
                  комиссий или новости для продавцов. Первая проверка после запуска только запоминает
                  текущее состояние, поэтому сообщения появятся со следующего изменения.
                </>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className="grid" style={{ gap: 12 }}>
          {items.map(t => (
            <div key={t.id} className="card" style={{ padding: 16 }}>
              <div className="row gap-8" style={{ marginBottom: 8, flexWrap: 'wrap' }}>
                <span className="mp-tab-dot" style={{ background: t.mp === 'wb' ? '#cb11ab' : '#005bff' }} />
                <strong style={{ fontSize: 13 }}>{t.mp === 'wb' ? 'Wildberries' : 'Ozon'}</strong>
                <span className="chip" style={{ fontSize: 11, color: CAT_COLOR[t.category] ?? 'var(--muted)' }}>
                  {t.category}
                </span>
                <span className="muted" style={{ fontSize: 12 }}>{fmtDate(t.date)}</span>
              </div>

              <div style={{ fontSize: 13.5, lineHeight: 1.55, marginBottom: t.impact || t.action ? 10 : 0 }}>
                {t.text}
              </div>

              {t.impact && (
                <div style={{ fontSize: 12.5, lineHeight: 1.5, color: 'var(--muted)', marginBottom: 6 }}>
                  <strong style={{ color: 'var(--text)' }}>Что это значит: </strong>{t.impact}
                </div>
              )}
              {t.action && (
                <div style={{
                  fontSize: 12.5, lineHeight: 1.5, background: 'var(--bg-2)',
                  borderRadius: 8, padding: '8px 10px', borderLeft: '2px solid var(--accent)',
                }}>
                  <strong>Что делать: </strong>{t.action}
                </div>
              )}
              {t.source && (
                <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>
                  {t.source.startsWith('http') ? (
                    <a href={t.source} target="_blank" rel="noreferrer" className="row gap-8" style={{ display: 'inline-flex', color: 'var(--accent-2)' }}>
                      <LinkSimpleIcon size={11} weight="bold" /> Источник
                    </a>
                  ) : <>Источник: {t.source}</>}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
