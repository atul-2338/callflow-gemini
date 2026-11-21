#!/usr/bin/env bash
# CallFlow (callflow-gemini) — routine deploy after pushing to GitHub.
#
#   sudo bash /srv/callflow-gemini/deploy/vps-deploy-gemini.sh
#
# Pulls origin/main, reinstalls dependencies, restarts the service and health
# gates the result. Rolls back to the previous commit if the install or the
# health check fails.
#
# The database is NOT touched: it lives in /var/data/callflow-gemini, outside
# the checkout, which is why `git reset --hard` here is safe.

set -euo pipefail

APP_NAME=callflow-gemini
APP_USER=callflow
APP_DIR=/srv/callflow-gemini
BRANCH="${BRANCH:-main}"

PREV_SHA="$(git -C "$APP_DIR" rev-parse HEAD)"
echo "==> Current commit: ${PREV_SHA}"

g() { runuser -u "$APP_USER" -- git -C "$APP_DIR" "$@"; }

if [[ -n "$(g status --porcelain)" ]]; then
  echo "!!  Working tree is dirty on the server. Investigate before deploying:" >&2
  g status --porcelain >&2
  exit 1
fi

echo "==> Fetch + install"
g fetch origin "$BRANCH"
g reset --hard "origin/${BRANCH}"
NEW_SHA="$(g rev-parse --short HEAD)"
echo "    Deploying ${NEW_SHA}"

if ! runuser -u "$APP_USER" -- bash -c "cd '$APP_DIR' && npm ci --omit=dev"; then
  echo "==> npm ci FAILED — restoring ${PREV_SHA:0:7}" >&2
  g reset --hard "$PREV_SHA"
  runuser -u "$APP_USER" -- bash -c "cd '$APP_DIR' && npm ci --omit=dev"
  systemctl restart "$APP_NAME"
  exit 1
fi

# The app port is whatever .env says (3001 during the parallel run).
PORT="$(grep -E '^PORT=' "$APP_DIR/.env" | tail -1 | cut -d= -f2 | tr -d '[:space:]')"
PORT="${PORT:-3001}"

echo "==> Restart ${APP_NAME} (port ${PORT})"
systemctl restart "$APP_NAME"
sleep 3

# /api/health proves the process is serving; /austin/round-rock proves the new
# city-page routes compiled and render.
HTTP_API="$(curl -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/api/health" || echo 000)"
HTTP_CITY="$(curl -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/austin/round-rock" || echo 000)"
echo "    /api/health -> ${HTTP_API}   /austin/round-rock -> ${HTTP_CITY}"

if [[ "$HTTP_API" != "200" || "$HTTP_CITY" != "200" ]]; then
  echo "==> Health check FAILED — rolling back to ${PREV_SHA:0:7}" >&2
  g reset --hard "$PREV_SHA"
  runuser -u "$APP_USER" -- bash -c "cd '$APP_DIR' && npm ci --omit=dev"
  systemctl restart "$APP_NAME"
  echo "    Rolled back. Logs: journalctl -u ${APP_NAME} -n 80 --no-pager" >&2
  exit 1
fi

echo "==> Deployed ${NEW_SHA} successfully."
echo "    Logs: journalctl -u ${APP_NAME} -f"
