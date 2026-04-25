#!/usr/bin/env bash
set -euo pipefail

POSTGRES_CONTAINER="${POSTGRES_CONTAINER:-hearthboard-postgres}"
APP_CONTAINER="${APP_CONTAINER:-hearthboard}"
POSTGRES_DB="${POSTGRES_DB:-hearthboard}"
POSTGRES_USER="${POSTGRES_USER:-hearthboard}"

if command -v docker >/dev/null 2>&1; then
  state_json="$(docker exec "$POSTGRES_CONTAINER" psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atqc "select data::text from hearthboard_state where store_id='primary';" 2>/dev/null || true)"
  if [[ -n "$state_json" ]]; then
    printf '%s' "$state_json"
    exit 0
  fi

  docker exec "$APP_CONTAINER" sh -lc 'cat /app/data/store.json'
  exit 0
fi

echo "Docker is required to export Hearthboard state." >&2
exit 1
