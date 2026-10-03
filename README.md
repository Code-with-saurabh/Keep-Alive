# Always Awake Keeper

Ek chhota sa web service jo aapke diye hue **URLs ko baar-baar ping karta rehta hai** — taaki aapki baaki web services free hosting pe **sleep / shutdown na hon**. Koi database nahi — URLs sirf file (`urls.json`) me store hote hain.

## Features

- 🌐 Web page — URL paste karke add/remove karo, live status table
- ⏱️ Automatic ping har **5 minute** (configurable)
- 🔘 Manual **Ping Now** button
- ✅ Per-URL status: OK/FAIL, HTTP code, response time, last ping time
- 💚 Khud ka health endpoint `/ping` + `/health` — baaki aapke backends isko hit karke **isse bhi awake rakh sakte hain**
- 💾 Data file (`data/`) me persist — restart pe bhi URLs/results safe
- 🚀 **Production-ready**: env se seed URLs, rate-limit, graceful shutdown, crash protection, health checks

---

## 1. Local Setup

Requirements: **Node.js 18+**

```bash
npm install
npm start
```

Browser me kholo → `http://localhost:3000`

Optional local config: `.env.example` ko copy karke `.env` bana lo (wo auto-load hota hai):

```bash
copy .env.example .env
```

---

## 2. Environment Variables

| Var | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | Server port |
| `NODE_ENV` | `development` | Production me `production` set karo |
| `PING_INTERVAL_MIN` | `5` | Kitne minute me ping cycle chale |
| `PING_TIMEOUT_MS` | `10000` | Har request ka timeout |
| `MAX_URLS` | `50` | Max kitne URLs add ho sakte hain |
| `URLS` | *(empty)* | Comma-separated seed URLs — **boot pe load hote hain** (ephemeral disk pe bhi safe) |
| `SELF_PING_URL` | *(empty)* | Agar set karo to har cycle me ye service **khud ko** bhi ping karega |
| `DATA_DIR` | `./data` | Data folder path (cloud volume ho to wahi path) |

Example (PowerShell):

```powershell
$env:PORT="3000"; $env:PING_INTERVAL_MIN="5"; $env:SELF_PING_URL="http://localhost:3000"; npm start
```

---

## 3. API Endpoints

| Method | Route | Kaam |
|---|---|---|
| GET | `/` | Web UI |
| GET | `/api/urls` | Saare URLs + last result |
| POST | `/api/urls` | URL add karo — body: `{"url":"https://..."}` |
| DELETE | `/api/urls/:id` | URL delete |
| POST | `/api/ping` | Abhi turant saare URLs ping karo |
| GET | `/ping` | **Awake endpoint** (200 JSON) — aapke backends ise hit karein |
| GET | `/health` | Simple health check |
| GET | `/api/status` | Stats: uptime, pings, failures |

### curl examples

```bash
# URL add
curl -X POST http://localhost:3000/api/urls -H "Content-Type: application/json" -d "{\"url\":\"https://example.com\"}"

# List
curl http://localhost:3000/api/urls

# Ping now
curl -X POST http://localhost:3000/api/ping

# Health / awake check
curl http://localhost:3000/ping
```

---

## 4. Apne Project Me Integrate Kaise Karein

### Step A — URLs add karo

UI se ya API se:

```js
await fetch("http://localhost:3000/api/urls", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ url: "https://my-backend.onrender.com" }),
});
```

Bas — ab ye service har 5 min us URL pe request bhejegi.

### Step B — Baaki backends se KOI SERVICE SLEEP NA HO

Har service ko do tarah se awake rakh sakte ho:

1. **Is list me add karo** → keeper khud ping karta rahega.
2. **Aapka backend is keeper ko hit kare** → keeper bhi awake rahega.

Apne backend me ek interval chalao jo `GET /ping` call kare:

**Node.js backend:**

```js
const KEEPER_URL = "https://your-keeper.onrender.com/ping";

setInterval(async () => {
  try {
    await fetch(KEEPER_URL);
    console.log("keeper awake ping sent");
  } catch (e) {
    console.error("keeper ping failed", e.message);
  }
}, 4 * 60 * 1000); // har 4 min (keeper ke 5 min se kam, taaki kabhi miss na ho)
```

