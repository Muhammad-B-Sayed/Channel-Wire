# ChannelWire

ChannelWire is a production-style real-time messaging platform. It combines a C11 TCP messaging core, a FastAPI REST/WebSocket gateway, PostgreSQL-backed persistence, and a React + TypeScript dashboard for browser chat and server monitoring.

The project is intentionally built like a deployable system, not just a local socket demo: it has Docker Compose, database migrations, GitHub Actions CI, sanitizer builds, integration tests, load tests, malformed-frame tests, a Render backend configuration, and a Vercel frontend configuration.

## Features

- Concurrent C messaging server using POSIX sockets, non-blocking I/O, and `poll()`.
- Compact custom binary protocol with length-prefixed frames.
- Channel chat, direct messages, nicknames, joins/leaves, user listing, channel listing, graceful quit, and server stats.
- Backpressure-safe outgoing queues that disconnect slow clients before memory grows without bound.
- Malformed frame and oversized payload rejection.
- FastAPI gateway exposing authenticated REST and WebSocket APIs.
- PostgreSQL or SQLite persistence for users, channels, memberships, and message history.
- Alembic migrations, including support for sharing one PostgreSQL database through `CHANNELWIRE_DB_SCHEMA`.
- React + TypeScript dashboard with dark UI, auth, WebSocket chat, direct messages, history, slash commands, and monitoring panels.
- Docker Compose stack for local full-system runs.
- Render backend deployment and Vercel frontend deployment support.

## Architecture

```text
Browser / React dashboard
  -> REST + WebSocket over HTTPS
  -> FastAPI gateway on Render
  -> private TCP connection to local C core
  -> PostgreSQL persistence
```

In local Docker Compose, the pieces run as separate services:

```text
frontend -> gateway -> core
             |
             v
          postgres
```

In Render production, the backend runs the FastAPI gateway and C core inside one Docker container. Only FastAPI is public. The C core binds privately to `127.0.0.1:5555`.

## Project Layout

```text
core/                  C TCP messaging server and protocol code
gateway/               FastAPI app, SQLAlchemy models, Alembic migrations
frontend/              React + TypeScript + Vite dashboard
tools/                 Local CLI client helpers
tests/                 Integration, gateway, migration, load, malformed tests
deploy/render/         Render Dockerfile and startup script
docs/                  Deployment notes, benchmark artifacts, requirement audit
.github/workflows/     GitHub Actions CI
Dockerfile             Render-compatible backend image fallback
Dockerfile.core        Standalone C-core image for Docker Compose
docker-compose.yml     Local full-stack development stack
render.yaml            Render Blueprint/service configuration
vercel.json            Vercel frontend build configuration
```

## Quick Start With Docker

Start the full local stack:

```sh
CHANNELWIRE_POSTGRES_PUBLISHED_PORT=15432 docker compose up --build
```

Use `15432` if your machine already has PostgreSQL running on `5432`. If port `5432` is free, this also works:

```sh
docker compose up --build
```

Open:

```text
Dashboard: http://127.0.0.1:3000
Gateway:   http://127.0.0.1:8000
Health:    http://127.0.0.1:8000/health
Core TCP:  127.0.0.1:5555
Postgres:  127.0.0.1:15432 or 127.0.0.1:5432
```

Stop the stack:

```sh
docker compose down
```

Remove the local Postgres volume if you want a clean database:

```sh
docker compose down -v
```

## Dashboard Usage

The dashboard is the main app UI. Locally it is available at `http://127.0.0.1:3000`.

1. Register a username and password, or use Dev Token in local/demo mode.
2. Log in to receive a JWT.
3. Connect to the WebSocket gateway.
4. Join a channel, send channel messages, send direct messages, inspect history, and monitor server stats.

Production disables Dev Token by default with:

```text
CHANNELWIRE_ENABLE_DEV_TOKEN=0
VITE_ENABLE_DEV_TOKEN=0
```

Supported chat slash commands:

```text
/help
/clear
/join CHANNEL
/switch CHANNEL
/leave CHANNEL
/dm USER MESSAGE
/who
/list
/stats
/history
/quit
```

The visible message list is capped to the latest 80 entries so the page does not grow forever. Older visible entries drop off as new events arrive. Persisted message history is still available through the History button and REST history endpoints.

## Running Pieces Manually

Build and run the C core:

```sh
make
./build/channelwire-server 5555
```

The C server binds to `127.0.0.1` by default. To expose it from a container, set:

```sh
CW_BIND_HOST=0.0.0.0 ./build/channelwire-server 5555
```

Connect with the local CLI:

```sh
python3 tools/cw_client.py alice
```

Install and run the gateway:

```sh
python3 -m pip install -r gateway/requirements.txt
uvicorn gateway.app.main:app --reload --port 8000
```

Install and run the frontend:

```sh
npm --prefix frontend install
npm --prefix frontend run dev
```

The frontend defaults to `http://127.0.0.1:8000`. Use `VITE_GATEWAY_URL` if the gateway is somewhere else.

## Authentication

Register:

