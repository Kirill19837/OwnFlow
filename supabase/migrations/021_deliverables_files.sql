-- Add files column to deliverables for storing agent-generated files
alter table deliverables
    add column if not exists files jsonb;

-- Index for performance
create index if not exists ix_deliverables_task_files
    on deliverables(task_id) where files is not null;

