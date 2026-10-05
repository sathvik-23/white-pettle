// Local dev server: serves /public and runs /api/*.js handlers (same code Vercel runs). Usage: node dev.mjs
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const ROOT = path.dirname(fileURLToPath(import.meta.url));
for (const f of [".env.local", ".env"]) {
  const p = path.join(ROOT, f); if (!fs.existsSync(p)) continue;
  for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) { const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m && m[2] && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); }
}
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json" };
const PORT = Number(process.env.PORT || 3000);
http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname.startsWith("/api/")) {
    const name = url.pathname.slice(5).replace(/[^a-z0-9-]/gi, "");
    const file = path.join(ROOT, "api", name + ".js");
    if (!name || name.startsWith("_") || !fs.existsSync(file)) { res.writeHead(404); return res.end("not found"); }
    const mod = await import(pathToFileURL(file).href);
    const chunks = []; for await (const c of req) chunks.push(c);
    const request = new Request(url, { method: req.method, headers: req.headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks) });
    try {
      const out = await mod.default(request);
      res.writeHead(out.status, Object.fromEntries(out.headers));
      if (!out.body) return res.end();
      const reader = out.body.getReader();
      for (;;) { const { value, done } = await reader.read(); if (done) break; res.write(value); }
      res.end();
    } catch (e) { console.error(e); res.writeHead(500); res.end(String(e)); }
    return;
  }
  let p = path.join(ROOT, "public", decodeURIComponent(url.pathname));
  if (!p.startsWith(path.join(ROOT, "public"))) { res.writeHead(403); return res.end(); }
  if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, "index.html");
  if (!fs.existsSync(p)) p = path.join(ROOT, "public", "index.html");
  res.writeHead(200, { "content-type": TYPES[path.extname(p)] || "application/octet-stream" });
  fs.createReadStream(p).pipe(res);
}).listen(PORT, () => console.log(`\n  White Petal → http://localhost:${PORT}\n`));
