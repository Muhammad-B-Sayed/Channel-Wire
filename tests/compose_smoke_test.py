#!/usr/bin/env python3
import json
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request


def run_cmd(args: list[str]) -> None:
    subprocess.run(args, check=True)


def request_json(method: str, url: str, body: dict | None = None) -> dict:
    data = None
    headers = {}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["content-type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=5) as response:
        return json.loads(response.read().decode("utf-8"))


def wait_for_json(url: str, timeout_seconds: float = 90) -> dict:
    deadline = time.time() + timeout_seconds
    last_error: Exception | None = None
    while time.time() < deadline:
        try:
            return request_json("GET", url)
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
            last_error = exc
            time.sleep(1)
    raise AssertionError(f"timed out waiting for {url}: {last_error}")


def wait_for_frontend(url: str, timeout_seconds: float = 90) -> str:
    deadline = time.time() + timeout_seconds
    last_error: Exception | None = None
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=5) as response:
                text = response.read().decode("utf-8")
                if "ChannelWire" in text:
                    return text
        except (urllib.error.URLError, TimeoutError) as exc:
            last_error = exc
        time.sleep(1)
    raise AssertionError(f"timed out waiting for frontend {url}: {last_error}")


def main() -> None:
    project = "channelwire-smoke"
    compose = ["docker", "compose", "-p", project]
    try:
        run_cmd([*compose, "up", "--build", "-d"])

        health = wait_for_json("http://127.0.0.1:8000/health")
        assert health["status"] == "ok", health

        username = f"compose{int(time.time())}"
        password = "compose-password-123"
        token_body = request_json(
            "POST",
            "http://127.0.0.1:8000/auth/register",
            {"username": username, "password": password},
        )
        token = token_body["access_token"]
        assert token

        login_body = request_json(
            "POST",
            "http://127.0.0.1:8000/auth/login",
            {"username": username, "password": password},
        )
        assert login_body["access_token"]

        query = urllib.parse.urlencode({"token": token})
        stats = request_json("GET", f"http://127.0.0.1:8000/stats?{query}")
        assert stats["users"] >= 1, stats

        core_stats = request_json("GET", f"http://127.0.0.1:8000/core-stats?{query}")
        assert core_stats["type"] == "core_stats", core_stats
        assert core_stats["total_connections"] >= 1, core_stats

        users = request_json("GET", f"http://127.0.0.1:8000/db/users?{query}")
        assert username in {user["username"] for user in users["users"]}, users

        wait_for_frontend("http://127.0.0.1:3000/")
    finally:
        subprocess.run([*compose, "down", "-v"], check=False)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # noqa: BLE001 - command-line smoke test should print direct failure.
        print(f"compose smoke failed: {exc}", file=sys.stderr)
        raise
