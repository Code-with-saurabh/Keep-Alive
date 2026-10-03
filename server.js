"use strict";

const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// ---------- tiny .env loader (no dependency) ----------
(function loadEnvFile() {
  const file = path.join(__dirname, ".env");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(m[1] in process.env)) process.env[m[1]] = v;
  }
})();

const NODE_ENV = process.env.NODE_ENV || "development";
const PORT = Number(process.env.PORT) || 3000;
const PING_INTERVAL_MIN = Math.max(1, Number(process.env.PING_INTERVAL_MIN) || 5);
const PING_TIMEOUT_MS = Number(process.env.PING_TIMEOUT_MS) || 10000;
const SELF_PING_URL = (process.env.SELF_PING_URL || "").trim();
const MAX_URLS = Math.max(1, Number(process.env.MAX_URLS) || 50);
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, "data");

const startedAt = Date.now();
const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);
const logErr = (...a) => console.error(`[${new Date().toISOString()}]`, ...a);

// active window — automatic pings only run between these times (services sleep at night)
const TIMEZONE = process.env.TIMEZONE || "Asia/Kolkata";
function parseHM(value, fallback) {
  const m = String(value || "").match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (!m) {
    if (value) logErr(`Invalid time "${value}" — expected HH:MM, using ${fallback.label}`);
    return fallback;
  }
  return { h: Number(m[1]), mins: Number(m[1]) * 60 + Number(m[2]), label: m[0] };
}
const ACTIVE_FROM = parseHM(process.env.ACTIVE_FROM, { h: 7, mins: 420, label: "07:00" });
const ACTIVE_TO = parseHM(process.env.ACTIVE_TO, { h: 23, mins: 1380, label: "23:00" });

const URLS_FILE = path.join(DATA_DIR, "urls.json");
const RESULTS_FILE = path.join(DATA_DIR, "pings.json");

// ---------- authentication ----------
const AUTH_USER = process.env.AUTH_USER || "Easyskill";
const AUTH_PASS = process.env.AUTH_PASS || "Easyskill@2026";
const AUTH_SESSION_DAYS = Math.max(1, Number(process.env.AUTH_SESSION_DAYS) || 7);
const COOKIE_NAME = "ka_session";

function getAuthSecret() {
  if (process.env.AUTH_SECRET) return process.env.AUTH_SECRET;
  const file = path.join(DATA_DIR, "auth-secret.txt");
  try {
    if (fs.existsSync(file)) return fs.readFileSync(file, "utf8").trim();
    const secret = crypto.randomBytes(32).toString("hex");
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(file, secret);
    return secret;
  } catch (e) {
    logErr("auth secret error:", e.message);
    return crypto.randomBytes(32).toString("hex");
  }
}
const AUTH_SECRET = getAuthSecret();

function hmac(value) {
  return crypto.createHmac("sha256", AUTH_SECRET).update(String(value)).digest("hex");
}
function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}
function createToken() {
  const exp = Date.now() + AUTH_SESSION_DAYS * 86400000;
  return `${exp}.${hmac(exp)}`;
}
function verifyToken(token) {
  if (!token || typeof token !== "string") return false;
  const dot = token.indexOf(".");
  if (dot < 1) return false;
  const exp = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = hmac(exp);
  if (sig.length !== expected.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
  return Number(exp) > Date.now();
}
function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie;
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function requireAuth(req) {
  return verifyToken(parseCookies(req)[COOKIE_NAME]);
}

// ---------- storage ----------
function loadJSON(file, fallback) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    logErr("failed reading", file, e.message);
  }
  return fallback;
}

function saveJSON(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
  } catch (e) {
    logErr("failed writing", file, e.message);
  }
}
function saveAll() {
  saveJSON(URLS_FILE, urls);
  saveJSON(RESULTS_FILE, results);
}

// migrate legacy urls.json from project root into DATA_DIR
(function migrateLegacy() {
  const legacy = path.join(__dirname, "urls.json");
  if (fs.existsSync(legacy) && !fs.existsSync(URLS_FILE)) {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.renameSync(legacy, URLS_FILE);
      log("migrated legacy urls.json →", URLS_FILE);
    } catch (e) {
      logErr("legacy migrate failed:", e.message);
    }
  }
})();

let urls = loadJSON(URLS_FILE, []);
let results = loadJSON(RESULTS_FILE, {});

