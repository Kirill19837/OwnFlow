-- Add actor_role column to tasks so the AI planner can specify which actor role
-- should handle each task. The assignment engine uses this for role-based matching,
-- preferring a human actor with a matching role over an AI actor.
alter table tasks add column if not exists actor_role text;
