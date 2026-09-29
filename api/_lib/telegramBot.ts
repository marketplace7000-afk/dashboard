/**
 * Telegram-бот Avto Vibe (без внешних зависимостей — на чистом fetch к Bot API).
 *
 * Принцип: бот НЕ ходит в WB/Ozon напрямую. Все цифры берёт из buildSnapshot()
 * — это серверный снапшот кэша, который наполняет cron. Так бот не жжёт лимиты.
 *
 * Что умеет:
 *  - Раз в день (≈09:00 МСК) шлёт сводку в TELEGRAM_CHAT_ID.
 *  - Отвечает на команды: /report (/отчет), /reviews (/отзывы), /ads (/реклама), /help.
 *
 * Активируется только если задан TELEGRAM_BOT_TOKEN (env на сервере).
 * Запускается из server.ts при старте процесса (long-polling).
 */
import { buildSnapshot, SnapshotContext } from './aiContext';
import { noteSwallowed } from './log';

// api.telegram.org режется с РФ-IP (Timeweb). Если задан TELEGRAM_API_BASE
// (наш Vercel-релей /api/tg-relay) — ходим через него с x-relay-secret.
// Иначе — напрямую (для не-РФ хостов / локального дева).
const DIRECT_BASE = 'https://api.telegram.org';
const RELAY_BASE = (process.env.TELEGRAM_API_BASE || '').trim().replace(/\/+$/, '');
const RELAY_SECRET = (process.env.RELAY_SECRET || '').trim();
const usingRelay = RELAY_BASE.length > 0;
const BASE = usingRelay ? RELAY_BASE : DIRECT_BASE;

const api = (token: string, method: string) => `${BASE}/bot${token}/${method}`;
const relayHeaders = (): Record<string, string> => (usingRelay && RELAY_SECRET ? { 'x-relay-secret': RELAY_SECRET } : {});
const rub = (n: number) => n.toLocaleString('ru-RU') + ' ₽';

/** Отправить сообщение в настроенный TELEGRAM_CHAT_ID (для алертов/уведомлений
 *  из других модулей). No-op, если бот/чат не сконфигурирован. */
export async function notifyChat(text: string): Promise<void> {
  const token = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
  const chatId = (process.env.TELEGRAM_CHAT_ID || '').trim();
  if (!token || !chatId) return;
  await sendMessage(token, chatId, text);
}

// У Telegram жёсткий лимит 4096 символов на сообщение: длинный список (например
// все критичные остатки) не отправился бы ВООБЩЕ. Режем по строкам, чтобы не
// рвать разметку посреди тега.
const TG_LIMIT = 3900;

function splitForTelegram(text: string): string[] {
  if (text.length <= TG_LIMIT) return [text];
  const parts: string[] = [];
  let buf = '';
  for (const line of text.split('\n')) {
    if (buf && buf.length + line.length + 1 > TG_LIMIT) { parts.push(buf); buf = ''; }
    buf = buf ? `${buf}\n${line}` : line;
  }
  if (buf) parts.push(buf);
  return parts;
}

/**
 * Показать «печатает…» в чате.
 *
 * Тяжёлые команды (сводка, трекер, закупки) считают данные ДО первого ответа, и
 * всё это время в чате тишина — кажется, что бот завис (жалоба 03.08). Индикатор
 * набора появляется сразу и держится ~5 секунд, давая мгновенную реакцию. Это не
 * сообщение, а статус, поэтому чат не засоряется. Ошибку глотаем: если не выйдет,
 * просто не будет индикатора.
 */
