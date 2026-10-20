import { useState, useEffect } from 'react';
import {
  GaugeIcon, TagIcon, ChatCircleTextIcon, PaperPlaneTiltIcon,
  GearIcon,
  CaretRightIcon, MegaphoneIcon,
  ListIcon, RobotIcon, ChatsCircleIcon, PulseIcon, BinocularsIcon, WarehouseIcon, UsersThreeIcon
} from '@phosphor-icons/react';
import { AgentHosts } from './pages/AgentHosts';
import { Login } from './pages/Login';
import { Dashboard } from './pages/Dashboard';
import { Prices } from './pages/Prices';
import { Reviews } from './pages/Reviews';
import { Chats } from './pages/Chats';
import { Settings } from './pages/Settings';
import { Ads } from './pages/Ads';
import { Competitors } from './pages/Competitors';
import { Rnp } from './pages/Rnp';
import { Sklad } from './pages/Sklad';
import { Access } from './pages/Access';
import { NotificationsBell } from './components/NotificationsBell';
import { AiChatBubble } from './components/AiChat';
import { prefetchAll } from './api/prefetch';
import { apiGet, setUnauthorizedHandler } from './api/http';
import { ROLE_LABEL, type Role } from './api/sklad';
import { noteSwallowed } from './utils/log';
import { loadUiState, startUiStateSync } from './utils/uiState';
import { ErrorBoundary } from './components/ErrorBoundary';

// Раздел «Склад» в архиве (18.10.2026): меню и страница скрыты, сервер тоже
// закрыт (api/_lib/sklad/archive.ts). Вернуть — false здесь и SKLAD_ENABLED=1 на сервере.
const SKLAD_ARCHIVED = true;

type Page = 'dashboard' | 'access' | 'sklad' | 'prices' | 'rnp' | 'reviews' | 'chats' | 'ads' | 'competitors' | 'collectors' | 'settings';

// 25.09.2026: разделы «Прогноз закупок», «Маржинальность», «Распределение»,
// «ROI и алерты», «BI и финансы», «База знаний», «Себестоимость» удалены по
// просьбе клиента (писали прежние разработчики). Код страниц удалён из
// репозитория; серверные эндпоинты и сборщик не тронуты. Себестоимость
// берётся из листа «Склад» таблицы клиента: сборщик раз в 2 часа
// синхронизирует её в справочник (api/_lib/costs.ts, таблица главнее), и из
// него её читают «Цены» и экономика товара.
// 11.10.2026: раздел «Аналитика» удалён по просьбе клиента (страница и её
// компоненты LiveOzonAnalytics/LiveWbAnalytics убраны; данные — в «РНП»).

const NAV_TOP: { key: Page; Icon: any; label: string }[] = [
  { key: 'dashboard',   Icon: GaugeIcon,           label: 'Дашборд' },
  // 18.10.2026: учёт товара на складах и фулфилментах (замена таблицы «Склад (orig)»).
  // В архиве по решению владельца (см. SKLAD_ARCHIVED ниже) — пункт скрыт.
  ...(SKLAD_ARCHIVED ? [] : [{ key: 'sklad' as Page, Icon: WarehouseIcon, label: 'Склад' }]),
];
const NAV_AFTER_PROCUREMENT: { key: Page; Icon: any; label: string }[] = [
  { key: 'prices',      Icon: TagIcon,             label: 'Цены' },
  { key: 'reviews',     Icon: ChatCircleTextIcon,  label: 'Отзывы и вопросы' },
  { key: 'chats',       Icon: ChatsCircleIcon,     label: 'Чаты с покупателями' },
  // «Рука на пульсе» — по дням и товарам из API площадок (11.10.2026), замена РнП «Культуры Аналитики».
  { key: 'rnp',         Icon: PulseIcon,           label: 'РНП' },
  { key: 'ads',         Icon: MegaphoneIcon,       label: 'Реклама' },
  // 15.10.2026: конкуренты — отдельный раздел (привязка, позиции и рынок, советник по продажам).
  { key: 'competitors', Icon: BinocularsIcon,      label: 'Конкуренты' },
];
const NAV_CONFIG: { key: Page; Icon: any; label: string }[] = [
  // «Сборщики» — сеть агентов на ПК (ТЗ «Сеть агентов»): очередь, живой ход
  // выполнения, паузы площадок. 13.10.2026: раздел «ИИ-агенты» удалён по просьбе
  // клиента — статус ключа Claude и расход на нейросеть теперь внизу «Сборщиков».
  { key: 'collectors',  Icon: RobotIcon,           label: 'Сборщики' },
  { key: 'settings',    Icon: GearIcon,            label: 'Настройки' },
  // 19.10.2026: учётки сотрудников и их разделы — только владельцу (api/_lib/access.ts).
  { key: 'access',      Icon: UsersThreeIcon,      label: 'Доступы' },
];

const TITLES: Record<Page, string> = {
  dashboard: 'Дашборд',
  access: 'Доступы сотрудников',
  sklad: 'Склад',
  prices: 'Модуль «Цены»',
  reviews: 'Отзывы и вопросы',
  chats: 'Чаты с покупателями',
  rnp: 'Рука на пульсе (РНП)',
  ads: 'Реклама',
  competitors: 'Конкуренты',
  collectors: 'Сборщики · агенты на ПК',
  settings: 'Настройки',
};

