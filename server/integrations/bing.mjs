// Bing Webmaster Tools (free). Bing's index also feeds ChatGPT search and Copilot, so its query data matters for AI visibility.
// API reference: https://learn.microsoft.com/en-us/dotnet/api/microsoft.bing.webmaster.api.interfaces.iwebmasterapi
// JSON endpoints: https://ssl.bing.com/webmaster/api.svc/json/<Method>?apikey=KEY&siteUrl=...  →  { "d": ... }
import { http, safeTest, clip } from "./_http.mjs";

const BASE = "https://ssl.bing.com/webmaster/api.svc/json/";

export const meta = {
  id: "bing",
  name: "Bing Webmaster Tools",
  category: "search",
  auth: "key",
  free: true,
  fields: [
    { key: "apiKey", label: "API key", secret: true, placeholder: "e.g. 1a2b3c4d5e6f…", help: "Bing Webmaster Tools → Settings (gear) → API access → Generate API key. One key covers all your verified sites." },
    { key: "siteUrl", label: "Site URL", secret: false, placeholder: "https://brand.com/", help: "Exactly as the site appears in Bing Webmaster Tools. Leave blank to use your main site." },
  ],
  blurb: "Shows which Bing searches surface your site (Bing powers ChatGPT search and Copilot) and lets White Petal push new pages to Bing instantly.",
  docs: "https://www.bing.com/webmasters/",
};

// WCF JSON dates: "/Date(1316156400000-0700)/". The millis are UTC; the offset is informational only.
export function parseBingDate(s) {
  const m = /\/Date\((-?\d+)(?:[+-]\d{4})?\)\//.exec(String(s || ""));
  return m ? new Date(Number(m[1])).toISOString() : null;
}

// ApiErrorCode enum (InvalidApiKey=3, ThrottleUser=4, ThrottleHost=5, UserBlocked=6, InvalidUrl=7, InvalidParameter=8, NotAllowed=13, NotAuthorized=14 …)
async function call(cfg, ctx, method, params = {}, body) {
  if (!cfg?.apiKey) throw new Error("Add your Bing Webmaster API key first.");
  const qs = new URLSearchParams({ ...params, apikey: cfg.apiKey });
  const r = await http(ctx, `${BASE}${method}?${qs}`, body
    ? { method: "POST", json: body, headers: { "content-type": "application/json; charset=utf-8" } }
    : { headers: { accept: "application/json" } });
  if (r.status === 0) throw new Error(`Couldn't reach Bing Webmaster Tools (${r.error}).`);
  const code = r.data?.ErrorCode, msg = clip(r.data?.Message || r.data?.message || (r.data ? "" : r.text));
  const site = params.siteUrl || body?.siteUrl || "that site";
  if (code === 3 || r.status === 401 || /InvalidApiKey/i.test(msg)) throw new Error("Bing rejected the API key. Generate a new one in Bing Webmaster Tools → Settings → API access.");
  if (code === 14 || code === 13 || r.status === 403 || /NotAuthorized/i.test(msg)) throw new Error(`Bing says this API key can't access ${site}. Add and verify the site in the same Bing Webmaster account.`);
  if (code === 4 || code === 5 || r.status === 429) throw new Error("Bing is rate-limiting requests (or the daily URL quota is used up). Try again later.");
  if (code === 6) throw new Error("Bing has blocked this Bing Webmaster account.");
  if (code === 7 || code === 8) throw new Error(`Bing rejected the request: ${msg || "invalid URL or parameter"} (check the site URL matches Bing Webmaster Tools exactly).`);
  if (!r.ok || code) throw new Error(`Bing Webmaster API error ${r.status}${msg ? `: ${msg}` : ""}`);
  return r.data?.d ?? null;
}

// Pick the Bing site to use: the saved siteUrl, else the verified site matching ctx.host, else ctx.site.
async function resolveSite(cfg, ctx) {
  if (cfg.siteUrl) return cfg.siteUrl;
  const sites = (await call(cfg, ctx, "GetUserSites")) || [];
  const host = String(ctx?.host || "").replace(/^www\./, "");
  const hit = sites.find((s) => { try { return new URL(s.Url).hostname.replace(/^www\./, "") === host; } catch { return false; } });
  return hit?.Url || ctx?.site;
}

