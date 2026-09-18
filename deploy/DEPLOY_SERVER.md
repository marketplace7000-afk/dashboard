# Деплой Auto Vibe на свой сервер (Timeweb, Ubuntu 24.04)

Зачем переехали с Vercel: WB `seller-analytics-api` и `statistics-api` **банят
зарубежные IP**, а Vercel Functions ходят из США/ЕС. На сервере в Москве WB
видит российский origin - аналитика по WB перестает баниться.

Архитектура на сервере = тот же код, что работал на Vercel:
- `server.ts` - долгоживущий Node-процесс, оборачивает `api/route.ts`
  (catch-all-прокси WB/Ozon/Anthropic), раздает собранный фронт `dist/`.
- `nginx` - reverse proxy :80/:443 → Node :8080.
- in-memory кэш переживает запросы (на Vercel умирал) + ежечасный прогрев.

---

## ⚠️ Сначала - публичный IPv4

На скрине создания сервера было **«Не удалось создать IP-адрес»** - выдался
только IPv6 (`2a03:6f00:a::…`). Этого **недостаточно**:
- многие RU-API (WB/Ozon-шлюзы) и твой доступ по SSH/HTTP нужны по IPv4;
- домен и SSL тоже проще на IPv4.

**Что сделать перед деплоем:** в панели сервера → вкладка **Сеть** → добавить
**Публичный IPv4** (180 ₽/мес). Если не создается («нет в наличии») - написать
в поддержку Timeweb или пересоздать сервер. Дальше все привязываем к этому IPv4.

---

## Шаг 1 - Зайти на сервер

```bash
ssh root@<ВАШ_IPv4>
```
(пароль root пришел в панели/на почту; или ключ, если загружал при создании).

## Шаг 2 - Залить код в /opt/autovibe

**Вариант A - rsync с ноутбука (так и деплоим на практике).** Без GitHub,
прямо из папки проекта. Боевой сервер: `root@200.165.234.229`.
```bash
rsync -rlptz --exclude '.env' --exclude '.env.*' --exclude node_modules \
  --exclude dist --exclude .git --exclude .av-cache \
  ./ root@200.165.234.229:/opt/autovibe/
```
Важно: `.env`, `node_modules`, `dist`, `.av-cache` исключены - на сервере
своя копия `.env` и свой собранный фронт. Поэтому **новые переменные окружения
дописываются прямо на сервере** (rsync их не привезет), а фронт собирается
на сервере (`npm run build`). Если в правках появились НОВЫЕ npm-зависимости -
после rsync один раз прогнать `npm ci` (иначе хватает только `npm run build`).

**Вариант B - git clone** (если когда-нибудь заведем GitHub-деплой):
```bash
apt-get update -y && apt-get install -y git
git clone <URL_РЕПО> /opt/autovibe
```

## Шаг 3 - Заполнить серверный .env

```bash
cd /opt/autovibe
cp deploy/env.server.example .env
nano .env
```
Заполни (значения возьми из локального `.env`, **имена БЕЗ `VITE_`**):
- `WB_TOKEN` - токен WB со всеми категориями (главное ради чего переезд);
- `OZON_CLIENT_ID`, `OZON_API_KEY`;
- `OZON_PERF_CLIENT_ID`, `OZON_PERF_CLIENT_SECRET` (реклама, опц.);
- `ANTHROPIC_API_KEY` (+ `ANTHROPIC_DEFAULT_MODEL`);
- `AUTH_PASSWORD` + `AUTH_SECRET` (пароль входа в дашборд);
- `CRON_SECRET` = `openssl rand -hex 24`;
- `TELEGRAM_BOT_TOKEN` (от @BotFather) - нужен и боту, и входу в мини-аппу;
- `TELEGRAM_ALLOWED_IDS` - TG-ID, кому разрешен вход через Telegram Mini App
  (через запятую; узнать id: @userinfobot). Пусто = вход по TG закрыт всем.

> Локально WB/Ozon лежали под `VITE_WB_TOKEN` / `VITE_OZON_*` (их читал
> vite-dev-proxy). На сервере серверный код читает `WB_TOKEN` / `OZON_*`.

## Шаг 4 - Провижининг одной командой

```bash
sudo bash /opt/autovibe/deploy/setup.sh
```
Скрипт: ставит Node 22 + nginx, `npm ci`, `npm run build`, поднимает
systemd-сервис `autovibe`, настраивает nginx и firewall.

Проверка:
```bash
curl -s http://127.0.0.1:8080/api/foo        # → {"error":"unknown_api_section",...}
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8080/   # → 200
journalctl -u autovibe -f                     # логи приложения
```

## Шаг 5 - Проверить WB-аналитику (главное)

```bash
# должно вернуть данные, а НЕ 401/бан, потому что IP теперь российский:
curl -s "http://127.0.0.1:8080/wb/analytics/api/analytics/v3/sales-funnel/products" \
  -X POST -H 'content-type: application/json' \
  -d '{"period":{"start":"2026-05-21","end":"2026-05-28"},"timezone":"Europe/Moscow","limit":50,"offset":0,"brandNames":[],"subjectIDs":[],"tagIDs":[],"nmIDs":[],"orderBy":{"field":"ordersSumRub","mode":"desc"}}'
```
Заголовок `x-av-cache: MISS/HIT` в ответе = прокси отработал. Если WB вернул
данные - бан снят переездом. Открой сайт по `http://<ВАШ_IPv4>/` и проверь
раздел WB-аналитики в дашборде.

## Шаг 6 - Домен + HTTPS (после привязки домена)

1. В DNS домена создай A-запись на `<ВАШ_IPv4>`.
2. В `/etc/nginx/sites-available/autovibe` замени `server_name _;` на свой домен.
3. ```bash
   apt-get install -y certbot python3-certbot-nginx
   certbot --nginx -d autovibe.example.ru
   systemctl reload nginx
   ```
   certbot сам добавит SSL-блок и редирект на 443.

---

## Обновление после правок кода (так и делаем)

С ноутбука, из папки проекта - rsync + сборка/рестарт на сервере:
```bash
# 1) залить изменения
rsync -rlptz --exclude '.env' --exclude '.env.*' --exclude node_modules \
  --exclude dist --exclude .git --exclude .av-cache \
  ./ root@200.165.234.229:/opt/autovibe/

# 2) собрать фронт и перезапустить сервис
ssh root@200.165.234.229 'cd /opt/autovibe && npm run build && systemctl restart autovibe'

# 3) проверить логи
ssh root@200.165.234.229 'journalctl -u autovibe -n 30 --no-pager'
```
Новые env-переменные (rsync их не везет, `.env` исключен) - дописать на сервере:
```bash
ssh root@200.165.234.229 "grep -q TELEGRAM_ALLOWED_IDS /opt/autovibe/.env \
  || echo 'TELEGRAM_ALLOWED_IDS=123456789' >> /opt/autovibe/.env"
# затем повторить шаг 2 (рестарт)
```

## Что с Vercel
Прокси WB/Ozon теперь на сервере. Vercel-деплой можно оставить как витрину или
выключить cron (`vercel.json` crons), чтобы не дергать WB параллельно с сервером
с зарубежного IP. На сервере прогрев кэша делает сам `server.ts` (ежечасно).
