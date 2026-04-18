from __future__ import annotations

from app.db import get_supabase
from app.providers.registry import get_provider
import uuid
from datetime import datetime

EXECUTOR_SYSTEM = """You are an AI actor working on a software project.
You will be given a task with its description and project context.
Produce a high-quality, detailed deliverable for the task.
If the task is code-related, write complete, working code with comments.
If the task is research or analysis, provide structured findings.
Format your response in Markdown.
"""


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

    prior_deliverables_resp = (
        db.table("deliverables")
        .select("content")
        .eq("task_id", task_id)
        .order("created_at")
        .execute()
    )
    prior = prior_deliverables_resp.data or []
    prior_text = "\n\n---\n\n".join(d["content"] for d in prior) if prior else ""

    context_parts = [
        f"Project: {project['name']}\nProject brief: {project['prompt']}",
        f"Task title: {task['title']}",
        f"Task description: {task['description']}",
        f"Task type: {task['type']}  |  Priority: {task['priority']}",
    ]
    if prior_text:
        context_parts.append(f"Prior deliverables for this task:\n{prior_text}")

    messages = [
        {"role": "system", "content": EXECUTOR_SYSTEM},
        {"role": "user", "content": "\n\n".join(context_parts)},
    ]

    model = actor.get("model") or "gpt-4o"
    provider = get_provider(model)
    content = await provider.complete(messages)

    # Update task status
    db.table("tasks").update({"status": "done"}).eq("id", task_id).execute()

    row = {
        "id": str(uuid.uuid4()),
        "task_id": task_id,
        "actor_id": actor_id,
        "content": content,
        "tool_calls_log": [],
        "created_at": datetime.utcnow().isoformat(),
    }
    db.table("deliverables").insert(row).execute()
    return row


async def stream_task_execution(task_id: str, actor_id: str):
    """Async generator yielding SSE text chunks."""
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

    model = actor.get("model") or "gpt-4o"
    provider = get_provider(model)

    full_content = []
    async for chunk in provider.stream(messages):
        full_content.append(chunk)
        yield chunk

    # Persist deliverable after stream completes
    row = {
        "id": str(uuid.uuid4()),
        "task_id": task_id,
        "actor_id": actor_id,
        "content": "".join(full_content),
        "tool_calls_log": [],
        "created_at": datetime.utcnow().isoformat(),
    }
    db.table("deliverables").insert(row).execute()
    db.table("tasks").update({"status": "done"}).eq("id", task_id).execute()
