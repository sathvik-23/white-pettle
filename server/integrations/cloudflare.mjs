// Cloudflare (free plan works): counts AI crawler / AI agent hits on your site from Cloudflare's edge logs.
// REST: https://developers.cloudflare.com/api/  GraphQL Analytics: https://developers.cloudflare.com/analytics/graphql-api/
// Dataset: httpRequestsAdaptiveGroups. Per-plan limits (maxDuration / notOlderThan, in seconds) are read from the
// `settings` node first, and the window is split into ≤maxDuration chunks queried as aliases in one GraphQL request.
import { http, safeTest, clip } from "./_http.mjs";

const API = "https://api.cloudflare.com/client/v4";
const DAY = 86400;

export const meta = {
  id: "cloudflare",
  name: "Cloudflare",
  category: "crawlers",
  auth: "key",
  free: true,
  fields: [
    { key: "apiToken", label: "API token", secret: true, placeholder: "Cloudflare API token", help: "dash.cloudflare.com → My Profile → API Tokens → Create Token → Custom: permissions Zone › Analytics › Read and Zone › Zone › Read, for your site's zone." },
    { key: "zoneId", label: "Zone ID", secret: false, placeholder: "32-character zone ID", help: "Your domain's Overview page in the Cloudflare dashboard → API section (right column) → Zone ID." },
  ],
  blurb: "Shows which AI crawlers and AI assistants (GPTBot, ChatGPT-User, PerplexityBot, ClaudeBot…) actually fetch your pages, and which pages they read most.",
  docs: "https://dash.cloudflare.com/profile/api-tokens",
};

// User-agent tokens (case-sensitive substrings). Order matters only where one token contains another (none here).
// Google-Extended and Applebot-Extended are robots.txt-only tokens and never appear in a user-agent, so they can't be counted.
export const BOTS = [
  ["GPTBot", "OpenAI", "training"], ["OAI-SearchBot", "OpenAI", "search"], ["ChatGPT-User", "OpenAI", "user"],
  ["PerplexityBot", "Perplexity", "search"], ["Perplexity-User", "Perplexity", "user"],
  ["ClaudeBot", "Anthropic", "training"], ["Claude-SearchBot", "Anthropic", "search"], ["Claude-User", "Anthropic", "user"],
  ["Googlebot", "Google", "search"], ["Google-CloudVertexBot", "Google", "user"], ["bingbot", "Microsoft", "search"],
  ["Applebot", "Apple", "search"], ["Amazonbot", "Amazon", "search"], ["Bytespider", "ByteDance", "training"], ["CCBot", "Common Crawl", "training"],
  ["meta-externalagent", "Meta", "training"], ["meta-externalfetcher", "Meta", "user"], ["DuckAssistBot", "DuckDuckGo", "search"],
  ["MistralAI-User", "Mistral", "user"],
];
export const classify = (ua) => BOTS.find(([t]) => String(ua || "").includes(t)) || null;

async function rest(cfg, ctx, path) {
  if (!cfg?.apiToken) throw new Error("Add a Cloudflare API token first.");
  const r = await http(ctx, `${API}${path}`, { headers: { authorization: `Bearer ${cfg.apiToken}`, accept: "application/json" } });
  if (r.status === 0) throw new Error(`Couldn't reach Cloudflare (${r.error}).`);
  const msg = clip(r.data?.errors?.map((e) => e.message).join("; "));
  if (r.status === 401 || r.status === 403 || /authenticat/i.test(msg)) throw new Error(`Cloudflare rejected the API token${msg ? ` (${msg})` : ""}. It needs Zone › Zone › Read and Zone › Analytics › Read for this zone.`);
  if (r.status === 404 || /invalid zone|could not route/i.test(msg)) throw new Error("Cloudflare couldn't find that zone ID (or the token can't see it).");
  if (!r.ok || r.data?.success === false) throw new Error(`Cloudflare error ${r.status}${msg ? `: ${msg}` : ""}`);
  return r.data?.result;
}

async function gql(cfg, ctx, query, variables) {
  if (!cfg?.apiToken) throw new Error("Add a Cloudflare API token first.");
  const r = await http(ctx, `${API}/graphql`, { method: "POST", json: { query, variables }, headers: { authorization: `Bearer ${cfg.apiToken}` } });
  if (r.status === 0) throw new Error(`Couldn't reach Cloudflare (${r.error}).`);
  const errs = (r.data?.errors || []).map((e) => e.message).filter(Boolean);
  if (r.status === 401 || r.status === 403 || errs.some((m) => /authenticat|not authori[sz]ed|permission/i.test(m))) throw new Error("Cloudflare rejected the API token for analytics. Add the Zone › Analytics › Read permission.");
  if (!r.ok || errs.length) { const e = new Error(`Cloudflare analytics error${errs.length ? `: ${clip(errs.join("; "), 300)}` : ` ${r.status}`}`); e.gql = errs.join("; "); throw e; }
  return r.data?.data?.viewer?.zones?.[0] || {};
}

export async function test(cfg, ctx = {}) {
  return safeTest(async () => {
    if (!cfg.zoneId) return { ok: false, detail: "Add your Cloudflare Zone ID." };
    const z = await rest(cfg, ctx, `/zones/${encodeURIComponent(cfg.zoneId)}`);
    return { ok: true, detail: `Connected to ${z?.name || cfg.zoneId} (${z?.plan?.name || "unknown plan"}, ${z?.status || "unknown status"})` };
  });
}

