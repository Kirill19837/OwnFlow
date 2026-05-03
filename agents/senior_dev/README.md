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

Go to **Team Settings → Agents** and create a new agent:

| Field | Value |
|-------|-------|
| Name | Senior Developer |
| Role | Lead Developer |
| Webhook URL | `https://your-agent-host/run` |
| API key | value of `AGENT_API_KEY` in your `.env` |

Once registered, assign this agent as an actor on any project. OwnFlow dispatches tasks to the webhook URL automatically when the actor has one set; actors without a webhook URL use the built-in Docker runner.

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
