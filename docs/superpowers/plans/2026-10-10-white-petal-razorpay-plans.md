# White Petal Razorpay Plans Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship usage-backed Starter, Growth, Agency and Enterprise plans across Bloom and White Petal, with Razorpay subscriptions, server-enforced entitlements, a seven-day capped trial, and a credential-gated production rollout.

**Architecture:** White Petal owns the canonical plan catalogue, billing state and every entitlement decision at organisation scope. Razorpay Checkout collects payment details, while signed idempotent webhooks control activation; Bloom presents a matching marketing snapshot and passes only validated plan/currency hints to White Petal. Existing organisations remain on an unrestricted `legacy/internal` state until deliberately migrated.

**Tech Stack:** Node.js 22 ESM, built-in `node:test`, PostgreSQL 17, vanilla browser JavaScript/CSS, Razorpay REST/Checkout, Next.js 16/React 19/TypeScript, Terraform, Google Cloud Run and GitHub Actions.

---

## Scope and repository boundaries

- White Petal repository: `/Users/sathvik/Desktop/white-pettle/white-petal-app`
- Bloom repository: `/Users/sathvik/Desktop/perfstaq-app/perfstaq-landing`
- Approved design: `docs/superpowers/specs/2026-10-10-white-petal-razorpay-plans-design.md`
- White Petal implementation branch: create `codex/razorpay-plans` from `org-ready`
- Bloom implementation branch: continue `feat/perfstaq-bloom-landing` or create an isolated worktree from that exact commit

Do not deploy live billing until Tasks 1–11 pass with Razorpay test mode. Task
12 prepares production; Task 13 requires the user-provided credentials and
Razorpay account approvals.

## File map

### White Petal: create

- `server/plans.mjs` — immutable catalogue, price mapping, public catalogue and pure limit helpers.
- `server/migrations/003_billing.sql` — billing fields and idempotent webhook-event table.
- `server/billing.mjs` — database-backed billing state, usage and entitlement checks.
- `server/razorpay.mjs` — narrow Razorpay REST client and webhook signature verification.
- `server/billing-routes.mjs` — billing catalogue, state, checkout, plan change, cancel and webhook routes.
- `test/server/plans.test.mjs` — pure catalogue and margin/limit tests.
- `test/server/razorpay.test.mjs` — REST request and HMAC verification tests.
- `docs/razorpay-runbook.md` — test/live configuration, reconciliation, rollout and rollback.

### White Petal: modify

- `server/env.mjs` — load the three Razorpay secrets.
- `server/routes.mjs` — compose billing routes and enforce brand, seat, schedule and integration limits.
- `server/app.mjs` — enforce AI/action entitlements before forwarding costly requests and expose billing summary.
- `server/orgs.mjs` — plan-aware usage summary and operator override audit helper.
- `test/server/api.test.mjs` — migration, billing lifecycle, tenant isolation and all route enforcement cases.
- `public/index.html` — Billing & usage navigation entry and checkout script.
- `public/app.js` — billing state, usage UI, checkout, locked-control explanations and read-only mode.
- `public/app.css` — plan cards, usage bars, lock banners and responsive billing layout.
- `.env.example` — documented local Razorpay test variables.
- `infra/terraform/secrets.tf` — Razorpay secret containers and runtime access.
- `infra/secrets.sh` — accept/rotate the three new secret values through the existing safe workflow.
- `.github/workflows/ci.yml` — ensure billing tests and syntax checks remain release gates.
- `README.md` — billing behavior and local test-mode setup.

### Bloom: modify/create

- `src/lib/bloom-content.ts` — approved prices, truthful features and CTA parameters.
- `src/components/bloom/Pricing.tsx` — monthly-only presentation and detailed comparison.
- `src/components/bloom/Closing.tsx` — Growth trial CTA.
- `src/components/bloom/Hero.tsx` — trial CTA with plan/currency hints.
- `src/components/bloom/Nav.tsx` — consistent trial CTA.
- `src/lib/billing-plans.ts` — small typed marketing snapshot and checkout URL builder.
- `test/billing-plans.test.ts` — price, feature and URL contract tests.
- `package.json` / `package-lock.json` — add the test runner command needed for TypeScript unit tests.

## Task 1: Canonical plan catalogue

**Files:**
- Create: `server/plans.mjs`
- Create: `test/server/plans.test.mjs`

- [ ] **Step 1: Write failing catalogue tests**

```js
// test/server/plans.test.mjs
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
});

test("enterprise overrides merge without mutating the catalogue", () => {
  const before = PLANS.enterprise.entitlements.questions;
  const out = effectiveEntitlements("enterprise", { questions: 600, seats: 80 });
  assert.equal(out.questions, 600);
  assert.equal(out.seats, 80);
  assert.equal(PLANS.enterprise.entitlements.questions, before);
});
```

- [ ] **Step 2: Run the tests and confirm the missing-module failure**

Run: `npm test -- --test-name-pattern='catalogue|enterprise overrides'`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `server/plans.mjs`.

- [ ] **Step 3: Implement the immutable catalogue**

