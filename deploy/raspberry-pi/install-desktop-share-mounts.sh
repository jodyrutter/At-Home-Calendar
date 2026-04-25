#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE. Copy .env.example to .env first." >&2
  exit 1
fi

if [[ "${EUID}" -ne 0 ]]; then
  exec sudo --preserve-env=PATH bash "$0" "$@"
fi

source "$ENV_FILE"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Required command missing: $1" >&2
    exit 1
  fi
}

require_cmd install
require_cmd mount
require_cmd mountpoint
require_cmd systemctl

if [[ -z "${DESKTOP_SMB_USERNAME:-}" || -z "${DESKTOP_SMB_PASSWORD:-}" ]]; then
  echo "DESKTOP_SMB_USERNAME and DESKTOP_SMB_PASSWORD must be set in $ENV_FILE." >&2
  exit 1
fi

OWNER_USER="${SUDO_USER:-jodyrutter}"
OWNER_UID="$(id -u "$OWNER_USER")"
OWNER_GID="$(id -g "$OWNER_USER")"
CREDENTIALS_DIR="/etc/hearthboard"
CREDENTIALS_FILE="$CREDENTIALS_DIR/desktop-shares.credentials"
FSTAB_BEGIN="# >>> hearthboard desktop shares >>>"
FSTAB_END="# <<< hearthboard desktop shares <<<"

install -d -m 0755 "$CREDENTIALS_DIR"
cat >"$CREDENTIALS_FILE" <<EOF
username=${DESKTOP_SMB_USERNAME}
password=${DESKTOP_SMB_PASSWORD}
domain=${DESKTOP_SMB_DOMAIN:-WORKGROUP}
EOF
chmod 600 "$CREDENTIALS_FILE"

ensure_mount_dir() {
  local mount_path="$1"
  [[ -n "$mount_path" ]] || return 0
  install -d -o "$OWNER_UID" -g "$OWNER_GID" -m 0755 "$mount_path"
}

ensure_mount_dir "${PI_DRONE_FULLRES_MOUNT:-/mnt/hearthboard-pc/drone-fullres}"
ensure_mount_dir "${PI_JAPAN_FULLRES_MOUNT:-/mnt/hearthboard-pc/japan}"
ensure_mount_dir "${PI_GENERAL_FULLRES_MOUNT:-/mnt/hearthboard-pc/general}"
ensure_mount_dir "${PI_PHONE_FULLRES_MOUNT:-/mnt/hearthboard-pc/phone}"
ensure_mount_dir "${PI_PHONE_QUARANTINE_FULLRES_MOUNT:-/mnt/hearthboard-pc/phone-quarantine}"

mount_line() {
  local share_path="$1"
  local mount_path="$2"

  if [[ -z "$share_path" || "$share_path" == *"REPLACE_"* ]]; then
    return
  fi

  printf '%s %s cifs credentials=%s,iocharset=utf8,uid=%s,gid=%s,file_mode=0644,dir_mode=0755,vers=3.0,noserverino,_netdev,nofail,noauto,x-systemd.automount,x-systemd.idle-timeout=10min,x-systemd.mount-timeout=30s 0 0\n' \
    "$share_path" "$mount_path" "$CREDENTIALS_FILE" "$OWNER_UID" "$OWNER_GID"
}

TMP_FSTAB="$(mktemp)"
trap 'rm -f "$TMP_FSTAB"' EXIT

awk -v begin="$FSTAB_BEGIN" -v end="$FSTAB_END" '
  $0 == begin { skip=1; next }
  $0 == end { skip=0; next }
  !skip { print }
' /etc/fstab >"$TMP_FSTAB"

{
  cat "$TMP_FSTAB"
  echo
  echo "$FSTAB_BEGIN"
  mount_line "${DESKTOP_SMB_DRONE_SHARE:-}" "${PI_DRONE_FULLRES_MOUNT:-/mnt/hearthboard-pc/drone-fullres}"
  mount_line "${DESKTOP_SMB_JAPAN_SHARE:-}" "${PI_JAPAN_FULLRES_MOUNT:-/mnt/hearthboard-pc/japan}"
  mount_line "${DESKTOP_SMB_GENERAL_SHARE:-}" "${PI_GENERAL_FULLRES_MOUNT:-/mnt/hearthboard-pc/general}"
  mount_line "${DESKTOP_SMB_PHONE_SHARE:-}" "${PI_PHONE_FULLRES_MOUNT:-/mnt/hearthboard-pc/phone}"
  mount_line "${DESKTOP_SMB_PHONE_QUARANTINE_SHARE:-}" "${PI_PHONE_QUARANTINE_FULLRES_MOUNT:-/mnt/hearthboard-pc/phone-quarantine}"
  echo "$FSTAB_END"
} >/etc/fstab

systemctl daemon-reload

for mount_path in \
  "${PI_DRONE_FULLRES_MOUNT:-/mnt/hearthboard-pc/drone-fullres}" \
  "${PI_JAPAN_FULLRES_MOUNT:-/mnt/hearthboard-pc/japan}" \
  "${PI_GENERAL_FULLRES_MOUNT:-/mnt/hearthboard-pc/general}" \
  "${PI_PHONE_FULLRES_MOUNT:-/mnt/hearthboard-pc/phone}" \
  "${PI_PHONE_QUARANTINE_FULLRES_MOUNT:-/mnt/hearthboard-pc/phone-quarantine}"
do
  mount "$mount_path" || true
done

echo "Installed persistent Hearthboard desktop share mounts."
echo "Credential file: $CREDENTIALS_FILE"