// sanitize loaded data — corrupt file should never crash the server
if (!Array.isArray(urls)) {
  logErr("urls.json corrupt (not an array) — resetting to []");
  urls = [];
}
urls = urls.filter((u) => u && typeof u === "object" && typeof u.url === "string");
for (const u of urls) if (!u.id) u.id = makeId();
if (!results || typeof results !== "object" || Array.isArray(results)) {
  if (results !== undefined && results !== null) logErr("pings.json corrupt — resetting");
  results = {};
}
saveAll();

// ---------- validation ----------
function isValidUrl(value) {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}
function makeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// seed URLs from env (works even on ephemeral filesystems like Render free)
(function seedUrls() {
  const seeds = (process.env.URLS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  let added = 0;
  for (const s of seeds) {
    if (!isValidUrl(s)) {
      logErr("Skipping invalid URL from URLS env:", s);
      continue;
    }
    if (urls.some((u) => u.url === s)) continue;
    urls.push({ id: makeId(), url: s, addedAt: new Date().toISOString(), seeded: true });
    added++;
  }
  if (added) {
    saveJSON(URLS_FILE, urls);
    log(`seeded ${added} URL(s) from URLS env`);
  }
})();

// ---------- active window ----------
let timeFmt = null;
try {
  timeFmt = new Intl.DateTimeFormat("en-GB", { timeZone: TIMEZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
} catch (e) {
  logErr(`Invalid TIMEZONE "${TIMEZONE}" (${e.message}) — falling back to server local time`);
}

function currentMinutes() {
  if (!timeFmt) {
    const d = new Date();
    return d.getHours() * 60 + d.getMinutes();
  }
  let h = 0;
  let m = 0;
  for (const part of timeFmt.formatToParts(new Date())) {
    if (part.type === "hour") h = Number(part.value);
    if (part.type === "minute") m = Number(part.value);
  }
  return (h % 24) * 60 + m;
}

function isActiveWindow() {
  const t = currentMinutes();
  const from = ACTIVE_FROM.mins;
  const to = ACTIVE_TO.mins;
  if (from === to) return true; // same time = 24x7
  if (from < to) return t >= from && t < to;
  return t >= from || t < to; // window crosses midnight
}

// ---------- ping engine ----------
let totalPings = 0;
let totalFailures = 0;
let lastCycleAt = null;
let lastCycleOk = 0;
let lastCycleFail = 0;
let lastCycleMs = 0;
let pinging = false;

async function pingOne(entry) {
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PING_TIMEOUT_MS);
  let ok = false;
  let code = 0;
  let error = "";
  try {
    let res;
    try {
      res = await fetch(entry.url, { method: "HEAD", redirect: "follow", signal: controller.signal, headers: { "user-agent": "AlwaysAwake-Keeper/1.0" } });
      if (res.status === 405 || res.status === 501) throw new Error("HEAD not allowed");
    } catch {
      res = await fetch(entry.url, { method: "GET", redirect: "follow", signal: controller.signal, headers: { "user-agent": "AlwaysAwake-Keeper/1.0" } });
    }
    code = res.status;
    ok = res.status >= 200 && res.status < 400;
    try {
      await res.arrayBuffer();
    } catch {}
  } catch (e) {
    error = e.name === "AbortError" ? `timeout ${PING_TIMEOUT_MS}ms` : e.message || "fetch failed";
  } finally {
    clearTimeout(timer);
  }

  const ms = Date.now() - start;
  const prev = results[entry.url] || {};
  results[entry.url] = {
    lastOk: ok,
    lastCode: code,
    lastMs: ms,
    lastError: error,
    lastPingAt: new Date().toISOString(),
    successCount: (prev.successCount || 0) + (ok ? 1 : 0),
    failCount: (prev.failCount || 0) + (ok ? 0 : 1),
  };
  totalPings++;
  if (!ok) totalFailures++;
  return { url: entry.url, ok, code, ms, error };
}

async function pingAll() {
  if (pinging) return { skipped: true, reason: "cycle already running" };
  pinging = true;
  const cycleStart = Date.now();
  try {
    const targets = [...urls];
    if (SELF_PING_URL && isValidUrl(SELF_PING_URL)) targets.push({ id: "self", url: SELF_PING_URL, self: true });
    const out = await Promise.all(targets.map((u) => pingOne(u)));
    saveAll();
    lastCycleAt = new Date().toISOString();
    lastCycleOk = out.filter((r) => r.ok).length;
    lastCycleFail = out.length - lastCycleOk;
    lastCycleMs = Date.now() - cycleStart;
    log(`ping cycle: ${lastCycleOk}/${out.length} ok, ${lastCycleMs}ms`);
    return { results: out, at: lastCycleAt };
  } finally {
    pinging = false;
  }
}

function publicList() {
  return urls.map((u) => ({ ...u, status: results[u.url] || null }));
}

// ---------- app ----------
const app = express();
app.disable("x-powered-by");
app.set("trust proxy", true);
app.use(express.json({ limit: "32kb" }));

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "no-referrer");
  if (req.path.startsWith("/api")) res.setHeader("Cache-Control", "no-store");
  next();
});

