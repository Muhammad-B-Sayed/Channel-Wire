# ChannelWire Requirements Audit

This audit maps the resume-scope requirements to current repository evidence.

## Concurrent TCP Messaging Server

Status: implemented and tested.

Evidence:

- C11/POSIX socket server: `core/src/server.c`
- Non-blocking client sockets and `poll()` event loop: `set_nonblocking`, `poll`, `accept_clients`, `read_from_client`, `write_to_client`
- Custom binary frame protocol: `core/include/channelwire/protocol.h`, `core/src/protocol.c`
- Channel communication and direct messaging: `broadcast_chat`, `handle_dm`
- Connection lifecycle: `HELLO`, `JOIN`, `SWITCH`, `LEAVE`, `NICK`, `QUIT`
- Backpressure-safe write queues: bounded `out_frame` queue per client and queue-overflow disconnects
- Core runtime stats: `CW_MSG_STATS` and `CW_MSG_STATS_RESP`

Verification:

```sh
make test
make test-lifecycle
make test-load
make test-backpressure
make test-malformed
make SANITIZE=1 test
make SANITIZE=1 test-lifecycle
make SANITIZE=1 test-backpressure
make SANITIZE=1 test-malformed
```

## Persistent Storage, Gateway, and Dashboard

Status: implemented for gateway traffic.

Evidence:

- FastAPI gateway: `gateway/app/main.py`
- JWT register/login auth with salted PBKDF2 password hashes: `/auth/register`, `/auth/login`, `hash_password`, `verify_password`
- PostgreSQL/SQLAlchemy persistence models: `gateway/app/db.py`
- Persisted users, channels, memberships, channel messages, and direct messages: `User`, `Channel`, `Membership`, `Message`
- REST APIs for health, stats, persisted directories, histories, and core stats: `gateway/app/main.py`
- WebSocket bridge from JSON commands to C binary frames: `/ws`
- React + TypeScript dashboard: `frontend/src/main.tsx`
- Dashboard monitoring: gateway health, core stats, persisted users/channels/memberships/messages, queue disconnects, live users/channels, message-mix meters, queue-pressure meter
- Gateway smoke coverage for browser-style channel broadcast and direct messaging: `tests/gateway_smoke_test.py`

Verification:

```sh
python3 -m pip install -r gateway/requirements.txt
make test-gateway
npm --prefix frontend run build
npm --prefix frontend audit --audit-level=high
```

## Production-Style Workflow

Status: implemented, with one local environment caveat.

Evidence:

- Dockerfile for C core: `Dockerfile`
- Dockerfile for gateway: `gateway/Dockerfile`
- Dockerfile for frontend: `frontend/Dockerfile`
- Docker Compose stack with core, gateway, PostgreSQL, and frontend: `docker-compose.yml`
- GitHub Actions CI: `.github/workflows/ci.yml`
- Sanitizer-enabled C builds: `make SANITIZE=1 ...`
- Automated integration/load/lifecycle/backpressure/malformed/gateway/frontend tests: `tests/`, `Makefile`
- Compose runtime smoke test: `tests/compose_smoke_test.py`

Verification:

```sh
docker compose config
make test-compose
```

Local caveat: `make test-compose` requires a running Docker daemon. In the current local environment, Docker API access is unavailable, so this gate is wired for CI/runtime environments where Docker is available.

## Remaining Nice-to-Haves

These are not required to truthfully support the current resume bullets, but would make the project stronger:

- Larger soak tests and benchmark artifacts.
- Refresh-token or session management beyond bearer JWTs.
- Dashboard time-series charts for message rate, queue pressure, and malformed traffic over time.
- Database migrations through Alembic instead of the current lightweight startup migration.
