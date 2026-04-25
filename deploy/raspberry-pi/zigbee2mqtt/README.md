# Zigbee2MQTT Onboarding

This lightweight stack brings up a local Zigbee2MQTT onboarding UI on the Pi
without touching the main Hearthboard stack.

What it does:

- starts a local Mosquitto broker for Zigbee2MQTT
- maps the coordinator from `/dev/serial/by-id/usb-1a86_USB_Serial-if00-port0`
- exposes the onboarding/frontend on `http://<pi-ip>:8099`

First-run notes:

- Zigbee2MQTT onboarding appears when no `configuration.yaml` exists in the
  `data/` directory.
- If adapter discovery does not identify the model automatically, use the
  detected serial path and choose the adapter type manually.
- The local broker hostname from inside onboarding is `mqtt://mosquitto:1883`.

Useful commands:

```bash
docker compose -f docker-compose.zigbee2mqtt.yml up -d
docker compose -f docker-compose.zigbee2mqtt.yml logs -f zigbee2mqtt
docker compose -f docker-compose.zigbee2mqtt.yml down
```
