import { PlugsConnectedIcon } from '@phosphor-icons/react';

type Props = { title?: string; children: React.ReactNode };

export function Stub({ title = 'Интеграция не подключена', children }: Props) {
  return (
    <div className="stub">
      <PlugsConnectedIcon size={20} weight="bold" style={{ flexShrink: 0, marginTop: 1 }} />
      <div>
        <b>{title}</b>
        <div style={{ marginTop: 4 }}>{children}</div>
      </div>
    </div>
  );
}
