// Billing HTTP routes: the public plan catalogue, the organisation's plan and usage, checkout, plan changes,
// cancellation and the Razorpay webhook. A factory (not an import of routes.mjs) so there is no import cycle.
//
// Razorpay is the source of truth for payment. The browser's checkout callback is only a hint to start polling;
// the plan changes when a signed webhook arrives (applyEvent in billing.mjs).
import { one, q, tx } from "./db.mjs";
import { fail, sendJson, readJson, readBody, clientIp } from "./http.mjs";
import { limited } from "./security.mjs";
import { PLANS, SELF_SERVE, CURRENCIES, ENTITLEMENT_KEYS, publicPlans } from "./plans.mjs";
import { billingState, applyEvent, eventSummary, nextPlan } from "./billing.mjs";
import { verifyWebhook, planIdFor, billingConfig, client } from "./razorpay.mjs";
import * as O from "./orgs.mjs";

const finite = (e) => Object.fromEntries(Object.entries(e).map(([k, v]) => [k, v === Infinity ? null : v])); // JSON-safe: null = unlimited

// The browser's view. Payment identifiers only for admins; nothing secret for anyone.
export async function billingView(ctx) {
  const s = await billingState(ctx.org.id), o = s.org, admin = O.can(ctx.role, "admin");
  const cfg = billingConfig();
  return {
    plan: { code: o.plan_code, name: PLANS[o.plan_code]?.name || o.plan_code, status: o.billing_status, currency: o.billing_currency, pendingPlan: o.pending_plan_code, cancelAtPeriodEnd: !!o.cancel_at_period_end,
      ...(admin ? { subscriptionId: o.razorpay_subscription_id || null } : {}) },
    mode: s.mode,
    period: { start: o.current_period_start, end: o.current_period_end, trialStartedAt: o.trial_started_at, trialEndsAt: o.trial_ends_at, graceEndsAt: o.grace_ends_at, usageFrom: s.period.start, usageResetsAt: s.period.end },
    entitlements: finite(s.entitlements), usage: s.usage, recommendedPlan: nextPlan(o.plan_code),
    canCheckout: admin && checkoutAllowed(ctx, cfg), canCancel: ctx.role === "owner" && !ctx.operatorVisit,
    checkout: cfg.public(),
  };
}
const checkoutAllowed = (ctx, cfg) => cfg.enabled === "1" || (cfg.enabled === "operators" && ctx.operator);

function pickPlan(b, { allowCurrencyFromOrg } = {}) {
  const plan = String(b.plan || ""), currency = String(b.currency || allowCurrencyFromOrg || "");
  if (!SELF_SERVE.includes(plan)) fail(400, "Choose Starter, Growth or Agency. Enterprise is arranged with our team.", { code: "bad_plan" });
  if (!CURRENCIES.includes(currency)) fail(400, "Choose USD or INR.", { code: "bad_currency" });
  return { plan, currency };
}
function needCheckout(ctx) {
  const cfg = billingConfig();
  if (cfg.enabled === "0") fail(503, "Paid plans aren't open yet. Your reports and current access are unchanged.", { code: "billing_disabled" });
  if (!checkoutAllowed(ctx, cfg)) fail(403, "Paid plans are open to the White Petal team only for now.", { code: "billing_operators_only" });
  if (!cfg.keyId || !cfg.keySecret) fail(503, "Payments aren't configured on this server yet.", { code: "billing_unconfigured" });
  return cfg;
}

