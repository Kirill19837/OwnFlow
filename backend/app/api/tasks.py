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


@router.patch("/{task_id}/description")
async def update_task_description(task_id: str, body: dict):
    db = get_supabase()
    content = (body.get("content") or "").strip()
    if not content:
        raise HTTPException(400, "content is required")
    db.table("tasks").update({"description": content}).eq("id", task_id).execute()
    return {"task_id": task_id, "description": content}


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
    actors_lines = "\n".join(
        f'- id:{a["id"]} | {a["name"]} | {a.get("role","") or a.get("type","")} | {a.get("model","") or ""}'
        for a in actors
    ) or "none"

    # Use assigned actor's model if available
    assignment_resp = (
        db.table("assignments").select("actor_id").eq("task_id", task_id).single().execute()
    )
    model = "gpt-4o"
    assigned_actor_id = None
    assigned_actor_name = "Unassigned"
    if assignment_resp.data:
        assigned_actor_id = assignment_resp.data["actor_id"]
        actor_resp = (
            db.table("actors").select("name,model").eq("id", assigned_actor_id).single().execute()
        )
        if actor_resp.data:
            assigned_actor_name = actor_resp.data.get("name", "Actor")
            if actor_resp.data.get("model"):
                model = actor_resp.data["model"]

    history = body.get("history") or []
    messages = [
        {
            "role": "system",
            "content": (
                f"You are {assigned_actor_name}, an AI agent working on a software project.\n"
                f"Project: {project.get('name', '')}\n"
                f"Project brief: {project.get('prompt', '')}\n\n"
                f"Your task:\n"
                f"  Title: {task['title']}\n"
                f"  Description: {task['description']}\n"
                f"  Status: {task['status']}  |  Type: {task['type']}  |  Priority: {task['priority']}\n\n"
                f"Team actors (for assignment):\n{actors_lines}\n\n"
                "Answer concisely. Use Markdown for code.\n\n"
                "IMPORTANT — structured action rule:\n"
                "When the user asks you to perform an action on this task, respond ONLY with a "
                "fenced JSON block — no prose before or after.\n\n"
                "Supported actions:\n"
                "```json\n"
                '{"intent":"assign_actor","actor_id":"<id from actors list>","actor_name":"..."}\n'
                "```\n"
                "```json\n"
                '{"intent":"update_status","status":"todo|in_progress|review|done|rework"}\n'
                "```\n"
                "```json\n"
                '{"intent":"execute_task","confirm":true}\n'
                "```\n"
                "```json\n"
                '{"intent":"update_description","content":"<full markdown to set as the task notes/documentation>"}\n'
                "```\n"
                "For all other questions, answer normally using Markdown."
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