```js
// server/plans.mjs
const plan = (code, name, prices, featured, entitlements) => Object.freeze({
  code, name, prices: Object.freeze(prices), featured, entitlements: Object.freeze(entitlements),
});

export const PLANS = Object.freeze({
  legacy: plan("legacy", "Legacy", { USD: 0, INR: 0 }, false, {
    brands: Infinity, questions: Infinity, competitorsPerBrand: Infinity,
    engines: ["chatgpt", "perplexity", "gemini", "aio", "aimode", "claude", "groq"],
    schedule: ["off", "weekly", "daily"], samples: 5, seats: Infinity,
    actionDrafts: Infinity, integrations: "all", whiteLabel: true, api: true,
  }),
  trial: plan("trial", "Growth trial", { USD: 0, INR: 0 }, false, {
    brands: 1, questions: 10, competitorsPerBrand: 3,
    engines: ["chatgpt", "perplexity", "gemini"], schedule: ["off"], samples: 1,
    seats: 1, actionDrafts: 10, integrations: [], whiteLabel: false, api: false,
    baselineRuns: 2,
  }),
  starter: plan("starter", "Starter", { USD: 4900, INR: 499900 }, false, {
    brands: 1, questions: 15, competitorsPerBrand: 3,
    engines: ["chatgpt", "perplexity", "gemini"], schedule: ["off", "weekly"], samples: 1,
    seats: 1, actionDrafts: 10, integrations: ["bing"], whiteLabel: false, api: false,
  }),
  growth: plan("growth", "Growth", { USD: 9900, INR: 999900 }, true, {
    brands: 1, questions: 30, competitorsPerBrand: 5,
    engines: ["chatgpt", "perplexity", "gemini", "aio", "aimode", "claude", "groq"],
    schedule: ["off", "weekly", "rotating"], samples: 1, seats: 5, actionDrafts: 30,
    integrations: ["google", "bing", "cloudflare"], whiteLabel: false, api: false,
  }),
  agency: plan("agency", "Agency", { USD: 24900, INR: 2499900 }, false, {
    brands: 5, questions: 100, competitorsPerBrand: 5,
    engines: ["chatgpt", "perplexity", "gemini", "aio", "aimode", "claude", "groq"],
    schedule: ["off", "weekly", "rotating"], samples: 1, seats: 20, actionDrafts: 100,
    integrations: "all", whiteLabel: true, api: "export",
  }),
  enterprise: plan("enterprise", "Enterprise", { USD: 99900, INR: 9999900 }, false, {
    brands: 20, questions: 300, competitorsPerBrand: 20,
    engines: ["chatgpt", "perplexity", "gemini", "aio", "aimode", "claude", "groq"],
    schedule: ["off", "weekly", "daily"], samples: 3, seats: 100,
    actionDrafts: 500, integrations: "all", whiteLabel: true, api: true,
  }),
});

export function effectiveEntitlements(code, overrides = {}) {
  const base = PLANS[code]?.entitlements || PLANS.trial.entitlements;
  return Object.freeze({ ...base, ...(overrides || {}) });
}

export function publicPlans() {
  return ["starter", "growth", "agency", "enterprise"].map((code) => {
    const p = PLANS[code];
    return { code: p.code, name: p.name, prices: p.prices, featured: p.featured, entitlements: p.entitlements };
  });
}
```

- [ ] **Step 4: Run the catalogue tests**

Run: `npm test -- --test-name-pattern='catalogue|enterprise overrides'`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/plans.mjs test/server/plans.test.mjs
git commit -m "feat(billing): add plan catalogue"
```

## Task 2: Billing schema and legacy-safe migration

**Files:**
- Create: `server/migrations/003_billing.sql`
- Modify: `test/server/api.test.mjs`

- [ ] **Step 1: Add a failing migration assertion to the DB-backed API test**

After the first account is created, query its organisation and assert:

```js
const [billingOrg] = await sql(`select plan_code, billing_status from organizations where slug = $1`, [(await call("a", "GET", "/api/me")).data.org.slug]);
assert.deepEqual(billingOrg, { plan_code: "legacy", billing_status: "internal" });
```

- [ ] **Step 2: Run the DB-backed test**

Run: `TEST_DATABASE_URL=postgres://sathvik@127.0.0.1:5432/whitepetal_test npm test`

Expected: FAIL because `plan_code` does not exist.

- [ ] **Step 3: Add the migration**

```sql
-- server/migrations/003_billing.sql
alter table organizations
  add column plan_code text not null default 'legacy'
    check (plan_code in ('legacy','trial','starter','growth','agency','enterprise')),
  add column billing_status text not null default 'internal'
    check (billing_status in ('internal','trialing','active','past_due','canceled','paused')),
  add column billing_currency text check (billing_currency in ('USD','INR')),
  add column razorpay_customer_id text,
  add column razorpay_subscription_id text unique,
  add column trial_started_at timestamptz,
  add column trial_ends_at timestamptz,
  add column current_period_start timestamptz,
  add column current_period_end timestamptz,
  add column grace_ends_at timestamptz,
  add column pending_plan_code text
    check (pending_plan_code is null or pending_plan_code in ('starter','growth','agency','enterprise')),
  add column entitlement_overrides jsonb not null default '{}',
  add column billing_event_at timestamptz;

alter table workspaces drop constraint workspaces_schedule_check;
alter table workspaces add constraint workspaces_schedule_check
  check (schedule in ('off','weekly','rotating','daily'));
alter table workspaces add column rotation_cursor int not null default 0;
alter table workspaces add column last_full_run_at timestamptz;

create table billing_events (
  event_id text primary key,
  event_type text not null,
  org_id uuid references organizations on delete set null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  status text not null default 'received' check (status in ('received','processed','ignored','failed')),
  payload jsonb not null default '{}',
  error text
);
create index billing_events_org_time on billing_events (org_id, received_at desc);
```

- [ ] **Step 4: Run all server tests**

Run: `TEST_DATABASE_URL=postgres://sathvik@127.0.0.1:5432/whitepetal_test npm test`

Expected: PASS, including the legacy migration assertion.

- [ ] **Step 5: Commit**

```bash
git add server/migrations/003_billing.sql test/server/api.test.mjs
git commit -m "feat(billing): add subscription schema"
```

## Task 3: Billing state and entitlement service

