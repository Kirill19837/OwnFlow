-- OwnFlow — full database schema (single source of truth)
-- Run this against a fresh Supabase project to bootstrap the entire schema.
-- Idempotent: drops all existing OwnFlow tables and recreates them cleanly.
--
-- Usage (Supabase SQL editor or psql):
--   \i database_full.sql

-- ─── Extensions ──────────────────────────────────────────────────────────────

create extension if not exists "pgcrypto";

-- ─── Drop existing tables (dependency order: children first) ─────────────────

drop table if exists user_signups        cascade;
drop table if exists user_skills         cascade;
drop table if exists skills              cascade;
drop table if exists task_interactions   cascade;
drop table if exists github_connections  cascade;
drop table if exists ai_messages         cascade;
drop table if exists ai_logs             cascade;
drop table if exists deliverables        cascade;
drop table if exists assignments         cascade;
drop table if exists tasks               cascade;
drop table if exists sprints             cascade;
drop table if exists project_members     cascade;
drop table if exists projects            cascade;
drop table if exists actors              cascade;
drop table if exists notifications       cascade;
drop table if exists notification_types  cascade;
drop table if exists team_api_logs       cascade;
drop table if exists team_invites        cascade;
drop table if exists team_members        cascade;
drop table if exists teams               cascade;
drop table if exists company_members     cascade;
drop table if exists companies           cascade;
drop table if exists roles               cascade;
-- legacy tables from earlier schema revisions
drop table if exists org_invites         cascade;
drop table if exists org_members         cascade;
drop table if exists organizations       cascade;

-- ─── Roles ───────────────────────────────────────────────────────────────────

create table roles (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  description text
);

insert into roles (id, name, description) values
  ('00000000-0000-0000-0000-000000000001', 'owner',  'Full control — can delete the entity and manage all members'),
  ('00000000-0000-0000-0000-000000000002', 'admin',  'Can manage members and settings but cannot delete the entity'),
  ('00000000-0000-0000-0000-000000000003', 'member', 'Read/write access to projects and tasks');

-- ─── Companies ───────────────────────────────────────────────────────────────

create table companies (
  id         uuid        primary key default gen_random_uuid(),
  name       text        not null,
  slug       text        not null unique,
  owner_id   uuid        not null,
  phone      text,
  created_at timestamptz not null default now()
);

create table company_members (
  company_id uuid        not null references companies(id) on delete cascade,
  user_id    uuid        not null,
  role       uuid        not null default '00000000-0000-0000-0000-000000000003' references roles(id),
  joined_at  timestamptz not null default now(),
  primary key (company_id, user_id)
);

-- ─── Teams ───────────────────────────────────────────────────────────────────

create table teams (
  id               uuid        primary key default gen_random_uuid(),
  name             text        not null,
  slug             text        not null unique,
  owner_id         uuid        not null,
  company_id       uuid        references companies(id) on delete cascade,
  default_ai_model text        not null default 'gpt-4o',
  created_at       timestamptz not null default now()
);

create table team_members (
  team_id   uuid        not null references teams(id) on delete cascade,
  user_id   uuid        not null,
  role      uuid        not null default '00000000-0000-0000-0000-000000000003' references roles(id),
  joined_at timestamptz not null default now(),
  primary key (team_id, user_id)
);

-- ─── Per-user notifications ────────────────────────────────────────────────

create table notification_types (
  id          uuid primary key,
  key         text not null unique,
  label       text not null,
  description text
);

insert into notification_types (id, key, label, description) values
  ('00000000-0000-0000-0002-000000000001', 'team_invite',        'Team invite',        'You have been invited to join a team'),
  ('00000000-0000-0000-0002-000000000002', 'team_accepted',      'Invite accepted',    'A user accepted your team invite'),
  ('00000000-0000-0000-0002-000000000003', 'team_declined',      'Invite declined',    'A user declined your team invite'),
  ('00000000-0000-0000-0002-000000000004', 'team_removed',       'Removed from team',  'You were removed from a team'),
  ('00000000-0000-0000-0002-000000000005', 'role_changed',       'Role changed',       'Your role in a team was changed'),
  ('00000000-0000-0000-0002-000000000006', 'general',            'General',            'General system notification'),
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
  ('00000000-0000-0000-0002-000000000017', 'revoke_invite',      'Revoke invite',      'An invite was revoked');

