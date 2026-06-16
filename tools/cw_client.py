#!/usr/bin/env python3
import argparse
import select
import socket
import sys

from channelwire_client import (
    DM,
    JOIN,
    LEAVE,
    LIST,
    NICK,
    QUIT,
    SAY,
    STATS,
    SWITCH,
    WHO,
    connect_registered,
    format_frame,
    read_frame,
    send_frame,
    string_payload,
)


HELP = """commands:
  /join CHANNEL       join and switch to a channel
  /switch CHANNEL     switch active channel
  /leave CHANNEL      leave a channel
  /dm USER MESSAGE    send a direct message
  /nick USER          change username
  /who                list connected users
  /list               list channels
  /stats              show core server stats
  /quit               disconnect
  /help               show this help

Plain text sends a SAY message to the active channel.
"""


def handle_command(sock: socket.socket, line: str) -> bool:
    if not line:
        return True
    if not line.startswith("/"):
        send_frame(sock, SAY, string_payload(line))
        return True

    parts = line.split(" ", 2)
    command = parts[0].lower()

    if command == "/join" and len(parts) >= 2:
        send_frame(sock, JOIN, string_payload(parts[1]))
    elif command == "/switch" and len(parts) >= 2:
        send_frame(sock, SWITCH, string_payload(parts[1]))
    elif command == "/leave" and len(parts) >= 2:
        send_frame(sock, LEAVE, string_payload(parts[1]))
    elif command == "/dm" and len(parts) == 3:
        send_frame(sock, DM, string_payload(parts[1], parts[2]))
    elif command == "/nick" and len(parts) >= 2:
        send_frame(sock, NICK, string_payload(parts[1]))
    elif command == "/who":
        send_frame(sock, WHO)
    elif command == "/list":
        send_frame(sock, LIST)
    elif command == "/stats":
        send_frame(sock, STATS)
    elif command == "/quit":
        send_frame(sock, QUIT)
        return False
    elif command == "/help":
        print(HELP, end="")
    else:
        print("unknown or incomplete command; try /help", file=sys.stderr)

    return True


def run(host: str, port: int, username: str) -> int:
    with connect_registered(host, port, username, timeout=3.0) as sock:
        sock.settimeout(None)
        print(f"connected to {host}:{port} as {username}")
        print(HELP, end="")

        while True:
            readable, _, _ = select.select([sock, sys.stdin], [], [])
            if sock in readable:
                try:
                    print(format_frame(read_frame(sock)))
                except (ConnectionError, OSError) as exc:
                    print(f"disconnected: {exc}", file=sys.stderr)
                    return 1
            if sys.stdin in readable:
                line = sys.stdin.readline()
                if line == "":
                    send_frame(sock, QUIT)
                    return 0
                if not handle_command(sock, line.rstrip("\n")):
                    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Interactive ChannelWire terminal client")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=5555)
    parser.add_argument("username")
    args = parser.parse_args()
    return run(args.host, args.port, args.username)


if __name__ == "__main__":
    raise SystemExit(main())
