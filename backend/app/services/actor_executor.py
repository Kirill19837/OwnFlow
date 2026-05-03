from __future__ import annotations

import asyncio
import json
import secrets
import httpx
from app.db import get_supabase
from app.providers.registry import get_provider
from app.services.github_service import create_pr_for_task, get_connection_for_project
from app.config import get_settings
import uuid
from datetime import datetime, timezone

EXECUTOR_SYSTEM = """You are an AI actor working on a software project.
You will be given a task with its description and project context.
Produce a high-quality, detailed deliverable for the task.
If the task is code-related, write complete, working code with comments.
If the task is research or analysis, provide structured findings.
Format your response in Markdown.

## Code tasks — file output
If the task produces one or more source code files, append a ###FILES### block at the
very end of your response (after all narrative / explanation). The block must be a
valid JSON array where every item has "path" (repo-relative path) and "content"
(full file text). Example:

###FILES###
[
  {"path": "src/auth/login.py", "content": "# Login handler\\n..."},
  {"path": "tests/test_login.py",  "content": "import pytest\\n..."}
]

Only include actual source/config/test files in the ###FILES### block.
Never include binary files or generated lock files.
If the task is not code-related (design, research, review, etc.) omit the ###FILES### block entirely.
"""


async def _dispatch_external_agent(task: dict, actor: dict, project: dict, db) -> dict:
    """Fire-and-forget dispatch to an external webhook agent."""
    webhook_url = actor.get("webhook_url")
    if not webhook_url:
        raise ValueError(f"External actor '{actor['name']}' has no webhook_url configured.")

    settings = get_settings()
    callback_token = secrets.token_hex(32)
    now = datetime.now(timezone.utc).isoformat()

    # Store token + dispatch timestamp so we can validate the callback
    db.table("tasks").update({
        "status": "in_progress",
        "agent_callback_token": callback_token,
        "agent_dispatched_at": now,
    }).eq("id", task["id"]).execute()

    backend_url = settings.backend_url or "https://ownflow.21century.tech/api"

    # Resolve GitHub repo + token for this project (if connected)
    github_conn = await get_connection_for_project(project["id"])

    payload = {
        "task_id": task["id"],
        "callback_url": f"{backend_url.rstrip('/')}/agents/callback",
        "callback_token": callback_token,
        "task": {
            "title": task["title"],
            "description": task.get("description", ""),
            "type": task.get("type", "code"),
            "priority": task.get("priority", "medium"),
        },
        "project": {
            "name": project["name"],
            "brief": project.get("prompt", ""),
        },
        "github": {
            "repo": f"{github_conn['owner']}/{github_conn['repo']}" if github_conn else None,
            "token": github_conn["token"] if github_conn else None,
        },
        "actor": {
            "name": actor.get("name", ""),
            "role": actor.get("role") or "",
            "capabilities": actor.get("capabilities") or [],
        },
    }

    headers = {"Content-Type": "application/json"}
    if actor.get("agent_api_key"):
        headers["X-Api-Key"] = actor["agent_api_key"]

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            await client.post(webhook_url, json=payload, headers=headers)
    except Exception as exc:
        # Don't fail hard — task is already in_progress; agent may retry
        db.table("ai_logs").insert({
            "id": str(uuid.uuid4()),
            "project_id": project["id"],
            "phase": "external_dispatch",
            "message": f"Dispatch to external agent '{actor['name']}' failed: {exc}",
            "level": "error",
        }).execute()

    return {"task_id": task["id"], "dispatched": True, "actor": actor["name"]}