create table notifications (
  id         uuid        primary key default gen_random_uuid(),
  user_id    uuid        not null,
  type_id    uuid        not null references notification_types (id),
  title      text        not null,
  body       text        not null default '',
  payload    jsonb       not null default '{}',
  read       boolean     not null default false,
  created_at timestamptz not null default now()
);

create index notifications_user_id_idx on notifications (user_id);
create index notifications_unread_idx  on notifications (user_id) where read = false;
create index notifications_created_idx on notifications (created_at desc);

-- ─── Team API logs ──────────────────────────────────────────────────────────

create table team_api_logs (
  id         uuid        primary key default gen_random_uuid(),
  team_id    uuid,
  user_id    text,
  action_id  uuid        not null references notification_types (id),
  level      text        not null default 'info' check (level in ('info', 'warn', 'error')),
  detail     jsonb       not null default '{}',
  created_at timestamptz not null default now()
);

create index team_api_logs_team_id_idx   on team_api_logs (team_id);
create index team_api_logs_user_id_idx   on team_api_logs (user_id);
create index team_api_logs_action_id_idx on team_api_logs (action_id);
create index team_api_logs_created_idx   on team_api_logs (created_at desc);

create table team_invites (
  id                 uuid        primary key default gen_random_uuid(),
  team_id            uuid        not null references teams(id) on delete cascade,
  company_id         uuid        references companies(id),
  email              text        not null,
  role               uuid        not null default '00000000-0000-0000-0000-000000000003' references roles(id),
  invited_by_user_id uuid        not null,
  invited_by_email   text,
  status             text        not null default 'pending' check (status in ('pending', 'accepted', 'revoked', 'declined')),
  accepted_user_id   uuid,
  invited_at         timestamptz not null default now(),
  accepted_at        timestamptz
);

create unique index team_invites_team_email_status_uniq on team_invites (team_id, email, status);
create        index team_invites_email_status_idx       on team_invites (email, status);

-- ─── User signups ─────────────────────────────────────────────────────────────
--
-- Tracks how each user first entered the product and where they are in
-- the onboarding funnel.
--
-- origin
--   'organic'     — self-signup via /auth/signup  → show company-setup flow
--   'team_invite' — arrived through a team invite → skip company creation
--
-- signup_status (onboarding funnel stage)
--   'invited'         — account created via team invite; setup not yet complete
--   'company_created' — organic user created their company (onboarding complete)
--   'team_join'       — invited user accepted the invite and joined a team
--
-- completed_at — timestamped when signup_status becomes 'company_created' or 'team_join'

create table user_signups (
  id               uuid        primary key default gen_random_uuid(),
  user_id          uuid        not null unique,
  origin           text        not null check (origin in ('organic', 'team_invite')),
  signup_status    text        check (signup_status in ('invited', 'company_created', 'team_join')),
  invited_by_email text,
  team_id          uuid,
  completed_at     timestamptz,
  created_at       timestamptz not null default now()
);

create index user_signups_status_idx on user_signups (signup_status);

-- ─── Projects ────────────────────────────────────────────────────────────────

create table projects (
  id          uuid        primary key default gen_random_uuid(),
  name        text        not null,
  prompt      text        not null,
  owner_id    uuid        not null,
  team_id     uuid        references teams(id) on delete cascade,
  status      text        not null default 'planning',
  sprint_days int         not null default 3,
  roadmap     jsonb,
  created_at  timestamptz not null default now()
);

create table project_members (
  project_id uuid        not null references projects(id) on delete cascade,
  user_id    uuid        not null,
  role       uuid        not null default '00000000-0000-0000-0000-000000000003' references roles(id),
  joined_at  timestamptz not null default now(),
  primary key (project_id, user_id)
);

-- ─── Actors ──────────────────────────────────────────────────────────────────

create table actors (
  id           uuid        primary key default gen_random_uuid(),
  project_id   uuid        not null references projects(id) on delete cascade,
  name         text        not null,
  type         text        not null check (type in ('human', 'ai')),
  role         text,
  model        text,
  capabilities text[]      default '{}',
  avatar_url   text,
  user_id      uuid        references auth.users(id) on delete set null,
  created_at   timestamptz not null default now()
);

-- ─── Sprints ─────────────────────────────────────────────────────────────────

create table sprints (
  id            uuid        primary key default gen_random_uuid(),
  project_id    uuid        not null references projects(id) on delete cascade,
  sprint_number integer     not null,
  start_date    date        not null,
  end_date      date        not null,
  status        text        not null default 'planned',
  created_at    timestamptz not null default now()
);

