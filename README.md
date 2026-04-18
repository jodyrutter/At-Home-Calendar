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
- HTTPS via Caddy, with a public cert for your real domain and a local cert for LAN/localhost access

## Run it with Docker

```powershell
docker compose up --build -d
```

Or use the included launcher:

```powershell
.\scripts\start-hearthboard.ps1
```

Then open:

- `https://jodyrutter-sh.duckdns.org`
- `https://jodyrutter-sh.duckdns.org:42069`
- `https://localhost`
- `https://localhost:42069`
- `https://YOUR-WINDOWS-IP`
- `https://YOUR-WINDOWS-IP:42069`

On the first HTTPS run, trust the local certificate on this Windows machine with:

```powershell
.\scripts\install-hearthboard-local-ca.ps1
```

If you want to install that same trust root on another device later, export it with:

```powershell
.\scripts\export-hearthboard-local-ca.ps1
```

That writes the certificate to `local-certs\hearthboard-local-root.crt`, which you can import on phones, tablets, or other PCs you trust if they use the LAN IP or `localhost` variant. Devices using your public domain should use the public certificate instead and normally will not need the local CA installed.

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
- When you wake `Jody AI`, it now auto-sleeps after `5m` without a new question. Each new chat refreshes that timer.
- `Jody AI` can also browse the web when you enable the `Use web search for this reply` toggle on the assistant page.
- If `BRAVE_SEARCH_API_KEY` is set, Hearthboard uses the Brave Search API. Otherwise it falls back to a best-effort DuckDuckGo search flow.
- Web result fetching blocks localhost and common private-network targets by default so the search tool does not wander into your LAN or Docker host services.
- The `General` gallery library excludes the `Pretty Pictures` subfolder so it stays hidden from Hearthboard.
- Run `node .\scripts\prewarm-gallery-thumbnails.mjs` if you want to pre-generate thumbnail caches instead of waiting for first-view requests.
- Use [start-hearthboard.ps1](C:\Users\jody4\OneDrive\Documents\New project\scripts\start-hearthboard.ps1) and [stop-hearthboard.ps1](C:\Users\jody4\OneDrive\Documents\New project\scripts\stop-hearthboard.ps1) if you want simple Windows-friendly launch commands.
- To install automatic startup at Windows sign-in, run [install-hearthboard-autostart.ps1](C:\Users\jody4\OneDrive\Documents\New project\scripts\install-hearthboard-autostart.ps1).
- To remove automatic startup later, run [uninstall-hearthboard-autostart.ps1](C:\Users\jody4\OneDrive\Documents\New project\scripts\uninstall-hearthboard-autostart.ps1).
- Remote internet access can be password-protected on selected pages. Right now `Calendar` and `Jody AI` are protected remotely, while `Gallery` stays public.
- LAN access keeps all current pages open without a password.
- Set or update the remote-access password locally on this machine with [set-hearthboard-remote-password.ps1](C:\Users\jody4\OneDrive\Documents\New project\scripts\set-hearthboard-remote-password.ps1).
- HTTPS is terminated by Caddy in Docker and proxied to the Node app over the internal Docker network.
- The public domain `jodyrutter-sh.duckdns.org` now uses Caddy's normal automatic HTTPS for browser-trusted certificates.
- `localhost` and the LAN IP still use Caddy's `tls internal` mode, so the local CA export/install scripts are still useful for direct in-home IP access.
