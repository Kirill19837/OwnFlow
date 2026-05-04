-- Migration 013: Team-level GitHub OAuth tokens
-- Each team connects GitHub once; all projects under the team share the token.
-- Projects still store their own repo selection in github_connections.

-- ─── Team-level GitHub token store ──────────────────────────────────────────
create table if not exists team_github_tokens (
  id                uuid        primary key default gen_random_uuid(),
  team_id           uuid        not null unique references teams(id) on delete cascade,
  github_token      text        not null,
  github_user_login text,
  created_at        timestamptz not null default now()
);

alter table team_github_tokens enable row level security;
create policy "service_role_all_team_github_tokens" on team_github_tokens for all using (true);

-- ─── Extend github_oauth_states to support team-level flow ───────────────────
-- team_id: set when the OAuth flow was started from team settings
-- project_id: now nullable (still set when started from project settings)
alter table github_oauth_states
  add column if not exists team_id uuid references teams(id) on delete cascade;

alter table github_oauth_states
  alter column project_id drop not null;

-- ─── Make github_connections.github_token nullable ───────────────────────────
-- Projects that rely on the team-level token won't store their own token here.
alter table github_connections
  alter column github_token set default '',
  alter column github_token drop not null;
