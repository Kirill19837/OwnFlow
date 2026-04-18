-- GitHub per-project token integration

CREATE TABLE IF NOT EXISTS github_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid REFERENCES projects(id) ON DELETE CASCADE UNIQUE,
  github_token text NOT NULL,
  repo_owner text DEFAULT '',
  repo_name text DEFAULT '',
  created_at timestamptz DEFAULT now()
);

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS github_pr_url text;