**Files:**
- Create: `server/billing.mjs`
- Modify: `test/server/plans.test.mjs`

- [ ] **Step 1: Write failing pure state tests**

```js
import { accessMode, planError } from "../../server/billing.mjs";

test("billing states preserve reports but stop spend after grace", () => {
  const now = new Date("2026-10-10T12:00:00Z");
  assert.equal(accessMode({ billing_status: "active" }, now), "write");
  assert.equal(accessMode({ billing_status: "past_due", grace_ends_at: "2026-10-11T00:00:00Z" }, now), "manual");
  assert.equal(accessMode({ billing_status: "past_due", grace_ends_at: "2026-10-09T00:00:00Z" }, now), "read");
  assert.equal(accessMode({ billing_status: "canceled", current_period_end: "2026-10-11T00:00:00Z" }, now), "write");
  assert.equal(accessMode({ billing_status: "canceled", current_period_end: "2026-10-09T00:00:00Z" }, now), "read");
});

test("plan errors are structured for upgrade UI", () => {
  const e = planError("questions", 15, 15, "growth", "2026-11-01T00:00:00Z");
  assert.equal(e.status, 402);
  assert.deepEqual(e.extra, { code: "plan_limit", capability: "questions", used: 15, limit: 15, recommendedPlan: "growth", resetsAt: "2026-11-01T00:00:00Z" });
});
```

- [ ] **Step 2: Run and confirm the missing-module failure**

Run: `npm test -- --test-name-pattern='billing states|plan errors'`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `server/billing.mjs`.

- [ ] **Step 3: Implement state resolution and DB-backed usage helpers**

Implement these exported interfaces in `server/billing.mjs`:

```js
import { one, q } from "./db.mjs";
import { HttpError } from "./http.mjs";
import { PLANS, effectiveEntitlements } from "./plans.mjs";

export function accessMode(org, now = new Date()) {
  if (!org) return "read";
  if (org.billing_status === "internal" || org.billing_status === "active") return "write";
  if (org.billing_status === "trialing") return new Date(org.trial_ends_at) > now ? "write" : "read";
  if (org.billing_status === "past_due") return new Date(org.grace_ends_at) > now ? "manual" : "read";
  if (org.billing_status === "canceled") return new Date(org.current_period_end) > now ? "write" : "read";
  return "read";
}

export function planError(capability, used, limit, recommendedPlan, resetsAt = null) {
  return new HttpError(402, `Your plan includes ${limit} ${capability}. Upgrade to continue.`, {
    code: "plan_limit", capability, used, limit, recommendedPlan, resetsAt,
  });
}

export async function billingState(orgId) {
  const org = await one(`select * from organizations where id = $1`, [orgId]);
  const entitlements = effectiveEntitlements(org.plan_code, org.entitlement_overrides);
  const [brands, seats, actions] = await Promise.all([
    one(`select count(*)::int as n from workspaces where org_id = $1`, [orgId]),
    one(`select count(*)::int as n from memberships where org_id = $1`, [orgId]),
    one(`select coalesce(sum(n),0)::int as n from usage where org_id = $1 and kind = 'write' and at >= date_trunc('month', now())`, [orgId]),
  ]);
  return { org, mode: accessMode(org), entitlements, usage: { brands: brands.n, seats: seats.n, actionDrafts: actions.n } };
}

export async function requireMode(orgId, operation = "manual") {
  const state = await billingState(orgId);
  if (state.mode === "read" || (operation === "scheduled" && state.mode !== "write")) {
    throw new HttpError(402, "Your subscription is read-only. Choose a plan to continue.", { code: "billing_read_only" });
  }
  return state;
}

export async function auditBilling(orgId, userId, action, detail) {
  await q(`insert into audit_log (org_id, user_id, action, detail) values ($1,$2,$3,$4)`, [orgId, userId || null, action, detail || {}]);
}
```

- [ ] **Step 4: Run pure and full tests**

Run: `npm test`

Expected: PASS; DB-backed tests may remain skipped when `TEST_DATABASE_URL` is absent.

- [ ] **Step 5: Commit**

```bash
git add server/billing.mjs test/server/plans.test.mjs
git commit -m "feat(billing): resolve plan access"
```

## Task 4: Razorpay client and webhook verification

**Files:**
- Create: `server/razorpay.mjs`
- Create: `test/server/razorpay.test.mjs`

- [ ] **Step 1: Write failing signature and request tests**

```js
// test/server/razorpay.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { verifyWebhook, makeClient } from "../../server/razorpay.mjs";

test("verifyWebhook accepts only the raw body HMAC", () => {
  const body = Buffer.from('{"event":"subscription.activated"}');
  const signature = crypto.createHmac("sha256", "whsec").update(body).digest("hex");
  assert.equal(verifyWebhook(body, signature, "whsec"), true);
  assert.equal(verifyWebhook(Buffer.from(body + " "), signature, "whsec"), false);
});

test("client creates a subscription using the configured plan id", async () => {
  let seen;
  const client = makeClient({ keyId: "rzp_test_id", keySecret: "secret", fetch: async (url, init) => {
    seen = { url, init };
    return new Response(JSON.stringify({ id: "sub_1", status: "created" }), { status: 200 });
  }});
  const sub = await client.createSubscription({ planId: "plan_growth_usd", orgId: "org-1" });
  assert.equal(sub.id, "sub_1");
  assert.equal(JSON.parse(seen.init.body).plan_id, "plan_growth_usd");
  assert.match(seen.init.headers.authorization, /^Basic /);
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npm test -- --test-name-pattern='verifyWebhook|client creates'`

Expected: FAIL because `server/razorpay.mjs` is missing.

- [ ] **Step 3: Implement the narrow REST client**

