/**
 * «Доступы» — учётные записи сотрудников (только владелец).
 *
 * Владелец сам придумывает логин (можно почту) и пароль и передаёт их
 * человеку — без писем и подтверждений. Выданный пароль виден здесь же
 * (хранится зашифрованным), его можно скопировать и переслать заново. Роль
 * задаёт набор разделов, его можно поправить галочками. Выключение, смена
 * пароля или «Выйти на всех устройствах» сразу выбрасывает человека из
 * кабинета. Кнопка в карточке «Вход владельца» выкидывает всех, кто вошёл
 * по общему паролю владельца.
 * Сервер: api/_lib/access.ts.
 */
import { useEffect, useState } from 'react';
import { PlusIcon, WarningIcon, CopyIcon, ArrowsClockwiseIcon, XIcon, EyeIcon, EyeSlashIcon, SignOutIcon } from '@phosphor-icons/react';
import { apiGet, apiPost, errText } from '../api/http';

type Role = 'owner' | 'manager' | 'buyer' | 'warehouse';
type User = {
  id: number; login: string; name: string; role: Role; active: boolean; hasPassword: boolean;
  /** Выданный пароль; null — выдан до 27.10.2026 (не сохранялся) или не прочитать. */
  password: string | null;
  sections: string[]; customSections: boolean; createdAt: number; lastLoginAt: number | null;
};
type Data = {
  users: User[];
  roles: Array<{ value: Role; label: string; sections: string[] }>;
  sections: Array<{ value: string; label: string }>;
  archivedSklad: boolean;
};
type JournalRow = { id: number; ts: number; userName: string; entityId: string; action: string; diff: Record<string, unknown> };