async function sendTyping(token: string, chatId: string | number): Promise<void> {
  try {
    await fetch(api(token, 'sendChatAction'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...relayHeaders() },
      body: JSON.stringify({ chat_id: chatId, action: 'typing' }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    // Индикатор набора необязателен, но если он падает, то и sendMessage рядом
    // почти наверняка не проходит: полезный ранний признак проблем с Telegram.
    noteSwallowed('tg', 'индикатор набора не отправлен', e, 30 * 60_000);
  }
}

async function sendMessage(token: string, chatId: string | number, text: string): Promise<void> {
  for (const part of splitForTelegram(text)) {
    try {
      await fetch(api(token, 'sendMessage'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...relayHeaders() },
        body: JSON.stringify({ chat_id: chatId, text: part, parse_mode: 'HTML', disable_web_page_preview: true }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (e) {
      console.warn('[tg] sendMessage failed:', (e as Error).message);
    }
  }
}

/**
 * Отправить файл в чат (команда /выгрузка).
 *
 * Telegram принимает файлы только multipart/form-data — JSON тут не годится.
 * Через релей это тоже проходит: релей передаёт тело как есть, но если он вдруг
 * не пропустит multipart, вызывающий покажет понятную ошибку, а не тишину.
 */
async function sendDocument(
  token: string, chatId: string | number,
  filename: string, data: Buffer, caption?: string,
): Promise<void> {
  const form = new FormData();
  form.append('chat_id', String(chatId));
  if (caption) { form.append('caption', caption); form.append('parse_mode', 'HTML'); }
  form.append('document', new Blob([new Uint8Array(data)]), filename);
  const res = await fetch(api(token, 'sendDocument'), {
    method: 'POST',
    headers: relayHeaders(),          // Content-Type проставит FormData сам (boundary)
    body: form,
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`sendDocument → ${res.status} ${(await res.text().catch(() => '')).slice(0, 150)}`);
}

/**
 * Данные выгрузки: то, за чем клиент обычно и лезет в кабинет — реклама по
 * артикулам, удержания и актуальные цены покупателя.
 */
async function buildExportWorkbook(): Promise<{ file: Buffer; summary: string }> {
  const [{ buildXlsx }, ads, pen, prices] = await Promise.all([
    import('./xlsx'),
    import('./agents/adsAdvisor').then(m => m.collectAdsBySku(7)).catch(() => null),
    import('./penalties').then(m => m.getPenalties(30)).catch(() => null),
    import('./ozonBuyerPrices').then(m => m.getOzonBuyerPrices()).catch(() => null),
  ]);

  const sheets = [];
  if (ads?.items?.length) {
    sheets.push({
      name: 'Реклама по артикулам',
      rows: [
        ['Площадка', 'Артикул', 'Категория', 'Расход, ₽', 'Выручка, ₽', 'Заказы', 'ДРР, %', 'Норма ДРР, %', 'ROMI, %'],
        ...ads.items.map(r => [
          r.platform.toUpperCase(), r.sku, r.category ?? '',
          r.spend, r.revenue, r.orders,
          r.drr ?? '', r.norm, r.romi ?? '',
        ]),
      ],
    });
  }
  if (pen?.rows?.length) {
    sheets.push({
      name: 'Штрафы и удержания',
      rows: [
        ['Площадка', 'Вид', 'Что удержали', 'Код операции', 'Операций', 'Сумма, ₽'],
        ...pen.rows.map(r => [
          r.platform.toUpperCase(), r.kind === 'fine' ? 'Штраф' : 'Удержание',
          r.title, r.code ?? '', r.count, r.amount,
        ]),
      ],
    });
  }
  if (prices?.items && Object.keys(prices.items).length) {
    sheets.push({
      name: 'Цены Ozon',
      rows: [
        ['Артикул', 'Цена продавца, ₽', 'Цена покупателя, ₽', 'СПП, %', 'Источник', 'Дата продажи'],
        ...Object.entries(prices.items).map(([offer, p]) => [
          offer, p.price, p.buyer, p.spp,
          p.source === 'postings' ? 'отправления' : 'отчёт реализации',
          p.date ?? '',
        ]),
      ],
    });
  }

  if (!sheets.length) sheets.push({ name: 'Нет данных', rows: [['Данные ещё собираются, попробуйте позже']] });
  return {
    file: buildXlsx(sheets),
    summary: sheets.map(s => `${s.name}: ${Math.max(0, s.rows.length - 1)} строк`).join(' · '),
  };
}

function fmtReport(s: SnapshotContext): string {
  const L: string[] = [];
  L.push(`<b>📊 Avto Vibe · сводка</b>`);
  L.push(`<i>данные за ${s.period.begin} → ${s.period.end}</i>`);
  L.push('');
  if (s.ozon) {
    L.push(`<b>Ozon (неделя)</b>${s.ozonStaleFrom ? ` <i>(на ${s.ozonStaleFrom})</i>` : ''}`);
    L.push(`• Выручка: ${rub(s.ozon.revenue)}`);
    L.push(`• Заказы: ${s.ozon.orders} · чек ${rub(s.ozon.avgCheck)}`);
    L.push(`• Товаров: ${s.ozon.productsCount}`);
  } else {
    L.push(`<b>Ozon</b> — данные ещё прогреваются`);
  }
  L.push('');
  if (s.wb) {
    L.push(`<b>Wildberries (неделя)</b>${s.wbStaleFrom ? ` <i>(на ${s.wbStaleFrom})</i>` : ''}`);
    L.push(`• Выручка: ${rub(s.wb.revenueWeek)}`);
    L.push(`• Заказы: ${s.wb.ordersWeek} · чек ${rub(s.wb.avgCheckWeek)}`);
    L.push(`• Карточек с продажами: ${s.wb.productsCount}`);
  } else {
    L.push(`<b>Wildberries</b> — данные ещё прогреваются (лимит WB)`);
  }
  if (s.topProducts.length) {
    L.push('');
    L.push(`<b>Топ-5 по выручке</b>`);
    for (const p of s.topProducts.slice(0, 5)) {
      L.push(`• [${p.mp.toUpperCase()}] ${p.name} — ${rub(p.revenue ?? 0)}`);
    }
  }
  if (s.reviews) {
    L.push('');
    L.push(`<b>Отзывы WB:</b> неотвеченных ${s.reviews.unanswered}, в архиве ${s.reviews.archive}`);
  }
  if (s.questions) {
    L.push(`<b>Вопросы WB:</b> без ответа ${s.questions.unanswered}`);
  }
  if (s.ads) {
    L.push(`<b>Реклама WB:</b> кампаний ${s.ads.wbTotal}, активных ${s.ads.wbActive}`);
  }
  L.push('');
  L.push(`<i>Команды: /report · /reviews · /ads · /help</i>`);
  return L.join('\n');
}

function fmtReviews(s: SnapshotContext): string {
  if (!s.reviews) return 'Данные по отзывам ещё прогреваются.';
  const L: string[] = [`<b>📝 Отзывы WB</b>`, `Неотвеченных: <b>${s.reviews.unanswered}</b> · в архиве: ${s.reviews.archive}`, ''];
  for (const r of s.reviews.recent.slice(0, 6)) {
    L.push(`${'⭐'.repeat(Math.max(1, Math.min(5, r.rating)))} «${r.text.slice(0, 140)}»${r.product ? ` — ${r.product}` : ''}`);
  }
  return L.join('\n');
}

function fmtAds(s: SnapshotContext): string {
  if (!s.ads) return 'Данные по рекламе ещё прогреваются (лимит рекламного API WB).';
  return `<b>📣 Реклама WB</b>\nКампаний: ${s.ads.wbTotal}\nАктивных: ${s.ads.wbActive}`;
}

const HELP = [
  '<b>Avto Vibe · бот</b>',
  'Команды:',
  '/report — сводка по продажам (Ozon + WB)',
  '/reviews — отзывы WB',
  '/ads — реклама WB',
  '/alerts — проверить пороги сейчас (остатки, отзывы)',
  '/штрафы — штрафы и удержания площадок за 30 дней',
  '/выгрузка — Excel-файл: реклама по артикулам, удержания, цены',
  '/юнитка &lt;артикул&gt; — юнит-экономика товара: цена, комиссия, логистика, реклама',
  '/закупки — аудит закупок: что пора пополнять',
  '/трекер — сроки этапов поставок',
  '/реклама-анализ — проверка рекламы по сценариям специалистов',
  '/нормы — фактический ДРР по категориям (основа норм)',
  '/юрист &lt;вопрос&gt; — справка по налогам и договорам МП',
  '/изменения — сверить тарифы, комиссии и новости WB и Ozon',
  '/новости — проверить, читаются ли каналы площадок',
  '/help — эта подсказка',
  '',
  'Раз в день в 09:00 МСК присылаю сводку автоматически.',
].join('\n');

/**
 * Обработать входящий update от Telegram (режим webhook).
 *
 * Зачем webhook: при long-polling бот держит непрерывный запрос через релей на
 * Vercel — это 2 вызова функции в минуту круглосуточно, около 1400 за 12 часов
 * (замечено 01.08 по расходу Vercel). При webhook вызовов ровно столько, сколько
 * реальных сообщений, то есть единицы в день.
 */

// ─── Кому бот вообще должен отвечать ────────────────────────────────────────
// 01.09 бота добавили в рабочий чат клиента, и он отвечал НА КАЖДОЕ сообщение —
// разговаривать в группе стало невозможно. Причина была в том, что проверки не
// было вовсе: любой текст из любого чата уходил в обработчик команд, а ответ
// летел туда же, откуда пришёл. `TELEGRAM_CHAT_ID` тут ни при чём — он задаёт
// только адрес дневной сводки, которую бот шлёт по своей инициативе.
//
// Правило теперь такое:
//   • в личке отвечаем на любой текст — там это и есть ожидаемое поведение;
//   • в группе только на явное обращение: команда со слэша, упоминание бота
//     или ответ на его сообщение.
//
// Отдельно в BotFather стоит вернуть режим приватности (/setprivacy → Enable):
// тогда Telegram вообще перестанет присылать боту чужие сообщения. Проверка
// ниже — вторая линия обороны, она работает независимо от той настройки.

/**
 * Имя бота (@username) — по нему ловим упоминания в группах.
 *
 * Узнаём из getMe при старте опроса, но читаем ЛЕНИВО с запасным вариантом из
 * env: на пути через вебхук getMe может не успеть отработать, и без запасного
 * значения бот перестал бы отзываться на упоминания — то есть в группе не
 * реагировал бы вообще ни на что, кроме команд.
 */
let botUsername = '';
function knownBotUsername(): string {
  return botUsername || (process.env.TELEGRAM_BOT_USERNAME || '').trim().replace(/^@/, '');
}

/**
 * Текст для обработки или null, если сообщение боту не адресовано.
 * Упоминание из текста вырезаем: «@bot цены» должно работать как «цены».
 */
export function messageForBot(msg: any): string | null {
  const text = String(msg?.text ?? '').trim();
  if (!text) return null;
  const type = String(msg?.chat?.type ?? '');
  if (type === 'private') return text;

  if (text.startsWith('/')) return text;

  const me = knownBotUsername();
  if (me) {
    const at = new RegExp(`@${me}\\b`, 'i');
    if (at.test(text)) return text.replace(at, ' ').trim() || '/help';
  }

  // Ответ на сообщение бота — тоже обращение к нему.
  const replyTo = msg?.reply_to_message?.from;
  if (replyTo?.is_bot && (!me || String(replyTo.username ?? '').toLowerCase() === me.toLowerCase())) {
    return text;
  }
  return null;
}

export async function handleTelegramUpdate(update: any): Promise<void> {
  const token = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
  if (!token) return;
  const msg = update?.message;
  if (!msg?.chat?.id) return;
  const text = messageForBot(msg);
  if (text) await handleCommand(token, msg.chat.id, text);
}

async function handleCommand(token: string, chatId: number, text: string): Promise<void> {
  const cmd = text.toLowerCase().replace(/^\//, '').split(/[\s@]/)[0];
  // «Печатает…» сразу — чтобы команда с тяжёлым расчётом не выглядела зависшей.
  // help/start отвечают мгновенно, им индикатор не нужен.
  if (cmd !== 'start' && cmd !== 'help') void sendTyping(token, chatId);
  if (cmd === 'start' || cmd === 'help') { await sendMessage(token, chatId, HELP); return; }
  if (['alerts', 'алерты', 'пороги'].includes(cmd)) {
    try {
      const { collectAlerts, markAlertsSent } = await import('./alerts');
      const list = await collectAlerts();
      await sendMessage(token, chatId, list.length
        ? '⚠️ <b>Алерты:</b>\n\n' + list.map(a => a.text).join('\n\n')
        : '✅ Порогов не нарушено — критичных остатков и просроченных отзывов нет.');
      // Помечаем показанное отправленным, иначе почасовая авто-проверка через
      // минуту пришлёт то же самое второй раз (жалоба 30.07).
      await markAlertsSent(list);
    } catch { await sendMessage(token, chatId, 'Не удалось проверить пороги.'); }
    return;
  }
  if (['юнитка', 'unit', 'экономика'].includes(cmd)) {
    const arg = text.replace(/^\/\S+\s*/, '').trim();
    try {
      const { unitEconomics } = await import('./botChat');
      await sendMessage(token, chatId, await unitEconomics(arg));
    } catch (e) {
      await sendMessage(token, chatId, `Не удалось посчитать юнитку: ${(e as Error).message.slice(0, 150)}`);
    }
    return;
  }
  if (['выгрузка', 'excel', 'xlsx', 'export'].includes(cmd)) {
    await sendMessage(token, chatId, '📗 Собираю выгрузку…');
    try {
      const { file, summary } = await buildExportWorkbook();
      const stamp = new Date().toISOString().slice(0, 10);
      await sendDocument(token, chatId, `avto-vibe-${stamp}.xlsx`, file,
        `📗 <b>Выгрузка ${stamp}</b>\n<i>${summary}</i>`);
    } catch (e) {
      await sendMessage(token, chatId, `Не удалось отправить выгрузку: ${(e as Error).message.slice(0, 200)}`);
    }
    return;
  }
  if (['штрафы', 'удержания', 'penalties'].includes(cmd)) {
    try {
      const { getPenalties, formatPenalties } = await import('./penalties');
      await sendMessage(token, chatId, formatPenalties(await getPenalties(30)));
    } catch { await sendMessage(token, chatId, 'Не удалось получить штрафы и удержания.'); }
    return;
  }
  if (['юрист', 'legal', 'налоги'].includes(cmd)) {
    // Вопрос — всё после команды. Без вопроса объясняем, как пользоваться.
    const question = text.replace(/^\/\S+\s*/, '').trim();
    if (!question) {
      await sendMessage(token, chatId, 'Задайте вопрос после команды.\nНапример: <code>/юрист какой НДС при УСН на маркетплейсах в 2026?</code>');
      return;
    }
    await sendMessage(token, chatId, '⚖️ Изучаю вопрос…');
    try {
      const { askLegal } = await import('./agents/legalAdvisor');
      await sendMessage(token, chatId, await askLegal(question));
    } catch (e) {
      await sendMessage(token, chatId, `Не удалось получить ответ: ${(e as Error).message.slice(0, 200)}`);
    }
    return;
  }
  if (['изменения', 'changes', 'тарифы'].includes(cmd)) {
    await sendMessage(token, chatId, '🔎 Сверяю тарифы, комиссии и новости МП…');
    try {
      const { runAgentById } = await import('./agents');
      const send = (t: string) => sendMessage(token, chatId, t);
      await runAgentById('wb-changes', send);
      await runAgentById('ozon-changes', send);
      await runAgentById('wb-news', send);
      await runAgentById('ozon-news', send);
    } catch { await sendMessage(token, chatId, 'Не удалось проверить изменения.'); }
    return;
  }
  if (['новости', 'news'].includes(cmd)) {
    // Показываем САМИ новости, а не только диагностику источников: раньше команда
    // отвечала «видим N постов», и это сбивало с толку (правка 30.07).
    // Состояние каналов остаётся внизу, оно нужно, если Telegram сменит вёрстку.
    await sendMessage(token, chatId, '📰 Смотрю новости площадок…');
    try {
      const { runAgentById } = await import('./agents');
      const send = (t: string) => sendMessage(token, chatId, t);
      await runAgentById('wb-news', send);
      await runAgentById('ozon-news', send);
      const { probeChannels } = await import('./agents/mpNews');
      await sendMessage(token, chatId, `<i>Источники: ${(await probeChannels()).replace(/\n/g, ' · ')}</i>`);
    } catch { await sendMessage(token, chatId, 'Не удалось получить новости.'); }
    return;
  }
  if (['реклама-анализ', 'ads-check', 'проверь-рекламу'].includes(cmd)) {
    await sendMessage(token, chatId, '📣 Проверяю рекламу по сценариям специалистов…');
    try {
      // Честный отчёт: различает «нет данных», «проверено, чисто» и список
      // находок. Общий runAgentById слал бы «замечаний нет» и при пустых данных.
      const { runAdsAnalysisManual } = await import('./agents/adsAdvisor');
      await runAdsAnalysisManual((t) => sendMessage(token, chatId, t));
    } catch { await sendMessage(token, chatId, 'Не удалось проверить рекламу.'); }
    return;
  }
  if (['нормы', 'дрр', 'нормы-дрр'].includes(cmd)) {
    try {
      const { categoryDrrReport } = await import('./agents/adsAdvisor');
      await sendMessage(token, chatId, await categoryDrrReport());
    } catch { await sendMessage(token, chatId, 'Не удалось посчитать ДРР по категориям.'); }
    return;
  }
  if (['трекер', 'поставки', 'tracker'].includes(cmd)) {
    try {
      const { runAgentById } = await import('./agents');
      await runAgentById('supply-tracker', (t) => sendMessage(token, chatId, t));
    } catch { await sendMessage(token, chatId, 'Не удалось проверить трекер.'); }
    return;
  }
  if (['закупки', 'procurement', 'закупка'].includes(cmd)) {
    try {
      const { runAgentById } = await import('./agents');
      await runAgentById('procurement-audit', (t) => sendMessage(token, chatId, t));
    } catch { await sendMessage(token, chatId, 'Не удалось проверить закупки.'); }
    return;
  }
  const snap = await buildSnapshot().catch(() => null);
  if (!snap) { await sendMessage(token, chatId, 'Данные временно недоступны, попробуйте позже.'); return; }
  if (['report', 'отчет', 'отчёт', 'revenue', 'выручка', 'сводка'].includes(cmd)) await sendMessage(token, chatId, fmtReport(snap));
  else if (['reviews', 'отзывы'].includes(cmd)) await sendMessage(token, chatId, fmtReviews(snap));
  else if (['ads', 'реклама'].includes(cmd)) await sendMessage(token, chatId, fmtAds(snap));
  else if (text.startsWith('/')) await sendMessage(token, chatId, 'Не понял команду. /help — список.');
  else {
    // Не команда — значит вопрос ИИ-аналитику (клиент 05.08 просил продублировать
    // чат из дашборда в бота). Команды остаются главнее: сюда попадает только то,
    // что не начинается со слэша.
    try {
      const { botAsk } = await import('./botChat');
      await sendMessage(token, chatId, await botAsk(text));
    } catch (e) {
      await sendMessage(token, chatId, `ИИ-аналитик недоступен: ${(e as Error).message.slice(0, 150)}`);
    }
  }
}

let started = false;

export function startTelegramBot(): void {
  if (started) return;
  const token = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
  if (!token) { console.log('[tg] TELEGRAM_BOT_TOKEN не задан — бот выключен'); return; }
  started = true;
  const chatId = (process.env.TELEGRAM_CHAT_ID || '').trim();
  const transport = usingRelay ? `через релей ${RELAY_BASE}` : 'напрямую (api.telegram.org)';
  console.log(`[tg] бот запущен (long-polling, ${transport})` + (chatId ? `, дневная сводка в чат ${chatId}` : ', chat_id не задан — дневная сводка выключена'));

  // ── проверка связи и токена при старте ──
  // Без неё бот «молчит» без объяснений: opros ниже глотал любые ошибки, и
  // непонятно, дело в токене, в блокировке api.telegram.org с РФ-IP или в том,
  // что тем же токеном уже опрашивает другой процесс.
  void (async () => {
    try {
      const r = await fetch(api(token, 'getMe'), { headers: relayHeaders(), signal: AbortSignal.timeout(20_000) });
      const j = await r.json().catch(() => null) as any;
      if (j?.ok) {
        // Запоминаем имя: по нему ловим упоминания в группах (см. messageForBot).
        if (j.result?.username) botUsername = String(j.result.username);
        console.log(`[tg] связь есть, бот @${j.result?.username ?? '—'}`);
      }
      else console.warn(`[tg] getMe вернул ошибку: ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
    } catch (e) {
      console.warn(`[tg] НЕТ СВЯЗИ с Telegram (${transport}): ${(e as Error).message}. ` +
        'С РФ-IP api.telegram.org блокируется — нужен TELEGRAM_API_BASE (релей).');
    }
  })();

  // ── webhook вместо опроса ──────────────────────────────────────────────────
  // При long-polling бот держал непрерывный запрос через релей на Vercel: около
  // двух вызовов функции в минуту круглосуточно (~1400 за 12 часов, замечено по
  // расходу 01.08). С webhook Telegram сам присылает сообщения на наш сервер, и
  // вызовов ровно столько, сколько реальных сообщений.
  // Включается, если задан PUBLIC_URL. Если регистрация не удалась — молча
  // возвращаемся к опросу, чтобы бот не остался немым.
  // Вебхук ОТКЛЮЧЁН по умолчанию: серверы Telegram (за границей) не могут
  // стабильно подключиться к российскому серверу — getWebhookInfo показал
  // «Connection timed out» (03.08). Это зеркало блокировки исходящих: наружу
  // api.telegram.org режется, внутрь Telegram не пробивается. Поэтому надёжен
  // только опрос: бот сам ходит за сообщениями через релей. Вебхук оставлен
  // как опция на случай переезда на не-РФ хост — включается TELEGRAM_USE_WEBHOOK=1.
  const useWebhook = /^(1|true|yes)$/i.test((process.env.TELEGRAM_USE_WEBHOOK || '').trim());
  const publicUrl = (process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
  const hookSecret = (process.env.TELEGRAM_WEBHOOK_SECRET || process.env.RELAY_SECRET || '').trim();
  let webhookOk = false;

  const setupWebhook = async (): Promise<boolean> => {
    if (!useWebhook || !publicUrl || !hookSecret) return false;
    try {
      const r = await fetch(api(token, 'setWebhook'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...relayHeaders() },
        body: JSON.stringify({
          url: `${publicUrl}/api/tg-webhook`,
          secret_token: hookSecret,
          allowed_updates: ['message'],
          drop_pending_updates: false,
        }),
        signal: AbortSignal.timeout(20_000),
      });
      const j = await r.json().catch(() => null) as any;
      if (j?.ok) {
        console.log(`[tg] webhook включён: ${publicUrl}/api/tg-webhook (опрос выключен)`);
        return true;
      }
      console.warn(`[tg] setWebhook не удался: ${JSON.stringify(j).slice(0, 200)} — остаёмся на опросе`);
    } catch (e) {
      console.warn(`[tg] setWebhook ошибка: ${(e as Error).message} — остаёмся на опросе`);
    }
    return false;
  };

  // ── опрос (основной режим, webhook до РФ-сервера не доходит) ──
  //
  // Раньше здесь стоял timeout=50 из соображения «меньше вызовов — дешевле».
  // Это было неверно: Vercel считает GB-ЧАСЫ, а не вызовы. Запрос, висящий 50
  // секунд, держит функцию открытой все 50 секунд — сутки такого опроса дают
  // почти сутки оплачиваемого времени. Отсюда и 47 GB-часов, из-за которых бота
  // пришлось выключить совсем.
  //
  // Теперь наоборот: короткий запрос (без удержания) раз в 20 секунд. Каждый
  // вызов живёт доли секунды, за сутки набегают минуты вместо часов. Плата —
  // ответ бота может прийти на несколько секунд позже; для сводок и команд это
  // незаметно. Оба параметра можно переопределить через env.
  const POLL_TIMEOUT = Number(process.env.TELEGRAM_POLL_TIMEOUT ?? 0);
  const POLL_INTERVAL_MS = Math.max(2_000, Number(process.env.TELEGRAM_POLL_INTERVAL_MS ?? 20_000));
  let offset = 0;
  let failStreak = 0;
  const poll = async () => {
    if (webhookOk) return;   // webhook включён — опрашивать нельзя, будет 409
    try {
      const r = await fetch(api(token, 'getUpdates') + `?offset=${offset}&timeout=${POLL_TIMEOUT}`, { headers: relayHeaders(), signal: AbortSignal.timeout((POLL_TIMEOUT + 15) * 1000) });
      const j = await r.json() as { ok: boolean; result?: any[]; description?: string; error_code?: number };
      // Telegram отвечает 200 с ok:false — это не ловится обычным catch.
      // Частые случаи: 401 (токен неверный/отозван), 409 (тем же токеном уже
      // опрашивает другой процесс или висит webhook).
      if (!j.ok) {
        if (failStreak === 0 || failStreak % 60 === 0) {
          console.warn(`[tg] getUpdates отказ: ${j.error_code ?? r.status} ${j.description ?? ''}`.trim());
        }
        failStreak++;
        setTimeout(poll, 5_000);
        return;
      }
      if (failStreak) { console.log('[tg] связь восстановлена'); failStreak = 0; }
      for (const u of (j.result || [])) {
        offset = (u.update_id as number) + 1;
        const msg = u.message;
        if (!msg?.chat?.id) continue;
        const text = messageForBot(msg);
        if (text) await handleCommand(token, msg.chat.id, text);
      }
    } catch (e) {
      // Сеть/блокировка. Логируем первую ошибку и далее редко, чтобы не залить лог.
      if (failStreak === 0 || failStreak % 60 === 0) {
        console.warn(`[tg] опрос не удался (${transport}): ${(e as Error).message}`);
      }
      failStreak++;
    }
    setTimeout(poll, failStreak ? 5_000 : POLL_INTERVAL_MS);
  };

  // Сначала пробуем webhook; опрос запускаем только если он не завёлся.
  void (async () => {
    webhookOk = await setupWebhook();
    if (!webhookOk) {
      // Снимаем возможный старый webhook, иначе getUpdates будет отвечать 409.
      try {
        await fetch(api(token, 'deleteWebhook'), { method: 'POST', headers: relayHeaders(), signal: AbortSignal.timeout(15_000) });
      } catch (e) {
        noteSwallowed('tg', 'старый webhook не снят перед опросом', e);
      }
      console.log(`[tg] режим опроса: каждые ${Math.round(POLL_INTERVAL_MS / 1000)}с, удержание ${POLL_TIMEOUT}с` +
        ` (~${Math.round(86_400_000 / POLL_INTERVAL_MS)} запросов в сутки)`);
      poll();
    }
  })();


  // ── дневная сводка ≈09:00 МСК (один раз в день) ──
  // Отметку о вчерашней отправке храним в дисковом кэше, а не в памяти: иначе
  // после каждого деплоя в том же часу сводка уходила повторно.
  setInterval(async () => {
    if (!chatId) return;
    const now = new Date();
    const mskHour = (now.getUTCHours() + 3) % 24;
    const dateKey = now.toISOString().slice(0, 10);
    if (mskHour !== 9) return;
    try {
      const { cacheGet, cacheSet } = await import('./cache');
      const KEY = 'tg-daily-report-sent';
      const prev = await cacheGet<{ date: string }>(KEY);
      if (prev?.data?.date === dateKey) return;        // сегодня уже отправляли
      await cacheSet(KEY, { date: dateKey }, 26 * 60 * 60_000);
      const snap = await buildSnapshot();
      await sendMessage(token, chatId, fmtReport(snap));
    } catch (e) {
      console.warn('[tg] daily report failed:', (e as Error).message);
    }
  }, 60_000);

  // ── push-алерты: проверяем пороги раз в час (дедуп внутри — не спамит) ──
  if (chatId) {
    const checkAlerts = async () => {
      try {
        const { runAlertsAndNotify } = await import('./alerts');
        const n = await runAlertsAndNotify((text) => sendMessage(token, chatId, text));
        if (n) console.log(`[alerts] отправлено ${n}`);
      } catch (e) { console.warn('[alerts] ошибка:', (e as Error).message); }
    };
    // Первую проверку делаем НЕ сразу: при деплое сервис перезапускается по
    // несколько раз подряд, и алерты прилетали через минуту после каждого
    // рестарта (жалоба 30.07 — два одинаковых сообщения с разницей 18 минут).
    setTimeout(checkAlerts, 15 * 60_000);
    setInterval(checkAlerts, 60 * 60_000);  // далее раз в час

    // Дедуп живёт в SQLite (node:sqlite, нужен Node 22.5+). Если хранилище
    // недоступно, повторы НЕ отсекаются и одно и то же будет приходить каждый
    // час — поэтому говорим об этом прямо, а не молчим.
    void import('./history').then(h => {
      if (!h.historyEnabled?.()) {
        console.warn('[alerts] ВНИМАНИЕ: хранилище дедупа недоступно (node:sqlite). ' +
          'Одинаковые алерты будут повторяться. Проверьте версию Node (нужна 22.5+) и права на папку кэша.');
      }
    }).catch(() => {});

    // ── фоновые агенты: почасовые и суточные (дедуп внутри раннера) ──
    const send = (text: string) => sendMessage(token, chatId, text);
    const runHourly = async () => {
      try {
        const { runAgents } = await import('./agents');
        const n = await runAgents('hourly', send);
        if (n) console.log(`[agents] hourly: отправлено ${n}`);
      } catch (e) { console.warn('[agents] hourly ошибка:', (e as Error).message); }
    };
    setTimeout(runHourly, 90_000);
    setInterval(runHourly, 60 * 60_000);

    // Суточные агенты — вместе с утренней сводкой (10:00 МСК, после неё).
    // Отметку «сегодня уже запускали» держим в ДИСКОВОМ кэше, а не в памяти:
    // при деплое процесс перезапускается, память обнуляется, и агенты стартовали
    // повторно в том же часу (жалоба 31.07 — повтор в 10:17 после запуска в 10:00).
    setInterval(async () => {
      const now = new Date();
      const mskHour = (now.getUTCHours() + 3) % 24;
      const dateKey = now.toISOString().slice(0, 10);
      if (mskHour !== 10) return;
      try {
        const { cacheGet, cacheSet } = await import('./cache');
        const KEY = 'agents-daily-ran';
        const prev = await cacheGet<{ date: string }>(KEY);
        if (prev?.data?.date === dateKey) return;      // уже запускали сегодня
        await cacheSet(KEY, { date: dateKey }, 26 * 60 * 60_000);
        const { runAgents } = await import('./agents');
        const n = await runAgents('daily', send);
        if (n) console.log(`[agents] daily: отправлено ${n}`);
      } catch (e) { console.warn('[agents] daily ошибка:', (e as Error).message); }
    }, 60_000);
  }
}
