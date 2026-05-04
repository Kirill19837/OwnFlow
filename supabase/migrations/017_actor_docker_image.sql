-- Migration 017: Per-actor Docker image + extra_env + builtin agent type on company_agents
--
-- Dispatch resolution for Docker agents:
--   actor.docker_image → server BUILTIN_AGENT_IMAGE env default
--
-- extra_env: company-level key→value env vars (e.g. FIGMA_TOKEN) injected
-- into Docker containers at dispatch. Values are secrets — never returned by API.

-- Per-actor Docker image override (null = use server default ownflow-agent:latest)
alter table actors
  add column if not exists docker_image text;

-- Per-actor extra env vars — copied from company_agent template at apply-time
-- Secrets: backend never returns values in API responses
alter table actors
  add column if not exists extra_env jsonb;

-- Make webhook_url nullable on company_agents (builtin agents have no URL)
alter table company_agents
  alter column webhook_url drop not null;

-- Docker image for builtin company agent templates
alter table company_agents
  add column if not exists docker_image text;

-- Extra env vars for company agent templates (e.g. {"FIGMA_TOKEN": "fig-xxx"})
-- Secrets: backend never returns values in API responses
alter table company_agents
  add column if not exists extra_env jsonb;

-- Agent type: 'webhook' (external HTTP) or 'builtin' (Docker container)
alter table company_agents
  add column if not exists agent_type text not null default 'webhook'
    check (agent_type in ('webhook', 'builtin'));

-- Ensure every company agent has at least one dispatch target
alter table company_agents
  add constraint chk_company_agent_dispatch
    check (webhook_url is not null or docker_image is not null);
