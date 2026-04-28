-- Migration 007: skills catalogue + user skill selections
-- Run in Supabase SQL editor or via psql.

-- ─── Skills catalogue ────────────────────────────────────────────────────────
-- Stores the pool of specialist roles/skills that actors can hold.
-- actor_type: 'human' | 'ai' | 'both'  (matches actors.type logic)

create table if not exists skills (
  id          uuid        primary key default gen_random_uuid(),
  name        text        not null unique,
  category    text        not null,
  description text,
  actor_type  text        not null default 'both' check (actor_type in ('human', 'ai', 'both')),
  created_at  timestamptz not null default now()
);

-- Seed with the roles that were previously hardcoded in the frontend
insert into skills (name, category, description, actor_type) values
  -- Engineering
  ('Lead Developer',     'Engineering', 'Drives technical decisions, reviews PRs, and mentors the team on best practices.',                'both'),
  ('Senior Developer',   'Engineering', 'Implements core features and complex business logic with high code quality.',                     'both'),
  ('Backend Developer',  'Engineering', 'Designs APIs, schemas, and services. Focused on performance and reliability.',                    'both'),
  ('Frontend Developer', 'Engineering', 'Builds responsive, accessible UIs. Manages component state and integrations.',                   'both'),
  ('Architect',          'Engineering', 'Defines system design, tech stack choices, and scalability patterns.',                            'both'),
  ('DevOps Engineer',    'Engineering', 'Manages CI/CD, infrastructure-as-code, monitoring, and release automation.',                     'both'),
  -- Quality
  ('QA Automation Lead', 'Quality',     'Designs and maintains automated test suites; owns coverage and regression strategy.',             'both'),
  ('QA Manual',          'Quality',     'Runs exploratory and acceptance testing; documents bugs with full reproduction steps.',           'human'),
  ('Security Reviewer',  'Quality',     'Audits code for OWASP vulnerabilities and enforces secure coding standards.',                    'both'),
  -- Product
  ('Product Owner',      'Product',     'Owns the backlog, defines acceptance criteria, and represents the customer.',                    'human'),
  ('Business Analyst',   'Product',     'Maps requirements to specs, validates scope, and bridges business and tech.',                    'both'),
  ('UI/UX Designer',     'Product',     'Creates wireframes, design systems, and user flows that prioritise usability.',                  'both'),
  ('Copywriter',         'Product',     'Writes product copy, tooltips, onboarding text, and user-facing documentation.',                 'both'),
  -- Management
  ('AI Project Manager', 'Management',  'Plans sprints, assigns tasks to actors, tracks progress, and surfaces blockers.',                'both'),
  ('Scrum Master',       'Management',  'Facilitates stand-ups, retrospectives, and sprint ceremonies; removes impediments.',             'human'),
  -- Feedback
  ('Beta User',          'Feedback',    'Stress-tests the product as a real user and reports friction points and bugs.',                  'human'),
  ('Stakeholder',        'Feedback',    'Approves major decisions, aligns product direction, and reviews key deliverables.',              'human')
on conflict (name) do nothing;

-- ─── User skill selections ───────────────────────────────────────────────────
-- Stores which skills each user has selected on their profile.

create table if not exists user_skills (
  user_id    uuid        not null,
  skill_id   uuid        not null references skills(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, skill_id)
);

-- ─── RLS ─────────────────────────────────────────────────────────────────────

alter table skills      enable row level security;
alter table user_skills enable row level security;

-- Service role has full access (backend uses service-role key)
create policy "service_role_all_skills"
  on skills for all using (true);

create policy "service_role_all_user_skills"
  on user_skills for all using (true);
