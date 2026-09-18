import { ReactNode, useState } from 'react';
import { CaretDownIcon, CaretRightIcon } from '@phosphor-icons/react';

type Props = {
  title: ReactNode;
  defaultOpen?: boolean;
  chip?: ReactNode;
  children: ReactNode;
};

export function Collapsible({ title, defaultOpen = false, chip, children }: Props) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="card" style={{ padding: open ? 18 : '12px 16px' }}>
      <div
        className="flex-between"
        style={{ cursor: 'pointer', userSelect: 'none' }}
        onClick={() => setOpen(!open)}
      >
        <div className="row" style={{ gap: 8 }}>
          {open ? <CaretDownIcon size={14} weight="bold" /> : <CaretRightIcon size={14} weight="bold" />}
          <span style={{ fontWeight: 600, fontSize: 14 }}>{title}</span>
          {chip}
        </div>
      </div>
      {open && <div style={{ marginTop: 14 }}>{children}</div>}
    </div>
  );
}
