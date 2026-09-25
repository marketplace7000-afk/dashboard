#!/bin/bash
# Выкатка ветки feature/agents на прод e-avtovibe.ru (25.09.2026).
# Запускать НА СЕРВЕРЕ под root (веб-консоль Timeweb или SSH).
# Делает: код с GitHub -> /opt/autovibe (без .env, кэша и данных),
# ключ агента в .env (если ещё нет), сборка фронта, перезапуск сервиса.
set -e

cd /opt/autovibe

echo "== 1/5 Забираю ветку feature/agents с GitHub =="
curl -sL https://github.com/marketplace7000-afk/dashboard/archive/refs/heads/feature/agents.tar.gz -o /tmp/agents.tar.gz
rm -rf /tmp/dashboard-feature-agents
tar -xzf /tmp/agents.tar.gz -C /tmp

echo "== 2/5 Копирую в /opt/autovibe (секреты, кэш и данные не трогаю) =="
rsync -rlpt --exclude '.env' --exclude '.env.*' --exclude node_modules --exclude dist \
  --exclude .av-cache --exclude av-data /tmp/dashboard-feature-agents/ /opt/autovibe/
chown -R autovibe:autovibe /opt/autovibe

echo "== 3/5 Ключ агента =="
if grep -q '^AGENT_API_KEY=' .env; then
  echo "AGENT_API_KEY уже есть в .env — оставляю как есть."
else
  KEY=$(openssl rand -hex 24)
  echo "AGENT_API_KEY=$KEY" >> .env
  echo "Создан новый ключ агента. ЗАПИШИТЕ ЕГО — он понадобится в .env хоста на ПК:"
  echo "AGENT_API_KEY=$KEY"
fi

echo "== 4/5 Сборка фронта =="
npm run build

echo "== 5/5 Перезапуск сервиса =="
systemctl restart autovibe
sleep 10
systemctl is-active autovibe && echo "OK: сервис работает."
echo "Проверка: откройте https://e-avtovibe.ru — в меню должен появиться раздел «Сборщики», а разделы Закупки/ROI/BI/База знаний — исчезнуть."
