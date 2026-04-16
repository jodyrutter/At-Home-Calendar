# Hearthboard

Hearthboard is a self-hosted household calendar and scheduling board you can run on your own Windows machine in Docker and share across your local network.

## What it includes

- Shared month-view calendar with a focused day agenda
- Upcoming event rail for quick planning
- Bulletin board for household notes, reminders, and alerts
- Separate `Jody AI` page that can bridge to a private local model on your Windows host
- Separate read-only gallery page backed by local media folders
- Cached video thumbnails generated inside Docker for faster gallery browsing
- Paginated gallery browsing so large libraries can be explored a page at a time
- Toggleable light and dark themes that persist across pages
- Household member roster with per-person filtering
- Event creation, editing, and deletion
- Persistent local storage backed by a JSON data file in a Docker volume
- Docker and Docker Compose defaults that bind the app to port `42069`

## Run it with Docker

```powershell
docker compose up --build -d
```

Or use the included launcher:

```powershell
.\scripts\start-hearthboard.ps1
```

Then open:

- `http://localhost:42069`
- `http://YOUR-WINDOWS-IP:42069`

The container listens on `0.0.0.0:42069`, so devices on your home network can reach it as long as Windows Firewall allows inbound traffic on that port.

## Local development

```powershell
npm install
npm run dev
```

Then open `http://localhost:42069`.

## Data persistence

Calendar data is stored in the named Docker volume `hearthboard-data`. If you want a bind-mounted folder instead, replace the volume section in [docker-compose.yml](C:\Users\jody4\OneDrive\Documents\New project\docker-compose.yml) with a host path mapping.

## API

- `GET /api/bootstrap`
- `GET /api/health`
- `GET /api/assistant/status`
- `POST /api/assistant/power`
- `POST /api/assistant/chat`
- `POST /api/members`
- `PATCH /api/members/:memberId`
- `DELETE /api/members/:memberId`
- `POST /api/events`
- `PATCH /api/events/:eventId`
- `DELETE /api/events/:eventId`
- `POST /api/bulletins`
- `PATCH /api/bulletins/:bulletinId`
- `DELETE /api/bulletins/:bulletinId`
- `GET /api/media/libraries`
- `GET /api/media/browse`
- `GET /api/media/search`
- `GET /media/:library/...`

## Notes

- The app seeds only `Jody` into a fresh household database.
- Update `HOUSEHOLD_NAME` and `APP_TIMEZONE` in [docker-compose.yml](C:\Users\jody4\OneDrive\Documents\New project\docker-compose.yml) if you want different defaults.
- The Docker setup mounts `E:\Drone`, `D:\Home\Japan-photos`, and `D:\Home\Pictures` as read-only gallery libraries.
- Video thumbnails are generated on demand and cached under Hearthboard's own data directory, so the original media library stays read-only.
- The `Jody AI` tab expects the local model runtime to be running on the Windows host at `http://localhost:11434`, which the Docker container reaches through `http://host.docker.internal:11434`.
- After installing the local runtime, run [setup-hearthboard-ai.ps1](C:\Users\jody4\OneDrive\Documents\New project\scripts\setup-hearthboard-ai.ps1) to pull `qwen2.5:7b` and create the custom `hearthboard-assistant` model alias.
- The site can now wake `Jody AI` into memory or put it back to sleep from the web page. Normal chat requests still send `keep_alive: 0`, so the local model unloads immediately after each response unless you explicitly wake it first.
- The `General` gallery library excludes the `Pretty Pictures` subfolder so it stays hidden from Hearthboard.
- Run `node .\scripts\prewarm-gallery-thumbnails.mjs` if you want to pre-generate thumbnail caches instead of waiting for first-view requests.
- Use [start-hearthboard.ps1](C:\Users\jody4\OneDrive\Documents\New project\scripts\start-hearthboard.ps1) and [stop-hearthboard.ps1](C:\Users\jody4\OneDrive\Documents\New project\scripts\stop-hearthboard.ps1) if you want simple Windows-friendly launch commands.
- To install automatic startup at Windows sign-in, run [install-hearthboard-autostart.ps1](C:\Users\jody4\OneDrive\Documents\New project\scripts\install-hearthboard-autostart.ps1).
- To remove automatic startup later, run [uninstall-hearthboard-autostart.ps1](C:\Users\jody4\OneDrive\Documents\New project\scripts\uninstall-hearthboard-autostart.ps1).
