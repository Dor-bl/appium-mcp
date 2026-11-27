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

# Pick one device for both passes. Without a serial, UiAutomator2 drives the
# first connected device, which could be a phone rather than the emulator.
if [ -z "${ANDROID_SERIAL:-}" ]; then
  mapfile -t serials < <(adb devices | awk 'NR > 1 && $2 == "device" {print $1}')
  if [ "${#serials[@]}" -ne 1 ]; then
    echo "::error::Found ${#serials[@]} ready Android devices; set ANDROID_SERIAL to the one to test"
    exit 1
  fi
  export ANDROID_SERIAL="${serials[0]}"
fi
echo "Testing on $ANDROID_SERIAL"

status=0

echo "::group::Smoke test: embedded driver"
ANDROID_SMOKE_SERVER_LOG="$SMOKE_LOG_DIR/mcp-server-embedded.log" node scripts/android-smoke.mjs || status=1
echo "::endgroup::"

# Use the Appium and UiAutomator2 driver versions the lockfile resolved, so the
# standalone server matches what the embedded mode just ran.
APPIUM_VERSION="$(node -p "require('./node_modules/appium/package.json').version")"
UIA2_VERSION="$(node -p "require('./node_modules/appium-uiautomator2-driver/package.json').version")"
APPIUM_BIN="$PWD/node_modules/.bin/appium"
# A fresh Appium home per run: Appium refuses to install a driver that is already
# installed, so a reused home would break the second local run.
APPIUM_HOME="$(mktemp -d "${RUNNER_TEMP:-/tmp}/appium-home.XXXXXX")"
export APPIUM_HOME
appium_pid=""
# shellcheck disable=SC2329 # invoked by the EXIT trap
cleanup() {
  if [ -n "$appium_pid" ]; then
    kill "$appium_pid" 2>/dev/null || true
    wait "$appium_pid" 2>/dev/null || true
  fi
  rm -rf "$APPIUM_HOME"
}
trap cleanup EXIT

echo "::group::Start Appium $APPIUM_VERSION with uiautomator2@$UIA2_VERSION"
ready=""
if curl -fsS "http://127.0.0.1:$APPIUM_PORT/status" >/dev/null 2>&1; then
  # Testing against someone else's server would report results for other versions.
  echo "::error::Port $APPIUM_PORT already serves an Appium server; stop it or set APPIUM_PORT to a free port"
  status=1
elif "$APPIUM_BIN" driver install "uiautomator2@$UIA2_VERSION" 2>&1 | tee "$SMOKE_LOG_DIR/appium-driver-install.log"; then
  "$APPIUM_BIN" server --address 127.0.0.1 --port "$APPIUM_PORT" --log-level debug \
    --log "$SMOKE_LOG_DIR/appium-server.log" >/dev/null 2>&1 &
  appium_pid=$!
  for _ in $(seq 1 60); do
    if ! kill -0 "$appium_pid" 2>/dev/null; then
      echo "::error::Appium server exited during startup; see appium-server.log"
      appium_pid=""
      break
    fi
    if curl -fsS "http://127.0.0.1:$APPIUM_PORT/status" >/dev/null 2>&1; then
      ready=1
      break
    fi
    sleep 1
  done
  if [ -z "$ready" ]; then
    if [ -n "$appium_pid" ]; then
      echo "::error::Appium server did not answer /status on port $APPIUM_PORT within 60s"
    fi
    status=1
  fi
else
  echo "::error::Installing uiautomator2@$UIA2_VERSION into Appium $APPIUM_VERSION failed"
  status=1
fi
echo "::endgroup::"

if [ -n "$ready" ]; then
  echo "::group::Smoke test: remote Appium server"
  ANDROID_SMOKE_SERVER_LOG="$SMOKE_LOG_DIR/mcp-server-remote.log" \
    node scripts/android-smoke.mjs --remote-server-url="http://127.0.0.1:$APPIUM_PORT" || status=1
  echo "::endgroup::"
fi

adb logcat -d > "$SMOKE_LOG_DIR/logcat.txt" 2>/dev/null || true

exit "$status"