// auth gate — everything is protected except login, health and awake endpoints
const PUBLIC_PATHS = new Set(["/login", "/ping", "/health"]);
app.use((req, res, next) => {
  if (PUBLIC_PATHS.has(req.path) || req.path === "/api/login") return next();
  if (requireAuth(req)) return next();
  if (req.path.startsWith("/api")) return res.status(401).json({ error: "Authentication required" });
  res.redirect("/login");
});

app.use(express.static(path.join(__dirname, "public"), { maxAge: NODE_ENV === "production" ? "1h" : 0 }));

// simple in-memory rate limit per IP
const buckets = new Map();
function rateLimit(limit, windowMs) {
  return (req, res, next) => {
    const ip = req.ip || req.socket.remoteAddress || "unknown";
    const now = Date.now();
    let b = buckets.get(ip);
    if (!b || now - b.start >= windowMs) {
      b = { start: now, count: 0 };
      buckets.set(ip, b);
    }
    if (++b.count > limit) return res.status(429).json({ error: "Too many requests — please try again shortly" });
    next();
  };
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, b] of buckets) if (now - b.start > 120000) buckets.delete(ip);
}, 60000).unref();

const apiLimiter = rateLimit(120, 60000);
const mutatorLimiter = rateLimit(20, 60000);
const loginLimiter = rateLimit(10, 60000);

// ---------- auth routes ----------
app.get("/login", (req, res) => {
  if (requireAuth(req)) return res.redirect("/");
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

app.post("/api/login", loginLimiter, (req, res) => {
  const user = String((req.body && req.body.user) || "");
  const pass = String((req.body && req.body.pass) || "");
  const userOk = safeEqual(user, AUTH_USER);
  const passOk = safeEqual(pass, AUTH_PASS);
  if (!userOk || !passOk) {
    logErr("failed login attempt from", req.ip);
    return res.status(401).json({ error: "Invalid ID or password" });
  }
  res.cookie(COOKIE_NAME, createToken(), {
    httpOnly: true,
    sameSite: "lax",
    secure: req.secure,
    maxAge: AUTH_SESSION_DAYS * 86400000,
    path: "/",
  });
  log("login successful:", user, "from", req.ip);
  res.json({ ok: true });
});

app.post("/api/logout", (req, res) => {
  res.clearCookie(COOKIE_NAME, { path: "/" });
  res.json({ ok: true });
});

// ---------- API ----------
app.get("/api/urls", apiLimiter, (req, res) => {
  res.json({ urls: publicList(), intervalMin: PING_INTERVAL_MIN, maxUrls: MAX_URLS });
});

app.post("/api/urls", apiLimiter, mutatorLimiter, (req, res) => {
  const raw = String((req.body && req.body.url) || "").trim();
  if (!raw) return res.status(400).json({ error: "url required" });
  if (!isValidUrl(raw)) return res.status(400).json({ error: "Invalid URL — it must start with http:// or https://" });
  if (urls.some((u) => u.url === raw)) return res.status(409).json({ error: "URL already exists" });
  if (urls.length >= MAX_URLS) return res.status(400).json({ error: `Limit reached (${MAX_URLS} URLs). Increase the MAX_URLS environment variable to add more.` });

  const entry = { id: makeId(), url: raw, addedAt: new Date().toISOString() };
  urls.push(entry);
  saveJSON(URLS_FILE, urls);
  log("URL added:", raw);
  res.status(201).json({ added: entry, urls: publicList() });
});

app.delete("/api/urls/:id", apiLimiter, mutatorLimiter, (req, res) => {
  const before = urls.length;
  urls = urls.filter((u) => u.id !== req.params.id);
  if (urls.length === before) return res.status(404).json({ error: "not found" });
  saveJSON(URLS_FILE, urls);
  log("URL removed:", req.params.id);
  res.json({ removed: req.params.id, urls: publicList() });
});

app.post("/api/ping", apiLimiter, mutatorLimiter, async (req, res) => {
  try {
    const out = await pingAll();
    res.json({ ok: true, ...out });
  } catch (e) {
    logErr("ping error:", e.message);
    res.status(500).json({ error: "ping cycle failed" });
  }
});

// awake endpoint — your other backends call this to keep this service awake
app.get("/ping", (req, res) => {
  res.json({
    status: "ok",
    service: "always-awake-keeper",
    env: NODE_ENV,
    uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
    startedAt: new Date(startedAt).toISOString(),
    trackedUrls: urls.length,
    lastCycleAt,
    time: new Date().toISOString(),
  });
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", uptimeSec: Math.floor((Date.now() - startedAt) / 1000), urls: urls.length });
});

app.get("/api/status", apiLimiter, (req, res) => {
  res.json({
    status: "ok",
    env: NODE_ENV,
    startedAt: new Date(startedAt).toISOString(),
    uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
    trackedUrls: urls.length,
    maxUrls: MAX_URLS,
    intervalMin: PING_INTERVAL_MIN,
    timeoutMs: PING_TIMEOUT_MS,
    totalPings,
    totalFailures,
    lastCycleAt,
    lastCycleOk,
    lastCycleFail,
    lastCycleMs,
    pinging,
    selfPing: SELF_PING_URL || null,
    dataDir: DATA_DIR,
    activeWindow: { from: ACTIVE_FROM.label, to: ACTIVE_TO.label, timezone: TIMEZONE },
    activeNow: isActiveWindow(),
  });
});

app.use("/api", (req, res) => res.status(404).json({ error: "Not found" }));

// JSON error responses for the API (instead of Express' default HTML pages)
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err && err.type === "entity.parse.failed") {
    return res.status(400).json({ error: "Invalid JSON body" });
  }
  if (err && err.type === "entity.too.large") {
    return res.status(413).json({ error: "Request body too large" });
  }
  logErr("unhandled error:", err && (err.stack || err.message) || err);
  res.status(500).json({ error: "Internal server error" });
});

