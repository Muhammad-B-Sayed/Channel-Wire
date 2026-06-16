#!/usr/bin/env python3
import argparse
import os
import socket
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))

from channelwire_client import (  # noqa: E402
    CHAT,
    ERROR,
    JOIN,
    LEAVE,
    LIST,
    LIST_RESP,
    NICK,
    OK,
    QUIT,
    SAY,
    SWITCH,
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


def expect_text(sock: socket.socket, msg_type: int, text: bytes) -> None:
    got = read_frame(sock)
    assert got.msg_type == msg_type, got
    assert got.payload == text, got.payload


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

        alice = connect_registered("127.0.0.1", port, "alice", timeout=3)
        sockets.append(alice)

        duplicate = socket.create_connection(("127.0.0.1", port), timeout=3)
        duplicate.settimeout(3)
        sockets.append(duplicate)
        send_frame(duplicate, 1, string_payload("alice"))
        expect_text(duplicate, ERROR, b"username already in use")

        send_frame(alice, JOIN, string_payload("alpha"))
        expect_text(alice, OK, b"joined alpha")
        send_frame(alice, JOIN, string_payload("beta"))
        expect_text(alice, OK, b"joined beta")

        send_frame(alice, SWITCH, string_payload("alpha"))
        expect_text(alice, OK, b"switched alpha")
        send_frame(alice, SAY, string_payload("alpha hello"))
        got = read_frame(alice)
        assert got.msg_type == CHAT
        assert decode_strings(got.payload) == ["alpha", "alice", "alpha hello"]

        send_frame(alice, NICK, string_payload("alice2"))
        expect_text(alice, OK, b"username changed")
        send_frame(alice, SAY, string_payload("renamed hello"))
        got = read_frame(alice)
        assert got.msg_type == CHAT
        assert decode_strings(got.payload) == ["alpha", "alice2", "renamed hello"]

        send_frame(alice, LEAVE, string_payload("alpha"))
        expect_text(alice, OK, b"left channel")
        send_frame(alice, SAY, string_payload("should fail"))
        expect_text(alice, ERROR, b"join a channel before sending")

        send_frame(alice, SWITCH, string_payload("beta"))
        expect_text(alice, OK, b"switched beta")
        send_frame(alice, LIST)
        got = read_frame(alice)
        assert got.msg_type == LIST_RESP
        listed = set(got.payload.decode("utf-8").splitlines())
        assert {"alpha", "beta"} <= listed

        send_frame(alice, QUIT)
        send_frame(duplicate, QUIT)
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
