import express from "express";
import cookieParser from "cookie-parser";
import rateLimit from "express-rate-limit";
import cron from "node-cron";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- Config from env ----------
const PORT = parseInt(process.env.PORT || "5200", 10);
const APP_USER = process.env.APP_USER || "admin";
const APP_PASS = process.env.APP_PASS || "changeme";
const SECRET_KEY =
  process.env.SECRET_KEY || crypto.randomBytes(32).toString("hex");
const SESSION_HOURS = parseInt(process.env.SESSION_HOURS || "12", 10);
const SCRIPTS_DIR = path.resolve(process.env.SCRIPTS_DIR || "/scripts");
const ALLOW_CREATE = (process.env.ALLOW_CREATE || "true").toLowerCase() === "true";
const ALLOW_DELETE = (process.env.ALLOW_DELETE || "true").toLowerCase() === "true";
const MAX_OUTPUT_BYTES = parseInt(process.env.MAX_OUTPUT_BYTES || "200000", 10);
const RUN_TIMEOUT = parseInt(process.env.RUN_TIMEOUT || "300", 10) * 1000;
const SCHEDULES_FILE = path.join(SCRIPTS_DIR, ".schedules.json");
const ENV_FILE = path.join(SCRIPTS_DIR, ".env.json");
const TRUSTED_IPS = new Set(
  (process.env.TRUSTED_IPS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);

const COOKIE_NAME = "sm_session";
const SAFE_NAME = /^[A-Za-z0-9._\-]+$/;
const jobs = new Map();

// ---------- App ----------
const app = express();
app.set("trust proxy", true);
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser(SECRET_KEY));

// Rate limit login attempts (per IP)
const loginLimiter = rateLimit({
  windowMs: 30 * 60 * 1000, // 30 min
  max: 3, // 3 attempts
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  handler: (req, res) => {
    res
      .status(429)
      .send(renderLoginPage("Too many failed attempts. Try again later."));
  },
});

// ---------- Helpers ----------
function clientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length) return fwd.split(",")[0].trim();
  return req.ip || req.socket?.remoteAddress || "unknown";
}

function isTrusted(req) {
  return TRUSTED_IPS.has(clientIp(req));
}

function requireUser(req, res, next) {
  if (isTrusted(req)) {
    req.user = "trusted";
    return next();
  }
  const token = req.signedCookies?.[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: "unauthorized" });
  // token payload: { u: username, e: expiryMs }
  try {
    const payload = JSON.parse(token);
    if (typeof payload?.e !== "number" || payload.e < Date.now()) {
      res.clearCookie(COOKIE_NAME);
      return res.status(401).json({ error: "expired" });
    }
    req.user = payload.u;
    next();
  } catch {
    res.clearCookie(COOKIE_NAME);
    return res.status(401).json({ error: "bad session" });
  }
}

function safePath(name) {
  if (!SAFE_NAME.test(name) || name === "." || name === "..") {
    const e = new Error("invalid script name");
    e.status = 400;
    throw e;
  }
  const p = path.resolve(SCRIPTS_DIR, name);
  if (p !== SCRIPTS_DIR && !p.startsWith(SCRIPTS_DIR + path.sep)) {
    const e = new Error("path escapes scripts dir");
    e.status = 400;
    throw e;
  }
  return p;
}

function timingSafeEqualStr(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) {
    // still do a compare to keep timing flat-ish
    crypto.timingSafeEqual(ab, ab);
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

async function readJsonFile(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return fallback;
    throw err;
  }
}

async function writeJsonFile(file, value) {
  await fs.writeFile(file, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
}

async function getScriptEnv(name) {
  const all = await readJsonFile(ENV_FILE, {});
  return all[name] && typeof all[name] === "object" ? all[name] : {};
}

function sendEvent(res, event, data) {
  if (!res.writableEnded) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }
}

function runProcess(name, args, user, env, handlers = {}) {
  const child = execFile(safePath(name), args, {
    cwd: SCRIPTS_DIR,
    timeout: RUN_TIMEOUT,
    maxBuffer: MAX_OUTPUT_BYTES * 2,
    env: { ...process.env, ...env, SCRIPT_USER: user },
  });
  let outputBytes = 0;
  const emit = (stream, chunk) => {
    const text = String(chunk);
    const remaining = Math.max(0, MAX_OUTPUT_BYTES - outputBytes);
    if (!remaining) return;
    const limited = text.slice(0, remaining);
    outputBytes += Buffer.byteLength(limited);
    handlers.onData?.(stream, limited);
  };
  child.stdout.on("data", (chunk) => emit("stdout", chunk));
  child.stderr.on("data", (chunk) => emit("stderr", chunk));
  child.on("error", (err) => handlers.onError?.(err));
  child.on("close", (code, signal) => handlers.onClose?.(code, signal));
  return child;
}

