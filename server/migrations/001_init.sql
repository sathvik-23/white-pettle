-- White Petal's whole data model. Everything lives in the `whitepetal` schema (search_path is set by db.mjs),
-- so it can share PerfStaq's Postgres instance without touching its tables.

create table users (
  id            uuid primary key default gen_random_uuid(),
  email         text not null unique,
  name          text,
  pw_hash       text not null,
  created_at    timestamptz not null default now(),
  last_login_at timestamptz
);

-- Session ids are SHA-256 hashes of the cookie token, so a database leak does not hand out live sessions.
create table sessions (
  id         text primary key,
  user_id    uuid not null references users on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index sessions_user on sessions (user_id);

-- A brand being tracked. `setup` is what onboarding produced: profile, audit, site text, topics, prompts,
-- engines, focus. Scheduling lives in columns so the cron tick can find due work with an index.
create table workspaces (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references users on delete cascade,
  slug        text not null,
  name        text not null,
  site        text,
  setup       jsonb not null default '{}',
  schedule    text not null default 'off' check (schedule in ('off', 'daily', 'weekly')),
  samples     int  not null default 1 check (samples between 1 and 5),
  next_run_at timestamptz,
  last_run_at timestamptz,
  running_at  timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (owner_id, slug)
);
create index workspaces_due on workspaces (next_run_at) where schedule <> 'off';

-- One check. `data` is the full run (answers, sources, pages opened, drafts) as the app uses it;
-- `summary` is the handful of numbers trend charts and the brand list need without loading `data`.
create table runs (
  id           text primary key,
  workspace_id uuid not null references workspaces on delete cascade,
  source       text not null default 'live' check (source in ('live', 'scheduled')),
  status       text not null default 'running' check (status in ('running', 'done', 'stopped', 'failed')),
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  summary      jsonb,
  data         jsonb,
  error        text,
  updated_at   timestamptz not null default now()
);
create index runs_ws_time on runs (workspace_id, started_at desc);

-- Connected tools per brand. Secret fields are AES-GCM encrypted with APP_SECRET; `config` holds only the
-- non-secret ones and is safe to send to the browser. `data` is the last thing `collect()` returned.
create table integrations (
  workspace_id uuid not null references workspaces on delete cascade,
  provider     text not null,
  config       jsonb not null default '{}',
  secret       text,
  status       text not null default 'connected',
  detail       text,
  data         jsonb,
  collected_at timestamptz,
  updated_at   timestamptz not null default now(),
  primary key (workspace_id, provider)
);

-- OAuth `state` values, so a callback can only complete a flow this server started (and only once).
create table oauth_states (
  state        text primary key,
  user_id      uuid not null references users on delete cascade,
  workspace_id uuid not null references workspaces on delete cascade,
  created_at   timestamptz not null default now()
);
