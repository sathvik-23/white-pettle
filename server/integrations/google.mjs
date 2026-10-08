// Google Search Console + GA4 via one OAuth connection (free).
// OAuth web-server flow: https://developers.google.com/identity/protocols/oauth2/web-server
// Search Console API v3: https://developers.google.com/webmaster-tools/v1/api_reference_index
// GA4 Admin (accountSummaries) v1beta + Data API runReport v1beta: https://developers.google.com/analytics/devguides/reporting/data/v1
import { http, safeTest, clip, isoDay, daysAgo } from "./_http.mjs";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const GSC = "https://www.googleapis.com/webmasters/v3";
const GA_ADMIN = "https://analyticsadmin.googleapis.com/v1beta";
const GA_DATA = "https://analyticsdata.googleapis.com/v1beta";
export const SCOPES = ["https://www.googleapis.com/auth/webmasters.readonly", "https://www.googleapis.com/auth/analytics.readonly", "openid", "email"];

export const meta = {
  id: "google",
  name: "Google Search Console + GA4",
  category: "analytics",
  auth: "oauth",
  free: true,
  fields: [
    { key: "gscProperty", label: "Search Console property", secret: false, placeholder: "sc-domain:brand.com or https://brand.com/", help: "Pick after connecting. Domain properties start with sc-domain:." },
    { key: "ga4PropertyId", label: "GA4 property ID", secret: false, placeholder: "123456789", help: "Pick after connecting. GA4 → Admin → Property details → Property ID (numbers only)." },
  ],
  blurb: "Brings in the Google searches you rank for and the visits GA4 sees from ChatGPT, Perplexity, Gemini, Copilot and Claude, so you can tie AI visibility to real traffic.",
  docs: "https://console.cloud.google.com/apis/credentials",
};

// AI assistant referrers as they appear in GA4's sessionSource (hostname or utm_source; ChatGPT adds utm_source=chatgpt.com).
// bing.com is deliberately excluded: Copilot-in-Bing referrals are indistinguishable from normal Bing search.
export const AI_SOURCES = [
  ["ChatGPT", /chatgpt\.com|chat\.openai\.com|openai/i], ["Perplexity", /perplexity/i], ["Gemini", /gemini\.google|bard\.google/i],
  ["Copilot", /copilot\.microsoft|copilot\.cloud\.microsoft|edgeservices\.bing\.com/i], ["Claude", /claude\.ai/i],
  ["DeepSeek", /deepseek/i], ["Meta AI", /meta\.ai/i], ["Grok", /grok\.com/i], ["Mistral", /chat\.mistral\.ai/i], ["You.com", /(^|\.)you\.com/i], ["Poe", /poe\.com/i],
];
// RE2 regex for GA4's PARTIAL_REGEXP filter (case-insensitive).
export const AI_SOURCE_REGEX = "chatgpt\\.com|chat\\.openai\\.com|openai|perplexity|gemini\\.google|bard\\.google|copilot\\.microsoft|copilot\\.cloud\\.microsoft|edgeservices\\.bing\\.com|claude\\.ai|deepseek|meta\\.ai|grok\\.com|chat\\.mistral\\.ai|(^|\\.)you\\.com|poe\\.com";
export const assistantOf = (source) => AI_SOURCES.find(([, re]) => re.test(source || ""))?.[0] || "Other AI";

// ---------- OAuth ----------
export function oauthUrl({ clientId, redirectUri, state }) {
  const q = new URLSearchParams({
    client_id: clientId, redirect_uri: redirectUri, response_type: "code", scope: SCOPES.join(" "),
    access_type: "offline", prompt: "consent", include_granted_scopes: "true", ...(state ? { state } : {}),
  });
  return `${AUTH_URL}?${q}`;
}

// The id_token came straight from Google's token endpoint over TLS, so decoding (not verifying) it is fine here.
function emailFromIdToken(t) {
  try { return JSON.parse(Buffer.from(String(t).split(".")[1], "base64url").toString("utf8")).email || null; } catch { return null; }
}

async function tokenCall(ctx, params) {
  const r = await http(ctx, TOKEN_URL, { method: "POST", body: new URLSearchParams(params).toString(), headers: { "content-type": "application/x-www-form-urlencoded" } });
  if (r.status === 0) throw new Error(`Couldn't reach Google (${r.error}).`);
  if (!r.ok || !r.data?.access_token) {
    const e = r.data?.error;
    if (e === "invalid_grant") throw new Error("Google access expired or was revoked. Reconnect Google.");
    if (e === "invalid_client" || e === "unauthorized_client") throw new Error("Google rejected the OAuth client ID/secret. Check the Google Cloud OAuth client.");
    if (e === "redirect_uri_mismatch") throw new Error("Google rejected the redirect URI. Add it to the OAuth client's authorised redirect URIs.");
    throw new Error(`Google token error ${r.status}${e ? `: ${e}` : ""}${r.data?.error_description ? ` (${clip(r.data.error_description)})` : ""}`);
  }
  return r.data;
}

