# ChannelWire

ChannelWire is a production-style real-time messaging platform in progress. The first milestone is a C11 TCP messaging core with non-blocking sockets, `poll()` multiplexing, a compact binary protocol, bounded outgoing queues, malformed-frame rejection, and integration tests.

## Current Architecture

```text
TCP clients
   |
   | ChannelWire binary protocol
   v
C messaging core
```

Planned layers include a FastAPI WebSocket/REST gateway, PostgreSQL persistence, a React TypeScript frontend, Docker Compose, and broader load testing.

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
| 108 | `STATS_RESP` | reserved |

## Build and Run

```sh
make
./build/channelwire-server 5555
```

The server currently binds to `127.0.0.1`.

## Test

```sh
make test
make sanitize
```

`make test` starts the server on an ephemeral local port and verifies registration, channel chat, direct messages, user/channel listing, graceful quit, and malformed oversized frame handling.

## Roadmap

- Add durable message persistence through PostgreSQL or SQLite.
- Add a FastAPI gateway exposing REST and browser WebSocket access.
- Add JWT authentication and membership-aware channel APIs.
- Add Docker Compose for the C core, gateway, database, and frontend.
- Add load tests for concurrent clients and slow-reader backpressure behavior.
