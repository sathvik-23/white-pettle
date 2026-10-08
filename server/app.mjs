// White Petal's HTTP app. server/index.mjs boots it (Cloud Run / `npm run dev`); tests import start() directly. One process serves the app (public/),
// the AI routes (api/*.js, Web Request/Response handlers) and the account/brand/integration API (routes.mjs).
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { pathToFileURL } from "node:url";
import { ROOT } from "./env.mjs";

import { connect, migrate, ping, hasDb, close } from "./db.mjs";
import { ROUTES, gate, currentUser, isLocalDev } from "./routes.mjs";
import { HttpError, sendJson } from "./http.mjs";

// The original AI handlers. They spend money, so the server gates them: a signed-in user (with a database), or
// the access code (without one). They also run their own ACCESS_CODE guard, so a gated request is handed the
// code on the way in rather than making the browser know it.
const AI = new Set(["ask", "site", "write", "inspect", "config"]);
const handlers = {};
async function aiHandler(name) { return (handlers[name] ||= (await import(pathToFileURL(path.join(ROOT, "api", name + ".js")).href)).default); }

const compiled = ROUTES.map(([method, pattern, fn]) => {
  const keys = []; const re = new RegExp("^" + pattern.replace(/:([a-z]+)/gi, (_, k) => { keys.push(k); return "([^/]+)"; }) + "/?$");
  return { method, re, keys, fn };
});

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json", ".txt": "text/plain; charset=utf-8", ".webmanifest": "application/manifest+json" };
const PUBLIC = path.join(ROOT, "public");
const cache = new Map(); // path → { mtime, raw, gz, br, etag }
function staticFile(p) {
  const st = fs.statSync(p); const hit = cache.get(p);
  if (hit && hit.mtime === st.mtimeMs) return hit;
  const raw = fs.readFileSync(p); const ext = path.extname(p);
  const compressible = /\.(html|js|css|svg|json|txt|webmanifest)$/.test(ext);
  const f = { mtime: st.mtimeMs, raw, type: TYPES[ext] || "application/octet-stream", etag: `"${st.size.toString(36)}-${Math.round(st.mtimeMs).toString(36)}"`,
    gz: compressible ? zlib.gzipSync(raw, { level: 9 }) : null, br: compressible ? zlib.brotliCompressSync(raw) : null };
  cache.set(p, f); return f;
}
const SECURITY = { "x-content-type-options": "nosniff", "referrer-policy": "strict-origin-when-cross-origin", "x-frame-options": "DENY", "permissions-policy": "camera=(), microphone=(), geolocation=()" };

function serveStatic(req, res, pathname) {
  let p = path.normalize(path.join(PUBLIC, decodeURIComponent(pathname)));
  if (!p.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) p = fs.existsSync(path.join(p, "index.html")) ? path.join(p, "index.html") : path.join(PUBLIC, "index.html");
  const f = staticFile(p);
  // index.html: always revalidate (it names the versioned assets). Versioned app.js/css and brand files: cache.
  const isHtml = p.endsWith(".html");
  const cc = isHtml ? "no-cache" : /\/brand\//.test(p) ? "public, max-age=86400" : "public, max-age=0, must-revalidate";
  if (req.headers["if-none-match"] === f.etag) { res.writeHead(304, { etag: f.etag, "cache-control": cc }); return res.end(); }
  const ae = String(req.headers["accept-encoding"] || "");
  const [body, enc] = f.br && /\bbr\b/.test(ae) ? [f.br, "br"] : f.gz && /\bgzip\b/.test(ae) ? [f.gz, "gzip"] : [f.raw, null];
  res.writeHead(200, { "content-type": f.type, "cache-control": cc, etag: f.etag, vary: "accept-encoding", "content-length": body.length, ...(enc ? { "content-encoding": enc } : {}), ...SECURITY });
  res.end(req.method === "HEAD" ? undefined : body);
}