**Python backend:**

```python
import time, threading, requests

KEEPER = "https://your-keeper.onrender.com/ping"

def keep_awake():
    while True:
        try: requests.get(KEEPER, timeout=10)
        except Exception as e: print("ping fail", e)
        time.sleep(240)  # 4 min

threading.Thread(target=keep_awake, daemon=True).start()
```

> **Rule:** ping interval hamesha uske sleep timeout se **kam** rakho (jaise Render ~15 min, isliye 4-5 min ideal).

### Step C — Keeper ko khud awake rakhne ka best setup

1. `SELF_PING_URL` env set karo → har cycle me khud ko bhi ping karega.
2. Apne baaki backends se `GET /ping` call karwao (upar Step B.2).
3. Extra safety ke liye aap apna keeper URL bhi apni list me add kar do.

---

## 5. Free Cloud Pe Deploy (Production-ready)

Repo me `render.yaml` blueprint, `Procfile` aur `.gitignore` ready hain — bas push karke connect karo.

### Step 1 — Git

```bash
git init
git add .
git commit -m "always awake keeper"
```

Repo GitHub pe push karo (`.gitignore` me `node_modules/`, `data/`, `.env` already excluded).

### Step 2 — Render.com (recommended)

**Option A — Blueprint (sabse aasaan):**
1. [render.com](https://render.com) → **New +** → **Blueprint** → GitHub repo connect karo
2. Render `render.yaml` padhke service bana dega (`healthCheckPath: /health`, env vars, auto-deploy)

**Option B — Manual:**
1. **New +** → **Web Service** → repo connect
2. **Build Command:** `npm install` | **Start Command:** `npm start`
3. **Health Check Path:** `/health`

### Step 3 — Deploy ke baad env set karo

| Var | Value |
|---|---|
| `NODE_ENV` | `production` |
| `PING_INTERVAL_MIN` | `5` |
| `SELF_PING_URL` | `https://YOUR-KEEPER.onrender.com` |
| `URLS` | `https://svc-1.com,https://svc-2.com` (jo bhi awake rakhne hain) |

### Step 4 — Awake rakhna mat bhoolna

> ⚠️ **Important:** free tier inactivity pe **sleep** karta hai. Service sote hi apna scheduler band ho jata hai — **self-ping kaam nahi karta**. Hamesha **external trigger** chahiye:
>
> 1. Aapke baaki backends har 4 min `GET /ping` karein (Section 4, Step B) — **mutual keep-awake, best option**
> 2. Ya [cron-job.org](https://cron-job.org) / UptimeRobot jaise free tool se `https://YOUR-KEEPER.onrender.com/ping` har 5 min hit ho
>
> Disk bhi **ephemeral** hai (restart pe `data/` mit jaata hai) — isliye `URLS` env me rakhoge to wo boot pe automatically wapas load ho jayenge.

### Railway / other

Same: repo connect → `npm start` → env vars → deploy. Volume laga rahe ho to `DATA_DIR` us mount path pe set kardo.

---

## 6. Files

```
server.js          → Express app + ping scheduler + APIs + lifecycle handling
public/index.html  → Web UI
render.yaml        → Render blueprint (one-click deploy)
Procfile           → Railway/Heroku-style start command
.env.example       → env config template (copy → .env)
data/urls.json     → URL list (runtime auto-create)
data/pings.json    → Last ping results (auto-create)
```

---

## Notes

- Server **HEAD** request bhejta hai; agar host 405/501 de to **GET** fallback hota hai.
- 2xx–3xx = OK, warna FAIL (timeout bhi fail).
- Ek cycle chal rahi ho to dobara `POST /api/ping` skip ho jata hai (overlap nahi hota).
- URLs file-based hain — server band karke file edit karke bhi chalega.
- Rate limit: `/api` 120 req/min, add/delete/ping 20 req/min per IP (429 milta hai to thodi der baad try karo).
- SIGTERM/SIGINT pe data save karke hi exit hota hai (host restart pe bhi data safe).
- Max 50 URLs default — `MAX_URLS` env se badla ja sakta hai.
