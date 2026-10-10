// Billing state and entitlements, per organisation. The one place that decides what an organisation may do and
// spend; routes, the AI gate and the scheduler call the assert* helpers here before any work. The browser mirrors
// these decisions to explain locks, but hiding a control is never the enforcement.
import { one, q } from "./db.mjs";
import { HttpError } from "./http.mjs";
import { PLANS, effectiveEntitlements } from "./plans.mjs";

// What an organisation may do right now:
//   write  - everything its plan allows (internal, active, trial in date, cancelled but paid up)
//   manual - past due inside the grace period: people may still work, scheduled (unattended) spend is paused
//   read   - historical reports stay readable; new checks, drafts, exports and scheduled jobs are locked
export function accessMode(org, now = new Date()) {
  if (!org) return "read";
  const after = (t) => !!t && new Date(t) > now;
  switch (org.billing_status) {
    case "internal": case "active": return "write";
    case "trialing": return after(org.trial_ends_at) ? "write" : "read";
    case "past_due": return after(org.grace_ends_at) ? "manual" : "read";
    case "canceled": return after(org.current_period_end) ? "write" : "read";
    default: return "read";
  }
}

const UPGRADE = { trial: "growth", starter: "growth", growth: "agency", agency: "enterprise" };
export const nextPlan = (code) => UPGRADE[code] || "enterprise";

const LABEL = { brands: "brand", questions: "tracked question", competitors: "competitor per brand", seats: "seat", actionDrafts: "action draft", engines: "engine", schedule: "schedule", samples: "sample per question", integrations: "integration", whiteLabel: "white-label report", api: "API access", baselineRuns: "trial check" };
export function planError(capability, used, limit, recommendedPlan, resetsAt = null) {
  const what = LABEL[capability] || capability;
  const lim = typeof limit === "number" ? `${limit} ${what}${limit === 1 ? "" : "s"}` : `${what}: ${limit}`;
  return new HttpError(402, `Your plan includes ${lim}. Upgrade to ${PLANS[recommendedPlan]?.name || recommendedPlan} to continue.`, {
    code: "plan_limit", capability, used, limit, recommendedPlan, resetsAt,
  });
}

// Overrides are stored as { values, reason, expiresAt, by }. They stop applying on their own once expired.
export function activeOverrides(org, now = new Date()) {
  const o = org?.entitlement_overrides || {};
  if (!o.values) return {};
  if (o.expiresAt && new Date(o.expiresAt) <= now) return {};
  return o.values;
}

const monthStart = (now = new Date()) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
const monthEnd = (now = new Date()) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
// Usage counts reset with the billing period when there is one, else on the calendar month.
export function usagePeriod(org, now = new Date()) {
  const s = org?.current_period_start && new Date(org.current_period_start), e = org?.current_period_end && new Date(org.current_period_end);
  if (s && e && s <= now && now < e) return { start: s, end: e };
  if (org?.billing_status === "trialing" && org.trial_started_at) return { start: new Date(org.trial_started_at), end: org.trial_ends_at ? new Date(org.trial_ends_at) : null };
  return { start: monthStart(now), end: monthEnd(now) };
}

export async function billingState(orgId) {
  const org = await one(`select * from organizations where id = $1`, [orgId]);
  if (!org) throw new HttpError(404, "Organisation not found.");
  const entitlements = effectiveEntitlements(org.plan_code, activeOverrides(org));
  const period = usagePeriod(org);
  const [brands, seats, drafts, runs, questions] = await Promise.all([
    one(`select count(*)::int as n from workspaces where org_id = $1`, [orgId]),
    one(`select (select count(*) from memberships where org_id = $1) + (select count(*) from invitations where org_id = $1 and accepted_at is null and revoked_at is null and expires_at > now()) as n`, [orgId]),
    one(`select coalesce(sum(n), 0)::int as n from usage where org_id = $1 and kind = 'draft' and at >= $2`, [orgId, period.start]),
    one(`select count(*)::int as n from runs r join workspaces w on w.id = r.workspace_id where w.org_id = $1 and r.started_at >= $2`, [orgId, period.start]),
    one(`select coalesce(sum((select count(*) from jsonb_array_elements(coalesce(w.setup->'questions', '[]')) x where coalesce(x->>'on', 'true') <> 'false')), 0)::int as n from workspaces w where w.org_id = $1`, [orgId]),
  ]);
  return { org, mode: accessMode(org), entitlements, period,
    usage: { brands: brands.n, seats: Number(seats.n), actionDrafts: drafts.n, runs: runs.n, questions: questions.n } };
}

export async function requireMode(orgId, operation = "manual") {
  const state = await billingState(orgId);
  if (state.org.billing_status === "trialing" && !state.org.trial_ends_at) {
    throw new HttpError(402, "Verify your email address to start your seven-day trial.", { code: "email_verification_required" });
  }
  if (state.mode === "read" || (operation === "scheduled" && state.mode !== "write")) {
    throw new HttpError(402, "Your subscription is read-only. Your reports stay here; choose a plan to run new checks.", { code: "billing_read_only", status: state.org.billing_status, recommendedPlan: nextPlan(state.org.plan_code) });
  }
  return state;
}

export async function auditBilling(orgId, userId, action, detail) {
  await q(`insert into audit_log (org_id, user_id, action, detail) values ($1, $2, $3, $4)`, [orgId, userId || null, action, detail || {}]);
}
