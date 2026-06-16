#!/usr/bin/env python3
import argparse
import json
import os
import socket
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))

from channelwire_client import (  # noqa: E402
    CHAT,
    JOIN,
    OK,
    QUIT,
    SAY,
    STATS,
    STATS_RESP,
    connect_registered,
    decode_strings,
    read_frame,
    send_frame,
    string_payload,
)


def pick_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def wait_for_port(port: int) -> None:
    deadline = time.time() + 5
    while time.time() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.2):
                return
        except OSError:
            time.sleep(0.05)
    raise AssertionError(f"server did not listen on {port}")


def drain_fast_client(sock: socket.socket, expected_text: str | None = None) -> bool:
    saw_expected = False
    deadline = time.time() + 0.05
    sock.settimeout(0.01)
    while time.time() < deadline:
        try:
            frame = read_frame(sock)
        except (TimeoutError, socket.timeout):
            break
        if frame.msg_type == CHAT and expected_text is not None:
            _channel, _sender, text = decode_strings(frame.payload)
            saw_expected = saw_expected or text == expected_text
    sock.settimeout(3)
    return saw_expected


def read_stats(sock: socket.socket) -> dict[str, int]:
    send_frame(sock, STATS)
    deadline = time.time() + 3
    while time.time() < deadline:
        frame = read_frame(sock)
        if frame.msg_type == STATS_RESP:
            return json.loads(frame.payload)
    raise AssertionError("did not receive STATS_RESP")


def run(server: str) -> None:
    port = pick_port()
    env = os.environ.copy()
    env["CW_MAX_QUEUE_BYTES"] = "4096"
    env["CW_CLIENT_SNDBUF"] = "1024"
    proc = subprocess.Popen(
        [server, str(port)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
        env=env,
    )
    try:
        wait_for_port(port)

        slow = connect_registered("127.0.0.1", port, "slow", timeout=3)
        slow.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 1024)
        send_frame(slow, JOIN, string_payload("pressure"))
        joined = read_frame(slow)
        assert (joined.msg_type, joined.payload) == (OK, b"joined pressure")

        fast = connect_registered("127.0.0.1", port, "fast", timeout=3)
        send_frame(fast, JOIN, string_payload("pressure"))
        joined_fast = read_frame(fast)
        assert (joined_fast.msg_type, joined_fast.payload) == (OK, b"joined pressure")

        body = "x" * 1000
        saw_fast_echo = False
        stats = read_stats(fast)
        for i in range(1200):
            text = f"{i:04d}-{body}"
            send_frame(fast, SAY, string_payload(text))
            saw_fast_echo = drain_fast_client(fast, text) or saw_fast_echo

            if i % 25 == 0:
                stats = read_stats(fast)
                if stats["queue_disconnects"] > 0:
                    break

        assert saw_fast_echo, "fast client never received its own channel traffic"
        assert stats["queue_disconnects"] > 0, stats
        assert stats["current_connections"] <= 2, stats

        send_frame(fast, QUIT)
        fast.close()
        slow.close()
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            proc.kill()
        stderr = proc.stderr.read() if proc.stderr is not None else ""
        if proc.returncode not in (0, -15):
            sys.stderr.write(stderr)
            raise AssertionError(f"server exited with {proc.returncode}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--server", required=True)
    args = parser.parse_args()
    run(os.path.abspath(args.server))


if __name__ == "__main__":
    main()
