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
from datetime import datetime, UTC

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel
from typing import Optional, List

from app.db import get_supabase
from app.services.github_service import create_pr_for_task
from app.services.file_storage import upload_file

router = APIRouter()


class FileEntry(BaseModel):
    path: str
    content: str


class AgentCallbackBody(BaseModel):
    task_id: str
    content: str
    files: Optional[List[FileEntry]] = None
    pr_url: Optional[str] = None            # PR already created by the agent — skips handler-side PR creation
    logs: Optional[List[dict]] = None       # [{level: int, phase: str, message: str}, ...]
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

    try:
        task_resp = (
            db.table("tasks")
            .select("*, assignments(actor_id)")
            .eq("id", body.task_id)
            .single()
            .execute()
        )
    except Exception:
        raise HTTPException(404, "Task not found.")

    task = task_resp.data
    if not task:
        raise HTTPException(404, "Task not found.")
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

    # ── Save deliverable FIRST ────────────────────────────────────────────────
    # Insert before consuming the token so that if this fails the agent can
    # still retry (the token is still valid and the task stays in its current
    # status)
    files_data = []
    if body.files:
        print(f"[agents] DEBUG: Received {len(body.files)} file(s) from agent callback for task {body.task_id}", flush=True)
        for file_entry in body.files:
            file_record = {
                "path": file_entry.path,
                "content": file_entry.content,
            }
            print(f"[agents] DEBUG: Processing file: path={file_entry.path!r} size={len(file_entry.content)} bytes", flush=True)

            try:
                download_url = await upload_file(
                    body.task_id,
                    file_entry.path,
                    file_entry.content,
                )
                file_record["url"] = download_url
                print(f"[agents] DEBUG: Uploaded {file_entry.path} to storage: {download_url}", flush=True)
            except Exception as exc:
                print(f"[agents] Warning: Storage upload failed for {file_entry.path}: {exc}", flush=True)

            files_data.append(file_record)
    else:
        print(f"[agents] DEBUG: No files in callback body for task {body.task_id}", flush=True)

    files_data = files_data if files_data else None
    print(f"[agents] DEBUG: Final files_data={files_data is not None} (count={len(files_data) if files_data else 0})", flush=True)

    deliverable_row = {
        "id": str(uuid.uuid4()),
        "task_id": body.task_id,
        "actor_id": actor_id,
        "content": body.content,
        "files": files_data,
        "tool_calls_log": [],
        "created_at": datetime.now(UTC).isoformat(),
    }
    print(f"[agents] DEBUG: About to insert deliverable with files={files_data is not None} (count={len(files_data) if files_data else 0})", flush=True)
    print(f"[agents] DEBUG: deliverable_row={{'task_id': '{body.task_id}', 'actor_id': '{actor_id}', 'files_present': {files_data is not None}, 'content_len': {len(body.content)}}}", flush=True)
    try:
        insert_resp = db.table("deliverables").insert(deliverable_row).execute()
        print(f"[agents] DEBUG: Deliverable saved successfully. Response count: {insert_resp.count if insert_resp else 'none'}", flush=True)
    except Exception as exc:
        print(f"[agents] ERROR: Failed to save deliverable: {exc}", flush=True)
        raise HTTPException(500, f"Failed to save deliverable: {str(exc)}") from exc

    # ── Atomically consume the token + move to review ──────────────────────────
    # Moves the task to 'review' so a human can validate the result before
    # closing it as done. Clears is_ready and ai_ready so the task is no longer
    # eligible for re-dispatch via run-ready.
    print(f"[agents] DEBUG: Consuming callback token for task {body.task_id}", flush=True)

    update_fields: dict = {
        "status": "review",
        "agent_callback_token": None,
        "is_ready": False,
        "ai_ready": False,
    }
    if body.pr_url:
        update_fields["github_pr_url"] = body.pr_url
        update_fields["github_pr_state"] = "open"

    consumed = (
        db.table("tasks")
        .update(update_fields)
        .eq("id", body.task_id)
        .eq("agent_callback_token", provided_token)
        .execute()
    )
    print(f"[agents] DEBUG: Token consumption result: count={consumed.count if consumed else 'none'}", flush=True)
    if not consumed.data:
        # Deliverable was inserted but token was already gone — idempotent: the
        # first caller already finished successfully, so return 200 rather than
        # leaving a duplicate deliverable row. Optionally delete the duplicate.
        print(f"[agents] WARNING: Callback token already consumed for task {body.task_id}", flush=True)
        raise HTTPException(409, "Callback token already consumed.")

    # Verify what was saved
    verify_resp = (
        db.table("deliverables")
        .select("id, task_id, files")
        .eq("task_id", body.task_id)
        .order("created_at", ascending=False)
        .limit(1)
        .execute()
    )
    if verify_resp.data:
        saved_del = verify_resp.data[0]
        print(f"[agents] DEBUG: Verification - saved deliverable has files={saved_del.get('files') is not None}", flush=True)
    else:
        print("[agents] WARNING: Could not verify saved deliverable", flush=True)

    # ── Persist agent logs to ai_logs ─────────────────────────────────────────
    if body.logs:
        project_id = task.get("project_id")
        # Resolve team log_level threshold (default 0=debug — store everything)
        team_log_level = 0
        try:
            proj_team_id = None
            proj_resp = db.table("projects").select("team_id").eq("id", task.get("project_id", "")).single().execute()
            if proj_resp.data:
                proj_team_id = proj_resp.data.get("team_id")
            if proj_team_id:
                team_resp = db.table("teams").select("log_level").eq("id", proj_team_id).single().execute()
                if team_resp.data:
                    team_log_level = team_resp.data.get("log_level") or 0
        except Exception:
            pass
        for entry in body.logs:
            try:
                lvl = int(entry.get("level", 1))
                if lvl < team_log_level:
                    continue  # below team threshold — drop
                db.table("ai_logs").insert({
                    "id": str(uuid.uuid4()),
                    "project_id": project_id,
                    "task_id": body.task_id,
                    "phase": entry.get("phase", 1),
                    "message": str(entry.get("message", "")),
                    "level": lvl,
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
                "phase": 1,
                "model": body.model,
                "messages": [{"role": "user", "content": body.prompt}],
                "response": body.content,
            }).execute()
        except Exception:
            pass

    # ── GitHub PR (fallback: only when the agent did not already open one) ─────
    # Agents are the primary PR authority. If body.pr_url is set, the agent
    # already created the PR; creating another one here would produce a duplicate.
    if not body.pr_url and body.files:
        import json
        files_json = [{"path": f.path, "content": f.content} for f in body.files]
        narrative = body.content.split("###FILES###")[0].rstrip()
        content_with_files = narrative + "\n\n###FILES###\n" + json.dumps(files_json, indent=2)
        try:
            await create_pr_for_task(body.task_id, task.get("title", ""), content_with_files)
        except Exception:
            pass

    print(f"[agents] DEBUG: Callback completed successfully for task {body.task_id}. Returning 200 OK.", flush=True)
    return {"ok": True, "task_id": body.task_id}


@router.get("/deliverables/{task_id}/files")
async def get_deliverable_files(task_id: str):
    """
    Get download URLs for all files generated for a deliverable.

    Returns:
        {
            "files": [
                {"path": "src/main.py", "url": "https://..."},
                ...
            ]
        }
    """
    db = get_supabase()

    # Separate DB errors (500) from "no rows found" (404) so callers and
    # on-call engineers get an accurate signal.
    try:
        deliverable_resp = (
            db.table("deliverables")
            .select("files")
            .eq("task_id", task_id)
            .order("created_at", ascending=False)
            .limit(1)
            .execute()
        )
    except Exception as exc:
        raise HTTPException(500, f"Failed to query deliverables: {exc}") from exc

    deliverables = deliverable_resp.data
    if not deliverables:
        raise HTTPException(404, "No deliverable found for this task")

    deliverable = deliverables[0]
    files = deliverable.get("files")

    if not files:
        return {"files": []}

    # files is stored as a native JSONB array, so the Supabase client returns
    # it already deserialised.  Guard against the legacy string shape just in case.
    if isinstance(files, str):
        import json
        try:
            files = json.loads(files)
        except Exception:
            return {"files": []}

    return {"files": files}
