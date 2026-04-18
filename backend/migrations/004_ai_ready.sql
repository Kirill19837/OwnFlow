-- Two-stage readiness: AI decides it has enough info, user approves for execution
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS ai_ready boolean DEFAULT false;
