from __future__ import annotations

import asyncio
import ipaddress
import json
import secrets
import socket
from urllib.parse import urlparse
import docker
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


async def _assert_safe_webhook_url(url: str) -> None:
    """SSRF guard: reject non-http(s) schemes and private/loopback/reserved destinations.

    The dispatch payload contains a GitHub access token, so we must ensure it
    cannot be exfiltrated to an internal service via a crafted webhook_url.
    """
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise ValueError(f"webhook_url scheme must be http or https, got {parsed.scheme!r}")
    hostname = parsed.hostname
    if not hostname:
        raise ValueError("webhook_url has no resolvable hostname")

    loop = asyncio.get_running_loop()
    try:
        infos = await loop.run_in_executor(None, socket.getaddrinfo, hostname, None)
    except socket.gaierror as exc:
        raise ValueError(f"webhook_url hostname could not be resolved: {exc}")

    for info in infos:
        addr = info[4][0]
        try:
            ip = ipaddress.ip_address(addr)
        except ValueError:
            continue
        if (
            ip.is_private
            or ip.is_loopback
            or ip.is_link_local
            or ip.is_multicast
            or ip.is_reserved
            or ip.is_unspecified
        ):
            raise ValueError(
                f"webhook_url resolves to a non-routable address ({ip}); "
                "dispatching to private/loopback/link-local hosts is not permitted"
            )


async def _dispatch_external_agent(task: dict, actor: dict, project: dict, db) -> dict:
    """Fire-and-forget dispatch to an external webhook agent."""
    webhook_url = actor.get("webhook_url")
    if not webhook_url:
        raise ValueError(f"External actor '{actor['name']}' has no webhook_url configured.")

    # SSRF guard: validate scheme and reject private/internal destinations before
    # sending a payload that contains a GitHub access token.
    try:
        await _assert_safe_webhook_url(webhook_url)
    except ValueError as exc:
        db.table("ai_logs").insert({
            "id": str(uuid.uuid4()),
            "project_id": project["id"],
            "phase": "external_dispatch",
            "message": f"Blocked dispatch to '{actor['name']}': {exc}",
            "level": "error",
        }).execute()
        return {"task_id": task["id"], "dispatched": False, "actor": actor["name"], "error": str(exc)}

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
    agent_api_key = actor.get("agent_api_key")
    if not agent_api_key:
        company_id = project.get("company_id")
        if not company_id and project.get("team_id"):
            team_resp = (
                db.table("teams")
                .select("company_id")
                .eq("id", project["team_id"])
                .single()
                .execute()
            )
            company_id = (team_resp.data or {}).get("company_id")
        if company_id:
            company_agent_resp = (
                db.table("company_agents")
                .select("agent_api_key")
                .eq("company_id", company_id)
                .eq("webhook_url", webhook_url)
                .limit(1)
                .execute()
            )
            first = (company_agent_resp.data or [None])[0]
            if isinstance(first, dict):
                agent_api_key = first.get("agent_api_key")

    if agent_api_key:
        headers["X-Api-Key"] = agent_api_key

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(webhook_url, json=payload, headers=headers)
        if resp.status_code >= 400:
            db.table("ai_logs").insert({
                "id": str(uuid.uuid4()),
                "project_id": project["id"],
                "phase": "external_dispatch",
                "message": f"Dispatch to external agent '{actor['name']}' returned HTTP {resp.status_code}: {resp.text[:200]}",
                "level": "error",
            }).execute()
            return {"task_id": task["id"], "dispatched": False, "actor": actor["name"], "error": f"HTTP {resp.status_code}"}
    except Exception as exc:
        # Don't fail hard — task is already in_progress; agent may retry
        db.table("ai_logs").insert({
            "id": str(uuid.uuid4()),
            "project_id": project["id"],
            "phase": "external_dispatch",
            "message": f"Dispatch to external agent '{actor['name']}' failed: {exc}",
            "level": "error",
        }).execute()
        return {"task_id": task["id"], "dispatched": False, "actor": actor["name"], "error": str(exc)}

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

    payload_json = json.dumps(payload)

    # Log a warning for very large payloads (> 64 KB) so operators can
    # investigate bloated project briefs or task descriptions.
    _PAYLOAD_WARN_BYTES = 64 * 1024
    if len(payload_json.encode()) > _PAYLOAD_WARN_BYTES:
        db.table("ai_logs").insert({
            "id": str(uuid.uuid4()),
            "project_id": project["id"],
            "phase": "docker_dispatch",
            "message": (
                f"Payload for task '{task['title']}' is "
                f"{len(payload_json.encode()):,} bytes — larger than expected. "
                "Consider trimming project brief or task description."
            ),
            "level": "warning",
        }).execute()

    # Build env dict for the container.  Passing env as a dict to the Docker
    # SDK sends it over the Docker Engine API (unix socket / TCP) — no shell
    # expansion, no ARG_MAX exposure, no docker CLI binary required in the image.
    env = {"PAYLOAD": payload_json}
    if openai_key:
        env["OPENAI_API_KEY"] = openai_key
    if anthropic_key:
        env["ANTHROPIC_API_KEY"] = anthropic_key

    def _run_container() -> str:
        client = docker.from_env()
        container = client.containers.run(
            image,
            detach=True,
            remove=True,
            environment=env,
        )
        return container.id

    loop = asyncio.get_running_loop()
    try:
        container_id = await loop.run_in_executor(None, _run_container)
    except docker.errors.ImageNotFound:
        db.table("ai_logs").insert({
            "id": str(uuid.uuid4()),
            "project_id": project["id"],
            "phase": "docker_dispatch",
            "message": f"docker image '{image}' not found",
            "level": "error",
        }).execute()
        return {"task_id": task["id"], "dispatched": False, "via": "docker", "actor": actor["name"], "error": f"image not found: {image}"}
    except docker.errors.APIError as exc:
        db.table("ai_logs").insert({
            "id": str(uuid.uuid4()),
            "project_id": project["id"],
            "phase": "docker_dispatch",
            "message": f"Docker API error launching '{image}': {exc}",
            "level": "error",
        }).execute()
        return {"task_id": task["id"], "dispatched": False, "via": "docker", "actor": actor["name"], "error": str(exc)}

    return {"task_id": task["id"], "dispatched": True, "via": "docker", "actor": actor["name"], "container_id": container_id}


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
    """Async generator yielding SSE text chunks.

    Routing mirrors execute_task():
    - Webhook actors  → dispatched externally; yields a single status event.
    - All other actors → run in-process with company-level AI key resolution.
    """
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

    # ── External webhook actor: dispatch and return a single status event ───────
    if actor.get("webhook_url"):
        result = await _dispatch_external_agent(task, actor, project, db)
        yield json.dumps(result)
        return

    # ── In-process streaming: resolve company-level AI keys ────────────────────
    settings = get_settings()
    company_resp = (
        db.table("companies")
        .select("openai_api_key, anthropic_api_key")
        .eq("id", project["company_id"])
        .single()
        .execute()
    )
    company = company_resp.data or {}
    model = actor.get("model") or "gpt-4o"

    if model.startswith("claude"):
        api_key = company.get("anthropic_api_key") or settings.anthropic_api_key
    else:
        api_key = company.get("openai_api_key") or settings.openai_api_key

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

    provider = get_provider(model, api_key=api_key)

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
