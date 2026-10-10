import test from "node:test";
import assert from "node:assert/strict";
import { PLANS, publicPlans, effectiveEntitlements } from "../../server/plans.mjs";

test("catalogue exposes approved monthly prices", () => {
  assert.deepEqual(
    Object.fromEntries(["starter", "growth", "agency", "enterprise"].map((k) => [k, PLANS[k].prices])),
    {
      starter: { USD: 4900, INR: 499900 },
      growth: { USD: 9900, INR: 999900 },
      agency: { USD: 24900, INR: 2499900 },
      enterprise: { USD: 99900, INR: 9999900 },
    },
  );
});

test("public catalogue contains no Razorpay ids or secrets", () => {
  const json = JSON.stringify(publicPlans());
  assert.doesNotMatch(json, /razorpay|secret|plan_id/i);
  assert.equal(publicPlans().find((p) => p.code === "growth").featured, true);
  assert.equal(publicPlans().filter((p) => p.featured).length, 1);
});

test("public catalogue survives JSON (no Infinity limits leak as null)", () => {
  for (const p of publicPlans()) for (const [k, v] of Object.entries(p.entitlements)) assert.notEqual(v, Infinity, `${p.code}.${k}`);
});

test("enterprise overrides merge without mutating the catalogue", () => {
  const before = PLANS.enterprise.entitlements.questions;
  const out = effectiveEntitlements("enterprise", { questions: 600, seats: 80 });
  assert.equal(out.questions, 600);
  assert.equal(out.seats, 80);
  assert.equal(PLANS.enterprise.entitlements.questions, before);
});

test("entitlements match the approved matrix", () => {
  const e = (c) => PLANS[c].entitlements;
  assert.deepEqual(["starter", "growth", "agency"].map((c) => [e(c).brands, e(c).questions, e(c).competitorsPerBrand, e(c).seats, e(c).actionDrafts]),
    [[1, 15, 3, 1, 10], [1, 30, 5, 5, 30], [5, 100, 5, 20, 100]]);
  assert.deepEqual(e("starter").engines, ["chatgpt", "perplexity", "gemini"]);
  assert.deepEqual([e("starter").trendMonths, e("growth").trendMonths, e("agency").trendMonths], [6, 12, 24]);
  assert.deepEqual([e("trial").brands, e("trial").questions, e("trial").schedule], [1, 10, ["off"]]);
  assert.equal(e("legacy").brands, Infinity);
  assert.ok(Object.isFrozen(e("growth")) && Object.isFrozen(PLANS.growth.prices));
});

test("planned margins stay at or above 70%", () => {
  for (const c of ["starter", "growth", "agency"]) {
    const p = PLANS[c], usd = p.prices.USD / 100, b = p.budget;
    const margin = 1 - (usd * 0.05 + b.aiUsd + b.infraUsd + b.supportUsd) / usd;
    assert.ok(margin >= 0.70, `${c} margin ${margin}`);
  }
});

test("unknown plan codes resolve to the most restrictive (trial) entitlements", () => {
  assert.equal(effectiveEntitlements("made-up").questions, PLANS.trial.entitlements.questions);
});