const err = (e: unknown) => errText(e).replace(/^сервер ответил \d+:\s*/, '');
const fmt = (ts: number | null) => (ts ? new Date(ts).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');
const ROLE_HINT: Record<Role, string> = {
  owner: 'Всё, включая «Доступы» и «Настройки».',
  manager: 'Весь кабинет, кроме «Настроек» и «Доступов». Разделы можно сузить галочками.',
  buyer: 'Только раздел «Склад»: товары и закупки.',
  warehouse: 'Только раздел «Склад» и только свои склады, без цен.',
};

const loginText = (login: string, password: string) => `Вход в кабинет Avto Vibe: https://e-avtovibe.ru\nЛогин: ${login}\nПароль: ${password}`;

/** Пароль, который легко продиктовать: без похожих символов (0/O, 1/l). */
function genPassword(): string {
  const abc = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const a = new Uint32Array(10);
  crypto.getRandomValues(a);
  return Array.from(a, x => abc[x % abc.length]).join('');
}

export function Access() {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [edit, setEdit] = useState<User | 'new' | null>(null);
  const [issued, setIssued] = useState<{ name: string; login: string; password: string } | null>(null);
  const [journal, setJournal] = useState<JournalRow[] | null>(null);

  const load = () => apiGet<Data>('/api/access').then(r => { setData(r.data); setError(null); }).catch(e => setError(err(e)));
  useEffect(() => { load(); }, []);

  if (error) return <div className="card sk-err"><WarningIcon size={16} /> {error} <button className="btn btn-sm" onClick={load}>Повторить</button></div>;
  if (!data) return <div className="card muted">Загрузка…</div>;
  const label = (s: string) => data.sections.find(x => x.value === s)?.label ?? s;
  const roleLabel = (r: Role) => data.roles.find(x => x.value === r)?.label ?? r;

  return (
    <div className="acc">
      <div className="card">
        <div className="flex-between acc-head">
          <div>
            <h2>Доступы сотрудников</h2>
            <p className="muted">Вы сами придумываете логин и пароль и передаёте их человеку. Он входит на e-avtovibe.ru с этим логином и паролем. Пароль виден в таблице — нажмите на глаз или «Скопировать», чтобы переслать заново.</p>
          </div>
          <button className="btn btn-primary" onClick={() => setEdit('new')}><PlusIcon size={16} /> Добавить человека</button>
        </div>
      </div>

      <OwnerCard onError={setError} />

      {issued && <IssuedCard {...issued} onClose={() => setIssued(null)} />}

      <div className="card sk-table-card">
        <div className="sk-scroll">
          <table className="sk-table">
            <thead><tr><th>Имя</th><th>Логин</th><th>Роль</th><th>Разделы</th><th>Пароль</th><th>Последний вход</th></tr></thead>
            <tbody>
              {data.users.map(u => (
                <tr key={u.id} className={u.active ? '' : 'sk-row-muted'} onClick={() => setEdit(u)}>
                  <td><b>{u.name}</b>{!u.active && <span className="chip sk-ml">выключен</span>}</td>
                  <td className="sk-mono">{u.login}</td>
                  <td>{roleLabel(u.role)}</td>
                  <td className="muted sk-name">{u.role === 'owner' ? 'все' : u.customSections ? u.sections.map(label).join(', ') : 'по роли'}</td>
                  <td onClick={ev => ev.stopPropagation()}><PasswordCell login={u.login} password={u.password} hasPassword={u.hasPassword} /></td>
                  <td className="muted">{fmt(u.lastLoginAt)}</td>
                </tr>
              ))}
              {!data.users.length && <tr><td colSpan={6} className="muted sk-empty">Пока никого — нажмите «Добавить человека»</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <button className="btn btn-sm" onClick={() => journal ? setJournal(null) : apiGet<{ journal: JournalRow[] }>('/api/access/journal').then(r => setJournal(r.data.journal)).catch(e => setError(err(e)))}>
          {journal ? 'Скрыть журнал' : 'Журнал изменений'}
        </button>
        {journal && (
          <div className="acc-journal">
            {journal.length ? journal.map(j => (
              <div key={j.id} className="sk-audit">
                <span className="muted">{fmt(j.ts)}</span> <b>{j.userName}</b> · {j.action === 'create' ? 'создал' : 'изменил'} учётку #{j.entityId}
                <div className="muted sk-audit-diff">{Object.entries(j.diff).map(([k, v]) => `${k}: ${Array.isArray(v) ? `${v[0] ?? '∅'} → ${v[1] ?? '∅'}` : String(v)}`).join('; ')}</div>
              </div>
            )) : <span className="muted">Изменений пока не было</span>}
          </div>
        )}
      </div>

      {edit && (
        <UserModal data={data} user={edit === 'new' ? null : edit} onClose={() => setEdit(null)}
          onSaved={(u, pw) => { setEdit(null); if (pw) setIssued({ name: u.name, login: u.login, password: pw }); load(); }} />
      )}
    </div>
  );
}

/** Карточка «что передать человеку» — показывается один раз после выдачи пароля. */
function IssuedCard({ name, login, password, onClose }: { name: string; login: string; password: string; onClose: () => void }) {
  const text = loginText(login, password);
  const [copied, setCopied] = useState(false);
  return (
    <div className="card acc-issued">
      <div className="flex-between"><b>Данные для входа — {name}</b><button className="close acc-x" onClick={onClose} title="Скрыть"><XIcon size={16} /></button></div>
      <pre className="acc-pre">{text}</pre>
      <div className="row gap-8">
        <button className="btn btn-sm" onClick={() => navigator.clipboard?.writeText(text).then(() => setCopied(true)).catch(() => setCopied(false))}><CopyIcon size={14} /> {copied ? 'Скопировано' : 'Скопировать'}</button>
        <span className="muted sk-hint">Пароль сохранён — его всегда можно посмотреть в таблице ниже.</span>
      </div>
    </div>
  );
}

/** Пароль в таблице: скрыт точками, глаз — показать, кнопка — скопировать логин и пароль. */
function PasswordCell({ login, password, hasPassword }: { login: string; password: string | null; hasPassword: boolean }) {
  const [show, setShow] = useState(false);
  const [copied, setCopied] = useState(false);
  if (!password) return <span className="muted" title="Пароль выдан до того, как их стали сохранять. Откройте учётку и задайте новый — тогда он будет виден здесь.">{hasPassword ? 'не сохранён' : '—'}</span>;
  return (
    <span className="row gap-8 acc-pw">
      <span className="sk-mono">{show ? password : '••••••••••'}</span>
      <button className="acc-icon" type="button" title={show ? 'Скрыть' : 'Показать пароль'} onClick={() => setShow(!show)}>{show ? <EyeSlashIcon size={16} /> : <EyeIcon size={16} />}</button>
      <button className="acc-icon" type="button" title="Скопировать логин и пароль" onClick={() => navigator.clipboard?.writeText(loginText(login, password)).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })}>
        <CopyIcon size={16} />{copied && <span className="acc-copied">скопировано</span>}
      </button>
    </span>
  );
}

/** Вход по общему паролю владельца: выкинуть всех, кто в нём сидит (кроме себя). */
function OwnerCard({ onError }: { onError: (e: string) => void }) {
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const kick = async () => {
    if (!confirm('Выкинуть всех, кто сейчас вошёл по паролю владельца? Вы останетесь в кабинете. Чтобы они не вошли снова, пароль владельца тоже нужно сменить.')) return;
    setBusy(true);
    try { await apiPost('/api/access/logout-owner', {}); setDone(true); } catch (e) { onError(err(e)); } finally { setBusy(false); }
  };
  return (
    <div className="card">
      <div className="flex-between acc-head">
        <div>
          <b>Вход владельца</b>
          <p className="muted">Общий пароль владельца (без логина) даёт полный доступ. Не передавайте его сотрудникам — каждому выдайте свою учётку ниже. После смены пароля владельца все, кто входил по старому, вылетают сами.</p>
        </div>
        <button className="btn" onClick={kick} disabled={busy || done}><SignOutIcon size={16} /> {done ? 'Все вышли' : 'Выкинуть всех, кто вошёл по паролю владельца'}</button>
      </div>
    </div>
  );
}