// Read this zone's limits for the dataset. Falls back to conservative free-plan-ish guesses if the settings node errors.
async function limits(cfg, ctx) {
  try {
    const z = await gql(cfg, ctx, `query($zoneTag: string) { viewer { zones(filter: { zoneTag: $zoneTag }) { settings { httpRequestsAdaptiveGroups { enabled maxDuration notOlderThan maxPageSize } } } } }`, { zoneTag: cfg.zoneId });
    const s = z.settings?.httpRequestsAdaptiveGroups;
    if (s) return { enabled: s.enabled !== false, maxDuration: +s.maxDuration || DAY, notOlderThan: +s.notOlderThan || 7 * DAY, maxPageSize: +s.maxPageSize || 1000 };
  } catch (e) { if (/token|permission|authenticat/i.test(e.message)) throw e; }
  return { enabled: true, maxDuration: DAY, notOlderThan: 7 * DAY, maxPageSize: 1000 };
}

const isTimeError = (m) => /time range|too old|older than|notOlderThan|max(imum)?\s*duration|exceed|out of range|datetime/i.test(m || "");

// One GraphQL request, one alias per time chunk (u0, u1…: by userAgent; p0, p1…: by path).
function buildQuery(chunks, { paths, uaLimit, pathLimit }) {
  const vars = chunks.map((_, i) => `$f${i}: ZoneHttpRequestsAdaptiveGroupsFilter_InputObject`).join(", ");
  const body = chunks.map((_, i) => `u${i}: httpRequestsAdaptiveGroups(limit: ${uaLimit}, filter: $f${i}, orderBy: [count_DESC]) { count dimensions { userAgent } }`
    + (paths ? `\n p${i}: httpRequestsAdaptiveGroups(limit: ${pathLimit}, filter: $f${i}, orderBy: [count_DESC]) { count dimensions { clientRequestPath } }` : "")).join("\n");
  return `query($zoneTag: string, ${vars}) { viewer { zones(filter: { zoneTag: $zoneTag }) {\n${body}\n} } }`;
}

async function runWindow(cfg, ctx, seconds, chunkSec, opts) {
  const now = Math.floor(Date.now() / 1000) - 60, chunks = [];
  for (let end = now; end > now - seconds && chunks.length < 14; end -= chunkSec) chunks.push([Math.max(end - chunkSec, now - seconds), end]);
  const iso = (s) => new Date(s * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const ua = BOTS.map(([t]) => ({ userAgent_like: `%${t}%` }));
  const variables = { zoneTag: cfg.zoneId };
  chunks.forEach(([a, b], i) => { variables[`f${i}`] = { datetime_geq: iso(a), datetime_lt: iso(b), requestSource: "eyeball", OR: ua }; });
  const z = await gql(cfg, ctx, buildQuery(chunks, opts), variables);
  return { z, chunks, from: iso(chunks.at(-1)[0]), to: iso(chunks[0][1]) };
}

export async function collect(cfg, ctx = {}) {
  if (!cfg.zoneId) throw new Error("Add your Cloudflare Zone ID.");
  const lim = await limits(cfg, ctx);
  if (!lim.enabled) throw new Error("Cloudflare's request analytics (httpRequestsAdaptiveGroups) isn't available for this zone.");
  const want = Math.min(7 * DAY, Math.max(DAY, lim.notOlderThan - 3600));
  const chunkSec = Math.max(3600, Math.min(lim.maxDuration, want));
  const opts = { paths: true, uaLimit: Math.min(1000, lim.maxPageSize), pathLimit: 20 };
  let res;
  try { res = await runWindow(cfg, ctx, want, chunkSec, opts); }
  catch (e) {
    if (isTimeError(e.gql)) res = await runWindow(cfg, ctx, DAY, Math.min(chunkSec, DAY), opts);       // shorter window
    else if (/clientRequestPath|unknown field|not available|cannot query field/i.test(e.gql || "")) res = await runWindow(cfg, ctx, want, chunkSec, { ...opts, paths: false }); // plan lacks paths
    else throw e;
  }
  const bots = new Map(), paths = new Map(), agents = new Map();
  res.chunks.forEach((_, i) => {
    for (const g of res.z[`u${i}`] || []) {
      const ua = g.dimensions?.userAgent || "", hit = classify(ua);
      if (!hit) continue;
      const [bot, owner, purpose] = hit, b = bots.get(bot) || { bot, owner, purpose, requests: 0 };
      b.requests += g.count || 0; bots.set(bot, b);
      agents.set(ua, (agents.get(ua) || 0) + (g.count || 0));
    }
    for (const g of res.z[`p${i}`] || []) { const p = g.dimensions?.clientRequestPath; if (p) paths.set(p, (paths.get(p) || 0) + (g.count || 0)); }
  });
  const list = [...bots.values()].sort((a, b) => b.requests - a.requests);
  return {
    window: { from: res.from, to: res.to, days: +((Date.parse(res.to) - Date.parse(res.from)) / 864e5).toFixed(1) },
    bots: list,
    total: list.reduce((s, b) => s + b.requests, 0),
    ...(paths.size ? { topPaths: [...paths].map(([path, requests]) => ({ path, requests })).sort((a, b) => b.requests - a.requests).slice(0, 20) } : {}),
    topUserAgents: [...agents].map(([userAgent, requests]) => ({ userAgent, requests })).sort((a, b) => b.requests - a.requests).slice(0, 10),
  };
}
