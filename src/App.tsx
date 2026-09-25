import { useState, useEffect } from 'react';
import {
  GaugeIcon, TagIcon, ChatCircleTextIcon, ChartLineIcon, PaperPlaneTiltIcon,
  GearIcon, GraphIcon, SquaresFourIcon,
  CaretRightIcon, MegaphoneIcon, CurrencyRubIcon,
  ListIcon, RobotIcon
} from '@phosphor-icons/react';
import { AgentHosts } from './pages/AgentHosts';
import { Login } from './pages/Login';
import { Dashboard } from './pages/Dashboard';
import { Prices } from './pages/Prices';
import { Reviews } from './pages/Reviews';
import { Analytics } from './pages/Analytics';
import { Settings } from './pages/Settings';
import { Agents } from './pages/Agents';
import { Modules } from './pages/Modules';
import { Ads } from './pages/Ads';
import { Costs } from './pages/Costs';
import { NotificationsBell } from './components/NotificationsBell';
import { AiChatBubble } from './components/AiChat';
import { prefetchAll } from './api/prefetch';
import { setUnauthorizedHandler } from './api/http';
import { noteSwallowed } from './utils/log';

type Page = 'dashboard' | 'costs' | 'prices' | 'reviews' | 'analytics' | 'modules' | 'ads' | 'agents' | 'collectors' | 'settings';

// 25.09.2026: разделы «Прогноз закупок», «Маржинальность», «Распределение»,
// «ROI и алерты», «BI и финансы», «База знаний» удалены по просьбе клиента
// (писали прежние разработчики, корректность не подтверждена). Код страниц
// удалён из репозитория; серверные эндпоинты и сборщик не тронуты.
const PROCUREMENT_CHILDREN: { key: Page; Icon: any; label: string }[] = [
  { key: 'costs',       Icon: CurrencyRubIcon,     label: 'Себестоимость' },
];

const NAV_TOP: { key: Page; Icon: any; label: string }[] = [
  { key: 'dashboard',   Icon: GaugeIcon,           label: 'Дашборд' },
];
const NAV_AFTER_PROCUREMENT: { key: Page; Icon: any; label: string }[] = [
  { key: 'prices',      Icon: TagIcon,             label: 'Цены' },
  { key: 'reviews',     Icon: ChatCircleTextIcon,  label: 'Отзывы' },
  { key: 'analytics',   Icon: ChartLineIcon,       label: 'Аналитика' },
  { key: 'ads',         Icon: MegaphoneIcon,       label: 'Реклама' },
  // «Модули» скрыт из меню по просьбе клиента (28.07) — роут и страница живы,
  // вернуть = раскомментировать строку ниже.
  // { key: 'modules',     Icon: SquaresFourIcon,     label: 'Модули' },
];
const NAV_CONFIG: { key: Page; Icon: any; label: string }[] = [
  // «Сборщики» — сеть агентов на ПК (ТЗ «Сеть агентов»): очередь, живой ход
  // выполнения, паузы площадок. Не путать с «ИИ-агенты» (серверные /api/ai/*).
  { key: 'collectors',  Icon: RobotIcon,           label: 'Сборщики' },
  { key: 'agents',      Icon: GraphIcon,           label: 'ИИ-агенты' },
  { key: 'settings',    Icon: GearIcon,            label: 'Настройки' },
];

const TITLES: Record<Page, string> = {
  dashboard: 'Дашборд',
  costs: 'Себестоимость товаров',
  prices: 'Модуль «Цены»',
  reviews: 'Модуль «Отзывы»',
  analytics: 'Модуль «Аналитика»',
  ads: 'Реклама',
  modules: 'Модули · акции, аудит карточек',
  agents: 'ИИ-агенты',
  collectors: 'Сборщики · агенты на ПК',
  settings: 'Настройки',
};

