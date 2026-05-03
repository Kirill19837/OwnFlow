# Senior Developer Agent

A standalone webhook agent that integrates with OwnFlow to process coding tasks autonomously.

## What it does

1. Receives a task payload from OwnFlow (`POST /run`)
2. Calls Claude (claude-opus-4-5 by default) with the full task + project context
3. Parses generated files from the `###FILES###` block in the response
4. Creates a GitHub branch, commits the files, and opens a PR — automatically, using the project's connected GitHub token
5. POSTs the deliverable + agent logs back to OwnFlow via the callback URL

## Setup

```bash
cp .env.example .env
# Fill in ANTHROPIC_API_KEY, optionally AGENT_API_KEY and MODEL
pip install -r requirements.txt
uvicorn main:app --port 8080
```

Or with Docker:

```bash
docker build -t senior-dev-agent .
docker run -p 8080:8080 --env-file .env senior-dev-agent
```

## Registering in OwnFlow

In a project's settings → Actors, add a new actor:

| Field | Value |
|-------|-------|
| Name | Senior Developer |
| Role | Lead Developer |
| Type | External agent |
| Webhook URL | `https://your-agent-host/run` |
| API key | value of `AGENT_API_KEY` in your `.env` |

When a task is assigned to this actor and "Run" is triggered, OwnFlow will POST the task to the webhook. The agent processes it and the task will automatically move to **Done** with the deliverable attached.

## Payload OwnFlow sends

```json
{
  "task_id": "uuid",
  "callback_url": "https://ownflow.21century.tech/api/agents/callback",
  "callback_token": "hex64",
  "task": { "title": "...", "description": "...", "type": "code", "priority": "high" },
  "project": { "name": "...", "brief": "..." },
  "github": { "repo": "owner/repo", "token": "ghp_..." }
}
```
