#!/bin/sh
set -eu

channelwire-server "${CHANNELWIRE_CORE_PORT:-5555}" &
core_pid="$!"

trap 'kill "$core_pid" 2>/dev/null || true' INT TERM EXIT

exec uvicorn gateway.app.main:app --host 0.0.0.0 --port "${PORT:-8000}"
