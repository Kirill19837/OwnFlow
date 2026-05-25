from __future__ import annotations

import uuid
from datetime import datetime, timezone
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from app.models import TaskAssign
from app.db import get_supabase
from app.services.assignment_engine import manual_assign
from app.services.actor_executor import execute_task, stream_task_execution
from app.providers.registry import get_provider
from app.assistants import (
    build_task_assistant_messages,
    resolve_task_assistant_model_and_name,
    strip_duplicate_task_details,
)
import json

router = APIRouter()
project_router = APIRouter()

_TASK_SECRET_FIELDS = {"agent_callback_token"}

_ACTOR_SECRET_FIELDS = {"agent_api_key"}

def _mask_actor(actor: dict) -> dict:
    """Remove secret fields from an actor before returning to the client."""
    return {k: v for k, v in actor.items() if k not in _ACTOR_SECRET_FIELDS}

def _strip_task(task: dict) -> dict:
    """Remove internal dispatch-secret fields before returning a task to the client."""
    stripped = {k: v for k, v in task.items() if k not in _TASK_SECRET_FIELDS}
    # Mask nested actor objects inside assignments
    if isinstance(stripped.get("assignments"), list):
        stripped["assignments"] = [
            {
                **a,
                "actors": _mask_actor(a["actors"]) if isinstance(a.get("actors"), dict) else a.get("actors"),
            }
            for a in stripped["assignments"]
        ]
    return stripped


@router.get("/{task_id}")
def get_task(task_id: str):
    db = get_supabase()
    resp = (
        db.table("tasks")
        .select("*, assignments(*, actors(*))")
        .eq("id", task_id)
        .single()
        .execute()
    )
    if not resp.data:
        raise HTTPException(404, "Task not found")
    return _strip_task(resp.data)


@router.patch("/{task_id}/assign")
async def assign_task(task_id: str, body: TaskAssign):
    db = get_supabase()
    task = db.table("tasks").select("id").eq("id", task_id).single().execute()
    if not task.data:
        raise HTTPException(404, "Task not found")
    if not body.actor_id:
        # Unassign: remove all assignments for this task
        db.table("assignments").delete().eq("task_id", task_id).execute()
        return {"task_id": task_id, "actor_id": None}
    assignment = await manual_assign(task_id, body.actor_id, assigned_by="user")
    return assignment


@router.patch("/{task_id}/status")
def update_task_status(task_id: str, body: dict):
    db = get_supabase()
    allowed = {"todo", "in_progress", "review", "done", "rework"}
    status = body.get("status")
    if status not in allowed:
        raise HTTPException(400, f"status must be one of {allowed}")
    db.table("tasks").update({"status": status}).eq("id", task_id).execute()
    return {"task_id": task_id, "status": status}


@router.post("/{task_id}/execute")
async def execute(task_id: str):
    db = get_supabase()
    assignment = (
        db.table("assignments").select("actor_id").eq("task_id", task_id).single().execute()
    )
    if not assignment.data:
        raise HTTPException(400, "Task has no assigned actor")
    actor_id = assignment.data["actor_id"]
    # Check actor is AI
    actor = db.table("actors").select("type").eq("id", actor_id).single().execute()
    if not actor.data or actor.data["type"] != "ai":
        raise HTTPException(400, "Assigned actor is not an AI actor")

    db.table("tasks").update({"status": "in_progress"}).eq("id", task_id).execute()
    deliverable = await execute_task(task_id, actor_id)
    return deliverable


@router.patch("/{task_id}/description")
async def update_task_description(task_id: str, body: dict):
    db = get_supabase()
    content = (body.get("content") or "").strip()
    if not content:
        raise HTTPException(400, "content is required")
    update: dict = {"description": content}
    title = (body.get("title") or "").strip()
    if title:
        update["title"] = title
    db.table("tasks").update(update).eq("id", task_id).execute()
    return {"task_id": task_id, **update}


