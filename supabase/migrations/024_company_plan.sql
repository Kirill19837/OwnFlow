-- ─── company subscription plan ────────────────────────────────

-- 1. Create the enum type (skip silently if it already exists)
do $$ begin
create type company_plan as enum ('free', 'standard', 'pro');
exception when duplicate_object then
  raise notice 'type company_plan already exists, skipping';
end $$;

-- 2. Add the column if it doesn't exist yet
alter table companies
    add column if not exists plan company_plan;

-- 3. Backfill any existing NULL rows
update companies
set plan = 'free'
where plan is null;

-- 4. Enforce DEFAULT and NOT NULL regardless of whether column is new or pre-existing
alter table companies
    alter column plan set default 'free';

alter table companies
    alter column plan set not null;