export function App() {
  const [logged, setLogged] = useState(false);
  const [page, setPage] = useState<Page>('dashboard');
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  // Кто вошёл и какие разделы ему открыты (роль + галочки владельца, см.
  // api/_lib/sklad/users.ts). Фулфилменту и закупщику — только «Склад»: сервер
  // закрывает им остальное сам, здесь только меню.
  const [me, setMe] = useState<{ name: string; role: Role; sections: string[] } | null>(null);
  const restricted = !!me && me.sections.every(s => s === 'sklad');
  const allowed = (k: Page) => k === 'access' ? me?.role === 'owner'
    : !(SKLAD_ARCHIVED && k === 'sklad') && (!me || me.sections.includes(k));

  useEffect(() => {
    if (!logged) { setMe(null); return; }
    const OWNER = { name: 'Владелец', role: 'owner' as Role, sections: [...NAV_TOP, ...NAV_AFTER_PROCUREMENT, ...NAV_CONFIG].map(n => n.key) };
    // Общая память настроек — вместе с ролью: страницы рисуются уже с серверным архивом и параметрами.
    const ui = loadUiState().finally(() => startUiStateSync());
    apiGet<{ user?: { name: string; role: Role; sections?: string[] } }>('/api/auth/check')
      .then(async r => {
        await ui;
        const u = r.data?.user;
        const m = u ? { name: u.name, role: u.role, sections: u.sections ?? OWNER.sections } : OWNER;
        setMe(m);
        if (!m.sections.includes('dashboard')) setPage((m.sections.find(s => !(SKLAD_ARCHIVED && s === 'sklad')) as Page) ?? 'dashboard');
        // Как только вошли — греем ВСЕ данные фоном, чтобы вкладки открывались
        // мгновенно без ожидания «загрузка…» на каждой (просьба клиента 20.07).
        if (!m.sections.every(s => s === 'sklad')) prefetchAll();
      })
      .catch(e => { noteSwallowed('auth', 'роль не получена — считаем владельцем', e); setMe(OWNER); prefetchAll(); });
  }, [logged]);

  // Сессия истекла — возвращаем на экран входа. Раньше каждый запрос молча
  // получал 401, а интерфейс рисовал нули, будто бизнес встал (инцидент 11.08).
  useEffect(() => {
    setUnauthorizedHandler(() => setLogged(false));
  }, []);

  if (!logged) return <Login onLogin={() => setLogged(true)} />;
  if (!me) return null;

  // Страница вне открытых разделов (переход с Дашборда, старое состояние) — показываем первую доступную.
  const firstAllowed = (me.sections as Page[]).find(allowed);
  const view: Page | null = allowed(page) ? page : firstAllowed ?? null;

  // Переход из колокольчика/Дашборда: только на существующий раздел. Раньше
  // ссылки на удалённые «Закупки» и «ROI» молча уводили на первый доступный.
  const navTo = (k: string) => { if (k in TITLES) setPage(k as Page); };

  // Выбор пункта меню: переключаем страницу и закрываем мобильный drawer.
  const goTo = (k: Page) => { setPage(k); setMobileNavOpen(false); };

  const renderNavItem = (n: { key: Page; Icon: any; label: string }) => {
    const I = n.Icon;
    return (
      <div key={n.key} className={`nav-item ${view === n.key ? 'active' : ''}`} onClick={() => goTo(n.key)} title={n.label}>
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
        {NAV_TOP.filter(n => allowed(n.key)).map(renderNavItem)}
        {NAV_AFTER_PROCUREMENT.filter(n => allowed(n.key)).map(renderNavItem)}
        {NAV_CONFIG.some(n => allowed(n.key)) && <div className="nav-section">Конфигурация</div>}
        {NAV_CONFIG.filter(n => allowed(n.key)).map(renderNavItem)}

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
          <h1>{view ? TITLES[view] : ''}</h1>
          <div className="topbar-meta">
            <span className="chip">
              {new Date().toLocaleString('ru-RU', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
            </span>
            {!restricted && <NotificationsBell onNav={navTo} />}
            <div className="profile-pill" title={`${me.name} · ${ROLE_LABEL[me.role]}`}>
              <div className="profile-avatar">{me.name.split(/s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase() || 'РА'}</div>
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
        <div className={`content ${view === 'rnp' ? 'content-wide' : view === 'prices' || view === 'ads' || view === 'competitors' || view === 'sklad' ? 'content-prices' : ''}`}>
          <ErrorBoundary key={view ?? 'none'} name={view ? TITLES[view] : ''}>
          {view === 'dashboard' && <Dashboard onNav={navTo} />}
          {view === 'sklad' && <Sklad />}
          {view === 'prices' && <Prices />}
          {view === 'reviews' && <Reviews />}
          {view === 'chats' && <Chats />}
          {view === 'rnp' && <Rnp />}
          {view === 'ads' && <Ads />}
          {view === 'competitors' && <Competitors />}
          {view === 'settings' && <Settings />}
          {view === 'collectors' && <AgentHosts />}
          {view === 'access' && <Access />}
          {view === null && <div className="card muted">Для вашей учётной записи сейчас нет доступных разделов.</div>}
          </ErrorBoundary>
        </div>
      </main>

      {/* AI-копилот: плавающая кнопка в правом нижнем углу, видна на всех страницах после логина. */}
      {!restricted && <AiChatBubble currentPage={view ? TITLES[view] : ''} />}
    </div>
  );
}