@router.patch("/{task_id}/details")
async def update_task_details(task_id: str, body: dict):
    """Merge key-value decisions into task_details JSONB, then auto-check readiness."""
    db = get_supabase()
    details = body.get("details") or {}
    if not isinstance(details, dict):
        raise HTTPException(400, "details must be an object")
    # Filter hallucinated meta-keys that some models invent instead of real task facts
    _FORBIDDEN_DETAIL_KEYS = {
        "task_memory_persisted", "all_refinements_saved", "execution_ready", "timestamp",
        "memory_saved", "refinement_complete", "persisted", "saved", "ready",
    }
    details = {k: v for k, v in details.items() if k not in _FORBIDDEN_DETAIL_KEYS}
    if not details:
        # Nothing real to save — return current state without writing
        existing = db.table("tasks").select("id,task_details").eq("id", task_id).single().execute()
        return {"task_id": task_id, "task_details": (existing.data or {}).get("task_details") or {}}
    existing = db.table("tasks").select("id,title,description,task_details,project_id").eq("id", task_id).single().execute()
    task_row = existing.data or {}
    current = task_row.get("task_details") or {}
    merged = {**current, **details}
    db.table("tasks").update({"task_details": merged}).eq("id", task_id).execute()
    # Auto-evaluate readiness after every save
    await _auto_check_ready(db, task_id, task_row.get("title", ""), task_row.get("description", ""), merged)
    # Persist decisions into project memory so future tasks can see them
    memory_result = await _upsert_task_memory_chunk(db, task_row, merged)
    return {"task_id": task_id, "task_details": merged, "memory": memory_result}


async def _upsert_task_memory_chunk(db, task_row: dict, task_details: dict, importance: int = 6) -> dict:
    """Create or update a memory chunk for this task's refinement decisions.

    Returns {"action": "created"|"updated"|"skipped", "title": ...} so callers can
    surface a UI message.

    Uses source_type='business-rules' and source_id=task_id so it can be upserted
    idempotently — one chunk per task, updated every time details change.
    """
    from app.services.embeddings import embed_memory_chunk
    task_id = task_row.get("id")
    project_id = task_row.get("project_id")
    if not task_id or not project_id or not task_details:
        return {"action": "skipped"}
    try:
        title = task_row.get("title") or "Untitled task"
        details_lines = "\n".join(f"- {k}: {v}" for k, v in task_details.items())
        content = f"Task: {title}\n\nRefinement decisions:\n{details_lines}"
        summary = f"Refined task '{title}' with {len(task_details)} captured decisions."
        chunk_title = f"Task refinement: {title}"
        embedding = await embed_memory_chunk(chunk_title, content, summary)

        existing = (
            db.table("memory_chunks")
            .select("id")
            .eq("project_id", project_id)
            .eq("source_type", "business-rules")
            .eq("source_id", task_id)
            .execute()
        )
        if existing.data:
            db.table("memory_chunks").update({
                "title": chunk_title,
                "content": content,
                "summary": summary,
                "importance": importance,
                "embedding": embedding,
                "updated_at": datetime.now(timezone.utc).isoformat(),
            }).eq("id", existing.data[0]["id"]).execute()
            return {"action": "updated", "title": chunk_title}
        else:
            db.table("memory_chunks").insert({
                "id": str(uuid.uuid4()),
                "project_id": project_id,
                "source_type": "business-rules",
                "source_id": task_id,
                "title": chunk_title,
                "content": content,
                "summary": summary,
                "tags": ["task-refinement"],
                "importance": importance,
                "embedding": embedding,
            }).execute()
            return {"action": "created", "title": chunk_title}
    except Exception as exc:
        import traceback
        traceback.print_exc()
        print(f"[memory] upsert failed task={task_row.get('id')} project={task_row.get('project_id')}: {exc}")
        return {"action": "failed", "error": str(exc)}


async def _auto_check_ready(db, task_id: str, title: str, description: str, task_details: dict):
    """Use AI to decide if the task has enough decisions to be implementation-ready.
    Silently sets ai_ready=True when the AI says YES (not is_ready — that is user approval)."""
    if not task_details:
        return
    details_text = "\n".join(f"  {k}: {v}" for k, v in task_details.items())
    prompt = (
        f"Task: {title}\n"
        f"Description: {(description or '').strip()[:600]}\n\n"
        f"Captured decisions:\n{details_text}\n\n"
        "Does this task have enough implementation decisions (tech stack, approach, requirements, "
        "acceptance criteria) that a developer could start without asking further questions?\n"
        "Reply with exactly one word: YES or NO."
    )
    try:
        from app.providers.registry import get_provider
        provider = get_provider("gpt-4o")
        result = ""
        async for chunk in provider.stream([{"role": "user", "content": prompt}]):
            result += chunk
            if len(result) > 10:
                break
        if "YES" in result.upper():
            db.table("tasks").update({"ai_ready": True}).eq("id", task_id).execute()
    except Exception:
        pass


