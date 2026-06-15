#!/usr/bin/env python3
import argparse
import os
import socket
import struct
import subprocess
import sys
import time


HELLO = 1
JOIN = 2
SAY = 5
DM = 6
WHO = 7
LIST = 8
QUIT = 10

OK = 101
ERROR = 102
CHAT = 103
DM_RECV = 104
WHO_RESP = 106
LIST_RESP = 107


def string_payload(*values: str) -> bytes:
    out = bytearray()
    for value in values:
        encoded = value.encode("utf-8")
        out += struct.pack("!H", len(encoded))
        out += encoded
    return bytes(out)


def frame(msg_type: int, payload: bytes = b"") -> bytes:
    return struct.pack("!BI", msg_type, len(payload)) + payload


def read_frame(sock: socket.socket) -> tuple[int, bytes]:
    header = recv_exact(sock, 5)
    msg_type, length = struct.unpack("!BI", header)
    return msg_type, recv_exact(sock, length)


def recv_exact(sock: socket.socket, length: int) -> bytes:
    chunks = bytearray()
    while len(chunks) < length:
        chunk = sock.recv(length - len(chunks))
        if not chunk:
            raise AssertionError("socket closed before complete frame")
        chunks += chunk
    return bytes(chunks)


def decode_strings(payload: bytes) -> list[str]:
    values = []
    offset = 0
    while offset < len(payload):
        (length,) = struct.unpack("!H", payload[offset : offset + 2])
        offset += 2
        values.append(payload[offset : offset + length].decode("utf-8"))
        offset += length
    return values


def connect_client(port: int, username: str) -> socket.socket:
    sock = socket.create_connection(("127.0.0.1", port), timeout=3)
    sock.settimeout(3)
    sock.sendall(frame(HELLO, string_payload(username)))
    msg_type, payload = read_frame(sock)
    assert (msg_type, payload) == (OK, b"registered")
    return sock


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
    got_type, payload = read_frame(sock)
    assert got_type == msg_type, (got_type, payload)
    assert payload == text, payload


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
        expect_text(alice, 105, b"bob connected")

        alice.sendall(frame(JOIN, string_payload("general")))
        expect_text(alice, OK, b"joined general")
        bob.sendall(frame(JOIN, string_payload("general")))
        expect_text(bob, OK, b"joined general")

        alice.sendall(frame(SAY, string_payload("hello from alice")))
        msg_type, payload = read_frame(alice)
        assert msg_type == CHAT
        assert decode_strings(payload) == ["general", "alice", "hello from alice"]
        msg_type, payload = read_frame(bob)
        assert msg_type == CHAT
        assert decode_strings(payload) == ["general", "alice", "hello from alice"]

        bob.sendall(frame(DM, string_payload("alice", "private ping")))
        expect_text(bob, OK, b"direct message sent")
        msg_type, payload = read_frame(alice)
        assert msg_type == DM_RECV
        assert decode_strings(payload) == ["bob", "private ping"]

        alice.sendall(frame(WHO))
        msg_type, payload = read_frame(alice)
        assert msg_type == WHO_RESP
        users = set(payload.decode("utf-8").splitlines())
        assert {"alice", "bob"} <= users

        alice.sendall(frame(LIST))
        msg_type, payload = read_frame(alice)
        assert msg_type == LIST_RESP
        assert "general" in payload.decode("utf-8").splitlines()

        bad = socket.create_connection(("127.0.0.1", port), timeout=3)
        bad.settimeout(3)
        bad.sendall(struct.pack("!BI", HELLO, 5000))
        msg_type, payload = read_frame(bad)
        assert msg_type == ERROR
        assert b"malformed" in payload

        alice.sendall(frame(QUIT))
        bob.sendall(frame(QUIT))
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