export function App() {
  const [logged, setLogged] = useState(false);
  const [page, setPage] = useState<Page>('dashboard');
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  // Как только вошли — греем ВСЕ данные фоном, чтобы вкладки открывались
  // мгновенно без ожидания «загрузка…» на каждой (просьба клиента 20.07).
  useEffect(() => { if (logged) prefetchAll(); }, [logged]);

  // Сессия истекла — возвращаем на экран входа. Раньше каждый запрос молча
  // получал 401, а интерфейс рисовал нули, будто бизнес встал (инцидент 11.08).
  useEffect(() => {
    setUnauthorizedHandler(() => setLogged(false));
  }, []);

  if (!logged) return <Login onLogin={() => setLogged(true)} />;

  // Выбор пункта меню: переключаем страницу и закрываем мобильный drawer.
  const goTo = (k: Page) => { setPage(k); setMobileNavOpen(false); };

  const renderNavItem = (n: { key: Page; Icon: any; label: string }) => {
    const I = n.Icon;
    return (
      <div key={n.key} className={`nav-item ${page === n.key ? 'active' : ''}`} onClick={() => goTo(n.key)} title={n.label}>
        <I size={18} weight="bold" /> <span className="nav-label">{n.label}</span>
      </div>
    );
  };

  return (
    <div className={`app ${!sidebarOpen ? 'sidebar-collapsed' : ''} ${mobileNavOpen ? 'mobile-nav-open' : ''}`}>
      <div className="mobile-nav-overlay" onClick={() => setMobileNavOpen(false)} />
      <aside className="sidebar">
        <div className="brand">
          <span>Avto Vibe</span>
          <button 
            className="sidebar-toggle" 
            title={sidebarOpen ? 'Скрыть меню' : 'Показать меню'}
            onClick={() => setSidebarOpen(o => !o)}
          >
            <CaretRightIcon size={16} weight="bold" style={{ transform: sidebarOpen ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.3s' }} />
          </button>
        </div>

        <div className="nav-section">Кабинет</div>
        {NAV_TOP.map(renderNavItem)}

        {PROCUREMENT_CHILDREN.map(renderNavItem)}

        {NAV_AFTER_PROCUREMENT.map(renderNavItem)}

        <div className="nav-section">Конфигурация</div>
        {NAV_CONFIG.map(renderNavItem)}

        <div className="sidebar-footer">
          <div className="seller">ИП Алешко</div>
          <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
            <span className="chip" style={{ padding: '2px 8px' }}>
              <span className="mp-tab-dot" style={{ background: '#cb11ab', width: 7, height: 7 }} />
              WB
            </span>
            <span className="chip" style={{ padding: '2px 8px' }}>
              <span className="mp-tab-dot" style={{ background: '#005bff', width: 7, height: 7 }} />
              Ozon
            </span>
          </div>
          <div style={{ marginTop: 8 }}>
            <span className="chip good"><span className="dot" /> MVP demo</span>
          </div>
        </div>
      </aside>

      <main className="main">
        <div className="topbar">
          <button
            className="icon-btn mobile-burger"
            title="Меню"
            onClick={() => setMobileNavOpen(true)}
          >
            <ListIcon size={20} weight="bold" />
          </button>
          <h1>{TITLES[page]}</h1>
          <div className="topbar-meta">
            <span className="chip">
              {new Date().toLocaleString('ru-RU', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
            </span>
            <NotificationsBell onNav={(k) => setPage(k as Page)} />
            <div className="profile-pill" title="ИП Алешко">
              <div className="profile-avatar">РА</div>
              <button className="btn btn-sm" onClick={async () => {
                // Из кабинета выходим в любом случае: даже если запрос не дошёл,
                // держать пользователя внутри хуже, чем оставить живую сессию на сервере.
                try { await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' }); }
                catch (e) { noteSwallowed('auth', 'выход на сервере не выполнен', e); }
                setLogged(false);
              }}>Выйти</button>
            </div>
          </div>
        </div>
        <div className="content">
          {page === 'dashboard' && <Dashboard onNav={(k) => setPage(k as Page)} />}
          {page === 'prices' && <Prices />}
          {page === 'reviews' && <Reviews />}
          {page === 'analytics' && <Analytics />}
          {page === 'costs' && <Costs />}
          {page === 'ads' && <Ads />}
          {page === 'settings' && <Settings />}
          {page === 'modules' && <Modules />}
          {page === 'agents' && <Agents />}
          {page === 'collectors' && <AgentHosts />}
        </div>
      </main>

      {/* AI-копилот: плавающая кнопка в правом нижнем углу, видна на всех страницах после логина. */}
      <AiChatBubble currentPage={TITLES[page]} />
    </div>
  );
}
