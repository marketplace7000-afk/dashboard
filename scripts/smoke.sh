#!/usr/bin/env bash
# Проверка сервера ПОСЛЕ деплоя. Запускать на сервере:
#   ssh root@185.152.93.245 'bash /opt/autovibe/scripts/smoke.sh'
#
# Зачем: до этого о поломках узнавали из скриншотов клиента. Скрипт за 20 секунд
# отвечает на три вопроса: процесс жив, эндпоинты отвечают, что в логах.
# Ничего не меняет и не печатает секретов.

set -u
BASE="http://127.0.0.1:${PORT:-8080}"
cd /opt/autovibe 2>/dev/null || true

echo "=== процесс ==="
systemctl is-active autovibe
systemctl show autovibe -p ActiveEnterTimestamp --value
ss -lntp 2>/dev/null | grep -q ":${PORT:-8080}" && echo "порт слушается" || echo "ПОРТ НЕ СЛУШАЕТСЯ"

echo
echo "=== вход ==="
# С включённой авторизацией защищённые эндпоинты мгновенно отдают 401, и замер
# времени становится бессмысленным (проверено 10.08). Поэтому логинимся сами:
# пароль читаем из .env прямо здесь, наружу он не попадает и в вывод не пишется.
JAR=$(mktemp)
trap 'rm -f "$JAR"' EXIT
# Читаем окружение РАБОТАЮЩЕГО процесса, а не .env: пароль может прийти из
# systemd-юнита, из окружения службы или из .env с отступом — текстовый разбор
# файла всё это пропускает. 10.08 скрипт из-за этого доложил «пароль не задан»,
# хотя авторизация была включена и отдавала 401.
PID=$(systemctl show -p MainPID --value autovibe 2>/dev/null)
P=""
if [ -n "${PID:-}" ] && [ "$PID" != "0" ] && [ -r "/proc/$PID/environ" ]; then
  P=$(tr '\0' '\n' < "/proc/$PID/environ" | sed -n 's/^AUTH_PASSWORD=//p' | head -1)
fi
# Запасной путь — файл, если прочитать окружение не вышло.
[ -z "$P" ] && P=$(sed -n 's/^[[:space:]]*AUTH_PASSWORD[[:space:]]*=[[:space:]]*//p' .env 2>/dev/null | head -1 | tr -d '"'"'"' ')
if [ -z "$P" ]; then
  # Отличаем «вход выключен» от «не смог прочитать пароль»: это разные вещи,
  # и путать их нельзя — первое означает дыру, второе просто слепой скрипт.
  probe=$(curl -s -o /dev/null -m 15 -w '%{http_code}' "$BASE/api/auth/check")
  if [ "$probe" = "401" ]; then
    echo "ВХОД ВКЛЮЧЁН, но пароль прочитать не удалось — замеры ниже будут по 401"
  else
    echo "ВНИМАНИЕ: вход отключён (/api/auth/check → $probe) — эндпоинты открыты всем"
  fi
else
  code=$(curl -s -o /dev/null -m 20 -w '%{http_code}' -c "$JAR" \
    -X POST -H 'content-type: application/json' \
    --data-binary "{\"password\":\"$P\"}" "$BASE/api/auth/login")
  [ "$code" = "200" ] && echo "сессия получена" || echo "ВОЙТИ НЕ ВЫШЛО (код $code) — замеры ниже будут по 401"
fi

echo
echo "=== эндпоинты (код · секунды) ==="
for p in /api/auth/check /api/meta/status /api/bi?days=30 /api/penalties?days=30 \
         "/api/ads-advisor/by-sku?days=7" /api/ozon-buyer-prices /api/wb-buyer-prices; do
  printf '%-42s %s\n' "$p" "$(curl -s -o /dev/null -m 60 -b "$JAR" -w '%{http_code} · %{time_total}s' "$BASE$p")"
done

echo
echo "=== залипания цикла событий за час ==="
# Если тут строки есть — сервер в это время не отвечал никому, и «network
# connection was lost» в браузере именно отсюда.
journalctl -u autovibe --since '1 hour ago' --no-pager 2>/dev/null | grep -c 'event-loop' | xargs -I{} echo "случаев: {}"
journalctl -u autovibe --since '1 hour ago' --no-pager 2>/dev/null | grep 'event-loop' | tail -5

echo
echo "=== прогревы ==="
journalctl -u autovibe --since '2 hours ago' --no-pager 2>/dev/null \
  | grep -E 'warm-extras|cache warm|wb-fullstats' | tail -8

echo
echo "=== ошибки в логе за час ==="
journalctl -u autovibe --since '1 hour ago' --no-pager 2>/dev/null \
  | grep -iE 'error|failed|ECONN|timeout' | grep -v 'event-loop' | tail -10
