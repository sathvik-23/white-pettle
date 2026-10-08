// Passwords, sessions and secret-at-rest encryption, on node:crypto only.
import crypto from "node:crypto";
import { promisify } from "node:util";
const scrypt = promisify(crypto.scrypt);

let warned = false;
function appKey() {
  let s = process.env.APP_SECRET;
  if (!s) {
    // Local dev without APP_SECRET: derive a per-process key. Sessions and saved integration keys then do not
    // survive a restart, which is acceptable locally and impossible in production (Terraform writes APP_SECRET).
    if (!globalThis.__wpDevSecret) globalThis.__wpDevSecret = crypto.randomBytes(32).toString("hex");
    s = globalThis.__wpDevSecret;
    if (!warned) { warned = true; console.warn("[security] APP_SECRET is not set; using a temporary key (sessions reset on restart)."); }
  }
  return crypto.createHash("sha256").update("whitepetal:" + s).digest();
}

// scrypt with 16 MiB of work per attempt: slow enough to make offline guessing expensive, fast enough for a login.
export async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = await scrypt(String(pw), salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$${salt.toString("base64")}$${h.toString("base64")}`;
}
export async function verifyPassword(pw, stored) {
  const [alg, n, salt, hash] = String(stored || "").split("$");
  if (alg !== "scrypt") return false;
  const h = await scrypt(String(pw), Buffer.from(salt, "base64"), 64, { N: Number(n), r: 8, p: 1 });
  const want = Buffer.from(hash, "base64");
  return want.length === h.length && crypto.timingSafeEqual(want, h);
}

export const newToken = () => crypto.randomBytes(32).toString("base64url");
export const tokenId = (t) => crypto.createHash("sha256").update(String(t)).digest("hex");
export const randomId = (n = 12) => crypto.randomBytes(n).toString("base64url");

// AES-256-GCM: an integration's secret fields as one sealed string. Tampering fails the auth tag.
export function seal(obj) {
  const iv = crypto.randomBytes(12); const c = crypto.createCipheriv("aes-256-gcm", appKey(), iv);
  const enc = Buffer.concat([c.update(JSON.stringify(obj || {}), "utf8"), c.final()]);
  return `v1.${iv.toString("base64url")}.${c.getAuthTag().toString("base64url")}.${enc.toString("base64url")}`;
}
export function unseal(s) {
  if (!s) return {};
  try {
    const [v, iv, tag, enc] = s.split(".");
    if (v !== "v1") return {};
    const d = crypto.createDecipheriv("aes-256-gcm", appKey(), Buffer.from(iv, "base64url"));
    d.setAuthTag(Buffer.from(tag, "base64url"));
    return JSON.parse(Buffer.concat([d.update(Buffer.from(enc, "base64url")), d.final()]).toString("utf8"));
  } catch { return {}; } // key rotated or data damaged: behave as "not connected" rather than crash
}

// A simple in-memory limiter. Per instance, which is fine at max 3 instances: it exists to blunt password guessing.
const hits = new Map();
export function limited(key, max = 10, windowMs = 60000) {
  const now = Date.now(); const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
  arr.push(now); hits.set(key, arr);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((t) => now - t < windowMs)) hits.delete(k);
  return arr.length > max;
}
export const safeEqual = (a, b) => { const x = Buffer.from(String(a || "")), y = Buffer.from(String(b || "")); return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y); };
