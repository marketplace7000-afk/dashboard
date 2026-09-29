#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────
# Auto Vibe — провижининг сервера (Ubuntu 24.04).
# Запускать НА СЕРВЕРЕ под root. Перед запуском код проекта должен уже лежать
# в /opt/autovibe (склонирован git'ом или залит rsync — см. DEPLOY_SERVER.md),
# а /opt/autovibe/.env заполнен (cp deploy/env.server.example .env && отредактировать).
#
#   sudo bash /opt/autovibe/deploy/setup.sh
# ──────────────────────────────────────────────────────────────────────────
set -euo pipefail

APP_DIR=/opt/autovibe
APP_USER=autovibe

echo "==> 1/7  Системные пакеты"
apt-get update -y
apt-get install -y curl ca-certificates gnupg nginx ufw

echo "==> 2/7  Node.js 22 LTS"
if ! command -v node >/dev/null || [[ "$(node -v)" != v22* ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
node -v && npm -v

echo "==> 3/7  Пользователь приложения"
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"

echo "==> 4/7  Зависимости + сборка фронта"
cd "$APP_DIR"
if [[ ! -f .env ]]; then
  echo "!! /opt/autovibe/.env не найден. Скопируй deploy/env.server.example в .env и заполни."
  exit 1
fi
npm ci --no-audit --no-fund
npm run build
chown -R "$APP_USER":"$APP_USER" "$APP_DIR"

echo "==> 5/7  systemd-сервис"
cp deploy/autovibe.service /etc/systemd/system/autovibe.service
systemctl daemon-reload
systemctl enable autovibe
systemctl restart autovibe
sleep 3
systemctl --no-pager --full status autovibe | head -12 || true

echo "==> 6/7  nginx"
cp deploy/nginx.conf /etc/nginx/sites-available/autovibe
ln -sf /etc/nginx/sites-available/autovibe /etc/nginx/sites-enabled/autovibe
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

echo "==> 7/7  Firewall"
ufw allow OpenSSH || true
ufw allow 'Nginx Full' || true
ufw --force enable || true

echo
echo "✅ Готово. Проверь: curl -s http://127.0.0.1:8080/api/foo  (должен вернуть JSON)"
echo "   Логи приложения:  journalctl -u autovibe -f"
echo "   Домен + SSL:      см. deploy/DEPLOY_SERVER.md (шаг 6, certbot)"
