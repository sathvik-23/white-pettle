# White Petal usage-backed plans and Razorpay billing

Date: 10 October 2026  
Status: Approved design; implementation has not started

## 1. Objective

Launch sustainable paid White Petal subscriptions across two repositories:

- White Petal application: `/Users/sathvik/Desktop/white-pettle/white-petal-app`
- Bloom landing page: `/Users/sathvik/Desktop/perfstaq-app/perfstaq-landing`
- Bloom branch: `feat/perfstaq-bloom-landing`

The system must:

1. sell four usage-backed plans through Razorpay;
2. keep direct cost of service at or below 30% of subscription revenue;
3. enforce every paid entitlement on the White Petal server;
4. explain locked features clearly in the interface;
5. keep reports readable after a trial, cancellation, or payment failure;
6. deploy without accidentally locking existing production organisations; and
7. avoid advertising capabilities that White Petal does not yet implement.

Gross margin in this specification means subscription revenue less direct
payment, AI, infrastructure, storage, transactional email, support, refund and
chargeback costs. It does not mean a 70% net margin after salaries, sales,
marketing and general company expenses.

## 2. Commercial decisions

White Petal launches globally with canonical USD pricing. Visitors in India
see INR pricing automatically and pay INR plus applicable GST. Customers may
manually switch currency on the landing page.

| Plan | USD per month | INR per month | Positioning |
|---|---:|---:|---|
| Starter | $49 | ₹4,999 + GST | Founder or small business proving AI visibility |
| Growth | $99 | ₹9,999 + GST | Growing brand operating a repeatable visibility loop |
| Agency | $249 | ₹24,999 + GST | Agency or consultant managing clients |
| Enterprise | From $999 | From ₹99,999 + GST | Large brands and groups with negotiated limits |

Additional decisions:

- Monthly billing only for the first 90 days.
- Annual billing and discounts are not launched until actual per-plan usage is
  measured. The Bloom promise of two months free must be removed for launch.
- Enterprise software starts at $999. Human-managed GEO/strategy work is a
  separate contract starting at $2,500 per month or a higher scoped quote.
- Enterprise may use invoicing rather than self-serve subscription checkout.
- Taxes are added to the listed price where required; they are not treated as
  White Petal revenue.
- The application never handles or stores raw card data. Razorpay Checkout
  collects payment details.

## 3. Plan entitlements

All paid plans receive the core evidence product: visibility metrics, prompt
answers, competitor comparison, cited sources, gap analysis and perception.
Plans primarily differ on cost-driving usage and collaboration capabilities.

| Entitlement | Starter | Growth | Agency | Enterprise |
|---|---:|---:|---:|---:|
| Active brands | 1 | 1 | 5 | Contract |
| Active tracked questions | 15 | 30 | 100 pooled | 300+ / contract |
| Tracked competitors | 3 | 5 | 5 per brand | Contract |
| Full scheduled re-check | Weekly | Weekly | Weekly | Daily or contract |
| Daily monitoring | None | Rotating priority subset | Rotating pooled subset | Full or contract |
| AI engines | ChatGPT, Perplexity, Gemini | All enabled engines | All enabled engines | Contract/all |
| Samples per question | 1 | 1 | 1 | Up to 3 by contract |
| Organisation seats | 1 | 5 | 20 | Contract |
| Generated action drafts | 10/month | 30/month | 100 pooled/month | Contract |
| Integrations | Basic | GSC, GA4, Bing, Cloudflare | All supported | All + custom |
| Report schedule | Monthly | Weekly | Weekly client reports | Contract |
| White-labelled reports | No | No | Yes | Yes |
| Team roles and invitations | No | Yes | Yes | Yes/custom |
| API access | No | No | Export/limited | Contract |
| Visible trend window | 6 months | 12 months | 24 months | Contract |
| Support | Email | Priority email | Priority onboarding | SLA/account owner |

“All enabled engines” means engines that are truly connected and operational in
White Petal. It must not imply unsupported models. A rotating daily subset
checks selected priority questions; it does not run every question on every
engine every day.

