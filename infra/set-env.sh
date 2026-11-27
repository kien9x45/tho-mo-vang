#!/bin/bash
# KIEN tự chạy trên console web của VPS: bash /opt/tho-mo-vang/set-env.sh
# Nhập 3 bí mật lấy từ Render (service tho-mo-vang -> Environment) + GAME_URL.
# Giá trị gõ vào KHÔNG đi qua chat, chỉ nằm trong /opt/tho-mo-vang/.env trên VPS.
set -e
cd /opt/tho-mo-vang
read -rp "DATABASE_URL (Neon, copy từ Render): " DATABASE_URL
read -rp "BOT_TOKEN (copy từ Render): " BOT_TOKEN
read -rp "OWNER_KEY (copy từ Render): " OWNER_KEY
read -rp "GAME_URL (địa chỉ https mới, Muse cung cấp): " GAME_URL
umask 077
{
  echo "PORT=3000"
  echo "DATABASE_URL=$DATABASE_URL"
  echo "BOT_TOKEN=$BOT_TOKEN"
  echo "OWNER_KEY=$OWNER_KEY"
  echo "GAME_URL=$GAME_URL"
} > .env
chmod 600 .env
systemctl enable tho-mo-vang
systemctl restart tho-mo-vang
sleep 2
systemctl --no-pager status tho-mo-vang | head -12
echo "ENV_DONE — báo Muse: 'đã nhập env'"
