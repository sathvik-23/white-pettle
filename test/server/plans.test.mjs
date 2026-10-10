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

import { accessMode, planError, nextPlan } from "../../server/billing.mjs";

test("billing states preserve reports but stop spend after grace", () => {
  const now = new Date("2026-10-10T12:00:00Z");
  assert.equal(accessMode({ billing_status: "internal" }, now), "write");
  assert.equal(accessMode({ billing_status: "active" }, now), "write");
  assert.equal(accessMode({ billing_status: "trialing", trial_ends_at: "2026-10-11T00:00:00Z" }, now), "write");
  assert.equal(accessMode({ billing_status: "trialing", trial_ends_at: "2026-10-09T00:00:00Z" }, now), "read");
  assert.equal(accessMode({ billing_status: "trialing", trial_ends_at: null }, now), "read"); // not started: email not verified
  assert.equal(accessMode({ billing_status: "past_due", grace_ends_at: "2026-10-11T00:00:00Z" }, now), "manual");
  assert.equal(accessMode({ billing_status: "past_due", grace_ends_at: "2026-10-09T00:00:00Z" }, now), "read");
  assert.equal(accessMode({ billing_status: "past_due", grace_ends_at: null }, now), "read");
  assert.equal(accessMode({ billing_status: "canceled", current_period_end: "2026-10-11T00:00:00Z" }, now), "write");
  assert.equal(accessMode({ billing_status: "canceled", current_period_end: "2026-10-09T00:00:00Z" }, now), "read");
  assert.equal(accessMode({ billing_status: "paused" }, now), "read");
  const grant = (expiresAt) => ({ billing_status: "active", entitlement_overrides: { grant: true, values: {}, expiresAt } });
  assert.equal(accessMode(grant("2026-10-11T00:00:00Z"), now), "write");
  assert.equal(accessMode(grant("2026-10-09T00:00:00Z"), now), "read");
  assert.equal(accessMode(null, now), "read");
});

test("plan errors are structured for upgrade UI", () => {
  const e = planError("questions", 15, 15, "growth", "2026-11-01T00:00:00Z");
  assert.equal(e.status, 402);
  assert.deepEqual(e.extra, { code: "plan_limit", capability: "questions", used: 15, limit: 15, recommendedPlan: "growth", resetsAt: "2026-11-01T00:00:00Z" });
});

test("upgrade path recommends the next plan up", () => {
  assert.deepEqual(["trial", "starter", "growth", "agency", "enterprise"].map(nextPlan), ["growth", "growth", "agency", "enterprise", "enterprise"]);
});
