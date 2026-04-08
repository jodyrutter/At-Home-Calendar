# Hearthboard

Hearthboard is a self-hosted household calendar and scheduling board you can run on your own Windows machine in Docker and share across your local network.

## What it includes

- Shared month-view calendar with a focused day agenda
- Upcoming event rail for quick planning
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
- `POST /api/members`
- `PATCH /api/members/:memberId`
- `DELETE /api/members/:memberId`
- `POST /api/events`
- `PATCH /api/events/:eventId`
- `DELETE /api/events/:eventId`

## Notes

- The app seeds a few starter household members and events the first time it boots so the board is not empty.
- Update `HOUSEHOLD_NAME` and `APP_TIMEZONE` in [docker-compose.yml](C:\Users\jody4\OneDrive\Documents\New project\docker-compose.yml) if you want different defaults.
- Use [start-hearthboard.ps1](C:\Users\jody4\OneDrive\Documents\New project\scripts\start-hearthboard.ps1) and [stop-hearthboard.ps1](C:\Users\jody4\OneDrive\Documents\New project\scripts\stop-hearthboard.ps1) if you want simple Windows-friendly launch commands.
