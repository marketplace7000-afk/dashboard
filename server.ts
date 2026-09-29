/**
 * Production-сервер для self-hosted деплоя (Timeweb / любой Linux VM).
 *
 * Зачем: на Vercel WB seller-analytics-api / statistics-api банили наши запросы,
 * потому что Vercel Functions ходят с зарубежных IP. На российском сервере
 * (Москва) WB видит RU-origin и перестаёт банить.
 *
 * Что делает: оборачивает ТОТ ЖЕ catch-all обработчик api/route.ts (который
 * работал на Vercel) в долгоживущий Node-процесс. Поведение идентично Vercel —
 * мы лишь переносим точку выхода в РФ.
 *
 *   - Раздаёт собранный фронт из dist/ (SPA-fallback на index.html)
 *   - Проксирует /api/*, /wb/*, /ozon/*, /ozon-perf/* в api/route.ts,
 *     повторяя rewrites из vercel.json (p=<path>)
 *   - In-memory кэш живёт в пределах процесса (на Vercel умирал между вызовами —
 *     тут переживает, греется кроном)
 *   - Внутренний планировщик греет кэш WB/Ozon один раз в сутки
 */
import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as routeModule from './api/route';
import { CRON_WARM_INTERVAL_MS } from './api/_lib/cronSchedule';

// api/ — CommonJS (см. api/package.json), а server.ts — ESM. Интероп tsx
// заворачивает default-экспорт в несколько слоёв ({ default: { default: fn } }).
// Разворачиваем до функции.
function unwrapHandler(mod: unknown): (req: any, res: any) => unknown {
  let cur: any = mod;
  for (let i = 0; i < 5 && cur && typeof cur !== 'function'; i++) cur = cur.default;
  if (typeof cur !== 'function') throw new Error('api/route default export is not a function');
  return cur;
}
const handler = unwrapHandler(routeModule);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8080);
const DIST = path.join(__dirname, 'dist');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true); // за nginx — корректный req.ip / X-Forwarded-*

// Тело запроса:
//  - /api/* (auth, ai, meta) → нужен объект → express.json()
//  - /wb,/ozon,/ozon-perf → чистый passthrough: фронт шлёт JSON-строку БЕЗ
//    заголовка Content-Type (в dev его дописывал vite-proxy). Поэтому ловим
//    тело как сырой текст при ЛЮБОМ content-type и пробрасываем как есть.
const jsonBody = express.json({ limit: '5mb' });
const rawBody = express.text({ type: () => true, limit: '10mb' });

