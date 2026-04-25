#!/usr/bin/env bash
set -euo pipefail

# Configure the BrosTrend / Realtek RTL88x2BU USB Wi-Fi adapter on the Pi
# using the currently active Wi-Fi profile as the source of truth.
#
# What this does:
# - detects the active Wi-Fi connection (usually wlan0 on WarwickNet420)
# - clones it to a wlan1-specific profile
# - makes wlan1 the preferred route when available
# - keeps the built-in Wi-Fi profile as lower-priority fallback
# - brings wlan1 up immediately
#
# Usage:
#   sudo ./deploy/raspberry-pi/setup-brostrend-wifi.sh
#
# Optional:
#   TARGET_IFACE=wlan1 SOURCE_CONN=my-ssid sudo ./deploy/raspberry-pi/setup-brostrend-wifi.sh

TARGET_IFACE="${TARGET_IFACE:-wlan1}"
SOURCE_CONN="${SOURCE_CONN:-}"
TARGET_PRIORITY="${TARGET_PRIORITY:-20}"
SOURCE_PRIORITY="${SOURCE_PRIORITY:-5}"
TARGET_METRIC="${TARGET_METRIC:-150}"
SOURCE_METRIC="${SOURCE_METRIC:-400}"
PREFER_5GHZ="${PREFER_5GHZ:-1}"
TARGET_BSSID="${TARGET_BSSID:-}"
TARGET_STATIC_IPV4="${TARGET_STATIC_IPV4:-}"
TARGET_GATEWAY="${TARGET_GATEWAY:-192.168.1.1}"
TARGET_DNS="${TARGET_DNS:-192.168.1.1}"
DISCONNECT_SOURCE_FOR_STATIC="${DISCONNECT_SOURCE_FOR_STATIC:-1}"

log() {
  printf '[brostrend] %s\n' "$*"
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    log "Required command not found: $1"
    exit 1
  fi
}

require_cmd nmcli
require_cmd ip

if [[ "${EUID}" -ne 0 ]]; then
  log "Please run this with sudo."
  exit 1
fi

if ! nmcli -t -f DEVICE,TYPE device status | grep -q "^${TARGET_IFACE}:wifi$"; then
  log "Wi-Fi adapter ${TARGET_IFACE} was not found. Plug the BrosTrend adapter in first."
  exit 1
fi

if [[ -z "${SOURCE_CONN}" ]]; then
  SOURCE_CONN="$(nmcli -t -f NAME,TYPE,DEVICE connection show --active | awk -F: '
    ($2 == "wifi" || $2 == "802-11-wireless") && $3 != "'"${TARGET_IFACE}"'" { print $1; exit }
  ')"
fi

if [[ -z "${SOURCE_CONN}" ]]; then
  SOURCE_CONN="$(nmcli -g GENERAL.CONNECTION device show wlan0 2>/dev/null | head -n 1)"
fi

if [[ -z "${SOURCE_CONN}" ]]; then
  log "Could not detect an active source Wi-Fi connection to clone."
  exit 1
fi

if ! nmcli connection show "${SOURCE_CONN}" >/dev/null 2>&1; then
  log "Source connection '${SOURCE_CONN}' does not exist."
  exit 1
fi

SOURCE_DEVICE="$(nmcli -g GENERAL.DEVICES connection show "${SOURCE_CONN}" 2>/dev/null | head -n 1 | tr -d '[:space:]')"

SSID="$(nmcli -g 802-11-wireless.ssid connection show "${SOURCE_CONN}" | head -n 1)"
if [[ -z "${SSID}" ]]; then
  log "Could not determine SSID from source connection '${SOURCE_CONN}'."
  exit 1
fi

if [[ -z "${TARGET_BSSID}" && "${PREFER_5GHZ}" == "1" ]]; then
  while IFS=: read -r dev type state _; do
    [[ "${type}" == "wifi" ]] || continue
    CANDIDATE="$(nmcli -t -f BSSID,SSID,FREQ,SIGNAL device wifi list ifname "${dev}" 2>/dev/null | awk -F: '
      $7 == "'"${SSID}"'" && ($8 + 0) >= 5000 {
        score = $9 + 0
        if (score > bestScore) {
          bestScore = score
          best = sprintf("%s:%s:%s:%s:%s:%s", $1, $2, $3, $4, $5, $6)
        }
      }
      END { if (best != "") print best }
    ')"
    if [[ -n "${CANDIDATE}" ]]; then
      TARGET_BSSID="${CANDIDATE}"
      break
    fi
  done < <(nmcli -t -f DEVICE,TYPE,STATE,CONNECTION device status)
