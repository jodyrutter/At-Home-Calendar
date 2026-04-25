#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"
LOCK_DIR="${TMPDIR:-/tmp}/hearthboard-gallery-sync.lock"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE. Copy .env.example to .env first." >&2
  exit 1
fi

source "$ENV_FILE"

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "Another gallery sync is already running." >&2
  exit 1
fi

cleanup() {
  rmdir "$LOCK_DIR" 2>/dev/null || true
}

trap cleanup EXIT

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Required command missing: $1" >&2
    exit 1
  fi
}

require_cmd rsync
require_cmd ffmpeg
require_cmd find
require_cmd bash

normalize_flag() {
  local value="${1:-1}"
  case "${value,,}" in
    0|false|no|off) echo "0" ;;
    *) echo "1" ;;
  esac
}

SYNC_JAPAN="$(normalize_flag "${SYNC_JAPAN:-1}")"
SYNC_GENERAL="$(normalize_flag "${SYNC_GENERAL:-1}")"
SYNC_PHONE="$(normalize_flag "${SYNC_PHONE:-1}")"
SYNC_PHONE_QUARANTINE="$(normalize_flag "${SYNC_PHONE_QUARANTINE:-1}")"
SYNC_DRONE="$(normalize_flag "${SYNC_DRONE:-1}")"
DRONE_VIDEO_FORCE_REGEN="$(normalize_flag "${DRONE_VIDEO_FORCE_REGEN:-0}")"

DEFAULT_DRONE_TRANSCODE_JOBS="2"
if command -v nproc >/dev/null 2>&1; then
  cpu_count="$(nproc)"
  if [[ "$cpu_count" -ge 4 ]]; then
    DEFAULT_DRONE_TRANSCODE_JOBS="3"
  fi
fi
DRONE_TRANSCODE_JOBS="${DRONE_TRANSCODE_JOBS:-$DEFAULT_DRONE_TRANSCODE_JOBS}"

DESKTOP_ROOT="${PI_DESKTOP_EXPORT_ROOT:-/mnt/hearthboard-pc}"
DRONE_SOURCE_DIR="${DESKTOP_DRONE_SOURCE_DIR:-$PI_DRONE_FULLRES_MOUNT}"
JAPAN_SOURCE_DIR="${DESKTOP_JAPAN_SOURCE_DIR:-$DESKTOP_ROOT/japan}"
GENERAL_SOURCE_DIR="${DESKTOP_GENERAL_SOURCE_DIR:-$DESKTOP_ROOT/general}"
PHONE_SOURCE_DIR="${DESKTOP_PHONE_SOURCE_DIR:-$DESKTOP_ROOT/phone}"
PHONE_QUARANTINE_SOURCE_DIR="${DESKTOP_PHONE_QUARANTINE_SOURCE_DIR:-$DESKTOP_ROOT/phone-quarantine}"

mkdir -p \
  "$PI_DRONE_MIRROR_DIR" \
  "$PI_JAPAN_DIR" \
  "$PI_GENERAL_DIR" \
  "$PI_PHONE_DIR" \
  "$PI_PHONE_QUARANTINE_DIR"

sync_copy_library() {
  local label="$1"
  local source_dir="$2"
  local target_dir="$3"
  local enabled="$4"

  if [[ "$enabled" != "1" ]]; then
    echo "Skipping $label sync (disabled)."
    return
  fi

  if [[ ! -d "$source_dir" ]]; then
    echo "Skipping missing $label source: $source_dir"
    return
  fi

  echo "Syncing $label..."
  rsync -a --delete "$source_dir"/ "$target_dir"/
  echo "Finished $label."
}

sync_copy_library "Japan" "$JAPAN_SOURCE_DIR" "$PI_JAPAN_DIR" "$SYNC_JAPAN"
sync_copy_library "General" "$GENERAL_SOURCE_DIR" "$PI_GENERAL_DIR" "$SYNC_GENERAL"
sync_copy_library "Phone" "$PHONE_SOURCE_DIR" "$PI_PHONE_DIR" "$SYNC_PHONE"
sync_copy_library "Phone quarantine" "$PHONE_QUARANTINE_SOURCE_DIR" "$PI_PHONE_QUARANTINE_DIR" "$SYNC_PHONE_QUARANTINE"

if [[ "$SYNC_DRONE" != "1" ]]; then
  echo "Skipping drone mirror transcode (disabled)."
  echo "Gallery mirror sync complete."
  exit 0
fi

if [[ ! -d "$DRONE_SOURCE_DIR" ]]; then
  echo "Drone source is missing: $DRONE_SOURCE_DIR" >&2
  exit 1
fi

transcode_drone_media() {
  local source_file="$1"
  if [[ -z "$source_file" || ! -f "$source_file" ]]; then
    echo "Skipping missing drone source: $source_file" >&2
    return 0
  fi

  local relative_path="${source_file#$DRONE_SOURCE_DIR/}"
  local extension="${source_file##*.}"
  extension="${extension,,}"
  local target_file="$PI_DRONE_MIRROR_DIR/$relative_path"
  local is_video="0"
  case "$extension" in
    mp4|mov|m4v|webm)
      is_video="1"
      ;;
  esac

  mkdir -p "$(dirname "$target_file")"

  if [[ "$is_video" == "1" && "$DRONE_VIDEO_FORCE_REGEN" == "1" && -f "$target_file" ]]; then
    rm -f "$target_file"
  fi

  if [[ -f "$target_file" && "$target_file" -nt "$source_file" ]]; then
    return
  fi

  case "$extension" in
    jpg|jpeg|png|webp)
      if ! ffmpeg -hide_banner -loglevel error -y -i "$source_file" \
        -vf "scale='min(1920,iw)':'min(1080,ih)':force_original_aspect_ratio=decrease" \
        "$target_file"; then
        echo "Warning: failed to transcode image: $source_file" >&2
        rm -f "$target_file"
      fi
      ;;
    mp4|mov|m4v|webm)
      if ! ffmpeg -hide_banner -loglevel error -y -i "$source_file" \
        -vf "scale='min(1280,iw)':'min(720,ih)':force_original_aspect_ratio=decrease" \
        -c:v libx264 -preset veryfast -crf 24 -pix_fmt yuv420p \
        -movflags +faststart -c:a aac -b:a 128k \
        "$target_file"; then
        echo "Warning: failed to transcode video: $source_file" >&2
        rm -f "$target_file"
      fi
      ;;
    *)
      ;;
  esac
}

export DRONE_SOURCE_DIR
export PI_DRONE_MIRROR_DIR
export -f transcode_drone_media

echo "Transcoding drone media to 1080p mirror..."
find "$DRONE_SOURCE_DIR" -type f -print0 | \
  xargs -0 -n 1 -P "$DRONE_TRANSCODE_JOBS" bash -lc 'transcode_drone_media "$1"' _

echo "Gallery mirror sync complete."