-- ─── Tasks ───────────────────────────────────────────────────────────────────

create table tasks (
  id              uuid        primary key default gen_random_uuid(),
  sprint_id       uuid        not null references sprints(id)  on delete cascade,
  project_id      uuid        not null references projects(id) on delete cascade,
  title           text        not null,
  description     text        not null default '',
  type            text        not null default 'code',
  priority        text        not null default 'medium',
  status          text        not null default 'todo',
  estimated_hours float       not null default 4,
  depends_on      uuid[]      default '{}',
  github_pr_url   text,
  ai_ready        boolean     not null default false,
  is_ready        boolean     not null default false,
  task_details    jsonb,
  created_at      timestamptz not null default now()
);

-- ─── Task interactions ────────────────────────────────────────────────────────

create table task_interactions (
  id         uuid        primary key default gen_random_uuid(),
  task_id    uuid        not null references tasks(id) on delete cascade,
  role       text        not null check (role in ('user', 'assistant')),
  content    text        not null,
  created_at timestamptz not null default now()
);

create index task_interactions_task_idx on task_interactions (task_id, created_at);

-- ─── Assignments ─────────────────────────────────────────────────────────────

create table assignments (
  id          uuid        primary key default gen_random_uuid(),
  task_id     uuid        not null references tasks(id)   on delete cascade,
  actor_id    uuid        not null references actors(id)  on delete cascade,
  assigned_by text        not null default 'system',
  assigned_at timestamptz not null default now(),
  unique (task_id)
);

-- ─── Deliverables ────────────────────────────────────────────────────────────

create table deliverables (
  id             uuid        primary key default gen_random_uuid(),
  task_id        uuid        not null references tasks(id)   on delete cascade,
  actor_id       uuid        not null references actors(id)  on delete cascade,
  content        text        not null,
  tool_calls_log jsonb       default '[]',
  created_at     timestamptz not null default now()
);

-- ─── AI context ──────────────────────────────────────────────────────────────

create table ai_logs (
  id         uuid        primary key default gen_random_uuid(),
  project_id uuid        not null references projects(id) on delete cascade,
  phase      text        not null default 'planning',
  message    text        not null,
  level      text        not null default 'info',
  created_at timestamptz not null default now()
);

create table ai_messages (
  id         uuid        primary key default gen_random_uuid(),
  project_id uuid        not null references projects(id) on delete cascade,
  task_id    uuid        references tasks(id)   on delete cascade,
  actor_id   uuid        references actors(id)  on delete set null,
  phase      text        not null default 'planning',
  model      text        not null,
  messages   jsonb       not null default '[]',
  response   text        not null,
  usage      jsonb,
  created_at timestamptz not null default now()
);

-- ─── GitHub integration ───────────────────────────────────────────────────────

create table github_connections (
  id           uuid        primary key default gen_random_uuid(),
  project_id   uuid        references projects(id) on delete cascade unique,
  github_token text        not null,
  repo_owner   text        default '',
  repo_name    text        default '',
  created_at   timestamptz default now()
);

-- ─── Realtime ────────────────────────────────────────────────────────────────

do $$ begin alter publication supabase_realtime add table tasks;        exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table assignments;  exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table deliverables; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table projects;     exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table ai_logs;      exception when duplicate_object then null; end $$;

-- ─── Row-level security ───────────────────────────────────────────────────────

alter table roles              enable row level security;
alter table companies          enable row level security;
alter table company_members    enable row level security;
alter table teams              enable row level security;
alter table team_members       enable row level security;
alter table notifications      enable row level security;
alter table notification_types enable row level security;
alter table team_api_logs      enable row level security;
alter table team_invites       enable row level security;
alter table user_signups       enable row level security;
alter table projects           enable row level security;
alter table project_members    enable row level security;
alter table actors             enable row level security;
alter table sprints            enable row level security;
alter table tasks              enable row level security;
alter table task_interactions  enable row level security;
alter table assignments        enable row level security;
alter table deliverables       enable row level security;
alter table ai_logs            enable row level security;
alter table ai_messages        enable row level security;
alter table github_connections enable row level security;