```sh
curl -X POST http://127.0.0.1:8000/auth/register \
  -H 'content-type: application/json' \
  -d '{"username":"alice","password":"correct-horse-battery"}'
```

Log in:

```sh
curl -X POST http://127.0.0.1:8000/auth/login \
  -H 'content-type: application/json' \
  -d '{"username":"alice","password":"correct-horse-battery"}'
```

Local/demo Dev Token:

```sh
curl -X POST http://127.0.0.1:8000/auth/dev-token \
  -H 'content-type: application/json' \
  -d '{"username":"alice"}'
```

Use the returned token as a bearer token:

```sh
curl -H "authorization: Bearer TOKEN" http://127.0.0.1:8000/stats
```

WebSockets use the same token as a query parameter:

```text
ws://127.0.0.1:8000/ws?token=TOKEN
```

Example WebSocket commands:

```json
{"type":"join","channel":"general"}
{"type":"say","text":"hello"}
{"type":"dm","to":"bob","text":"private hello"}
{"type":"stats"}
{"type":"quit"}
```

## REST Endpoints

Useful unauthenticated endpoints:

```text
GET /          gateway status
GET /health   health check
```

Authenticated endpoints:

```text
POST /auth/register
POST /auth/login
POST /auth/dev-token
GET  /stats
GET  /core-stats
GET  /history/{channel}
GET  /history/dm/{other_username}
GET  /db/users
GET  /db/channels
GET  /db/channels/{channel}/members
WS   /ws?token=...
```

## Binary TCP Protocol

Each core frame uses:

```text
1 byte  message type
4 bytes payload length, network byte order
N bytes payload
```

String fields inside payloads use:

```text
2 bytes string length, network byte order
N bytes UTF-8 string content, no trailing NUL
```

Client message types:

| Type | Name | Payload |
| ---: | --- | --- |
| 1 | `HELLO` | username string |
| 2 | `JOIN` | channel string |
| 3 | `SWITCH` | channel string |
| 4 | `LEAVE` | channel string |
| 5 | `SAY` | message string |
| 6 | `DM` | target username string, message string |
| 7 | `WHO` | empty |
| 8 | `LIST` | empty |
| 9 | `NICK` | username string |
| 10 | `QUIT` | empty |
| 11 | `STATS` | empty |

Server message types:

| Type | Name | Payload |
| ---: | --- | --- |
| 101 | `OK` | UTF-8 status text |
| 102 | `ERROR` | UTF-8 error text |
| 103 | `CHAT` | channel string, sender string, message string |
| 104 | `DM_RECV` | sender string, message string |
| 105 | `SYSTEM` | UTF-8 notification text |
| 106 | `WHO_RESP` | newline-delimited users |
| 107 | `LIST_RESP` | newline-delimited channels |
| 108 | `STATS_RESP` | JSON server stats |

## Database And Migrations

The gateway uses SQLAlchemy and Alembic.

Default local database:

```text
sqlite:///./channelwire.db
```

Docker Compose database:

```text
postgresql+psycopg://channelwire:channelwire@postgres:5432/channelwire
```

Apply migrations manually:

```sh
make migrate-db
```

The gateway also runs migrations on startup.

### Sharing One Render PostgreSQL Database

Render free plans may only allow one PostgreSQL database. ChannelWire supports sharing that database safely through a dedicated schema:

```text
CHANNELWIRE_DATABASE_URL=<your existing Render internal database URL>
CHANNELWIRE_DB_SCHEMA=channelwire
```

With that setting, ChannelWire creates:

```text
channelwire.users
channelwire.channels
channelwire.memberships
channelwire.messages
channelwire.alembic_version
```

This avoids colliding with another project using the same database.

## Deployment

The intended public deployment is:

```text
Backend:  Render Docker web service
Frontend: Vercel Vite app
Database: Render PostgreSQL
```

### Render Backend

Use the repo root as the Render root directory.

Recommended Render settings:

```text
Runtime: Docker
Root Directory: blank / repo root
Dockerfile Path: deploy/render/Dockerfile
Health Check Path: /health
```

The root `Dockerfile` also builds the same HTTP backend as a fallback because Render may still build the root Dockerfile if the dashboard setting is wrong or stale.

Render environment variables:

```text
CHANNELWIRE_DATABASE_URL=<Render internal PostgreSQL URL>
CHANNELWIRE_DB_SCHEMA=channelwire
CHANNELWIRE_JWT_SECRET=<long random secret>
CHANNELWIRE_ENABLE_DEV_TOKEN=0
CHANNELWIRE_CORS_ORIGINS=https://your-production-vercel-domain.vercel.app
CHANNELWIRE_CORS_ORIGIN_REGEX=https://.*\.vercel\.app
```

Use the Render **Internal Database URL**, not the `PGPASSWORD=... psql ...` command.

After deploy, these should work:

```text
https://your-render-service.onrender.com/
https://your-render-service.onrender.com/health
```

Expected `/health` response:

```json
{"status":"ok","core_host":"127.0.0.1","core_port":5555}
```

Render logs should show Python/FastAPI/Uvicorn behavior. If logs show only:

