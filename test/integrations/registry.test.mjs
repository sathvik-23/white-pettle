import { test } from "node:test";
import assert from "node:assert/strict";
import { PROVIDERS, listMeta, secretFields } from "../../server/integrations/index.mjs";
import { http } from "../../server/integrations/_http.mjs";

const CATEGORIES = ["search", "analytics", "crawlers", "entity", "ai-search", "alerts"];

test("every provider follows the shared contract", () => {
  assert.deepEqual(Object.keys(PROVIDERS).sort(), ["bing", "cloudflare", "entity", "google", "indexnow", "serp", "slack"]);
  for (const [id, p] of Object.entries(PROVIDERS)) {
    const m = p.meta;
    assert.equal(m.id, id);
    assert.ok(m.name && m.blurb && /^https:\/\//.test(m.docs), id);
    assert.ok(CATEGORIES.includes(m.category), id);
    assert.ok(["key", "oauth", "none"].includes(m.auth), id);
    assert.equal(typeof m.free, "boolean");
    assert.ok(Array.isArray(m.fields) && m.fields.every((f) => f.key && f.label && typeof f.secret === "boolean"), id);
    assert.equal(typeof p.test, "function");
    assert.equal(typeof p.collect, "function");
    assert.equal(p.default, undefined);
  }
  assert.equal(listMeta().length, 7);
  assert.equal(PROVIDERS.serp.meta.free, false);
  assert.equal(PROVIDERS.google.meta.auth, "oauth");
  assert.deepEqual(secretFields("serp"), ["password", "apiKey"]);
  for (const fn of ["submitUrls"]) { assert.equal(typeof PROVIDERS.bing[fn], "function"); assert.equal(typeof PROVIDERS.indexnow[fn], "function"); }
  for (const fn of ["oauthUrl", "exchangeCode", "ensureToken", "listProperties"]) assert.equal(typeof PROVIDERS.google[fn], "function");
  for (const fn of ["aiOverview", "aiMode", "organic"]) assert.equal(typeof PROVIDERS.serp[fn], "function");
  assert.equal(typeof PROVIDERS.slack.notify, "function");
});

test("test() never throws, even on network failure", async () => {
  const boom = async () => { throw new TypeError("fetch failed"); };
  const cfgs = { bing: { apiKey: "k" }, indexnow: { key: "0123456789abcdef" }, google: { accessToken: "a", expiresAt: Date.now() + 1e7 }, cloudflare: { apiToken: "t", zoneId: "z" }, entity: {}, serp: { backend: "serpapi", apiKey: "k" }, slack: { webhookUrl: "https://hooks.slack.com/services/x" } };
  for (const [id, p] of Object.entries(PROVIDERS)) {
    const r = await p.test(cfgs[id], { fetch: boom, site: "https://brand.com", host: "brand.com", brand: "Brand" });
    assert.equal(typeof r.ok, "boolean", id);
    assert.equal(typeof r.detail, "string", id);
    if (id !== "entity") assert.equal(r.ok, false, id);
  }
});

test("http(): aborts after the timeout and reports it", async () => {
  const hang = (url, { signal }) => new Promise((_, rej) => signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))));
  const r = await http({ fetch: hang }, "https://x.test/", { timeout: 20 });
  assert.deepEqual([r.ok, r.status, r.error], [false, 0, "timed out after 0.02s"]);
});

test("http(): tolerates non-JSON bodies", async () => {
  const r = await http({ fetch: async () => new Response("<html>oops</html>", { status: 502 }) }, "https://x.test/");
  assert.deepEqual([r.ok, r.status, r.data, r.text], [false, 502, null, "<html>oops</html>"]);
});
