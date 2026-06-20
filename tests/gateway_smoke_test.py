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
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))

from channelwire_client import DM_RECV, QUIT, connect_registered, decode_strings, read_frame, send_frame  # noqa: E402


def receive_type(ws, expected_type: str) -> dict:
    for _ in range(10):
        event = ws.receive_json()
        if event["type"] == expected_type:
            return event
    raise AssertionError(f"did not receive event type {expected_type}")


def receive_core_type(sock: socket.socket, expected_type: int) -> object:
    for _ in range(10):
        event = read_frame(sock)
        if event.msg_type == expected_type:
            return event
    raise AssertionError(f"did not receive core frame type {expected_type}")


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

                register_resp = client.post(
                    "/auth/register",
                    json={"username": "loginuser", "password": "correct-horse-battery"},
                )
                assert register_resp.status_code == 200
                assert register_resp.json()["access_token"]

                short_password = client.post(
                    "/auth/login",
                    json={"username": "loginuser", "password": "short"},
                )
                assert short_password.status_code == 422
                assert short_password.json() == {
                    "detail": "Password must be at least 8 characters."
                }

                duplicate_resp = client.post(
                    "/auth/register",
                    json={"username": "loginuser", "password": "correct-horse-battery"},
                )
                assert duplicate_resp.status_code == 409

                bad_login = client.post(
                    "/auth/login",
                    json={"username": "loginuser", "password": "wrong-password"},
                )
                assert bad_login.status_code == 401

                login_resp = client.post(
                    "/auth/login",
                    json={"username": "loginuser", "password": "correct-horse-battery"},
                )
                assert login_resp.status_code == 200
                login_token = login_resp.json()["access_token"]
                assert client.get("/stats", params={"token": login_token}).status_code == 200
                bearer_headers = {"authorization": f"Bearer {login_token}"}
                assert client.get("/stats", headers=bearer_headers).status_code == 200
                assert client.get("/db/users", headers=bearer_headers).status_code == 200
                assert client.get("/stats").status_code == 401

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
                    ws.send_json({"type": "dm", "to": "missing-user", "text": "hello"})
                    assert ws.receive_json() == {
                        "type": "error",
                        "message": "User not found. Check the username and try again.",
                    }
                    ws.send_json({"type": "dm", "to": "invalid user!", "text": "hello"})
                    assert ws.receive_json() == {
                        "type": "error",
                        "message": "User not found. Check the username and try again.",
                    }
                    ws.send_json({"type": "quit"})

                history = client.get("/history/general", params={"token": token})
                assert history.status_code == 200
                body = history.json()
                assert body["type"] == "history"
                assert body["channel"] == "general"
                assert body["messages"][-1]["sender"] == "webalice"
                assert body["messages"][-1]["text"] == "hello from websocket"

                persisted_users = client.get("/db/users", params={"token": token})
                assert persisted_users.status_code == 200
                assert all("password" not in user for user in persisted_users.json()["users"])
                assert "webalice" in {
                    user["username"] for user in persisted_users.json()["users"]
                }

                persisted_channels = client.get("/db/channels", params={"token": token})
                assert persisted_channels.status_code == 200
                assert "general" in {
                    channel["name"] for channel in persisted_channels.json()["channels"]
                }

                members = client.get("/db/channels/general/members", params={"token": token})
                assert members.status_code == 200
                assert members.json()["channel"] == "general"
                assert "webalice" in {
                    member["username"] for member in members.json()["members"]
                }

                stats = client.get("/stats", params={"token": token})
                assert stats.status_code == 200
                stats_body = stats.json()
                assert stats_body["type"] == "stats"
                assert stats_body["users"] == 2
                assert stats_body["channels"] == 1
                assert stats_body["messages"] == 1
                assert stats_body["channel_messages"] == 1

                core_stats = client.get("/core-stats", params={"token": token})
                assert core_stats.status_code == 200
                core_stats_body = core_stats.json()
                assert core_stats_body["type"] == "core_stats"
                assert core_stats_body["total_connections"] >= 2
                assert core_stats_body["channel_messages"] >= 1

                raw_bob = connect_registered("127.0.0.1", port, "rawbob", timeout=3)
                try:
                    with client.websocket_connect(f"/ws?token={token}") as alice_ws:
                        assert alice_ws.receive_json() == {"type": "ready", "username": "webalice"}
                        alice_ws.send_json({"type": "dm", "to": "rawbob", "text": "gateway to raw core"})
                        assert receive_type(alice_ws, "ok") == {
                            "type": "ok",
                            "message": "direct message sent",
                        }
                        raw_dm = receive_core_type(raw_bob, DM_RECV)
                        assert decode_strings(raw_dm.payload) == ["webalice", "gateway to raw core"]
                        alice_ws.send_json({"type": "quit"})
                finally:
                    send_frame(raw_bob, QUIT)
                    raw_bob.close()

                raw_history = client.get("/history/dm/rawbob", params={"token": token})
                assert raw_history.status_code == 200
                raw_body = raw_history.json()
                assert raw_body["messages"][-1]["sender"] == "webalice"
                assert raw_body["messages"][-1]["recipient"] == "rawbob"
                assert raw_body["messages"][-1]["text"] == "gateway to raw core"

                bob_resp = client.post("/auth/dev-token", json={"username": "webbob"})
                assert bob_resp.status_code == 200
                bob_token = bob_resp.json()["access_token"]

                with client.websocket_connect(f"/ws?token={token}") as alice_ws:
                    assert alice_ws.receive_json() == {"type": "ready", "username": "webalice"}
                    with client.websocket_connect(f"/ws?token={bob_token}") as bob_ws:
                        assert bob_ws.receive_json() == {"type": "ready", "username": "webbob"}
                        alice_ws.send_json({"type": "join", "channel": "browser-room"})
                        assert receive_type(alice_ws, "ok") == {
                            "type": "ok",
                            "message": "joined browser-room",
                        }
                        bob_ws.send_json({"type": "join", "channel": "browser-room"})
                        assert receive_type(bob_ws, "ok") == {
                            "type": "ok",
                            "message": "joined browser-room",
                        }
                        alice_ws.send_json({"type": "say", "text": "shared browser channel"})
                        expected_chat = {
                            "type": "chat",
                            "channel": "browser-room",
                            "sender": "webalice",
                            "text": "shared browser channel",
                        }
                        assert receive_type(alice_ws, "chat") == expected_chat
                        assert receive_type(bob_ws, "chat") == expected_chat
                        alice_ws.send_json({"type": "quit"})
                        bob_ws.send_json({"type": "quit"})

                with client.websocket_connect(f"/ws?token={token}") as alice_ws:
                    assert alice_ws.receive_json() == {"type": "ready", "username": "webalice"}
                    with client.websocket_connect(f"/ws?token={bob_token}") as bob_ws:
                        assert bob_ws.receive_json() == {"type": "ready", "username": "webbob"}
                        alice_ws.send_json({"type": "dm", "to": "webbob", "text": "private browser hello"})
                        assert receive_type(alice_ws, "ok") == {
                            "type": "ok",
                            "message": "direct message sent",
                        }
                        assert receive_type(bob_ws, "dm") == {
                            "type": "dm",
                            "sender": "webalice",
                            "text": "private browser hello",
                        }
                        alice_ws.send_json({"type": "quit"})
                        bob_ws.send_json({"type": "quit"})

                dm_history = client.get("/history/dm/webalice", params={"token": bob_token})
                assert dm_history.status_code == 200
                dm_body = dm_history.json()
                assert dm_body["type"] == "dm_history"
                assert dm_body["with"] == "webalice"
                assert dm_body["messages"][-1]["sender"] == "webalice"
                assert dm_body["messages"][-1]["recipient"] == "webbob"
                assert dm_body["messages"][-1]["text"] == "private browser hello"
                assert [
                    message["text"] for message in dm_body["messages"]
                ].count("private browser hello") == 1
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
