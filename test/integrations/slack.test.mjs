import { test } from "node:test";
import assert from "node:assert/strict";
import * as slack from "../../server/integrations/slack.mjs";
import { mockFetch, text } from "./_mock.mjs";

const HOOK = "https://hooks.slack.com/services/T000/B000/XXXX";

test("test(): posts a short connected message to the webhook", async () => {
  const fetch = mockFetch([[HOOK, text("ok")]]);
  const r = await slack.test({ webhookUrl: HOOK }, { fetch, brand: "Brand" });
  assert.deepEqual(r, { ok: true, detail: "Sent a test message to Slack." });
  const c = fetch.calls[0];
  assert.equal(c.method, "POST");
  assert.match(c.headers["content-type"], /application\/json/);
  assert.equal(c.body.blocks[0].type, "header");
  assert.equal(c.body.blocks[0].text.text, "White Petal connected");
  assert.match(c.body.text, /White Petal connected/);
});

test("notify(): header + mrkdwn section + button", async () => {
  const fetch = mockFetch([[HOOK, text("ok")]]);
  const r = await slack.notify({ webhookUrl: HOOK }, { title: "Visibility up 12%", lines: ["*ChatGPT*: 4/10", "*Perplexity*: 6/10"], url: "https://app.whitepetal.ai/r/1" }, { fetch });
  assert.equal(r.ok, true);
  assert.deepEqual(fetch.calls[0].body.blocks, [
    { type: "header", text: { type: "plain_text", text: "Visibility up 12%", emoji: true } },
    { type: "section", text: { type: "mrkdwn", text: "*ChatGPT*: 4/10\n*Perplexity*: 6/10" } },
    { type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "Open in White Petal" }, url: "https://app.whitepetal.ai/r/1" }] },
  ]);
});

test("errors: revoked webhook (403 invalid_token / 404 no_service) → ok:false readable", async () => {
  const r1 = await slack.test({ webhookUrl: HOOK }, { fetch: mockFetch([[HOOK, text("invalid_token", 403)]]) });
  assert.deepEqual(r1, { ok: false, detail: "Slack rejected the webhook URL (invalid token). Create a new webhook." });
  const r2 = await slack.notify({ webhookUrl: HOOK }, { title: "x" }, { fetch: mockFetch([[HOOK, text("no_service", 404)]]) });
  assert.match(r2.detail, /removed or disabled/);
});

test("rejects non-Slack URLs without calling fetch", async () => {
  const fetch = mockFetch([]);
  const r = await slack.test({ webhookUrl: "https://evil.example/hook" }, { fetch });
  assert.equal(r.ok, false);
  assert.equal(fetch.calls.length, 0);
});

test("buildMessage(): truncates header to 150 chars", () => {
  const m = slack.buildMessage({ title: "x".repeat(200) });
  assert.equal(m.blocks[0].text.text.length, 150);
  assert.equal(m.blocks.length, 1);
});
