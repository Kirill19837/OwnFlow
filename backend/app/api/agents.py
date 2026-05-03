"""External agent callback endpoint.

External agents POST their deliverable here after processing a task.
The callback_token (Bearer token) is validated against tasks.agent_callback_token
to ensure only the agent that received the dispatch can submit the result.
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

    # ── Save deliverable ──────────────────────────────────────────────────────
    actor_id = None
    assignments = task.get("assignments")
    if assignments:
        if isinstance(assignments, list) and assignments:
            actor_id = assignments[0].get("actor_id")
        elif isinstance(assignments, dict):
            actor_id = assignments.get("actor_id")

    deliverable_row = {
        "id": str(uuid.uuid4()),
        "task_id": body.task_id,
        "actor_id": actor_id,
        "content": body.content,
        "tool_calls_log": [],
        "created_at": datetime.utcnow().isoformat(),
    }
    db.table("deliverables").insert(deliverable_row).execute()

    # ── Update task: done, clear callback token ───────────────────────────────
    db.table("tasks").update({
        "status": "done",
        "agent_callback_token": None,
    }).eq("id", body.task_id).execute()

    # ── GitHub PR (if files provided and repo connected) ──────────────────────
    if body.files:
        # Reconstruct deliverable content with ###FILES### block for create_pr_for_task
        files_json = [{"path": f.path, "content": f.content} for f in body.files]
        import json
        content_with_files = body.content + "\n\n###FILES###\n" + json.dumps(files_json, indent=2)
        try:
            await create_pr_for_task(body.task_id, task.get("title", ""), content_with_files)
        except Exception:
            pass
    else:
        try:
            await create_pr_for_task(body.task_id, task.get("title", ""), body.content)
        except Exception:
            pass

    return {"ok": True, "task_id": body.task_id}
