-- Migration 012: GitHub OAuth app support + webhooks + PR state on tasks

-- ─── OAuth state table (CSRF protection during OAuth flow) ───────────────────
create table if not exists github_oauth_states (
  state       text        primary key,
  project_id  uuid        not null references projects(id) on delete cascade,
  created_at  timestamptz not null default now()
);

-- Expire states older than 10 minutes automatically (clean-up via periodic cron or on next request)
-- No trigger needed — we validate created_at in application code.

alter table github_oauth_states enable row level security;
create policy "service_role_all_github_oauth_states" on github_oauth_states for all using (true);

-- ─── Extend github_connections ───────────────────────────────────────────────
alter table github_connections
  add column if not exists github_user_login text,
  add column if not exists webhook_secret    text;

-- ─── PR state + number on tasks ──────────────────────────────────────────────
alter table tasks
  add column if not exists github_pr_state  text,
  add column if not exists github_pr_number int;