Studio credits do not launch as a White Petal entitlement. The current White
Petal repository has action drafting but no production Studio-credit ledger or
verified Perfstaq Studio connection. Bloom must replace Studio-credit promises
with the action-draft limits above until that integration exists.

## 4. Trial and free-check policy

The public landing-page free check remains separate from a paid organisation.

New verified organisations receive a seven-day Growth trial with:

- one brand;
- ten tracked questions;
- ChatGPT, Perplexity and Gemini;
- one baseline analysis and one re-check;
- no recurring daily monitoring;
- no automated integrations or white-label output; and
- an acquisition-cost target below $3–$5 per verified organisation.

No card is required. At expiry, historical results stay readable and new
checks, drafts, exports and scheduled jobs are locked. Trial creation must be
rate-limited and tied to a verified email address. The server, not local browser
state, determines whether a trial is available or exhausted.

## 5. Margin model and safeguards

The planning model reserves 5% of revenue for Razorpay and related payment
costs. Each plan also receives explicit AI, infrastructure and service budgets.

| Plan | Revenue | Payment reserve | AI allowance | Infra/data | Support/refund reserve | Planned margin |
|---|---:|---:|---:|---:|---:|---:|
| Starter | $49 | $2.45 | $5 | $1 | $4 | 74.6% |
| Growth | $99 | $4.95 | $14 | $2 | $7 | 71.8% |
| Agency | $249 | $12.45 | $38 | $5 | $17 | 70.9% |
| Enterprise | $999+ | At most 5% | Contract | Contract | Contract | At least 70% |

Safeguards:

- Every expensive server operation records cost and usage against an
  organisation, brand and billing period.
- Limits are checked before work is queued and again by scheduled workers.
- A monthly plan may not silently spend beyond its included allowance.
- When a limit is reached, the server returns a structured `plan_limit`
  response and the interface offers the appropriate upgrade.
- No automatic overage billing launches in version one. This prevents surprise
  bills and keeps reconciliation simple.
- Platform operators can inspect usage and grant a dated, audited override.
- Enterprise entitlements are contract-specific and must still respect the 30%
  maximum direct-cost rule.
- The first 90 days must compare forecast cost with actual Razorpay, AI and
  cloud invoices before annual plans or higher limits are offered.

## 6. Billing state and data model

Billing belongs to an organisation, not an individual user or brand. This
matches White Petal's existing organisation, membership, usage and audit model.

Add billing fields to `organizations` through a numbered SQL migration:

- `plan_code`: `legacy`, `trial`, `starter`, `growth`, `agency`, `enterprise`;
- `billing_status`: `internal`, `trialing`, `active`, `past_due`, `canceled`,
  `paused`;
- `billing_currency`: `USD` or `INR`;
- `razorpay_customer_id`;
- `razorpay_subscription_id`;
- `trial_started_at` and `trial_ends_at`;
- `current_period_start` and `current_period_end`;
- `grace_ends_at`;
- `pending_plan_code` for a scheduled downgrade;
- `entitlement_overrides` JSONB for enterprise contracts and temporary operator
  exceptions; and
- timestamps for the most recent verified billing event.

Add a `billing_events` table containing the Razorpay event ID, type, received
time, processing status, organisation, non-secret payload subset and error.
The unique event ID makes webhook processing idempotent.

Add period-based counters only where the existing `usage` table cannot answer
the limit efficiently. Counters must be derived from or reconcilable with an
append-only usage record; a mutable counter must not be the only source of
truth.

Existing production organisations migrate to `legacy/internal`, retaining
their current access. They are not automatically converted to expired trials.
Operators migrate them deliberately after launch.

## 7. Entitlement service

Create one server-side plan registry and one entitlement service. Both the UI
and routes read the same public plan description, but only the server makes
authorization decisions.

Responsibilities:

- resolve effective plan, status, billing period and overrides;
- calculate remaining brands, questions, seats, runs and action drafts;
- expose a safe `/api/billing` view for the signed-in organisation;
- assert an entitlement before any protected mutation or AI call;
- return consistent errors containing the limit, current use, reset date and
  recommended plan; and