```js
// server/razorpay.mjs
import crypto from "node:crypto";

export function verifyWebhook(raw, signature, secret) {
  if (!raw || !signature || !secret) return false;
  const expected = crypto.createHmac("sha256", secret).update(raw).digest("hex");
  const a = Buffer.from(expected); const b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function makeClient({ keyId, keySecret, fetch: doFetch = fetch }) {
  const auth = `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}`;
  async function request(method, path, body) {
    const r = await doFetch(`https://api.razorpay.com/v1${path}`, {
      method, headers: { authorization: auth, "content-type": "application/json" },
      body: body == null ? undefined : JSON.stringify(body),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Razorpay ${r.status}: ${data.error?.description || "request failed"}`);
    return data;
  }
  return {
    createSubscription: ({ planId, orgId }) => request("POST", "/subscriptions", { plan_id: planId, total_count: 120, quantity: 1, notes: { white_petal_org_id: orgId } }),
    cancelSubscription: (id) => request("POST", `/subscriptions/${encodeURIComponent(id)}/cancel`, { cancel_at_cycle_end: 1 }),
    fetchSubscription: (id) => request("GET", `/subscriptions/${encodeURIComponent(id)}`),
  };
}
```

- [ ] **Step 4: Run tests**

Run: `npm test -- --test-name-pattern='verifyWebhook|client creates'`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/razorpay.mjs test/server/razorpay.test.mjs
git commit -m "feat(billing): add Razorpay client"
```

## Task 5: Billing HTTP routes and idempotent lifecycle

**Files:**
- Create: `server/billing-routes.mjs`
- Modify: `server/routes.mjs`
- Modify: `test/server/api.test.mjs`

- [ ] **Step 1: Add failing API tests**

Add one integration test that proves:

```js
const plans = await call("anon", "GET", "/api/billing/plans");
assert.equal(plans.status, 200);
assert.equal(plans.data.plans.find((p) => p.code === "growth").prices.USD, 9900);
assert.equal((await call("b2", "GET", "/api/billing")).data.plan.code, "legacy");
assert.equal((await call("m1", "POST", "/api/billing/checkout", { plan: "enterprise", currency: "USD" })).status, 403);
assert.equal((await call("rahul", "POST", "/api/billing/checkout", { plan: "made-up", currency: "USD" })).status, 400);
```

Add a signed webhook fixture twice and assert only one `billing_events` row and
one state transition are recorded.

- [ ] **Step 2: Run the DB-backed test and confirm 404 failures**

Run: `TEST_DATABASE_URL=postgres://sathvik@127.0.0.1:5432/whitepetal_test npm test`

Expected: FAIL because the billing routes do not exist.

- [ ] **Step 3: Implement a route factory without introducing a circular import**

`server/billing-routes.mjs` must export:

```js
export function makeBillingRoutes({ needCtx }) {
  return [
    ["GET", "/api/billing/plans", getPlans],
    ["GET", "/api/billing", (req, res) => getBilling(req, res, needCtx)],
    ["POST", "/api/billing/checkout", (req, res) => checkout(req, res, needCtx)],
    ["POST", "/api/billing/change-plan", (req, res) => changePlan(req, res, needCtx)],
    ["POST", "/api/billing/cancel", (req, res) => cancel(req, res, needCtx)],
    ["POST", "/api/webhooks/razorpay", webhook],
  ];
}
```

Implementation requirements:

- `GET /plans` returns `publicPlans()` and `monthlyOnly: true`.
- Owner/admin is required for checkout and plan change; owner is required for cancellation.
- Only `starter`, `growth` and `agency` are self-serve.
- The server selects `RAZORPAY_PLAN_<PLAN>_<CURRENCY>`; the request cannot provide a plan ID or amount.
- Checkout creates/reuses a Razorpay customer only after the exact current API contract is verified against official Razorpay docs.
- Webhook reads `readBody(req, 512 * 1024)` once, verifies `x-razorpay-signature`, stores the event ID first and processes in one DB transaction.
- Store only event type, subscription/payment identifiers, notes, status and billing timestamps—not card/payment details.
- `subscription.activated` and a successful charged event activate access.
- pending/failed state creates a three-day grace period and pauses scheduled work.
- cancellation preserves the paid period; completed/canceled after period end becomes read-only.
- Ignore events that cannot be mapped to exactly one organisation.
- `BILLING_ENABLED=0` rejects checkout with a safe maintenance response;
  `BILLING_ENABLED=operators` permits only verified platform operators; and
  `BILLING_ENABLED=1` permits eligible organisation owners/admins.

In `server/routes.mjs`, import `makeBillingRoutes` and compose it at the start of
the exported `ROUTES` array so the webhook is handled before the generic API
fallback.

- [ ] **Step 4: Run all tests**

Run: `TEST_DATABASE_URL=postgres://sathvik@127.0.0.1:5432/whitepetal_test npm test`

Expected: PASS including duplicate-webhook and tenant-isolation assertions.

- [ ] **Step 5: Commit**

```bash
git add server/billing-routes.mjs server/routes.mjs test/server/api.test.mjs
git commit -m "feat(billing): add subscription routes"
```

## Task 6: Enforce plan limits at every cost boundary

**Files:**
- Modify: `server/billing.mjs`
- Modify: `server/routes.mjs`
- Modify: `server/app.mjs`
- Modify: `server/orgs.mjs`
- Modify: `test/server/api.test.mjs`

- [ ] **Step 1: Write failing integration cases for each boundary**

Create a Starter organisation in SQL and assert:

