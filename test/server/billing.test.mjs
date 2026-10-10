import test from "node:test";
import assert from "node:assert/strict";
import { applyEvent, eventSummary } from "../../server/billing.mjs";

const NOW = new Date("2026-10-10T12:00:00Z");
const s = (iso) => Math.floor(new Date(iso).getTime() / 1000);
const planOf = (id) => ({ plan_g: { plan: "growth", currency: "INR" }, plan_s: { plan: "starter", currency: "INR" } }[id] || null);
const ev = (event, sub = {}, at = "2026-10-10T11:00:00Z", payment) => ({ event, created_at: s(at), payload: { subscription: { entity: { id: "sub_1", plan_id: "plan_g", status: "active", current_start: s("2026-10-10T11:00:00Z"), current_end: s("2026-11-10T11:00:00Z"), notes: { white_petal_org_id: "o1" }, ...sub } }, ...(payment ? { payment: { entity: payment } } : {}) } });
const base = { plan_code: "legacy", billing_status: "internal", razorpay_subscription_id: "sub_1", billing_event_at: null, current_period_end: null, grace_ends_at: null, pending_plan_code: null };
const opts = { planOf, now: NOW, graceDays: 3 };

test("authenticated alone never grants access", () => {
  const r = applyEvent(base, ev("subscription.authenticated", { status: "authenticated", current_start: null, current_end: null }), opts);
  assert.equal(r.patch.plan_code, undefined); assert.equal(r.patch.billing_status, undefined);
});

test("activation and charge grant the plan resolved from the server's plan id map", () => {
  const r = applyEvent(base, ev("subscription.activated"), opts);
  assert.equal(r.status, "processed");
  assert.equal(r.patch.plan_code, "growth"); assert.equal(r.patch.billing_status, "active"); assert.equal(r.patch.billing_currency, "INR");
  assert.equal(r.patch.current_period_end.toISOString(), "2026-11-10T11:00:00.000Z"); assert.equal(r.patch.grace_ends_at, null);
  const c = applyEvent(base, ev("subscription.charged"), opts);
  assert.equal(c.patch.billing_status, "active");
});

test("an unknown Razorpay plan id is ignored, not trusted", () => {
  const r = applyEvent(base, ev("subscription.activated", { plan_id: "plan_evil" }), opts);
  assert.equal(r.status, "ignored"); assert.deepEqual(r.patch, {});
});

test("failed renewal starts a three-day grace period once", () => {
  const active = { ...base, plan_code: "growth", billing_status: "active", current_period_end: new Date("2026-10-11T00:00:00Z") };
  const r = applyEvent(active, ev("subscription.pending", { status: "pending" }), opts);
  assert.equal(r.patch.billing_status, "past_due"); assert.equal(r.patch.grace_ends_at.toISOString(), "2026-10-13T12:00:00.000Z");
  const again = applyEvent({ ...active, ...r.patch }, ev("subscription.halted", { status: "halted" }, "2026-10-10T11:30:00Z"), { ...opts, now: new Date("2026-10-12T00:00:00Z") });
  assert.equal(again.patch.grace_ends_at, undefined); // keeps the first grace end
  assert.equal(again.patch.billing_status, "past_due");
});

test("cancellation keeps access to the end of the paid period", () => {
  const active = { ...base, plan_code: "growth", billing_status: "active", current_period_end: new Date("2026-11-10T11:00:00Z") };
  const r = applyEvent(active, ev("subscription.cancelled", { status: "cancelled", current_end: s("2026-11-10T11:00:00Z") }), opts);
  assert.equal(r.patch.billing_status, "canceled"); assert.equal(r.patch.plan_code, undefined);
  assert.equal(r.patch.current_period_end, undefined); // never shortened
});

test("an older event never shortens a newer paid period or changes state", () => {
  const active = { ...base, plan_code: "growth", billing_status: "active", current_period_end: new Date("2026-12-10T11:00:00Z"), billing_event_at: new Date("2026-11-10T11:00:00Z") };
  const r = applyEvent(active, ev("subscription.pending", { status: "pending" }, "2026-10-10T11:00:00Z"), opts);
  assert.equal(r.status, "ignored"); assert.match(r.reason, /older/);
  const charged = applyEvent({ ...active, billing_event_at: null }, ev("subscription.charged", { current_end: s("2026-11-10T11:00:00Z") }), opts);
  assert.equal(charged.patch.current_period_end, undefined);
});

test("a scheduled downgrade lands when Razorpay reports the new plan", () => {
  const active = { ...base, plan_code: "growth", billing_status: "active", pending_plan_code: "starter" };
  const r = applyEvent(active, ev("subscription.charged", { plan_id: "plan_s" }), opts);
  assert.equal(r.patch.plan_code, "starter"); assert.equal(r.patch.pending_plan_code, null);
});

test("stored payload keeps identifiers and statuses, never payment method details", () => {
  const e = ev("subscription.charged", {}, undefined, { id: "pay_1", status: "captured", amount: 999900, currency: "INR", method: "card", card: { last4: "1111", name: "X" }, email: "a@b.c", contact: "+91" });
  const out = eventSummary(e);
  assert.equal(out.payment.id, "pay_1"); assert.equal(out.subscription.id, "sub_1");
  const json = JSON.stringify(out);
  for (const bad of ["1111", "card", "a@b.c", "+91"]) assert.ok(!json.includes(bad), bad);
});
