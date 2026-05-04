# Agent Flow

## Architecture: OwnFlow app vs Agent workers

**OwnFlow** is a normal web application — always running, owns the database, handles auth, UI, billing, and GitHub connections.

**Agent workers** are ephemeral Docker containers — spawned per task by the OwnFlow API via the Docker daemon, do their work, report back via HTTP, and are destroyed. They have zero standing access to OwnFlow's database or infrastructure.

```
┌──────────────────────────────────────────────┐
│                 OwnFlow app                  │
│  • Always running                            │
│  • PostgreSQL / Supabase (service role)      │
│  • Auth, UI, billing                         │
│  • GitHub connection registry                │
│  • Dispatches tasks → Docker, receives results│
└──────────────┬───────────────────────────────┘
               │
               ▼
        Docker daemon
               │
               │  docker run ownflow-agent  (per task)
               │
       ┌───────▼──────────────────────┐
       │   Agent container            │
       │  • Ephemeral — one per task  │
       │  • No DB access              │
       │  • Gets task via env/payload │
       │  • POSTs result to callback  │
       │  • Destroyed on exit         │
       └──────────────────────────────┘
```

Agent containers communicate with OwnFlow exclusively over HTTP:
- They receive everything they need in the dispatch payload (passed as env vars or startup args)
- They report back via a one-time callback token
- They never hold credentials to OwnFlow's database

---

## Dispatch flow

```
User clicks "Run" on a task
        │
        ▼
POST /tasks/{task_id}/execute  (OwnFlow API)
        │
        ▼
actor_executor.execute_task()
        │
        ├── actor.webhook_url set? ──YES──► _dispatch_external_agent()
        │                                  OwnFlow POSTs payload to webhook_url
        │                                  (fire-and-forget, 10s timeout)
        │                                          │
        │                                  Worker receives task, runs async
        │                                          │
        │                                  Worker POSTs result to /agents/callback
        │                                          │
        │                                  OwnFlow saves deliverable, task → done
        │
        └── no webhook_url ─────────────► _dispatch_docker_agent()
                                           docker run ownflow-agent:latest
                                                   │
                                           Container calls AI provider
                                                   │
                                           Container POSTs to /agents/callback
                                                   │
                                           OwnFlow saves deliverable, task → done
```

Dispatch is driven by `webhook_url` presence alone — not by actor type.

---

## Built-in execution (Docker)

When no `webhook_url` is set, OwnFlow spawns [`agents/builtin/`](../agents/builtin/) as an ephemeral Docker container via `docker run`. The container follows the same callback contract as any other agent worker — it has no DB access and communicates only via `POST /agents/callback`.

In production, OwnFlow uses `tecnativa/docker-socket-proxy` between backend and Docker Engine. This avoids mounting the raw Docker socket inside the backend container and limits Docker API exposure to explicitly enabled endpoints.

`_dispatch_docker_agent()` in `actor_executor.py`:

1. Generates a one-time `callback_token`, sets task `status = in_progress`
2. Resolves the GitHub connection for the project
3. Looks up company-level AI keys (`openai_api_key` / `anthropic_api_key`), falls back to server-level keys
4. Runs: `docker run --rm -d -e PAYLOAD=<json> [-e OPENAI_API_KEY=...] [-e ANTHROPIC_API_KEY=...] ownflow-agent:latest`
5. Container reads `PAYLOAD`, calls the AI provider, optionally creates a GitHub PR, POSTs back to `callback_url`, then exits

If `docker run` fails (non-zero exit), the error is logged to `ai_logs` and the task stays `in_progress`.

**Build the image:**

```bash
docker build -t ownflow-agent:latest agents/builtin/
```

**Override the image name** via `BUILTIN_AGENT_IMAGE` in `backend/.env`.

---

## Webhook agents (external workers)

Any actor with a `webhook_url` is dispatched to an external worker — a container, serverless function, or local process controlled by the actor owner. OwnFlow fires the dispatch and waits for the callback; it doesn't manage the container lifecycle.

### 1. Dispatch (OwnFlow → worker)

OwnFlow:

1. Generates a one-time `callback_token` (`secrets.token_hex(32)`)
2. Stores it on the task alongside `agent_dispatched_at`, sets `status = in_progress`
3. Resolves the GitHub connection for the project
4. POSTs to `actor.webhook_url` (fire-and-forget, 10s timeout)

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