fi

TARGET_CONN="usb-${TARGET_IFACE}-${SSID// /-}"

log "Source connection : ${SOURCE_CONN}"
log "Target connection : ${TARGET_CONN}"
log "SSID              : ${SSID}"
if [[ -n "${TARGET_BSSID}" ]]; then
  log "Target BSSID      : ${TARGET_BSSID}"
fi
if [[ -n "${TARGET_STATIC_IPV4}" ]]; then
  log "Target IPv4       : ${TARGET_STATIC_IPV4}"
fi

if nmcli connection show "${TARGET_CONN}" >/dev/null 2>&1; then
  log "Reusing existing target connection '${TARGET_CONN}'."
else
  nmcli connection clone "${SOURCE_CONN}" "${TARGET_CONN}" >/dev/null
fi

nmcli connection modify "${TARGET_CONN}" \
  connection.interface-name "${TARGET_IFACE}" \
  connection.autoconnect yes \
  connection.autoconnect-priority "${TARGET_PRIORITY}" \
  ipv4.route-metric "${TARGET_METRIC}" \
  ipv6.route-metric "${TARGET_METRIC}" \
  802-11-wireless.powersave 2

if [[ "${PREFER_5GHZ}" == "1" ]]; then
  nmcli connection modify "${TARGET_CONN}" 802-11-wireless.band a
fi

if [[ -n "${TARGET_BSSID}" ]]; then
  nmcli connection modify "${TARGET_CONN}" 802-11-wireless.bssid "${TARGET_BSSID}"
fi

if [[ -n "${TARGET_STATIC_IPV4}" ]]; then
  nmcli connection modify "${TARGET_CONN}" \
    ipv4.method manual \
    ipv4.addresses "${TARGET_STATIC_IPV4}" \
    ipv4.gateway "${TARGET_GATEWAY}" \
    ipv4.dns "${TARGET_DNS}"
else
  nmcli connection modify "${TARGET_CONN}" \
    ipv4.method auto \
    -ipv4.addresses \
    -ipv4.gateway \
    -ipv4.dns
fi

nmcli connection modify "${SOURCE_CONN}" \
  connection.autoconnect yes \
  connection.autoconnect-priority "${SOURCE_PRIORITY}" \
  ipv4.route-metric "${SOURCE_METRIC}" \
  ipv6.route-metric "${SOURCE_METRIC}"

if [[ -n "${TARGET_STATIC_IPV4}" && "${DISCONNECT_SOURCE_FOR_STATIC}" == "1" && -n "${SOURCE_DEVICE}" && "${SOURCE_DEVICE}" != "${TARGET_IFACE}" ]]; then
  log "Disconnecting ${SOURCE_CONN} on ${SOURCE_DEVICE} so ${TARGET_IFACE} can claim ${TARGET_STATIC_IPV4}."
  nmcli connection down "${SOURCE_CONN}" || true
  sleep 2
fi

log "Bringing up ${TARGET_CONN} on ${TARGET_IFACE}..."
nmcli connection up "${TARGET_CONN}" ifname "${TARGET_IFACE}"

sleep 3

log "Device status:"
nmcli device status
echo

log "IP state:"
ip -br address show "${TARGET_IFACE}" || true
echo

log "Routing table (top):"
ip route | sed -n '1,10p'
echo

log "Wireless link:"
iw dev "${TARGET_IFACE}" link 2>/dev/null || true
echo

CURRENT_IP="$(ip -4 -o addr show "${TARGET_IFACE}" | awk '{print $4}' | head -n 1)"
if [[ -n "${CURRENT_IP}" ]]; then
  log "${TARGET_IFACE} is up with ${CURRENT_IP}."
else
  log "${TARGET_IFACE} did not get an IPv4 address yet. If needed, retry after a few seconds."
fi

log "Done. Built-in Wi-Fi remains configured as fallback."
