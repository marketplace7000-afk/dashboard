import { Component, type ReactNode } from 'react';
import { WarningIcon } from '@phosphor-icons/react';
import { noteSwallowed } from '../utils/log';

/**
 * «Предохранитель»: ошибка при отрисовке одного раздела больше не превращает
 * весь кабинет в белый экран (прожарка 20.10.2026) — падает только этот
 * раздел, меню и остальные страницы работают. `name` — что не загрузилось.
 */
export class ErrorBoundary extends Component<{ name: string; children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    noteSwallowed('ui', `раздел «${this.props.name}» упал при отрисовке`, error);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="card" style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
        <WarningIcon size={22} weight="bold" style={{ color: 'var(--bad)', flex: 'none', marginTop: 2 }} />
        <div>
          <b>Раздел «{this.props.name}» не загрузился</b>
          <div className="muted" style={{ marginTop: 6 }}>
            Остальные разделы работают. Попробуйте обновить страницу; если повторится — сообщите разработчику
            текст ниже.
          </div>
          <div className="muted" style={{ marginTop: 6, fontFamily: 'monospace', fontSize: 15 }}>{this.state.error.message}</div>
          <button className="btn btn-sm" style={{ marginTop: 10 }} onClick={() => this.setState({ error: null })}>Попробовать снова</button>
        </div>
      </div>
    );
  }
}
