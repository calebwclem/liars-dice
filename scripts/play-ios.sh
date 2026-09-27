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

cleanup() {
  echo
  echo "==> stopping"
  xcrun simctl terminate "$DEVICE" com.liarsdice.app 2>/dev/null || true
}
trap cleanup EXIT

echo "==> starting the server on :${PORT:-8080}"
pnpm dev:server &
SERVER=$!
sleep 2

echo "==> launching the app"
xcrun simctl launch "$DEVICE" com.liarsdice.app >/dev/null

cat <<'EOF'

    Tap "Find a match". Three bots sit down after five seconds.
    Server logs below; Ctrl-C to stop.

EOF

wait $SERVER
