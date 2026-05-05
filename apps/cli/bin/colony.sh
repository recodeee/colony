#!/bin/sh
# Colony CLI bin shim with daemon fast-path for `colony bridge lifecycle`.
#
# Why: every IDE tool event fires `colony bridge lifecycle ...` from external
# hook integrations (oh-my-codex's ColonyBridge.spawnSync, Codex/Claude Code
# settings). Cold-starting Node on each event pegs ~one core for ~300 ms.
# Multiplied across concurrent agents this is a measurable CPU storm. When
# the worker daemon is running, we POST the envelope to /api/bridge/lifecycle
# and skip Node entirely.
#
# Rules:
# - Only `bridge lifecycle --json` is fast-pathed. Everything else execs Node
#   so behavior is unchanged.
# - Daemon unreachable / errored / unknown flags ⇒ fall back to Node with
#   stdin intact (we buffer it so it can be replayed).
# - POSIX-only. No bash-isms, no GNU-only flags.

set -e

# Resolve this script's directory through symlinks (npm bin is a symlink).
self="$0"
while [ -L "$self" ]; do
  next="$(readlink "$self")"
  case "$next" in
    /*) self="$next" ;;
    *)  self="$(dirname "$self")/$next" ;;
  esac
done
DIR="$(cd -P -- "$(dirname -- "$self")" && pwd)"
NODE_CLI="$DIR/../dist/index.js"

case "${COLONY_BRIDGE_FAST:-1}" in
  0|false|no|off) FAST=0 ;;
  *) FAST=1 ;;
esac

# Non-bridge-lifecycle commands take the unchanged Node path.
if [ "$FAST" != "1" ] || [ "$1" != "bridge" ] || [ "$2" != "lifecycle" ]; then
  exec node "$NODE_CLI" "$@"
fi

# Prefer the native bridge client when one exists for this platform. It
# handles arg parsing, the daemon POST, and the in-process Node fallback
# itself in ~5-10 ms total (vs ~50 ms for the sh+curl path below). When
# the binary is absent (unsupported platform, or not built locally) we
# fall through to the portable shell+curl implementation.
PLATFORM=""
case "$(uname -s 2>/dev/null)" in
  Linux)  KERNEL=linux ;;
  Darwin) KERNEL=darwin ;;
  *)      KERNEL="" ;;
esac
case "$(uname -m 2>/dev/null)" in
  x86_64|amd64) ARCH=x64 ;;
  arm64|aarch64) ARCH=arm64 ;;
  *) ARCH="" ;;
esac
if [ -n "$KERNEL" ] && [ -n "$ARCH" ]; then
  PLATFORM="${KERNEL}-${ARCH}"
fi
NATIVE="$DIR/colony-bridge-${PLATFORM}"
if [ -n "$PLATFORM" ] && [ -x "$NATIVE" ] && [ "${COLONY_BRIDGE_NATIVE:-1}" != "0" ]; then
  exec "$NATIVE" "$@"
fi

# No native binary — keep going with the portable shell path. We need
# curl from here on; if it isn't installed, fall through to Node.
if ! command -v curl >/dev/null 2>&1; then
  exec node "$NODE_CLI" "$@"
fi

# We're handling `bridge lifecycle ...`. Parse known flags and bail to Node
# (with original argv) if anything looks unfamiliar.
PORT="${COLONY_WORKER_PORT:-37777}"
IDE=""
CWD=""
JSON=""
UNKNOWN=""

shift 2
while [ $# -gt 0 ]; do
  case "$1" in
    --json) JSON=1; shift ;;
    --ide) IDE="${2:-}"; shift 2 ;;
    --ide=*) IDE="${1#--ide=}"; shift ;;
    --cwd) CWD="${2:-}"; shift 2 ;;
    --cwd=*) CWD="${1#--cwd=}"; shift ;;
    --) shift; break ;;
    *) UNKNOWN=1; break ;;
  esac
done

# Bail to Node on unknown flags, missing --json (humans want pretty output),
# or trailing positional args (we don't know how to forward them).
if [ -n "$UNKNOWN" ] || [ "$JSON" != "1" ] || [ $# -gt 0 ]; then
  set -- bridge lifecycle
  [ -n "$JSON" ] && set -- "$@" --json
  [ -n "$IDE" ]  && set -- "$@" --ide "$IDE"
  [ -n "$CWD" ]  && set -- "$@" --cwd "$CWD"
  exec node "$NODE_CLI" "$@"
fi

# Buffer stdin once so we can replay it to Node on fallback.
BODY="$(mktemp 2>/dev/null || echo "/tmp/colony-bridge-body-$$.json")"
RESP="$(mktemp 2>/dev/null || echo "/tmp/colony-bridge-resp-$$.json")"
cleanup() { rm -f "$BODY" "$RESP"; }
trap cleanup EXIT INT TERM

cat >"$BODY"

HTTP_CODE="$(
  curl --silent --show-error \
    --connect-timeout 1 --max-time 2 \
    --output "$RESP" \
    --write-out '%{http_code}' \
    --request POST \
    --header 'content-type: application/json' \
    --header "x-colony-ide: ${IDE}" \
    --header "x-colony-cwd: ${CWD}" \
    --data-binary "@${BODY}" \
    "http://127.0.0.1:${PORT}/api/bridge/lifecycle" \
    2>/dev/null
)" || HTTP_CODE="000"

if [ "$HTTP_CODE" = "200" ]; then
  cat "$RESP"
  exit 0
fi

# Daemon unreachable or non-200 — fall back to in-process Node with the
# buffered envelope on stdin.
set -- bridge lifecycle --json
[ -n "$IDE" ] && set -- "$@" --ide "$IDE"
[ -n "$CWD" ] && set -- "$@" --cwd "$CWD"
exec node "$NODE_CLI" "$@" <"$BODY"
