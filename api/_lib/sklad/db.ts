/**
 * Раздел «Склад» — своя база учёта (ТЗ: Sklad/Анализ и проект системы учёта.md).
 *
 * Отдельный файл sklad.sqlite рядом с history.sqlite: история снимков — кэш,
 * её можно потерять; склад — первичные данные, его бэкапим отдельно и не
 * смешиваем. Тот же встроенный node:sqlite (Node ≥ 22.5), без npm-зависимостей.
 *
 * Схема меняется только миграциями из MIGRATIONS (по порядку, номер = индекс+1,
 * текущий номер — PRAGMA user_version). Уже выпущенную миграцию не правим —
 * добавляем следующую.
 *
 * В отличие от history.ts, здесь нет «тихого no-op»: без базы склад работать
 * не может, поэтому getSkladDb() бросает понятную ошибку, а обработчик
 * отвечает 503 с причиной.
 */
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

let DatabaseSync: any = null;
let loadError = '';
try {
  // api/ — CommonJS (api/package.json), require доступен.
  DatabaseSync = require('node:sqlite').DatabaseSync;
} catch (e) {
  loadError = (e as Error).message;
}

export class SkladDbUnavailable extends Error {}

/** Путь к базе. SKLAD_DB_PATH — для проверок (scripts/check-sklad-db.ts). */
export function skladDbPath(): string {
  if (process.env.SKLAD_DB_PATH) return process.env.SKLAD_DB_PATH;
  const dir = process.env.CACHE_DIR || join(process.cwd(), '.av-cache');
  return join(dir, 'sklad.sqlite');
}

