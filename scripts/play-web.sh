#!/usr/bin/env bash
#
# One command to get a playable game onto the internet from this Mac.
#
#   pnpm play:web
#
# Builds the browser client, starts the server, and opens a Cloudflare tunnel so the URL works
# from anywhere. The server serves the page *and* the WebSocket on one port, which is why one
# tunnel is enough — and why the client needs no configuration to find the socket.
#
# This is self-hosting in the literal sense: the game runs on this machine and dies when this
# script does. That is the right trade for a playtest and the wrong one for anything permanent;
# see docs/PLAN.md for the hosted options.
set -euo pipefail

cd "$(dirname "$0")/.."

PORT="${PORT:-8080}"
SERVER=""
TUNNEL=""
TUNNEL_LOG="$(mktemp -t liarsdice-tunnel)"

cleanup() {
  echo
  echo "shutting down…"
  if [ -n "$TUNNEL" ]; then kill "$TUNNEL" 2>/dev/null || true; fi
  if [ -n "$SERVER" ]; then
    # `node --watch` supervises a child, so kill the process group and fall back to the job.
    kill -- "-$SERVER" 2>/dev/null || kill "$SERVER" 2>/dev/null || true
  fi
  # The server runs with its cwd inside apps/server, so its argv is 'src/index.ts' — matching on
  # the repo-relative path would never fire. \Completed running ''. Waiting for file changes before restarting... also supervises a child, so the
  # pattern has to catch both processes.
  pkill -f 'node .*src/index.ts' 2>/dev/null || true
  rm -f "$TUNNEL_LOG"
}
trap cleanup EXIT INT TERM

if lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "error: something is already listening on :${PORT}"
  echo "  clear it with:  lsof -ti tcp:${PORT} | xargs kill"
  exit 1
fi

if ! command -v cloudflared >/dev/null 2>&1; then
  cat <<'MSG'
error: cloudflared is not installed.

  brew install cloudflared

It needs no account and no configuration for a quick tunnel — it hands back an
https:// URL that forwards to this machine, which is what makes wss:// work in a
browser. Install it and run this again.
MSG
  exit 1
fi

echo "building the web client…"
pnpm build:web >/dev/null

echo "starting the server on :${PORT}…"
# `set -m` puts the server in its own process group so cleanup can take the whole tree.
set -m
PORT="${PORT}" pnpm dev:server &
SERVER=$!
set +m

# Wait for it to answer before pointing a tunnel at it.
for _ in $(seq 1 40); do
  if curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then break; fi
  sleep 0.25
done
if ! curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
  echo "error: the server did not come up — see the log above"
  exit 1
fi

echo "opening a tunnel…"
cloudflared tunnel --url "http://127.0.0.1:${PORT}" >"$TUNNEL_LOG" 2>&1 &
TUNNEL=$!

URL=""
for _ in $(seq 1 60); do
  URL="$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' "$TUNNEL_LOG" | head -1 || true)"
  [ -n "$URL" ] && break
  sleep 0.5
done

if [ -z "$URL" ]; then
  echo "error: the tunnel did not report a URL. Its log:"
  cat "$TUNNEL_LOG"
  exit 1
fi

cat <<MSG

  ┌────────────────────────────────────────────────────────┐
     Send this to whoever you are playing with:

       $URL

     Open it yourself too — one of you taps "Play with friends",
     reads out the four-character code, the other taps "Join with
     a code". Or use "Copy invite link", which carries the code.

     Ctrl-C here stops everything.
  └────────────────────────────────────────────────────────┘

MSG

# Stay in the foreground so Ctrl-C reaches the trap. Watching the server is what ends this.
wait "$SERVER"