```text
channelwire server listening on 0.0.0.0:5555
No open HTTP ports detected
```

then Render is running the old C-core-only image or an old commit. Deploy the latest branch/commit and clear the build cache.

### Vercel Frontend

You can deploy Vercel with the repo root set to `frontend`.

Recommended Vercel settings:

```text
Framework Preset: Vite
Root Directory: frontend
Install Command: npm install
Build Command: npm run build
Output Directory: dist
```

Vercel environment variables:

```text
VITE_GATEWAY_URL=https://your-render-service.onrender.com
VITE_ENABLE_DEV_TOKEN=0
```

No trailing slash is needed on `VITE_GATEWAY_URL`.

The repo's `vercel.json` is written for the `frontend` root:

```json
{
  "buildCommand": "npm run build",
  "installCommand": "npm install",
  "outputDirectory": "dist"
}
```

If Vercel root is `frontend`, do not use commands like `npm --prefix frontend install`; that makes Vercel look for `frontend/frontend/package.json`.

After changing Vercel environment variables, redeploy Vercel. If builds behave strangely, choose **Clear cache and redeploy**.

### CORS

If the browser says `Failed to fetch` but `https://your-render-service.onrender.com/health` works directly, it is usually CORS.

For production only:

```text
CHANNELWIRE_CORS_ORIGINS=https://your-production-vercel-domain.vercel.app
```

For Vercel preview deployments:

```text
CHANNELWIRE_CORS_ORIGIN_REGEX=https://.*\.vercel\.app
```

You can test CORS with:

```sh
curl -i -X OPTIONS \
  -H 'Origin: https://your-vercel-domain.vercel.app' \
  -H 'Access-Control-Request-Method: GET' \
  https://your-render-service.onrender.com/health
```

Working CORS should return `200` and an `access-control-allow-origin` header matching your Vercel origin.

## Tests And Verification

Common verification commands:

```sh
make test
make test-gateway
make test-migrations
make frontend-build
docker compose config
docker build -f Dockerfile -t channelwire-render-test .
docker build -f Dockerfile.core -t channelwire-core-test .
```

Full test/benchmark targets:

```sh
make test
make test-load
make test-lifecycle
make test-backpressure
make test-malformed
make test-gateway
make test-migrations
make test-compose
make benchmark
make soak
make sanitize
```

What they cover:

| Target | Purpose |
| --- | --- |
| `make test` | core registration, chat, DMs, listings, graceful quit, oversized frames |
| `make test-load` | concurrent TCP clients against the binary protocol |
| `make benchmark` | larger load test with JSON report in `docs/benchmarks/latest-load.json` |
| `make soak` | repeated concurrent-client rounds with JSON report in `docs/benchmarks/latest-soak.json` |
| `make test-lifecycle` | duplicate usernames, joins/switches/leaves, renames, quit behavior |
| `make test-backpressure` | slow-reader disconnects and continued service for other clients |
| `make test-malformed` | invalid usernames, truncated strings, unknown types, oversized frames |
| `make test-gateway` | FastAPI auth/stats/history/WebSocket smoke path with the C core |
| `make test-migrations` | fresh Alembic upgrade and legacy schema adoption |
| `make test-compose` | full Docker Compose stack smoke test |
| `make sanitize` | sanitizer-enabled C build |

GitHub Actions runs CI from `.github/workflows/ci.yml`.

## Troubleshooting

### Docker says PostgreSQL port 5432 is already in use

Run Compose with a different published port:

```sh
CHANNELWIRE_POSTGRES_PUBLISHED_PORT=15432 docker compose up --build
```

### Render says `No open HTTP ports detected`

Render is not running the FastAPI backend image. Confirm:

```text
Root Directory: blank / repo root
Dockerfile Path: deploy/render/Dockerfile
Health Check Path: /health
```

Also make sure Render is deploying the branch and commit that contain the current Docker changes. The build should use `python:3.12-slim`, not the old Alpine-only C-core image.

### Render root URL shows `{"detail":"Not Found"}`

That means an older backend commit is deployed. Current versions include `GET /`, which returns gateway status. `GET /health` is the important health check either way.

### Vercel build looks for `frontend/frontend/package.json`

The Vercel root is already `frontend`, but the commands still include `--prefix frontend`. Use:

```text
Install Command: npm install
Build Command: npm run build
Output Directory: dist
```

### Frontend says `Failed to fetch`

Check:

```text
VITE_GATEWAY_URL=https://your-render-service.onrender.com
CHANNELWIRE_CORS_ORIGINS=https://your-vercel-domain.vercel.app
CHANNELWIRE_CORS_ORIGIN_REGEX=https://.*\.vercel\.app
```

Redeploy both services after environment variable changes.

### Dev Token does not show in production

That is expected. Production should use:

```text
CHANNELWIRE_ENABLE_DEV_TOKEN=0
VITE_ENABLE_DEV_TOKEN=0
```

Use Register/Login in production.

## Requirement Evidence

See `docs/requirements-audit.md` for a requirement-by-requirement evidence map and verification commands.

Deployment-specific notes live in `docs/deployment.md`.
