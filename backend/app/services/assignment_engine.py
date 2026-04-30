from __future__ import annotations

from typing import List
from app.db import get_supabase
import uuid

# Task types that should be handled by AI vs. human (fallback when no role match)
AI_TASK_TYPES = {"code", "research", "qa", "devops"}
HUMAN_TASK_TYPES = {"design", "review"}


def _best_actor(task: dict, actors: list[dict], ai_idx: int, human_idx: int, ai_actors: list, human_actors: list):
    """
    Pick the best actor for a task using this priority order:
      1. Human actor whose role matches task.actor_role  (exact, case-insensitive)
      2. AI actor whose role matches task.actor_role
      3. Type-based round-robin fallback (AI for code/research/qa/devops, human for design/review)
      4. Any remaining actor
    Returns (actor, new_ai_idx, new_human_idx).
    """
    task_role = (task.get("actor_role") or "").strip().lower()
    task_type = task.get("type", "code")

    if task_role:
        # 1. Human role match
        human_match = next((a for a in human_actors if (a.get("role") or "").strip().lower() == task_role), None)
        if human_match:
            return human_match, ai_idx, human_idx

        # 2. AI role match
        ai_match = next((a for a in ai_actors if (a.get("role") or "").strip().lower() == task_role), None)
        if ai_match:
            return ai_match, ai_idx, human_idx

    # 3. Type-based fallback
    prefer_ai = task_type in AI_TASK_TYPES
    if prefer_ai and ai_actors:
        actor = ai_actors[ai_idx % len(ai_actors)]
        return actor, ai_idx + 1, human_idx
    if not prefer_ai and human_actors:
        actor = human_actors[human_idx % len(human_actors)]
        return actor, ai_idx, human_idx + 1

    # 4. Whatever is available
    if ai_actors:
        actor = ai_actors[ai_idx % len(ai_actors)]
        return actor, ai_idx + 1, human_idx
    if human_actors:
        actor = human_actors[human_idx % len(human_actors)]
        return actor, ai_idx, human_idx + 1

    return None, ai_idx, human_idx


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

    ai_idx = 0
    human_idx = 0
    assignments: list[dict] = []

    for task in tasks:
        actor, ai_idx, human_idx = _best_actor(task, actors, ai_idx, human_idx, ai_actors, human_actors)
        if not actor:
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
