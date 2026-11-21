#!/usr/bin/env bash
# CallFlow (callflow-gemini) — one-shot VPS setup, run as root.
#
#   sudo git clone https://github.com/atul-2338/callflow-gemini.git /srv/callflow-gemini
#   sudo bash /srv/callflow-gemini/deploy/vps-bootstrap-gemini.sh
#
# Then, only once that reports PASS:
#   sudo bash /srv/callflow-gemini/deploy/vps-bootstrap-gemini.sh --flip-nginx
#
# It never touches the running Next.js app: /srv/callflow, callflow.service and
# /var/data are left exactly as they are. The new app gets its own directory,
# its own .env and its own database, and only listens on 127.0.0.1:3001.

set -euo pipefail

APP_NAME=callflow-gemini
APP_USER=callflow
APP_DIR=/srv/callflow-gemini
DATA_DIR=/var/data/callflow-gemini
OLD_ENV=/srv/callflow/.env
PORT=3001
FLIP_NGINX=0
[[ "${1:-}" == "--flip-nginx" ]] && FLIP_NGINX=1

say() { printf '%s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

[[ "$(id -u)" -eq 0 ]] || die "run with sudo"
[[ -f "$APP_DIR/server.js" ]] || die "clone the repo to $APP_DIR first"
command -v node >/dev/null || die "node is not installed"

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
say "==> node $(node -v) detected"
[[ "$NODE_MAJOR" -ge 20 ]] || say "!!  WARNING: this app expects Node 20+ (better-sqlite3); Node $NODE_MAJOR may fail to install."

# --- user + directories (never touches the old app) -------------------------
if getent passwd "$APP_USER" >/dev/null; then
  say "==> reusing existing user: $APP_USER"
else
  useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"
  say "==> created system user: $APP_USER"
fi
mkdir -p "$DATA_DIR"
chown -R "$APP_USER:$APP_USER" "$APP_DIR" "$DATA_DIR"
say "==> directories ready ($APP_DIR, $DATA_DIR)"

# --- .env ------------------------------------------------------------------
# Reuse the live secrets from the old app's .env when it exists, then force the
# three values that must differ. Quotes are stripped because systemd's
# EnvironmentFile takes values literally.
ENV_FILE="$APP_DIR/.env"
set_kv() {
  local file="$1" key="$2" value="$3"
  sed -i "/^[[:space:]]*${key}=/d" "$file"
  printf '%s=%s\n' "$key" "$value" >> "$file"
}

if [[ ! -f "$ENV_FILE" ]]; then
  if [[ -f "$OLD_ENV" ]]; then
    say "==> building .env from $OLD_ENV (secrets reused)"
    : > "$ENV_FILE"
    while IFS= read -r line || [[ -n "$line" ]]; do
      line="${line%$'\r'}"
      [[ -z "$line" || "$line" == \#* ]] && continue
      [[ "$line" == *=* ]] || continue
      key="${line%%=*}"; val="${line#*=}"
      if [[ "$val" == \"*\" && "$val" == *\" ]]; then val="${val:1:${#val}-2}"; fi
      if [[ "$val" == \'*\' && "$val" == *\' ]]; then val="${val:1:${#val}-2}"; fi
      printf '%s=%s\n' "$key" "$val" >> "$ENV_FILE"
    done < "$OLD_ENV"
  else
    say "==> no old .env found, starting from .env.example"
    cp "$APP_DIR/.env.example" "$ENV_FILE"
  fi
else
  say "==> keeping existing $ENV_FILE"
fi

set_kv "$ENV_FILE" PORT "$PORT"
set_kv "$ENV_FILE" HOST "127.0.0.1"
set_kv "$ENV_FILE" SQLITE_PATH "$DATA_DIR/callflow.db"
set_kv "$ENV_FILE" APP_BASE_URL "https://callflow.biz"
set_kv "$ENV_FILE" PUBLIC_SITE_URL "https://callflow.biz"
chown "$APP_USER:$APP_USER" "$ENV_FILE"
chmod 600 "$ENV_FILE"

# Refuse to continue with an obviously unusable config.
MISSING=()
for key in DOGRAH_WEBHOOK_SECRET ADMIN_EMAIL ADMIN_PASSWORD; do
  grep -qE "^${key}=.+" "$ENV_FILE" || MISSING+=("$key")
done
if [[ ${#MISSING[@]} -gt 0 ]]; then
  die "these keys are empty in $ENV_FILE: ${MISSING[*]} — fill them in and re-run."
fi
for key in DODO_API_KEY DODO_WEBHOOK_SECRET VAPID_PUBLIC_KEY VAPID_PRIVATE_KEY; do
  grep -qE "^${key}=.+" "$ENV_FILE" || say "!!  note: $key is empty (billing/push features will be inert)"
done

# --- install dependencies + service ----------------------------------------
say "==> npm ci --omit=dev"
runuser -u "$APP_USER" -- bash -c "cd '$APP_DIR' && npm ci --omit=dev"
install -m 644 "$APP_DIR/deploy/callflow-gemini.service" "/etc/systemd/system/${APP_NAME}.service"
systemctl daemon-reload
systemctl enable "$APP_NAME" >/dev/null 2>&1 || true
# `restart || true` lets the health gate below print the journal instead of
# aborting on systemd's non-zero exit before we can show why it failed.
systemctl restart "$APP_NAME" || true
say "==> ${APP_NAME}.service started on 127.0.0.1:${PORT}"

# --- health gate ------------------------------------------------------------
API=000; CITY=000
for _ in $(seq 1 25); do
  API="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/api/health" || echo 000)"
  [[ "$API" == "200" ]] && break
  sleep 1
done
CITY="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/austin/round-rock" || echo 000)"
say "==> /api/health -> $API    /austin/round-rock -> $CITY"
if [[ "$API" != "200" || "$CITY" != "200" ]]; then
  say "---- last log lines ----"
  journalctl -u "$APP_NAME" -n 25 --no-pager || true
  die "health check failed — nginx was NOT touched. Fix the log above, then re-run."
fi
say "PASS: the new app is healthy on 127.0.0.1:${PORT} (old app still serving on 3000)"

# --- optional nginx cutover -------------------------------------------------
if [[ "$FLIP_NGINX" -eq 1 ]]; then
  CONF=/etc/nginx/sites-available/callflow.conf
  [[ -f "$CONF" ]] || die "nginx config not found at $CONF"
  cp "$CONF" "/root/callflow.conf.bak.$(date +%Y%m%d%H%M%S)"
  sed -i 's|server 127\.0\.0\.1:3000;|server 127.0.0.1:3001;|' "$CONF"
  nginx -t || die "nginx -t failed — restoring is just: cp /root/callflow.conf.bak.* $CONF"
  systemctl reload nginx
  LIVE="$(curl -s -o /dev/null -w '%{http_code}' https://callflow.biz/austin/round-rock || echo 000)"
  say "==> https://callflow.biz/austin/round-rock -> $LIVE"
  say "==> nginx now points at 3001. Rollback: sed the line back to 3000 and reload nginx."
else
  say ""
  say "Next: flip nginx when you are ready (old app stays untouched):"
  say "  sudo bash $APP_DIR/deploy/vps-bootstrap-gemini.sh --flip-nginx"
fi
