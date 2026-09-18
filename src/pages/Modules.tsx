import { useState } from 'react';
import { PercentIcon, ImagesIcon, SparkleIcon } from '@phosphor-icons/react';
import { LiveOzonPromos } from '../components/LiveOzonPromos';
import { LiveOzonCardAudit } from '../components/LiveOzonCardAudit';
import { AiCardAudit } from '../components/AiCardAudit';

type Tab = 'promos' | 'audit' | 'ai-audit';

// «ROI и алерты» вынесен в отдельный пункт меню (по просьбе клиента). Здесь —
// остальные рабочие модули с живыми данными.
const TABS: { key: Tab; label: string; Icon: any; status: 'live' | 'partial' }[] = [
  { key: 'promos',    label: 'Акции и скидки',          Icon: PercentIcon,     status: 'partial' },
  { key: 'audit',     label: 'Аудит карточек',          Icon: ImagesIcon,      status: 'partial' },
  { key: 'ai-audit',  label: 'AI-аудит (фото+контент)', Icon: SparkleIcon,     status: 'live' },
];

const STATUS_CHIP = {
  live: <span className="chip good">live</span>,
  partial: <span className="chip warn">частично</span>,
};

export function Modules() {
  const [tab, setTab] = useState<Tab>('promos');

  return (
    <div className="grid" style={{ gap: 20 }}>
      <div className="row gap-8" style={{ flexWrap: 'wrap' }}>
        {TABS.map((t) => {
          const I = t.Icon;
          return (
            <button
              key={t.key}
              className={`mp-tab ${tab === t.key ? 'active' : ''}`}
              onClick={() => setTab(t.key)}
            >
              <I size={14} weight="bold" />
              {t.label}
              <span style={{ marginLeft: 6 }}>{STATUS_CHIP[t.status]}</span>
            </button>
          );
        })}
      </div>

      {tab === 'promos' && <LiveOzonPromos />}
      {tab === 'audit' && <LiveOzonCardAudit />}
      {tab === 'ai-audit' && <AiCardAudit />}
    </div>
  );
}
