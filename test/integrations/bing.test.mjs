import { test } from "node:test";
import assert from "node:assert/strict";
import * as bing from "../../server/integrations/bing.mjs";
import { mockFetch, json } from "./_mock.mjs";

const BASE = "https://ssl.bing.com/webmaster/api.svc/json/";
const cfg = { apiKey: "KEY123", siteUrl: "https://brand.com/" };
// Response shapes from the Microsoft Learn IWebmasterApi reference samples.
const sites = { d: [{ __type: "Site:#Microsoft.Bing.Webmaster.Api", AuthenticationCode: "258CAD", DnsVerificationCode: "x.brand.com", IsVerified: true, Url: "https://brand.com/" }, { __type: "Site:#Microsoft.Bing.Webmaster.Api", IsVerified: false, Url: "https://other.com/" }] };
const qs = (Query, Impressions, Clicks, pos, date) => ({ __type: "QueryStats:#Microsoft.Bing.Webmaster.Api", AvgClickPosition: pos, AvgImpressionPosition: pos, Clicks, Date: `/Date(${date}-0700)/`, Impressions, Query });

test("parseBingDate handles WCF dates with and without offsets", () => {
  assert.equal(bing.parseBingDate("/Date(1316156400000-0700)/"), "2011-09-16T07:00:00.000Z");
  assert.equal(bing.parseBingDate("/Date(1700000000000)/"), "2023-11-14T22:13:20.000Z");
  assert.equal(bing.parseBingDate("nope"), null);
});

test("test(): GetUserSites with apikey, finds the verified site", async () => {
  const fetch = mockFetch([[`${BASE}GetUserSites`, json(sites)]]);
  const r = await bing.test(cfg, { fetch, site: "https://brand.com" });
  assert.equal(r.ok, true);
  assert.match(r.detail, /https:\/\/brand\.com\/ \(1 verified site\)/);
  const u = new URL(fetch.calls[0].url);
  assert.equal(u.searchParams.get("apikey"), "KEY123");
  assert.equal(fetch.calls[0].method, "GET");
});

test("test(): invalid key (ApiFault InvalidApiKey) → ok:false readable", async () => {
  const fetch = mockFetch([[BASE, json({ ErrorCode: 3, Message: "ERROR!!! InvalidApiKey" }, 400)]]);
  const r = await bing.test(cfg, { fetch });
  assert.equal(r.ok, false);
  assert.match(r.detail, /Bing rejected the API key/);
  assert.doesNotMatch(r.detail, /KEY123/);
});

test("test(): 401 → ok:false", async () => {
  const r = await bing.test(cfg, { fetch: mockFetch([[BASE, json({}, 401)]]) });
  assert.deepEqual([r.ok, /rejected the API key/.test(r.detail)], [false, true]);
});

test("collect(): aggregates weekly query/page rows, sorts, parses crawl stats", async () => {
  const fetch = mockFetch([
    [`${BASE}GetQueryStats`, json({ d: [qs("best crm", 100, 10, 4, 1700000000000), qs("best crm", 300, 5, 8, 1700604800000), qs("brand pricing", 50, 20, 1, 1700000000000)] })],
    [`${BASE}GetPageStats`, json({ d: [qs("https://brand.com/pricing", 80, 8, 3, 1700000000000)] })],
    [`${BASE}GetCrawlStats`, json({ d: [
      { __type: "CrawlStats:#Microsoft.Bing.Webmaster.Api", AllOtherCodes: 0, BlockedByRobotsTxt: 0, Code2xx: 9998, Code301: 0, Code302: 0, Code4xx: 1, Code5xx: 1, ContainsMalware: 0, CrawlErrors: 0, CrawledPages: 120, Date: "/Date(1316156400000-0700)/", InIndex: 1000, InLinks: 2048 },
      { CrawledPages: 140, InIndex: 1010, Date: "/Date(1316761200000-0700)/" },
    ] })],
  ]);
  const r = await bing.collect(cfg, { fetch });
  assert.equal(r.siteUrl, "https://brand.com/");
  assert.equal(r.queries[0].query, "best crm");
  assert.equal(r.queries[0].impressions, 400);
  assert.equal(r.queries[0].clicks, 15);
  assert.equal(r.queries[0].avgPosition, 7); // (100*4 + 300*8) / 400
  assert.equal(r.queries[0].lastDate, "2023-11-21T22:13:20.000Z");
  assert.equal(r.pages[0].url, "https://brand.com/pricing");
  assert.equal(r.crawl.latest.crawledPages, 140);
  assert.equal(r.crawl.recent.length, 2);
  assert.deepEqual(r.totals, { impressions: 450, clicks: 35, queries: 2 });
  for (const c of fetch.calls) assert.equal(new URL(c.url).searchParams.get("siteUrl"), "https://brand.com/");
});

test("collect(): resolves site from GetUserSites when siteUrl is blank", async () => {
  const fetch = mockFetch([[`${BASE}GetUserSites`, json(sites)], [BASE, json({ d: [] })]]);
  const r = await bing.collect({ apiKey: "K" }, { fetch, host: "brand.com", site: "https://brand.com" });
  assert.equal(r.siteUrl, "https://brand.com/");
});

test("submitUrls(): POSTs SubmitUrlBatch JSON body", async () => {
  const fetch = mockFetch([[`${BASE}SubmitUrlBatch`, json({ d: null })]]);
  const r = await bing.submitUrls(cfg, ["https://brand.com/a", "https://brand.com/b", "https://brand.com/a"], { fetch });
  assert.equal(r.ok, true);
  assert.equal(r.submitted, 2);
  const c = fetch.calls[0];
  assert.equal(c.method, "POST");
  assert.equal(new URL(c.url).searchParams.get("apikey"), "KEY123");
  assert.deepEqual(c.body, { siteUrl: "https://brand.com/", urlList: ["https://brand.com/a", "https://brand.com/b"] });
  assert.match(c.headers["content-type"], /application\/json/);
});

test("submitUrls(): quota/throttle → ok:false", async () => {
  const r = await bing.submitUrls(cfg, ["https://brand.com/a"], { fetch: mockFetch([[BASE, json({ ErrorCode: 4, Message: "ThrottleUser" }, 400)]]) });
  assert.equal(r.ok, false);
  assert.match(r.detail, /rate-limiting|quota/);
});