async def _dispatch_docker_agent(task: dict, actor: dict, project: dict, db) -> dict:
    """Spawn the built-in ownflow-agent Docker container for this task."""
    settings = get_settings()
    callback_token = secrets.token_hex(32)
    now = datetime.now(timezone.utc).isoformat()

    db.table("tasks").update({
        "status": "in_progress",
        "agent_callback_token": callback_token,
        "agent_dispatched_at": now,
    }).eq("id", task["id"]).execute()

    backend_url = settings.backend_url or "https://ownflow.21century.tech/api"
    github_conn = await get_connection_for_project(project["id"])

    # Prefer company-level AI keys; fall back to server-level keys
    company_resp = (
        db.table("companies")
        .select("openai_api_key, anthropic_api_key")
        .eq("id", project["company_id"])
        .single()
        .execute()
    )
    company = company_resp.data or {}

    payload = {
        "task_id": task["id"],
        "callback_url": f"{backend_url.rstrip('/')}/agents/callback",
        "callback_token": callback_token,
        "task": {
            "title": task["title"],
            "description": task.get("description", ""),
            "type": task.get("type", "code"),
            "priority": task.get("priority", "medium"),
        },
        "project": {
            "name": project["name"],
            "brief": project.get("prompt", ""),
        },
        "github": {
            "repo": f"{github_conn['owner']}/{github_conn['repo']}" if github_conn else None,
            "token": github_conn["token"] if github_conn else None,
        },
        "model": actor.get("model") or "gpt-4o",
        "actor": {
            "name": actor.get("name", ""),
            "role": actor.get("role") or "",
            "capabilities": actor.get("capabilities") or [],
        },
    }

    openai_key = company.get("openai_api_key") or settings.openai_api_key
    anthropic_key = company.get("anthropic_api_key") or settings.anthropic_api_key

    image = settings.builtin_agent_image
    cmd = ["docker", "run", "--rm", "-d",
           "-e", f"PAYLOAD={json.dumps(payload)}"]
    if openai_key:
        cmd += ["-e", f"OPENAI_API_KEY={openai_key}"]
    if anthropic_key:
        cmd += ["-e", f"ANTHROPIC_API_KEY={anthropic_key}"]
    cmd.append(image)

    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await proc.communicate()

    if proc.returncode != 0:
        db.table("ai_logs").insert({
            "id": str(uuid.uuid4()),
            "project_id": project["id"],
            "phase": "docker_dispatch",
            "message": f"docker run {image} failed: {stderr.decode()[:500]}",
            "level": "error",
        }).execute()

    return {"task_id": task["id"], "dispatched": True, "via": "docker", "actor": actor["name"]}


async def execute_task(task_id: str, actor_id: str) -> dict:
    db = get_supabase()

    task_resp = db.table("tasks").select("*").eq("id", task_id).single().execute()
    task = task_resp.data
    if not task:
        raise ValueError(f"Task {task_id} not found")

    actor_resp = db.table("actors").select("*").eq("id", actor_id).single().execute()
    actor = actor_resp.data
    if not actor:
        raise ValueError(f"Actor {actor_id} not found")

    project_resp = (
        db.table("projects")
        .select("*")
        .eq("id", task["project_id"])
        .single()
        .execute()
    )
    project = project_resp.data

    # ── Webhook agent dispatch ──────────────────────────────────────────────────
    if actor.get("webhook_url"):
        return await _dispatch_external_agent(task, actor, project, db)

    # ── Docker agent dispatch (built-in) ────────────────────────────────────────
    return await _dispatch_docker_agent(task, actor, project, db)


async def stream_task_execution(task_id: str, actor_id: str):
    """Async generator yielding SSE text chunks."""
    db = get_supabase()

    task_resp = db.table("tasks").select("*").eq("id", task_id).single().execute()
    task = task_resp.data

    actor_resp = db.table("actors").select("*").eq("id", actor_id).single().execute()
    actor = actor_resp.data

    project_resp = (
        db.table("projects")
        .select("*")
        .eq("id", task["project_id"])
        .single()
        .execute()
    )
    project = project_resp.data

    messages = [
        {"role": "system", "content": EXECUTOR_SYSTEM},
        {
            "role": "user",
            "content": (
                f"Project: {project['name']}\n"
                f"Brief: {project['prompt']}\n\n"
                f"Task: {task['title']}\n"
                f"{task['description']}"
            ),
        },
    ]

    model = actor.get("model") or "gpt-4o"
    provider = get_provider(model)

    full_content = []
    async for chunk in provider.stream(messages):
        full_content.append(chunk)
        yield chunk

    final_content = "".join(full_content)

    # Persist full prompt + response
    try:
        db.table("ai_messages").insert({
            "id": str(uuid.uuid4()),
            "project_id": project["id"],
            "task_id": task_id,
            "actor_id": actor_id,
            "phase": "task_execution",
            "model": model,
            "messages": messages,
            "response": final_content,
        }).execute()
        db.table("ai_logs").insert({
            "id": str(uuid.uuid4()),
            "project_id": project["id"],
            "phase": "task_execution",
            "message": f"Actor '{actor.get('name', actor_id)}' streamed task: {task['title']}",
            "level": "info",
        }).execute()
    except Exception:
        pass

    # Persist deliverable after stream completes
    row = {
        "id": str(uuid.uuid4()),
        "task_id": task_id,
        "actor_id": actor_id,
        "content": final_content,
        "tool_calls_log": [],
        "created_at": datetime.utcnow().isoformat(),
    }
    db.table("deliverables").insert(row).execute()
    db.table("tasks").update({"status": "done"}).eq("id", task_id).execute()

    # Create GitHub PR if connected
    try:
        await create_pr_for_task(task_id, task["title"], final_content)
    except Exception:
        pass