If `actor.agent_api_key` is set, OwnFlow sends `X-Api-Key: <key>` in the request headers so the worker can authenticate the call.

If the POST fails (network error, timeout, non-2xx), the task stays `in_progress` and the error is logged. The worker can still call back later using the stored token.

### 2. Callback (worker → OwnFlow)

When the worker finishes, it calls back:

```
POST /agents/callback
Authorization: Bearer <callback_token>
Content-Type: application/json
```

**Body:**

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

1. Validates `Bearer <callback_token>` against `tasks.agent_callback_token` (constant-time comparison)
2. Saves deliverable to `deliverables`
3. Sets task `status = done`, clears the token (one-time use)
4. If `files` provided: creates a GitHub PR via the project's connected repo
5. Returns `{"ok": true, "task_id": "..."}`

---

## Reference implementation: Senior Developer Agent

[`agents/senior_dev/`](../agents/senior_dev/) is a reference worker — a standalone FastAPI service packaged as a Docker image. It implements the full webhook contract: receives a task, calls Claude, creates a GitHub PR, and callbacks.

| Step | What happens |
|------|-------------|
| Receive `POST /run` | Validates `X-Api-Key`, spawns async task, returns `202 Accepted` immediately |
| Call Claude | Sends task + project brief to `claude-haiku-4-5` with a senior-dev system prompt |
| Parse files | Extracts the `###FILES###` JSON block from the response |
| Create GitHub PR | Creates branch, commits files via GitHub REST API, opens a PR |
| Callback | POSTs deliverable to `callback_url` with `Bearer <callback_token>` |

**To run locally:**

```bash
cd agents/senior_dev
cp .env.example .env          # fill in ANTHROPIC_API_KEY and AGENT_API_KEY
pip install -r requirements.txt
uvicorn main:app --port 8080
```

**To register:** in the OwnFlow Agents page, add an agent with webhook URL `http://localhost:8080/run` and API key matching `AGENT_API_KEY` in your `.env`. Then assign that agent as an actor on a project.

---

## Security

| Concern | Mitigation |
|---------|-----------|
| Forged callbacks | `callback_token` is 32 random bytes, compared with `secrets.compare_digest` (timing-safe) |
| Token reuse | Token is cleared on first successful callback |
| Unauthenticated dispatch | `AGENT_API_KEY` header verified on the worker side |
| Token leakage | `agent_callback_token` is never returned by any read API |
| Container isolation | Workers have no DB credentials — all state flows through the callback API |

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



---

## Overview

```
User clicks "Run" on a task
        │
        ▼
POST /tasks/{task_id}/execute
        │
        ▼
actor_executor.execute_task()
        │
        ├── actor.webhook_url is set? ──YES──► _dispatch_webhook_agent()
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
        └── no webhook_url ──────────────────► Built-in agent (default AI provider)
                                                      │
                                                      ▼
                                              deliverable saved, task → done
```

---

## Built-in Agents

Actors without a `webhook_url` are executed by OwnFlow's default built-in agent. These are **not** tied to OwnFlow — they are standard AI providers (OpenAI, Anthropic, etc.) called via a thin provider abstraction. Any actor can be swapped to an external webhook agent at any time by setting `webhook_url`, with no other changes required. The full default flow:

1. `actor_executor.execute_task()` loads the task, actor, project, and any prior deliverables
2. Builds a prompt: project brief + task title/description/type/priority + prior deliverables
3. Selects the provider via `get_provider(actor.model)` (defaults to `gpt-4o`)
4. Calls `provider.complete(messages)` with the `EXECUTOR_SYSTEM` prompt
5. Persists the full prompt + response to `ai_messages` and logs to `ai_logs`
6. Saves the response as a deliverable in `deliverables`, sets task `status = done`
7. If the response contains a `###FILES###` JSON block: attempts to create a GitHub PR via the project's connected repo

**`###FILES###` format** (appended after narrative in the model response):

```
###FILES###
[
  {"path": "src/auth/login.py", "content": "# full file content"},
  {"path": "tests/test_login.py", "content": "import pytest\n..."}
]
```

**Actor fields used:** `model`, `webhook_url` (absence triggers this path)

---

## Webhook Actors

Any actor that has a `webhook_url` set will be dispatched via webhook. This lets you point any actor at your own service without changing its type.

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
| Call Claude | Sends task + project brief to `claude-haiku-4-5` with a senior-dev system prompt |
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