export async function exchangeCode({ clientId, clientSecret, redirectUri, code, fetch: f }) {
  const d = await tokenCall({ fetch: f }, { code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: "authorization_code" });
  return { accessToken: d.access_token, refreshToken: d.refresh_token || null, expiresAt: Date.now() + (d.expires_in || 3600) * 1000, email: emailFromIdToken(d.id_token), scope: d.scope || "" };
}

// "Sign in with Google": identity only (openid email profile), no offline access, separate from the Search Console
// connection above. The claims come from the id_token Google's token endpoint returned over TLS.
export function loginUrl({ clientId, redirectUri, state }) {
  const q = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: "code", scope: "openid email profile", prompt: "select_account", state });
  return `${AUTH_URL}?${q}`;
}
export async function exchangeLogin({ clientId, clientSecret, redirectUri, code, fetch: f }) {
  const d = await tokenCall({ fetch: f }, { code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: "authorization_code" });
  let c = {};
  try { c = JSON.parse(Buffer.from(String(d.id_token).split(".")[1], "base64url").toString("utf8")); } catch {}
  if (!c.sub || !c.email) throw new Error("Google didn't return an email for this account.");
  return { sub: String(c.sub), email: String(c.email).toLowerCase(), emailVerified: c.email_verified === true || c.email_verified === "true", name: c.name || null };
}

const toMs = (v) => (v == null || v === "" ? 0 : typeof v === "number" ? v : /^\d+$/.test(v) ? +v : Date.parse(v) || 0);

// Refresh if missing or expiring within 2 minutes. Mutates cfg with the new token and calls ctx.onToken (caller persists).
export async function ensureToken(cfg, ctx = {}) {
  const exp = toMs(cfg.expiresAt);
  if (cfg.accessToken && exp - Date.now() > 120e3) return { accessToken: cfg.accessToken, expiresAt: exp, changed: false };
  if (!cfg.refreshToken) throw new Error("Google isn't connected (no refresh token). Reconnect Google.");
  if (!cfg.clientId || !cfg.clientSecret) throw new Error("Google OAuth client ID/secret aren't configured on the server.");
  const d = await tokenCall(ctx, { client_id: cfg.clientId, client_secret: cfg.clientSecret, refresh_token: cfg.refreshToken, grant_type: "refresh_token" });
  const out = { accessToken: d.access_token, expiresAt: Date.now() + (d.expires_in || 3600) * 1000, changed: true };
  Object.assign(cfg, { accessToken: out.accessToken, expiresAt: out.expiresAt });
  await ctx.onToken?.({ accessToken: out.accessToken, expiresAt: out.expiresAt });
  return out;
}

