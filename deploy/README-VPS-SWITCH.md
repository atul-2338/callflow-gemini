# Switching the VPS from `callflow` to `callflow-gemini`

Short version: the old app keeps running untouched while the new one runs beside it on
**port 3001**. When it looks right, nginx is pointed at 3001 with a one-line edit. Rollback is the
same one line back.

Nothing below deletes the old app, its `.env`, or its database.

---

## What stays where

| | Old app (live today) | New app (`callflow-gemini`) |
|---|---|---|
| Code | `/srv/callflow` | `/srv/callflow-gemini` |
| Service | `callflow.service` | `callflow-gemini.service` |
| Port | `3000` | `3001` |
| Secrets | `/srv/callflow/.env` | `/srv/callflow-gemini/.env` |
| Database | `/var/data` (Next app schema) | `/var/data/callflow-gemini/callflow.db` (own schema) |

The two databases are **not compatible** — do not copy the old SQLite file. The new app creates
its own on first boot.

---

## 1. Put the code on the VPS (once)

```bash
sudo useradd -r -s /usr/sbin/nologin callflow 2>/dev/null || true
sudo mkdir -p /srv/callflow-gemini /var/data/callflow-gemini
sudo git clone https://github.com/atul-2338/callflow-gemini.git /srv/callflow-gemini
sudo chown -R callflow:callflow /srv/callflow-gemini /var/data/callflow-gemini
```

## 2. Create the new `.env` (once)

Copy the values that already exist in `/srv/callflow/.env` into the new file — then change only
these three lines:

```bash
sudo -u callflow cp /srv/callflow-gemini/.env.example /srv/callflow-gemini/.env
sudo nano /srv/callflow-gemini/.env
```

```ini
PORT=3001
HOST=127.0.0.1
SQLITE_PATH=/var/data/callflow-gemini/callflow.db
APP_BASE_URL=https://callflow.biz
PUBLIC_SITE_URL=https://callflow.biz
```

Reuse the existing live secrets (`DOGRAH_WEBHOOK_SECRET`, `DODO_*`, `VAPID_*`, `ADMIN_*`,
`TELNYX_*`) from `/srv/callflow/.env`. Leave the old file alone.

```bash
sudo chmod 600 /srv/callflow-gemini/.env
```

## 3. Start the new app on 3001

```bash
sudo cp /srv/callflow-gemini/deploy/callflow-gemini.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now callflow-gemini
sudo systemctl status callflow-gemini --no-pager
```

Verify **before** touching nginx:

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3001/api/health        # expect 200
curl -s http://127.0.0.1:3001/austin/round-rock | head -n 5                       # expect HTML
```

## 4. Point nginx at the new app

One line, inside the existing `upstream callflow_app { ... }` block. Do **not** replace the whole
file — certbot's TLS blocks live in it.

```bash
sudo cp /etc/nginx/sites-available/callflow.conf /root/callflow.conf.bak
sudo sed -i 's/server 127\.0\.0\.1:3000;/server 127.0.0.1:3001;/' /etc/nginx/sites-available/callflow.conf
sudo nginx -t && sudo systemctl reload nginx
```

Check the live site:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://callflow.biz/austin/round-rock
```

## 5. Nobody loses anything

- Old service still runs on 3000 → instantly available for rollback.
- Old database still in `/var/data`, untouched.
- New database is its own file in `/var/data/callflow-gemini`.

---

## Rollback (10 seconds)

```bash
sudo sed -i 's/server 127\.0\.0\.1:3001;/server 127.0.0.1:3000;/' /etc/nginx/sites-available/callflow.conf
sudo nginx -t && sudo systemctl reload nginx
```

The old app answers again immediately.

---

## After the switch: two URLs to update

The new app uses different webhook paths than the old Next.js one.

| Provider | New URL to paste |
|---|---|
| Dograh webhook | `https://callflow.biz/webhooks/dograh/lead` (no `/api`) |
| Dodo webhook | `https://callflow.biz/webhooks/dodo` (no `/api`) |

Keep the same `x-webhook-secret` / Dodo signing secret values.

---

## Routine deploys after this

```bash
sudo bash /srv/callflow-gemini/deploy/vps-deploy-gemini.sh
```

It pulls `origin/main`, runs `npm ci --omit=dev`, restarts the service, health gates
`/api/health` + `/austin/round-rock`, and rolls back automatically on failure.

## When you are ready to retire the old app

```bash
sudo systemctl disable --now callflow
# optional: move the new app to port 3000 and update the sed line above
```
