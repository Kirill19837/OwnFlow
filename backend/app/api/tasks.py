from __future__ import annotations

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from app.models import TaskAssign
from app.db import get_supabase
from app.services.assignment_engine import manual_assign
from app.services.actor_executor import execute_task, stream_task_execution
from app.providers.registry import get_provider
from app.assistants import (
    build_task_assistant_messages,
    has_mark_ready_action,
    resolve_task_assistant_model_and_name,
    strip_duplicate_task_details,
)
import json

router = APIRouter()


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
    return resp.data


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
    existing = db.table("tasks").select("title,description,task_details").eq("id", task_id).single().execute()
    task_row = existing.data or {}
    current = task_row.get("task_details") or {}
    merged = {**current, **details}
    db.table("tasks").update({"task_details": merged}).eq("id", task_id).execute()
    # Auto-evaluate readiness after every save
    await _auto_check_ready(db, task_id, task_row.get("title", ""), task_row.get("description", ""), merged)
    return {"task_id": task_id, "task_details": merged}


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
def set_task_ai_ready(task_id: str, body: dict):
    """Set ai_ready flag (AI-decided stage)."""
    db = get_supabase()
    ai_ready = bool(body.get("ai_ready", True))
    db.table("tasks").update({"ai_ready": ai_ready}).eq("id", task_id).execute()
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
    return resp.data or []


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

    task_details = task.get("task_details") or {}
    messages = build_task_assistant_messages(
        task=task,
        project=project,
        actors=actors,
        history=history,
        assigned_actor_name=assigned_actor_name,
        task_details=task_details,
        user_prompt=user_prompt,
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

    async def event_stream():
        full_response = []
        async for chunk in provider.stream(messages):
            full_response.append(chunk)
            yield f"data: {json.dumps({'content': chunk})}\n\n"
        yield "data: [DONE]\n\n"
        # Persist assistant reply — strip duplicate detail keys before saving
        assistant_content = strip_duplicate_task_details("".join(full_response), task_details)
        # If the AI emitted mark_ready, set ai_ready on the task
        try:
            if has_mark_ready_action(assistant_content):
                db.table("tasks").update({"ai_ready": True}).eq("id", task_id).execute()
        except Exception:
            pass
        try:
            db.table("task_interactions").insert({
                "task_id": task_id,
                "role": "assistant",
                "content": assistant_content,
            }).execute()
        except Exception:
            pass

    return StreamingResponse(event_stream(), media_type="text/event-stream")
