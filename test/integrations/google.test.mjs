import { test } from "node:test";
import assert from "node:assert/strict";
import * as g from "../../server/integrations/google.mjs";
import { mockFetch, json } from "./_mock.mjs";

const fresh = () => ({ accessToken: "AT", refreshToken: "RT", expiresAt: Date.now() + 3600e3, clientId: "CID", clientSecret: "CS", gscProperty: "sc-domain:brand.com", ga4PropertyId: "123456" });
const idToken = (p) => `h.${Buffer.from(JSON.stringify(p)).toString("base64url")}.s`;

test("oauthUrl(): scopes, offline access, consent, state", () => {
  const u = new URL(g.oauthUrl({ clientId: "CID", redirectUri: "https://app/cb", state: "xyz" }));
  assert.equal(u.origin + u.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  const p = Object.fromEntries(u.searchParams);
  assert.deepEqual(p.scope.split(" "), ["https://www.googleapis.com/auth/webmasters.readonly", "https://www.googleapis.com/auth/analytics.readonly", "openid", "email"]);
  assert.deepEqual([p.client_id, p.redirect_uri, p.response_type, p.access_type, p.prompt, p.include_granted_scopes, p.state], ["CID", "https://app/cb", "code", "offline", "consent", "true", "xyz"]);
});

test("exchangeCode(): form POST to token endpoint, decodes email from id_token", async () => {
  const fetch = mockFetch([["https://oauth2.googleapis.com/token", json({ access_token: "AT", expires_in: 3599, refresh_token: "RT", scope: "openid email", token_type: "Bearer", id_token: idToken({ email: "me@brand.com" }) })]]);
  const t0 = Date.now();
  const r = await g.exchangeCode({ clientId: "CID", clientSecret: "CS", redirectUri: "https://app/cb", code: "C0DE", fetch });
  assert.deepEqual([r.accessToken, r.refreshToken, r.email], ["AT", "RT", "me@brand.com"]);
  assert.ok(r.expiresAt >= t0 + 3598e3);
  const c = fetch.calls[0];
  assert.equal(c.method, "POST");
  assert.equal(c.headers["content-type"], "application/x-www-form-urlencoded");
  assert.deepEqual(Object.fromEntries(new URLSearchParams(c.rawBody)), { code: "C0DE", client_id: "CID", client_secret: "CS", redirect_uri: "https://app/cb", grant_type: "authorization_code" });
});

test("ensureToken(): no-op while valid; refreshes when expiring and reports changed", async () => {
  const none = mockFetch([]);
  assert.deepEqual((await g.ensureToken(fresh(), { fetch: none })).changed, false);
  assert.equal(none.calls.length, 0);
  const fetch = mockFetch([["https://oauth2.googleapis.com/token", json({ access_token: "AT2", expires_in: 3599, token_type: "Bearer" })]]);
  const cfg = { ...fresh(), expiresAt: Date.now() + 30e3 };
  let saved = null;
  const r = await g.ensureToken(cfg, { fetch, onToken: (t) => { saved = t; } });
  assert.deepEqual([r.accessToken, r.changed, cfg.accessToken, saved.accessToken], ["AT2", true, "AT2", "AT2"]);
  assert.equal(new URLSearchParams(fetch.calls[0].rawBody).get("grant_type"), "refresh_token");
});

test("ensureToken(): revoked refresh token → readable error", async () => {
  const fetch = mockFetch([["https://oauth2.googleapis.com/token", json({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, 400)]]);
  await assert.rejects(g.ensureToken({ ...fresh(), expiresAt: 0 }, { fetch }), /expired or was revoked. Reconnect Google/);
});

const sitesRes = { siteEntry: [{ siteUrl: "sc-domain:brand.com", permissionLevel: "siteOwner" }, { siteUrl: "https://old.com/", permissionLevel: "siteUnverifiedUser" }] };
const summaries = { accountSummaries: [{ name: "accountSummaries/1", account: "accounts/1", displayName: "Brand Inc", propertySummaries: [{ property: "properties/123456", displayName: "brand.com GA4", propertyType: "PROPERTY_TYPE_ORDINARY", parent: "accounts/1" }] }] };

test("listProperties() / test(): Bearer auth, filters unverified sites", async () => {
  const fetch = mockFetch([["https://www.googleapis.com/webmasters/v3/sites", json(sitesRes)], ["https://analyticsadmin.googleapis.com/v1beta/accountSummaries", json(summaries)]]);
  const r = await g.listProperties(fresh(), { fetch });
  assert.deepEqual(r, { gsc: ["sc-domain:brand.com"], ga4: [{ id: "123456", name: "brand.com GA4", account: "Brand Inc" }] });
  for (const c of fetch.calls) assert.equal(c.headers.authorization, "Bearer AT");
  const t = await g.test(fresh(), { fetch });
  assert.equal(t.ok, true);
  assert.match(t.detail, /1 Search Console property, 1 GA4 property/);
});

test("test(): 401 → ok:false readable", async () => {
  const fetch = mockFetch([["https://www.googleapis.com/", json({ error: { code: 401, message: "Request had invalid authentication credentials.", status: "UNAUTHENTICATED" } }, 401)]]);
  const r = await g.test(fresh(), { fetch });
  assert.equal(r.ok, false);
  assert.match(r.detail, /Search Console rejected the access token/);
});

test("test(): 403 API disabled → tells the user to enable it", async () => {
  const fetch = mockFetch([["https://www.googleapis.com/", json({ error: { code: 403, message: "Google Search Console API has not been used in project 123 before or it is disabled.", status: "PERMISSION_DENIED" } }, 403)]]);
  const r = await g.test(fresh(), { fetch });
  assert.equal(r.ok, false);
  assert.match(r.detail, /isn't enabled/);
});

const gscRow = (k, clicks, impressions, ctr, position) => ({ keys: [k], clicks, impressions, ctr, position });
const ga4Row = (dim, s, e, k) => ({ dimensionValues: [{ value: dim }], metricValues: [{ value: String(s) }, { value: String(e) }, { value: String(k) }] });

test("collect(): Search Console + GA4 AI-source reports", async () => {
  const gscUrl = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent("sc-domain:brand.com")}/searchAnalytics/query`;
  const fetch = mockFetch([
    [gscUrl, (url, init) => {
      const b = JSON.parse(init.body);
      if (!b.dimensions) return json({ rows: [{ clicks: 120, impressions: 4000, ctr: 0.03, position: 9.4 }], responseAggregationType: "byProperty" });
      if (b.dimensions[0] === "query") return json({ rows: [gscRow("best crm for startups", 40, 900, 0.0444, 5.21), gscRow("brand reviews", 30, 300, 0.1, 2.0), gscRow("crm", 1, 2000, 0.0005, 31.7)], responseAggregationType: "byProperty" });
      return json({ rows: [gscRow("https://brand.com/", 80, 2500, 0.032, 6.1)] });
    }],
    ["https://analyticsdata.googleapis.com/v1beta/properties/123456:runReport", (url, init) => {
      const b = JSON.parse(init.body);
      if (b.dimensions[0].name === "sessionSource") return json({
        dimensionHeaders: [{ name: "sessionSource" }], metricHeaders: [{ name: "sessions", type: "TYPE_INTEGER" }, { name: "engagedSessions", type: "TYPE_INTEGER" }, { name: "keyEvents", type: "TYPE_FLOAT" }],
        rows: [ga4Row("chatgpt.com", 50, 30, 4), ga4Row("perplexity.ai", 20, 12, 1), ga4Row("chat.openai.com", 5, 2, 0)],
        totals: [{ dimensionValues: [{ value: "RESERVED_TOTAL" }], metricValues: [{ value: "75" }, { value: "44" }, { value: "5" }] }], rowCount: 3, kind: "analyticsData#runReport",
      });
      return json({ dimensionHeaders: [{ name: "landingPage" }], rows: [ga4Row("/pricing", 30, 20, 3)], rowCount: 1 });
    }],
  ]);
  const r = await g.collect(fresh(), { fetch, queries: ["Best CRM for startups in 2026", "brand reviews"] });

  // Search Console request shape
  const gq = fetch.calls.filter((c) => c.url === gscUrl);
  assert.equal(gq.length, 3);
  for (const c of gq) { assert.equal(c.method, "POST"); assert.equal(c.headers.authorization, "Bearer AT"); assert.match(c.body.startDate, /^\d{4}-\d{2}-\d{2}$/); assert.equal(c.body.type, "web"); }
  const days = (Date.parse(gq[0].body.endDate) - Date.parse(gq[0].body.startDate)) / 864e5 + 1;
  assert.equal(days, 28);
  assert.deepEqual(r.gsc.totals, { clicks: 120, impressions: 4000, ctr: 0.03, position: 9.4 });
  assert.equal(r.gsc.queries.length, 3);
  assert.deepEqual(r.gsc.queries[0], { query: "best crm for startups", clicks: 40, impressions: 900, ctr: 0.0444, position: 5.2 });
  assert.equal(r.gsc.pages[0].page, "https://brand.com/");
  // "best crm for startups" is contained in the buyer question; "crm" too (either-way contains).
  assert.deepEqual(r.gsc.tracked[0].rows.map((x) => x.query), ["best crm for startups", "crm"]);
  assert.deepEqual(r.gsc.tracked[1].rows.map((x) => x.query), ["brand reviews"]);

  // GA4 request shape
  const ga = fetch.calls.filter((c) => c.url.includes("runReport"));
  const src = ga.find((c) => c.body.dimensions[0].name === "sessionSource").body;
  assert.deepEqual(src.metrics.map((m) => m.name), ["sessions", "engagedSessions", "keyEvents"]);
  assert.deepEqual(src.dateRanges, [{ startDate: "28daysAgo", endDate: "yesterday" }]);
  assert.equal(src.dimensionFilter.filter.stringFilter.matchType, "PARTIAL_REGEXP");
  assert.equal(src.dimensionFilter.filter.stringFilter.caseSensitive, false);
  const re = new RegExp(src.dimensionFilter.filter.stringFilter.value, "i");
  for (const s of ["chatgpt.com", "chat.openai.com", "perplexity.ai", "gemini.google.com", "copilot.microsoft.com", "claude.ai"]) assert.ok(re.test(s), s);
  for (const s of ["google", "bing.com", "youtube.com", "(direct)"]) assert.ok(!re.test(s), s);
  assert.deepEqual(ga.find((c) => c.body.dimensions[0].name === "landingPage").body.limit, 20);

  assert.deepEqual(r.ga4.totals, { sessions: 75, engagedSessions: 44, keyEvents: 5 });
  assert.deepEqual(r.ga4.bySource[0], { source: "chatgpt.com", assistant: "ChatGPT", sessions: 50, engagedSessions: 30, keyEvents: 4 });
  assert.deepEqual(r.ga4.byAssistant[0], { assistant: "ChatGPT", sessions: 55, engagedSessions: 32, keyEvents: 4 });
  assert.deepEqual(r.ga4.landingPages, [{ page: "/pricing", sessions: 30, engagedSessions: 20, keyEvents: 3 }]);
});

test("collect(): skips parts without a property; isolates part errors", async () => {
  const fetch = mockFetch([[/runReport/, json({ error: { code: 403, message: "User does not have sufficient permissions for this property.", status: "PERMISSION_DENIED" } }, 403)]]);
  const r = await g.collect({ ...fresh(), gscProperty: "" }, { fetch });
  assert.deepEqual(r.gsc, { skipped: "Choose a Search Console property." });
  assert.match(r.ga4.error, /doesn't have access/);
});
