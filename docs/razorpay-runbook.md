# Razorpay paid plans: runbook

How White Petal's paid plans are configured, tested, released and rolled back.
Design: `docs/superpowers/specs/2026-10-10-white-petal-razorpay-plans-design.md`.

## How it works

- `server/plans.mjs` is the plan catalogue (prices, entitlements, margin budgets).
  `GET /api/billing/plans` serves its public view; the Bloom landing page keeps a
  marketing copy in `src/lib/billing-plans.ts` that must match it.
- `server/billing.mjs` decides what an organisation may do. Every cost boundary
  (brands, questions, competitors, engines, schedules, samples, seats,
  integrations, action drafts, trial checks, AI calls, the scheduler) calls it.
- Checkout creates a Razorpay subscription for an internal `plan` + `currency`.
  The Razorpay plan id comes from `RAZORPAY_PLAN_<PLAN>_<CURRENCY>`; the browser
  never sends an amount or a plan id.
- Only a signed webhook (`POST /api/webhooks/razorpay`) changes a plan. The
  browser's checkout callback just starts polling `GET /api/billing`.
- Existing organisations are `legacy/internal` and keep full access until an
  operator moves them. New self-serve sign-ups become a capped Growth trial only
  when `BILLING_ENABLED=1`; the seven days start when the email is verified.

## Configuration

| Name | Secret | Where |
|---|---|---|
| `RAZORPAY_KEY_ID` | yes (public in Checkout) | Secret Manager `WHITEPETAL_RAZORPAY_KEY_ID` |
| `RAZORPAY_KEY_SECRET` | yes | Secret Manager `WHITEPETAL_RAZORPAY_KEY_SECRET` |
| `RAZORPAY_WEBHOOK_SECRET` | yes | Secret Manager `WHITEPETAL_RAZORPAY_WEBHOOK_SECRET` |
| `RAZORPAY_PLAN_{STARTER,GROWTH,AGENCY}_{USD,INR}` | no | Terraform `razorpay_plan_ids` |
| `BILLING_ENABLED` (`0`, `operators`, `1`) | no | Terraform `billing_enabled` (default `0`) |
| `BILLING_TRIAL_DAYS`, `BILLING_GRACE_DAYS` | no | optional, default 7 and 3 |

Set a secret (input hidden, previous version destroyed):

```bash
infra/secrets.sh RAZORPAY_KEY_SECRET
```

Check which are set without printing values:

```bash
for k in RAZORPAY_KEY_ID RAZORPAY_KEY_SECRET RAZORPAY_WEBHOOK_SECRET; do
  if gcloud secrets versions list "WHITEPETAL_$k" --filter=state=ENABLED --format='value(name)' --limit=1 | grep -q .; then echo "$k: set"; else echo "$k: not set"; fi
done
```

Locally, put test values in the untracked `.env.local`, then:

```bash
node --env-file=.env.local -e 'for (const k of ["RAZORPAY_KEY_ID","RAZORPAY_KEY_SECRET","RAZORPAY_WEBHOOK_SECRET"]) console.log(k, process.env[k] ? "set" : "not set")'
```

Test and live keys are different values in different environments, rotated
independently. Never put either in Git, logs, screenshots or chat.

## Razorpay setup (test mode first)

1. In the Razorpay Dashboard (Test Mode), create six **monthly** plans, period
   `monthly`, interval `1`:

   | Plan | USD amount | INR amount |
   |---|---:|---:|
   | Starter | 4900 | 499900 |
   | Growth | 9900 | 999900 |
   | Agency | 24900 | 2499900 |

   INR amounts are before GST; configure tax in Razorpay as your accountant
   advises. USD plans need international payments enabled on the account.
2. Map the plan ids to `RAZORPAY_PLAN_<PLAN>_<CURRENCY>`.
3. Add a webhook at `<PUBLIC_ORIGIN>/api/webhooks/razorpay` with a new secret
   (`RAZORPAY_WEBHOOK_SECRET`) and these events (Razorpay docs, October 2026):
   `subscription.authenticated`, `subscription.activated`,
   `subscription.charged`, `subscription.updated`, `subscription.pending`,
   `subscription.halted`, `subscription.cancelled`, `subscription.completed`,
   `subscription.paused`, `subscription.resumed`. Recheck the list against
   razorpay.com/docs/webhooks/subscriptions before going live.
