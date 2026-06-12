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
from app.exceptions import AiLimitReachedError

# Role → Docker image mapping for built-in agent types.
# Resolution order: actor.docker_image (explicit) → role-based → "default" entry
ROLE_IMAGE_MAP: dict[str, str] = {
    "default": "ownflow-agent:latest",
    "ui/ux designer": "ownflow-figma-agent:latest",
    "business analyst": "ownflow-docs-agent:latest",
}

def _resolve_builtin_image(actor: dict, default_image: str) -> str:
    """Return the Docker image to use for a built-in actor dispatch."""
    # Explicit per-actor override wins
    if actor.get("docker_image"):
        return actor["docker_image"]
    # Role-based lookup; fall back to ROLE_IMAGE_MAP["default"], then server setting
    role = (actor.get("role") or "").strip().lower()
    return ROLE_IMAGE_MAP.get(role, ROLE_IMAGE_MAP.get("default", default_image))


def _resolve_company_id(project: dict, db) -> str | None:
    """Resolve company_id for a project via its team (projects has no company_id column)."""
    team_id = project.get("team_id")
    if not team_id:
        return None
    resp = db.table("teams").select("company_id").eq("id", team_id).single().execute()
    return (resp.data or {}).get("company_id")


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

    # Check AI prompt limit before dispatching to external agent
    from app.services.usage_guard import check_and_increment
    try:
        check_and_increment(project["id"])
    except AiLimitReachedError as exc:
        return {
            "type": "error",
            "message": str(exc),
            "task_id": task.get("id"),
            "dispatched": False,
            "actor": actor.get("name"),
        }

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
            "task_id": task["id"],
            "phase": 2,
            "message": f"Blocked dispatch to '{actor['name']}': {exc}",
            "level": 3,
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

    db.table("ai_logs").insert({
        "id": str(uuid.uuid4()),
        "project_id": project["id"],
        "task_id": task["id"],
        "phase": 2,
        "message": f"Dispatching to external agent '{actor['name']}' at {webhook_url}",
        "level": 1,
    }).execute()

    backend_url = settings.backend_url or "https://ownflow.21century.tech/api"
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
                "task_id": task["id"],
                "phase": 2,
                "message": f"Dispatch to external agent '{actor['name']}' returned HTTP {resp.status_code}: {resp.text[:200]}",
                "level": 3,
            }).execute()
            return {"task_id": task["id"], "dispatched": False, "actor": actor["name"], "error": f"HTTP {resp.status_code}"}
    except Exception as exc:
        # Don't fail hard — task is already in_progress; agent may retry
        db.table("ai_logs").insert({
            "id": str(uuid.uuid4()),
            "project_id": project["id"],
            "task_id": task["id"],
            "phase": 2,
            "message": f"Dispatch to external agent '{actor['name']}' failed: {exc}",
            "level": 3,
        }).execute()
        return {"task_id": task["id"], "dispatched": False, "actor": actor["name"], "error": str(exc)}

    return {"task_id": task["id"], "dispatched": True, "actor": actor["name"]}


