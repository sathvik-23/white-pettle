import { test } from "node:test";
import assert from "node:assert/strict";
import * as serp from "../../server/integrations/serp.mjs";
import { mockFetch, json } from "./_mock.mjs";

const DFS = { backend: "dataforseo", login: "me@brand.com", password: "PW" };
const SAPI = { backend: "serpapi", apiKey: "SKEY" };
const env = (items, extra = {}) => ({ version: "0.1.20250101", status_code: 20000, status_message: "Ok.", time: "3.1 sec.", cost: 0.004, tasks_count: 1, tasks_error: 0,
  tasks: [{ id: "t1", status_code: 20000, status_message: "Ok.", result_count: 1, data: {}, result: [{ keyword: "best crm", type: "organic", se_domain: "google.com", item_types: ["ai_overview", "organic"], items_count: items.length, items, ...extra }] }] });
const aio = { type: "ai_overview", rank_group: 1, rank_absolute: 1, position: "left", markdown: "**Top CRMs** include Brand and Rival.",
  items: [{ type: "ai_overview_element", position: "left", title: "Top CRMs", text: "Brand and Rival lead.", references: [{ type: "ai_overview_reference", source: "G2", domain: "g2.com", url: "https://www.g2.com/best-crm", title: "Best CRM 2026", text: "…" }] }],
  references: [{ type: "ai_overview_reference", source: "Brand", domain: "brand.com", url: "https://brand.com/crm", title: "Brand CRM", text: "…" }, { type: "ai_overview_reference", source: "G2", domain: "g2.com", url: "https://www.g2.com/best-crm", title: "Best CRM 2026" }] };
const org = (n, url) => ({ type: "organic", rank_group: n, rank_absolute: n + 1, domain: new URL(url).hostname, title: `Result ${n}`, url });

test("DataForSEO aiOverview()/organic(): Basic auth, task body, parsing", async () => {
  const fetch = mockFetch([["https://api.dataforseo.com/v3/serp/google/organic/live/advanced", json(env([aio, org(1, "https://www.g2.com/best-crm"), org(2, "https://brand.com/crm")]))]]);
  const a = await serp.aiOverview(DFS, "best crm", { fetch });
  assert.equal(a.present, true);
  assert.equal(a.text, "**Top CRMs** include Brand and Rival.");
  assert.deepEqual(a.references, [{ url: "https://brand.com/crm", title: "Brand CRM", domain: "brand.com" }, { url: "https://www.g2.com/best-crm", title: "Best CRM 2026", domain: "g2.com" }]);
  assert.deepEqual(a.brands, []);
  const c = fetch.calls[0];
  assert.equal(c.method, "POST");
  assert.equal(c.headers.authorization, `Basic ${Buffer.from("me@brand.com:PW").toString("base64")}`);
  assert.deepEqual(c.body, [{ keyword: "best crm", location_name: "United States", language_code: "en", device: "desktop", depth: 10, load_async_ai_overview: true }]);
  const o = await serp.organic(DFS, "best crm", { fetch });
  assert.deepEqual(o.results[1], { position: 2, url: "https://brand.com/crm", domain: "brand.com", title: "Result 2" });
});

test("DataForSEO aiMode(): ai_mode endpoint", async () => {
  const fetch = mockFetch([["https://api.dataforseo.com/v3/serp/google/ai_mode/live/advanced", json(env([{ ...aio, markdown: "AI Mode says Brand." }]))]]);
  const r = await serp.aiMode(DFS, "best crm", { fetch });
  assert.deepEqual([r.present, r.text, r.references.length], [true, "AI Mode says Brand.", 2]);
});

test("DataForSEO: no ai_overview item → present:false", async () => {
  const fetch = mockFetch([["https://api.dataforseo.com/", json(env([org(1, "https://a.com/")]))]]);
  assert.deepEqual(await serp.aiOverview(DFS, "q", { fetch }), { present: false, text: "", references: [], brands: [] });
});

test("DataForSEO test(): user_data; 401 → readable ok:false", async () => {
  const ok = mockFetch([["https://api.dataforseo.com/v3/appendix/user_data", json({ ...env([]), tasks: [{ status_code: 20000, status_message: "Ok.", result: [{ login: "me@brand.com", timezone: "UTC", money: { total: 50, balance: 42.5 } }] }] })]]);
  assert.deepEqual(await serp.test(DFS, { fetch: ok }), { ok: true, detail: "Connected to DataForSEO as me@brand.com (balance $42.50)" });
  assert.equal(ok.calls[0].method, "GET");
  const bad = mockFetch([["https://api.dataforseo.com/", json({ status_code: 40100, status_message: "You are not authorized to access this resource.", tasks: null }, 401)]]);
  const r = await serp.test(DFS, { fetch: bad });
  assert.equal(r.ok, false);
  assert.match(r.detail, /DataForSEO rejected the login\/password/);
  assert.doesNotMatch(r.detail, /PW/);
});

