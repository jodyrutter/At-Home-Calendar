#!/usr/bin/env bash
set -euo pipefail

ENV_FILE="${HEARTHBOARD_ENV_FILE:-/home/jodyrutter/hearthboard/deploy/raspberry-pi/.env}"
APP_BASE_URL="${HEARTHBOARD_APP_BASE_URL:-http://127.0.0.1:42070}"
RUNNER_LABEL="${HEARTHBOARD_SPEEDTEST_RUNNER_LABEL:-Hearthboard Pi}"
LOG_TAG="hearthboard-pi-speedtest"

log() {
  logger -t "${LOG_TAG}" "$*"
  printf '[%s] %s\n' "${LOG_TAG}" "$*"
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    log "Missing required command: $1"
    exit 1
  fi
}

require_cmd speedtest
require_cmd python3
require_cmd curl
require_cmd sha256sum

if [[ -f "${ENV_FILE}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
  set +a
fi

PUSH_SECRET="${SPEEDTEST_PUSH_SECRET:-${INTEGRATION_TOKEN_ENCRYPTION_KEY:-}}"
if [[ -z "${PUSH_SECRET}" ]]; then
  log "Missing SPEEDTEST_PUSH_SECRET / INTEGRATION_TOKEN_ENCRYPTION_KEY."
  exit 1
fi

PUSH_KEY="$(python3 - <<'PY' "${PUSH_SECRET}"
import hashlib, sys
secret = sys.argv[1].encode("utf-8")
print(hashlib.sha256(b"hearthboard-speedtest-push\0" + secret).hexdigest())
PY
)"

RAW_JSON="$(speedtest --accept-license --accept-gdpr --progress=no --format=json)"

PAYLOAD_JSON="$(python3 - <<'PY' "${RAW_JSON}" "${RUNNER_LABEL}"
import json, sys

raw = json.loads(sys.argv[1])
runner = sys.argv[2]

download_mbps = (float(raw["download"]["bandwidth"]) * 8.0) / 1_000_000.0
upload_mbps = (float(raw["upload"]["bandwidth"]) * 8.0) / 1_000_000.0
latency_ms = float(raw["ping"]["latency"])
server_name = raw.get("server", {}).get("name") or "Speedtest server"
server_location = raw.get("server", {}).get("location") or ""
server_country = raw.get("server", {}).get("country") or ""

payload = {
    "downloadMbps": round(download_mbps, 2),
    "uploadMbps": round(upload_mbps, 2),
    "latencyMs": round(latency_ms, 1),
    "source": "internet",
    "target": f"{server_name} \u00b7 {server_location} (Ookla)" if server_location else f"{server_name} (Ookla)",
    "serverLocation": ", ".join(part for part in [server_name, server_location, server_country] if part),
    "runner": runner,
    "client": "server"
}

print(json.dumps(payload, separators=(",", ":")))
PY
)"

TMP_PAYLOAD="$(mktemp)"
trap 'rm -f "${TMP_PAYLOAD}"' EXIT
printf '%s' "${PAYLOAD_JSON}" > "${TMP_PAYLOAD}"

curl -fsS --max-time 90 \
  -X POST \
  "${APP_BASE_URL%/}/api/speedtest/results" \
  -H "Content-Type: application/json" \
  -H "X-Hearthboard-Speedtest-Key: ${PUSH_KEY}" \
  --data-binary "@${TMP_PAYLOAD}" >/dev/null

log "Pushed Pi host speedtest sample: ${PAYLOAD_JSON}"
