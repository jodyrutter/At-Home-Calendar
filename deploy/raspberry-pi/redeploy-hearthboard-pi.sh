#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"
COMPOSE_FILE="$SCRIPT_DIR/docker-compose.pi.yml"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE. Copy .env.example to .env and fill in the Pi/Desktop paths first." >&2
  exit 1
fi

mkdir -p \
  /mnt/hearthboard-sda \
  /mnt/hearthboard-pc \
  /srv/hearthboard

source "$ENV_FILE"

mkdir -p \
  "${PI_MEDIA_ROOT:-/mnt/hearthboard-sda/hearthboard-media}" \
  "${PI_DRONE_MIRROR_DIR:-/mnt/hearthboard-sda/hearthboard-media/drone-1080p}" \
  "${PI_JAPAN_DIR:-/mnt/hearthboard-sda/hearthboard-media/japan}" \
  "${PI_GENERAL_DIR:-/mnt/hearthboard-sda/hearthboard-media/general}" \
  "${PI_PHONE_DIR:-/mnt/hearthboard-sda/hearthboard-media/phone}" \
  "${PI_PHONE_QUARANTINE_DIR:-/mnt/hearthboard-sda/hearthboard-media/phone-quarantine}"

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is not installed. Install docker.io + docker-compose-plugin first." >&2
  exit 1
fi

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "ffmpeg is not installed. Install ffmpeg before running the gallery mirror sync." >&2
fi

cd "$REPO_ROOT"
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d --build
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ps