@router.patch("/{task_id}/ai-ready")
async def set_task_ai_ready(task_id: str, body: dict):
    """Set ai_ready flag (AI-decided stage)."""
    db = get_supabase()
    ai_ready = bool(body.get("ai_ready", True))
    db.table("tasks").update({"ai_ready": ai_ready}).eq("id", task_id).execute()
    # On mark-ready, ensure latest decisions are reflected in project memory
    if ai_ready:
        task_row = db.table("tasks").select("id,title,description,task_details,project_id").eq("id", task_id).single().execute().data or {}
        await _upsert_task_memory_chunk(db, task_row, task_row.get("task_details") or {}, importance=7)
    return {"task_id": task_id, "ai_ready": ai_ready}


@router.delete("/{task_id}")
def delete_task(task_id: str):
    """Permanently delete a task and its related data."""
    db = get_supabase()
    db.table("tasks").delete().eq("id", task_id).execute()
    return {"deleted": task_id}


@router.patch("/{task_id}/ready")
def set_task_ready(task_id: str, body: dict):
    """Mark or unmark a task as ready for implementation."""
    db = get_supabase()
    is_ready = bool(body.get("is_ready", True))
    db.table("tasks").update({"is_ready": is_ready}).eq("id", task_id).execute()
    return {"task_id": task_id, "is_ready": is_ready}


@router.get("/{task_id}/interactions")
def get_task_interactions(task_id: str):
    """Return all persisted human/AI interactions for a task."""
    db = get_supabase()
    resp = (
        db.table("task_interactions")
        .select("*")
        .eq("task_id", task_id)
        .order("created_at")
        .execute()
    )
    return resp.data or []


@router.get("/{task_id}/execute/stream")
async def execute_stream(task_id: str):
    db = get_supabase()
    assignment = (
        db.table("assignments").select("actor_id").eq("task_id", task_id).single().execute()
    )
    if not assignment.data:
        raise HTTPException(400, "Task has no assigned actor")
    actor_id = assignment.data["actor_id"]

    db.table("tasks").update({"status": "in_progress"}).eq("id", task_id).execute()

    # Build a short execution plan announcement before streaming
    task_resp = db.table("tasks").select("title,description,type,priority").eq("id", task_id).single().execute()
    task_data = task_resp.data or {}
    actor_resp2 = db.table("actors").select("name,model").eq("id", actor_id).single().execute()
    actor_data = actor_resp2.data or {}
    plan_text = (
        f"**{actor_data.get('name', 'Agent')} is starting work**\n\n"
        f"Task: *{task_data.get('title', '')}*\n"
        f"Type: {task_data.get('type', '')} · Priority: {task_data.get('priority', '')}\n\n"
        f"I'll produce a detailed {task_data.get('type', 'deliverable')} addressing the task description."
    )

    async def event_stream():
        yield f"data: {json.dumps({'type': 'plan', 'content': plan_text})}\n\n"
        async for chunk in stream_task_execution(task_id, actor_id):
            yield f"data: {json.dumps({'type': 'content', 'content': chunk})}\n\n"
        yield "data: [DONE]\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@router.get("/{task_id}/deliverables")
def get_deliverables(task_id: str):
    db = get_supabase()
    resp = (
        db.table("deliverables")
        .select("*")
        .eq("task_id", task_id)
        .order("created_at")
        .execute()
    )
    data = resp.data or []
    print(f"[tasks] GET /{{task_id}}/deliverables: task_id={task_id} returned {len(data)} deliverable(s)", flush=True)
    for i, d in enumerate(data):
        files_info = d.get("files")
        print(f"  [deliverable {i}] has files={files_info is not None} (count={len(files_info) if isinstance(files_info, list) else 0})", flush=True)
        if files_info and isinstance(files_info, list):
            for j, f in enumerate(files_info):
                print(f"    [file {j}] path={f.get('path')} has_content={bool(f.get('content'))} has_url={bool(f.get('url'))}", flush=True)
    return data


