#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${PORT:-47855}"
URL="http://127.0.0.1:${PORT}/"
PID_FILE="${SCRIPT_DIR}/.server.pid"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js was not found. Install Node.js LTS from https://nodejs.org, then run this file again."
  exit 1
fi

is_ready() {
  node -e "fetch(process.argv[1]).then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))" "$URL" >/dev/null 2>&1
}

if ! is_ready; then
  CAMERA_OPEN_BROWSER=0 PORT="$PORT" node "${SCRIPT_DIR}/server.js" >/dev/null 2>&1 &
  echo "$!" > "$PID_FILE"

  ready=0
  for _ in $(seq 1 40); do
    if is_ready; then
      ready=1
      break
    fi
    sleep 0.2
  done

  if [ "$ready" -ne 1 ]; then
    echo "The local server did not start at $URL"
    echo "Try running: node server.js"
    exit 1
  fi
fi

case "$(uname -s)" in
  Darwin*) open "$URL" ;;
  MINGW*|MSYS*|CYGWIN*) cmd.exe /c start "" "$URL" >/dev/null ;;
  *) xdg-open "$URL" >/dev/null 2>&1 || echo "Open this URL in your browser: $URL" ;;
esac

echo "Wi-Fi Endoscope Viewer is running at $URL"