const MIGRATIONS: string[] = [
  // 1 — этап 1: пользователи, справочники товаров и складов, журнал действий.
  `
  CREATE TABLE users (
    id            INTEGER PRIMARY KEY,
    login         TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name          TEXT NOT NULL,
    role          TEXT NOT NULL CHECK (role IN ('owner','manager','buyer','warehouse')),
    pass_hash     TEXT,                    -- scrypt; NULL = вход только через Telegram
    tg_id         INTEGER UNIQUE,
    active        INTEGER NOT NULL DEFAULT 1,
    token_ver     INTEGER NOT NULL DEFAULT 1, -- +1 = все сессии пользователя недействительны
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    last_login_at INTEGER
  );

  CREATE TABLE warehouses (
    id          INTEGER PRIMARY KEY,
    code        TEXT NOT NULL UNIQUE,      -- короткий ключ: ufa, ff-podolsk…
    name        TEXT NOT NULL UNIQUE,      -- как в таблице: «Склад Уфа», «ФФ Подольск»
    kind        TEXT NOT NULL CHECK (kind IN ('own','ff','transit')),
    city        TEXT NOT NULL DEFAULT '',
    sheet_name  TEXT,                      -- лист в Google-таблице (для сверки на переходе)
    active      INTEGER NOT NULL DEFAULT 1,
    sort        INTEGER NOT NULL DEFAULT 100,
    notes       TEXT NOT NULL DEFAULT '',
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );

  -- Доступ сотрудника склада: какие склады он видит.
  CREATE TABLE user_warehouses (
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    warehouse_id INTEGER NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, warehouse_id)
  );

  -- Склады площадок, привязанные к нашему складу (замена констант FBS.gs).
  --   mode: stock       — шлём остаток и списываем заказы;
  --         heavy_only  — только тяжёлые товары (СГТ WB);
  --         orders_only — остаток не шлём, заказы списываем (КГТ Ozon).
  CREATE TABLE mp_warehouses (
    id           INTEGER PRIMARY KEY,
    warehouse_id INTEGER NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
    mp           TEXT NOT NULL CHECK (mp IN ('wb1','wb2','ozon','ym')),
    ext_name     TEXT NOT NULL,            -- точное название в кабинете
    ext_id       TEXT,                     -- id склада площадки (заполняет синхронизация)
    mode         TEXT NOT NULL DEFAULT 'stock' CHECK (mode IN ('stock','heavy_only','orders_only')),
    active       INTEGER NOT NULL DEFAULT 1,
    notes        TEXT NOT NULL DEFAULT '',
    synced_at    INTEGER,
    UNIQUE (mp, ext_name)
  );

  -- Товар никогда не удаляется: ассортимент «течёт», а история движений
  -- должна остаться. Выведенный товар — status = 'archived'.
  CREATE TABLE products (
    id          INTEGER PRIMARY KEY,
    article     TEXT NOT NULL UNIQUE COLLATE NOCASE, -- = offer_id Ozon = vendorCode WB
    name        TEXT NOT NULL DEFAULT '',
    status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('draft','active','phaseout','archived')),
    length_cm   REAL,
    width_cm    REAL,
    height_cm   REAL,
    weight_g    REAL,
    per_box     INTEGER,                   -- штук в коробке
    photo_url   TEXT NOT NULL DEFAULT '',
    disk_url    TEXT NOT NULL DEFAULT '',  -- папка на Яндекс Диске (запрос закупщика у поставщика)
    notes       TEXT NOT NULL DEFAULT '',
    source      TEXT NOT NULL DEFAULT 'manual', -- manual | sheet
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    updated_by  INTEGER REFERENCES users(id)
  );

  -- Баркоды: у товара их может быть несколько (основной, кабинет WB 2, старые).
  CREATE TABLE product_barcodes (
    barcode     TEXT PRIMARY KEY,
    product_id  INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    kind        TEXT NOT NULL DEFAULT 'main' CHECK (kind IN ('main','wb2','extra')),
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX product_barcodes_product ON product_barcodes(product_id);

  -- Привязка товара к карточке площадки (замена BARCODE_CHRTID_MAP и моста каб.2).
  --   wb1/wb2: ext_sku = nmID, ext_item = chrtID;  ozon: ext_sku = sku, ext_item = product_id.
  CREATE TABLE product_mp (
    product_id  INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    mp          TEXT NOT NULL CHECK (mp IN ('wb1','wb2','ozon','ym')),
    ext_sku     TEXT NOT NULL DEFAULT '',
    ext_item    TEXT NOT NULL DEFAULT '',
    barcode     TEXT NOT NULL DEFAULT '',
    title       TEXT NOT NULL DEFAULT '',
    synced_at   INTEGER NOT NULL,
    PRIMARY KEY (product_id, mp)
  );

  -- Кто, когда и что изменил. diff — JSON {поле: [было, стало]}.
  CREATE TABLE audit_log (
    id          INTEGER PRIMARY KEY,
    ts          INTEGER NOT NULL,
    user_id     INTEGER,
    user_name   TEXT NOT NULL,
    entity      TEXT NOT NULL,
    entity_id   TEXT NOT NULL,
    action      TEXT NOT NULL,
    diff        TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX audit_log_entity ON audit_log(entity, entity_id);
  CREATE INDEX audit_log_ts ON audit_log(ts);
  `,
  // 2 — разделы кабинета на человека: NULL = набор по роли (users.ts, ROLE_SECTIONS).
  `ALTER TABLE users ADD COLUMN sections TEXT;`,
  // 3 — этап 2: журнал движений (остаток = сумма движений) и инвентаризации.
  `
  -- Движение меняет остаток ОДНОГО склада: sign = +1 приход, −1 расход.
  -- Перемещение = расход на складе-отправителе (status in_transit, counter_wh =
  -- получатель) + приход на получателе со ссылкой link_id на расход.
  -- Ошибки не удаляются, а сторнируются: обратное движение с link_id на исходное,
  -- у исходного reversed = 1.
  CREATE TABLE movements (
    id           INTEGER PRIMARY KEY,
    ts           INTEGER NOT NULL,          -- дата операции
    wh_id        INTEGER NOT NULL REFERENCES warehouses(id),
    sign         INTEGER NOT NULL CHECK (sign IN (1, -1)),
    kind         TEXT NOT NULL,             -- см. MOVEMENT_KINDS в movements.ts
    counter_wh   INTEGER REFERENCES warehouses(id), -- второй склад перемещения
    counterpart  TEXT NOT NULL DEFAULT '',  -- куда/откуда словами: WB, Ozon, Китай…
    ref          TEXT NOT NULL DEFAULT '',  -- № заказа, поставки, задания
    note         TEXT NOT NULL DEFAULT '',
    status       TEXT NOT NULL DEFAULT 'done' CHECK (status IN ('done','in_transit','received')),
    link_id      INTEGER REFERENCES movements(id),
    reversed     INTEGER NOT NULL DEFAULT 0,
    source       TEXT NOT NULL DEFAULT 'manual', -- manual | sheet | inventory | wb | ozon
    created_by   INTEGER,
    created_name TEXT NOT NULL DEFAULT '',
    created_at   INTEGER NOT NULL
  );
  CREATE INDEX movements_wh ON movements(wh_id, ts);
  CREATE INDEX movements_ref ON movements(ref);
  CREATE INDEX movements_source ON movements(source);

  CREATE TABLE movement_lines (
    id           INTEGER PRIMARY KEY,
    movement_id  INTEGER NOT NULL REFERENCES movements(id) ON DELETE CASCADE,
    product_id   INTEGER NOT NULL REFERENCES products(id),
    qty          INTEGER NOT NULL,          -- в истории из таблицы бывает и отрицательное
    price        REAL,                      -- цена партии (только закупка)
    barcode      TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX movement_lines_mov ON movement_lines(movement_id);
  CREATE INDEX movement_lines_product ON movement_lines(product_id);

  CREATE TABLE inventories (
    id          INTEGER PRIMARY KEY,
    wh_id       INTEGER NOT NULL REFERENCES warehouses(id),
    status      TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','done','cancelled')),
    full_count  INTEGER NOT NULL DEFAULT 0, -- 1 = непосчитанное списать в 0
    note        TEXT NOT NULL DEFAULT '',
    created_by  INTEGER,
    created_name TEXT NOT NULL DEFAULT '',
    created_at  INTEGER NOT NULL,
    done_at     INTEGER,
    done_name   TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE inventory_lines (
    inventory_id INTEGER NOT NULL REFERENCES inventories(id) ON DELETE CASCADE,
    product_id   INTEGER NOT NULL REFERENCES products(id),
    counted      INTEGER NOT NULL,
    expected     INTEGER,                   -- снимок «ожидалось» при проведении
    counted_at   INTEGER NOT NULL,
    PRIMARY KEY (inventory_id, product_id)
  );
  `,
  // 4 — служебные отметки (перенос истории, переход с таблицы).
  `CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);`,
  // 5 — этап 3: реестр заказов FBS с площадок (строка = заказ × товар).
  `
  CREATE TABLE mp_orders (
    id            INTEGER PRIMARY KEY,
    mp            TEXT NOT NULL CHECK (mp IN ('wb1','wb2','ozon')),
    order_id      TEXT NOT NULL,            -- WB: id сборочного задания; Ozon: номер отправления
    offer         TEXT NOT NULL DEFAULT '', -- артикул/offer_id или баркод из заказа
    product_id    INTEGER REFERENCES products(id),
    qty           INTEGER NOT NULL,
    ext_wh_id     TEXT NOT NULL DEFAULT '',
    wh_id         INTEGER REFERENCES warehouses(id), -- наш склад (по складу площадки)
    ordered_at    INTEGER NOT NULL,
    raw_status    TEXT NOT NULL DEFAULT '', -- как у площадки: new/confirm/…, awaiting_packaging/…
    state         TEXT NOT NULL,            -- open | assembled | shipped | cancelled_before | cancelled_after | removed
    problem       TEXT NOT NULL DEFAULT '', -- нет склада / нет товара / отменён после сборки…
    movement_id   INTEGER REFERENCES movements(id), -- списание (боевой режим)
    storno_id     INTEGER REFERENCES movements(id), -- сторно при отмене до передачи
    first_seen    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    UNIQUE (mp, order_id, offer)
  );
  CREATE INDEX mp_orders_state ON mp_orders(state);
  CREATE INDEX mp_orders_wh ON mp_orders(wh_id, state);
  CREATE INDEX mp_orders_ordered ON mp_orders(ordered_at);
  `,
  // 6 — склады площадок «не учитывать» (самовыкупы «Нижнекамск спортивная 9» и т.п.).
  `
  ALTER TABLE mp_orders ADD COLUMN ignored INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE mp_wh_ignored (
    mp       TEXT NOT NULL,
    ext_id   TEXT NOT NULL,
    ext_name TEXT NOT NULL DEFAULT '',
    reason   TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (mp, ext_id)
  );
  `,
  // 7 — занят: так была пронумерована удалённая из кода миграция закупок
  // (таблицы purchases/purchase_lines на проде остались). Рабочая база уже на
  // версии 7, поэтому новая миграция под этим номером там не запустилась бы.
  `SELECT 1;`,
  // 8 — пароль сотрудника в зашифрованном виде, чтобы владелец мог его
  // посмотреть в «Доступах» (users.ts, sealPassword). Вход сверяет pass_hash.
  `ALTER TABLE users ADD COLUMN pass_enc TEXT;`,
];

