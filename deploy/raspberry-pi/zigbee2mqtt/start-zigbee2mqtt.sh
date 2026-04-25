#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "${SCRIPT_DIR}/data"
cd "${SCRIPT_DIR}"

docker compose -f docker-compose.zigbee2mqtt.yml up -d
docker compose -f docker-compose.zigbee2mqtt.yml ps
