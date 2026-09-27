#!/usr/bin/env bash
#
# Play the iOS app against the bots, on a simulator, in one command.
#
#   ./scripts/play-ios.sh                 # iPhone 17, you plus three bots
#   ./scripts/play-ios.sh "iPhone 16e"    # some other simulator
#
# It starts a local server sized for one human, builds and installs the app, opens the Simulator,
# and leaves the server running in the foreground so you can watch the match in its logs. Ctrl-C
# stops everything.
set -euo pipefail

DEVICE="${1:-iPhone 17}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_DIR="${TMPDIR:-/tmp}/liars-dice-ios"

cd "$ROOT"

echo "==> generating the Swift models from the protocol"
pnpm codegen

echo "==> generating the Xcode project"
(cd clients/ios && xcodegen generate >/dev/null)

echo "==> building"
xcodebuild -project clients/ios/LiarsDice.xcodeproj \
  -scheme LiarsDice -configuration Debug \
  -sdk iphonesimulator -arch arm64 \
  -derivedDataPath "$BUILD_DIR" \
  CODE_SIGNING_ALLOWED=NO build >/dev/null

echo "==> booting $DEVICE"
xcrun simctl boot "$DEVICE" 2>/dev/null || true
open -a Simulator
xcrun simctl bootstatus "$DEVICE" -b >/dev/null 2>&1 || true

echo "==> installing"
xcrun simctl install "$DEVICE" "$BUILD_DIR/Build/Products/Debug-iphonesimulator/LiarsDice.app"

# A four-seat table that fills with bots five seconds after you queue, so one person is a match.
export MATCH_SIZE=4
export QUEUE_BACKFILL_MS=5000
export AUTH_SECRET="${AUTH_SECRET:-$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')}"
export LOG_LEVEL="${LOG_LEVEL:-info}"

SERVER=""
cleanup() {
  echo
  echo "==> stopping"
  xcrun simctl terminate "$DEVICE" com.liarsdice.app 2>/dev/null || true
  # Kill the whole server process group, not just the pnpm wrapper: pnpm spawns node as a
  # child, so killing the job alone leaves node holding the port and the *next* run of this
  # script fails to bind. Which is exactly what happened the first time.
  if [ -n "$SERVER" ]; then
    kill -- "-$SERVER" 2>/dev/null || kill "$SERVER" 2>/dev/null || true
  fi
  pkill -f 'node .*src/index.ts' 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# Fail early and clearly rather than letting the server die on an address clash.
if lsof -nP -iTCP:"${PORT:-8080}" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "error: something is already listening on :${PORT:-8080}." >&2
  echo "       a previous run may still be up — try: pkill -f 'node .*src/index.ts'" >&2
  exit 1
fi

echo "==> starting the server on :${PORT:-8080}"
set -m                      # own process group, so cleanup can take the whole tree down
pnpm dev:server &
SERVER=$!
set +m
sleep 2

echo "==> launching the app"
xcrun simctl launch "$DEVICE" com.liarsdice.app >/dev/null

cat <<'EOF'

    Tap "Find a match". Three bots sit down after five seconds.
    Server logs below; Ctrl-C to stop.

EOF

wait $SERVER
