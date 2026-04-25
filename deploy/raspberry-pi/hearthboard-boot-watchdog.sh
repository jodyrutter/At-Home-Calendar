#!/usr/bin/env bash
# hearthboard-boot-watchdog.sh
#
# Ensures the Hearthboard container is running.
#
# At boot (--boot flag): waits up to 90 seconds for the desktop SMB automounts
# to either succeed or fully time out before asking Docker to start the
# container. This prevents the bind-mount race where Docker tries to mount an
# autofs trigger that hasn't resolved yet, gets "no such device", and gives up.
#
# Cron (no flag): just checks and starts if stopped.
#
# Usage (in jodyrutter's crontab):
#   @reboot sleep 30 && /home/jodyrutter/hearthboard/deploy/raspberry-pi/hearthboard-boot-watchdog.sh --boot
#   */5 * * * *        /home/jodyrutter/hearthboard/deploy/raspberry-pi/hearthboard-boot-watchdog.sh

set -euo pipefail

COMPOSE_DIR="/home/jodyrutter/hearthboard/deploy/raspberry-pi"
COMPOSE_FILE="docker-compose.pi.yml"
LOG="/home/jodyrutter/hearthboard/hearthboard-watchdog.log"
MOUNT_PATH="/mnt/hearthboard-pc/drone-fullres"
MAX_WAIT=90

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >> "$LOG"; }

# ---- Boot mode: wait for the SMB automount to reach a stable state ----------
if [[ "${1:-}" == "--boot" ]]; then
  log "Boot watchdog started. Waiting up to ${MAX_WAIT}s for SMB automounts to settle."
  waited=0
  while [[ $waited -lt $MAX_WAIT ]]; do
    if findmnt -t cifs "$MOUNT_PATH" >/dev/null 2>&1; then
      log "CIFS share mounted at $MOUNT_PATH after ${waited}s."
      break
    fi
    sleep 10
    waited=$((waited + 10))
  done
  if [[ $waited -ge $MAX_WAIT ]]; then
    log "Automount timed out after ${MAX_WAIT}s — desktop likely offline. Proceeding with local fallback."
  fi
fi

# ---- Ensure Hearthboard is running ------------------------------------------
if docker ps --filter "name=^hearthboard$" --filter "status=running" \
     --format "{{.Names}}" 2>/dev/null | grep -q "^hearthboard$"; then
  # Running — nothing to do (silent in cron mode, brief note in boot mode)
  [[ "${1:-}" == "--boot" ]] && log "Hearthboard already running, done."
  exit 0
fi

log "Hearthboard not running. Starting via docker compose."
cd "$COMPOSE_DIR"
if docker compose -f "$COMPOSE_FILE" up -d hearthboard >> "$LOG" 2>&1; then
  log "Hearthboard started successfully."
else
  log "ERROR: docker compose up returned $? — check logs above."
fi
