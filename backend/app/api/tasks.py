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
    update: dict = {"description": content}
    title = (body.get("title") or "").strip()
    if title:
        update["title"] = title
    db.table("tasks").update(update).eq("id", task_id).execute()
    return {"task_id": task_id, **update}


@router.patch("/{task_id}/details")
async def update_task_details(task_id: str, body: dict):
    """Merge key-value decisions into task_details JSONB."""
    db = get_supabase()
    details = body.get("details") or {}
    if not isinstance(details, dict):
        raise HTTPException(400, "details must be an object")
    # Fetch existing and merge
    existing = db.table("tasks").select("task_details").eq("id", task_id).single().execute()
    current = (existing.data or {}).get("task_details") or {}
    merged = {**current, **details}
    db.table("tasks").update({"task_details": merged}).eq("id", task_id).execute()
    return {"task_id": task_id, "task_details": merged}


@router.patch("/{task_id}/ready")
async def set_task_ready(task_id: str, body: dict):
    """Mark or unmark a task as ready for implementation."""
    db = get_supabase()
    is_ready = bool(body.get("is_ready", True))
    db.table("tasks").update({"is_ready": is_ready}).eq("id", task_id).execute()
    return {"task_id": task_id, "is_ready": is_ready}


@router.get("/{task_id}/interactions")
async def get_task_interactions(task_id: str):
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

    # Format existing task_details for context
    task_details = task.get("task_details") or {}
    details_lines = (
        "\n".join(f"  {k}: {v}" for k, v in task_details.items())
        if task_details else "  (none captured yet)"
    )

    messages = [
        {
            "role": "system",
            "content": (
                f"You are {assigned_actor_name}, an AI agent working on a software project.\n"
                f"Project: {project.get('name', '')}\n"
                f"Project brief: {project.get('prompt', '')}\n\n"
                f"Current task:\n"
                f"  Title: {task['title']}\n"
                f"  Description: {task.get('description') or '(empty)'}\n"
                f"  Status: {task['status']}  |  Type: {task['type']}  |  Priority: {task['priority']}\n\n"
                f"Decisions & details already captured:\n{details_lines}\n\n"
                f"Team actors (for assignment):\n{actors_lines}\n\n"
                "────────────────────────────────────\n"
                "REFINEMENT PROTOCOL\n"
                "When the user asks you to refine, clarify, or improve this task "
                "(phrases like 'refine', 'clarify', 'improve description', 'what do you need', "
                "'ask me questions', 'fill in details', etc.), follow this exact process:\n\n"
                "STEP 1 — Rewrite title and description.\n"
                "  Emit one update_description action. Include a concise `title` (≤ 10 words, plain text, no "
                "  markdown symbols) AND a full `content` description in markdown with: goal, acceptance "
                "  criteria, and any technical notes you can infer. The title should clearly name what "
                "  this task does.\n\n"
                "STEP 2 — Capture known structured decisions.\n"
                "  Emit one update_details action for every fact you can already infer from the "
                "  description, project context, or prior conversation. "
                "  Typical keys: tech_stack, database, auth_method, api_style, framework, "
                "  deployment_target, testing_approach, performance_requirements.\n"
                "  IMPORTANT: never emit a key that was already captured (shown above).\n\n"
                "STEP 3 — Ask all remaining open questions.\n"
                "  After the JSON blocks, list every question still unanswered as a numbered list. "
                "  Be specific — ask one thing per question. Do not ask about things already "
                "  captured in 'Decisions & details already captured'.\n\n"
                "STEP 4 — When the user answers a question.\n"
                "  Immediately emit update_details for the answered fact(s), then check if any "
                "  questions remain. If none remain, also emit mark_ready.\n\n"
                "Do NOT emit mark_ready until ALL questions are answered by the user.\n"
                "Do NOT repeat questions already answered in the captured details.\n"
                "────────────────────────────────────\n\n"
                "STRUCTURED ACTIONS (respond with ONLY a fenced JSON block — no prose before/after):\n\n"
                "```json\n"
                '{"intent":"update_description","title":"<concise task name>","content":"<full markdown description>"}\n'
                "```\n"
                "```json\n"
                '{"intent":"update_details","details":{"<key>":"<value>",...}}\n'
                "```\n"
                "```json\n"
                '{"intent":"mark_ready","summary":"<one-sentence confirmation all questions answered>"}\n'
                "```\n"
                "```json\n"
                '{"intent":"assign_actor","actor_id":"<id>","actor_name":"..."}\n'
                "```\n"
                "```json\n"
                '{"intent":"update_status","status":"todo|in_progress|review|done|rework"}\n'
                "```\n"
                "```json\n"
                '{"intent":"execute_task","confirm":true}\n'
                "```\n\n"
                "When the refinement protocol produces multiple actions (steps 1+2), emit them as "
                "separate fenced JSON blocks in sequence, then ask questions in plain text after.\n"
                "For all other questions, answer normally using Markdown."
            ),
        },
        *history,
        {"role": "user", "content": user_prompt},
    ]

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
        # Persist assistant reply
        assistant_content = "".join(full_response)
        try:
            db.table("task_interactions").insert({
                "task_id": task_id,
                "role": "assistant",
                "content": assistant_content,
            }).execute()
        except Exception:
            pass

    return StreamingResponse(event_stream(), media_type="text/event-stream")
