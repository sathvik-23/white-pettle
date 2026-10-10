-- Set when the owner asks to cancel: access continues until current_period_end, when Razorpay's cancelled
-- event arrives. Cleared if the subscription is charged again.
alter table organizations add column cancel_at_period_end boolean not null default false;