export async function test(cfg, ctx = {}) {
  return safeTest(async () => {
    const sites = (await call(cfg, ctx, "GetUserSites")) || [];
    const verified = sites.filter((s) => s.IsVerified);
    const want = cfg.siteUrl || ctx.site;
    const norm = (u) => String(u || "").toLowerCase().replace(/^https?:\/\/(www\.)?/, "").replace(/\/+$/, "");
    const mine = want && sites.find((s) => norm(s.Url) === norm(want));
    if (want && !mine) return { ok: false, detail: `Key works (${sites.length} site${sites.length === 1 ? "" : "s"}), but ${want} isn't in this Bing account. Add it at bing.com/webmasters.` };
    if (mine && !mine.IsVerified) return { ok: false, detail: `${mine.Url} is in Bing Webmaster Tools but not verified yet.` };
    return { ok: true, detail: `Connected to ${mine?.Url || "Bing Webmaster Tools"} (${verified.length} verified site${verified.length === 1 ? "" : "s"})` };
  });
}

// GetQueryStats / GetPageStats return weekly rows per query/page; aggregate them per key.
function aggregate(rows, keyName) {
  const by = new Map();
  for (const r of rows || []) {
    const k = r.Query; if (!k) continue;
    const a = by.get(k) || { [keyName]: k, impressions: 0, clicks: 0, _ip: 0, _cp: 0, lastDate: null };
    const imp = +r.Impressions || 0, clk = +r.Clicks || 0, d = parseBingDate(r.Date);
    a.impressions += imp; a.clicks += clk;
    a._ip += (+r.AvgImpressionPosition || 0) * imp; a._cp += (+r.AvgClickPosition || 0) * clk;
    if (d && (!a.lastDate || d > a.lastDate)) a.lastDate = d;
    by.set(k, a);
  }
  return [...by.values()].map(({ _ip, _cp, ...a }) => ({
    ...a,
    ctr: a.impressions ? +(a.clicks / a.impressions).toFixed(4) : 0,
    avgPosition: a.impressions ? +(_ip / a.impressions).toFixed(1) : null, // impression-weighted avg position
    avgClickPosition: a.clicks ? +(_cp / a.clicks).toFixed(1) : null,
  })).sort((x, y) => y.impressions - x.impressions || y.clicks - x.clicks);
}

export async function collect(cfg, ctx = {}) {
  const siteUrl = await resolveSite(cfg, ctx);
  if (!siteUrl) throw new Error("No site URL: set one in the Bing settings.");
  const [q, p, c] = await Promise.all([
    call(cfg, ctx, "GetQueryStats", { siteUrl }),
    call(cfg, ctx, "GetPageStats", { siteUrl }),
    call(cfg, ctx, "GetCrawlStats", { siteUrl }),
  ]);
  const crawl = (c || []).map((r) => ({
    date: parseBingDate(r.Date), crawledPages: r.CrawledPages ?? 0, inIndex: r.InIndex ?? 0, inLinks: r.InLinks ?? 0,
    crawlErrors: r.CrawlErrors ?? 0, blockedByRobotsTxt: r.BlockedByRobotsTxt ?? 0,
    code2xx: r.Code2xx ?? 0, code301: r.Code301 ?? 0, code302: r.Code302 ?? 0, code4xx: r.Code4xx ?? 0, code5xx: r.Code5xx ?? 0,
    dnsFailures: r.DnsFailures ?? 0, connectionTimeout: r.ConnectionTimeout ?? 0, containsMalware: r.ContainsMalware ?? 0,
  })).sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const queries = aggregate(q, "query").slice(0, 100);
  const pages = aggregate(p, "url").slice(0, 100);
  const sum = (arr, k) => arr.reduce((s, r) => s + (r[k] || 0), 0);
  return {
    siteUrl,
    totals: { impressions: sum(queries, "impressions"), clicks: sum(queries, "clicks"), queries: queries.length },
    queries, pages,
    crawl: { latest: crawl[0] || null, recent: crawl.slice(0, 14) },
  };
}

// Push URLs to Bing (SubmitUrlBatch). Bing caps batches and a daily quota; send in chunks of 500.
export async function submitUrls(cfg, urls, ctx = {}) {
  const list = [...new Set((urls || []).filter(Boolean))];
  if (!list.length) return { ok: true, submitted: 0, detail: "No URLs to submit." };
  let sent = 0;
  try {
    const siteUrl = cfg.siteUrl || ctx.site;
    if (!siteUrl) throw new Error("No site URL: set one in the Bing settings.");
    for (let i = 0; i < list.length; i += 500) {
      const urlList = list.slice(i, i + 500);
      await call(cfg, ctx, "SubmitUrlBatch", {}, { siteUrl, urlList });
      sent += urlList.length;
    }
    return { ok: true, submitted: sent, detail: `Submitted ${sent} URL${sent === 1 ? "" : "s"} to Bing.` };
  } catch (e) { return { ok: false, submitted: sent, detail: e.message }; }
}
