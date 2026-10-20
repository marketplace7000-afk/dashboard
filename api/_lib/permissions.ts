/**
 * Права разделов на сервере.
 *
 * Галочки разделов в «Доступах» раньше только прятали пункты меню: сервер
 * различал «весь кабинет» и «только Склад», поэтому менеджер с одними
 * «Отзывами» мог напрямую вызвать /api/ads2/action и поменять ставки, или
 * через прокси Ozon — цены (прожарка 20.10.2026).
 *
 * Правило: владелец может всё. Остальным
 *   - ИЗМЕНЕНИЯ (POST/PUT/PATCH/DELETE) — только в разделах, которые им открыты;
 *   - чтение — открыто по-прежнему, кроме разделов с личными данными покупателей
 *     (отзывы, чаты) и пульта агентов: их видно только с нужной галочкой;
 *   - запись в кабинеты площадок через прокси /wb, /ozon, /ozon-perf — только
 *     владельцу: интерфейс сотрудников такие запросы не шлёт вовсе.
 * Чтения у площадок Ozon часто идут методом POST (v1/analytics/data и т.п.),
 * поэтому в прокси POST считаем записью по словам в пути; PUT/PATCH/DELETE — всегда.
 */
import type { AuthUser, Section } from './sklad/users';

export type Denied = { reason: string };

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Путь прокси, который меняет что-то в кабинете площадки. */
const PROXY_WRITE = /(^|\/)(import|upload|update|set|delete|remove|archive|unarchive|activate|deactivate|start|pause|stop|answer|send|create|edit|budget|bids?|cpm|save|apply|cancel)(\/|$|[-_?])/i;

/** Какие разделы дают право на изменения в секции API. null — запись свободна всем, кто вошёл. */
function writeSections(section: string, sub: string): Section[] | null | 'owner' {
  switch (section) {
    case 'ads2':
      if (sub === 'competitors') return ['competitors', 'ads'];
      if (sub === 'signals') return ['rnp', 'prices', 'ads'];
      return ['ads'];
    case 'ads-advisor':
      return ['ads'];
    case 'repricer':
      return ['prices'];
    case 'costs': case 'settings':
      return ['settings'];
    case 'rnp':
      return ['rnp'];
    case 'agents':
      return ['collectors'];
    case 'reviews': case 'wb-answer':
      return ['reviews', 'chats'];
    case 'wb': case 'ozon': case 'ozon-perf':
      return 'owner';
    default:
      return null;     // ui-state, ai-чат и прочее общее
  }
}

/** Какие разделы нужны, чтобы читать секцию. null — читать может любой, кто вошёл. */
function readSections(section: string): Section[] | null {
  switch (section) {
    case 'reviews': return ['reviews', 'chats', 'collectors'];
    case 'agents': return ['collectors'];
    default: return null;
  }
}

/**
 * Можно ли этому пользователю сделать запрос. `rest` — путь после секции
 * (для прокси — путь у площадки). Возвращает причину отказа или null.
 */
export function checkSectionAccess(user: AuthUser, section: string, rest: string[], method: string): Denied | null {
  if (user.role === 'owner') return null;
  const has = (list: Section[]) => list.some(s => user.sections.includes(s));
  const m = method.toUpperCase();

  if (section === 'wb' || section === 'ozon' || section === 'ozon-perf') {
    // У WB первый сегмент — scope (prices, promotion…), сам путь дальше.
    const path = (section === 'wb' ? rest.slice(1) : rest).join('/');
    if (m === 'PUT' || m === 'PATCH' || m === 'DELETE' || (m === 'POST' && PROXY_WRITE.test(path))) {
      return { reason: 'Изменения в кабинете площадки доступны только владельцу' };
    }
    return null;
  }

  if (WRITE_METHODS.has(m)) {
    const need = writeSections(section, rest[0] ?? '');
    if (need === 'owner') return { reason: 'Доступно только владельцу' };
    if (need && !has(need)) return { reason: 'Нет доступа к этому разделу — попросите владельца открыть его в «Доступах»' };
    return null;
  }

  const need = readSections(section);
  if (need && !has(need)) return { reason: 'Нет доступа к этому разделу — попросите владельца открыть его в «Доступах»' };
  return null;
}