async function loadSchedules() {
  const value = await readJsonFile(SCHEDULES_FILE, []);
  return Array.isArray(value) ? value : [];
}

async function refreshSchedules() {
  for (const job of jobs.values()) job.stop();
  jobs.clear();
  for (const schedule of await loadSchedules()) {
    if (!schedule.enabled || !SAFE_NAME.test(schedule.name) || !cron.validate(schedule.cron)) continue;
    const job = cron.schedule(schedule.cron, async () => {
      try {
        const env = await getScriptEnv(schedule.name);
        runProcess(schedule.name, [], "scheduler", env);
      } catch (err) {
        console.error(`scheduled run failed for ${schedule.name}: ${err.message}`);
      }
    });
    jobs.set(schedule.id, job);
  }
}

// ---------- Views (inline templates) ----------
function renderLoginPage(error) {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Login · Script Manager</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    :root { color-scheme: dark; }
    body { font-family: system-ui, sans-serif; background: #0f1116; color: #e6e6e6;
           display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .card { background: #171a21; padding: 2rem; border-radius: 12px; width: 320px;
            box-shadow: 0 8px 30px rgba(0,0,0,.5); }
    h1 { font-size: 1.25rem; margin: 0 0 1rem; }
    input { width: 100%; padding: .6rem .8rem; margin: .4rem 0; background: #0f1116;
            border: 1px solid #2a2f3a; color: #e6e6e6; border-radius: 8px; box-sizing: border-box; }
    button { width: 100%; padding: .7rem; margin-top: .8rem; border: 0; background: #4f8cff;
             color: #fff; font-weight: 600; border-radius: 8px; cursor: pointer; }
    button:hover { background: #3a7bff; }
    .err { color: #ff6b6b; font-size: .85rem; margin-top: .5rem; }
  </style>
</head>
<body>
  <form class="card" method="post" action="/login">
    <h1>Script Manager</h1>
    <input name="username" placeholder="Username" autofocus autocomplete="username" />
    <input name="password" type="password" placeholder="Password" autocomplete="current-password" />
    <button type="submit">Sign in</button>
    ${error ? `<div class="err">${escapeHtml(error)}</div>` : ""}
  </form>
</body>
</html>`;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---------- Auth routes ----------
app.get("/login", (req, res) => {
  res.type("html").send(renderLoginPage(null));
});

app.post(
  "/login",
  loginLimiter,
  express.urlencoded({ extended: false }),
  (req, res) => {
    const { username = "", password = "" } = req.body || {};
    const okUser = timingSafeEqualStr(username, APP_USER);
    const okPass = timingSafeEqualStr(password, APP_PASS);
    if (!(okUser && okPass)) {
      return res.status(401).type("html").send(renderLoginPage("Invalid credentials"));
    }
    const payload = JSON.stringify({
      u: username,
      e: Date.now() + SESSION_HOURS * 3600 * 1000,
    });
    res.cookie(COOKIE_NAME, payload, {
      httpOnly: true,
      sameSite: "lax",
      signed: true,
      maxAge: SESSION_HOURS * 3600 * 1000,
    });
    res.redirect("/");
  }
);

app.post("/logout", (req, res) => {
  res.clearCookie(COOKIE_NAME);
  res.redirect("/login");
});

// ---------- Static / UI ----------
app.get("/", (req, res) => {
  if (!isTrusted(req) && !req.signedCookies?.[COOKIE_NAME]) {
    return res.redirect("/login");
  }
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ---------- API ----------
app.get("/healthz", (req, res) => res.json({ ok: true }));

app.get("/api/scripts", requireUser, async (req, res, next) => {
  try {
    const entries = await fs.readdir(SCRIPTS_DIR, { withFileTypes: true });
    const out = [];
    for (const e of entries) {
      if (!e.isFile()) continue;
      const st = await fs.stat(path.join(SCRIPTS_DIR, e.name));
      out.push({
        name: e.name,
        size: st.size,
        mtime: Math.floor(st.mtimeMs / 1000),
        executable: !!(st.mode & 0o111),
      });
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    res.json({ scripts: out });
  } catch (err) {
    next(err);
  }
});

app.get("/api/scripts/:name", requireUser, async (req, res, next) => {
  try {
    const p = safePath(req.params.name);
    const content = await fs.readFile(p, "utf8");
    const schedules = (await loadSchedules()).filter((s) => s.name === req.params.name);
    res.json({ name: req.params.name, content, env: await getScriptEnv(req.params.name), schedules });
  } catch (err) {
    if (err.code === "ENOENT") return res.status(404).json({ error: "not found" });
    next(err);
  }
});

app.put("/api/scripts/:name/env", requireUser, async (req, res, next) => {
  try {
    safePath(req.params.name);
    const env = req.body?.env;
    if (!env || typeof env !== "object" || Array.isArray(env) ||
        !Object.entries(env).every(([key, value]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && typeof value === "string")) {
      return res.status(400).json({ error: "env must be an object of valid names and string values" });
    }
    const all = await readJsonFile(ENV_FILE, {});
    all[req.params.name] = env;
    await writeJsonFile(ENV_FILE, all);
    res.json({ ok: true, env });
  } catch (err) {
    next(err);
  }
});

app.get("/api/schedules", requireUser, async (req, res, next) => {
  try {
    res.json({ schedules: await loadSchedules() });
  } catch (err) {
    next(err);
  }
});

app.put("/api/schedules", requireUser, async (req, res, next) => {
  try {
    const schedules = req.body?.schedules;
    if (!Array.isArray(schedules) || schedules.some((s) =>
      !s || typeof s.id !== "string" || !SAFE_NAME.test(s.name) ||
      typeof s.cron !== "string" || !cron.validate(s.cron) || typeof s.enabled !== "boolean")) {
      return res.status(400).json({ error: "invalid schedules" });
    }
    await writeJsonFile(SCHEDULES_FILE, schedules);
    await refreshSchedules();
    res.json({ ok: true, schedules });
  } catch (err) {
    next(err);
  }
});

app.post("/api/scripts/:name", requireUser, async (req, res, next) => {
  try {
    if (!ALLOW_CREATE) return res.status(403).json({ error: "creating scripts disabled" });
    const p = safePath(req.params.name);
    const content = req.body?.content;
    if (typeof content !== "string") {
      return res.status(400).json({ error: "content must be a string" });
    }
    await fs.writeFile(p, content, { mode: 0o755 });
    await fs.chmod(p, 0o755);
    res.json({ ok: true, name: req.params.name });
  } catch (err) {
    next(err);
  }
});

app.delete("/api/scripts/:name", requireUser, async (req, res, next) => {
  try {
    if (!ALLOW_DELETE) return res.status(403).json({ error: "deleting scripts disabled" });
    const p = safePath(req.params.name);
    await fs.unlink(p);
    res.json({ ok: true });
  } catch (err) {
    if (err.code === "ENOENT") return res.status(404).json({ error: "not found" });
    next(err);
  }
});

app.post("/api/scripts/:name/run", requireUser, async (req, res, next) => {
  try {
    const p = safePath(req.params.name);
    await fs.access(p);

    const args = req.body?.args ?? [];
    if (!Array.isArray(args) || !args.every((a) => typeof a === "string")) {
      return res.status(400).json({ error: "args must be a list of strings" });
    }

    const env = await getScriptEnv(req.params.name);
    res.status(200).set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();
    const child = runProcess(req.params.name, args, req.user, env, {
      onData: (stream, data) => sendEvent(res, "data", { stream, data }),
      onError: (err) => sendEvent(res, "error", { error: `execution failed: ${err.message}` }),
      onClose: (code, signal) => {
        sendEvent(res, "close", { exit_code: code, signal });
        res.end();
      },
    });
    req.on("close", () => {
      if (!res.writableEnded) child.kill();
    });
  } catch (err) {
    next(err);
  }
});

// ---------- Error handler ----------
app.use((err, req, res, _next) => {
  const status = err.status || 500;
  if (req.path.startsWith("/api/")) {
    return res.status(status).json({ error: err.message || "server error" });
  }
  res.status(status).send(err.message || "server error");
});

// ---------- Boot ----------
await fs.mkdir(SCRIPTS_DIR, { recursive: true });
await refreshSchedules();
app.listen(PORT, "0.0.0.0", () => {
  console.log(`script-manager listening on :${PORT}`);
  console.log(`scripts dir: ${SCRIPTS_DIR}`);
});