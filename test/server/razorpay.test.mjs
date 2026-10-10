import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { verifyWebhook, makeClient, planIdFor, billingConfig } from "../../server/razorpay.mjs";

test("verifyWebhook accepts only the raw body HMAC", () => {
  const body = Buffer.from('{"event":"subscription.activated"}');
  const signature = crypto.createHmac("sha256", "whsec").update(body).digest("hex");
  assert.equal(verifyWebhook(body, signature, "whsec"), true);
  assert.equal(verifyWebhook(Buffer.from(body + " "), signature, "whsec"), false);
  assert.equal(verifyWebhook(body, signature, "other"), false);
  assert.equal(verifyWebhook(body, "", "whsec"), false);
  assert.equal(verifyWebhook(body, signature, ""), false);
  assert.equal(verifyWebhook(body, signature.toUpperCase(), "whsec"), false);
});

function fakeFetch(reply = { id: "sub_1", status: "created" }, status = 200) {
  const seen = [];
  const fetch = async (url, init) => { seen.push({ url, init }); return new Response(JSON.stringify(reply), { status }); };
  return { seen, fetch };
}

test("client creates a subscription using the configured plan id", async () => {
  const f = fakeFetch();
  const client = makeClient({ keyId: "rzp_test_id", keySecret: "secret", fetch: f.fetch });
  const sub = await client.createSubscription({ planId: "plan_growth_usd", orgId: "org-1", plan: "growth" });
  assert.equal(sub.id, "sub_1");
  const body = JSON.parse(f.seen[0].init.body);
  assert.equal(f.seen[0].url, "https://api.razorpay.com/v1/subscriptions");
  assert.equal(body.plan_id, "plan_growth_usd");
  assert.equal(body.notes.white_petal_org_id, "org-1");
  assert.equal(body.notes.white_petal_plan, "growth");
  assert.ok(body.total_count > 0);
  assert.equal(f.seen[0].init.headers.authorization, "Basic " + Buffer.from("rzp_test_id:secret").toString("base64"));
});

test("client cancels at cycle end and changes plan at cycle end or now", async () => {
  const f = fakeFetch({ id: "sub_1", status: "active" });
  const client = makeClient({ keyId: "k", keySecret: "s", fetch: f.fetch });
  await client.cancelSubscription("sub_1");
  assert.equal(f.seen[0].url, "https://api.razorpay.com/v1/subscriptions/sub_1/cancel");
  assert.deepEqual(JSON.parse(f.seen[0].init.body), { cancel_at_cycle_end: true });
  await client.updateSubscription("sub_1", { planId: "plan_x", at: "cycle_end" });
  assert.equal(f.seen[1].init.method, "PATCH");
  assert.deepEqual(JSON.parse(f.seen[1].init.body), { plan_id: "plan_x", schedule_change_at: "cycle_end" });
  await client.fetchSubscription("sub/../x");
  assert.equal(f.seen[2].url, "https://api.razorpay.com/v1/subscriptions/sub%2F..%2Fx");
});

test("client errors carry no secrets", async () => {
  const f = fakeFetch({ error: { description: "Bad plan" } }, 400);
  const client = makeClient({ keyId: "k", keySecret: "super-secret", fetch: f.fetch });
  await assert.rejects(client.createSubscription({ planId: "p", orgId: "o" }), (e) => /Razorpay 400: Bad plan/.test(e.message) && !e.message.includes("super-secret"));
});

test("plan ids come only from server configuration", () => {
  const env = { RAZORPAY_PLAN_GROWTH_INR: "plan_g_inr" };
  assert.equal(planIdFor("growth", "INR", env), "plan_g_inr");
  assert.equal(planIdFor("growth", "USD", env), null);
  assert.equal(planIdFor("enterprise", "USD", { RAZORPAY_PLAN_ENTERPRISE_USD: "x" }), null); // not self-serve
  assert.equal(planIdFor("../x", "INR", env), null);
});

test("billing mode defaults off and never reports secret values", () => {
  assert.equal(billingConfig({}).enabled, "0");
  assert.equal(billingConfig({ BILLING_ENABLED: "operators" }).enabled, "operators");
  assert.equal(billingConfig({ BILLING_ENABLED: "yes" }).enabled, "0");
  const c = billingConfig({ BILLING_ENABLED: "1", RAZORPAY_KEY_ID: "rzp_test_abc", RAZORPAY_KEY_SECRET: "sek", RAZORPAY_WEBHOOK_SECRET: "wh" });
  assert.equal(c.keyId, "rzp_test_abc"); assert.equal(c.ready, true); assert.equal(c.testMode, true);
  assert.ok(!JSON.stringify(c.public()).includes("sek") && !JSON.stringify(c.public()).includes("wh"));
});