export function makeBillingRoutes({ needCtx, currentUser }) {
  return [
    ["GET", "/api/billing/plans", async (req, res) => sendJson(res, 200, { plans: publicPlans().map((p) => ({ ...p, entitlements: finite(p.entitlements) })), monthlyOnly: true, currencies: CURRENCIES })],
    ["GET", "/api/billing", async (req, res) => sendJson(res, 200, await billingView(await needCtx(req, "viewer")))],

    ["POST", "/api/billing/checkout", async (req, res) => {
      const ctx = await needCtx(req, "admin"); const b = await readJson(req, 5000);
      const { plan, currency } = pickPlan(b);
      const cfg = needCheckout(ctx);
      if (limited("checkout:" + ctx.org.id, 10, 3600e3)) fail(429, "Too many checkout attempts. Try again in an hour.");
      const org = await one(`select billing_status, plan_code from organizations where id = $1`, [ctx.org.id]);
      if (["active", "past_due"].includes(org.billing_status)) fail(409, "This organisation already has a subscription. Change plan instead.", { code: "has_subscription" });
      const planId = planIdFor(plan, currency);
      if (!planId) fail(503, `${PLANS[plan].name} in ${currency} isn't available yet.`, { code: "plan_unavailable" });
      const sub = await client().createSubscription({ planId, orgId: ctx.org.id, plan });
      await q(`update organizations set razorpay_subscription_id = $2, billing_currency = coalesce(billing_currency, $3), updated_at = now() where id = $1`, [ctx.org.id, sub.id, currency]);
      await O.audit(ctx.org.id, ctx.user.id, "billing.checkout_started", plan, { currency, subscription: sub.id });
      sendJson(res, 200, { subscriptionId: sub.id, keyId: cfg.keyId, plan, currency, amount: PLANS[plan].prices[currency], name: PLANS[plan].name, testMode: cfg.testMode });
    }],

    ["POST", "/api/billing/change-plan", async (req, res) => {
      const ctx = await needCtx(req, "admin"); const b = await readJson(req, 5000);
      needCheckout(ctx);
      const org = await one(`select * from organizations where id = $1`, [ctx.org.id]);
      if (org.billing_status !== "active" || !org.razorpay_subscription_id) fail(409, "Start a subscription first.", { code: "no_subscription" });
      const { plan, currency } = pickPlan({ ...b, currency: org.billing_currency });
      if (plan === org.plan_code) fail(400, `You're already on ${PLANS[plan].name}.`);
      const planId = planIdFor(plan, currency);
      if (!planId) fail(503, `${PLANS[plan].name} in ${currency} isn't available yet.`, { code: "plan_unavailable" });
      const upgrade = (PLANS[plan].prices[currency] || 0) > (PLANS[org.plan_code]?.prices[currency] || 0);
      await client().updateSubscription(org.razorpay_subscription_id, { planId, at: upgrade ? "now" : "cycle_end" });
      // An upgrade unlocks when Razorpay confirms the charge; a downgrade is remembered until the period ends.
      await q(`update organizations set pending_plan_code = $2, updated_at = now() where id = $1`, [ctx.org.id, upgrade ? null : plan]);
      await O.audit(ctx.org.id, ctx.user.id, upgrade ? "billing.upgrade_requested" : "billing.downgrade_scheduled", plan, { from: org.plan_code });
      sendJson(res, 200, await billingView(ctx));
    }],

    ["POST", "/api/billing/cancel", async (req, res) => {
      const ctx = await needCtx(req, "owner");
      if (ctx.operatorVisit) fail(403, "Only the owner can cancel.");
      const org = await one(`select * from organizations where id = $1`, [ctx.org.id]);
      if (!org.razorpay_subscription_id || !["active", "past_due"].includes(org.billing_status)) fail(409, "There's no active subscription to cancel.", { code: "no_subscription" });
      await client().cancelSubscription(org.razorpay_subscription_id);
      await q(`update organizations set cancel_at_period_end = true, pending_plan_code = null, updated_at = now() where id = $1`, [ctx.org.id]);
      await O.audit(ctx.org.id, ctx.user.id, "billing.cancel_requested", PLANS[org.plan_code]?.name, { until: org.current_period_end });
      sendJson(res, 200, await billingView(ctx));
    }],

    ["POST", "/api/webhooks/razorpay", webhook],
    ["POST", "/api/admin/orgs/:org/billing", (req, res, p) => operatorGrant(req, res, p, currentUser)],
  ];
}

// Configured Razorpay plan id → internal plan and currency. Only ids this server was given count.
function planOf(id) {
  if (!id) return null;
  for (const plan of SELF_SERVE) for (const currency of CURRENCIES) if (planIdFor(plan, currency) === id) return { plan, currency };
  return null;
}

