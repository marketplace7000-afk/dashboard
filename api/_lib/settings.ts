/**
 * Общие настройки кабинета — те, что меняют РАСЧЁТ, а не оформление.
 *
 * Зачем отдельно от справочника себестоимости и настроек репрайсера: это не
 * данные о товарах, а правила, по которым считается экономика. Их немного, но
 * каждая меняет цифры на всех экранах сразу, поэтому они должны лежать в одном
 * месте и иметь явное значение по умолчанию.
 *
 * Файл в av-data, как и себестоимость: переживает выкатку (каталог исключён из
 * rsync) и виден глазами.
 */
import { join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { noteSwallowed } from './log';

/**
 * Схема работы со складом. От неё зависят комиссия и логистика: у FBO и FBS они
 * разные, и подставить не ту — значит показать неверную прибыль по всему каталогу.
 *
 * Клиент перешёл на FBS (29.08), поэтому это значение по умолчанию. Возможность
 * задать FBO он попросил оставить: часть товаров может вернуться на склад
 * площадки, и тогда правило меняется здесь, а не правкой кода.
 */
export type Fulfilment = 'fbs' | 'fbo';

export type AppSettings = {
  /** Схема по умолчанию для WB. */
  wbFulfilment: Fulfilment;
  /** Схема по умолчанию для Ozon. */
  ozonFulfilment: Fulfilment;
  updatedAt: number;
};

export const DEFAULT_SETTINGS: AppSettings = {
  wbFulfilment: 'fbs',
  ozonFulfilment: 'fbs',
  updatedAt: 0,
};

const FILE = process.env.SETTINGS_FILE || join(process.cwd(), 'av-data', 'settings.json');
let cache: AppSettings | null = null;

export function getSettings(): AppSettings {
  if (cache) return cache;
  try {
    const raw = JSON.parse(readFileSync(FILE, 'utf8')) as Partial<AppSettings>;
    // Разворачиваем поверх умолчаний: файл может быть от прошлой версии и не
    // знать новых полей — это не повод терять остальные настройки.
    cache = { ...DEFAULT_SETTINGS, ...raw };
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      noteSwallowed('settings', 'настройки не прочитаны, работаем на умолчаниях', e);
    }
    cache = { ...DEFAULT_SETTINGS };
  }
  return cache!;
}

export function setSettings(patch: Partial<AppSettings>): AppSettings {
  const next: AppSettings = { ...getSettings(), ...patch, updatedAt: Date.now() };
  cache = next;
  try {
    mkdirSync(join(FILE, '..'), { recursive: true });
    const tmp = `${FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
    renameSync(tmp, FILE);   // атомарно: убитый на записи процесс не побьёт файл
  } catch (e) {
    noteSwallowed('settings', 'настройки не сохранены', e);
  }
  return next;
}
