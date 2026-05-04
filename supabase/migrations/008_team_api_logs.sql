-- Migration 008: team API request/event log
-- Records every mutating action on the teams API so you can audit who did
-- what and when without digging through server logs.
--
-- Also creates notification_types here because team_api_logs.action_id FKs into it,
-- and 008 runs before 009 which owns the full notifications setup.

-- ─── Notification types (lookup — created here, extended in 009) ─────────────

drop table if exists team_api_logs       cascade;
drop table if exists notification_types  cascade;

create table notification_types (
  id          uuid primary key,
  key         text not null unique,
  label       text not null,
  description text
);

insert into notification_types (id, key, label, description) values
  -- user-facing notification types
  ('00000000-0000-0000-0002-000000000001', 'team_invite',        'Team invite',        'You have been invited to join a team'),
  ('00000000-0000-0000-0002-000000000002', 'team_accepted',      'Invite accepted',    'A user accepted your team invite'),
  ('00000000-0000-0000-0002-000000000003', 'team_declined',      'Invite declined',    'A user declined your team invite'),
  ('00000000-0000-0000-0002-000000000004', 'team_removed',       'Removed from team',  'You were removed from a team'),
  ('00000000-0000-0000-0002-000000000005', 'role_changed',       'Role changed',       'Your role in a team was changed'),
  ('00000000-0000-0000-0002-000000000006', 'general',            'General',            'General system notification'),
  -- team API action types
  ('00000000-0000-0000-0002-000000000007', 'create_team',        'Create team',        'A new team was created'),
  ('00000000-0000-0000-0002-000000000008', 'update_team',        'Update team',        'Team settings were updated'),
  ('00000000-0000-0000-0002-000000000009', 'add_member',         'Add member',         'A member was added directly'),
  ('00000000-0000-0000-0002-000000000010', 'invite_member',      'Invite member',      'A member was invited by email'),
  ('00000000-0000-0000-0002-000000000011', 'accept_invites',     'Accept invites',     'Pending invites were accepted'),
  ('00000000-0000-0000-0002-000000000012', 'decline_invite',     'Decline invite',     'An invite was declined'),
  ('00000000-0000-0000-0002-000000000013', 'delete_team',        'Delete team',        'A team was deleted'),
  ('00000000-0000-0000-0002-000000000014', 'change_member_role', 'Change member role', 'A member''s role was changed'),
  ('00000000-0000-0000-0002-000000000015', 'leave_team',         'Leave team',         'A member left the team'),
  ('00000000-0000-0000-0002-000000000016', 'remove_member',      'Remove member',      'A member was removed from the team'),
  ('00000000-0000-0000-0002-000000000017', 'revoke_invite',      'Revoke invite',      'An invite was revoked')
on conflict (id) do nothing;

alter table notification_types enable row level security;
create policy "anyone_can_read_notification_types"  on notification_types for select using (true);
create policy "service_role_all_notification_types" on notification_types for all   using (true);

-- ─── Team API logs ────────────────────────────────────────────────────────────

create table team_api_logs (
  id         uuid        primary key default gen_random_uuid(),
  team_id    uuid,                                      -- nullable: create / accept-invites set this after the fact
  user_id    text,                                      -- actor UUID as text (no FK so rows survive team deletion)
  action_id  uuid        not null references notification_types (id),  -- FK to notification_types
  level      text        not null default 'info'        -- 'info' | 'warn' | 'error'
               check (level in ('info', 'warn', 'error')),
  detail     jsonb       not null default '{}',         -- extra context: email, role, status, etc.
  created_at timestamptz not null default now()
);

create index team_api_logs_team_id_idx   on team_api_logs (team_id);
create index team_api_logs_user_id_idx   on team_api_logs (user_id);
create index team_api_logs_action_id_idx on team_api_logs (action_id);
create index team_api_logs_created_idx   on team_api_logs (created_at desc);

alter table team_api_logs enable row level security;
create policy "service_role_all_team_api_logs" on team_api_logs for all using (true);
