#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"
CREDS_FILE="$SCRIPT_DIR/.smb-credentials"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE. Copy .env.example to .env first." >&2
  exit 1
fi

source "$ENV_FILE"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Required command missing: $1" >&2
    exit 1
  fi
}

require_cmd mount
require_cmd mountpoint
require_cmd sudo

if [[ -z "${DESKTOP_SMB_USERNAME:-}" || -z "${DESKTOP_SMB_PASSWORD:-}" ]]; then
  echo "DESKTOP_SMB_USERNAME and DESKTOP_SMB_PASSWORD must be set in $ENV_FILE." >&2
  exit 1
fi

cat >"$CREDS_FILE" <<EOF
username=${DESKTOP_SMB_USERNAME}
password=${DESKTOP_SMB_PASSWORD}
domain=${DESKTOP_SMB_DOMAIN:-WORKGROUP}
EOF
chmod 600 "$CREDS_FILE"

mount_share() {
  local share_path="$1"
  local mount_path="$2"

  if [[ -z "$share_path" || "$share_path" == *"REPLACE_"* ]]; then
    echo "Skipping unresolved share path for $mount_path"
    return
  fi

  sudo mkdir -p "$mount_path"

  if mountpoint -q "$mount_path"; then
    echo "Already mounted: $mount_path"
    return
  fi

  sudo mount -t cifs "$share_path" "$mount_path" \
    -o "credentials=$CREDS_FILE,iocharset=utf8,uid=$(id -u),gid=$(id -g),vers=3.0,_netdev"
}

mount_share "${DESKTOP_SMB_DRONE_SHARE:-}" "${PI_DRONE_FULLRES_MOUNT:-/mnt/hearthboard-pc/drone-fullres}"
mount_share "${DESKTOP_SMB_JAPAN_SHARE:-}" "${PI_JAPAN_FULLRES_MOUNT:-/mnt/hearthboard-pc/japan}"
mount_share "${DESKTOP_SMB_GENERAL_SHARE:-}" "${PI_GENERAL_FULLRES_MOUNT:-/mnt/hearthboard-pc/general}"
mount_share "${DESKTOP_SMB_PHONE_SHARE:-}" "${PI_PHONE_FULLRES_MOUNT:-/mnt/hearthboard-pc/phone}"
mount_share "${DESKTOP_SMB_PHONE_QUARANTINE_SHARE:-}" "${PI_PHONE_QUARANTINE_FULLRES_MOUNT:-/mnt/hearthboard-pc/phone-quarantine}"

echo "Desktop share mount pass complete."
