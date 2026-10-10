-- When the daily reconciliation last compared this organisation's subscription with Razorpay.
alter table organizations add column billing_reconciled_at timestamptz;
