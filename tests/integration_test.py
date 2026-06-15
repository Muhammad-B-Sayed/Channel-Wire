#!/usr/bin/env python3
import argparse
import os
import socket
import struct
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))

from channelwire_client import (
    CHAT,
    DM,
    DM_RECV,
    ERROR,
    HELLO,
    JOIN,
    LIST,
    LIST_RESP,
    OK,
    QUIT,
    SAY,
    SYSTEM,
    WHO,
    WHO_RESP,
    connect_registered,
    decode_strings,
    encode_frame,
    read_frame,
    send_frame,
    string_payload,
)


def connect_client(port: int, username: str) -> socket.socket:
    return connect_registered("127.0.0.1", port, username)


def wait_for_port(port: int) -> None:
    deadline = time.time() + 5
    while time.time() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.2):
                return
        except OSError:
            time.sleep(0.05)
    raise AssertionError(f"server did not listen on {port}")


def pick_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


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
    try:
        wait_for_port(port)

        alice = connect_client(port, "alice")
        bob = connect_client(port, "bob")
        expect_text(alice, SYSTEM, b"bob connected")

        send_frame(alice, JOIN, string_payload("general"))
        expect_text(alice, OK, b"joined general")
        send_frame(bob, JOIN, string_payload("general"))
        expect_text(bob, OK, b"joined general")

        send_frame(alice, SAY, string_payload("hello from alice"))
        got = read_frame(alice)
        assert got.msg_type == CHAT
        assert decode_strings(got.payload) == ["general", "alice", "hello from alice"]
        got = read_frame(bob)
        assert got.msg_type == CHAT
        assert decode_strings(got.payload) == ["general", "alice", "hello from alice"]

        send_frame(bob, DM, string_payload("alice", "private ping"))
        expect_text(bob, OK, b"direct message sent")
        got = read_frame(alice)
        assert got.msg_type == DM_RECV
        assert decode_strings(got.payload) == ["bob", "private ping"]

        send_frame(alice, WHO)
        got = read_frame(alice)
        assert got.msg_type == WHO_RESP
        users = set(got.payload.decode("utf-8").splitlines())
        assert {"alice", "bob"} <= users

        send_frame(alice, LIST)
        got = read_frame(alice)
        assert got.msg_type == LIST_RESP
        assert "general" in got.payload.decode("utf-8").splitlines()

        bad = socket.create_connection(("127.0.0.1", port), timeout=3)
        bad.settimeout(3)
        bad.sendall(struct.pack("!BI", HELLO, 5000))
        got = read_frame(bad)
        assert got.msg_type == ERROR
        assert b"malformed" in got.payload

        alice.sendall(encode_frame(QUIT))
        bob.sendall(encode_frame(QUIT))
        alice.close()
        bob.close()
        bad.close()
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
