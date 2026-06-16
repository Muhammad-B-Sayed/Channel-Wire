#!/usr/bin/env python3
import argparse
import json
import os
import queue
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))

from channelwire_client import (  # noqa: E402
    CHAT,
    JOIN,
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


def read_until_chat(sock: socket.socket, expected_text: str, deadline: float) -> None:
    while time.time() < deadline:
        frame = read_frame(sock)
        if frame.msg_type != CHAT:
            continue
        channel, sender, text = decode_strings(frame.payload)
        if channel == "load" and text == expected_text and sender.startswith("client"):
            return
    raise AssertionError(f"did not receive chat payload {expected_text!r}")


def client_worker(port: int, idx: int, ready: threading.Barrier, errors: queue.Queue[str]) -> None:
    username = f"client{idx}"
    message = f"message-{idx}"
    try:
        with connect_registered("127.0.0.1", port, username, timeout=5) as sock:
            send_frame(sock, JOIN, string_payload("load"))
            ready.wait(timeout=10)
            send_frame(sock, SAY, string_payload(message))
            read_until_chat(sock, message, time.time() + 10)
            send_frame(sock, QUIT)
    except Exception as exc:  # noqa: BLE001 - test needs to collect thread failures.
        errors.put(f"{username}: {exc}")


def read_stats(port: int) -> dict[str, int]:
    with connect_registered("127.0.0.1", port, "loadobserver", timeout=5) as sock:
        send_frame(sock, STATS)
        deadline = time.time() + 5
        while time.time() < deadline:
            frame = read_frame(sock)
            if frame.msg_type == STATS_RESP:
                return json.loads(frame.payload)
    raise AssertionError("did not receive load-test stats")


def run(server: str, clients: int) -> None:
    port = pick_port()
    proc = subprocess.Popen(
        [server, str(port)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
    )
    try:
        wait_for_port(port)

        errors: queue.Queue[str] = queue.Queue()
        ready = threading.Barrier(clients)
        threads = [
            threading.Thread(target=client_worker, args=(port, i, ready, errors), daemon=True)
            for i in range(clients)
        ]

        start = time.monotonic()
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=15)
        elapsed = time.monotonic() - start

        alive = [thread.name for thread in threads if thread.is_alive()]
        if alive:
            raise AssertionError(f"load-test threads did not finish: {alive}")
        if not errors.empty():
            failures = []
            while not errors.empty():
                failures.append(errors.get())
            raise AssertionError("\n".join(failures))

        stats = read_stats(port)
        assert stats["channel_messages"] >= clients, stats
        messages_per_second = clients / elapsed if elapsed > 0 else 0
        print(
            "load-test summary: "
            f"clients={clients} elapsed={elapsed:.3f}s "
            f"client_messages_per_second={messages_per_second:.1f} "
            f"server_channel_messages={stats['channel_messages']} "
            f"total_connections={stats['total_connections']}"
        )
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
    parser.add_argument("--clients", type=int, default=24)
    args = parser.parse_args()
    run(os.path.abspath(args.server), args.clients)


if __name__ == "__main__":
    main()
