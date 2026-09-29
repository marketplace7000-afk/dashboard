/**
 * Агент 3 — «Трекер поставок».
 *
 * Следит за таблицей Supply_Tracker и напоминает, когда подходит срок этапа:
 * оплата → изготовление → сдача в карго → Китай-Москва → Москва-Уфа → Уфа.
 *
 * Методика от Александра (созвон 31.07): за 5 дней до срока предупредить, за 2
 * дня напоминать настойчивее, просрочку показывать отдельно и первой. Таблица
 * САМА считает колонку «Дней до след. этапа», поэтому агент её просто читает —
 * не дублируем расчёт, который может разойтись с тем, что видят люди.
 *
 * Доступ: таблица открыта по ссылке (Александр прислал 03.08), поэтому читаем её
 * штатной выгрузкой Google в CSV — без Apps Script и токена. ID таблицы и gid
 * вкладки заданы ниже и переопределяются через env, если таблицу заменят.
 */
import { Agent, AgentMessage, mskDay } from './types';

// Пороги из методики. Меняются через env, если процесс поменяется.
const WARN_DAYS = Number(process.env.AGENT_TRACKER_WARN_DAYS) || 5;
const URGENT_DAYS = Number(process.env.AGENT_TRACKER_URGENT_DAYS) || 2;

// Таблица Supply_Tracker, вкладка Tracker (gid из ссылки Александра).
const SHEET_ID = (process.env.SUPPLY_TRACKER_SHEET_ID || '1cdIpSwyMtSoaLJlCFRijG-XK8iEQ9x-HBQg-uF6XSvg').trim();
const SHEET_GID = (process.env.SUPPLY_TRACKER_GID || '734025691').trim();

type Row = {
  order: string;
  name: string;
  status: string;
  nextStage: string;
  nextDate: string;
  daysLeft: number;
};

const clean = (v: any) => String(v ?? '').trim();

/**
 * Разбор CSV в строки ячеек. Нужен свой, а не split(','): в заголовках есть
 * запятые внутри кавычек («Срок изгот., дн»), простой split их порвал бы.
 * Поддерживает кавычки, экранированные кавычки ("") и переносы строк в ячейке.
 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else inQuotes = false;
      } else cell += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(cell); cell = '';
    } else if (c === '\n') {
      row.push(cell); rows.push(row); row = []; cell = '';
    } else if (c !== '\r') {
      cell += c;
    }
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

/**
 * Читает вкладку Tracker штатной выгрузкой Google в CSV. Таблица открыта по
 * ссылке, поэтому ни Apps Script, ни токен не нужны. Google отвечает редиректом
 * на googleusercontent — fetch идёт за ним сам (redirect: follow по умолчанию).
 */
async function fetchTracker(): Promise<string[][]> {
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${SHEET_GID}`;
  try {
    const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(30_000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const text = await r.text();
    // Если доступ закрыли — Google отдаёт HTML страницы входа, а не CSV.
    if (/^\s*</.test(text) || /<html/i.test(text.slice(0, 200))) {
      throw new Error('таблица недоступна по ссылке (нужен доступ «просмотр по ссылке»)');
    }
    return parseCsv(text);
  } catch (e) {
    console.warn('[agent3] трекер недоступен:', (e as Error).message);
    return [];
  }
}

/**
 * Разбор строк. Колонки ищем ПО ЗАГОЛОВКУ, а не по буквам: в таблицу regularly
 * добавляют столбцы, и жёсткие индексы сломались бы при первом же изменении.
 */
function parseRows(data: any[][]): Row[] {
  if (data.length < 2) return [];
  const head = (data[0] ?? []).map(h => clean(h).toLowerCase());
  const col = (...pats: RegExp[]) => head.findIndex(h => pats.some(p => p.test(h)));

  const cOrder = col(/^заказ/);
  const cName = col(/^назван/);
  const cStatus = col(/^статус/);
  const cNext = col(/следующий этап/);
  const cNextDate = col(/дата след/);
  const cDays = col(/дней до след/);
  if (cDays < 0) {
    console.warn('[agent3] в таблице нет колонки «Дней до след. этапа»');
    return [];
  }

  const out: Row[] = [];
  for (let i = 1; i < data.length; i++) {
    const r = data[i] ?? [];
    const raw = clean(r[cDays]);
    if (raw === '') continue;                       // этап не запланирован
    const daysLeft = Number(raw.replace(',', '.'));
    if (!Number.isFinite(daysLeft)) continue;
    const status = cStatus >= 0 ? clean(r[cStatus]) : '';
    // Доставленные заказы больше не ведём.
    if (/доставлен/i.test(status)) continue;
    out.push({
      order: cOrder >= 0 ? clean(r[cOrder]) : '',
      name: cName >= 0 ? clean(r[cName]) : '',
      status,
      nextStage: cNext >= 0 ? clean(r[cNext]) : '',
      nextDate: cNextDate >= 0 ? clean(r[cNextDate]) : '',
      daysLeft,
    });
  }
  return out;
}

function fmt(r: Row): string {
  const what = [r.order && `№${r.order}`, r.name].filter(Boolean).join(' ');
  const stage = r.nextStage ? ` → <b>${r.nextStage}</b>` : '';
  const date = r.nextDate ? ` до ${r.nextDate}` : '';
  return `• ${what}${stage}${date}`;
}

async function run(): Promise<AgentMessage[]> {
  const rows = parseRows(await fetchTracker());
  if (!rows.length) return [];

  const overdue = rows.filter(r => r.daysLeft < 0).sort((a, b) => a.daysLeft - b.daysLeft);
  const urgent = rows.filter(r => r.daysLeft >= 0 && r.daysLeft <= URGENT_DAYS).sort((a, b) => a.daysLeft - b.daysLeft);
  const soon = rows.filter(r => r.daysLeft > URGENT_DAYS && r.daysLeft <= WARN_DAYS).sort((a, b) => a.daysLeft - b.daysLeft);
  if (!overdue.length && !urgent.length && !soon.length) return [];

  const parts: string[] = ['📋 <b>Трекер поставок</b>'];
  if (overdue.length) {
    parts.push(`\n🔴 <b>Просрочено (${overdue.length})</b>`);
    parts.push(...overdue.map(r => `${fmt(r)} — просрочка ${Math.abs(r.daysLeft)} дн`));
  }
  if (urgent.length) {
    parts.push(`\n🟠 <b>Срок на днях (${urgent.length})</b>`);
    parts.push(...urgent.map(r => `${fmt(r)} — осталось ${r.daysLeft} дн`));
  }
  if (soon.length) {
    parts.push(`\n🟡 <b>Скоро срок (${soon.length})</b>`);
    parts.push(...soon.map(r => `${fmt(r)} — осталось ${r.daysLeft} дн`));
  }
  parts.push('\nПроверьте статус у поставщика и обновите этап в таблице.');

  // Ключ включает состав списка: если ничего не изменилось, повтор не уйдёт,
  // а как только появится новая просрочка — сообщение придёт сразу.
  const sig = [...overdue, ...urgent].map(r => `${r.order}:${r.daysLeft}`).join(',');
  return [{ key: `agent3:tracker:${mskDay()}:${sig.slice(0, 200)}`, text: parts.join('\n') }];
}

export const supplyTrackerAgent: Agent = {
  id: 'supply-tracker',
  name: 'Агент 3 · Трекер поставок',
  role: 'Напоминает о подходящих сроках этапов поставки по таблице Supply_Tracker',
  schedule: 'daily',
  run,
};
