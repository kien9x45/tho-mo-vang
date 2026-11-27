#!/bin/bash
# Chẩn đoán + sửa lỗi SSH pubkey bị từ chối trên VPS TopCloud.
# Chạy: curl -fsSL https://raw.githubusercontent.com/kien9x45/tho-mo-vang/main/infra/fix-ssh.sh | bash
echo "===== DIAG ====="
sshd -T 2>/dev/null | grep -Ei 'pubkeyauthentication|authorizedkeysfile|permitrootlogin|strictmodes|usepam|passwordauthentication'
passwd -S root
ls -ld /root /root/.ssh /root/.ssh/authorized_keys
grep '^root' /etc/shadow | cut -c1-12
echo "===== FIX ====="
# 1) Mở khóa tài khoản root nếu đang bị khóa (field shadow bắt đầu bằng "!") — giữ nguyên hash mật khẩu
if grep -q '^root:!' /etc/shadow; then
  sed -i 's/^root:!/root:/' /etc/shadow
  echo "ROOT_UNLOCKED"
else
  echo "ROOT_NOT_LOCKED"
fi
# 2) Drop-in cấu hình sshd: bật pubkey, cho root đăng nhập bằng key
cat > /etc/ssh/sshd_config.d/99-tho-mo-vang.conf <<'CONF'
PubkeyAuthentication yes
PermitRootLogin prohibit-password
AuthorizedKeysFile .ssh/authorized_keys
CONF
echo "DROPIN_WRITTEN"
# 3) Quyền file
chown -R root:root /root/.ssh
chmod 700 /root /root/.ssh
chmod 600 /root/.ssh/authorized_keys
# 4) Nạp lại sshd
systemctl restart ssh || service ssh restart
echo "SSH_RESTARTED"
sshd -T 2>/dev/null | grep -Ei 'pubkeyauthentication|permitrootlogin'
echo "FIX_SSH_DONE"
