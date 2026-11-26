#!/usr/bin/env bash
# Runs scripts/android-smoke.mjs against an already booted Android emulator,
# first with the embedded UiAutomator2 driver (the MCP server's default mode),
# then against a standalone Appium server (remoteServerUrl mode).
#
# Called by .github/workflows/android-smoke.yml from inside
# reactivecircus/android-emulator-runner. Expects `npm ci` and `npm run build`
# to have run. Logs go to $SMOKE_LOG_DIR (default: $RUNNER_TEMP/android-smoke-logs).
set -uo pipefail

SMOKE_LOG_DIR="${SMOKE_LOG_DIR:-${RUNNER_TEMP:-/tmp}/android-smoke-logs}"
APPIUM_PORT="${APPIUM_PORT:-4723}"
mkdir -p "$SMOKE_LOG_DIR"

adb devices -l

status=0

echo "::group::Smoke test: embedded driver"
ANDROID_SMOKE_SERVER_LOG="$SMOKE_LOG_DIR/mcp-server-embedded.log" node scripts/android-smoke.mjs || status=1
echo "::endgroup::"

# Use the Appium and UiAutomator2 driver versions the lockfile resolved, so the
# standalone server matches what the embedded mode just ran.
APPIUM_VERSION="$(node -p "require('./node_modules/appium/package.json').version")"
UIA2_VERSION="$(node -p "require('./node_modules/appium-uiautomator2-driver/package.json').version")"
APPIUM_BIN="$PWD/node_modules/.bin/appium"
export APPIUM_HOME="${RUNNER_TEMP:-/tmp}/appium-home"
mkdir -p "$APPIUM_HOME"

echo "::group::Start Appium $APPIUM_VERSION with uiautomator2@$UIA2_VERSION"
appium_pid=""
if "$APPIUM_BIN" driver install "uiautomator2@$UIA2_VERSION" 2>&1 | tee "$SMOKE_LOG_DIR/appium-driver-install.log"; then
  "$APPIUM_BIN" server --address 127.0.0.1 --port "$APPIUM_PORT" --log-level debug \
    --log "$SMOKE_LOG_DIR/appium-server.log" >/dev/null 2>&1 &
  appium_pid=$!
  ready=""
  for _ in $(seq 1 60); do
    if curl -fsS "http://127.0.0.1:$APPIUM_PORT/status" >/dev/null 2>&1; then
      ready=1
      break
    fi
    sleep 1
  done
  if [ -z "$ready" ]; then
    echo "::error::Appium server did not answer /status on port $APPIUM_PORT within 60s"
    status=1
  fi
else
  echo "::error::Installing uiautomator2@$UIA2_VERSION into Appium $APPIUM_VERSION failed"
  ready=""
  status=1
fi
echo "::endgroup::"

if [ -n "$ready" ]; then
  echo "::group::Smoke test: remote Appium server"
  ANDROID_SMOKE_SERVER_LOG="$SMOKE_LOG_DIR/mcp-server-remote.log" \
    node scripts/android-smoke.mjs --remote-server-url="http://127.0.0.1:$APPIUM_PORT" || status=1
  echo "::endgroup::"
fi

if [ -n "$appium_pid" ]; then
  kill "$appium_pid" 2>/dev/null || true
  wait "$appium_pid" 2>/dev/null || true
fi

adb logcat -d > "$SMOKE_LOG_DIR/logcat.txt" 2>/dev/null || true

exit "$status"
