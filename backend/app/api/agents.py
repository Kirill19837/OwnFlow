"""External agent callback endpoint.

External agents (and the built-in Docker runner) POST their deliverable here
after processing a task.

Authentication
--------------
Bearer <callback_token> in the Authorization header.  The token is stored in
tasks.agent_callback_token at dispatch time and consumed atomically on the
first successful callback (prevents duplicate deliverables from concurrent
requests with the same token).

PR authority
------------
Agents are the primary PR authority.  If the agent already opened a GitHub PR,
it sends ``pr_url`` in the callback body and omits ``files``.  The handler
only calls ``create_pr_for_task`` when ``files`` is present AND ``pr_url`` is
not set (i.e. the agent had no GitHub connection or its PR failed).
"""
from __future__ import annotations

import secrets
import uuid
from datetime import datetime

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel
from typing import Optional, List

from app.db import get_supabase
from app.services.github_service import create_pr_for_task

router = APIRouter()


class FileEntry(BaseModel):
    path: str
    content: str


class AgentCallbackBody(BaseModel):
    task_id: str
    content: str
    files: Optional[List[FileEntry]] = None
    pr_url: Optional[str] = None            # PR already created by the agent — skips handler-side PR creation
    logs: Optional[List[str]] = None        # structured log lines from the agent
    prompt: Optional[str] = None            # user prompt sent to the model (for ai_messages)
    model: Optional[str] = None             # model used (for ai_messages)


@router.post("/callback")
async def agent_callback(request: Request, body: AgentCallbackBody):
    """
    Called by an external agent when it has finished processing a task.

    Authentication: Bearer <callback_token> in the Authorization header.
    The token must match tasks.agent_callback_token for the given task_id.
    """
    auth_header = request.headers.get("Authorization", "")
    if not auth_header.startswith("Bearer "):
        raise HTTPException(401, "Missing or invalid Authorization header. Expected: Bearer <callback_token>")

    provided_token = auth_header.removeprefix("Bearer ").strip()
    if not provided_token:
        raise HTTPException(401, "Empty callback token.")

    db = get_supabase()

    task_resp = (
        db.table("tasks")
        .select("*, assignments(actor_id)")
        .eq("id", body.task_id)
        .single()
        .execute()
    )
    if not task_resp.data:
        raise HTTPException(404, "Task not found.")

    task = task_resp.data
    stored_token = task.get("agent_callback_token")

    # Constant-time comparison to prevent timing attacks
    if not stored_token or not secrets.compare_digest(provided_token, stored_token):
        raise HTTPException(403, "Invalid callback token.")

    # ── Resolve actor_id before any state change ──────────────────────────────
    # deliverables.actor_id is NOT NULL; fail early (before consuming the token)
    # so the task is not left done-but-deliverable-less if the assignment is missing.
    actor_id = None
    assignments = task.get("assignments")
    if isinstance(assignments, list) and assignments:
        actor_id = assignments[0].get("actor_id")
    elif isinstance(assignments, dict):
        actor_id = assignments.get("actor_id")
    if not actor_id:
        raise HTTPException(400, "No actor assignment found for this task; cannot save deliverable.")

    # ── Atomically consume the token ──────────────────────────────────────────
    # UPDATE ... WHERE id=? AND agent_callback_token=? ensures only the first
    # concurrent request wins. Any duplicate callback finds 0 rows updated.
    consumed = (
        db.table("tasks")
        .update({"status": "done", "agent_callback_token": None})
        .eq("id", body.task_id)
        .eq("agent_callback_token", provided_token)
        .execute()
    )
    if not consumed.data:
        raise HTTPException(409, "Callback token already consumed.")

    # ── Save deliverable ──────────────────────────────────────────────────────
    deliverable_row = {
        "id": str(uuid.uuid4()),
        "task_id": body.task_id,
        "actor_id": actor_id,
        "content": body.content,
        "tool_calls_log": [],
        "created_at": datetime.utcnow().isoformat(),
    }
    db.table("deliverables").insert(deliverable_row).execute()

    # ── Persist agent logs to ai_logs ─────────────────────────────────────────
    if body.logs:
        project_id = task.get("project_id")
        for line in body.logs:
            try:
                db.table("ai_logs").insert({
                    "id": str(uuid.uuid4()),
                    "project_id": project_id,
                    "phase": "agent_execution",
                    "message": line,
                    "level": "error" if "ERROR" in line.upper() or "FAILED" in line.upper() else "info",
                }).execute()
            except Exception:
                pass

    # ── Persist prompt + response to ai_messages ──────────────────────────────
    if body.prompt and body.model:
        project_id = task.get("project_id")
        try:
            db.table("ai_messages").insert({
                "id": str(uuid.uuid4()),
                "project_id": project_id,
                "task_id": body.task_id,
                "actor_id": actor_id,
                "phase": "agent_execution",
                "model": body.model,
                "messages": [{"role": "user", "content": body.prompt}],
                "response": body.content,
            }).execute()
        except Exception:
            pass

    # ── GitHub PR (fallback: only when the agent did not already open one) ─────
    # Agents are the primary PR authority. If body.pr_url is set, the agent
    # already created the PR; creating another one here would produce a duplicate.
    if body.files and not body.pr_url:
        import json
        files_json = [{"path": f.path, "content": f.content} for f in body.files]
        # Strip any existing ###FILES### block the agent may have included in its
        # content, then append a clean one so create_pr_for_task sees exactly one.
        narrative = body.content.split("###FILES###")[0].rstrip()
        content_with_files = narrative + "\n\n###FILES###\n" + json.dumps(files_json, indent=2)
        try:
            await create_pr_for_task(body.task_id, task.get("title", ""), content_with_files)
        except Exception:
            pass

    return {"ok": True, "task_id": body.task_id}
