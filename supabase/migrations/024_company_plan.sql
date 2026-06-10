-- ─── company subscription plan ────────────────────────────────
-- Adds a plan column (free / standard / pro) to the companies table.
-- Safe to run on an existing database — idempotent.

-- 1. Create the enum type (skip silently if it already exists)
do $$ begin
create type company_plan as enum ('free', 'standard', 'pro');
exception when duplicate_object then
  raise notice 'type company_plan already exists, skipping';
end $$;

-- 2. Add the column with default = 'free'
--    "add column if not exists" means re-running this migration is safe
alter table companies
    add column if not exists plan company_plan not null default 'free';

-- 3. Backfill any existing rows just to be explicit
update companies
set plan = 'free'
where plan is null;