@router.post("/{task_id}/prompt/stream")
async def prompt_task_stream(task_id: str, body: dict):
    """Stream a free-form AI prompt with full task context and structured action support."""
    db = get_supabase()
    user_prompt = (body.get("prompt") or "").strip()
    if not user_prompt:
        raise HTTPException(400, "prompt is required")

    task_resp = db.table("tasks").select("*").eq("id", task_id).single().execute()
    task = task_resp.data
    if not task:
        raise HTTPException(404, "Task not found")

    project_resp = (
        db.table("projects").select("name,prompt").eq("id", task["project_id"]).single().execute()
    )
    project = project_resp.data or {}

    # Fetch all actors for this project so AI knows who can be assigned
    actors_resp = (
        db.table("actors")
        .select("id,name,role,type,model")
        .eq("project_id", task["project_id"])
        .execute()
    )
    actors = actors_resp.data or []

    # Use assigned actor's model if available
    assignment_resp = (
        db.table("assignments").select("actor_id").eq("task_id", task_id).single().execute()
    )
    model = "gpt-4o"
    assigned_actor_id = None
    assigned_actor_name = "Unassigned"
    actor_row = None
    if assignment_resp.data:
        assigned_actor_id = assignment_resp.data["actor_id"]
        actor_resp = (
            db.table("actors").select("name,model").eq("id", assigned_actor_id).single().execute()
        )
        if actor_resp.data:
            actor_row = actor_resp.data
    model, assigned_actor_name = resolve_task_assistant_model_and_name(
        assignment_row=assignment_resp.data,
        actor_row=actor_row,
    )

    history = body.get("history") or []

    # Load project memory chunks via vector similarity search.
    # Query = task title + description + current user prompt — this surfaces
    # only chunks relevant to what the user is currently asking about.
    memory_chunks: list[dict] = []
    active_decisions: list[dict] = []
    try:
        from app.services.embeddings import generate_embedding
        query_text = "\n".join(
            p for p in (task.get("title"), task.get("description"), user_prompt) if p
        )
        query_embedding = await generate_embedding(query_text)
        if query_embedding is not None:
            rpc_resp = db.rpc(
                "match_memory_chunks",
                {
                    "p_project_id": task["project_id"],
                    "p_query_embedding": query_embedding,
                    "p_match_threshold": 0.3,
                    "p_match_count": 8,
                },
            ).execute()
            memory_chunks = rpc_resp.data or []
        if not memory_chunks:
            # Fallback to top-importance chunks (e.g. embeddings not yet generated)
            memory_chunks = (
                db.table("memory_chunks")
                .select("source_type,title,content,summary,importance")
                .eq("project_id", task["project_id"])
                .order("importance", desc=True)
                .limit(8)
                .execute()
                .data
                or []
            )
        active_decisions = (
            db.table("decisions")
            .select("title,decision,reason,status")
            .eq("project_id", task["project_id"])
            .eq("status", "active")
            .execute()
            .data
            or []
        )
    except Exception as exc:
        import traceback
        traceback.print_exc()
        print(f"[memory-search] failed: {exc}")

    task_details = task.get("task_details") or {}
    messages = build_task_assistant_messages(
        task=task,
        project=project,
        actors=actors,
        history=history,
        assigned_actor_name=assigned_actor_name,
        task_details=task_details,
        user_prompt=user_prompt,
        memory_chunks=memory_chunks,
        active_decisions=active_decisions,
    )

    # Persist user message
    try:
        db.table("task_interactions").insert({
            "task_id": task_id,
            "role": "user",
            "content": user_prompt,
        }).execute()
    except Exception:
        pass

    provider = get_provider(model)

    # Build memory event for SSE so the UI can show what was queried.
    memory_titles = [c.get("title") for c in memory_chunks if c.get("title")]
    decision_titles = [d.get("title") for d in active_decisions if d.get("title")]

    async def event_stream():
        # First event: tell client what memory was consulted for this turn.
        yield (
            "data: "
            + json.dumps({
                "type": "memory_event",
                "action": "queried",
                "count": len(memory_titles),
                "titles": memory_titles[:8],
                "decisions": decision_titles[:5],
            })
            + "\n\n"
        )
        full_response = []
        async for chunk in provider.stream(messages):
            full_response.append(chunk)
            yield f"data: {json.dumps({'content': chunk})}\n\n"
        yield "data: [DONE]\n\n"
        # Persist assistant reply — strip duplicate detail keys before saving
        assistant_content = strip_duplicate_task_details("".join(full_response), task_details)
        # NOTE: ai_ready is NOT set here from chat.
        # It is only set by _auto_check_ready after the user actually saves decisions
        # via the /tasks/{id}/details endpoint. This prevents chat proposals that were
        # never saved from marking the task ready.
        try:
            db.table("task_interactions").insert({
                "task_id": task_id,
                "role": "assistant",
                "content": assistant_content,
            }).execute()
        except Exception:
            pass

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@project_router.post("/{project_id}/tasks", status_code=201)
async def create_tasks_for_project(project_id: str, body: dict):
    """Create one or more tasks in a sprint from the AI suggestion."""
    db = get_supabase()
    tasks_in = body.get("tasks") or []
    if not tasks_in:
        raise HTTPException(400, "tasks list is required")

    sprint_id = body.get("sprint_id")
    if not sprint_id:
        sr = (
            db.table("sprints")
            .select("id")
            .eq("project_id", project_id)
            .order("sprint_number")
            .limit(1)
            .execute()
        )
        if not sr.data:
            raise HTTPException(400, "No sprints found — plan the project first")
        sprint_id = sr.data[0]["id"]

    rows = []
    for t in tasks_in:
        rows.append(
            {
                "id": str(uuid.uuid4()),
                "sprint_id": sprint_id,
                "project_id": project_id,
                "title": (t.get("title") or "Untitled").strip(),
                "description": t.get("description") or "",
                "type": t.get("type") or "feature",
                "priority": t.get("priority") or "medium",
                "estimated_hours": float(t.get("estimated_hours") or 1),
                "status": "todo",
                "depends_on": [],
            }
        )

    result = db.table("tasks").insert(rows).execute()
    created = result.data or []

    # Auto-assign actor if provided per task
    for task_in, task_row in zip(tasks_in, created):
        actor_id = (task_in.get("actor_id") or "").strip()
        if actor_id and task_row.get("id"):
            try:
                db.table("assignments").insert({
                    "task_id": task_row["id"],
                    "actor_id": actor_id,
                    "assigned_by": "ai",
                }).execute()
            except Exception:
                pass  # don't fail the whole batch if one assignment fails

    return {"created": len(rows), "tasks": created}