// ---------- API calls ----------
async function gapi(cfg, ctx, url, { method = "GET", json, what = "Google" } = {}) {
  const { accessToken } = await ensureToken(cfg, ctx);
  const r = await http(ctx, url, { method, json, headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" } });
  if (r.status === 0) throw new Error(`Couldn't reach ${what} (${r.error}).`);
  if (r.ok) return r.data || {};
  const msg = clip(r.data?.error?.message || r.text);
  if (r.status === 401) throw new Error(`${what} rejected the access token. Reconnect Google.`);
  if (r.status === 403 && /has not been used|is disabled|SERVICE_DISABLED|accessNotConfigured/i.test(msg + JSON.stringify(r.data?.error?.details || ""))) throw new Error(`The ${what} API isn't enabled in your Google Cloud project. Enable it, then retry.`);
  if (r.status === 403) throw new Error(`${what}: this Google account doesn't have access${msg ? ` (${msg})` : ""}.`);
  if (r.status === 404) throw new Error(`${what}: property not found${msg ? ` (${msg})` : ""}.`);
  if (r.status === 429) throw new Error(`${what} quota exceeded. Try again later.`);
  throw new Error(`${what} error ${r.status}${msg ? `: ${msg}` : ""}`);
}

export async function listProperties(cfg, ctx = {}) {
  const sites = await gapi(cfg, ctx, `${GSC}/sites`, { what: "Search Console" });
  const gsc = (sites.siteEntry || []).filter((s) => s.permissionLevel !== "siteUnverifiedUser").map((s) => s.siteUrl);
  const ga4 = [];
  let pageToken = "";
  for (let i = 0; i < 5; i++) { // up to 1,000 accounts
    const d = await gapi(cfg, ctx, `${GA_ADMIN}/accountSummaries?pageSize=200${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`, { what: "Google Analytics Admin" });
    for (const a of d.accountSummaries || []) for (const p of a.propertySummaries || []) ga4.push({ id: String(p.property || "").replace(/^properties\//, ""), name: p.displayName || "", account: a.displayName || "" });
    if (!(pageToken = d.nextPageToken)) break;
  }
  return { gsc, ga4 };
}

export async function test(cfg, ctx = {}) {
  return safeTest(async () => {
    const { gsc, ga4 } = await listProperties(cfg, ctx);
    const who = cfg.email ? `${cfg.email}: ` : "";
    return { ok: true, detail: `Connected (${who}${gsc.length} Search Console propert${gsc.length === 1 ? "y" : "ies"}, ${ga4.length} GA4 propert${ga4.length === 1 ? "y" : "ies"})` };
  });
}

// ---------- collect ----------
const gscRow = (r, key) => ({ [key]: r.keys?.[0], clicks: r.clicks || 0, impressions: r.impressions || 0, ctr: +(r.ctr || 0).toFixed(4), position: +(r.position || 0).toFixed(1) });

async function collectGsc(cfg, ctx) {
  // Search Console data lags ~2 days; take the 28 days ending 2 days ago.
  const end = daysAgo(2), start = daysAgo(27, end);
  const base = { startDate: isoDay(start), endDate: isoDay(end), type: "web" };
  const url = `${GSC}/sites/${encodeURIComponent(cfg.gscProperty)}/searchAnalytics/query`;
  const q = (body) => gapi(cfg, ctx, url, { method: "POST", json: { ...base, ...body }, what: "Search Console" });
  const [tot, qs, pg] = await Promise.all([q({}), q({ dimensions: ["query"], rowLimit: 1000 }), q({ dimensions: ["page"], rowLimit: 50 })]);
  const all = (qs.rows || []).map((r) => gscRow(r, "query"));
  const t = tot.rows?.[0] || {};
  // Buyer questions vs. search queries: match when either contains the other (case-insensitive), over the top 1,000 queries.
  const tracked = (ctx.queries || []).map((cq) => {
    const c = String(cq).toLowerCase().trim();
    return { query: cq, rows: c ? all.filter((r) => { const s = String(r.query).toLowerCase(); return s.includes(c) || c.includes(s); }).slice(0, 20) : [] };
  });
  return {
    property: cfg.gscProperty, startDate: base.startDate, endDate: base.endDate,
    totals: { clicks: t.clicks || 0, impressions: t.impressions || 0, ctr: +(t.ctr || 0).toFixed(4), position: +(t.position || 0).toFixed(1) },
    queries: all.slice(0, 200), pages: (pg.rows || []).map((r) => gscRow(r, "page")), tracked,
  };
}

const metricsOf = (row, names) => Object.fromEntries(names.map((n, i) => [n, Number(row?.metricValues?.[i]?.value || 0)]));

async function collectGa4(cfg, ctx) {
  const id = String(cfg.ga4PropertyId).replace(/^properties\//, "");
  const url = `${GA_DATA}/properties/${encodeURIComponent(id)}:runReport`;
  const metrics = ["sessions", "engagedSessions", "keyEvents"]; // "conversions" was renamed keyEvents (May 2024)
  const base = {
    dateRanges: [{ startDate: "28daysAgo", endDate: "yesterday" }],
    metrics: metrics.map((name) => ({ name })),
    dimensionFilter: { filter: { fieldName: "sessionSource", stringFilter: { matchType: "PARTIAL_REGEXP", value: AI_SOURCE_REGEX, caseSensitive: false } } },
    orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
  };
  const run = (body) => gapi(cfg, ctx, url, { method: "POST", json: { ...base, ...body }, what: "Google Analytics Data" });
  const [src, lp] = await Promise.all([
    run({ dimensions: [{ name: "sessionSource" }], metricAggregations: ["TOTAL"], limit: 50 }),
    run({ dimensions: [{ name: "landingPage" }], limit: 20 }),
  ]);
  const bySource = (src.rows || []).map((r) => ({ source: r.dimensionValues?.[0]?.value, assistant: assistantOf(r.dimensionValues?.[0]?.value), ...metricsOf(r, metrics) }));
  const totals = src.totals?.[0] ? metricsOf(src.totals[0], metrics) : Object.fromEntries(metrics.map((m) => [m, bySource.reduce((s, r) => s + r[m], 0)]));
  const byAssistant = {};
  for (const r of bySource) { const a = (byAssistant[r.assistant] ||= { assistant: r.assistant, sessions: 0, engagedSessions: 0, keyEvents: 0 }); for (const m of metrics) a[m] += r[m]; }
  return {
    propertyId: id, dateRange: "last 28 days", totals, bySource,
    byAssistant: Object.values(byAssistant).sort((a, b) => b.sessions - a.sessions),
    landingPages: (lp.rows || []).map((r) => ({ page: r.dimensionValues?.[0]?.value, ...metricsOf(r, metrics) })),
  };
}

// Each part is independent: a missing property → { skipped }, a failing part → { error } without sinking the other.
export async function collect(cfg, ctx = {}) {
  await ensureToken(cfg, ctx); // fail fast (and refresh once) if the connection is dead
  const part = async (have, why, fn) => { if (!have) return { skipped: why }; try { return await fn(); } catch (e) { return { error: e.message }; } };
  const [gsc, ga4] = await Promise.all([
    part(cfg.gscProperty, "Choose a Search Console property.", () => collectGsc(cfg, ctx)),
    part(cfg.ga4PropertyId, "Choose a GA4 property.", () => collectGa4(cfg, ctx)),
  ]);
  return { gsc, ga4 };
}
