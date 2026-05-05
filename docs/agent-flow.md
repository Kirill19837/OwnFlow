# Agent Flow

## Architecture: OwnFlow app vs agent workers

**OwnFlow** is a normal web application — always running, owns the database, handles auth, UI, billing, and GitHub connections.

**Agent workers** are execution backends — either ephemeral Docker containers spawned per task, or external services reached via webhook. They have zero standing access to OwnFlow's database and communicate exclusively over HTTP.

```
┌──────────────────────────────────────────────────┐
│                  OwnFlow app                     │
│  • Always running                                │
│  • PostgreSQL / Supabase (service role)          │
│  • Auth, UI, billing                             │
│  • GitHub connection registry                    │
│  • Dispatches tasks → Docker or webhook          │
│  • Receives results via /agents/callback         │
└──────────────┬───────────────────────────────────┘
               │
      ┌────────┴──────────┐
      │                   │
      ▼                   ▼
  Docker daemon      Webhook URL
      │                   │
  docker run          POST payload
  (per task)          (fire-and-forget)
      │                   │
  ┌───▼──────┐       ┌────▼──────────────┐
  │ Built-in │       │ External agent    │
  │ container│       │ (any HTTP server) │
  └───┬──────┘       └────┬──────────────┘
      │                   │
      └────────┬──────────┘
               │
               ▼
     POST /agents/callback
     (Bearer callback_token)
```

Dispatch mode is determined solely by whether `actor.webhook_url` is set:

| `webhook_url` | Dispatch mode |
|---|---|
| not set | Docker — `_dispatch_docker_agent()` |
| set | Webhook — `_dispatch_external_agent()` |

---

## Dispatch flow

```
User triggers task execution
        │
        ▼
POST /tasks/{task_id}/execute  (OwnFlow API)
        │
        ▼
actor_executor.execute_task()
        │
        ├── actor.webhook_url set?
        │   YES ──► _dispatch_external_agent()
        │             SSRF guard validates URL
        │             OwnFlow POSTs payload to webhook_url (10s timeout)
        │             Worker runs async
        │             Worker POSTs result to /agents/callback
        │
        └── NO ──► _dispatch_docker_agent()
                      Resolves Docker image (per-actor → role-based → default)
                      Resolves AI keys (company → server fallback)
                      docker run --rm -d -e PAYLOAD=<json> <image>
                      Container runs, POSTs to /agents/callback, exits
```

Both paths share the same callback contract.

---

## Docker image resolution

Built-in agents support per-actor and per-role image overrides.

| Source | Wins when |
|---|---|
| `actor.docker_image` | Explicitly set on the actor |
| Role-based (`ROLE_IMAGE_MAP`) | Actor role matches a known key |
| Server default (`BUILTIN_AGENT_IMAGE`) | No match above |

**Built-in role → image map:**

| Role | Image |
|---|---|
| `ui/ux designer` | `ownflow-figma-agent:latest` |
| `business analyst` | `ownflow-docs-agent:latest` |
| _(any other)_ | `ownflow-agent:latest` |

Override the default image via `BUILTIN_AGENT_IMAGE` in `backend/.env`.

**Build the default image:**

```bash
docker build -t ownflow-agent:latest agents/builtin/
```

---

## AI key resolution

Keys are resolved per-dispatch in this priority order:

1. Company-level key (`companies.openai_api_key` / `companies.anthropic_api_key`) via project → team → company chain
2. Server-level key (`OPENAI_API_KEY` / `ANTHROPIC_API_KEY` in backend env)

If neither is available the dispatch fails with an error log.

---

## Built-in execution (Docker)

When no `webhook_url` is set, OwnFlow spawns `agents/builtin/` as an ephemeral container.

`_dispatch_docker_agent()` sequence:

1. Generates a one-time `callback_token` (`secrets.token_hex(32)`), stores it on the task alongside `agent_dispatched_at`, sets `status = in_progress`
2. Resolves the GitHub connection for the project
3. Resolves AI keys (company → server fallback)
4. Runs: `docker run --rm -d -e PAYLOAD=<json> [-e OPENAI_API_KEY=...] [-e ANTHROPIC_API_KEY=...] <image>`
5. Container reads `PAYLOAD`, calls the AI provider, optionally creates a GitHub PR, POSTs back to `/agents/callback`, then exits

If `docker run` fails, the error is logged to `ai_logs` (level=error) and the task stays `in_progress`.

In production, OwnFlow uses `tecnativa/docker-socket-proxy` between backend and Docker Engine to limit Docker API exposure to explicitly enabled endpoints.

---

## Webhook agents (external workers)

Any actor with a `webhook_url` is dispatched to an external service. OwnFlow fires the dispatch and waits for the callback; it does not manage the remote container lifecycle.

### SSRF protection

Before sending the dispatch payload (which contains a GitHub token), OwnFlow resolves the webhook hostname and rejects addresses that are:

- Non-`http`/`https` schemes
- Loopback, private, link-local, multicast, or reserved IP ranges

Blocked dispatches are logged as `level=3` errors and the task is **not** set to `in_progress`.

### 1. Dispatch (OwnFlow → worker)

1. SSRF guard validates the URL
2. Generates a one-time `callback_token`, stores it on the task, sets `status = in_progress`
3. Resolves GitHub connection for the project
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
  },
  "actor": {
    "name": "Aria",
    "role": "Backend Developer",
    "capabilities": []
  }
}
```

If `actor.agent_api_key` is set, OwnFlow sends `X-Api-Key: <key>` in the request headers.

If the POST fails (network error, timeout, non-2xx), the task stays `in_progress` and the error is logged. The worker can still call back later using the stored token.

### 2. Callback (worker → OwnFlow)

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

## Company agent templates

Company admins can define reusable agent templates in **Settings → Agents**. When an actor is created from a template (`company_agent_id` in the create request), OwnFlow copies the template's `webhook_url`, `docker_image`, `agent_api_key`, and `extra_env` onto the actor. The template is not re-read at dispatch time — the actor is fully self-contained after creation.

Templates are scoped to a company and can only be applied to projects within that company.

---

## Reference implementation: Senior Developer Agent

`agents/senior_dev/` is a reference webhook worker — a standalone FastAPI service packaged as a Docker image. It implements the full webhook contract.

| Step | What happens |
|---|---|
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

**To register:** in the OwnFlow Agents page, add a company agent with webhook URL `http://localhost:8080/run` and the API key matching `AGENT_API_KEY` in your `.env`. Assign that agent as an actor on a project.