async function handleAi(req, res, name, url) {
  if (name !== "config") { await gate(req); }
  const chunks = []; for await (const c of req) chunks.push(c);
  const headers = { ...req.headers }; if (process.env.ACCESS_CODE && name !== "config") headers["x-access-code"] = process.env.ACCESS_CODE;
  const request = new Request(url, { method: req.method, headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks) });
  const out = await (await aiHandler(name))(request);
  if (name === "config") { // the browser's view of what this server can do
    const cfg = await out.json(); const user = hasDb() ? await currentUser(req) : null;
    return sendJson(res, 200, { ...cfg, db: hasDb(), auth: hasDb(), access: hasDb() || isLocalDev(req) ? false : cfg.access, invite: hasDb() && !!process.env.ACCESS_CODE, user: user ? { email: user.email, name: user.name } : null,
      serp: cfg.engines.includes("aio"), googleOAuth: !!process.env.GOOGLE_OAUTH_CLIENT_ID, version: process.env.K_REVISION || "dev" });
  }
  res.writeHead(out.status, Object.fromEntries(out.headers));
  if (!out.body) return res.end();
  const reader = out.body.getReader();
  req.on("close", () => reader.cancel().catch(() => {})); // the browser left: stop paying for the stream
  for (;;) { const { value, done } = await reader.read(); if (done) break; res.write(value); }
  res.end();
}

export async function start({ port = Number(process.env.PORT || 3000), quiet = false } = {}) {
if (process.env.DATABASE_URL) {
  connect();
  try { await migrate(); if (!quiet) console.log("[db] migrations up to date"); }
  catch (e) { console.error("[db] migration failed:", e.message); if (process.env.NODE_ENV === "production") process.exit(1); throw e; }
} else if (!quiet) console.log("[db] no DATABASE_URL: running without accounts (data stays in the browser)");

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  try {
    if (url.pathname === "/api/health") return sendJson(res, 200, { ok: true, db: hasDb() ? await ping() : false, revision: process.env.K_REVISION || "dev" });
    for (const r of compiled) {
      if (r.method !== req.method) continue;
      const m = url.pathname.match(r.re); if (!m) continue;
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      return await r.fn(req, res, params, url);
    }
    if (url.pathname.startsWith("/api/")) {
      const name = url.pathname.slice(5).replace(/\/$/, "");
      if (AI.has(name)) return await handleAi(req, res, name, url);
      return sendJson(res, 404, { error: "Not found" });
    }
    if (req.method !== "GET" && req.method !== "HEAD") return sendJson(res, 405, { error: "Method not allowed" });
    return serveStatic(req, res, url.pathname);
  } catch (e) {
    if (res.headersSent) { try { res.end(); } catch {} return; }
    if (e instanceof HttpError) return sendJson(res, e.status, { error: e.message, ...(e.extra || {}) });
    console.error(`[${req.method} ${url.pathname}]`, e);
    return sendJson(res, 500, { error: String(e.message || "Something went wrong").slice(0, 300) });
  }
});
// Long SSE streams (a live AI answer can take a minute) must not be cut by Node's defaults.
server.requestTimeout = 0; server.headersTimeout = 65000; server.keepAliveTimeout = 65000;

await new Promise((ok) => server.listen(port, ok));
if (!quiet) {
  const { engines } = await import("../api/_lib.js");
  const keys = engines();
  console.log(`\n  White Petal → http://localhost:${server.address().port}`);
  console.log(`  accounts: ${hasDb() ? "on (Postgres)" : "off (no DATABASE_URL, data stays in the browser)"}`);
  console.log(`  engines:  ${keys.length ? keys.join(", ") : "none: add GEMINI_API_KEY or OPENAI_API_KEY to .env.local"}`);
  if (process.env.ACCESS_CODE) console.log(`  access code: ${hasDb() ? "required at sign-up" : "required, except from this machine"}`);
  console.log("");
}
return { server, port: server.address().port, stop: () => new Promise((ok) => server.close(() => close().finally(ok))) };
}