```js
assert.equal((await call("starter", "PUT", "/api/workspaces/second", { name: "Second", site: "https://second.example", setup: WS.setup })).data.code, "plan_limit");
assert.equal((await call("starter", "PATCH", "/api/workspaces/first", { schedule: "daily" })).data.capability, "schedule");
assert.equal((await call("starter", "PATCH", "/api/workspaces/first", { samples: 2 })).data.capability, "samples");
assert.equal((await call("starter", "POST", "/api/org/invitations", { email: "seat2@x.co", role: "viewer" })).data.capability, "seats");
assert.equal((await call("starter", "PUT", "/api/workspaces/first/integrations/google", { property: "x" })).data.capability, "integrations");
```

Also test question count, engine allowlist, action-draft monthly count,
read-only manual AI calls, grace manual access, grace scheduled denial and
legacy unrestricted behavior.

Test trial creation explicitly: a new email/password personal organisation is
`trial/trialing` but cannot spend until email verification starts its seven-day
clock; a verified Google signup starts immediately; operator-created client
organisations remain `legacy/internal` until assigned a contract or plan.

- [ ] **Step 2: Run and confirm limits are not enforced**

Run: `TEST_DATABASE_URL=postgres://sathvik@127.0.0.1:5432/whitepetal_test npm test`

Expected: FAIL because the protected operations currently succeed.

- [ ] **Step 3: Add focused assertion helpers**

Add these helpers to `server/billing.mjs`, using current DB counts plus
`effectiveEntitlements()`:

```js
const nextPlan = (code) => ({ trial: "starter", starter: "growth", growth: "agency", agency: "enterprise" }[code] || "enterprise");
const activeQuestions = (setup) => (setup?.questions || []).filter((x) => x.on !== false);

export async function assertBrandCreate(orgId) {
  const state = await requireMode(orgId);
  if (state.usage.brands >= state.entitlements.brands) throw planError("brands", state.usage.brands, state.entitlements.brands, nextPlan(state.org.plan_code));
  return state;
}

export async function assertWorkspaceSetup(orgId, setup) {
  const state = await requireMode(orgId);
  const questions = activeQuestions(setup).length;
  const competitors = (setup?.profile?.competitors || []).length;
  const engines = setup?.engines || [];
  if (questions > state.entitlements.questions) throw planError("questions", questions, state.entitlements.questions, nextPlan(state.org.plan_code));
  if (competitors > state.entitlements.competitorsPerBrand) throw planError("competitors", competitors, state.entitlements.competitorsPerBrand, nextPlan(state.org.plan_code));
  const blocked = engines.find((x) => !state.entitlements.engines.includes(x));
  if (blocked) throw planError("engines", engines.length, state.entitlements.engines.length, nextPlan(state.org.plan_code));
  return state;
}

export async function assertSchedule(orgId, schedule, samples) {
  const state = await requireMode(orgId);
  if (!state.entitlements.schedule.includes(schedule)) throw planError("schedule", schedule, state.entitlements.schedule.join(" or "), nextPlan(state.org.plan_code));
  if (samples > state.entitlements.samples) throw planError("samples", samples, state.entitlements.samples, nextPlan(state.org.plan_code));
  return state;
}

export async function assertSeatInvite(orgId) {
  const state = await requireMode(orgId);
  if (state.usage.seats >= state.entitlements.seats) throw planError("seats", state.usage.seats, state.entitlements.seats, nextPlan(state.org.plan_code));
  return state;
}

export async function assertIntegration(orgId, provider) {
  const state = await requireMode(orgId);
  const allowed = state.entitlements.integrations === "all" || state.entitlements.integrations.includes(provider);
  if (!allowed) throw planError("integrations", provider, state.entitlements.integrations.length, nextPlan(state.org.plan_code));
  return state;
}

export async function assertAi(orgId, { kind, engine, scheduled = false }) {
  const state = await requireMode(orgId, scheduled ? "scheduled" : "manual");
  if (engine && !state.entitlements.engines.includes(engine)) throw planError("engines", engine, state.entitlements.engines.length, nextPlan(state.org.plan_code));
  if (kind === "write" && state.usage.actionDrafts >= state.entitlements.actionDrafts) throw planError("actionDrafts", state.usage.actionDrafts, state.entitlements.actionDrafts, nextPlan(state.org.plan_code));
  return state;
}

export async function billingSummary(orgId) {
  const state = await billingState(orgId);
  return {
    plan: { code: state.org.plan_code, status: state.org.billing_status, currency: state.org.billing_currency },
    mode: state.mode,
    period: { start: state.org.current_period_start, end: state.org.current_period_end, trialEndsAt: state.org.trial_ends_at, graceEndsAt: state.org.grace_ends_at },
    entitlements: state.entitlements,
    usage: state.usage,
  };
}
```

- [ ] **Step 4: Wire every enforcement point**

- `server/routes.mjs`: before workspace insert/update, schedule/sample update,
  invite creation and integration save/collect.
- `server/app.mjs:57-80`: after organisation context and before reading/forwarding
  an expensive AI call, call `assertAi` using `kind` and `engine`.
- `server/routes.mjs:164-220`: scheduler must require scheduled write mode and
  skip with audited reason `billing_read_only` or `plan_limit`.
- `server/orgs.mjs`: include billing usage in the existing organisation usage
  response without exposing payment identifiers to viewers.
- `server/app.mjs:84-95`: include a safe billing summary in `/api/config`.
- Signup and verification routes: mark only new self-serve personal
  organisations as `trial/trialing`; set `trial_started_at=now()` and
  `trial_ends_at=now()+interval '7 days'` only after verified email or verified
  Google identity. `assertAi` rejects an unstarted trial with
  `email_verification_required`.
