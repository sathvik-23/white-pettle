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
export function planError(capability, used, limit, recommendedPlan, resetsAt = null, planName = null) {
  const what = LABEL[capability] || capability;
  const lim = typeof limit === "number" ? `${limit} ${what}${limit === 1 ? "" : "s"}` : `${what}: ${limit}`;
  return new HttpError(402, `${planName || "Your plan"} includes ${lim}. Upgrade to ${PLANS[recommendedPlan]?.name || recommendedPlan} to continue.`, {
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

// ── Razorpay webhook lifecycle ───────────────────────────────────────────────
// Pure: given the organisation row and a verified event, the columns to change. The webhook route runs it inside
// a transaction with the row locked. Rules (design §8, docs/superpowers/specs/2026-10-10-white-petal-razorpay-plans-design.md):
//   - only a signed activated/charged event grants a paid plan, and only for a plan id the server configured;
//   - a failed renewal starts one three-day grace period; cancellation keeps the paid period;
//   - an event older than the last applied one changes nothing; a paid period end only ever moves forward.
const SUB_EVENTS = new Set(["subscription.authenticated", "subscription.activated", "subscription.charged", "subscription.updated", "subscription.pending", "subscription.halted", "subscription.cancelled", "subscription.completed", "subscription.paused", "subscription.resumed"]);
const fromUnix = (v) => (v ? new Date(Number(v) * 1000) : null);
const later = (a, b) => (!b ? null : !a || b > new Date(a) ? b : null); // b if it moves the date forward

export function applyEvent(org, evt, { planOf, now = new Date(), graceDays = 3 } = {}) {
  const type = String(evt?.event || "");
  if (!SUB_EVENTS.has(type)) return { status: "ignored", reason: "not a subscription event", patch: {} };
  const sub = evt.payload?.subscription?.entity || {};
  const at = fromUnix(evt.created_at) || now;
  if (org.billing_event_at && at < new Date(org.billing_event_at)) return { status: "ignored", reason: "older than the last applied event", patch: {} };
  const patch = { billing_event_at: at };
  const periodEnd = later(org.current_period_end, fromUnix(sub.current_end));
  const grant = () => {
    const mapped = planOf(sub.plan_id);
    if (!mapped) return false;
    Object.assign(patch, { plan_code: mapped.plan, billing_currency: mapped.currency, billing_status: "active", grace_ends_at: null });
    if (fromUnix(sub.current_start)) patch.current_period_start = fromUnix(sub.current_start);
    if (periodEnd) patch.current_period_end = periodEnd;
    if (org.pending_plan_code === mapped.plan || org.pending_plan_code == null) patch.pending_plan_code = null;
    if (sub.customer_id) patch.razorpay_customer_id = sub.customer_id;
    return true;
  };
  switch (type) {
    case "subscription.authenticated":
      if (sub.customer_id) patch.razorpay_customer_id = sub.customer_id;
      break; // a mandate, not a payment: no access yet
    case "subscription.activated": case "subscription.charged": case "subscription.resumed":
      if (!grant()) return { status: "ignored", reason: "unknown Razorpay plan id", patch: {} };
      break;
    case "subscription.updated":
      // A plan change Razorpay has applied. Only an active subscription keeps its access; others wait for a charge.
      if (sub.status === "active" && !grant()) return { status: "ignored", reason: "unknown Razorpay plan id", patch: {} };
      break;
    case "subscription.pending": case "subscription.halted":
      patch.billing_status = "past_due";
      if (!org.grace_ends_at || org.billing_status !== "past_due") patch.grace_ends_at = new Date(now.getTime() + graceDays * 864e5);
      break;
    case "subscription.cancelled": case "subscription.completed":
      patch.billing_status = "canceled";
      if (periodEnd) patch.current_period_end = periodEnd;
      break;
    case "subscription.paused":
      patch.billing_status = "paused";
      break;
  }
  return { status: "processed", patch };
}

// What we keep of an event: identifiers, statuses, amounts and timestamps. No card, method, email or phone.
export function eventSummary(evt) {
  const s = evt?.payload?.subscription?.entity || {}, p = evt?.payload?.payment?.entity;
  return {
    event: evt?.event, created_at: evt?.created_at,
    subscription: { id: s.id, plan_id: s.plan_id, status: s.status, current_start: s.current_start, current_end: s.current_end, ended_at: s.ended_at, paid_count: s.paid_count, notes: s.notes && !Array.isArray(s.notes) ? { white_petal_org_id: s.notes.white_petal_org_id, white_petal_plan: s.notes.white_petal_plan } : {} },
    ...(p ? { payment: { id: p.id, status: p.status, amount: p.amount, currency: p.currency, invoice_id: p.invoice_id } } : {}),
  };
}

// ── assertions at the cost boundaries ────────────────────────────────────────
// Each loads the organisation's state, refuses read-only use, and throws a structured plan_limit error when the
// change would go past the plan. Reductions are always allowed, so an organisation over its limit after a
// downgrade can get back under it.
const activeQuestions = (setup) => (setup?.questions || []).filter((x) => x && x.on !== false).length;
const limitError = (state, capability, used, limit) => planError(capability, used, limit, nextPlan(state.org.plan_code), state.period.end, PLANS[state.org.plan_code]?.name);
const allowsIntegration = (e, provider) => e.integrations === "all" || (Array.isArray(e.integrations) && e.integrations.includes(provider));

export async function assertBrandCreate(orgId) {
  const state = await requireMode(orgId);
  if (state.usage.brands >= state.entitlements.brands) throw limitError(state, "brands", state.usage.brands, state.entitlements.brands);
  return state;
}

// `prev` is the brand's current setup when it is being edited, so only growth past the plan is refused.
export async function assertWorkspaceSetup(orgId, setup, { prev = null, workspaceId = null } = {}) {
  const state = await requireMode(orgId);
  const e = state.entitlements, mine = activeQuestions(setup), before = prev ? activeQuestions(prev) : 0;
  // Questions are pooled across the organisation's brands (Agency: 100 across five).
  const others = state.usage.questions - (workspaceId ? before : 0);
  if (mine > before && others + mine > e.questions) throw limitError(state, "questions", others + mine, e.questions);
  const comps = (setup?.profile?.competitors || []).length, compsBefore = (prev?.profile?.competitors || []).length;
  if (comps > compsBefore && comps > e.competitorsPerBrand) throw limitError(state, "competitors", comps, e.competitorsPerBrand);
  const blocked = (setup?.engines || []).filter((x) => !e.engines.includes(x) && !(prev?.engines || []).includes(x));
  if (blocked.length) throw limitError(state, "engines", blocked.join(", "), e.engines.join(", "));
  return state;
}

export async function assertSchedule(orgId, schedule, samples) {
  const state = await requireMode(orgId);
  if (schedule != null && !state.entitlements.schedule.includes(schedule)) throw limitError(state, "schedule", schedule, state.entitlements.schedule.join(" or "));
  if (samples != null && samples > state.entitlements.samples) throw limitError(state, "samples", samples, state.entitlements.samples);
  return state;
}

export async function assertSeatInvite(orgId) {
  const state = await requireMode(orgId);
  if (state.usage.seats >= state.entitlements.seats) throw limitError(state, "seats", state.usage.seats, state.entitlements.seats);
  return state;
}

export async function assertIntegration(orgId, provider) {
  const state = await requireMode(orgId);
  if (!allowsIntegration(state.entitlements, provider)) throw limitError(state, "integrations", provider, Array.isArray(state.entitlements.integrations) ? state.entitlements.integrations.join(", ") || "none" : state.entitlements.integrations);
  return state;
}

// A trial includes a fixed number of checks (a baseline and a re-check).
export async function assertNewRun(orgId) {
  const state = await requireMode(orgId);
  const n = state.entitlements.baselineRuns;
  if (n != null && state.usage.runs >= n) throw limitError(state, "baselineRuns", state.usage.runs, n);
  return state;
}

// Generated action drafts: pages, rewrites and outreach pitches. Counted per period from the usage table.
export const DRAFT_KINDS = new Set(["pitch", "article", "fixpack"]);
export async function assertAi(orgId, { kind, engine, draft = false, scheduled = false }) {
  const state = await requireMode(orgId, scheduled ? "scheduled" : "manual");
  const e = state.entitlements;
  if (engine && !e.engines.includes(engine)) throw limitError(state, "engines", engine, e.engines.join(", "));
  if (draft && state.usage.actionDrafts >= e.actionDrafts) throw limitError(state, "actionDrafts", state.usage.actionDrafts, e.actionDrafts);
  return state;
}

// For the scheduler: may this brand run unattended now, and with what? Throws like the others.
export async function scheduledPlan(orgId, ws) {
  const state = await requireMode(orgId, "scheduled");
  const e = state.entitlements;
  if (!e.schedule.includes(ws.schedule)) throw limitError(state, "schedule", ws.schedule, e.schedule.join(" or "));
  return state;
}

// The safe summary the browser gets with /api/config.
export async function billingSummary(orgId) {
  const state = await billingState(orgId);
  const finite = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v === Infinity ? null : v]));
  return {
    plan: { code: state.org.plan_code, name: PLANS[state.org.plan_code]?.name, status: state.org.billing_status, currency: state.org.billing_currency },
    mode: state.mode,
    period: { start: state.org.current_period_start, end: state.org.current_period_end, trialEndsAt: state.org.trial_ends_at, graceEndsAt: state.org.grace_ends_at },
    entitlements: finite(state.entitlements), usage: state.usage, recommendedPlan: nextPlan(state.org.plan_code),
  };
}

// The visible trend window in months for run history, or null for no limit. Stored evidence is never deleted.
export async function trendMonths(orgId) {
  const org = await one(`select plan_code, entitlement_overrides from organizations where id = $1`, [orgId]);
  const m = effectiveEntitlements(org?.plan_code || "legacy", activeOverrides(org)).trendMonths;
  return Number.isFinite(m) ? m : null;
}
