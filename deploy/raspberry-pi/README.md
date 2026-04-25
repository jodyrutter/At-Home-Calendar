# Raspberry Pi Migration

This folder is the Pi-primary deployment pack for Hearthboard.

## What this setup does

- Runs Hearthboard on the Raspberry Pi as the normal primary host.
- Keeps the Windows PC as the place where `Jody AI` still lives.
- Stores Pi media on the USB drive mounted from `/dev/sda`, not on the SD card.
- Uses a hybrid drone library:
  - full resolution from the Windows desktop over the network when the desktop is reachable
  - local 1080p mirror on the Pi USB drive when the desktop is offline
- Lets you redeploy to a fresh Pi using the same repo + `.env` file + scripts in this folder.

## Folder contents

- `docker-compose.pi.yml`
  Pi-primary compose file.
- `.env.example`
  Copy this to `.env` and fill in the real Pi/Desktop paths.
- `redeploy-hearthboard-pi.sh`
  Idempotent start/rebuild script for the Pi.
- `sync-gallery-to-pi.sh`
  Copies the whole gallery from the desktop export mount to the Pi USB drive, while making 1080p drone copies.

## Recommended Pi storage layout

Your Pi is already showing the USB drive mounted here:

- `/mnt/media`

Then keep all Pi media under:

- `/mnt/media/hearthboard-media`

Recommended subfolders:

- `/mnt/media/hearthboard-media/drone-1080p`
- `/mnt/media/hearthboard-media/japan`
- `/mnt/media/hearthboard-media/general`
- `/mnt/media/hearthboard-media/phone`
- `/mnt/media/hearthboard-media/phone-quarantine`

## Desktop share mount on the Pi

The Pi should mount the desktop's exported gallery shares somewhere like:

- `/mnt/hearthboard-pc/drone-fullres`
- `/mnt/hearthboard-pc/japan`
- `/mnt/hearthboard-pc/general`
- `/mnt/hearthboard-pc/phone`
- `/mnt/hearthboard-pc/phone-quarantine`

For the drone library, the app now prefers the mounted desktop full-res path and falls back automatically to the local 1080p mirror after a cached availability check. That switch happens inside Hearthboard itself; you do not need a second gallery config for the drone library.

Use automount/soft-timeout-friendly mount options so the Pi does not hang hard on a dead desktop. For SMB/CIFS, that usually means using `x-systemd.automount`, `_netdev`, and conservative timeout behavior instead of a blocking eager mount.

There is also a helper script in this folder:

- `mount-desktop-shares.sh`
- `install-desktop-share-mounts.sh`

It reads the SMB settings from `.env` and mounts all five desktop shares into the `/mnt/hearthboard-pc/...` paths. You still need to replace the placeholder share names in `.env` with your real Windows SMB share paths first.

For the long-term Pi setup, prefer:

```bash
sudo ./deploy/raspberry-pi/install-desktop-share-mounts.sh
```

That writes stable CIFS automount entries into `/etc/fstab`, stores the SMB credentials in `/etc/hearthboard/desktop-shares.credentials`, and mounts the shares immediately so the Pi keeps recovering the desktop links across reboot.

On the Windows desktop, you can create the expected share names with:

- [scripts/setup-hearthboard-desktop-shares.ps1](C:\Users\jody4\OneDrive\Documents\New project\scripts\setup-hearthboard-desktop-shares.ps1)

Run that in an elevated PowerShell window. It creates these read-only share names for your current Windows account:

- `//192.168.1.118/HearthDrone`
- `//192.168.1.118/HearthJapan`
- `//192.168.1.118/HearthGeneral`
- `//192.168.1.118/HearthPhone`
- `//192.168.1.118/HearthPhoneQuarantine`

## First-time Pi setup

1. Copy `.env.example` to `.env`.
2. Fill in:
   - `POSTGRES_PASSWORD`
   - your existing OAuth credentials
   - your existing `INTEGRATION_TOKEN_ENCRYPTION_KEY`
   - the Pi LAN hostname/IP
   - the desktop LAN IP
   - the mounted USB-drive paths
   - the mounted desktop-share paths
3. Mount the USB drive and desktop-share paths.
4. Run:

```bash
cd /path/to/this/repo
./deploy/raspberry-pi/mount-desktop-shares.sh
./deploy/raspberry-pi/sync-gallery-to-pi.sh
./deploy/raspberry-pi/redeploy-hearthboard-pi.sh
```

## Fresh Pi recovery

If this Pi dies or the SD card gets corrupted:

1. Clone/copy this repo to the new Pi.
2. Recreate the USB mount and desktop-share mount paths.
3. Copy your saved `.env` back into `deploy/raspberry-pi/.env`.
4. Run:

```bash
./deploy/raspberry-pi/mount-desktop-shares.sh
./deploy/raspberry-pi/sync-gallery-to-pi.sh
./deploy/raspberry-pi/redeploy-hearthboard-pi.sh
```

## Important limitations

- `Jody AI` still lives only on the desktop. When the desktop is down, Hearthboard on the Pi stays up but `Jody AI` will be unavailable.
- The local drone mirror keeps the same folder structure, but it only creates 1080p derivatives for common image/video formats. Desktop-only formats such as raw drone originals may stay unavailable while the desktop is offline.
- Public internet failover to the Windows backup still depends on your network edge. If your router/NAT still points at the Pi, the Windows backup will be a LAN/local fallback until you move that forwarding or add edge failover.