- `server/routes.mjs:164-220`: for `schedule='rotating'`, run five active
  questions from `rotation_cursor` each day, advance the cursor transactionally,
  and perform a full run whenever `last_full_run_at` is null or seven days old.
  Growth and Agency permit `rotating`; Enterprise also permits full `daily`.
- Run-history responses: trim the visible trend window to 6, 12 or 24 months
  for Starter, Growth or Agency while leaving stored evidence intact.

- [ ] **Step 5: Run full server verification**

Run:

```bash
find api server public -type f \( -name '*.js' -o -name '*.mjs' \) -print0 | xargs -0 -n1 node --check
TEST_DATABASE_URL=postgres://sathvik@127.0.0.1:5432/whitepetal_test npm test
```

Expected: syntax checks and all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add server/billing.mjs server/routes.mjs server/app.mjs server/orgs.mjs test/server/api.test.mjs
git commit -m "feat(billing): enforce plan limits"
```

## Task 7: White Petal Billing & usage interface

**Files:**
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `public/app.css`
- Modify: `test/e2e/flow.py`

- [ ] **Step 1: Extend the browser flow with failing billing assertions**

In `test/e2e/flow.py`, after sign-in, assert the page exposes a Billing & usage
entry, the current plan, usage meters and a locked-action explanation. For a
test Starter organisation, attempt a second brand and assert the UI says:
`Starter includes 1 brand. Upgrade to Growth to continue.`

- [ ] **Step 2: Run the browser flow and confirm failure**

Run: `TEST_DATABASE_URL=postgres://sathvik@127.0.0.1:5432/whitepetal_test python3 test/e2e/flow.py`

Expected: FAIL because Billing & usage is absent.

- [ ] **Step 3: Add the billing page and checkout state**

Add `Billing & usage` beside Settings in `public/index.html`. In `public/app.js`:

```js
Object.assign(PAGES, { billing: ["Organisation", "Billing & usage"] });

function billingMeter(label, used, limit) {
  const pct = Number.isFinite(limit) && limit > 0 ? Math.min(100, Math.round(100 * used / limit)) : 0;
  return `<div class="bill-meter"><div><b>${esc(label)}</b><span>${used} / ${Number.isFinite(limit) ? limit : "Unlimited"}</span></div><i><b style="width:${pct}%"></b></i></div>`;
}
```

The page must render current plan/status, trial or renewal date, brands,
questions, drafts and seats, and plan cards from `/api/billing/plans`. Only an
owner/admin sees checkout; only an owner sees cancel. Read-only banners keep
links to historical reports.

Load Razorpay Checkout only when the user explicitly starts checkout. Send only
the server-created subscription/order identifiers and public key ID to Checkout.
After the browser success callback, render `Confirming payment…`; poll
`GET /api/billing` until a signed webhook reports active or a bounded timeout
shows a support-safe message. Never set local active state from the callback.

- [ ] **Step 4: Mirror locks in existing controls**

- Hide no core reports.
- Disable or annotate New brand, daily schedule, samples above the plan,
  unsupported integrations, extra engines, invites and generation buttons.
- Centralize rendering of `plan_limit` and `billing_read_only` API errors so all
  actions show the same plan, limit and upgrade path.
- Preserve an incoming `?plan=<code>&currency=<USD|INR>` through authentication
  and open Billing after login.

- [ ] **Step 5: Add responsive styles and update the cache-busting asset query**

Create styles for `.billing-grid`, `.billing-card`, `.billing-current`,
`.bill-meter`, `.plan-lock` and `.billing-banner`. Ensure a 320 px viewport has
no horizontal page scroll and that keyboard focus is visible.

- [ ] **Step 6: Run syntax, server and browser tests**

Run:

```bash
node --check public/app.js
TEST_DATABASE_URL=postgres://sathvik@127.0.0.1:5432/whitepetal_test npm test
TEST_DATABASE_URL=postgres://sathvik@127.0.0.1:5432/whitepetal_test python3 test/e2e/flow.py
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add public/index.html public/app.js public/app.css test/e2e/flow.py
git commit -m "feat(billing): add plan usage UI"
```

## Task 8: Secrets, environment and deployment configuration

**Files:**
- Modify: `server/env.mjs`
- Modify: `.env.example`
- Modify: `infra/terraform/secrets.tf`
- Modify: `infra/secrets.sh`
- Modify: `test/server/security.test.mjs`

- [ ] **Step 1: Write a failing environment contract test**

Assert `SECRET_NAMES` contains exactly the three billing secrets once:

```js
for (const key of ["RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET", "RAZORPAY_WEBHOOK_SECRET"]) {
  assert.equal(SECRET_NAMES.filter((x) => x === key).length, 1);
}
```

- [ ] **Step 2: Run the test and confirm failure**

Run: `npm test -- --test-name-pattern='billing secrets'`

Expected: FAIL because the keys are absent.

- [ ] **Step 3: Add secret and non-secret configuration**

Add to `SECRET_NAMES`, Terraform `local.secret_names`, and `infra/secrets.sh`:

```text
RAZORPAY_KEY_ID
RAZORPAY_KEY_SECRET
RAZORPAY_WEBHOOK_SECRET
```

Document these non-secret plan-ID variables in `.env.example` and pass them to
Cloud Run through Terraform variables/environment configuration:

```text
RAZORPAY_PLAN_STARTER_USD=
RAZORPAY_PLAN_STARTER_INR=
RAZORPAY_PLAN_GROWTH_USD=
RAZORPAY_PLAN_GROWTH_INR=
RAZORPAY_PLAN_AGENCY_USD=
RAZORPAY_PLAN_AGENCY_INR=
BILLING_ENABLED=0
```

Do not create secret versions for empty values.

- [ ] **Step 4: Run tests and Terraform formatting/validation**

