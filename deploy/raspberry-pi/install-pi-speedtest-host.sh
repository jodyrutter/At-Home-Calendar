#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
SOURCE_SCRIPT="${SCRIPT_DIR}/host-speedtest-push.sh"
TARGET_SCRIPT="/usr/local/bin/hearthboard-pi-speedtest"
SERVICE_FILE="/etc/systemd/system/hearthboard-pi-speedtest.service"
TIMER_FILE="/etc/systemd/system/hearthboard-pi-speedtest.timer"

if [[ "${EUID}" -ne 0 ]]; then
  echo "[pi-speedtest] Please run this with sudo."
  exit 1
fi

if [[ ! -f "${SOURCE_SCRIPT}" ]]; then
  echo "[pi-speedtest] Missing source script at ${SOURCE_SCRIPT}"
  exit 1
fi

install -m 0755 "${SOURCE_SCRIPT}" "${TARGET_SCRIPT}"

cat > "${SERVICE_FILE}" <<EOF
[Unit]
Description=Push Hearthboard Pi host speedtest sample
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
WorkingDirectory=${PROJECT_ROOT}
Environment=HOME=/root
Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ExecStart=${TARGET_SCRIPT}
EOF

cat > "${TIMER_FILE}" <<'EOF'
[Unit]
Description=Run Hearthboard Pi host speedtest every 5 minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
AccuracySec=30s
Persistent=true

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now hearthboard-pi-speedtest.timer

echo "[pi-speedtest] Installed ${TARGET_SCRIPT}"
echo "[pi-speedtest] Enabled hearthboard-pi-speedtest.timer"
systemctl list-timers hearthboard-pi-speedtest.timer --no-pager || true
