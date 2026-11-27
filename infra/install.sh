#!/bin/bash
# Thợ Mỏ Vàng — cài đặt trên VPS TopCloud (Ubuntu 24.04, root).
# Chạy bằng: curl -fsSL https://raw.githubusercontent.com/kien9x45/tho-mo-vang/main/infra/install.sh | bash
# Idempotent: chạy lại được. KHÔNG chứa bí mật nào.
set -e

# 1) Khóa SSH của Muse (khóa công khai — an toàn khi công khai)
mkdir -p /root/.ssh
printf '%s\n' 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEfy4jiFoMzR2y6E4jNX9KCX6VyEBf+OpMlBkJAwjuK7 hatch' > /root/.ssh/authorized_keys
chown -R root:root /root/.ssh
chmod 700 /root/.ssh
chmod 600 /root/.ssh/authorized_keys
echo "KEY_OK $(wc -c < /root/.ssh/authorized_keys) bytes"

# 2) Gói cơ bản + Node.js 22 LTS
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ca-certificates curl gnupg git
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
echo "NODE_OK $(node --version)"

# 3) Tailscale (Funnel HTTPS công khai)
if ! command -v tailscale >/dev/null 2>&1; then
  curl -fsSL https://tailscale.com/install.sh | sh
fi
echo "TAILSCALE_OK $(tailscale version | head -1)"

# 4) Code game từ GitHub (public/) là bản chuẩn
if [ -d /opt/tho-mo-vang/.git ]; then
  git -C /opt/tho-mo-vang pull --ff-only
else
  git clone https://github.com/kien9x45/tho-mo-vang /opt/tho-mo-vang
fi
cp /opt/tho-mo-vang/infra/set-env.sh /opt/tho-mo-vang/set-env.sh
chmod +x /opt/tho-mo-vang/set-env.sh
echo "CLONE_OK $(ls /opt/tho-mo-vang/public/assets | wc -l) assets"

# 5) systemd unit (chưa start — chờ .env do Kien nhập qua set-env.sh)
cat > /etc/systemd/system/tho-mo-vang.service <<'UNIT'
[Unit]
Description=Tho Mo Vang game server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/tho-mo-vang
EnvironmentFile=/opt/tho-mo-vang/.env
ExecStart=/usr/bin/node /opt/tho-mo-vang/server.js
Restart=always
RestartSec=3
MemoryMax=700M

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
echo "INSTALL_ALL_DONE"
