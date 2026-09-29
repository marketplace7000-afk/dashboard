/**
 * ЕДИНАЯ ТОЧКА ИСТИНЫ по сети агентов (ТЗ «Сеть агентов», конституция v1.0.0).
 *
 * Импортируется двумя сторонами:
 *   - сервером (api/_lib/agentQueue.ts, CommonJS через tsx)
 *   - хостом на ПК (agent-host/src/*, ESM через tsx)
 * Фронт СВОЕЙ копии не держит: списки этапов и настройки приезжают в ответе
 * GET /api/agents/live — на клиенте ничего не вычисляется (конституция).
 *
 * Добавить этап сценария = поменять здесь, в коде сценария и в тестах разом.
 */

// ─── Типы заданий ────────────────────────────────────────────────────────────

export type Marketplace = 'wb' | 'ozon';

export type AgentTaskType = 'showcase_prices' | 'competitor_watch' | 'funnel_compare';

export type AgentTaskStatus = 'queued' | 'claimed' | 'running' | 'done' | 'failed' | 'cancelled';

export type PauseReason = 'captcha' | 'blocked' | 'login_required';

export type AgentTaskParams = {
  marketplace: Marketplace;
  /** Артикулы. Пусто/нет = все наши товары (сервер заполняет при постановке). */
  skus?: string[];
  /** WB: nmId → серая цена ЛК (якорь единиц card.wb.ru). Заполняет сервер. */
  anchors?: Record<string, number>;
  [k: string]: unknown;
};

export type AgentProgress = {
  stage: string;
  stage_index: number;   // 1-based
  stages_total: number;
  items_done?: number;
  items_total?: number;
  current_item?: string | null;
  message: string;
  eta_sec?: number;
};

export type AgentTask = {
  id: number;
  type: AgentTaskType;
  params: AgentTaskParams;
  priority: number;
  status: AgentTaskStatus;
  scheduled_for: number;        // ms epoch
  claimed_by?: string | null;
  claimed_at?: number | null;
  started_at?: number | null;
  finished_at?: number | null;
  attempts: number;
  max_attempts: number;
  error?: string | null;
  created_by: string;           // 'schedule' | 'button' | имя пользователя | 'dev'
  schedule_id?: number | null;
  progress?: AgentProgress | null;
  progress_updated_at?: number | null;
  created_at: number;
  summary?: string | null;
  stats?: Record<string, number> | null;
};

export type AgentRunLevel = 'info' | 'warn' | 'error';

// ─── Этапы сценариев (степпер экрана «В работе») ────────────────────────────

export type StageDef = { stage: string; title: string; counted: boolean };

export const TASK_TYPE_TITLES: Record<AgentTaskType, string> = {
  showcase_prices: 'Цены покупателя',
  competitor_watch: 'Мониторинг конкурентов',
  funnel_compare: 'Воронка продаж',
};

export const SCENARIO_STAGES: Record<AgentTaskType, StageDef[]> = {
  showcase_prices: [
    { stage: 'open_showcase',  title: 'Открыть витрину',    counted: false },
    { stage: 'collect_prices', title: 'Снять цены',         counted: true  },
    { stage: 'direct_cards',   title: 'Прямые карточки',    counted: true  },
    { stage: 'ingest',         title: 'Отправка в дашборд', counted: true  },
  ],
  competitor_watch: [
    { stage: 'load_links',     title: 'Список конкурентов',  counted: false },
    { stage: 'snapshot_cards', title: 'Снимки карточек',     counted: true  },
    { stage: 'ingest',         title: 'Отправка снимков',    counted: false },
    { stage: 'analyze',        title: 'Анализ (Claude)',     counted: true  },
    { stage: 'save_advice',    title: 'Запись рекомендаций', counted: false },
  ],
  funnel_compare: [
    { stage: 'open_cabinet',        title: 'Вход в кабинет',         counted: false },
    { stage: 'collect_ours',        title: 'Воронка наших товаров',  counted: true  },
    { stage: 'collect_competitors', title: 'Данные по конкурентам',  counted: true  },
    { stage: 'ingest',              title: 'Отправка в дашборд',     counted: false },
    { stage: 'analyze',             title: 'Анализ (Claude)',        counted: false },
  ],
};

// ─── Настройки по умолчанию (переопределяются в agent_settings из панели) ───

export type AgentSettings = {
  /** Пауза между открытием страниц, мс: случайная в [min, max]. */
  page_pause_ms: [number, number];
  /** Пауза между товарами при прямом открытии карточек, мс. */
  card_pause_ms: [number, number];
  /** Не более страниц в час на площадку. */
  pages_per_hour: number;
  /** Минимальный интервал между полными проходами showcase_prices на площадку, мин. */
  showcase_min_interval_min: number;
  /** Пауза площадки после капчи/блокировки, мин. */
  pause_after_captcha_min: number;
  /** running без progress/log дольше этого — failed 'stale', мин. */
  stale_after_min: number;
  /** claimed, не ставший running за это время, — обратно в queued, мин. */
  unclaim_after_min: number;
  /** Хост офлайн, если heartbeat старше, мин. */
  offline_after_min: number;
  /** Порог «конкурент дешевле» для attention / urgent, %. */
  competitor_attention_pct: number;
  competitor_urgent_pct: number;
  /** Лимит токенов анализа на один товар. */
  tokens_per_item_limit: number;
};

export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  page_pause_ms: [3000, 8000],
  card_pause_ms: [5000, 12000],
  pages_per_hour: 120,
  showcase_min_interval_min: 180,
  pause_after_captcha_min: 360,
  stale_after_min: 30,
  unclaim_after_min: 5,
  offline_after_min: 2,
  competitor_attention_pct: 5,
  competitor_urgent_pct: 15,
  tokens_per_item_limit: 2000,
};

// ─── Контракты API хоста ────────────────────────────────────────────────────

export type HeartbeatReq = { name: string; version: string; chrome_ok: boolean };
export type HeartbeatRes = { ok: true; paused: boolean };

export type ClaimReq = { name: string; types: AgentTaskType[] };
export type ClaimRes = { task: AgentTask; settings: AgentSettings } | null; // null = 204

export type TaskStatusRes = { ok: true; status: AgentTaskStatus };

export type FailReq = {
  error: string;
  retryable: boolean;
  pause?: { marketplace: Marketplace; reason: PauseReason };
};

export const AGENT_HOST_VERSION = '0.1.0';