Run:

```bash
npm test
terraform -chdir=infra/terraform fmt -check
terraform -chdir=infra/terraform validate
```

Expected: PASS. If Terraform cannot initialize without remote credentials, run
`terraform fmt -check` locally and let CI/bootstrap perform validation in the
configured environment; record that limitation in the runbook.

- [ ] **Step 5: Commit**

```bash
git add server/env.mjs .env.example infra/terraform/secrets.tf infra/secrets.sh infra/terraform test/server/security.test.mjs
git commit -m "chore(billing): configure Razorpay secrets"
```

## Task 9: Bloom plan contract and pricing content

**Files:**
- Create: `src/lib/billing-plans.ts`
- Create: `test/billing-plans.test.ts`
- Modify: `src/lib/bloom-content.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Add the TypeScript test runner and failing plan tests**

Run: `npm install --save-dev tsx`

Add `"test": "tsx --test test/**/*.test.ts"` to `package.json`, then create:

```ts
// test/billing-plans.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { marketingPlans, checkoutUrl } from "../src/lib/billing-plans";

test("Bloom publishes the approved monthly prices", () => {
  assert.deepEqual(marketingPlans.map((p) => [p.code, p.usd, p.inr]), [
    ["starter", 49, 4999], ["growth", 99, 9999],
    ["agency", 249, 24999], ["enterprise", 999, 99999],
  ]);
});