create policy "service_role_all_roles"             on roles              for all using (true);
create policy "service_role_all_companies"         on companies          for all using (true);
create policy "service_role_all_company_members"   on company_members    for all using (true);
create policy "service_role_all_teams"             on teams              for all using (true);
create policy "service_role_all_team_members"      on team_members       for all using (true);
create policy "user_can_read_own_notifications"    on notifications      for select using (auth.uid() = user_id);
create policy "user_can_update_own_notifications"  on notifications      for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "service_role_all_notifications"     on notifications      for all using (true);
create policy "anyone_can_read_notification_types" on notification_types for select using (true);
create policy "service_role_all_notification_types" on notification_types for all using (true);
create policy "service_role_all_team_api_logs"     on team_api_logs      for all using (true);
create policy "service_role_all_team_invites"      on team_invites       for all using (true);
create policy "service_role_all_user_signups"      on user_signups       for all using (true);
create policy "service_role_all_projects"          on projects           for all using (true);
create policy "service_role_all_project_members"   on project_members    for all using (true);
create policy "service_role_all_actors"            on actors             for all using (true);
create policy "service_role_all_sprints"           on sprints            for all using (true);
create policy "service_role_all_tasks"             on tasks              for all using (true);
create policy "service_role_all_task_interactions" on task_interactions  for all using (true);
create policy "service_role_all_assignments"       on assignments        for all using (true);
create policy "service_role_all_deliverables"      on deliverables       for all using (true);
create policy "service_role_all_ai_logs"           on ai_logs            for all using (true);
create policy "service_role_all_ai_messages"       on ai_messages        for all using (true);
create policy "service_role_all_github"            on github_connections for all using (true);

-- ─── Skills catalogue ────────────────────────────────────────────────────────

create table if not exists skills (
  id          uuid        primary key default gen_random_uuid(),
  name        text        not null unique,
  category    text        not null,
  description text,
  actor_type  text        not null default 'both' check (actor_type in ('human', 'ai', 'both')),
  created_at  timestamptz not null default now()
);

insert into skills (name, category, description, actor_type) values
  ('Lead Developer',     'Engineering', 'Drives technical decisions, reviews PRs, and mentors the team on best practices.',                'both'),
  ('Senior Developer',   'Engineering', 'Implements core features and complex business logic with high code quality.',                     'both'),
  ('Backend Developer',  'Engineering', 'Designs APIs, schemas, and services. Focused on performance and reliability.',                    'both'),
  ('Frontend Developer', 'Engineering', 'Builds responsive, accessible UIs. Manages component state and integrations.',                   'both'),
  ('Architect',          'Engineering', 'Defines system design, tech stack choices, and scalability patterns.',                            'both'),
  ('DevOps Engineer',    'Engineering', 'Manages CI/CD, infrastructure-as-code, monitoring, and release automation.',                     'both'),
  ('QA Automation Lead', 'Quality',     'Designs and maintains automated test suites; owns coverage and regression strategy.',             'both'),
  ('QA Manual',          'Quality',     'Runs exploratory and acceptance testing; documents bugs with full reproduction steps.',           'human'),
  ('Security Reviewer',  'Quality',     'Audits code for OWASP vulnerabilities and enforces secure coding standards.',                    'both'),
  ('Product Owner',      'Product',     'Owns the backlog, defines acceptance criteria, and represents the customer.',                    'human'),
  ('Business Analyst',   'Product',     'Maps requirements to specs, validates scope, and bridges business and tech.',                    'both'),
  ('UI/UX Designer',     'Product',     'Creates wireframes, design systems, and user flows that prioritise usability.',                  'both'),
  ('Copywriter',         'Product',     'Writes product copy, tooltips, onboarding text, and user-facing documentation.',                 'both'),
  ('AI Project Manager', 'Management',  'Plans sprints, assigns tasks to actors, tracks progress, and surfaces blockers.',                'both'),
  ('Scrum Master',       'Management',  'Facilitates stand-ups, retrospectives, and sprint ceremonies; removes impediments.',             'human'),
  ('Beta User',          'Feedback',    'Stress-tests the product as a real user and reports friction points and bugs.',                  'human'),
  ('Stakeholder',        'Feedback',    'Approves major decisions, aligns product direction, and reviews key deliverables.',              'human')
on conflict (name) do nothing;

create table if not exists user_skills (
  user_id    uuid        not null,
  skill_id   uuid        not null references skills(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, skill_id)
);

alter table skills      enable row level security;
alter table user_skills enable row level security;
create policy "service_role_all_skills"       on skills      for all using (true);
create policy "service_role_all_user_skills"  on user_skills for all using (true);
