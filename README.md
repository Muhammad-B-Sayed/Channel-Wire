# ChannelWire

ChannelWire is a production-style real-time messaging platform in progress. It includes a C11 TCP messaging core with non-blocking sockets, `poll()` multiplexing, a compact binary protocol, bounded outgoing queues, malformed-frame rejection, a FastAPI WebSocket/REST gateway, database-backed message history for gateway traffic, and a React + TypeScript dashboard.

## Current Architecture

```text
React TypeScript dashboard
   |
   | JSON over REST + WebSocket
   v
FastAPI gateway
   |
   | ChannelWire binary protocol over TCP
   v
C messaging core
   |
   | gateway persistence path
   v
PostgreSQL
```

Planned layers include richer gateway APIs and deeper dashboard monitoring.

## Binary Protocol

Each frame uses:

```text
1 byte  message type
4 bytes payload length, network byte order
N bytes payload
```

String fields inside payloads use:

```text
2 bytes string length, network byte order
N bytes string content, no trailing NUL
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

## Build and Run

```sh
make
./build/channelwire-server 5555
```

The server binds to `127.0.0.1` by default. Set `CW_BIND_HOST=0.0.0.0` when running in a container or when you intentionally want to expose it beyond localhost.

In another terminal, connect with the development CLI:

```sh
python3 tools/cw_client.py alice
```

Useful commands include `/join general`, plain text to send to the active channel, `/dm USER MESSAGE`, `/who`, `/list`, `/stats`, and `/quit`.

## Test

```sh
make test
make test-load
make test-lifecycle
make test-backpressure
make test-malformed
make test-compose
make sanitize
```

`make test` starts the server on an ephemeral local port and verifies registration, channel chat, direct messages, user/channel listing, graceful quit, and malformed oversized frame handling.

`make test-load` starts the server and runs a concurrent TCP client test against the binary protocol, then prints elapsed time, client-message throughput, server channel-message count, and total connection count.

`make test-lifecycle` verifies duplicate username rejection, joining multiple channels, switching active channels, renaming users, leaving channels, and graceful quit behavior.

`make test-backpressure` starts the server with intentionally tiny write queues and send buffers, then verifies that a slow reader is disconnected while other clients continue to exchange messages and request stats.

`make test-malformed` sends invalid usernames, truncated string payloads, unknown message types, and oversized frames, then verifies error responses and server health afterward.

`make test-compose` builds and runs the full Docker Compose stack, then verifies the gateway, PostgreSQL-backed auth/stats APIs, C core stats through the gateway, and the React dashboard HTTP surface.

## Docker

```sh
docker compose up --build
```

This runs the C core on `127.0.0.1:5555` through Docker port publishing. Stop it with:

```sh
docker compose down
```

The React dashboard is available at `http://127.0.0.1:3000`, the gateway is available at `http://127.0.0.1:8000`, and PostgreSQL is published on `127.0.0.1:5432` when Docker Compose is running.

## Gateway

Install the gateway dependencies:

```sh
python3 -m pip install -r gateway/requirements.txt
```

Start the C core:

```sh
make
./build/channelwire-server 5555
```

Start the gateway:

```sh
uvicorn gateway.app.main:app --reload --port 8000
```

Register or log in to receive a JWT:

```sh
curl -X POST http://127.0.0.1:8000/auth/register \
  -H 'content-type: application/json' \
  -d '{"username":"alice","password":"correct-horse-battery"}'

curl -X POST http://127.0.0.1:8000/auth/login \
  -H 'content-type: application/json' \
  -d '{"username":"alice","password":"correct-horse-battery"}'
```

For quick local demos, create a development JWT without a password:

```sh
curl -X POST http://127.0.0.1:8000/auth/dev-token \
  -H 'content-type: application/json' \
  -d '{"username":"alice"}'
```

Use the returned token with `GET /channels?token=...` or connect a WebSocket to `/ws?token=...`. WebSocket commands are JSON objects:

```json
{"type":"join","channel":"general"}
{"type":"say","text":"hello from the browser side"}
{"type":"dm","to":"bob","text":"private hello"}
```

Gateway WebSocket traffic is persisted through SQLAlchemy. Docker Compose uses PostgreSQL; local smoke tests use an isolated SQLite database. Retrieve channel history with:

```sh
curl 'http://127.0.0.1:8000/history/general?token=TOKEN'
```

Retrieve direct-message history with another user:

```sh
curl 'http://127.0.0.1:8000/history/dm/bob?token=TOKEN'
```

Inspect persisted users, channels, and memberships:

```sh
curl 'http://127.0.0.1:8000/db/users?token=TOKEN'
curl 'http://127.0.0.1:8000/db/channels?token=TOKEN'
curl 'http://127.0.0.1:8000/db/channels/general/members?token=TOKEN'
```

Retrieve platform counters for basic monitoring with:

```sh
curl 'http://127.0.0.1:8000/stats?token=TOKEN'
```

## Frontend

Install and run the dashboard locally:

```sh
npm --prefix frontend install
npm --prefix frontend run dev
```

The dashboard connects to `http://127.0.0.1:8000` by default. Set `VITE_GATEWAY_URL` before building if the gateway runs somewhere else. It can register/login for a JWT, use a dev token for demos, connect to the WebSocket gateway, and show gateway health, core address, live core users/channels, persisted users/channels/memberships/messages, queue disconnects, and local event counts.

## Roadmap

- Add refresh-token/session management beyond short-lived bearer JWTs.
- Add deeper visualizations for message rates and queue pressure.
- Add larger soak tests and exported benchmark reports.