// ---------- start + lifecycle ----------
let lastCycleRun = 0;
let windowOpen = isActiveWindow();

const server = app.listen(PORT, () => {
  log(`Always-Awake Keeper → http://localhost:${PORT} (${NODE_ENV})`);
  log(`interval: ${PING_INTERVAL_MIN} min | timeout: ${PING_TIMEOUT_MS}ms | urls: ${urls.length} | data: ${DATA_DIR}`);
  log(`active window: ${ACTIVE_FROM.label}–${ACTIVE_TO.label} ${TIMEZONE} (${windowOpen ? "ACTIVE" : "PAUSED"})`);
  if (SELF_PING_URL) log(`self ping: ${SELF_PING_URL}`);

  if (windowOpen) {
    setTimeout(() => {
      lastCycleRun = Date.now();
      pingAll().catch((e) => logErr("cycle error:", e.message));
    }, 5000).unref?.();
  } else {
    log(`outside active window — automatic pings resume at ${ACTIVE_FROM.label} ${TIMEZONE}`);
  }

  // tick every minute: watch window state and run due cycles
  const timer = setInterval(() => {
    const active = isActiveWindow();
    if (active !== windowOpen) {
      windowOpen = active;
      log(
        active
          ? `active window opened — automatic pings resumed (${ACTIVE_FROM.label}–${ACTIVE_TO.label} ${TIMEZONE})`
          : `active window closed — automatic pings paused until ${ACTIVE_FROM.label} ${TIMEZONE}`
      );
    }
    if (!active) return;
    if (Date.now() - lastCycleRun >= PING_INTERVAL_MIN * 60000) {
      lastCycleRun = Date.now();
      pingAll().catch((e) => logErr("cycle error:", e.message));
    }
  }, 60000);
  timer.unref?.();
});

server.on("error", (e) => {
  logErr("server error:", e.message);
  process.exit(1);
});

process.on("uncaughtException", (e) => logErr("uncaughtException:", e.stack || e.message));
process.on("unhandledRejection", (e) => logErr("unhandledRejection:", (e && (e.stack || e.message)) || e));

let shuttingDown = false;
function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`${sig} received — saving data and shutting down…`);
  saveAll();
  server.close(() => {
    log("server closed");
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
