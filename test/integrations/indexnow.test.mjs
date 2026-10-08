import { test } from "node:test";
import assert from "node:assert/strict";
import * as ix from "../../server/integrations/indexnow.mjs";
import { mockFetch, json, text } from "./_mock.mjs";

const KEY = "0123456789abcdef0123456789abcdef";
const ctx = (fetch) => ({ fetch, site: "https://www.brand.com", host: "brand.com" });

test("generateKey(): 32 hex chars; test() generates and returns a key when empty", async () => {
  assert.match(ix.generateKey(), /^[0-9a-f]{32}$/);
  const cfg = {};
  const r = await ix.test(cfg, ctx(mockFetch([[/\.txt$/, text("nope", 404)]])));
  assert.equal(r.ok, false);
  assert.match(cfg.key, /^[0-9a-f]{32}$/);
  assert.equal(r.key, cfg.key);
  assert.match(r.detail, new RegExp(`https://www\\.brand\\.com/${cfg.key}\\.txt`));
  assert.match(r.detail, /site root/);
});

test("test(): key file at site root matching the key → ok", async () => {
  const fetch = mockFetch([[`https://www.brand.com/${KEY}.txt`, text(`${KEY}\n`)]]);
  const r = await ix.test({ key: KEY }, ctx(fetch));
  assert.deepEqual([r.ok, r.key], [true, undefined]);
  assert.match(r.detail, /verified/);
});

test("test(): wrong file contents → ok:false; custom keyLocation is used", async () => {
  const loc = `https://www.brand.com/keys/${KEY}.txt`;
  const fetch = mockFetch([[loc, text("something else")]]);
  const r = await ix.test({ key: KEY, keyLocation: loc }, ctx(fetch));
  assert.equal(r.ok, false);
  assert.equal(fetch.calls[0].url, loc);
  assert.match(r.detail, /doesn't contain exactly the key/);
});

test("submitUrls(): POST JSON to api.indexnow.org, keeps only the site's host", async () => {
  const fetch = mockFetch([["https://api.indexnow.org/indexnow", new Response(null, { status: 202 })]]);
  const r = await ix.submitUrls({ key: KEY }, ["https://www.brand.com/a", "https://www.brand.com/b", "https://evil.com/x"], ctx(fetch));
  assert.equal(r.ok, true);
  assert.equal(r.status, 202);
  assert.equal(r.submitted, 2);
  assert.equal(r.skipped, 1);
  const c = fetch.calls[0];
  assert.equal(c.method, "POST");
  assert.match(c.headers["content-type"], /application\/json/);
  assert.deepEqual(c.body, { host: "www.brand.com", key: KEY, urlList: ["https://www.brand.com/a", "https://www.brand.com/b"] });
});

for (const [status, re] of [[403, /key isn't valid/], [422, /don't belong/], [429, /rate-limiting/]]) {
  test(`submitUrls(): HTTP ${status} → readable ok:false`, async () => {
    const r = await ix.submitUrls({ key: KEY, keyLocation: `https://www.brand.com/${KEY}.txt` }, ["https://www.brand.com/a"], ctx(mockFetch([["https://api.indexnow.org/", json({}, status)]])));
    assert.equal(r.ok, false);
    assert.equal(r.status, status);
    assert.match(r.detail, re);
  });
}

test("collect(): reports key file state and lastSubmit", async () => {
  const last = { ok: true, at: "2026-10-01T00:00:00Z", submitted: 3 };
  const r = await ix.collect({ key: KEY, lastSubmit: last }, ctx(mockFetch([[/\.txt$/, text(KEY)]])));
  assert.deepEqual([r.keyFileOk, r.key, r.lastSubmit], [true, KEY, last]);
});
