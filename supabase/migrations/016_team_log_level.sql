-- Log levels: 0=debug 1=info 2=warning 3=error
-- teams.log_level — minimum level to persist; agents below this threshold are dropped
alter table teams add column if not exists log_level smallint not null default 1
  check (log_level between 0 and 3);

-- ai_logs.level — change from text to smallint
alter table ai_logs drop column if exists level;
alter table ai_logs add column level smallint not null default 1;

-- ai_logs.phase — change from text to smallint
-- 0=planning 1=agent_execution 2=external_dispatch 3=docker_dispatch 4=task_execution
alter table ai_logs drop column if exists phase;
alter table ai_logs add column phase smallint not null default 0;
