import { test } from "node:test";
import assert from "node:assert/strict";
import * as cf from "../../server/integrations/cloudflare.mjs";
import { mockFetch, json } from "./_mock.mjs";

const cfg = { apiToken: "TOKEN", zoneId: "023e105f4ecef8ad9ca31a8372d0c353" };
const GQL = "https://api.cloudflare.com/client/v4/graphql";
const UA = {
  gpt: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot",
  chat: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot",
  pplx: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)",
  claude: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)",
  human: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Chrome/126 Safari/537.36",
};

test("classify(): maps user agents to bots", () => {
  assert.equal(cf.classify(UA.gpt)[0], "GPTBot");
  assert.equal(cf.classify(UA.chat)[0], "ChatGPT-User");
  assert.equal(cf.classify("Mozilla/5.0 (compatible; Claude-SearchBot/1.0)")[0], "Claude-SearchBot");
  assert.equal(cf.classify("Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)")[0], "bingbot");
  assert.equal(cf.classify(UA.human), null);
});

test("test(): GET zone with Bearer token", async () => {
  const fetch = mockFetch([[`https://api.cloudflare.com/client/v4/zones/${cfg.zoneId}`, json({ success: true, errors: [], messages: [], result: { id: cfg.zoneId, name: "brand.com", status: "active", plan: { name: "Free Website" } } })]]);
  const r = await cf.test(cfg, { fetch });
  assert.deepEqual(r, { ok: true, detail: "Connected to brand.com (Free Website, active)" });
  assert.equal(fetch.calls[0].headers.authorization, "Bearer TOKEN");
});

test("test(): bad token → ok:false readable", async () => {
  const fetch = mockFetch([["https://api.cloudflare.com/", json({ success: false, errors: [{ code: 10000, message: "Authentication error" }], messages: [], result: null }, 403)]]);
  const r = await cf.test(cfg, { fetch });
  assert.equal(r.ok, false);
  assert.match(r.detail, /Cloudflare rejected the API token/);
  assert.doesNotMatch(r.detail, /TOKEN/);
});

// Answers the settings query, then the aliased data query (u0/p0 per 1-day chunk).
function gqlMock({ maxDuration = 86400, notOlderThan = 691200, failFirstData } = {}) {
  let dataCalls = 0;
  return mockFetch([[GQL, (url, init) => {
    const { query, variables } = JSON.parse(init.body);
    if (query.includes("settings")) return json({ data: { viewer: { zones: [{ settings: { httpRequestsAdaptiveGroups: { enabled: true, maxDuration, notOlderThan, maxPageSize: 10000 } } }] } }, errors: null });
    dataCalls++;
    if (failFirstData && dataCalls === 1) return json({ data: null, errors: [{ message: "cannot request data older than 86400s", path: ["viewer", "zones", 0, "u0"] }] });
    const zone = {};
    for (const k of Object.keys(variables).filter((v) => /^f\d+$/.test(v))) {
      const i = k.slice(1);
      zone[`u${i}`] = [{ count: 100, dimensions: { userAgent: UA.gpt } }, { count: 10, dimensions: { userAgent: UA.chat } }, { count: 5, dimensions: { userAgent: UA.pplx } }, { count: 3, dimensions: { userAgent: UA.human } }];
      if (query.includes(`p${i}:`)) zone[`p${i}`] = [{ count: 60, dimensions: { clientRequestPath: "/pricing" } }, { count: 40, dimensions: { clientRequestPath: "/" } }];
    }
    return json({ data: { viewer: { zones: [zone] } }, errors: null });
  }]]);
}

test("collect(): reads limits, chunks 7 days into 1-day aliases, classifies bots", async () => {
  const fetch = gqlMock();
  const r = await cf.collect(cfg, { fetch });
  assert.equal(fetch.calls.length, 2);
  const { query, variables } = fetch.calls[1].body;
  assert.equal(fetch.calls[1].headers.authorization, "Bearer TOKEN");
  assert.match(query, /httpRequestsAdaptiveGroups/);
  assert.match(query, /\$f0: ZoneHttpRequestsAdaptiveGroupsFilter_InputObject/);
  assert.equal(variables.zoneTag, cfg.zoneId);
  const fs = Object.keys(variables).filter((k) => /^f\d+$/.test(k));
  assert.equal(fs.length, 7);
  for (const k of fs) {
    const f = variables[k];
    assert.ok(Date.parse(f.datetime_lt) - Date.parse(f.datetime_geq) <= 86400e3);
    assert.equal(f.requestSource, "eyeball");
    assert.ok(f.OR.some((o) => o.userAgent_like === "%GPTBot%"));
  }
  assert.equal(r.window.days, 7);
  assert.deepEqual(r.bots.map((b) => [b.bot, b.requests]), [["GPTBot", 700], ["ChatGPT-User", 70], ["PerplexityBot", 35]]);
  assert.equal(r.total, 805);
  assert.deepEqual(r.topPaths[0], { path: "/pricing", requests: 420 });
  assert.equal(r.bots[0].owner, "OpenAI");
});

test("collect(): falls back to a 1-day window on a time-range error", async () => {
  const fetch = gqlMock({ failFirstData: true });
  const r = await cf.collect(cfg, { fetch });
  assert.equal(fetch.calls.length, 3);
  assert.equal(Object.keys(fetch.calls[2].body.variables).filter((k) => /^f\d+$/.test(k)).length, 1);
  assert.equal(r.window.days, 1);
  assert.equal(r.total, 115);
});

test("collect(): GraphQL auth failure throws a readable error", async () => {
  const fetch = mockFetch([[GQL, json({ data: null, errors: [{ message: "not authorized for that account" }] }, 403)]]);
  await assert.rejects(cf.collect(cfg, { fetch }), /Cloudflare rejected the API token/);
});