@project_router.patch("/{project_id}/tasks/batch")
async def batch_modify_tasks(project_id: str, body: dict):
    """Bulk-update tasks. Each item must have an 'id' plus the fields to change."""
    db = get_supabase()
    tasks_in = body.get("tasks") or []
    if not tasks_in:
        raise HTTPException(400, "tasks list is required")
    updated = []
    allowed_fields = {"title", "description", "type", "priority", "estimated_hours", "status"}
    for t in tasks_in:
        task_id = t.get("id")
        if not task_id:
            continue
        patch = {k: v for k, v in t.items() if k in allowed_fields and v is not None}
        if patch:
            r = db.table("tasks").update(patch).eq("id", task_id).eq("project_id", project_id).execute()
            if r.data:
                updated.extend(r.data)
    return {"updated": len(updated), "tasks": updated}


@project_router.delete("/{project_id}/tasks/batch")
async def batch_delete_tasks(project_id: str, body: dict):
    """Bulk-delete tasks by ID list."""
    db = get_supabase()
    task_ids = [t.get("id") for t in (body.get("tasks") or []) if t.get("id")]
    if not task_ids:
        raise HTTPException(400, "tasks list with ids is required")
    db.table("tasks").delete().in_("id", task_ids).eq("project_id", project_id).execute()
    return {"deleted": len(task_ids)}


@project_router.get("/{project_id}/tasks/{task_id}/activity")
def get_task_activity(project_id: str, task_id: str):
    """Return recent logs and AI messages for a running task."""
    db = get_supabase()

    task_resp = (
        db.table("tasks")
        .select("id,title,status,priority,agent_dispatched_at,created_at")
        .eq("id", task_id)
        .eq("project_id", project_id)
        .single()
        .execute()
    )
    task = task_resp.data
    if not task:
        raise HTTPException(404, "Task not found")

    dispatched_at = task.get("agent_dispatched_at") or task.get("created_at")

    logs_q = (
        db.table("ai_logs")
        .select("id,phase,message,level,created_at")
        .eq("task_id", task_id)
        .order("created_at", desc=False)
        .limit(40)
    )
    logs = logs_q.execute().data or []

    messages_resp = (
        db.table("ai_messages")
        .select("id,phase,model,response,created_at")
        .eq("task_id", task_id)
        .order("created_at", desc=True)
        .limit(1)
        .execute()
    )
    messages = messages_resp.data or []

    return {
        "task": {
            "id": task.get("id"),
            "title": task.get("title"),
            "status": task.get("status"),
            "priority": task.get("priority"),
            "agent_dispatched_at": dispatched_at,
        },
        "logs": logs,
        "latest_response": messages[0]["response"][:800] if messages else None,
        "model": messages[0].get("model") if messages else None,
    }
