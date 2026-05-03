# Agent Flow

OwnFlow supports two execution modes for actors: **built-in AI** (Claude/GPT via the backend) and **external webhook agents** (your own service, anywhere on the internet). The dispatch mode is determined per-actor by whether a `webhook_url` is configured — not by actor type.

---

## Overview

```
User clicks "Run" on a task
        │
        ▼
POST /tasks/{id}/run
        │
        ▼
actor_executor.execute_task()
        │
        ├── actor.webhook_url is set? ──YES──► _dispatch_external_agent()
        │                                             │
        │                                             ▼
        │                                      POST {webhook_url}
        │                                      (fire-and-forget, 10s timeout)
        │                                             │
        │                                      Agent processes async
        │                                             │
        │                                             ▼
        │                                      POST /agents/callback
        │                                             │
        │                                             ▼
        │                                      task → done, deliverable saved
        │
        └── no webhook_url ──────────────────► Built-in AI provider (Claude/GPT)
                                                      │
                                                      ▼
                                              deliverable saved, task → done
```

---

## Built-in AI Actors

Standard actors with a `model` field (`gpt-4o`, `claude-opus-4-5`, etc.) and no `webhook_url`. The backend calls the AI provider directly, streams the response, parses any `###FILES###` block, creates a GitHub PR if files are present, and saves the deliverable.

**Actor fields used:** `type`, `model`, `capabilities`

---

## External Webhook Actors

Any actor — regardless of `type` — that has a `webhook_url` set will be dispatched externally. This lets you point an AI actor at your own service without changing its type.

### 1. Dispatch (OwnFlow → Agent)

When a task is run, OwnFlow:

1. Generates a one-time `callback_token` (`secrets.token_hex(32)`)
2. Stores it on the task alongside `agent_dispatched_at`
3. Sets task `status = in_progress`
4. Resolves the GitHub connection for the project (token + repo)
5. POSTs to `actor.webhook_url` with a 10-second timeout (fire-and-forget)

**Dispatch payload:**

```json
{
  "task_id": "uuid",
  "callback_url": "https://ownflow.21century.tech/api/agents/callback",
  "callback_token": "64-char hex string",
  "task": {
    "title": "Implement user authentication",
    "description": "...",
    "type": "code",
    "priority": "high"
  },
  "project": {
    "name": "My SaaS",
    "brief": "A project management tool for..."
  },
  "github": {
    "repo": "owner/repo",
    "token": "ghp_..."
  }
}
```

If `actor.agent_api_key` is set, it is sent as `X-Api-Key: <key>` in the request headers.

If the POST fails (network error, timeout, non-2xx), the task stays `in_progress` and the error is logged to `ai_logs`. The agent can still call back later using the stored token.

### 2. Callback (Agent → OwnFlow)

When the agent finishes, it calls back:

```
POST /agents/callback
Authorization: Bearer <callback_token>
Content-Type: application/json
```

**Callback body:**

```json
{
  "task_id": "uuid",
  "content": "Markdown deliverable — summary, explanation, etc.",
  "files": [
    { "path": "src/auth.py", "content": "# full file content" },
    { "path": "tests/test_auth.py", "content": "# full test content" }
  ]
}
```

`files` is optional. If omitted, no PR is created.

**OwnFlow then:**

1. Validates `Bearer <callback_token>` against `tasks.agent_callback_token` using constant-time comparison
2. Saves the deliverable to `deliverables`
3. Sets task `status = done`, clears the callback token (one-time use)
4. If `files` provided: attempts to create a GitHub PR via the project's connected repo
5. Returns `{"ok": true, "task_id": "..."}`

---

## Senior Developer Agent

A reference implementation lives in [`agents/senior_dev/`](../agents/senior_dev/).

It runs as a standalone FastAPI service and implements the full external agent contract:

| Step | What happens |
|------|-------------|
| Receive `POST /run` | Validates `X-Api-Key`, returns `202 Accepted` immediately |
| Call Claude | Sends task + project brief to `claude-opus-4-5` with a senior-dev system prompt |
| Parse files | Extracts the `###FILES###` JSON block from the response |
| Create GitHub PR | Creates a branch, commits files via GitHub REST API, opens a PR |
| Callback | POSTs deliverable + agent logs to `callback_url` with `Bearer <callback_token>` |

**To run locally:**

```bash
cd agents/senior_dev
cp .env.example .env          # fill in ANTHROPIC_API_KEY
pip install -r requirements.txt
uvicorn main:app --port 8080
```

**To register in OwnFlow:** add an actor with webhook URL `http://localhost:8080/run` and set the API key field to match `AGENT_API_KEY` in your `.env`.

---

## Security

| Concern | Mitigation |
|---------|-----------|
| Forged callbacks | `callback_token` is 32 random bytes, compared with `secrets.compare_digest` (timing-safe) |
| Token reuse | Token is cleared from the task on first successful callback |
| Unauthenticated dispatch | `AGENT_API_KEY` header check on the agent side |
| Token leakage | `agent_callback_token` is never returned by any list/read API endpoint |

---

## Database columns

**`actors` table:**

| Column | Type | Purpose |
|--------|------|---------|
| `webhook_url` | `text` | URL OwnFlow POSTs tasks to |
| `agent_api_key` | `text` | Sent as `X-Api-Key` header on dispatch |

**`tasks` table:**

| Column | Type | Purpose |
|--------|------|---------|
| `agent_callback_token` | `text` | One-time token validating the callback |
| `agent_dispatched_at` | `timestamptz` | When the task was dispatched |

Migration: `supabase/migrations/014_external_agents.sql`
