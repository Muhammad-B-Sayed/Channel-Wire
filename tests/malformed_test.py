#!/usr/bin/env python3
import argparse
import json
import os
import socket
import struct
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))

from channelwire_client import (  # noqa: E402
    ERROR,
    HELLO,
    OK,
    QUIT,
    STATS,
    STATS_RESP,
    connect_registered,
    encode_frame,
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


def expect_error(sock: socket.socket, expected: bytes) -> None:
    got = read_frame(sock)
    assert got.msg_type == ERROR, got
    assert expected in got.payload, got.payload


def run(server: str) -> None:
    port = pick_port()
    proc = subprocess.Popen(
        [server, str(port)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
    )
    sockets: list[socket.socket] = []
    try:
        wait_for_port(port)

        bad_name = socket.create_connection(("127.0.0.1", port), timeout=3)
        bad_name.settimeout(3)
        sockets.append(bad_name)
        send_frame(bad_name, HELLO, string_payload("bad name with spaces"))
        expect_error(bad_name, b"invalid username")

        truncated_string = socket.create_connection(("127.0.0.1", port), timeout=3)
        truncated_string.settimeout(3)
        sockets.append(truncated_string)
        truncated_string.sendall(encode_frame(HELLO, struct.pack("!H", 8) + b"short"))
        expect_error(truncated_string, b"invalid username")

        unknown = socket.create_connection(("127.0.0.1", port), timeout=3)
        unknown.settimeout(3)
        sockets.append(unknown)
        unknown.sendall(encode_frame(250))
        expect_error(unknown, b"unknown message type")

        oversized = socket.create_connection(("127.0.0.1", port), timeout=3)
        oversized.settimeout(3)
        sockets.append(oversized)
        oversized.sendall(struct.pack("!BI", HELLO, 5000))
        expect_error(oversized, b"malformed frame")

        observer = connect_registered("127.0.0.1", port, "observer", timeout=3)
        sockets.append(observer)
        send_frame(observer, STATS)
        got = read_frame(observer)
        assert got.msg_type == STATS_RESP, got
        stats = json.loads(got.payload)
        assert stats["malformed_frames"] >= 1, stats
        assert stats["current_connections"] >= 1, stats
        send_frame(observer, QUIT)

        post_check = connect_registered("127.0.0.1", port, "healthy", timeout=3)
        sockets.append(post_check)
        send_frame(post_check, STATS)
        got = read_frame(post_check)
        assert got.msg_type == STATS_RESP, got
        send_frame(post_check, QUIT)
    finally:
        for sock in sockets:
            try:
                sock.close()
            except OSError:
                pass
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