function UserModal({ data, user, onClose, onSaved }: { data: Data; user: User | null; onClose: () => void; onSaved: (u: User, password: string | null) => void }) {
  const roleSections = (r: Role) => data.roles.find(x => x.value === r)?.sections ?? [];
  const firstRole = data.roles.find(r => r.value === 'manager')?.value ?? data.roles[0].value;
  const [f, setF] = useState({
    name: user?.name ?? '', login: user?.login ?? '', role: (user?.role ?? firstRole) as Role,
    password: user ? '' : genPassword(), active: user?.active ?? true,
    sections: user?.sections ?? roleSections(firstRole), touched: false,
  });
  const [e, setE] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const roleKnown = data.roles.some(r => r.value === f.role);
  const editable = f.role === 'manager' || f.role === 'buyer';
  const set = (k: 'name' | 'login' | 'password') => (ev: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: ev.target.value });
  const toggle = (s: string) => setF({ ...f, touched: true, sections: f.sections.includes(s) ? f.sections.filter(x => x !== s) : [...f.sections, s] });

  const logoutAll = async () => {
    if (!user || !confirm(`Выкинуть ${user.name} со всех устройств? Логин и пароль не меняются — войти снова можно с ними же.`)) return;
    setBusy(true); setE(null);
    try { await apiPost(`/api/access/${user.id}`, { logoutAll: true }); onSaved(user, null); } catch (ex) { setE(err(ex)); } finally { setBusy(false); }
  };

  const save = async () => {
    setBusy(true); setE(null);
    const input: Record<string, unknown> = { name: f.name, login: f.login, active: f.active };
    if (roleKnown) input.role = f.role;
    if (editable && (f.touched || user?.customSections)) input.sections = f.sections;
    if (f.password) input.password = f.password;
    try {
      const r = await apiPost<{ user: User }>(`/api/access${user ? `/${user.id}` : ''}`, input);
      onSaved(r.data.user, f.password || null);
    } catch (ex) { setE(err(ex)); } finally { setBusy(false); }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={ev => ev.stopPropagation()}>
        <div className="flex-between"><h2>{user ? user.name : 'Новый сотрудник'}</h2><button className="close" onClick={onClose} title="Закрыть"><XIcon size={18} /></button></div>
        <div className="grid grid-2">
          <div className="field"><label className="field-label">Имя</label><input className="input" value={f.name} onChange={set('name')} placeholder="Как его зовут" autoFocus={!user} /></div>
          <div className="field"><label className="field-label">Логин</label><input className="input" value={f.login} onChange={set('login')} placeholder="почта или слово латиницей" autoCapitalize="none" /></div>
          <div className="field">
            <label className="field-label">Роль</label>
            <select className="input" value={f.role} disabled={!roleKnown} onChange={ev => { const r = ev.target.value as Role; setF({ ...f, role: r, sections: roleSections(r), touched: false }); }}>
              {data.roles.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
              {!roleKnown && <option value={f.role}>{f.role}</option>}
            </select>
          </div>
          <div className="field">
            <label className="field-label">{user ? 'Новый пароль' : 'Пароль'}</label>
            <div className="row gap-8">
              <input className="input sk-mono" value={f.password} onChange={set('password')} placeholder={user ? (user.password ? `сейчас: ${user.password}` : 'пусто — оставить прежний') : ''} autoComplete="new-password" />
              <button className="btn btn-sm" type="button" title="Придумать пароль" onClick={() => setF({ ...f, password: genPassword() })}><ArrowsClockwiseIcon size={14} /></button>
            </div>
          </div>
        </div>
        <div className="muted sk-hint">{ROLE_HINT[f.role]}</div>
        {f.role !== 'owner' && (
          <div className="field">
            <label className="field-label">Разделы кабинета</label>
            <div className="sk-checks">{data.sections.map(s => (
              <label key={s.value} className="row gap-8">
                <input type="checkbox" checked={f.sections.includes(s.value)} disabled={!editable} onChange={() => toggle(s.value)} /> {s.label}
              </label>
            ))}</div>
          </div>
        )}
        {user && <label className="row gap-8"><input type="checkbox" checked={f.active} onChange={ev => setF({ ...f, active: ev.target.checked })} /> Учётка включена (снимите галочку — человек сразу потеряет доступ)</label>}
        {e && <div className="sk-err"><WarningIcon size={14} /> {e}</div>}
        <div className="row gap-8 sk-actions">
          <button className="btn btn-primary" onClick={save} disabled={busy}>{busy ? 'Сохраняю…' : 'Сохранить'}</button>
          <button className="btn" onClick={onClose}>Отмена</button>
          {user && <button className="btn" onClick={logoutAll} disabled={busy} title="Логин и пароль не меняются"><SignOutIcon size={14} /> Выйти на всех устройствах</button>}
        </div>
      </div>
    </div>
  );
}
