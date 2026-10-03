# Always Awake Keeper

A lightweight web service that **continuously pings the URLs you provide**, preventing your other web services from sleeping or shutting down on free hosting platforms. No database required — URLs are stored in a plain file (`data/urls.json`).

## Features

- 🌐 Web dashboard — add/remove URLs, live status table
- ⏱️ Automatic ping cycle every **5 minutes** (configurable)
- 🔘 Manual **Ping Now** button
- ✅ Per-URL status: OK/FAIL, HTTP status code, response time, last ping timestamp
- 💚 Built-in awake endpoints `/ping` and `/health` — your other backends can hit these to keep **this** service awake as well
- 💾 Data persisted to file — URLs and results survive restarts
- 🚀 **Production-ready**: env-based URL seeding, rate limiting, graceful shutdown, crash protection, health checks

---

## 1. Local Setup

**Requirements:** Node.js 18+

```bash
npm install
npm start
```

Open `http://localhost:3000` in your browser.

Optional local configuration — copy the template (it is auto-loaded):

```bash
copy .env.example .env
```

---

## 2. Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Server port |
| `NODE_ENV` | `development` | Set to `production` in production |
| `PING_INTERVAL_MIN` | `5` | Minutes between ping cycles |
| `PING_TIMEOUT_MS` | `10000` | Timeout per request |
| `MAX_URLS` | `50` | Maximum number of URLs allowed |
| `URLS` | *(empty)* | Comma-separated seed URLs — **loaded at boot** (safe on ephemeral disks) |
| `SELF_PING_URL` | *(empty)* | When set, the service pings **itself** on every cycle |
| `DATA_DIR` | `./data` | Data directory (set to your mount path when using a cloud volume) |

Example (PowerShell):

```powershell
$env:PORT="3000"; $env:PING_INTERVAL_MIN="5"; $env:SELF_PING_URL="http://localhost:3000"; npm start
```

---

## 3. API Endpoints

| Method | Route | Description |
|---|---|---|
| GET | `/` | Web dashboard |
| GET | `/api/urls` | List all URLs with last results |
| POST | `/api/urls` | Add a URL — body: `{"url":"https://..."}` |
| DELETE | `/api/urls/:id` | Remove a URL |
| POST | `/api/ping` | Trigger a ping cycle immediately |
| GET | `/ping` | **Awake endpoint** (200 JSON) — call this from your backends |
| GET | `/health` | Health check |
| GET | `/api/status` | Stats: uptime, ping counts, failures |

### curl examples

```bash
# Add a URL
curl -X POST http://localhost:3000/api/urls -H "Content-Type: application/json" -d "{\"url\":\"https://example.com\"}"

# List URLs
curl http://localhost:3000/api/urls

# Ping now
curl -X POST http://localhost:3000/api/ping

# Health / awake check
curl http://localhost:3000/ping
```

---

## 4. Integrating With Your Project

### Step A — Register your URLs

Via the dashboard or the API:

```js
await fetch("http://localhost:3000/api/urls", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ url: "https://my-backend.onrender.com" }),
});
```

That's it — the service now sends a request to this URL every 5 minutes.

### Step B — Keep every service awake

Each service can be kept awake in two ways:

1. **Add it to this list** → the keeper pings it automatically.
2. **Have your backend call this keeper** → the keeper stays awake too.

Run an interval in your backend that calls `GET /ping`:

**Node.js backend:**

```js
const KEEPER_URL = "https://your-keeper.onrender.com/ping";

setInterval(async () => {
  try {
    await fetch(KEEPER_URL);
    console.log("Keeper awake ping sent");
  } catch (e) {
    console.error("Keeper ping failed:", e.message);
  }
}, 4 * 60 * 1000); // every 4 min — shorter than the keeper's 5 min cycle
```

**Python backend:**

```python
import time, threading, requests

KEEPER = "https://your-keeper.onrender.com/ping"

def keep_awake():
    while True:
        try:
            requests.get(KEEPER, timeout=10)
        except Exception as e:
            print("ping failed:", e)
        time.sleep(240)  # 4 minutes

threading.Thread(target=keep_awake, daemon=True).start()
```

> **Rule:** always keep the ping interval **below** the platform's sleep timeout (e.g. Render sleeps after ~15 minutes, so 4–5 minutes is ideal).

### Step C — Recommended self-awake configuration

1. Set the `SELF_PING_URL` environment variable → the keeper includes itself in every cycle.
2. Have your backends call `GET /ping` (Step B.2).
3. Optionally, add the keeper's own URL to its list as an extra safeguard.

---

## 5. Deploying to a Free Cloud (Production)

The repository already ships with a `render.yaml` blueprint, `Procfile`, and `.gitignore` — push and connect.

### Step 1 — Git

```bash
git init
git add .
git commit -m "Always Awake Keeper"
```

Push the repository to GitHub (`node_modules/`, `data/`, and `.env` are already excluded by `.gitignore`).

### Step 2 — Render.com (recommended)

**Option A — Blueprint (easiest):**
1. [render.com](https://render.com) → **New +** → **Blueprint** → connect the GitHub repository
2. Render reads `render.yaml` and provisions the service (`healthCheckPath: /health`, environment variables, auto-deploy)

**Option B — Manual:**
1. **New +** → **Web Service** → connect the repository
2. **Build Command:** `npm install` | **Start Command:** `npm start`
3. **Health Check Path:** `/health`

### Step 3 — Set environment variables after deploy

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `PING_INTERVAL_MIN` | `5` |
| `SELF_PING_URL` | `https://YOUR-KEEPER.onrender.com` |
| `URLS` | `https://svc-1.com,https://svc-2.com` (services to keep awake) |

### Step 4 — Do not forget to keep it awake

> ⚠️ **Important:** free tiers sleep after inactivity. Once the service sleeps, its own scheduler stops — **self-ping alone cannot wake it**. An **external trigger** is always required:
>
> 1. Your other backends call `GET /ping` every 4 minutes (Section 4, Step B) — **mutual keep-awake, the best option**
> 2. Or use a free scheduler such as [cron-job.org](https://cron-job.org) / UptimeRobot to hit `https://YOUR-KEEPER.onrender.com/ping` every 5 minutes
>
> The disk is also **ephemeral** (the `data/` folder is wiped on restart) — storing your URLs in the `URLS` environment variable ensures they are reloaded automatically at boot.

### Railway / other platforms

Same flow: connect the repository → `npm start` → set environment variables → deploy. If you attach a volume, point `DATA_DIR` to that mount path.

---

## 6. Project Structure

```
server.js          → Express app + ping scheduler + APIs + lifecycle handling
public/index.html  → Web dashboard
render.yaml        → Render blueprint (one-click deploy)
Procfile           → Railway/Heroku-style start command
.env.example       → Environment variable template (copy → .env)
data/urls.json     → URL list (created at runtime)
data/pings.json    → Latest ping results (created at runtime)
```

---

## Notes

- The server sends a **HEAD** request first; if the host returns 405/501 it falls back to **GET**.
- 2xx–3xx = OK, otherwise FAIL (timeouts count as failures).
- If a cycle is already running, `POST /api/ping` is skipped (cycles never overlap).
- URLs are file-based — you can stop the server, edit the file, and start again.
- Rate limits: `/api` 120 req/min, add/delete/ping 20 req/min per IP (HTTP 429 — retry after a short delay).
- On SIGTERM/SIGINT the service saves data before exiting (data survives host restarts).
- Default limit is 50 URLs — adjustable via the `MAX_URLS` environment variable.
