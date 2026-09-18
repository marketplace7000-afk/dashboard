type Props = { on: boolean; onChange: (v: boolean) => void; label?: string };

export function Switch({ on, onChange, label }: Props) {
  return (
    <div className={`switch ${on ? 'on' : ''}`} onClick={() => onChange(!on)}>
      <div className="switch-track"><div className="switch-thumb" /></div>
      {label && <span>{label}</span>}
    </div>
  );
}
