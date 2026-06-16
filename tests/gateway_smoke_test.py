#!/usr/bin/env python3
import argparse
import os
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


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
        with tempfile.TemporaryDirectory() as tmpdir:
            os.environ["CHANNELWIRE_CORE_PORT"] = str(port)
            os.environ["CHANNELWIRE_JWT_SECRET"] = "test-secret-with-at-least-32-bytes"
            os.environ["CHANNELWIRE_DATABASE_URL"] = f"sqlite:///{tmpdir}/gateway-test.db"

            from gateway.app.main import app

            with TestClient(app) as client:
                health = client.get("/health")
                assert health.status_code == 200
                assert health.json()["core_port"] == port

                token_resp = client.post("/auth/dev-token", json={"username": "webalice"})
                assert token_resp.status_code == 200
                token = token_resp.json()["access_token"]

                channels = client.get("/channels", params={"token": token})
                assert channels.status_code == 200
                assert channels.json() == {"type": "channels", "channels": []}

                with client.websocket_connect(f"/ws?token={token}") as ws:
                    assert ws.receive_json() == {"type": "ready", "username": "webalice"}
                    ws.send_json({"type": "join", "channel": "general"})
                    assert ws.receive_json() == {"type": "ok", "message": "joined general"}
                    ws.send_json({"type": "say", "text": "hello from websocket"})
                    assert ws.receive_json() == {
                        "type": "chat",
                        "channel": "general",
                        "sender": "webalice",
                        "text": "hello from websocket",
                    }
                    ws.send_json({"type": "quit"})

                history = client.get("/history/general", params={"token": token})
                assert history.status_code == 200
                body = history.json()
                assert body["type"] == "history"
                assert body["channel"] == "general"
                assert body["messages"][-1]["sender"] == "webalice"
                assert body["messages"][-1]["text"] == "hello from websocket"

                stats = client.get("/stats", params={"token": token})
                assert stats.status_code == 200
                stats_body = stats.json()
                assert stats_body["type"] == "stats"
                assert stats_body["users"] == 1
                assert stats_body["channels"] == 1
                assert stats_body["messages"] == 1
                assert stats_body["channel_messages"] == 1
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