4. Webhooks are signed with HMAC-SHA256 of the raw body (`X-Razorpay-Signature`)
   and carry a unique `x-razorpay-event-id`, which is the idempotency key in
   `billing_events`.

### Local webhook forwarding

Razorpay must reach the local server over HTTPS, with the body untouched. A
plain tunnel works because it forwards bytes, for example:

```bash
cloudflared tunnel --url http://localhost:3000
```

Use the tunnel URL + `/api/webhooks/razorpay` as a separate test-mode webhook.
Do not use a proxy that re-serialises JSON: the signature would no longer match.

## Test-mode checks

Automated (no network): `TEST_DATABASE_URL=… npm test` covers the catalogue,
state machine, signature checks, idempotency (including two identical
deliveries at once), out-of-order events, every enforcement point, the trial,
grace, cancellation and read-only behaviour, and tenant isolation.

Manual, with test keys and `BILLING_ENABLED=operators` or `1`:

| Case | Do | Expect |
|---|---|---|
| Success | Buy Growth INR with a Razorpay test card | Checkout shows ₹9,999 (+ tax as configured); page shows "Confirming payment…" until the webhook; then `growth/active` |
| Duplicate webhook | Resend the `subscription.activated` delivery from the Dashboard | 200 with `duplicate:true`; one `billing_events` row; no second audit entry |
| Failed renewal | Use a failing test card / trigger `subscription.pending` | `past_due`, grace 3 days, scheduled checks skipped, manual work allowed |
| Grace expiry | Set `grace_ends_at` in the past on the test org | Read-only; reports readable; new checks refused with `billing_read_only` |
| Cancellation | Owner cancels on Billing & usage | Stays active until `current_period_end`, then `canceled` read-only |
| Upgrade | Growth → Agency | Plan changes only after Razorpay confirms the charge |
| Downgrade | Growth → Starter | Shows "Starts <date>"; changes at the next cycle |
| Delayed webhook | Pause webhook delivery, pay, then resume | "Confirming…" then a support-safe timeout message; plan updates when the webhook lands |

Record test-mode event ids and the resulting states (no card or payment data).

## Release

1. Back up the production database.
2. Deploy with `billing_enabled = "0"`. Migrations 003 and 004 run at boot under
   the advisory lock. Check `/api/health` is `ok:true, db:true`, and that every
   organisation is still `legacy/internal`:
   `select plan_code, billing_status, count(*) from whitepetal.organizations group by 1, 2;`
3. Confirm `GET /api/billing/plans` exposes no ids or secrets.
4. Set live secrets and live plan ids; register the live webhook with its own
   secret. Possession of keys does not mean Razorpay approved international or
   recurring payments: confirm KYC and approvals in the Dashboard first.
5. `billing_enabled = "operators"`; run one low-risk real transaction on an
   internal organisation, then cancel or refund and reconcile.
6. Deploy the Bloom pricing; verify live prices and CTA parameters, and that
   altered `plan`/`currency` values are refused by White Petal.
7. `billing_enabled = "1"` for self-serve checkout and trials.
8. Weekly for 90 days: compare the operator cost view against Razorpay, AI
   provider and cloud invoices before offering annual plans or higher limits.

Terraform: `terraform -chdir=infra/terraform fmt -check` and `validate` pass
locally with the initialised providers. In a fresh checkout `validate` needs
`terraform init` first.

## Rollback

1. Set `billing_enabled = "0"` and redeploy. Checkout stops; webhooks are still
   recorded and applied, so no payment is lost.
2. Keep reports and access readable. Do not drop billing columns or
   `billing_events`.
3. If an organisation was wrongly locked, an operator grants an expiring,
   audited override (Team & keys → All organisations) while you investigate.
4. Restore the previous Cloud Run revision if needed.
5. Reconcile Razorpay subscriptions against `billing_events` before replaying
   anything or re-enabling billing.
6. If the landing page is live, point self-serve CTAs to contact/waitlist until
   checkout is back.

Rollback triggers: a valid signature rejected or an invalid one accepted; one
event changing state twice; existing organisations losing access; a server-side
limit exceeded; access granted without a webhook; secrets in logs, config or
bundles; usage attributed across organisations; direct cost above the plan
budget without an audited override.
