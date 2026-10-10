-- Paid plans. Billing belongs to an organisation. Every existing organisation becomes legacy/internal and keeps
-- the access it has today; operators move organisations onto plans deliberately (docs/razorpay-runbook.md).

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

-- 'rotating': a daily check of a few priority questions, plus a full weekly run (Growth and Agency).
alter table workspaces drop constraint workspaces_schedule_check;
alter table workspaces add constraint workspaces_schedule_check
  check (schedule in ('off','weekly','rotating','daily'));
alter table workspaces add column rotation_cursor int not null default 0;
alter table workspaces add column last_full_run_at timestamptz;

-- One row per Razorpay webhook event. The primary key makes processing idempotent; `payload` holds only
-- identifiers, statuses and timestamps, never card or payment-method details.
create table billing_events (
  event_id     text primary key,
  event_type   text not null,
  org_id       uuid references organizations on delete set null,
  received_at  timestamptz not null default now(),
  processed_at timestamptz,
  status       text not null default 'received' check (status in ('received','processed','ignored','failed')),
  payload      jsonb not null default '{}',
  error        text
);
create index billing_events_org_time on billing_events (org_id, received_at desc);
