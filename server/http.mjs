// Small HTTP helpers shared by the router and route modules.
export class HttpError extends Error { constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; } }
export const fail = (status, message, extra) => { throw new HttpError(status, message, extra); };

export function sendJson(res, status, obj, headers = {}) {
  const body = JSON.stringify(obj ?? {});
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "content-length": Buffer.byteLength(body), ...headers });
  res.end(body);
}
export function redirect(res, location, headers = {}) { res.writeHead(302, { location, "cache-control": "no-store", ...headers }); res.end(); }

export async function readBody(req, limit = 6 * 1024 * 1024) {
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > limit) throw new HttpError(413, "That request is too large."); chunks.push(c); }
  return Buffer.concat(chunks);
}
export async function readJson(req, limit) {
  const b = await readBody(req, limit); if (!b.length) return {};
  try { return JSON.parse(b.toString("utf8")); } catch { throw new HttpError(400, "The request body isn't valid JSON."); }
}

export function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || "").split(";")) { const i = part.indexOf("="); if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); }
  return out;
}
// Secure only over https (Cloud Run terminates TLS and sets x-forwarded-proto), so local http still works.
export function cookie(req, name, value, { maxAge } = {}) {
  const secure = (req.headers["x-forwarded-proto"] || "").includes("https") || process.env.NODE_ENV === "production";
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}${maxAge != null ? `; Max-Age=${maxAge}` : ""}`;
}
export const clientIp = (req) => String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
export function origin(req) {
  if (process.env.PUBLIC_ORIGIN) return process.env.PUBLIC_ORIGIN.replace(/\/$/, "");
  const proto = String(req.headers["x-forwarded-proto"] || "http").split(",")[0];
  return `${proto}://${req.headers["x-forwarded-host"] || req.headers.host}`;
}
