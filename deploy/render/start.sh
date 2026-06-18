#!/bin/sh
set -eu

uvicorn gateway.app.main:app --host 0.0.0.0 --port "${PORT:-8000}" &
api_pid="$!"

python - <<'PY'
import os
import time
import urllib.request

url = f"http://127.0.0.1:{os.getenv('PORT', '8000')}/health"
deadline = time.time() + 30

while time.time() < deadline:
    try:
        with urllib.request.urlopen(url, timeout=1) as response:
            if 200 <= response.status < 500:
                raise SystemExit(0)
    except Exception:
        time.sleep(0.5)

raise SystemExit("gateway did not become ready before starting core")
PY

channelwire-server "${CHANNELWIRE_CORE_PORT:-5555}" &
core_pid="$!"

trap 'kill "$api_pid" "$core_pid" 2>/dev/null || true' INT TERM EXIT

while kill -0 "$api_pid" 2>/dev/null && kill -0 "$core_pid" 2>/dev/null; do
    sleep 1
done

kill "$api_pid" "$core_pid" 2>/dev/null || true
wait "$api_pid" 2>/dev/null || true
wait "$core_pid" 2>/dev/null || true
