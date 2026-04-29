-- Migration 008: team API request/event log
-- Records every mutating action on the teams API so you can audit who did
-- what and when without digging through server logs.

create table if not exists team_api_logs (
  id         uuid        primary key default gen_random_uuid(),
  team_id    uuid,                                      -- nullable: create / accept-invites set this after the fact
  user_id    text,                                      -- actor UUID as text (no FK so rows survive team deletion)
  action     text        not null,                      -- e.g. 'invite_member', 'accept_invites', 'remove_member'
  level      text        not null default 'info'        -- 'info' | 'warn' | 'error'
               check (level in ('info', 'warn', 'error')),
  detail     jsonb       not null default '{}',         -- extra context: email, role, status, etc.
  created_at timestamptz not null default now()
);

create index team_api_logs_team_id_idx  on team_api_logs (team_id);
create index team_api_logs_user_id_idx  on team_api_logs (user_id);
create index team_api_logs_action_idx   on team_api_logs (action);
create index team_api_logs_created_idx  on team_api_logs (created_at desc);

alter table team_api_logs enable row level security;
create policy "service_role_all_team_api_logs" on team_api_logs for all using (true);