const sapiSearch = {
  search_metadata: { id: "x", status: "Success" },
  ai_overview: { text_blocks: [
    { type: "paragraph", snippet: "Brand is a popular CRM.", reference_indexes: [0] },
    { type: "list", list: [{ title: "Brand:", snippet: "Best for startups.", reference_indexes: [0] }, { title: "Rival:", snippet: "Best for enterprise.", list: [{ snippet: "Pricey." }] }] },
  ], references: [{ title: "Brand CRM", link: "https://brand.com/crm", snippet: "…", source: "Brand", index: 0 }] },
  organic_results: [{ position: 1, title: "Best CRM", link: "https://www.g2.com/best-crm", displayed_link: "g2.com", source: "G2" }],
};

test("SerpApi aiOverview(): inline text_blocks; params", async () => {
  const fetch = mockFetch([["https://serpapi.com/search.json", json(sapiSearch)]]);
  const r = await serp.aiOverview({ ...SAPI, locationName: "United Kingdom" }, "best crm", { fetch });
  assert.equal(r.present, true);
  assert.equal(r.text, "Brand is a popular CRM.\n- Brand: Best for startups.\n- Rival: Best for enterprise.\n  - Pricey.");
  assert.deepEqual(r.references, [{ url: "https://brand.com/crm", title: "Brand CRM", domain: "brand.com" }]);
  const p = new URL(fetch.calls[0].url).searchParams;
  assert.deepEqual([p.get("engine"), p.get("q"), p.get("api_key"), p.get("hl"), p.get("gl"), p.get("location")], ["google", "best crm", "SKEY", "en", "uk", "United Kingdom"]);
});

test("SerpApi aiOverview(): follows page_token with engine=google_ai_overview", async () => {
  const fetch = mockFetch([
    [(u) => u.includes("engine=google_ai_overview"), json({ search_metadata: {}, ai_overview: sapiSearch.ai_overview })],
    ["https://serpapi.com/search.json", json({ ...sapiSearch, ai_overview: { page_token: "TOK", serpapi_link: "https://serpapi.com/search.json?engine=google_ai_overview&page_token=TOK" } })],
  ]);
  const r = await serp.aiOverview(SAPI, "best crm", { fetch });
  assert.equal(r.present, true);
  const p = new URL(fetch.calls[1].url).searchParams;
  assert.deepEqual([p.get("engine"), p.get("page_token"), p.get("api_key")], ["google_ai_overview", "TOK", "SKEY"]);
});

test("SerpApi aiMode() + organic()", async () => {
  const fetch = mockFetch([
    [(u) => u.includes("engine=google_ai_mode"), json({ text_blocks: [{ type: "paragraph", snippet: "Try Brand." }], references: [{ title: "Brand", link: "https://brand.com/", index: 0 }], reconstructed_markdown: "Try **Brand**." })],
    ["https://serpapi.com/search.json", json(sapiSearch)],
  ]);
  const m = await serp.aiMode(SAPI, "best crm", { fetch });
  assert.deepEqual([m.present, m.text, m.references[0].domain], [true, "Try **Brand**.", "brand.com"]);
  const o = await serp.organic(SAPI, "best crm", { fetch });
  assert.deepEqual(o.results, [{ position: 1, url: "https://www.g2.com/best-crm", domain: "g2.com", title: "Best CRM" }]);
});

test("SerpApi test(): account.json; invalid key → ok:false", async () => {
  const ok = mockFetch([["https://serpapi.com/account.json", json({ account_id: "1", plan_name: "Developer", searches_per_month: 5000, plan_searches_left: 4000, total_searches_left: 4100 })]]);
  assert.deepEqual(await serp.test(SAPI, { fetch: ok }), { ok: true, detail: "Connected to SerpApi (Developer; 4100 searches left)" });
  const bad = mockFetch([["https://serpapi.com/", json({ error: "Invalid API key. Your API key should be here: https://serpapi.com/manage-api-key" }, 401)]]);
  assert.deepEqual(await serp.test(SAPI, { fetch: bad }), { ok: false, detail: "SerpApi rejected the API key." });
});

test("collect(): max 10 queries, one SERP call each, no AI Mode; stops on auth failure", async () => {
  const fetch = mockFetch([["https://serpapi.com/search.json", json(sapiSearch)]]);
  const queries = Array.from({ length: 12 }, (_, i) => `q${i}`);
  const r = await serp.collect(SAPI, { fetch, queries });
  assert.equal(fetch.calls.length, 10);
  assert.ok(fetch.calls.every((c) => !c.url.includes("google_ai_mode")));
  assert.deepEqual([r.checked, r.withAiOverview, r.results[0].organic.length], [10, 10, 1]);
  const bad = mockFetch([["https://serpapi.com/", json({ error: "Invalid API key." }, 401)]]);
  const r2 = await serp.collect(SAPI, { fetch: bad, queries });
  assert.equal(bad.calls.length, 1);
  assert.match(r2.results[0].error, /rejected/);
});