async def _dispatch_docker_agent(task: dict, actor: dict, project: dict, db) -> dict:
    """Spawn the built-in ownflow-agent Docker container for this task."""
    # Check AI prompt limit before spawning the container
    from app.services.usage_guard import check_and_increment
    try:
        check_and_increment(project["id"])
    except AiLimitReachedError as exc:
        return {
            "type": "error",
            "message": str(exc),
            "task_id": task.get("id"),
            "dispatched": False,
            "actor": actor.get("name"),
        }

    settings = get_settings()
    callback_token = secrets.token_hex(32)
    now = datetime.now(timezone.utc).isoformat()

    update_resp = db.table("tasks").update({
        "status": "in_progress",
        "agent_callback_token": callback_token,
        "agent_dispatched_at": now,
    }).eq("id", task["id"]).execute()
    print(f"[dispatch] task update: count={update_resp.count}", flush=True)

    db.table("ai_logs").insert({
        "id": str(uuid.uuid4()),
        "project_id": project["id"],
        "task_id": task["id"],
        "phase": 3,
        "message": f"Spawning built-in Docker agent '{actor['name']}' for task",
        "level": 1,
    }).execute()

    backend_url = settings.backend_url or "https://ownflow.21century.tech/api"
    github_conn = await get_connection_for_project(project["id"])

    # Prefer company-level AI keys; fall back to server-level keys
    company_id = _resolve_company_id(project, db)
    company_resp = (
        db.table("companies")
        .select("openai_api_key, anthropic_api_key")
        .eq("id", company_id)
        .single()
        .execute()
    ) if company_id else None
    company = (company_resp.data if company_resp else None) or {}

    # Create Figma file for design tasks
    figma_file_key = None
    if task.get("type") == "design":
        extra_env_data = actor.get("extra_env") or {}
        if isinstance(extra_env_data, str):
            try:
                extra_env_data = json.loads(extra_env_data)
            except json.JSONDecodeError:
                extra_env_data = {}
        if isinstance(extra_env_data, dict):
            figma_file_key = extra_env_data.get("FIGMA_FILE_KEY")
            if figma_file_key:
                db.table("ai_logs").insert({
                    "id": str(uuid.uuid4()),
                    "project_id": project["id"],
                    "task_id": task["id"],
                    "phase": 3,
                    "message": f"Figma file_key resolved from actor config: {figma_file_key}",
                    "level": 1,
                }).execute()

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
        "figma": {
            "file_key": figma_file_key,
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

    # Per-actor override → role-based default → server default
    image = _resolve_builtin_image(actor, settings.builtin_agent_image)

    payload_json = json.dumps(payload)

    # Log a warning for very large payloads (> 64 KB) so operators can
    # investigate bloated project briefs or task descriptions.
    _PAYLOAD_WARN_BYTES = 64 * 1024
    if len(payload_json.encode()) > _PAYLOAD_WARN_BYTES:
        db.table("ai_logs").insert({
            "id": str(uuid.uuid4()),
            "project_id": project["id"],
            "task_id": task["id"],
            "phase": 3,
            "message": (
                f"Payload for task '{task['title']}' is "
                f"{len(payload_json.encode()):,} bytes — larger than expected. "
                "Consider trimming project brief or task description."
            ),
            "level": 2,
        }).execute()

    # Build env dict for the container.  Passing env as a dict to the Docker
    # SDK sends it over the Docker Engine API (unix socket / TCP) — no shell
    # expansion, no ARG_MAX exposure, no docker CLI binary required in the image.
    env = {"PAYLOAD": payload_json}
    if openai_key:
        env["OPENAI_API_KEY"] = openai_key
    if anthropic_key:
        env["ANTHROPIC_API_KEY"] = anthropic_key

    # FIX: Inject per-actor extra env vars (e.g. FIGMA_TOKEN set at company level)
    # Parse JSON string if extra_env is stored as string in DB
    extra_env = actor.get("extra_env") or {}
    if isinstance(extra_env, str):
        try:
            extra_env = json.loads(extra_env)
        except json.JSONDecodeError:
            extra_env = {}
    if isinstance(extra_env, dict):
        for k, v in extra_env.items():
            if k and isinstance(v, str):
                env[str(k)] = v

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
            "task_id": task["id"],
            "phase": 3,
            "message": f"docker image '{image}' not found",
            "level": 3,
        }).execute()
        return {"task_id": task["id"], "dispatched": False, "via": "docker", "actor": actor["name"], "error": f"image not found: {image}"}
    except docker.errors.APIError as exc:
        db.table("ai_logs").insert({
            "id": str(uuid.uuid4()),
            "project_id": project["id"],
            "task_id": task["id"],
            "phase": 3,
            "message": f"Docker API error launching '{image}': {exc}",
            "level": 3,
        }).execute()
        return {"task_id": task["id"], "dispatched": False, "via": "docker", "actor": actor["name"], "error": str(exc)}

    except docker.errors.DockerException as exc:
        error_msg = f"Docker unavailable or error: {str(exc)}"
        db.table("ai_logs").insert({
            "id": str(uuid.uuid4()),
            "project_id": project["id"],
            "task_id": task["id"],
            "phase": 3,
            "message": error_msg,
            "level": 3,
        }).execute()
        return {"task_id": task["id"], "dispatched": False, "via": "docker", "actor": actor["name"], "error": error_msg}
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

    def _log(msg: str, level: int = 1) -> None:
        try:
            db.table("ai_logs").insert({
                "id": str(uuid.uuid4()),
                "project_id": project["id"],
                "task_id": task_id,
                "phase": 4,
                "message": msg,
                "level": level,
            }).execute()
        except Exception:
            pass

    # ── External webhook actor: dispatch and return a single status event ───────
    if actor.get("webhook_url"):
        result = await _dispatch_external_agent(task, actor, project, db)
        if isinstance(result, dict):
            message = result.get("message")
            yield message if isinstance(message, str) and message else json.dumps(result, ensure_ascii=False)
        else:
            yield str(result)
        return

    # ── Docker agent dispatch ────────────────────────────────────────────────
    # Only dispatch to Docker if the actor has an explicit docker_image set.
    # Actors with a model configured (e.g. claude-haiku-4-5) should run
    # in-process so the user gets real-time streaming.
    if actor.get("docker_image"):
        result = await _dispatch_docker_agent(task, actor, project, db)
        yield f"Docker agent dispatched: {result}"
        return

    # ── In-process streaming: resolve company-level AI keys ────────────────────
    settings = get_settings()
    company_id = _resolve_company_id(project, db)
    company_resp = (
        db.table("companies")
        .select("openai_api_key, anthropic_api_key")
        .eq("id", company_id)
        .single()
        .execute()
    ) if company_id else None
    company = (company_resp.data if company_resp else None) or {}
    model = actor.get("model") or "gpt-4o"

    if model.startswith("claude"):
        api_key = company.get("anthropic_api_key") or settings.anthropic_api_key
    else:
        api_key = company.get("openai_api_key") or settings.openai_api_key

    actor_name = actor.get("name", actor_id)
    _log(f"Starting in-process stream: actor='{actor_name}' model={model} task='{task['title']}'", level=0)
    _log(f"API key present={bool(api_key)} company_id={company_id}", level=0)

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

    # Check AI prompt limit before calling the provider
    from app.services.usage_guard import check_and_increment
    try:
        check_and_increment(project["id"])
    except AiLimitReachedError as e:
        yield json.dumps({"type": "error", "message": str(e)})
        return

    _log(f"Calling AI provider (model={model})…", level=1)
    t0 = datetime.now(timezone.utc)
    provider = get_provider(model, api_key=api_key)

    full_content = []
    try:
        async for chunk in provider.stream(messages):
            full_content.append(chunk)
            yield chunk
    except Exception as exc:
        _log(f"AI provider stream failed: {type(exc).__name__}: {exc}", level=3)
        raise

    final_content = "".join(full_content)
    elapsed = (datetime.now(timezone.utc) - t0).total_seconds()
    _log(f"AI responded in {elapsed:.1f}s — {len(final_content)} chars", level=1)

    # Persist full prompt + response
    try:
        db.table("ai_messages").insert({
            "id": str(uuid.uuid4()),
            "project_id": project["id"],
            "task_id": task_id,
            "actor_id": actor_id,
            "phase": 4,
            "model": model,
            "messages": messages,
            "response": final_content,
        }).execute()
    except Exception:
        pass

    # Persist deliverable after stream completes
    files_data = None
    files_marker = final_content.find("###FILES###")
    if files_marker != -1:
        after_marker = final_content[files_marker + len("###FILES###"):].strip()
        arr_start = after_marker.find("[")
        if arr_start != -1:
            try:
                parsed, _ = json.JSONDecoder().raw_decode(after_marker, arr_start)
                if isinstance(parsed, list) and all(
                    "path" in item and "content" in item for item in parsed
                ):
                    files_data = parsed
            except json.JSONDecodeError:
                pass

    row = {
        "id": str(uuid.uuid4()),
        "task_id": task_id,
        "actor_id": actor_id,
        "content": final_content,
        "files": files_data,
        "tool_calls_log": [],
        "created_at": datetime.utcnow().isoformat(),
    }
    db.table("deliverables").insert(row).execute()
    db.table("tasks").update({"status": "review"}).eq("id", task_id).execute()
    _log("Deliverable saved — task moved to review", level=1)

    # Create GitHub PR if connected
    try:
        _log(f"[PR] Attempting PR for task_id={task_id} project_id={project['id']}", level=0)
        conn = await get_connection_for_project(project["id"])
        if not conn:
            _log("[PR] No GitHub connection — skipping PR", level=2)
        else:
            pr_url = await create_pr_for_task(task_id, task["title"], final_content)
            if pr_url:
                _log(f"[PR] PR created: {pr_url}", level=1)
            else:
                _log("[PR] create_pr_for_task returned None — check github_service logs", level=2)
    except Exception as exc:
        import traceback
        _log(f"[PR] ERROR {type(exc).__name__}: {exc}\n{traceback.format_exc()}", level=3)