- write an audit event for subscription changes, limit blocks and operator
  overrides.

Enforcement points include:

- creating or moving a brand;
- activating tracked questions or competitors;
- selecting engines or samples;
- changing a schedule;
- running or queueing an analysis;
- scheduled cron selection and execution;
- generating pages, rewrites and outreach pitches;
- inviting a member or changing plan-restricted roles;
- connecting plan-restricted integrations;
- exporting or white-labelling reports; and
- API access.

The UI mirrors these checks with disabled controls, remaining-usage labels and
an upgrade explanation. Hiding a control is never considered enforcement.

## 8. Razorpay integration

The application uses Razorpay Subscriptions and hosted Checkout.

Server endpoints:

- `GET /api/billing/plans`: public, safe plan catalogue and currency prices;
- `GET /api/billing`: current organisation plan, state and usage;
- `POST /api/billing/checkout`: authenticated owner/admin creates or resumes a
  subscription checkout for an allowed plan and currency;
- `POST /api/billing/cancel`: owner requests cancellation at period end;
- `POST /api/billing/change-plan`: upgrade or schedule downgrade; and
- `POST /api/webhooks/razorpay`: raw-body webhook receiver with signature
  verification and idempotent processing.

Checkout flow:

1. Bloom links to White Petal with `plan` and `currency` query parameters.
2. White Petal preserves the selection through sign-up or login.
3. An authenticated organisation owner confirms plan, currency, price and tax
   treatment.
4. The server maps the selection to an environment-configured Razorpay plan ID
   and creates the subscription/order. Browser input never supplies an
   arbitrary amount or Razorpay plan ID.
5. Razorpay Checkout collects payment details.
6. Checkout completion is shown as “confirming” until a signed webhook marks
   the subscription active. A browser success callback alone never unlocks the
   plan.

Lifecycle rules:

- Successful first payment activates the selected plan.
- A paid upgrade activates only after Razorpay confirms payment.
- A downgrade is scheduled for the next billing period.
- Cancellation keeps access through `current_period_end`.
- Failed renewal enters `past_due` with a three-day grace period.
- During grace, manual use remains available but new scheduled work is paused
  to contain cost.
- After grace, the organisation becomes read-only.
- Duplicate or out-of-order webhook events must not shorten a valid paid
  period or grant unverified access.
- Exact webhook event names and subscription-change parameters must be checked
  against Razorpay's current official API documentation during implementation.

## 9. Configuration and credentials

No secrets are committed. Test and live values use separate environments and
Razorpay accounts/modes.

Required secret values:

- `RAZORPAY_KEY_ID`;
- `RAZORPAY_KEY_SECRET`;
- `RAZORPAY_WEBHOOK_SECRET`.

Required non-secret configuration:

- Razorpay plan IDs for Starter, Growth and Agency in USD and INR;
- public origin and allowed checkout return origin;
- trial duration and grace duration; and
- optional enterprise sales/contact URL.

Before live international checkout is enabled, the Razorpay account must have
completed KYC and must be approved for the required international and recurring
payment methods. The implementation must not infer approval from possession of
API keys.

## 10. Landing-page changes

The Bloom landing page becomes a truthful presentation of the same plan
catalogue:

- Starter $49 / ₹4,999;
- Growth $99 / ₹9,999 and marked “Most popular”;
- Agency $249 / ₹24,999;
- Enterprise from $999 / ₹99,999;
- monthly-only toggle at launch;
- automatic India detection with a manual USD/INR switch;
- feature copy matching the entitlement matrix;
- no two-month annual discount;
- no unimplemented Studio-credit promise;
- managed service clearly separated from Enterprise software; and
- CTA links containing only validated plan/currency choices.

The landing page may keep a marketing-friendly subset of features, but a
detailed comparison section must be available. White Petal remains the source
of truth for checkout amounts and entitlements; landing-page values cannot
authorize a purchase.

## 11. White Petal interface changes

Add a Billing and usage view under organisation settings showing:

- current plan and status;
- trial, renewal, cancellation or grace date;
- usage against brands, questions, checks, drafts and seats;
- plan comparison and upgrade action;
- cancel/downgrade controls for owners;
- payment-confirmation and webhook-delay states; and
- concise invoice/payment links supplied by Razorpay where available.

Locked actions remain visible where useful. The interface explains the current
limit and which plan unlocks the action. Historical reports remain readable in
read-only states.

Platform operators receive a small audited control for legacy migration,
enterprise overrides and support recovery. Operators cannot mark an unpaid
self-serve subscription active without an explicit, expiring override reason.

## 12. Error handling and security

- Verify Razorpay webhook signatures against the unmodified raw request body.
- Treat all checkout callbacks and query parameters as untrusted hints.
- Use server-side price and plan mappings only.
- Process webhooks transactionally and idempotently.
- Redact secrets, card details and full payment payloads from logs and audit
  records.
- Rate-limit checkout creation and webhook failures.
- Return safe, structured billing errors to the browser.
- Alert operators when webhook processing repeatedly fails.
- Reconcile active subscriptions with Razorpay periodically so a missed
  webhook cannot create permanent drift.
- Preserve tenant isolation in every billing and entitlement query.

## 13. Testing

Unit tests:

- plan registry and margin/limit constants;
- effective entitlement resolution and overrides;
- trial, active, grace, canceled and read-only transitions;
- usage reset boundaries;
- upgrade/downgrade decisions; and
- webhook signature and idempotency helpers.

Database/API integration tests:

- migration of existing organisations to `legacy/internal`;
- checkout authorization and server-side plan mapping;
- one organisation cannot inspect or change another's billing;
- every enforcement point rejects usage above its limit;
- scheduled checks skip ineligible organisations without spending AI budget;
- cancellation and payment failure preserve readable reports;
- duplicate and out-of-order webhooks are harmless; and
- operator overrides are expiring and audited.

Browser tests:

- Bloom USD/INR presentation and correct CTA parameters;
- selected plan survives authentication;
- Razorpay test-mode checkout opens with the correct amount;
- confirming, active, past-due and read-only interfaces;
- locked-feature upgrade messaging; and
- mobile and desktop pricing layouts.

Production verification:

- test-mode end-to-end payment before live keys;
- signed webhook received on the production-style endpoint;
- successful payment activates exactly one organisation;
- cancellation and a simulated failed renewal follow policy;
- Cloud Run health, logs and database migrations remain healthy; and
- live landing-page prices match White Petal's server catalogue.

## 14. Rollout

1. Build migrations, plan registry and entitlement checks behind a disabled
   billing flag.
2. Add billing UI and landing-page pricing without enabling live checkout.
3. Configure Razorpay test credentials and plan IDs.
4. Run automated and manual test-mode lifecycle tests.
5. Deploy entitlement code with all existing organisations on legacy access.
6. Enable test checkout in production only for platform operators.
7. Configure and verify live credentials and webhooks.
8. Enable self-serve checkout for new organisations.
9. Review actual direct costs weekly for the first 90 days.
10. Change limits or pricing before adding annual billing if any plan trends
    below 70% gross margin.

Deployment is not complete merely because code is pushed. Live checkout stays
disabled until the required Razorpay credentials, account approvals, plan IDs
and webhook delivery are verified.

## 15. Out of scope for the first release

- annual subscriptions;
- automatic metered overage billing;
- coupons and referral credits;
- automatic multi-gateway failover;
- a new Studio-credit economy;
- bundled human strategy work;
- deleting historical reports immediately after cancellation; and
- promising outcomes, rankings or AI recommendations.

## 16. Acceptance criteria

The release is acceptable when:

- landing and application show the approved prices and feature boundaries;
- a signed Razorpay webhook is required to grant paid access;
- every expensive operation is server-gated;
- scheduled work cannot spend after trial expiry, grace expiry or plan limits;
- existing production customers remain usable until intentionally migrated;
- reports remain readable after payment loss;
- all billing, tenant isolation and entitlement tests pass;
- test-mode checkout is verified end to end;
- production deploy and rollback procedures are documented; and
- the first 90-day cost dashboard can show direct cost and gross margin by
  plan.