async function webhook(req, res) {
  const cfg = billingConfig();
  const raw = await readBody(req, 512 * 1024); // the exact bytes: the signature is over these
  if (!cfg.webhookSecret) fail(503, "Webhooks are not configured.");
  if (!verifyWebhook(raw, req.headers["x-razorpay-signature"], cfg.webhookSecret)) {
    if (limited("rzp-bad-sig:" + clientIp(req), 30, 3600e3)) console.warn("[billing] repeated invalid webhook signatures from", clientIp(req));
    fail(400, "Invalid signature.");
  }
  let evt; try { evt = JSON.parse(raw.toString("utf8")); } catch { fail(400, "Invalid JSON."); }
  const eventId = String(req.headers["x-razorpay-event-id"] || "").slice(0, 100) || "sha256:" + (await import("node:crypto")).createHash("sha256").update(raw).digest("hex");
  const summary = eventSummary(evt), subId = summary.subscription.id;
  try {
    const out = await tx(async (c) => {
      // Recorded first: a duplicate delivery finds the row and stops. A failed one may be retried.
      const fresh = (await c.query(`insert into billing_events (event_id, event_type, payload) values ($1, $2, $3)
        on conflict (event_id) do update set received_at = now(), error = null where billing_events.status = 'failed' returning event_id`, [eventId, String(evt.event || "unknown"), summary])).rows[0];
      if (!fresh) return { duplicate: true };
      const org = subId ? (await c.query(`select * from organizations where razorpay_subscription_id = $1 for update`, [subId])).rows[0] : null;
      if (!org) { await c.query(`update billing_events set status = 'ignored', processed_at = now(), error = 'no organisation for this subscription' where event_id = $1`, [eventId]); return { ignored: true }; }
      const r = applyEvent(org, evt, { planOf, graceDays: cfg.graceDays });
      const patch = { ...r.patch };
      if (patch.billing_status === "active" && ["subscription.charged", "subscription.activated", "subscription.resumed"].includes(evt.event)) patch.cancel_at_period_end = false;
      const keys = Object.keys(patch);
      if (keys.length) await c.query(`update organizations set ${keys.map((k, i) => `${k} = $${i + 2}`).join(", ")}, updated_at = now() where id = $1`, [org.id, ...keys.map((k) => patch[k])]);
      await c.query(`update billing_events set status = $2, org_id = $3, processed_at = now(), error = $4 where event_id = $1`, [eventId, r.status, org.id, r.reason || null]);
      if (r.status === "processed" && evt.event !== "subscription.authenticated") {
        await c.query(`insert into audit_log (org_id, action, target, detail) values ($1, $2, $3, $4)`,
          [org.id, "billing." + evt.event, eventId, { from: { plan: org.plan_code, status: org.billing_status }, to: { plan: patch.plan_code || org.plan_code, status: patch.billing_status || org.billing_status } }]);
      }
      return { status: r.status };
    });
    sendJson(res, 200, { ok: true, ...out });
  } catch (e) {
    // Remember the failure (outside the rolled-back transaction) so operators see it and a retry reprocesses it.
    await q(`insert into billing_events (event_id, event_type, status, payload, error) values ($1, $2, 'failed', $3, $4) on conflict (event_id) do update set status = 'failed', error = excluded.error`,
      [eventId, String(evt.event || "unknown"), summary, String(e.message || e).slice(0, 300)]).catch(() => {});
    if (limited("rzp-fail", 5, 3600e3)) console.error("[billing] webhook processing keeps failing:", e.message);
    else console.error("[billing] webhook failed", eventId, e.message);
    fail(500, "Webhook processing failed; it will be retried.");
  }
}

// ── operator controls ────────────────────────────────────────────────────────
// A verified platform operator may put an organisation on a plan with contract limits, for a reason and until a
// date. The grant and its values stop applying on their own at expiry; every change is audited before/after.
const NUMERIC = new Set(["brands", "questions", "competitorsPerBrand", "samples", "seats", "actionDrafts", "trendMonths", "baselineRuns"]);
function checkOverrides(o) {
  if (o == null) return {};
  if (typeof o !== "object" || Array.isArray(o)) fail(400, "Overrides must be an object of entitlement limits.");
  for (const [k, v] of Object.entries(o)) {
    if (!ENTITLEMENT_KEYS.includes(k)) fail(400, `Unknown entitlement: ${k}.`);
    if (NUMERIC.has(k) && !(Number.isInteger(v) && v >= 0 && v <= 100000)) fail(400, `${k} must be a whole number from 0.`);
  }
  return o;
}
export async function operatorGrant(req, res, p, currentUser) {
  const u = await currentUser(req); if (!u || !O.isOperator(u)) fail(404, "Not found");
  const b = await readJson(req, 20000);
  const plan = String(b.plan || ""); if (!PLANS[plan] || plan === "trial") fail(400, "Choose legacy, starter, growth, agency or enterprise.");
  const reason = String(b.reason || "").trim().slice(0, 300); if (reason.length < 3) fail(400, "Give a reason (for example, the signed order number).");
  const expiresAt = b.expiresAt ? new Date(b.expiresAt) : null;
  if (!expiresAt || Number.isNaN(+expiresAt) || expiresAt <= new Date()) fail(400, "Give an expiry date in the future.");
  const values = checkOverrides(b.overrides);
  const out = await tx(async (c) => {
    const org = (await c.query(`select * from organizations where slug = $1 for update`, [p.org])).rows[0]; if (!org) fail(404, "Not found");
    const overrides = { grant: plan !== "legacy", values, reason, expiresAt: expiresAt.toISOString(), by: u.email };
    await c.query(`update organizations set plan_code = $2, billing_status = $3, entitlement_overrides = $4, current_period_start = now(), current_period_end = $5,
                     grace_ends_at = null, pending_plan_code = null, updated_at = now() where id = $1`,
      [org.id, plan, plan === "legacy" ? "internal" : "active", overrides, expiresAt]);
    await c.query(`insert into audit_log (org_id, user_id, action, target, detail) values ($1, $2, 'billing.override', $3, $4)`, [org.id, u.id, org.name, {
      reason, expiresAt: overrides.expiresAt,
      before: { plan: org.plan_code, status: org.billing_status, overrides: org.entitlement_overrides?.values || {}, periodEnd: org.current_period_end },
      after: { plan, status: plan === "legacy" ? "internal" : "active", overrides: values, periodEnd: overrides.expiresAt },
    }]);
    return { slug: org.slug, plan, expiresAt: overrides.expiresAt };
  });
  sendJson(res, 200, { ok: true, ...out });
}

