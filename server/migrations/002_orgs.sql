-- Organisations. Brands belong to an organisation, not a person; people join an organisation with a role.
-- One person can belong to many organisations (an agency, or the operator who runs White Petal for clients).

create table organizations (
  id                  uuid primary key default gen_random_uuid(),
  slug                text not null unique,
  name                text not null,
  -- The organisation's own AI keys, sealed with APP_SECRET (AES-256-GCM), like integration secrets.
  keys                text,
  -- May this organisation fall back to the platform's keys for an engine it has no key for?
  -- True for the personal organisations created from existing accounts (nothing changes for them);
  -- false for client organisations, which bring their own keys. Only a platform operator can change it.
  allow_platform_keys boolean not null default false,
  monthly_cap_usd     numeric(10, 2) check (monthly_cap_usd is null or monthly_cap_usd >= 0),
  created_by          uuid references users on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create table memberships (
  org_id     uuid not null references organizations on delete cascade,
  user_id    uuid not null references users on delete cascade,
  role       text not null check (role in ('owner', 'admin', 'editor', 'viewer')),
  created_at timestamptz not null default now(),
  primary key (org_id, user_id)
);
create index memberships_user on memberships (user_id);
-- At most one owner per organisation (an organisation created for a client has none until they accept).
create unique index memberships_one_owner on memberships (org_id) where role = 'owner';

-- Invite links. Only the SHA-256 of the token is stored, so a database leak hands out no working links.
create table invitations (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations on delete cascade,
  email       text not null,
  role        text not null check (role in ('owner', 'admin', 'editor', 'viewer')),
  token_hash  text not null unique,
  invited_by  uuid references users on delete set null,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  accepted_at timestamptz,
  revoked_at  timestamptz
);
create index invitations_org on invitations (org_id);

-- One-time email links: password resets and email verification. Only the SHA-256 of the token is stored.
create table user_tokens (
  token_hash text primary key,
  user_id    uuid not null references users on delete cascade,
  purpose    text not null check (purpose in ('reset', 'verify')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at    timestamptz
);
create index user_tokens_user on user_tokens (user_id, purpose);

-- Estimated AI spend, per call (n > 1 for a scheduled run's batched rows). Feeds the usage meter and the cap.
create table usage (
  id           bigserial primary key,
  org_id       uuid not null references organizations on delete cascade,
  workspace_id uuid references workspaces on delete set null,
  user_id      uuid references users on delete set null,
  kind         text not null,
  engine       text,
  n            int not null default 1,
  cost_usd     numeric(12, 5) not null default 0,
  at           timestamptz not null default now()
);
create index usage_org_time on usage (org_id, at);

-- Who did what: invites, role changes, key and cap changes, deletions, operator visits.
create table audit_log (
  id      bigserial primary key,
  org_id  uuid references organizations on delete cascade,
  user_id uuid references users on delete set null,
  action  text not null,
  target  text,
  detail  jsonb not null default '{}',
  at      timestamptz not null default now()
);
create index audit_org_time on audit_log (org_id, at desc);

-- Accounts made with Google have no password.
alter table users alter column pw_hash drop not null;
alter table users add column google_sub text unique;
-- Set once the person has proved they own the address: an emailed link (invite, verification, reset) or a
-- verified Google sign-in. Operator rights (PLATFORM_OPERATORS) need it, so typing an operator's address at
-- sign-up gives nothing.
alter table users add column email_verified_at timestamptz;

-- The organisation a session is working in.
alter table sessions add column org_id uuid references organizations on delete set null;

alter table workspaces add column org_id uuid references organizations on delete cascade;
alter table runs add column started_by uuid references users on delete set null;

-- Every existing account gets a personal organisation, and its brands move into it unchanged.
insert into organizations (slug, name, created_by, allow_platform_keys)
select 'u-' || substr(replace(u.id::text, '-', ''), 1, 12),
       coalesce(nullif(trim(u.name), ''), split_part(u.email, '@', 1)) || '''s brands', u.id, true
from users u;
insert into memberships (org_id, user_id, role) select o.id, o.created_by, 'owner' from organizations o;
update workspaces w set org_id = o.id from organizations o where o.created_by = w.owner_id;
update sessions s set org_id = o.id from organizations o where o.created_by = s.user_id;

alter table workspaces alter column org_id set not null;
alter table workspaces drop constraint workspaces_owner_id_slug_key;
alter table workspaces add constraint workspaces_org_slug_key unique (org_id, slug);
-- owner_id now means "created by": deleting a person no longer deletes the organisation's brands.
alter table workspaces alter column owner_id drop not null;
alter table workspaces drop constraint workspaces_owner_id_fkey;
alter table workspaces add constraint workspaces_owner_id_fkey foreign key (owner_id) references users on delete set null;
create index workspaces_org on workspaces (org_id);