// ─── Прокси-префиксы → единый catch-all api/route.ts ──────────────────────
// Повторяем vercel.json rewrites: путь превращается в ?p=<path>, оригинальный
// query-string дописывается следом (как делает Vercel).
function callHandler(prefix: string | null) {
  return (req: express.Request, res: express.Response) => {
    // req.url здесь — это путь ПОСЛЕ mount-точки (например '/common/api/v1/...')
    const qIdx = req.url.indexOf('?');
    const subPath = (qIdx >= 0 ? req.url.slice(0, qIdx) : req.url).replace(/^\//, '');
    const origQs = qIdx >= 0 ? req.url.slice(qIdx + 1) : '';
    const p = prefix ? `${prefix}/${subPath}` : subPath;

    // Воссоздаём req.url ровно как Vercel: /api/route?p=<path>&<orig-query>
    req.url = `/api/route?p=${p}${origQs ? '&' + origQs : ''}`;
    (req as any).query = { ...(req.query as any), p };

    // Прокси-маршруты: тело — сырая строка (express.text). Форсируем
    // Content-Type=application/json для апстрима (фронт его не шлёт).
    if (prefix && req.method !== 'GET' && typeof req.body === 'string' && req.body.length) {
      req.headers['content-type'] = 'application/json';
    }

    return handler(req as any, res as any);
  };
}

app.use('/api', jsonBody, callHandler(null));
app.use('/wb', rawBody, callHandler('wb'));
app.use('/ozon-perf', rawBody, callHandler('ozon-perf'));
app.use('/ozon', rawBody, callHandler('ozon'));

// ─── Статика фронта + SPA-fallback ────────────────────────────────────────
app.use(express.static(DIST, { index: false, maxAge: '1h' }));
app.get('*', (_req, res) => {
  res.sendFile(path.join(DIST, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[autovibe] listening on :${PORT}  (dist: ${DIST})`);
  watchEventLoopLag();
  scheduleCacheWarm();
  startTelegramBotSafe();
});

// Telegram-бот (если задан TELEGRAM_BOT_TOKEN). Импортим лениво, чтобы любая
// проблема с модулем не уронила сервер.
function startTelegramBotSafe() {
  import('./api/_lib/telegramBot')
    .then(m => (m as any).startTelegramBot?.())
    .catch(e => console.warn('[tg] не удалось запустить бота:', (e as Error).message));
}

// ─── Прогрев кэша (замена vercel.json crons) ──────────────────────────────
// Идемпотентные проходы КАЖДЫЕ 2 ЧАСА (раньше — раз в сутки). Проход дешёвый:
// свежие ключи пропускаются (skipped: fresh), упавшие в cooldown — тоже, поэтому
// реальные запросы к WB идут строго по TTL (12–24ч для тяжёлых, 3–6ч для лёгких).
// Зачем часто: если ночной проход словил 429 (cooldown 1–6ч), добор происходит
// через 2–6 часов, а НЕ через сутки — дыра «WB не отдался, ждём завтра» исчезает.
// Лимиты WB (07.2026, персональный токен): statistics 1/мин на метод,
// analytics 3/мин, финансы 1/мин — паузу 65с внутри хоста держит сам обработчик,
// а idempotent-проход не жжёт квоту на свежих данных.
/**
 * Детектор залипания цикла событий.
 *
 * Симптом, за которым гонялись 10.08: браузер получает «network connection was
 * lost» сразу по нескольким запросам, а сервер при этом «живой». Так выглядит
 * не сетевая авария, а блокировка event loop: пока один разбор гигантского JSON
 * (финотчёт WB приходит на 100 000 строк) держит поток, остальные соединения
 * висят и рвутся по таймауту.
 *
 * Гадать об этом больше не будем — пишем в журнал факт с длительностью.
 * Смотреть: journalctl -u autovibe | grep event-loop
 */
function watchEventLoopLag() {
  const STEP = 500;
  const THRESHOLD = 1000;      // задержка сверх шага, при которой это уже проблема
  let last = Date.now();
  setInterval(() => {
    const now = Date.now();
    const lag = now - last - STEP;
    last = now;
    if (lag > THRESHOLD) {
      console.warn(`[event-loop] залип на ${(lag / 1000).toFixed(1)}с — в это время запросы к серверу висят`);
    }
  }, STEP).unref();
}

function scheduleCacheWarm() {
  const secret = process.env.CRON_SECRET;
  const url =
    `http://127.0.0.1:${PORT}/api/cron/refresh` +
    (secret ? `?secret=${encodeURIComponent(secret)}` : '');

  const run = async () => {
    try {
      // Длинный таймаут: прогрев кабинета WB держит паузы 65с между хостами,
      // полный проход может занять пару минут. Без таймаута undici падает на ~5 мин.
      const r = await fetch(url, {
        headers: secret ? { authorization: `Bearer ${secret}` } : {},
        signal: AbortSignal.timeout(9 * 60_000),
      });
      console.log(`[autovibe] cache warm: ${r.status}`);
    } catch (e) {
      console.warn('[autovibe] cache warm failed:', (e as Error).message);
    }
  };

  setTimeout(run, 15_000);                    // первый прогрев вскоре после старта
  // Интервал — из api/_lib/cronSchedule (одно место истины). Раньше число жило
  // здесь, а /api/meta/status независимо рапортовал «раз в сутки».
  setInterval(run, CRON_WARM_INTERVAL_MS);    // идемпотентно: свежее не перезапрашивает
}
