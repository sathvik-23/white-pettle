import { test } from "node:test";
import assert from "node:assert/strict";
import { summarize, visibilityScore, isYou } from "../../server/metrics.mjs";

const M = { profile: { name: "Acme", site: "https://acme.ai", competitors: ["Bolt"] }, answers: {
  a: { status: "yes", named: true, rank: 2, engine: "chatgpt", brands: ["Bolt", "Acme"], sources: [{ url: "https://www.acme.ai/x" }], sent: { Acme: 80, Bolt: 60 } },
  b: { status: "no", named: false, engine: "gemini", brands: ["Bolt"], sources: [] },
  c: { status: "no", engine: "aio", absent: true, brands: [] }, // Google showed no AI Overview: not a miss
  d: { status: "err", engine: "gemini" } } };

test("summary follows the Peec/Profound definitions", () => {
  const s = summarize(M);
  assert.equal(s.n, 2);                  // err and absent answers excluded
  assert.equal(s.visibility, 0.5);       // named in 1 of 2
  assert.equal(s.sov, 1 / 3);            // 1 of 3 brand mentions
  assert.equal(s.position, 2);
  assert.equal(s.sentiment, 80);
  assert.equal(s.win, 0);
  assert.equal(s.usedAsSource, 0.5);     // www. counts as your domain
  assert.equal(s.leader.name, "Bolt");
  assert.deepEqual(s.engines, { chatgpt: 1, gemini: 0 });
});
test("visibility score weights being named first", () => {
  assert.equal(visibilityScore({ vis: 0 }), 0);
  assert.equal(visibilityScore({ vis: 1, sov: 1, leaderSov: 1, position: 1, sentiment: 100 }), 100);
  assert.equal(visibilityScore({ vis: 0.5, sov: 0.2, leaderSov: 0.4, position: 3, sentiment: 70 }), 54); // 25 + 10 + 12 + 7
});
test("brand matching uses the name and the domain stem", () => {
  assert.ok(isYou("Acme", M.profile)); assert.ok(isYou("acme.ai", M.profile)); assert.ok(!isYou("Acmeville Labs", { name: "Acm", site: "" }));
});
