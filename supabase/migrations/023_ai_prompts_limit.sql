-- Add AI prompt usage tracking to companies
alter table companies
    add column if not exists ai_prompts_used  integer not null default 0,
    add column if not exists ai_prompts_limit integer not null default 100;