export function kvGet(key: string): string | null {
  return (getSkladDb().prepare('SELECT value FROM kv WHERE key = ?').get(key) as any)?.value ?? null;
}
export function kvSet(key: string, value: string): void {
  getSkladDb().prepare(`INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(key, value, Date.now());
}

let db: any = null;

export function getSkladDb(): any {
  if (db) return db;
  if (!DatabaseSync) throw new SkladDbUnavailable(`node:sqlite недоступен (${loadError || 'нужен Node ≥ 22.5'})`);
  const path = skladDbPath();
  mkdirSync(join(path, '..'), { recursive: true });
  const d = new DatabaseSync(path);
  d.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(d);
  db = d;
  return db;
}

/** Закрыть соединение (нужно проверкам, чтобы удалить временный файл). */
export function closeSkladDb(): void {
  if (db) { try { db.close(); } catch { /* уже закрыта */ } db = null; }
}

function migrate(d: any): void {
  const cur = Number((d.prepare('PRAGMA user_version').get() as any)?.user_version ?? 0);
  for (let v = cur; v < MIGRATIONS.length; v++) {
    d.exec('BEGIN');
    try {
      d.exec(MIGRATIONS[v]);
      d.exec(`PRAGMA user_version = ${v + 1}`);
      d.exec('COMMIT');
      console.warn(`[sklad] миграция базы ${v + 1} применена`);
    } catch (e) {
      d.exec('ROLLBACK');
      throw new Error(`[sklad] миграция ${v + 1} не применилась: ${(e as Error).message}`);
    }
  }
}

/** Выполнить fn в транзакции: либо всё, либо ничего. */
export function tx<T>(fn: (d: any) => T): T {
  const d = getSkladDb();
  d.exec('BEGIN IMMEDIATE');
  try {
    const r = fn(d);
    d.exec('COMMIT');
    return r;
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
}
