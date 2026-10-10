// A narrow Razorpay client: Subscriptions over REST, and webhook signature checks. The REST calls and webhook
// shapes follow Razorpay's docs as of October 2026 (razorpay.com/docs/api/payments/subscriptions,
// razorpay.com/docs/webhooks/subscriptions); recheck them there before changing anything here.
// `fetch` is injectable so tests run the whole lifecycle without the network (setClient).
import crypto from "node:crypto";
import { SELF_SERVE, CURRENCIES } from "./plans.mjs";

// HMAC-SHA256 of the exact bytes received, hex, compared in constant time. Never verify a re-serialised body.
export function verifyWebhook(raw, signature, secret) {
  if (!raw || !signature || !secret) return false;
  const expected = crypto.createHmac("sha256", secret).update(raw).digest("hex");
  const a = Buffer.from(expected), b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function makeClient({ keyId, keySecret, fetch: doFetch = globalThis.fetch }) {
  const auth = `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}`;
  async function request(method, path, body) {
    const r = await doFetch(`https://api.razorpay.com/v1${path}`, {
      method, headers: { authorization: auth, "content-type": "application/json" },
      body: body == null ? undefined : JSON.stringify(body),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Razorpay ${r.status}: ${String(data.error?.description || "request failed").slice(0, 200)}`);
    return data;
  }
  const sub = (id) => `/subscriptions/${encodeURIComponent(id)}`;
  return {
    // 120 monthly cycles: effectively "until cancelled"; Razorpay requires a count or an end date.
    createSubscription: ({ planId, orgId, plan }) => request("POST", "/subscriptions", {
      plan_id: planId, total_count: 120, quantity: 1, customer_notify: true,
      notes: { white_petal_org_id: orgId, ...(plan ? { white_petal_plan: plan } : {}) },
    }),
    cancelSubscription: (id) => request("POST", `${sub(id)}/cancel`, { cancel_at_cycle_end: true }),
    // Upgrades apply now (Razorpay charges the difference); downgrades at cycle end.
    updateSubscription: (id, { planId, at = "cycle_end" }) => request("PATCH", sub(id), { plan_id: planId, schedule_change_at: at }),
    fetchSubscription: (id) => request("GET", sub(id)),
  };
}

// The server maps an internal plan and currency to a Razorpay plan id from its own configuration.
// Browser input never supplies a plan id or an amount.
export function planIdFor(plan, currency, env = process.env) {
  if (!SELF_SERVE.includes(plan) || !CURRENCIES.includes(currency)) return null;
  return env[`RAZORPAY_PLAN_${plan.toUpperCase()}_${currency}`] || null;
}

// BILLING_ENABLED: 0 (default, checkout off), operators (platform operators only), 1 (eligible owners/admins).
export function billingConfig(env = process.env) {
  const enabled = ["0", "operators", "1"].includes(String(env.BILLING_ENABLED || "0")) ? String(env.BILLING_ENABLED || "0") : "0";
  const keyId = env.RAZORPAY_KEY_ID || "";
  return {
    enabled, keyId,
    keySecret: env.RAZORPAY_KEY_SECRET || "", webhookSecret: env.RAZORPAY_WEBHOOK_SECRET || "",
    ready: !!(keyId && env.RAZORPAY_KEY_SECRET && env.RAZORPAY_WEBHOOK_SECRET),
    testMode: keyId.startsWith("rzp_test_"),
    graceDays: Number(env.BILLING_GRACE_DAYS || 3), trialDays: Number(env.BILLING_TRIAL_DAYS || 7),
    // Safe for the browser: the public key id only.
    public() { return { enabled: this.enabled, keyId: this.enabled !== "0" ? this.keyId : "", testMode: this.testMode }; },
  };
}

let override = null;
// Tests swap in a fake; production builds one from the environment on each use (keys can rotate).
export const setClient = (c) => { override = c; };
export function client() {
  if (override) return override;
  const c = billingConfig();
  if (!c.keyId || !c.keySecret) throw new Error("Razorpay keys are not configured.");
  return makeClient({ keyId: c.keyId, keySecret: c.keySecret });
}
