-- Add task_id to ai_logs for per-task log filtering in executor monitor
alter table ai_logs add column if not exists task_id uuid references tasks(id) on delete cascade;
create index if not exists ai_logs_task_id_idx on ai_logs(task_id) where task_id is not null;