// ── daily reconciliation ─────────────────────────────────────────────────────
// A missed webhook must not leave permanent drift. A bounded batch of subscriptions not compared in the last day
// is fetched from Razorpay and applied like an event: forward only, never shortening a paid period, and without
// moving billing_event_at (so a real webhook created earlier but delivered later is still applied).
const REMOTE = { active: "subscription.charged", pending: "subscription.halted", halted: "subscription.halted", cancelled: "subscription.cancelled", completed: "subscription.cancelled", expired: "subscription.cancelled", paused: "subscription.paused" };
export async function reconcile({ limit = 20, log = () => {} } = {}) {
  let rzp; try { rzp = client(); } catch { return { checked: 0, changed: 0 }; }
  const due = await q(`select id, razorpay_subscription_id from organizations where razorpay_subscription_id is not null and billing_status in ('active','past_due')
                       and (billing_reconciled_at is null or billing_reconciled_at < now() - interval '1 day') order by billing_reconciled_at nulls first limit $1`, [limit]);
  let changed = 0;
  for (const d of due) {
    let sub; try { sub = await rzp.fetchSubscription(d.razorpay_subscription_id); } catch (e) { log(`[reconcile] ${d.razorpay_subscription_id}: ${e.message}`); continue; }
    await tx(async (c) => {
      const org = (await c.query(`select * from organizations where id = $1 for update`, [d.id])).rows[0];
      const type = REMOTE[sub.status];
      const r = type ? applyEvent({ ...org, billing_event_at: null }, { event: type, created_at: Math.floor(Date.now() / 1000), payload: { subscription: { entity: sub } } }, { planOf, graceDays: billingConfig().graceDays }) : { status: "ignored", patch: {} };
      const patch = { ...r.patch }; delete patch.billing_event_at;
      const same = (k) => (k === "current_period_end" ? +new Date(patch[k]) === +new Date(org[k]) : patch[k] === org[k]);
      const drift = ["plan_code", "billing_status", "current_period_end"].some((k) => k in patch && !same(k));
      patch.billing_reconciled_at = new Date();
      const keys = Object.keys(patch);
      await c.query(`update organizations set ${keys.map((k, i) => `${k} = $${i + 2}`).join(", ")} where id = $1`, [org.id, ...keys.map((k) => patch[k])]);
      await c.query(`insert into billing_events (event_id, event_type, org_id, status, processed_at, payload) values ($1, 'reconcile', $2, $3, now(), $4) on conflict (event_id) do nothing`,
        [`reconcile:${org.razorpay_subscription_id}:${Date.now()}`, org.id, drift ? "processed" : "ignored", { remote: { status: sub.status, plan_id: sub.plan_id, current_end: sub.current_end }, local: { plan: org.plan_code, status: org.billing_status } }]);
      if (drift) { changed++; await c.query(`insert into audit_log (org_id, action, target, detail) values ($1, 'billing.reconciled', $2, $3)`, [org.id, org.razorpay_subscription_id, { from: { plan: org.plan_code, status: org.billing_status }, to: { plan: patch.plan_code || org.plan_code, status: patch.billing_status || org.billing_status } }]); }
    });
  }
  return { checked: due.length, changed };
}