test("checkout URL contains only plan and currency hints", () => {
  assert.equal(checkoutUrl("growth", "INR"), "https://apps.perfstaq.com/?plan=growth&currency=INR");
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npm test`

Expected: FAIL because `src/lib/billing-plans.ts` is missing.

- [ ] **Step 3: Implement the typed marketing snapshot**

Create `src/lib/billing-plans.ts` with the four prices, the approved short
feature lists, `featured: true` only for Growth, and:

```ts
export type BillingCurrency = "USD" | "INR";
export type SelfServePlan = "starter" | "growth" | "agency";

export function checkoutUrl(plan: SelfServePlan, currency: BillingCurrency) {
  const url = new URL("https://apps.perfstaq.com/");
  url.searchParams.set("plan", plan);
  url.searchParams.set("currency", currency);
  return url.toString();
}
```

Refactor `bloom-content.ts` to consume this snapshot. Remove Solo, annual
pricing, “two months free,” Studio credits and bundled strategist copy.

- [ ] **Step 4: Run unit test, lint and build**

Run:

```bash
npm test
npm run lint
npm run build
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json src/lib/billing-plans.ts src/lib/bloom-content.ts test/billing-plans.test.ts
git commit -m "feat(pricing): define paid plan contract"
```

## Task 10: Bloom pricing and CTA experience

**Files:**
- Modify: `src/components/bloom/Pricing.tsx`
- Modify: `src/components/bloom/Hero.tsx`
- Modify: `src/components/bloom/Nav.tsx`
- Modify: `src/components/bloom/Closing.tsx`
- Modify: `src/app/globals.css`

- [ ] **Step 1: Add a failing rendered-content test**

Extend `test/billing-plans.test.ts` to read the pricing source and assert there
is no annual toggle or Studio-credit promise, Growth is the featured plan, and
each self-serve CTA uses `checkoutUrl`.

- [ ] **Step 2: Run and confirm the old copy fails**

Run: `npm test`

Expected: FAIL on annual/Studio copy.

- [ ] **Step 3: Implement the monthly-only plan cards and comparison**

- Keep automatic India timezone detection and manual `US$` / `₹ India` switch.
- Render Starter, Growth, Agency and Enterprise with the approved prices.
- Add the detailed differentiation rows from the design: brands, questions,
  engines, schedule, seats, action drafts, integrations, reports, white label
  and API.
- Use semantic table markup on desktop and labelled stacked rows on mobile.
- Starter/Growth/Agency link to `checkoutUrl`; Enterprise links to sales.
- State that GST is added for INR and that monthly billing is cancel-anytime.
- State that Enterprise software and managed service are separate.

- [ ] **Step 4: Update every trial CTA**

Hero, navigation and closing CTAs must target Growth trial consistently. Login
continues to use the plain app URL.

- [ ] **Step 5: Verify test, lint, build and responsive UI**

Run:

```bash
npm test
npm run lint
npm run build
PATH=/Users/sathvik/.nvm/versions/node/v22.22.0/bin:$PATH npm run dev -- --port 3100
```

In the browser verify `/#pricing` at desktop and 320 px widths, USD and INR,
keyboard navigation, CTA URLs and no console errors.

Expected: all commands PASS and the four plans remain readable without
horizontal page scroll.

- [ ] **Step 6: Commit**

```bash
git add src/components/bloom src/app/globals.css test/billing-plans.test.ts
git commit -m "feat(pricing): launch usage-backed plans"
```

## Task 11: Test-mode end-to-end billing lifecycle

**Files:**
- Modify: `test/server/api.test.mjs`
- Modify: `test/e2e/flow.py`
- Create: `docs/razorpay-runbook.md`

- [ ] **Step 1: Document the exact test-mode setup**

The runbook must include:

- creation of six monthly Razorpay test plans (three tiers × USD/INR);
- test key, webhook secret and plan-ID environment mapping;
- webhook URL `/api/webhooks/razorpay`;
- subscribed events verified against current official Razorpay docs;
- local forwarding method that preserves the raw request body;
- test cases for success, duplicate webhook, failed renewal, cancellation,
  upgrade, downgrade and delayed webhook; and
- commands that print only whether each secret is set, never its value.

- [ ] **Step 2: Add a deterministic fake-Razorpay lifecycle test**

Use dependency injection in `server/razorpay.mjs` so automated tests cover the
entire lifecycle without the network. Assert browser callback alone leaves the
plan unchanged; only the signed event activates it.

- [ ] **Step 3: Run all automated gates in both repositories**

White Petal:

```bash
find api server public -type f \( -name '*.js' -o -name '*.mjs' \) -print0 | xargs -0 -n1 node --check
TEST_DATABASE_URL=postgres://sathvik@127.0.0.1:5432/whitepetal_test npm test
```

Bloom:

```bash
npm test
npm run lint
npm run build
```

Expected: PASS.

- [ ] **Step 4: Perform a real Razorpay test-mode checkout**

With user-provided test credentials, buy Growth INR and verify:

1. Checkout shows ₹9,999 plus the correct tax treatment.
2. White Petal stays “Confirming” after browser callback.
3. Signed webhook changes the organisation to `growth/active`.
4. Usage limits update without a reload race.
5. A repeated webhook changes nothing.
6. Cancellation preserves access to period end.

- [ ] **Step 5: Commit**

```bash
git add test/server/api.test.mjs test/e2e/flow.py docs/razorpay-runbook.md
git commit -m "test(billing): cover subscription lifecycle"
```

## Task 12: Production-ready cost and operator controls

**Files:**
- Modify: `server/billing.mjs`
- Modify: `server/billing-routes.mjs`
- Modify: `server/routes.mjs`
- Modify: `public/app.js`
- Modify: `test/server/api.test.mjs`
- Modify: `README.md`

- [ ] **Step 1: Add failing override and reconciliation tests**

Assert only a verified platform operator can set an entitlement override; every
override includes reason and expiry; the audit log contains before/after; and a
reconciliation pass repairs a deliberately stale local subscription from a
fake Razorpay response.

- [ ] **Step 2: Implement audited expiring overrides**

Add an operator-only route accepting:

```json
{
  "plan": "enterprise",
  "overrides": { "questions": 600, "brands": 30 },
  "reason": "Signed enterprise order WP-2026-001",
  "expiresAt": "2027-10-10T00:00:00Z"
}
```

Reject missing reason, past expiry, unknown entitlement keys and non-operator
requests. Expired overrides must stop applying automatically.

- [ ] **Step 3: Add periodic reconciliation**

The existing cron tick must reconcile a bounded batch of active/past-due
subscriptions no more than once daily. It fetches Razorpay state, advances only
to a newer verified billing event/time, records drift in `billing_events`, and
never shortens a locally valid paid period from an older response.

- [ ] **Step 4: Add the 90-day founder cost view**

Extend the operator organisations table with plan, status, subscription revenue,
estimated direct cost, cost percentage and gross-margin percentage. Use current
`usage.cost_usd`, allocated infrastructure/payment reserves and clearly label
them estimates; Razorpay/provider invoices remain authoritative.

- [ ] **Step 5: Run all White Petal gates**

Run syntax checks, DB-backed tests and the browser flow. Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server public test/server/api.test.mjs README.md
git commit -m "feat(billing): add operator safeguards"
```

## Task 13: Credential-gated production rollout

**Files:**
- Modify only if verification finds a real defect.

- [ ] **Step 1: Confirm external prerequisites without exposing secrets**

The user provides/configures:

- live `RAZORPAY_KEY_ID`;
- live `RAZORPAY_KEY_SECRET`;
- live `RAZORPAY_WEBHOOK_SECRET`;
- six live plan IDs; and
- confirmation that Razorpay KYC, international cards and recurring payments
  are approved.

Report only set/unset state and safe IDs; never print secrets.

- [ ] **Step 2: Deploy White Petal with billing disabled**

Merge/push through the existing CI deployment. Verify `/api/health` reports
`ok:true` and `db:true`, migration 003 is applied, and legacy organisations
remain writable.

- [ ] **Step 3: Configure webhook and run one live low-risk verification**

Register the production webhook URL and verify its signed delivery. Use the
smallest approved real transaction only after the user confirms the financial
action at action time. Verify settlement/tax details in Razorpay.

- [ ] **Step 4: Enable operator-only billing**

Set `BILLING_ENABLED=operators`, deploy, complete Starter and Growth lifecycle
checks, and verify no non-operator can start checkout.

- [ ] **Step 5: Deploy Bloom pricing**

Deploy the Bloom branch, verify live USD/INR prices and CTA parameters, and
confirm the White Petal server rejects altered plan/amount parameters.

- [ ] **Step 6: Enable self-serve billing**

Set `BILLING_ENABLED=1`, deploy White Petal, create a new trial account, and
verify trial limits, payment activation, read-only expiry behavior and scheduled
cost blocking.

- [ ] **Step 7: Record release evidence**

Record commit SHAs, Cloud Run revision, landing deployment ID, migration state,
test outputs, webhook event ID, safe plan IDs and rollback commands in the
runbook. Do not record secrets or card/payment data.

## Final verification checklist

- [ ] White Petal syntax checks pass.
- [ ] White Petal unit and PostgreSQL integration tests pass.
- [ ] White Petal browser flow passes on desktop and mobile.
- [ ] Bloom unit tests, lint and production build pass.
- [ ] Razorpay test-mode lifecycle passes end to end.
- [ ] Existing organisations remain `legacy/internal` until migrated.
- [ ] Browser callback alone cannot grant access.
- [ ] Duplicate/out-of-order webhooks are safe.
- [ ] Trial, active, grace, canceled and expired states match the design.
- [ ] Server routes and scheduler enforce every paid limit.
- [ ] Live checkout remains disabled until credentials and approvals are verified.
- [ ] Bloom and White Petal prices/features match.
- [ ] Production health, public reachability and rollback path are verified.
