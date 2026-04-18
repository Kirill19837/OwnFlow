from __future__ import annotations

from typing import List
from app.db import get_supabase
import uuid

# Task types that should be handled by AI vs. human
AI_TASK_TYPES = {"code", "research", "qa", "devops"}
HUMAN_TASK_TYPES = {"design", "review"}


async def auto_assign(sprint_id: str) -> List[dict]:
    """Auto-assign unassigned tasks in a sprint to the best available actor."""
    db = get_supabase()

    tasks_resp = (
        db.table("tasks").select("*").eq("sprint_id", sprint_id).execute()
    )
    tasks = tasks_resp.data or []
    if not tasks:
        return []

    project_id = tasks[0]["project_id"]

    actors_resp = (
        db.table("actors").select("*").eq("project_id", project_id).execute()
    )
    actors = actors_resp.data or []

    ai_actors = [a for a in actors if a["type"] == "ai"]
    human_actors = [a for a in actors if a["type"] == "human"]

    # Simple round-robin counters
    ai_idx = 0
    human_idx = 0
    assignments: list[dict] = []

    for task in tasks:
        task_type = task.get("type", "code")
        prefer_ai = task_type in AI_TASK_TYPES

        actor = None
        if prefer_ai and ai_actors:
            actor = ai_actors[ai_idx % len(ai_actors)]
            ai_idx += 1
        elif not prefer_ai and human_actors:
            actor = human_actors[human_idx % len(human_actors)]
            human_idx += 1
        elif ai_actors:
            actor = ai_actors[ai_idx % len(ai_actors)]
            ai_idx += 1
        elif human_actors:
            actor = human_actors[human_idx % len(human_actors)]
            human_idx += 1
        else:
            continue

        row = {
            "id": str(uuid.uuid4()),
            "task_id": task["id"],
            "actor_id": actor["id"],
            "assigned_by": "system",
        }
        assignments.append(row)

    if assignments:
        db.table("assignments").insert(assignments).execute()

    return assignments


async def manual_assign(task_id: str, actor_id: str, assigned_by: str) -> dict:
    db = get_supabase()
    # Remove existing assignment for this task
    db.table("assignments").delete().eq("task_id", task_id).execute()
    row = {
        "id": str(uuid.uuid4()),
        "task_id": task_id,
        "actor_id": actor_id,
        "assigned_by": assigned_by,
    }
    db.table("assignments").insert(row).execute()
    return row
