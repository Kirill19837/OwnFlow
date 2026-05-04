-- Migration 014: External/webhook agents + company AI keys + agent registry
--
-- Actors dispatch to external services based on webhook_url presence (not type).
-- Company-level API keys let built-in AI actors use org-owned provider credentials.

-- ─── Extend actors table ─────────────────────────────────────────────────────
-- webhook_url:    where OwnFlow sends the task payload
-- agent_api_key:  sent as X-Api-Key header so the agent can verify OwnFlow
alter table actors
  add column if not exists webhook_url   text,
  add column if not exists agent_api_key text;

-- ─── Extend tasks table ──────────────────────────────────────────────────────
-- One-time token generated per dispatch; the agent uses it to authenticate the callback.
-- Cleared after the callback is received.
alter table tasks
  add column if not exists agent_callback_token text,
  add column if not exists agent_dispatched_at  timestamptz;

-- ─── Company AI provider keys ────────────────────────────────────────────────
alter table companies
  add column if not exists openai_api_key    text,
  add column if not exists anthropic_api_key text;

-- ─── Company-level agent registry ────────────────────────────────────────────
-- Reusable agent templates available across all projects in the company.
create table if not exists company_agents (
  id             uuid        primary key default gen_random_uuid(),
  company_id     uuid        not null references companies(id) on delete cascade,
  name           text        not null,
  role           text,
  webhook_url    text        not null,
  agent_api_key  text,
  description    text,
  created_at     timestamptz not null default now()
);

alter table company_agents enable row level security;

-- Only the backend service-role may read or write company_agents.
-- PostgREST connects as the 'service_role' Postgres role when using the
-- service-role JWT, so current_user = 'service_role' is the right guard.
-- Client-side (anon / authenticated) requests cannot reach this table.
create policy "service_role_all_company_agents"
  on company_agents for all
  to service_role
  using (true)
  with check (true);

-- Index supporting the standard list query: WHERE company_id = ? ORDER BY created_at
create index if not exists idx_company_agents_company_created
  on company_agents (company_id, created_at);
