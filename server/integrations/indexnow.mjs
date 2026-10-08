// IndexNow (free, no account): instantly tell Bing, Yandex, Seznam, Naver… that pages changed.
// Protocol: https://www.indexnow.org/documentation. Ownership is proven by a key file hosted on the site.
import { randomBytes } from "node:crypto";
import { http, safeTest, bareHost, clip } from "./_http.mjs";

const ENDPOINT = "https://api.indexnow.org/indexnow";

export const meta = {
  id: "indexnow",
  name: "IndexNow",
  category: "search",
  auth: "none",
  free: true,
  fields: [
    { key: "key", label: "IndexNow key", secret: false, placeholder: "Leave blank to generate one", help: "8–128 characters (a-z, A-Z, 0-9, -). White Petal generates one if empty; host it as https://yoursite.com/<key>.txt containing only the key." },
    { key: "keyLocation", label: "Key file URL (optional)", secret: false, placeholder: "https://brand.com/<key>.txt", help: "Only if the key file isn't at your site root. It then only covers URLs under that folder." },
  ],
  blurb: "Pings Bing and other IndexNow search engines the moment you publish or update a page, so AI search answers pick up changes in hours, not weeks.",
  docs: "https://www.indexnow.org/documentation",
};

export const generateKey = () => randomBytes(16).toString("hex"); // 32 hex chars
const validKey = (k) => /^[a-zA-Z0-9-]{8,128}$/.test(String(k || ""));
// Fills cfg.key when empty so the caller can persist it. Returns the key.
export function ensureKey(cfg) { if (!cfg.key) cfg.key = generateKey(); return cfg.key; }

const hostname = (u) => { try { return new URL(u).hostname.toLowerCase(); } catch { return ""; } };
// The site's real hostname (keeps "www." — IndexNow matches hosts exactly).
const hostFor = (ctx) => hostname(ctx?.site) || String(ctx?.host || "").toLowerCase();
const keyFileUrl = (cfg, host) => cfg.keyLocation || `https://${host}/${cfg.key}.txt`;

async function checkKeyFile(cfg, ctx) {
  const host = hostFor(ctx);
  if (!host) return { ok: false, url: null, detail: "No site host set for this brand." };
  const url = keyFileUrl(cfg, host);
  const howTo = `Create a text file named ${cfg.key}.txt containing only the key (${cfg.key}) and upload it to your site root so it loads at https://${host}/${cfg.key}.txt.`;
  const r = await http(ctx, url, { headers: { accept: "text/plain,*/*" } });
  if (r.status === 0) return { ok: false, url, detail: `Couldn't fetch ${url} (${r.error}). ${howTo}` };
  if (r.status === 404) return { ok: false, url, detail: `Key file not found at ${url}. ${howTo}` };
  if (!r.ok) return { ok: false, url, detail: `Fetching ${url} returned HTTP ${r.status}. ${howTo}` };
  if (r.text.replace(/^﻿/, "").trim() !== cfg.key) return { ok: false, url, detail: `${url} exists but doesn't contain exactly the key. ${howTo}` };
  return { ok: true, url, detail: `Key file verified at ${url}` };
}

export async function test(cfg, ctx = {}) {
  return safeTest(async () => {
    const generated = !cfg.key; ensureKey(cfg);
    if (!validKey(cfg.key)) return { ok: false, detail: "The key must be 8–128 characters of letters, digits or dashes." };
    const r = await checkKeyFile(cfg, ctx);
    return { ok: r.ok, detail: r.detail, ...(generated ? { key: cfg.key } : {}) };
  });
}

export async function collect(cfg, ctx = {}) {
  ensureKey(cfg);
  const r = await checkKeyFile(cfg, ctx);
  return { keyFileOk: r.ok, key: cfg.key, keyFileUrl: r.url, detail: r.detail, lastSubmit: cfg.lastSubmit || null };
}

const STATUS = {
  400: "IndexNow rejected the request as badly formatted.",
  403: "IndexNow says the key isn't valid: the key file wasn't found or doesn't match the key.",
  422: "IndexNow rejected the URLs: they don't belong to this host, or the key file location doesn't cover them.",
  429: "IndexNow is rate-limiting this site (too many submissions). Try again later.",
};

// POST up to 10,000 URLs per request. Returns { ok, status, submitted, skipped, at, detail } (store as cfg.lastSubmit).
export async function submitUrls(cfg, urls, ctx = {}) {
  ensureKey(cfg);
  const all = [...new Set((urls || []).filter(Boolean))];
  // One request per host: use the hostname the URLs actually use (brand.com vs www.brand.com), if it's the brand's.
  const brand = bareHost(ctx.host || hostFor(ctx));
  const host = all.map(hostname).find((h) => bareHost(h) === brand) || hostFor(ctx);
  const list = all.filter((u) => hostname(u) === host);
  const skipped = all.length - list.length, at = new Date().toISOString();
  if (!list.length) return { ok: false, status: 0, submitted: 0, skipped, at, detail: `No URLs on ${host || "your site"} to submit.` };
  let sent = 0, status = 0;
  for (let i = 0; i < list.length; i += 10000) {
    const urlList = list.slice(i, i + 10000);
    const r = await http(ctx, ENDPOINT, { method: "POST", json: { host, key: cfg.key, ...(cfg.keyLocation ? { keyLocation: cfg.keyLocation } : {}), urlList }, headers: { "content-type": "application/json; charset=utf-8" } });
    status = r.status;
    if (r.status === 0) return { ok: false, status, submitted: sent, skipped, at, detail: `Couldn't reach IndexNow (${r.error}).` };
    if (r.status !== 200 && r.status !== 202) return { ok: false, status, submitted: sent, skipped, at, detail: STATUS[r.status] || `IndexNow error ${r.status}${r.text ? `: ${clip(r.text)}` : ""}` };
    sent += urlList.length;
  }
  const note = status === 202 ? " (accepted; key validation pending)" : "";
  return { ok: true, status, submitted: sent, skipped, at, detail: `Submitted ${sent} URL${sent === 1 ? "" : "s"} via IndexNow${note}${skipped ? `; skipped ${skipped} not on ${host}` : ""}.` };
}
