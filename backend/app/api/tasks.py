from __future__ import annotations

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from app.models import TaskAssign
from app.db import get_supabase
from app.services.assignment_engine import manual_assign
from app.services.actor_executor import execute_task, stream_task_execution
from app.providers.registry import get_provider
import json

router = APIRouter()


@router.get("/{task_id}")
async def get_task(task_id: str):
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
async def update_task_status(task_id: str, body: dict):
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

    async def event_stream():
        async for chunk in stream_task_execution(task_id, actor_id):
            yield f"data: {json.dumps({'content': chunk})}\n\n"
        yield "data: [DONE]\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@router.get("/{task_id}/deliverables")
async def get_deliverables(task_id: str):
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
    """Stream a free-form AI prompt with full task context."""
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

    # Use assigned actor's model if available, else fallback
    assignment_resp = (
        db.table("assignments").select("actor_id").eq("task_id", task_id).single().execute()
    )
    model = "gpt-4o"
    if assignment_resp.data:
        actor_resp = (
            db.table("actors").select("model").eq("id", assignment_resp.data["actor_id"]).single().execute()
        )
        if actor_resp.data and actor_resp.data.get("model"):
            model = actor_resp.data["model"]

    history = body.get("history") or []
    messages = [
        {
            "role": "system",
            "content": (
                f"You are an AI assistant helping with a software project.\n"
                f"Project: {project.get('name', '')}\n"
                f"Project brief: {project.get('prompt', '')}\n\n"
                f"Current task: {task['title']}\n"
                f"Description: {task['description']}\n"
                f"Status: {task['status']}  |  Type: {task['type']}  |  Priority: {task['priority']}\n\n"
                "Answer concisely. Use Markdown for code."
            ),
        },
        *history,
        {"role": "user", "content": user_prompt},
    ]

    provider = get_provider(model)

    async def event_stream():
        async for chunk in provider.stream(messages):
            yield f"data: {json.dumps({'content': chunk})}\n\n"
        yield "data: [DONE]\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")
